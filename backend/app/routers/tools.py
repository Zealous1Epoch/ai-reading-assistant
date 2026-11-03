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
  data: {"artifact": {...}}  非文本产物（精读笔记 HTML）
  data: {"error": "..."}     执行失败
  data: [DONE]
"""
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from langchain_core.messages import HumanMessage
from pydantic import BaseModel
from typing import List, Optional
import json

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


async def _mindmap(request, chapters, scope_desc):
    """思维导图 —— 章节锚定用左栏选中的真实标题，不再正则猜编号"""
    book = _book_title(request.book_id)
    context = _context(chapters)

    if len(chapters) == 1:
        anchor_rule = f"- # 一级：《{book}》→「{chapters[0].title}」\n- ## 二级：该章的核心小节/主题\n- ### 三级：每个主题下的关键论点\n- #### 四级：支撑论点的具体论据、案例、数据\n- ##### 五级：论据的展开——原文中的具体例子、关键引文、数据细节、作者的推理步骤"
    else:
        title_lines = "\n".join(f"{i + 1}. {ch.title}" for i, ch in enumerate(chapters))
        anchor_rule = f"""- # 一级：《{book}》
- ## 二级：章节标题——必须逐条使用下面列表中的原文标题，每章恰好一个、顺序一致，不得改写、合并或遗漏：
{title_lines}
- ### 三级：该章的核心主题/小节标题
- #### 四级：每个主题下的关键论点（作者的主张是什么）
- ##### 五级：支撑该论点的具体论据、案例、数据"""

    prompt = f"""请为《{book}》（作用范围：{scope_desc}）生成一份极其详尽的思维导图。

使用 Markdown 标题层级（# 一级 ## 二级 ### 三级 #### 四级 ##### 五级）：

层级结构要求：
{anchor_rule}

核心要求：
- 必须深入到第四级和第五级，把每个论点的论据说透
- 不要写"15字以内"这种限制，每个节点写出完整意思
- 第五级要包含书中真实出现过的具体内容，如：人名、事件、数据、引文原文、比喻或故事
- 结构要反映作者的论证逻辑链条，而非简单的要点罗列
- 确保覆盖范围内所有主要论点，不要遗漏重要内容

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


_STREAM_TOOLS = {
    "summarize": _summarize,
    "questions": _questions,
    "mindmap": _mindmap,
    "author-talk": _author_talk,
    "knowledge-graph": _knowledge_graph,
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
