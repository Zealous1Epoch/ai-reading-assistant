"""知识卡片路由（v2.3）：列表 / 到期队列 / 统计徽标 / Leitner 复习打分 / 删除 / Anki 导出

抽卡入口在 AI 工具 `cards`（routers/tools.py，产出即入库+artifact 进对话流）。
"""
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from app.services import card_store
from app.routers.book_processor import analysis_results as books_index

router = APIRouter(prefix="/cards", tags=["知识卡片"])

_VALID_RESULTS = ("again", "good", "easy")


class GradeRequest(BaseModel):
    result: str   # again=忘了 / good=记住了 / easy=很熟


def _book_title(book_id: Optional[str]) -> str:
    entry = books_index.get(book_id or "")
    return (getattr(entry, "title", "") or "").strip() or "未命名书"


@router.get("")
async def list_cards(book_id: Optional[str] = None):
    cards = card_store.list_cards(book_id)
    return {"cards": cards, "total": len(cards)}


@router.get("/due")
async def due_cards(book_id: Optional[str] = None):
    """到期复习队列（难卡优先）。不传 book_id = 全库"""
    cards = card_store.due_cards(book_id)
    return {"cards": cards, "total": len(cards)}


@router.get("/stats")
async def card_stats():
    """书架徽标：全库 total/due + 按书分布"""
    per_book = card_store.stats_by_book()
    return {"stats": per_book,
            "total": sum(s["total"] for s in per_book.values()),
            "due": sum(s["due"] for s in per_book.values())}


@router.post("/{card_id}/grade")
async def grade_card(card_id: str, request: GradeRequest):
    if request.result not in _VALID_RESULTS:
        raise HTTPException(status_code=400, detail=f"复习结果须为 {'/'.join(_VALID_RESULTS)}")
    card = card_store.grade_card(card_id, request.result)
    if not card:
        raise HTTPException(status_code=404, detail="找不到该卡片")
    return {"ok": True, "card": card}


@router.delete("/{card_id}")
async def delete_card(card_id: str):
    if not card_store.delete_card(card_id):
        raise HTTPException(status_code=404, detail="找不到该卡片")
    return {"ok": True}


@router.get("/export/anki")
async def export_anki(book_id: Optional[str] = None):
    """Anki 桌面版「文本分隔导入」兼容 TSV：正面/背面/标签 三列制表符分隔"""
    tsv = card_store.anki_tsv(book_id, title_of=_book_title)
    if not tsv.strip():
        raise HTTPException(status_code=404, detail="没有可导出的卡片")
    fname = f"{_book_title(book_id) if book_id else '全部卡片'}_anki.txt"
    return Response(
        content=tsv.encode("utf-8"),
        media_type="text/tab-separated-values; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(fname)}"},
    )
