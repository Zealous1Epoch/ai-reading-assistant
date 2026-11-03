from fastapi import APIRouter, HTTPException, Query
from typing import Optional

from app.models.book_models import ChapterSearchResult
from app.services.book_processor import book_processor

router = APIRouter(prefix="/search", tags=["智能搜索"])


@router.get("/chapters", response_model=list[ChapterSearchResult])
async def search_chapters(
    query: str = Query(..., description="搜索关键词"),
    book_id: Optional[str] = Query(None, description="限定书籍ID"),
    n_results: int = Query(5, ge=1, le=20, description="返回结果数量")
):
    """在所有书籍章节中搜索内容

    使用向量相似度搜索，支持语义匹配
    """
    if not query.strip():
        raise HTTPException(status_code=400, detail="搜索关键词不能为空")

    results = await book_processor.search_chapters(
        query=query,
        book_ids=[book_id] if book_id else None,
        n_results=n_results
    )

    return results


@router.get("/fulltext")
async def fulltext_search(
    keyword: str = Query(..., description="精确搜索关键词"),
    book_id: str = Query(..., description="书籍ID"),
    limit: int = Query(20, ge=1, le=50, description="返回结果数量")
):
    """全文精确关键词搜索——按章聚合命中位置（滑窗重叠区自动去重）"""
    if not keyword.strip() or not book_id:
        raise HTTPException(status_code=400, detail="关键词和书籍ID不能为空")

    matches = book_processor.fulltext_search(book_id, keyword.strip(), limit)
    return {"keyword": keyword, "matches": matches}


@router.get("/semantic", response_model=list[ChapterSearchResult])
async def semantic_search(
    query: str = Query(..., description="语义搜索查询"),
    book_id: Optional[str] = Query(None, description="限定书籍ID"),
    n_results: int = Query(5, ge=1, le=20, description="返回结果数量")
):
    """语义搜索 - 理解查询意图而非关键词匹配

    示例查询：
    - "主角的冒险经历"
    - "关于爱情的描写"
    - "悬疑和推理部分"
    """
    results = await book_processor.search_chapters(
        query=query,
        book_ids=[book_id] if book_id else None,
        n_results=n_results
    )

    return results
