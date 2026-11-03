from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Any, Dict, List, Optional

from app.services import chat_store

router = APIRouter(prefix="/sessions", tags=["对话历史"])


class CreateSessionRequest(BaseModel):
    book_id: Optional[str] = None
    scope: str = "book"  # cross 为对比阅读遗留值（前端入口已移除，仅兼容存量数据）


class AppendMessageRequest(BaseModel):
    """v2.0「工具产出即消息」：AI 工具完成后把结果落进当前会话"""
    role: str = "assistant"
    content: str = ""
    kind: Optional[str] = None  # opening / report / tool
    tool_id: Optional[str] = None
    tool_name: Optional[str] = None
    output_type: Optional[str] = None  # text / html / mindmap
    filename: Optional[str] = None
    scope: Optional[str] = None  # 作用范围文案（整本书 / 章节名 / 用户输入），收藏时用
    sources: Optional[List[Dict[str, Any]]] = None


@router.get("")
async def list_sessions(book_id: Optional[str] = None, scope: Optional[str] = None):
    return {"sessions": chat_store.list_sessions(book_id=book_id, scope=scope)}


@router.post("")
async def create_session(request: CreateSessionRequest):
    return chat_store.create_session(book_id=request.book_id, scope=request.scope)


@router.get("/{session_id}")
async def get_session(session_id: str):
    session = chat_store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")
    return session


@router.post("/{session_id}/messages")
async def append_message(session_id: str, request: AppendMessageRequest):
    """向已有会话追加一条消息（工具产出落盘用）"""
    if request.role not in ("user", "assistant"):
        raise HTTPException(status_code=400, detail="role 只能是 user 或 assistant")
    if request.kind and request.kind not in ("opening", "report", "tool"):
        raise HTTPException(status_code=400, detail="未知的 kind")
    if not request.content.strip():
        raise HTTPException(status_code=400, detail="content 不能为空")
    payload = request.model_dump() if hasattr(request, "model_dump") else request.dict()
    session = chat_store.append_messages(session_id, [payload])
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")
    return {"ok": True, "message_count": len(session.get("messages", []))}


@router.delete("/{session_id}")
async def delete_session(session_id: str):
    if not chat_store.delete_session(session_id):
        raise HTTPException(status_code=404, detail="会话不存在")
    return {"ok": True}
