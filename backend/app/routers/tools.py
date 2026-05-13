"""
AI工具路由 - 右侧工具栏的后端接口
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from app.services.book_processor import book_processor
from app.services.analysis_service import analysis_service
from app.models.book_models import Chapter

router = APIRouter(prefix="/api/tools", tags=["AI工具"])


def _get_book_chapters(book_id: str):
    """从 ChromaDB 获取指定书籍的所有章节"""
    results = book_processor.collection.get(
        where={"book_id": book_id},
        include=["documents", "metadatas"]
    )
    chapters = []
    if results["ids"]:
        for i, doc_id in enumerate(results["ids"]):
            content = results["documents"][i]
            metadata = results["metadatas"][i]
            chapters.append(Chapter(
                chapter_id=doc_id,
                book_id=book_id,
                title=metadata.get("title", ""),
                content=content,
                word_count=len(content),
                chapter_index=metadata.get("chapter_index", 0)
            ))
    return sorted(chapters, key=lambda c: c.chapter_index)


class ToolRequest(BaseModel):
    book_id: str
    chapter_id: Optional[str] = None
    user_input: Optional[str] = None


@router.post("/{tool_id}")
async def run_tool(tool_id: str, request: ToolRequest):
    """运行指定工具"""

    # 获取书籍章节
    chapters = _get_book_chapters(request.book_id)
    if not chapters and request.chapter_id:
        chapter = book_processor.get_chapter_by_id(request.chapter_id)
        chapters = [chapter] if chapter else []
    if not chapters:
        raise HTTPException(status_code=404, detail="找不到书籍或章节内容")

    if tool_id == "summarize":
        return await _summarize(request, chapters)
    elif tool_id == "background":
        return await _background(request, chapters)
    elif tool_id == "questions":
        return await _questions(request, chapters)
    elif tool_id == "mindmap":
        return await _mindmap(request, chapters)
    elif tool_id == "recommend":
        return await _recommend(request, chapters)
    elif tool_id == "debate":
        return await _debate(request, chapters)
    elif tool_id == "knowledge-graph":
        return await _knowledge_graph(request, chapters)
    else:
        raise HTTPException(status_code=404, detail=f"未知工具: {tool_id}")


def _get_context(chapters, chapter_id=None):
    """获取要分析的文本内容"""
    if chapter_id:
        for ch in chapters:
            if ch.chapter_id == chapter_id:
                return f"《{ch.title}》\n{ch.content[:10000]}"
        return ""
    # 全书：取每章前2000字
    parts = []
    for ch in chapters[:20]:
        parts.append(f"[{ch.title}]\n{ch.content[:2000]}")
    return "\n\n".join(parts)


async def _summarize(request, chapters):
    """总结 - 用户可指定整本书或特定章节"""
    user_spec = (request.user_input or "").strip()
    if not user_spec:
        return {"data": "请说明你想总结的范围，例如「整本书」或「第3章」"}

    # 尝试理解用户指定的章节
    target_chapter = request.chapter_id
    context = _get_context(chapters, target_chapter)

    prompt = f"""用户想总结的内容：{user_spec}

请根据以下书籍内容，提供详细的总结：

{context[:8000]}

请提供：
1. 核心内容概述（300字左右）
2. 关键论点与论据
3. 重要的概念和结论

格式要求：每个部分用编号作为标题行（如"1. 核心内容概述"），标题行后换行写正文。请用纯文本，不要使用 Markdown 符号。"""
    from langchain.schema import HumanMessage

    response = await analysis_service.llm.ainvoke([HumanMessage(content=prompt)])
    return {"data": response.content}


async def _background(request, chapters):
    """背景调研"""
    context = _get_context(chapters)

    prompt = f"""请为以下书籍内容提供详细的背景调研分析：

{context[:6000]}

请从以下角度分析：
1. 时代背景：这本书创作的历史和社会背景
2. 作者背景：作者的身份、立场及其对内容的影响
3. 学术脉络：这本书在相关学术领域中的位置
4. 核心争论：书中涉及的主要学术或思想争论
5. 影响力：这本书发布后产生的影响和回响"""
    from langchain.schema import HumanMessage

    response = await analysis_service.llm.ainvoke([HumanMessage(content=prompt)])
    return {"data": response.content}


async def _questions(request, chapters):
    """读书十问 - 固定10个问题的模板"""
    context = _get_context(chapters)

    prompt = f"""请基于以下书籍内容，回答以下10个问题。每个问题请给出具体、有深度的回答，引用书中内容作为依据。

书籍内容：
{context[:8000]}

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
    from langchain.schema import HumanMessage

    response = await analysis_service.llm.ainvoke([HumanMessage(content=prompt)])
    return {"data": response.content}


async def _mindmap(request, chapters):
    """思维导图 - 生成 Markdown 层级结构，供 markmap 渲染"""
    user_spec = (request.user_input or "").strip()
    scope_desc = user_spec if user_spec else "整本书"

    # 根据用户指定范围筛选章节内容
    target_chapters = chapters
    if user_spec:
        import re
        # 尝试匹配 "第X章" 或 "第X-Y章"
        matches = re.findall(r'第\s*(\d+)\s*[章\-—至到]\s*(\d+)?', user_spec)
        if matches:
            start = int(matches[0][0])
            end = int(matches[0][1]) if matches[0][1] else start
            target_chapters = [ch for ch in chapters if start <= ch.chapter_index <= end]

    if not target_chapters:
        target_chapters = chapters

    context = _get_context(target_chapters)

    prompt = f"""请为以下书籍内容生成一份极其详尽的思维导图。用户想了解的范围：{scope_desc}

使用 Markdown 标题层级（# 一级 ## 二级 ### 三级 #### 四级 ##### 五级 ###### 六级）：

层级结构要求：
- # 一级：书名
- ## 二级：章节标题
- ### 三级：该章的核心主题/小节标题
- #### 四级：每个主题下的关键论点（作者的主张是什么）
- ##### 五级：支撑该论点的具体论据、案例、数据
- ###### 六级（重要）：对论据的进一步展开——原文中的具体例子、关键引文、数据细节、作者的推理步骤

核心要求：
- 必须深入到第五级和第六级，把每个论点的论据说透
- 不要写"15字以内"这种限制，每个节点写出完整意思
- 第六级要包含书中真实出现过的具体内容，如：人名、事件、数据、引文原文、比喻或故事
- 结构要反映作者的论证逻辑链条，而非简单的要点罗列
- 确保覆盖书中所有主要论点，不要遗漏重要内容

书籍内容：
{context[:12000]}

请直接输出 Markdown 格式的思维导图结构，不要输出任何前言、说明、结尾语或客套话。第一行必须是 # 开头的标题。第五级和第六级是关键。"""
    from langchain.schema import HumanMessage

    response = await analysis_service.llm.ainvoke([HumanMessage(content=prompt)])
    return {"data": response.content}


async def _recommend(request, chapters):
    """书籍推荐 - 推荐同主题书籍"""
    context = _get_context(chapters)

    prompt = f"""请根据以下书籍内容，推荐 3-5 本相同主题或相似内容的书籍。

书籍内容：
{context[:5000]}

请按以下格式推荐：

1. 《书名》- 作者
   - 推荐理由：（1-2句话，说明为什么推荐）
   - 与本书的关联：（与当前书籍的异同或互补关系）
   - 适合读者：（什么样的读者适合读这本）

请确保推荐真实存在的书籍，推荐理由要具体。"""
    from langchain.schema import HumanMessage

    response = await analysis_service.llm.ainvoke([HumanMessage(content=prompt)])
    return {"data": response.content}


async def _debate(request, chapters):
    """芒格辩论法 - 跨学科正反辩论"""
    if not request.user_input:
        return {"data": "请输入书中你想辩论的观点（ 如「人与AI可不可以和谐共生」 ）"}

    prompt = f"""用户输入的观点：{request.user_input}

请用查理·芒格推崇的「多元思维模型」辩论法，模拟以下四个领域的专家从正反两方对这个观点进行辩论：

## 一、经济学专家视角
正方（支持）：从经济学角度如何论证这个观点？
反方（质疑）：从经济学角度如何质疑这个观点？

## 二、心理学专家视角
正方（支持）：从心理学角度如何论证？
反方（质疑）：从心理学角度如何质疑？

## 三、社会学专家视角
正方（支持）：从社会学角度如何论证？
反方（质疑）：从社会学角度如何质疑？

## 四、哲学/逻辑学专家视角
正方（支持）：从哲学/逻辑学角度如何论证？
反方（质疑）：从哲学/逻辑学角度如何质疑？

## 总结
- 这个观点的前提假设是什么？
- 它的适用边界在哪里？
- 综合四个角度，你的最终评估是什么？

请用纯文本格式，每个专家的回答要具体、有深度，避免泛泛而谈。"""
    from langchain.schema import HumanMessage

    response = await analysis_service.llm.ainvoke([HumanMessage(content=prompt)])
    return {"data": response.content}


def _build_knowledge_html(book_title: str, author: str, chapters_data: list, keyword_index: list, recommendations: list) -> str:
    """组装知识图谱 HTML 页面"""
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


async def _knowledge_graph(request, chapters):
    """知识图谱 HTML 导出 - 生成精读笔记卡片页"""
    from langchain.schema import HumanMessage

    # 限制章节数量，控制 token 消耗
    selected = chapters[:20]
    chapter_texts = []
    for i, ch in enumerate(selected):
        chapter_texts.append(f"--- 第{i+1}章：{ch.title} ---\n{ch.content[:1500]}")

    book_content = "\n\n".join(chapter_texts)
    chapter_names = "\n".join([f"{i+1}. {ch.title}" for i, ch in enumerate(selected)])

    prompt = f"""你是一位资深的阅读编辑，请为以下书籍生成一份精读笔记内容。我需要你输出一个严格格式的文本，以便程序解析后生成HTML页面。

【书籍内容】
{book_content}

【章节列表】
{chapter_names}

请按以下格式输出（严格按照标记，每个字段独立一行）：

[BOOK]
标题：根据内容推断的书名
作者：根据内容推断的作者

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
    author = "未知作者"

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
                # Ensure excerpts list has enough slots
                idx_str = line.split('：')[0].replace('摘录', '')
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
        book_title = chapters[0].title if chapters else "未命名"

    html = _build_knowledge_html(book_title, author, chapters_data, keyword_index, recommendations)
    return {"data": html, "type": "html", "filename": f"{book_title}_精读笔记.html"}
