from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, List
import json

from app.services.analysis_service import analysis_service
from app.services.book_processor import book_processor
from app.services import chat_store
from app.services import experts as experts_svc

router = APIRouter(prefix="/analysis", tags=["AI分析"])


class QuotePayload(BaseModel):
    """v2.7 读者划线选区引用：text=摘录原文，chapter_id=出处章节（可空）"""
    text: str
    chapter_id: Optional[str] = None


class ChatRequest(BaseModel):
    """聊天请求"""
    message: str
    chapter_id: Optional[str] = None
    book_id: Optional[str] = None
    chat_history: Optional[List[dict]] = None
    session_id: Optional[str] = None  # 传入则本次问答自动持久化到该会话
    expert_id: Optional[str] = None   # 专家模式：用该方法论 playbook 替换默认人格
    quote: Optional[QuotePayload] = None  # v2.7 随提问附带的书中摘录引用


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


def _source_snippet(chunk_text: str, prefix_len: int = 0) -> str:
    """取块体首行前缀做段落锚点（剥去滑窗重叠前缀），前端据此定位并高亮段落。
    取不到（空行等）返回空串，前端自动回落到章首跳转。"""
    body = chunk_text[prefix_len + 1:] if prefix_len else chunk_text
    first_line = body.split("\n", 1)[0].strip()
    return first_line[:24]


@router.post("/chat/stream")
async def stream_chat(request: ChatRequest):
    """
    流式对话接口

    支持两种模式：
    1. 当前章节模式：传入 chapter_id，基于该章节内容回答
    2. 整本书模式：传入 book_id，通过 RAG 搜索全书相关章节后回答
    参考段落统一以 [n] 编号，回答句末用 [n] 标注引用，前端渲染为可点击角标（v2.2）
    返回 SSE 流式数据
    """

    chapter_context = None
    sources = []

    # v2.7 划线选区引用：把摘录与提问包成一条给 LLM 的消息。
    # 在路由侧拼装、不改 analysis_service.stream_chat 签名——服务函数加参数
    # 需要同步测试里全部 fake（项目记忆教训），能不碰就不碰。
    question = (request.message or "").strip()
    quote_text = (request.quote.text or "").strip() if request.quote else ""
    quote_meta = None
    effective_message = request.message
    if quote_text:
        quote_title = ""
        if request.quote.chapter_id:
            qchap = book_processor.get_chapter_by_id(request.quote.chapter_id)
            if qchap:
                quote_title = qchap.title or ""
        source_note = f"（出处：《{quote_title}》）" if quote_title else ""
        question = question or "请帮我解读这段摘录。"
        effective_message = (
            f"读者在书中划了一段{source_note}：\n「{quote_text[:2000]}」\n\n"
            f"读者的问题：\n{question}"
        )
        quote_meta = {
            "text": quote_text[:2000],
            "chapter_id": request.quote.chapter_id,
            "chapter_title": quote_title,
        }

    # 收集上下文：指定章节 + RAG 搜索结果（每段以 [n] 编号，与 sources[i].index 对应）
    context_parts = []

    if request.chapter_id:
        chapter = book_processor.get_chapter_by_id(request.chapter_id)
        if chapter:
            n = len(sources) + 1
            context_parts.append(f"[{n}] [当前章节：{chapter.title}]\n{chapter.content[:4000]}")
            sources.append({
                "index": n,
                "book_title": "",
                "chapter_title": chapter.title,
                "chapter_id": chapter.chapter_id,
                "book_id": chapter.book_id,
                "snippet": ""
            })

    if request.book_id:
        search_results = await book_processor.search_chapters(
            query=effective_message,
            book_ids=[request.book_id],
            n_results=5
        )
        for r in search_results:
            n = len(sources) + 1
            source_label = f"[{r.book_title} → {r.title}]" if r.book_title else f"[{r.title}]"
            context_parts.append(f"[{n}] {source_label}\n{r.content_snippet}")
            sources.append({
                "index": n,
                "book_title": r.book_title,
                "chapter_title": r.title,
                "chapter_id": r.chapter_id,
                "book_id": r.book_id,
                "snippet": _source_snippet(r.content_snippet, r.prefix_len)
            })

    chapter_context = "\n\n---\n\n".join(context_parts) if context_parts else None

    # 有编号段落时追加引用规则（对默认人格与专家人格都生效）
    citation_instruction = None
    if sources:
        citation_instruction = (
            "\n\n引用编号规则：\n"
            "- 上文参考段落各自带有 [n] 编号。回答中凡引用或转述某段内容，句末必须附上该段编号，如 [1] 或 [2][3]；只能使用本轮真实存在的编号，不得虚构。\n"
            "- 编号每轮重新分配，历史回答里出现过的旧编号一律不要沿用。"
        )

    # 会话持久化：用户消息先落盘（中途刷新/断流也不丢提问），回答完成后补写
    session = None
    if request.session_id:
        session = chat_store.get_session(request.session_id)
        if session:
            user_msg = {"role": "user", "content": question or request.message}
            if quote_meta:
                user_msg["quote"] = quote_meta
            chat_store.append_messages(request.session_id, [user_msg])
        else:
            request.session_id = None

    # 专家模式换轨：请求显式指定优先，其次沿会话上绑定的专家
    expert_id = request.expert_id or (session or {}).get("expert_id")
    system_override = None
    if expert_id and experts_svc.get_expert(expert_id):
        system_override = experts_svc.build_system(
            expert_id, request.book_id or (session or {}).get("book_id")
        )

    async def generate():
        full_reply = ""
        async for chunk in analysis_service.stream_chat(
            message=effective_message,
            chapter_context=chapter_context,
            chat_history=request.chat_history,
            system_prompt_override=system_override,
            citation_instruction=citation_instruction
        ):
            full_reply += chunk
            yield f"data: {json.dumps({'content': chunk}, ensure_ascii=False)}\n\n"

        # RAG 命中时发送来源章节信息（含书名）
        if sources:
            yield f"data: {json.dumps({'sources': sources}, ensure_ascii=False)}\n\n"

        if request.session_id and full_reply:
            chat_store.append_messages(request.session_id, [{
                "role": "assistant", "content": full_reply, "sources": sources or None
            }])

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
    elif request.book_id:
        search_results = await book_processor.search_chapters(
            query=request.message,
            book_ids=[request.book_id],
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
