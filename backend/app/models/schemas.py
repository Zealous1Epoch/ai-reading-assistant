from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime


class ChatRequest(BaseModel):
    """聊天请求"""
    message: str
    context: Optional[str] = None
    book_id: Optional[str] = None


class ChatResponse(BaseModel):
    """聊天响应"""
    response: str
    timestamp: datetime = datetime.now()


class SummarizeRequest(BaseModel):
    """总结请求"""
    text: str
    max_length: Optional[int] = 500


class SummarizeResponse(BaseModel):
    """总结响应"""
    summary: str
    original_length: int
    summary_length: int


class BookInfo(BaseModel):
    """书籍信息"""
    id: Optional[str] = None
    title: str
    author: Optional[str] = None
    pages: Optional[int] = None
    format: str
    file_path: str
    created_at: datetime = datetime.now()


class UploadResponse(BaseModel):
    """上传响应"""
    message: str
    book_id: str
    book_info: BookInfo
