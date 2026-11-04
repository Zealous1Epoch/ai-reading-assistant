"""
AI 工具路由 —— 右侧工具栏的后端接口（v1.8 P0 重设计）

共享管线：
- 范围收口：作用范围 = 左栏当前选中（chapter_id 命中当前章，否则整本书），不再靠打字描述
- 统一上下文构建：单章全文直进；全书按预算逐章分配限额（首尾都取，覆盖每一章）
- SSE 流式执行：除精读笔记（HTML 产物）外全部逐 token 推送

SSE 帧协议（与 /analysis/chat/stream 同款 data: 行）：
  data: {"status": "..."}    进度提示（全书分段通读等）
  data: {"content": "..."}   正文增量
  data: {"sources": [...]}   引用章节（与作者对谈）
  data: {"artifact": {...}}  非文本产物（精读笔记 HTML / 思维导图 JSON 结构树）
  data: {"error": "..."}     执行失败
  data: [DONE]
"""
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from langchain_core.messages import HumanMessage
from pydantic import BaseModel
from typing import List, Optional
import json
import re

from app.services.book_processor import book_processor
from app.services.analysis_service import analysis_service
from app.routers.book_processor import analysis_results as books_index

router = APIRouter(prefix="/api/tools", tags=["AI工具"])

# 上下文预算（字符数）。单章尽量全文；全书拼接按章数分配每章限额。
CHAPTER_CAP = 12000
BOOK_BUDGET = 30000
# 全书总结 map-reduce：每块目标大小 / 每块章节数
MAP_CHUNK = 12000
MAP_GROUP_SIZE = 8


class ToolRequest(BaseModel):
    book_id: str
    chapter_id: Optional[str] = None   # 左栏当前选中章；不传即作用范围为整本书
    user_input: Optional[str] = None   # 仅「与作者对谈」使用：读者的问题


def _frame(obj) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


DONE_FRAME = "data: [DONE]\n\n"


def _book_title(book_id: str) -> str:
    entry = books_index.get(book_id)
    return (getattr(entry, "title", "") or "").strip() or "这本书"


def _resolve_scope(request: ToolRequest):
    """范围收口：返回 (作用章节列表, 范围描述)"""
    chapters = book_processor.get_full_chapters(request.book_id)
    if not chapters:
        raise HTTPException(status_code=404, detail="找不到书籍或章节内容")
    if request.chapter_id:
        for ch in chapters:
            if ch.chapter_id == request.chapter_id:
                return [ch], ch.title
    return chapters, "整本书"


def _context(chapters, budget: int = BOOK_BUDGET) -> str:
    """统一上下文构建：单章全文（封顶）；全书按预算分配每章限额，首尾都取、覆盖每一章"""
    if len(chapters) == 1:
        ch = chapters[0]
        return f"[{ch.title}]\n{ch.content[:CHAPTER_CAP]}"
    cap = max(500, budget // len(chapters))
    parts = []
    for ch in chapters:
        if len(ch.content) <= cap:
            body = ch.content
        else:
            tail_n = min(200, cap // 4)
            body = ch.content[:cap - tail_n] + "\n……（中段省略）……\n" + ch.content[-tail_n:]
        parts.append(f"[{ch.title}]\n{body}")
    return "\n\n".join(parts)


async def _stream_prompt(prompt: str):
    """逐 token 推送一次补全"""
    async for msg in analysis_service.llm.astream([HumanMessage(content=prompt)]):
        piece = msg.content if isinstance(msg.content, str) else ""
        if piece:
            yield _frame({"content": piece})


# ---------------------------------------------------------------- 工具实现

async def _summarize(request, chapters, scope_desc):
    """总结 —— 范围即左栏选中；全书走 map-reduce 全章覆盖"""
    if len(chapters) == 1:
        ch = chapters[0]
        prompt = f"""请根据以下章节内容，提供详细的总结：

《{ch.title}》
{ch.content[:CHAPTER_CAP]}

请提供：
1. 核心内容概述（300字左右）
2. 关键论点与论据
3. 重要的概念和结论

格式要求：每个部分用编号作为标题行（如"1. 核心内容概述"），标题行后换行写正文。请用纯文本，不要使用 Markdown 符号。"""
        async for frame in _stream_prompt(prompt):
            yield frame
        return

    book = _book_title(request.book_id)
    groups = [chapters[i:i + MAP_GROUP_SIZE] for i in range(0, len(chapters), MAP_GROUP_SIZE)]
    partials = []
    for i, grp in enumerate(groups, 1):
        yield _frame({"status": f"通读全书 {i}/{len(groups)} 段"})
        part_prompt = f"""以下是《{book}》一书的一部分（第 {grp[0].title} 至 {grp[-1].title}，共 {len(grp)} 节），请提炼这部分的主要内容。
每节给出 1-3 行要点，保留关键论据、案例和数据细节。纯文本输出，不要客套话。

{_context(grp, budget=MAP_CHUNK)}"""
        resp = await analysis_service.llm.ainvoke([HumanMessage(content=part_prompt)])
        partials.append(f"【{grp[0].title} — {grp[-1].title}】\n{resp.content}")

    yield _frame({"status": "汇总全书总结"})
    prompt = f"""以下是《{book}》全书分段提炼的要点（覆盖全部 {len(chapters)} 节）：

{chr(10).join(partials)[:24000]}

请据此写一份全书详细总结：
1. 全书核心内容概述（400字左右）
2. 关键论点与论据（按书中脉络组织）
3. 重要的概念和结论

格式要求：每个部分用编号作为标题行（如"1. 核心内容概述"），标题行后换行写正文。请用纯文本，不要使用 Markdown 符号。"""
    async for frame in _stream_prompt(prompt):
        yield frame


async def _questions(request, chapters, scope_desc):
    """读书十问"""
    context = _context(chapters)
    prompt = f"""请基于以下书籍内容，回答以下10个问题。每个问题请给出具体、有深度的回答，引用书中内容作为依据。

书籍内容：
{context}

请逐一回答：

1. 这本书的作者想解决的核心问题是什么？
2. 关于这个问题，前人的研究或回答到了什么程度？
3. 这位作者给出了哪些独特的新答案或新视角？
4. 作者用了哪些全新的素材和案例来支撑论点？
5. 相同时代、相同主题的其他书提出了哪些不同的观点？与本书有何分歧？
6. 这本书的结论被质疑过吗？它有什么局限性或潜在问题？
7. 作者在这本书中提出了哪些待解决的问题和新方向？
8. 这本书能给外行（非专业读者）带来什么样的跨界启发？
9. 这本书最有启发的一个案例或故事是什么？
10. 读完这本书后，最值得记住或落实的一个行动建议是什么？

格式要求：每个问题用一行作为标题（如"1. 核心问题是什么？"），然后换行用一段或多段回答。问题之间用空行分隔。请用纯文本，不要使用 Markdown 符号。"""
    async for frame in _stream_prompt(prompt):
        yield frame


# ---------- 思维导图 JSON 生成（v2.1 M1） ----------
# 输出上限必须经 extra_body 透传给 DeepSeek：
# langchain-openai 1.x 会把 max_tokens 改名成 max_completion_tokens，而 DeepSeek 不认后者；
# extra_body 由 OpenAI SDK 原样并入请求体，实测生效（截断时 finish_reason=length）
MINDMAP_TOKENS = 8192


def _bounded_llm(max_tokens: int = MINDMAP_TOKENS):
    return analysis_service.llm.bind(extra_body={"max_tokens": max_tokens})


def _extract_json_obj(text: str):
    """从模型输出中提取完整 JSON 对象（容忍代码围栏与前后杂话）；失败返回 None"""
    if not text:
        return None
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\s*", "", t)
        t = re.sub(r"\s*```\s*$", "", t)
    i, j = t.find("{"), t.rfind("}")
    if i < 0 or j <= i:
        return None
    try:
        obj = json.loads(t[i:j + 1])
    except json.JSONDecodeError:
        return None
    return obj if isinstance(obj, dict) else None


def _norm_title(title: str) -> str:
    """标题归一化：去空白与常见标点，用于 LLM 回填时的容错匹配"""
    return re.sub(r"[\s《》〈〉「」【】()（）.、,，:：;；\-—_·]+", "", title or "")


def _clean_node(node, depth: int = 0, max_depth: int = 6, max_children: int = 12):
    """递归校验/规范 {t, c} 结构：去空标题、限深度、限子数、限单节点字数"""
    if not isinstance(node, dict) or depth > max_depth:
        return None
    t = str(node.get("t", "")).strip().strip("#").strip()
    if not t:
        return None
    out = {"t": t[:80]}
    children = node.get("c")
    if isinstance(children, list):
        cleaned = [c for c in (_clean_node(x, depth + 1, max_depth, max_children) for x in children[:max_children]) if c]
        if cleaned:
            out["c"] = cleaned
    return out


async def _llm_json(prompt: str, attempts: int = 2):
    """调用 LLM 并解析 JSON 对象；解析不出重试。返回 dict 或 None"""
    for _ in range(attempts):
        try:
            resp = await _bounded_llm().ainvoke([HumanMessage(content=prompt)])
        except Exception:
            continue
        obj = _extract_json_obj(resp.content if isinstance(resp.content, str) else "")
        if obj is not None:
            return obj
    return None


def _themes_from_response(obj, wanted_keys):
    """解析 {"nodes":[{t,c}]} → {归一化章题: [主题节点]}；不属于本批真实章的回填全部丢弃"""
    themes_map = {}
    nodes = obj.get("nodes") if isinstance(obj, dict) else None
    if not isinstance(nodes, list):
        return themes_map
    for nd in nodes:
        cc = _clean_node(nd, max_depth=2)
        if not cc:
            continue
        key = _norm_title(cc["t"])
        if key in wanted_keys:
            themes_map.setdefault(key, []).extend(cc.get("c") or [])
    return themes_map


async def _gen_themes_batch(book: str, grp) -> dict:
    """一批章节 → {归一化章题: [三级主题]}（思维导图骨架）"""
    titles = "\n".join(f"{i + 1}. {ch.title}" for i, ch in enumerate(grp))
    prompt = f"""下面是《{book}》的若干章节，请为每一章提炼 2-4 个核心主题（作为思维导图的第三级节点）。

【章节列表——标题必须逐字使用】
{titles}

【章节内容】
{_context(grp, budget=MAP_CHUNK)}

严格输出 JSON（只输出 JSON 本身，不要 Markdown 代码块、不要任何说明文字）：
{{"nodes":[{{"t":"章节原标题","c":[{{"t":"主题"}}]}}]}}

要求：
- 每章一条 nodes，顺序与列表一致，章标题逐字照抄
- 主题不超过 12 字，是能概括该章核心内容的名词短语
- JSON 字符串里不要出现 Markdown 符号"""
    obj = await _llm_json(prompt)
    if not obj:
        return {}
    return _themes_from_response(obj, {_norm_title(ch.title) for ch in grp})


def _build_book_tree(book_title: str, chapters, themes_map: dict) -> dict:
    """服务端组装骨架：逐真实章节建节点（cid 用真实 chapter_id），主题按标题匹配挂上。
    章节 100% 覆盖由本函数结构性保证——LLM 漏写、改写、幻觉出的章都不影响节点集合。"""
    root = {"t": f"《{book_title}》", "c": []}
    for ch in chapters:
        node = {"t": ch.title, "cid": ch.chapter_id, "c": []}
        key = _norm_title(ch.title)
        themes = list(themes_map.get(key) or [])
        if not themes and key:
            # 精确归一化没中 → 找唯一包含关系兜底（LLM 偶尔多写/少写几个字）
            for k, v in themes_map.items():
                if k and (k in key or key in k):
                    themes = list(v)
                    break
        seen = set()
        for th in themes:
            if th["t"] not in seen:
                seen.add(th["t"])
                node["c"].append({"t": th["t"][:40]})
        root["c"].append(node)
    return root


async def _gen_chapter_subtree(book: str, ch):
    """单章深层结构树：章→主题→论点→论据（论据只准用原文真实内容）；失败返回 None"""
    prompt = f"""根据以下章节内容，生成思维导图的一棵结构子树：该章的知识骨架（主题 → 论点 → 论据）。

【书名】《{book}》
【章节】{ch.title}
【章节内容】
{ch.content[:CHAPTER_CAP]}

严格输出 JSON（只输出 JSON 本身，不要 Markdown 代码块、不要任何说明文字）：
{{"t":"章节标题","c":[{{"t":"核心主题","c":[{{"t":"关键论点","c":[{{"t":"论据/案例/数据/关键引文"}}]}}]}}]}}

要求：
- 主题 3-6 个，覆盖本章论证脉络
- 每个主题下 1-4 个论点；每个论点下 0-3 条论据
- 论据必须是章节原文中真实出现过的内容（人名、事件、数据、引文），不得编造
- 节点文字不超过 40 字；不要出现 Markdown 符号"""
    obj = await _llm_json(prompt)
    node = _clean_node(obj, max_depth=4) if obj else None
    if not node:
        return None
    node["t"] = ch.title  # 标题服务端锚定，防 LLM 改写
    node["cid"] = ch.chapter_id
    return node


async def _mindmap(request, chapters, scope_desc):
    """思维导图（v2.1 M1）—— JSON 结构树：
    - 全书：分组生成三级骨架（书→章→主题），章节点由服务端按真实目录组装，结构性零漏章
    - 单章：整章一次生成四级结构树（章→主题→论点→论据）
    - 更深层级由前端点「展开详分支」调 /mindmap/expand/stream 按需生成
    - JSON 解析失败时退回旧版 Markdown 大纲（前端仍用 markmap 渲染，向后兼容）
    """
    book = _book_title(request.book_id)

    if len(chapters) == 1:
        yield _frame({"status": "生成结构树"})
        node = await _gen_chapter_subtree(book, chapters[0])
        if node:
            yield _frame({"artifact": {"type": "mindmap", "data": json.dumps(node, ensure_ascii=False)}})
            return
        yield _frame({"status": "结构树解析失败，改用大纲模式"})
        async for frame in _mindmap_markdown(request, chapters, scope_desc):
            yield frame
        return

    groups = [chapters[i:i + MAP_GROUP_SIZE] for i in range(0, len(chapters), MAP_GROUP_SIZE)]
    themes_map = {}
    for i, grp in enumerate(groups, 1):
        yield _frame({"status": f"生成骨架 {i}/{len(groups)} 段"})
        seg = await _gen_themes_batch(book, grp)
        for k, v in seg.items():
            themes_map.setdefault(k, []).extend(v)
    yield _frame({"status": "组装结构树"})
    root = _build_book_tree(book, chapters, themes_map)
    yield _frame({"artifact": {"type": "mindmap", "data": json.dumps(root, ensure_ascii=False)}})


async def _mindmap_markdown(request, chapters, scope_desc):
    """旧版 Markdown 思维导图（仅作 JSON 生成失败时的降级路径）"""
    book = _book_title(request.book_id)
    context = _context(chapters)

    if len(chapters) == 1:
        anchor_rule = f"- # 一级：《{book}》→「{chapters[0].title}」\n- ## 二级：该章的核心小节/主题\n- ### 三级：每个主题下的关键论点\n- #### 四级：支撑论点的具体论据、案例、数据"
    else:
        title_lines = "\n".join(f"{i + 1}. {ch.title}" for i, ch in enumerate(chapters))
        anchor_rule = f"""- # 一级：《{book}》
- ## 二级：章节标题——必须逐条使用下面列表中的原文标题，每章恰好一个、顺序一致，不得改写、合并或遗漏：
{title_lines}
- ### 三级：该章的核心主题/小节标题
- #### 四级：每个主题下的关键论点（作者的主张是什么）
- ##### 五级：支撑该论点的具体论据、案例、数据"""

    prompt = f"""请为《{book}》（作用范围：{scope_desc}）生成一份详尽的思维导图。

使用 Markdown 标题层级（# 一级 ## 二级 ### 三级 #### 四级 ##### 五级）：

层级结构要求：
{anchor_rule}

核心要求：
- 深入到第四级和第五级，把每个论点的论据说透
- 第五级要包含书中真实出现过的具体内容，如：人名、事件、数据、引文原文、比喻或故事
- 结构要反映作者的论证逻辑链条，而非简单的要点罗列

书籍内容：
{context}

请直接输出 Markdown 格式的思维导图结构，不要输出任何前言、说明、结尾语或客套话。第一行必须是 # 开头的标题。"""
    async for frame in _stream_prompt(prompt):
        yield frame


async def _author_talk(request, chapters, scope_desc):
    """与作者对谈 —— 问题先经语义检索书中相关段落，AI 以作者视角基于书中论点回答并标注出处"""
    question = (request.user_input or "").strip()
    if not question:
        yield _frame({"content": "请输入你想问作者的问题。"})
        return

    yield _frame({"status": "检索书中相关段落"})
    results = await book_processor.search_chapters(
        query=question, book_ids=[request.book_id], n_results=6
    )
    sources = [{
        "book_title": r.book_title,
        "chapter_title": r.title,
        "chapter_id": r.chapter_id,
        "book_id": r.book_id,
    } for r in results]
    if sources:
        yield _frame({"sources": sources})

    book = _book_title(request.book_id)
    if results:
        passages = "\n\n".join(
            f"〔出自《{r.title}》〕\n{r.content_snippet}" for r in results
        )
    else:
        passages = "（未检索到与问题直接相关的段落）"

    prompt = f"""你是一位读者正在向《{book}》的作者本人提问。请扮演这位作者，以第一人称回答。

【读者问题】
{question}

【书中与问题相关的原文段落】
{passages}

回答要求：
1. 基于书中真实观点回答；引用时标注出自哪一节，如"正如我在《××》里写的"
2. 书中没有谈到的内容，坦白说明书中未涉及，可谨慎延伸但必须声明这是书外之谈
3. 语气如作者面对面的深入对谈，有立场、有细节，不要空泛客套
4. 600 字左右，纯文本，不要使用 Markdown 符号"""
    async for frame in _stream_prompt(prompt):
        yield frame


def _build_knowledge_html(book_title: str, author: str, chapters_data: list, keyword_index: list, recommendations: list) -> str:
    """组装精读笔记 HTML 页面"""
    now = __import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M')

    cards_html = ""
    for ch in chapters_data:
        excerpts_html = ""
        for ex in ch.get("excerpts", []):
            excerpts_html += f"""
                    <div class="excerpt-block">
                        <div class="excerpt-text">「{ex.get('text', '')}」</div>
                        <div class="excerpt-annotation">{ex.get('annotation', '')}</div>
                    </div>"""

        cards_html += f"""
            <div class="chapter-card">
                <div class="card-header">
                    <span class="chapter-num">{ch.get('index', '')}</span>
                    <h2>{ch.get('title', '')}</h2>
                </div>
                <div class="card-body">
                    <div class="field">
                        <div class="field-label">摘要</div>
                        <p>{ch.get('summary', '')}</p>
                    </div>
                    <div class="field">
                        <div class="field-label">关键词</div>
                        <div class="keyword-tags">{''.join(f'<span class="tag">{kw}</span>' for kw in ch.get('keywords', []))}</div>
                    </div>
                    <div class="field">
                        <div class="field-label">关键摘录</div>{excerpts_html}
                    </div>
                    <div class="field notes-area">
                        <div class="field-label">我的笔记</div>
                        <div class="notes-lines"></div>
                    </div>
                </div>
            </div>"""

    index_html = ""
    for item in keyword_index:
        index_html += f"""
                <div class="index-item">
                    <span class="index-concept">{item.get('concept', '')}</span>
                    <span class="index-desc">{item.get('description', '')}</span>
                    <span class="index-chapters">{', '.join(item.get('chapters', []))}</span>
                </div>"""

    recs_html = ""
    for r in recommendations:
        recs_html += f"""
                <div class="rec-item">
                    <div class="rec-title">《{r.get('title', '')}》<span class="rec-author">— {r.get('author', '')}</span></div>
                    <div class="rec-reason">{r.get('reason', '')}</div>
                </div>"""

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>《{book_title}》精读笔记</title>
<style>
    *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{
        font-family: "Noto Serif SC", "Source Han Serif SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", serif;
        background: #fafafa; color: #3f3f46; line-height: 1.8; padding: 40px 20px;
    }}
    .container {{ max-width: 800px; margin: 0 auto; }}
    .page-header {{
        text-align: center; padding: 48px 0 40px; border-bottom: 1px solid #e4e4e7; margin-bottom: 40px;
    }}
    .page-header h1 {{ font-size: 28px; font-weight: 700; color: #18181b; letter-spacing: 0.05em; margin-bottom: 8px; }}
    .page-header .meta {{ font-size: 13px; color: #a1a1aa; }}
    .chapter-card {{
        background: #fff; border: 1px solid #e4e4e7; border-radius: 16px; margin-bottom: 20px;
        overflow: hidden; page-break-inside: avoid; transition: box-shadow 0.2s;
    }}
    .chapter-card:hover {{ box-shadow: 0 2px 16px rgba(0,0,0,0.04); }}
    .card-header {{
        display: flex; align-items: baseline; gap: 10px; padding: 20px 24px 14px;
        border-bottom: 1px solid #f4f4f5;
    }}
    .chapter-num {{ font-size: 11px; font-weight: 600; color: #a1a1aa; text-transform: uppercase; letter-spacing: 0.1em; }}
    .card-header h2 {{ font-size: 17px; font-weight: 700; color: #18181b; }}
    .card-body {{ padding: 18px 24px 20px; }}
    .field {{ margin-bottom: 16px; }}
    .field:last-child {{ margin-bottom: 0; }}
    .field-label {{
        font-size: 11px; font-weight: 600; color: #a1a1aa; text-transform: uppercase;
        letter-spacing: 0.1em; margin-bottom: 6px;
    }}
    .field p {{ font-size: 14px; color: #52525b; text-indent: 2em; }}
    .keyword-tags {{ display: flex; flex-wrap: wrap; gap: 6px; }}
    .tag {{
        display: inline-block; padding: 2px 10px; font-size: 12px; color: #52525b;
        background: #f4f4f5; border-radius: 100px;
    }}
    .excerpt-block {{
        margin-bottom: 12px; padding: 12px 16px; background: #fafafa;
        border-left: 3px solid #d4d4d8; border-radius: 0 8px 8px 0;
    }}
    .excerpt-text {{ font-size: 14px; color: #18181b; font-style: italic; margin-bottom: 6px; line-height: 1.7; }}
    .excerpt-annotation {{
        font-size: 12px; color: #71717a; padding-top: 6px; border-top: 1px dashed #e4e4e7;
    }}
    .notes-area {{ margin-top: 8px; }}
    .notes-lines {{
        min-height: 80px; border-radius: 8px;
        background: repeating-linear-gradient(transparent, transparent 27px, #e4e4e7 28px);
    }}
    .appendix {{
        margin-top: 48px; padding-top: 32px; border-top: 1px solid #e4e4e7;
    }}
    .appendix h2 {{
        font-size: 20px; font-weight: 700; color: #18181b; text-align: center; margin-bottom: 24px;
        letter-spacing: 0.05em;
    }}
    .appendix h3 {{ font-size: 15px; font-weight: 700; color: #3f3f46; margin: 24px 0 12px; }}
    .index-item {{
        display: flex; align-items: baseline; gap: 12px; padding: 8px 0;
        border-bottom: 1px solid #f4f4f5; font-size: 13px;
    }}
    .index-concept {{ font-weight: 600; color: #18181b; min-width: 80px; }}
    .index-desc {{ color: #52525b; flex: 1; }}
    .index-chapters {{ font-size: 11px; color: #a1a1aa; white-space: nowrap; }}
    .rec-item {{ padding: 12px 16px; margin-bottom: 8px; background: #fafafa; border-radius: 10px; }}
    .rec-title {{ font-size: 14px; font-weight: 600; color: #18181b; }}
    .rec-author {{ font-weight: 400; color: #a1a1aa; }}
    .rec-reason {{ font-size: 13px; color: #71717a; margin-top: 4px; }}
    .page-footer {{
        text-align: center; padding: 40px 0 20px; font-size: 12px; color: #d4d4d8;
    }}
    @media print {{
        body {{ background: #fff; padding: 0; }}
        .chapter-card {{ box-shadow: none; break-inside: avoid; }}
    }}
</style>
</head>
<body>
<div class="container">
    <header class="page-header">
        <h1>《{book_title}》精读笔记</h1>
        <p class="meta">{author} &nbsp;·&nbsp; 生成于 {now}</p>
    </header>
    <main>{cards_html}
    </main>
    <section class="appendix">
        <h2>附录</h2>
        <h3>核心概念索引</h3>
        <div class="index-list">{index_html}
        </div>
        <h3>相关推荐</h3>
        <div class="rec-list">{recs_html}
        </div>
    </section>
    <footer class="page-footer">
        由 AI 智能读书助手生成 &nbsp;·&nbsp; 内容仅供参考
    </footer>
</div>
</body>
</html>"""


async def _knowledge_graph(request, chapters, scope_desc):
    """精读笔记 —— 生成 HTML 卡片页（P1 将改为 JSON + 前端渲染）"""
    entry = books_index.get(request.book_id)
    book = getattr(entry, "title", "") or ""
    author = getattr(entry, "author", "") or "未知作者"

    selected = chapters[:24]
    chapter_texts = []
    for i, ch in enumerate(selected):
        chapter_texts.append(f"--- 第{i+1}节：{ch.title} ---\n{ch.content[:1500]}")

    book_content = "\n\n".join(chapter_texts)
    chapter_names = "\n".join([f"{i+1}. {ch.title}" for i, ch in enumerate(selected)])

    yield _frame({"status": "生成精读笔记"})

    prompt = f"""你是一位资深的阅读编辑，请为以下书籍生成一份精读笔记内容。我需要你输出一个严格格式的文本，以便程序解析后生成HTML页面。

【书籍内容】
{book_content}

【章节列表】
{chapter_names}

请按以下格式输出（严格按照标记，每个字段独立一行）：

[BOOK]
标题：{book or '根据内容推断的书名'}
作者：{author or '根据内容推断的作者'}

[CHAPTERS]
（为每一章输出以下内容块，用 ===CHAPTER=== 分隔）

===CHAPTER===
序号：{selected[0].chapter_index if selected else 1}
标题：章节标题
摘要：一段简明摘要（50-100字）
关键词：词1, 词2, 词3, 词4
摘录1：从这里提供的章节原文中，精选一句最有价值的原文（必须是从上面书籍内容中真实存在的句子）
批注1：对摘录1的AI点评（30-50字）
摘录2：再精选一句有价值的原文（必须是从上面书籍内容中真实存在的句子）
批注2：对摘录2的AI点评（30-50字）

（后续章节也用相同格式）

[INDEX]
概念：核心概念名 | 简述：一句话说明 | 出现章节：第1章, 第3章
概念：另一个核心概念 | 简述：一句话说明 | 出现章节：第2章, 第5章
（输出5-8个核心概念）

[RECOMMEND]
书名：推荐书名1 | 作者：作者名 | 理由：推荐理由（1-2句）
书名：推荐书名2 | 作者：作者名 | 理由：推荐理由（1-2句）
（输出3-5本相关推荐书籍）

重要要求：
1. "摘录"必须是从上面提供的书籍原文中复制的真实句子，不能自己编造
2. 每章至少提供2条摘录，每条摘录控制在50字以内
3. 关键词控制在3-5个，用中文逗号分隔
4. 全书核心概念索引5-8个
5. 推荐书籍请确保是真实存在的出版物"""

    response = await analysis_service.llm.ainvoke([HumanMessage(content=prompt)])
    raw = response.content

    # 解析 AI 返回的结构化文本
    chapters_data = []
    keyword_index = []
    recommendations = []
    book_title = ""

    current_section = None
    current_chapter = {}
    excerpts = []

    for line in raw.split('\n'):
        line = line.strip()
        if not line:
            continue

        if line == '[BOOK]':
            current_section = 'book'
            continue
        elif line == '[CHAPTERS]':
            current_section = 'chapters'
            continue
        elif line == '[INDEX]':
            if current_chapter:
                current_chapter['excerpts'] = excerpts
                chapters_data.append(current_chapter)
                current_chapter = {}
                excerpts = []
            current_section = 'index'
            continue
        elif line == '[RECOMMEND]':
            current_section = 'recommend'
            continue

        if current_section == 'book':
            if line.startswith('标题：'):
                book_title = line.replace('标题：', '').strip()
            elif line.startswith('作者：'):
                author = line.replace('作者：', '').strip()

        elif current_section == 'chapters':
            if line == '===CHAPTER===':
                if current_chapter:
                    current_chapter['excerpts'] = excerpts
                    chapters_data.append(current_chapter)
                current_chapter = {}
                excerpts = []
            elif line.startswith('序号：'):
                current_chapter['index'] = line.replace('序号：', '').strip()
            elif line.startswith('标题：'):
                current_chapter['title'] = line.replace('标题：', '').strip()
            elif line.startswith('摘要：'):
                current_chapter['summary'] = line.replace('摘要：', '').strip()
            elif line.startswith('关键词：'):
                kws = line.replace('关键词：', '').strip()
                current_chapter['keywords'] = [k.strip() for k in kws.replace('，', ',').split(',') if k.strip()]
            elif line.startswith('摘录') and line[2].isdigit():
                txt = line.split('：', 1)[1].strip() if '：' in line else ''
                excerpts.append({'text': txt, 'annotation': ''})
            elif line.startswith('批注') and line[2].isdigit():
                idx_str = line.split('：')[0].replace('批注', '')
                txt = line.split('：', 1)[1].strip() if '：' in line else ''
                try:
                    idx = int(idx_str) - 1
                    while len(excerpts) <= idx:
                        excerpts.append({'text': '', 'annotation': ''})
                    excerpts[idx]['annotation'] = txt
                except ValueError:
                    pass

        elif current_section == 'index':
            if line.startswith('概念：'):
                parts = line.split('|')
                concept = parts[0].replace('概念：', '').strip() if parts else ''
                desc = parts[1].replace('简述：', '').strip() if len(parts) > 1 else ''
                chs = parts[2].replace('出现章节：', '').strip() if len(parts) > 2 else ''
                keyword_index.append({
                    'concept': concept,
                    'description': desc,
                    'chapters': [c.strip() for c in chs.replace('，', ',').split(',') if c.strip()]
                })

        elif current_section == 'recommend':
            if line.startswith('书名：'):
                parts = line.split('|')
                title = parts[0].replace('书名：', '').strip() if parts else ''
                auth = parts[1].replace('作者：', '').strip() if len(parts) > 1 else ''
                reason = parts[2].replace('理由：', '').strip() if len(parts) > 2 else ''
                recommendations.append({'title': title, 'author': auth, 'reason': reason})

    # Don't forget the last chapter
    if current_chapter:
        current_chapter['excerpts'] = excerpts
        chapters_data.append(current_chapter)

    # Fallback: if parsing yielded no chapters, use raw response as summary
    if not chapters_data:
        chapters_data = [{
            'index': '1',
            'title': '全书概览',
            'summary': raw[:500],
            'keywords': [],
            'excerpts': []
        }]

    if not book_title:
        book_title = book or (chapters[0].title if chapters else "未命名")

    html = _build_knowledge_html(book_title, author, chapters_data, keyword_index, recommendations)
    yield _frame({"artifact": {"type": "html", "data": html, "filename": f"{book_title}_精读笔记.html"}})


# ---------------------------------------------------------------- 知识卡片（v2.3）

CARDS_TOTAL_CAP = 40   # 全书抽卡总量上限（防一次抽太多复习不动）


def _cards_prompt(book: str, scope_desc: str, body: str, n: int) -> str:
    return f"""你是读书助手。从下面的内容中提炼 {n} 张适合长期记忆的知识卡片（抽卡式的回忆提示）。
卡片要求：
- front：一个问题或填空，具体明确、能一句话回答（50 字以内），不要出无意义或大而空的题
- back：答案，准确自足、脱离原书也能看懂（200 字以内）
- cite：内容中支撑该卡的原句摘录（60 字以内，必须真实存在，禁止编造；没有可留空）
- 优先提取：核心概念、关键论据、反直觉的结论、值得记住的事实细节
只输出 JSON，不要任何其他文字，格式：
{{"cards":[{{"front":"...","back":"...","cite":"..."}}]}}

《{book}》· {scope_desc}
{body}"""


def _clean_cards(obj) -> list:
    """校验 LLM 输出的卡片数组：front/back 必须非空，去空白重复，限幅"""
    raw = obj.get("cards") if isinstance(obj, dict) else None
    if not isinstance(raw, list):
        return []
    out, seen = [], set()
    for it in raw[:12]:
        if not isinstance(it, dict):
            continue
        front = str(it.get("front", "")).strip()
        back = str(it.get("back", "")).strip()
        if not front or not back:
            continue
        key = "".join(front.split())
        if key in seen:
            continue
        seen.add(key)
        out.append({"front": front, "back": back, "cite": str(it.get("cite", "")).strip()})
    return out


async def _cards(request, chapters, scope_desc):
    """知识卡片抽卡：产出直接入库 card_store（去重），artifact 帧带入库卡列表进对话流"""
    from app.services import card_store
    book = _book_title(request.book_id)
    single = len(chapters) == 1
    if single:
        groups = [(chapters, 8)]
    else:
        gs = [chapters[i:i + MAP_GROUP_SIZE] for i in range(0, len(chapters), MAP_GROUP_SIZE)]
        groups = [(g, 3) for g in gs]

    collected = []      # (cards, chapter_id, chapter_title)
    failed = 0
    for i, (grp, n) in enumerate(groups, 1):
        label = grp[0].title if single else f"{grp[0].title} 等 {len(grp)} 章"
        yield _frame({"status": f"提炼卡片 {i}/{len(groups)}"})
        obj = await _llm_json(_cards_prompt(book, label, _context(grp), n))
        cards = _clean_cards(obj)[:n]   # 每组硬截断：数量约束不能只靠 prompt 自觉
        if not cards:
            failed += 1
            continue
        cid = grp[0].chapter_id if single else None
        ctitle = grp[0].title if single else None
        collected.append((cards, cid, ctitle))
        if sum(len(c) for c, _, _ in collected) >= CARDS_TOTAL_CAP:
            collected = collected[:i]
            break

    if not collected:
        yield _frame({"error": "卡片生成失败（模型输出未能解析），请重试"})
        return

    added_total, skipped_total, all_cards = 0, 0, []
    for cards, cid, ctitle in collected:
        if len(all_cards) + len(cards) > CARDS_TOTAL_CAP:
            cards = cards[:CARDS_TOTAL_CAP - len(all_cards)]
            if not cards:
                break
        result = card_store.add_cards(request.book_id, cards, chapter_id=cid, chapter_title=ctitle)
        added_total += result["added"]
        skipped_total += result["skipped"]
        all_cards.extend(result["cards"])

    note = f"已存入 {added_total} 张新卡片"
    if skipped_total:
        note += f"（跳过 {skipped_total} 张重复）"
    if failed:
        note += f"，{failed} 组生成失败"
    yield _frame({"status": note})
    yield _frame({"artifact": {"type": "cards", "data": json.dumps({"note": note, "cards": all_cards}, ensure_ascii=False)}})


_STREAM_TOOLS = {
    "summarize": _summarize,
    "questions": _questions,
    "mindmap": _mindmap,
    "author-talk": _author_talk,
    "knowledge-graph": _knowledge_graph,
    "cards": _cards,
}


@router.post("/{tool_id}/stream")
async def run_tool_stream(tool_id: str, request: ToolRequest):
    """运行指定工具（SSE 流式）。作用范围 = 左栏当前选中：chapter_id 命中当前章，否则整本书"""
    fn = _STREAM_TOOLS.get(tool_id)
    if not fn:
        raise HTTPException(status_code=404, detail=f"未知工具: {tool_id}")

    chapters, scope_desc = _resolve_scope(request)

    async def generate():
        try:
            # chapter_id 传了却没命中（孤章：目录有、内容未入索引）→ 静默回退整本书会让用户困惑，显式说明
            if request.chapter_id and len(chapters) > 1:
                yield _frame({"status": "当前章内容未入索引，范围已自动回退为整本书"})
            async for frame in fn(request, chapters, scope_desc):
                yield frame
        except Exception as e:
            yield _frame({"error": f"工具执行失败: {e}"})
        yield DONE_FRAME

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


class MindmapExpandRequest(BaseModel):
    book_id: str
    chapter_id: str


@router.post("/mindmap/expand/stream")
async def mindmap_expand_stream(request: MindmapExpandRequest):
    """思维导图章节按需展开（v2.1 M1）：按该章全文生成深层结构子树。
    SSE：status 帧 + artifact 帧 {type:"mindmap-subtree", data:<节点 JSON>}；章节不存在 404"""
    chapter = book_processor.get_chapter_by_id(request.chapter_id)
    if not chapter or chapter.book_id != request.book_id:
        raise HTTPException(status_code=404, detail="找不到该章节")

    async def generate():
        try:
            yield _frame({"status": "通读全章，展开分支"})
            node = await _gen_chapter_subtree(_book_title(request.book_id), chapter)
            if node:
                yield _frame({"artifact": {"type": "mindmap-subtree", "data": json.dumps(node, ensure_ascii=False)}})
            else:
                yield _frame({"error": "展开结果未能解析，请重试"})
        except Exception as e:
            yield _frame({"error": f"展开失败: {e}"})
        yield DONE_FRAME

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )
