"""划线高亮路由（v2.7）：列表 / 新增 / 删除 / 按书计数徽标

前端锚定约定见 highlight_store 模块注释：{chapter_id, start_p, text}，
渲染侧按块索引 + 段内文本匹配包 <mark>，匹配不到优雅跳过。
"""
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services import highlight_store
from app.services.book_processor import book_processor

router = APIRouter(prefix="/highlights", tags=["划线高亮"])


class HighlightRequest(BaseModel):
    book_id: str
    chapter_id: str
    start_p: int = 0
    text: str
    chapter_title: Optional[str] = None


@router.get("")
async def list_highlights(book_id: Optional[str] = None,
                          chapter_id: Optional[str] = None):
    items = highlight_store.list_highlights(book_id, chapter_id)
    return {"highlights": items, "total": len(items)}


@router.get("/count")
async def count_highlights():
    """书架徽标：按书划线数 {book_id: n}"""
    return {"counts": highlight_store.count_by_book()}


@router.post("")
async def add_highlight(request: HighlightRequest):
    text = (request.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="划线文本不能为空")
    # 验章存在：划线必须挂在真实章节上（同时顺手补全书名可省的 chapter_title）
    chapter = book_processor.get_chapter_by_id(request.chapter_id)
    if chapter is None:
        raise HTTPException(status_code=404, detail="找不到该章节")
    title = (request.chapter_title or "").strip() or (getattr(chapter, "title", "") or "")
    hl = highlight_store.add_highlight(
        book_id=request.book_id,
        chapter_id=request.chapter_id,
        start_p=request.start_p,
        text=text,
        chapter_title=title,
    )
    if hl is None:
        raise HTTPException(status_code=400, detail="划线文本不能为空")
    return {"ok": True, "highlight": hl}


@router.delete("/{highlight_id}")
async def delete_highlight(highlight_id: str):
    if not highlight_store.delete_highlight(highlight_id):
        raise HTTPException(status_code=404, detail="找不到该划线")
    return {"ok": True}
