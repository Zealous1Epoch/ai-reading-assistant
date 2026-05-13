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


@router.get("/fulltext")
async def fulltext_search(
    keyword: str = Query(..., description="精确搜索关键词"),
    book_id: str = Query(..., description="书籍ID"),
    limit: int = Query(20, ge=1, le=50, description="返回结果数量")
):
    """全文精确关键词搜索——在所有章节中查找关键词出现的位置"""
    if not keyword.strip() or not book_id:
        raise HTTPException(status_code=400, detail="关键词和书籍ID不能为空")

    results = book_processor.collection.get(
        where={"book_id": book_id},
        include=["documents", "metadatas"]
    )

    matches = []
    if results["ids"]:
        for i, doc_id in enumerate(results["ids"]):
            content = results["documents"][i]
            metadata = results["metadatas"][i]
            idx = content.find(keyword)
            pos = 0
            while idx != -1 and len(matches) < limit:
                start = max(0, idx - 30)
                end = min(len(content), idx + len(keyword) + 80)
                snippet = ('...' if start > 0 else '') + content[start:end] + ('...' if end < len(content) else '')
                matches.append({
                    "chapter_id": doc_id,
                    "chapter_title": metadata.get("title", ""),
                    "chapter_index": metadata.get("chapter_index", 0),
                    "position": idx,
                    "snippet": snippet
                })
                pos = idx + 1
                idx = content.find(keyword, pos)
    return {"keyword": keyword, "matches": sorted(matches, key=lambda m: (m["chapter_index"], m["position"]))}


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
