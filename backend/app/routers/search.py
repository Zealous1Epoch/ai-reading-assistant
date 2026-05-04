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
        book_id=book_id,
        n_results=n_results
    )

    return results


@router.get("/semantic", response_model=list[ChapterSearchResult])
async def semantic_search(
    query: str = Query(..., description="语义搜索查询"),
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
        n_results=n_results
    )

    return results
