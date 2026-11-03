from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from app.services import chat_store

router = APIRouter(prefix="/sessions", tags=["对话历史"])


class CreateSessionRequest(BaseModel):
    book_id: Optional[str] = None
    scope: str = "book"  # book | cross


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


@router.delete("/{session_id}")
async def delete_session(session_id: str):
    if not chat_store.delete_session(session_id):
        raise HTTPException(status_code=404, detail="会话不存在")
    return {"ok": True}
