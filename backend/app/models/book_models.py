from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime


class Chapter(BaseModel):
    """章节模型"""
    chapter_id: str
    book_id: str
    title: str
    content: str
    word_count: int                     # 清洗前长度（split_by_toc 的过滤口径，保留兼容）
    chapter_index: int
    start_position: Optional[int] = None
    end_position: Optional[int] = None
    level: int = 1                      # 层级（EPUB 原生 TOC 透传；1=章 2=节）
    cleaned_word_count: Optional[int] = None  # 清洗后正文长度（store 时回填；质检/展示的真口径）
    created_at: datetime = Field(default_factory=datetime.now)


class QcItem(BaseModel):
    """单条质检结果"""
    rule: str                           # R1~R10
    level: str                          # info / warning / blocking
    msg: str
    chapter_ids: List[str] = []


class QcReport(BaseModel):
    """解析后质量检查报告"""
    auto_commit: bool = True            # 无 blocking 且无 warning → 可跳过人工核对
    items: List[QcItem] = []


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
    content_hash: Optional[str] = None       # 文件内容 SHA-256，用于重复上传检测
    original_filename: Optional[str] = None  # 上传时的原始文件名
    created_at: datetime = Field(default_factory=datetime.now)


class ChapterSearchResult(BaseModel):
    """章节搜索结果"""
    chapter_id: str
    book_id: str
    book_title: str = ""
    title: str
    content_snippet: str
    chapter_index: int
    relevance_score: float
    # 滑窗块锚点信息：供句内引用跳转到原文段落时定位（chunk 体首行前缀子串）
    chunk_index: int = 0
    prefix_len: int = 0
