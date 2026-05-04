from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime


class Chapter(BaseModel):
    """章节模型"""
    chapter_id: str
    book_id: str
    title: str
    content: str
    word_count: int
    chapter_index: int
    start_position: Optional[int] = None
    end_position: Optional[int] = None
    created_at: datetime = datetime.now()


class TocItem(BaseModel):
    """目录项模型"""
    title: str
    level: int = 1
    pattern: Optional[str] = None  # 用于匹配的文本模式
    page_number: Optional[int] = None
    position: Optional[int] = None


class BookAnalysisResult(BaseModel):
    """书籍分析结果"""
    book_id: str
    title: str
    author: Optional[str] = None
    total_chapters: int
    total_words: int
    chapters: List[Chapter]
    toc: List[TocItem]
    file_format: str
    created_at: datetime = datetime.now()


class ChapterSearchResult(BaseModel):
    """章节搜索结果"""
    chapter_id: str
    book_id: str
    book_title: str = ""
    title: str
    content_snippet: str
    chapter_index: int
    relevance_score: float
