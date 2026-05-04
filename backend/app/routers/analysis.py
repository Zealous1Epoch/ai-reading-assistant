from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, List
import json

from app.services.analysis_service import analysis_service
from app.services.book_processor import book_processor

router = APIRouter(prefix="/analysis", tags=["AI分析"])


class ChatRequest(BaseModel):
    """聊天请求"""
    message: str
    chapter_id: Optional[str] = None
    book_id: Optional[str] = None
    selected_book_ids: Optional[List[str]] = None
    chat_history: Optional[List[dict]] = None


class QuickAnalysisRequest(BaseModel):
    """快速分析请求"""
    text: str
    analysis_type: str = "summary"  # summary, key_points, critique


@router.post("/chapter/{chapter_id}")
async def analyze_chapter(chapter_id: str):
    """
    深度分析章节

    返回：
    - 论点论据
    - 杠精视角提问
    - 对话总结
    """
    # 获取章节内容
    chapter = book_processor.get_chapter_by_id(chapter_id)
    if not chapter:
        raise HTTPException(status_code=404, detail="章节不存在")

    result = await analysis_service.analyze_chapter(
        chapter_content=chapter.content,
        chapter_title=chapter.title
    )

    return {
        "chapter_id": chapter_id,
        "chapter_title": chapter.title,
        "analysis": result
    }


@router.get("/chapter/{chapter_id}/summary")
async def get_chapter_summary(chapter_id: str):
    """获取章节摘要和关键词"""
    chapter = book_processor.get_chapter_by_id(chapter_id)
    if not chapter:
        raise HTTPException(status_code=404, detail="章节不存在")

    result = await analysis_service.generate_chapter_summary(
        title=chapter.title,
        content=chapter.content
    )

    return {
        "chapter_id": chapter_id,
        "chapter_title": chapter.title,
        "summary": result["summary"],
        "keywords": result["keywords"]
    }


@router.post("/quick")
async def quick_analysis(request: QuickAnalysisRequest):
    """快速分析文本"""
    result = await analysis_service.quick_analysis(
        text=request.text,
        analysis_type=request.analysis_type
    )
    return {"result": result}


@router.post("/chat/stream")
async def stream_chat(request: ChatRequest):
    """
    流式对话接口

    支持两种模式：
    1. 当前章节模式：传入 chapter_id，基于该章节内容回答
    2. 整本书模式：传入 book_id，通过 RAG 搜索全书相关章节后回答
    返回 SSE 流式数据
    """

    chapter_context = None
    sources = []

    if request.chapter_id:
        # 当前章节模式
        chapter = book_processor.get_chapter_by_id(request.chapter_id)
        if chapter:
            chapter_context = chapter.content
    elif request.selected_book_ids or request.book_id:
        # 多书/整本书模式：RAG 搜索
        search_ids = request.selected_book_ids or ([request.book_id] if request.book_id else None)

        if search_ids:
            search_results = await book_processor.search_chapters(
                query=request.message,
                book_ids=search_ids,
                n_results=5
            )
        else:
            search_results = []

        if search_results:
            parts = []
            for r in search_results:
                source_label = f"[{r.book_title} → {r.title}]" if r.book_title else f"[{r.title}]"
                parts.append(f"{source_label}\n{r.content_snippet}")
                sources.append({
                    "book_title": r.book_title,
                    "chapter_title": r.title,
                    "chapter_id": r.chapter_id,
                    "book_id": r.book_id
                })
            chapter_context = "\n\n---\n\n".join(parts)

    async def generate():
        async for chunk in analysis_service.stream_chat(
            message=request.message,
            chapter_context=chapter_context,
            chat_history=request.chat_history
        ):
            yield f"data: {json.dumps({'content': chunk}, ensure_ascii=False)}\n\n"

        # 多书/整本书模式：发送来源章节信息（含书名）
        if sources:
            yield f"data: {json.dumps({'sources': sources}, ensure_ascii=False)}\n\n"

        yield "data: [DONE]\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


@router.post("/chat")
async def chat(request: ChatRequest):
    """非流式对话接口（备用）"""
    chapter_context = None
    if request.chapter_id:
        chapter = book_processor.get_chapter_by_id(request.chapter_id)
        if chapter:
            chapter_context = chapter.content
    elif request.selected_book_ids or request.book_id:
        search_ids = request.selected_book_ids or ([request.book_id] if request.book_id else None)
        if search_ids:
            search_results = await book_processor.search_chapters(
                query=request.message,
                book_ids=search_ids,
                n_results=5
            )
            if search_results:
                parts = []
                for r in search_results:
                    source_label = f"[{r.book_title} → {r.title}]" if r.book_title else f"[{r.title}]"
                    parts.append(f"{source_label}\n{r.content_snippet}")
                chapter_context = "\n\n---\n\n".join(parts)

    full_response = ""
    async for chunk in analysis_service.stream_chat(
        message=request.message,
        chapter_context=chapter_context,
        chat_history=request.chat_history
    ):
        full_response += chunk

    return {"response": full_response}
