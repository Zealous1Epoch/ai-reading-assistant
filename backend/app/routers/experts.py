"""专家模式端点

- GET  /experts                      专家包展示元数据（花名/职业/方法论/标签/试试这样问）
- POST /experts/{id}/opening         起手式：按当前范围生成第一回合，建会话并落盘
- POST /experts/{id}/report          收束报告：基于会话全程流式生成认知诊断，完成后落盘（kind=report）

方法论在每轮对话中的生效（system 换轨 + RAG 注入）见 /analysis/chat/stream 的 expert_id 参数。
"""
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel
from typing import Optional
import json

from app.services import chat_store
from app.services.book_processor import book_processor
from app.services.analysis_service import analysis_service
from app.services.experts import (
    get_expert, list_experts, book_title_of,
    build_opening_system, build_report_system,
)

router = APIRouter(prefix="/experts", tags=["专家模式"])


class OpeningRequest(BaseModel):
    book_id: str
    chapter_id: Optional[str] = None


class ReportRequest(BaseModel):
    session_id: str


def _scope_context(request: OpeningRequest):
    """起手式的阅读范围：选中章→整章；否则全书（逐章预算覆盖）"""
    chapters = book_processor.get_full_chapters(request.book_id)
    if not chapters:
        raise HTTPException(status_code=404, detail="找不到书籍或章节内容")
    if request.chapter_id:
        for ch in chapters:
            if ch.chapter_id == request.chapter_id:
                return [ch], ch.title
    return chapters, "整本书"


@router.get("")
async def read_experts():
    return {"experts": list_experts()}


@router.post("/{expert_id}/opening")
async def expert_opening(expert_id: str, request: OpeningRequest):
    """进入专家模式：AI 依据当前阅读范围主动发第一回合（会话同建同落盘）"""
    expert = get_expert(expert_id)
    if not expert:
        raise HTTPException(status_code=404, detail=f"未知专家: {expert_id}")

    scope_chapters, scope_desc = _scope_context(request)
    # 单章全文直给；全书复用统一上下文构建器
    if len(scope_chapters) == 1:
        context = f"[{scope_chapters[0].title}]\n{scope_chapters[0].content[:6000]}"
    else:
        from app.routers.tools import _context
        context = _context(scope_chapters)

    system = build_opening_system(expert_id, request.book_id)
    response = await analysis_service.llm.ainvoke([
        SystemMessage(content=system),
        HumanMessage(content=f"[阅读范围：{scope_desc}]\n{context}"),
    ])
    content = (response.content or "").strip()
    if not content:
        raise HTTPException(status_code=502, detail="起手式生成失败，请重试")

    title = f"{expert['name']} · {scope_desc}"
    session = chat_store.create_session(
        book_id=request.book_id, scope="book", expert_id=expert_id, title=title[:30]
    )
    chat_store.append_messages(session["session_id"], [{
        "role": "assistant", "content": content, "kind": "opening"
    }])

    return {
        "session_id": session["session_id"],
        "expert_id": expert_id,
        "title": session["title"],
        "content": content,
        "quick_prompts": expert.get("quickPrompts", []),
    }


@router.post("/{expert_id}/report")
async def expert_report(expert_id: str, request: ReportRequest):
    """收束报告：读取会话全程，流式生成该专家方法论对应的认知诊断"""
    expert = get_expert(expert_id)
    if not expert:
        raise HTTPException(status_code=404, detail=f"未知专家: {expert_id}")

    session = chat_store.get_session(request.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")
    if session.get("expert_id") != expert_id:
        raise HTTPException(status_code=400, detail="会话与专家不匹配")
    if not any(m.get("role") == "user" for m in session.get("messages", [])):
        raise HTTPException(status_code=400, detail="还没有你的回答，先对话几轮再收束")

    transcript = "\n\n".join(
        f"{'读者' if m.get('role') == 'user' else '专家'}：{(m.get('content') or '')[:800]}"
        for m in session["messages"]
    )[:20000]
    system = build_report_system(expert_id, session.get("book_id"))

    async def generate():
        full = ""
        async for chunk in analysis_service.streaming_llm.astream([
            SystemMessage(content=system),
            HumanMessage(content=f"【对话全程记录】\n{transcript}"),
        ]):
            if chunk.content:
                full += chunk.content
                yield f"data: {json.dumps({'content': chunk.content}, ensure_ascii=False)}\n\n"
        if full.strip():
            chat_store.append_messages(request.session_id, [{
                "role": "assistant", "content": full.strip(), "kind": "report"
            }])
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )
