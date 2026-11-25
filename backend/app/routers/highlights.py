"""划线高亮路由（v2.7，v3.6 多色+笔记）：列表 / 新增 / 换色改笔记 / 删除 / 按书计数徽标

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
    color: Optional[str] = None   # v3.6 高亮色键（amber/green/blue/pink），None=默认黄
    note: Optional[str] = None    # v3.6 随高亮附带的笔记


class HighlightPatch(BaseModel):
    color: Optional[str] = None
    note: Optional[str] = None    # '' = 清空笔记


class ExportRequest(BaseModel):
    book_id: str
    dir: Optional[str] = None     # 测试/换库覆盖；默认走设置里的 Obsidian「读点书吧」目录


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
    # v3.6：非法色键直接拒绝（前端色板只会发合法键，走到这里说明是外部调用方写错了）
    if request.color is not None and request.color not in highlight_store.HL_COLORS:
        raise HTTPException(status_code=400, detail="不支持的高亮颜色")
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
        color=request.color,
        note=request.note,
    )
    if hl is None:
        raise HTTPException(status_code=400, detail="划线文本不能为空")
    return {"ok": True, "highlight": hl}


@router.post("/export")
async def export_highlights(request: ExportRequest):
    """v3.7 阅读轨迹导出：全书高亮+笔记 → Markdown 落 Obsidian「读点书吧」。写失败也回全文供下载"""
    from app.routers.book_processor import analysis_results
    from app.services import annotation_export
    book = analysis_results.get(request.book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="找不到该书")
    chapters = [(c.chapter_id, c.title) for c in (book.chapters or [])]
    return annotation_export.export_book(request.book_id, book.title, book.author, chapters, request.dir)


@router.patch("/{highlight_id}")
async def patch_highlight(highlight_id: str, request: HighlightPatch):
    """v3.6 换色 / 写·改·清笔记。两个字段都不带 → 400"""
    if request.color is None and request.note is None:
        raise HTTPException(status_code=400, detail="至少要更新颜色或笔记")
    if request.color is not None and request.color not in highlight_store.HL_COLORS:
        raise HTTPException(status_code=400, detail="不支持的高亮颜色")
    hl = highlight_store.update_highlight(highlight_id, color=request.color, note=request.note)
    if hl is None:
        raise HTTPException(status_code=404, detail="找不到该划线")
    return {"ok": True, "highlight": hl}


@router.delete("/{highlight_id}")
async def delete_highlight(highlight_id: str):
    if not highlight_store.delete_highlight(highlight_id):
        raise HTTPException(status_code=404, detail="找不到该划线")
    return {"ok": True}
