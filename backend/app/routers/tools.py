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
    else:
        raise HTTPException(status_code=404, detail=f"未知工具: {tool_id}")


def _get_context(chapters, chapter_id=None):
    """获取要分析的文本内容"""
    if chapter_id:
        for ch in chapters:
            if ch.chapter_id == chapter_id:
                return f"《{ch.title}》\n{ch.content[:6000]}"
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
3. 重要的概念和结论"""
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

格式要求：请用纯文本回答，每个问题请编号并分段回答。"""
    from langchain.schema import HumanMessage

    response = await analysis_service.llm.ainvoke([HumanMessage(content=prompt)])
    return {"data": response.content}


async def _mindmap(request, chapters):
    """思维导图 - 生成 Markdown 层级结构，供 markmap 渲染"""
    context = _get_context(chapters)

    prompt = f"""请为以下书籍内容生成思维导图结构。使用 Markdown 标题层级（# 一级 ## 二级 ### 三级等）。

要求：
- 一级标题：书名
- 二级标题：核心主题/主要章节
- 三级标题：关键论点、概念、论据
- 四级标题：具体细节、案例
- 每个节点控制在10个字以内
- 整体结构要清晰反映书的知识框架

书籍内容：
{context[:6000]}

输出示例：
# 书名
## 核心主题一
### 关键概念
### 主要论据
## 核心主题二
### 分支观点

请直接输出 Markdown 格式的思维导图结构。"""
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
        return {"data": "请输入书中你想辩论的观点（如「耶稣的复活是历史事件」）"}

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
