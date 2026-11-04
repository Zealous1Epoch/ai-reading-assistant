"""本书资产区路由（v2.4）：收藏后端化——列表 / 收藏 / 移除 / Markdown 导出

资产三类：note=文字收藏、tool=AI 工具产出、report=专家收束报告。
前端 localStorage 旧收藏由 App.jsx 在进书时一次性 POST 迁移后清除。
"""
from typing import Optional, List
from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from app.services import asset_store
from app.routers.book_processor import analysis_results as books_index

router = APIRouter(prefix="/assets", tags=["资产区"])


class AssetRequest(BaseModel):
    book_id: str
    type: str                       # note | tool | report
    content: str
    title: Optional[str] = None
    tool_id: Optional[str] = None
    tool_name: Optional[str] = None
    output_type: Optional[str] = None   # text | html | mindmap | cards
    source: Optional[str] = None


def _book_title(book_id: Optional[str]) -> str:
    entry = books_index.get(book_id or "")
    return (getattr(entry, "title", "") or "").strip() or "未命名书"


@router.get("")
async def list_assets(book_id: Optional[str] = None, type: Optional[str] = None,
                      q: Optional[str] = None):
    assets = asset_store.list_assets(book_id, type, q)
    return {"assets": assets, "total": len(assets)}


@router.post("")
async def add_asset(request: AssetRequest):
    try:
        asset = asset_store.add_asset(
            book_id=request.book_id, type=request.type, content=request.content,
            title=request.title, tool_id=request.tool_id, tool_name=request.tool_name,
            output_type=request.output_type, source=request.source)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "asset": asset}


@router.delete("/{asset_id}")
async def delete_asset(asset_id: str):
    if not asset_store.delete_asset(asset_id):
        raise HTTPException(status_code=404, detail="找不到该资产")
    return {"ok": True}


@router.get("/export")
async def export_assets(book_id: Optional[str] = None, ids: Optional[str] = None):
    """导出 Markdown（ids=逗号分隔指定条目；否则按书全量）。空库 404"""
    id_list: Optional[List[str]] = [s for s in (ids or "").split(",") if s.strip()] or None
    md = asset_store.export_markdown(book_id, id_list, title_of=_book_title)
    if not md.strip():
        raise HTTPException(status_code=404, detail="没有可导出的资产")
    scope = _book_title(book_id) if book_id else "全部资产"
    fname = f"{scope}_资产区.md"
    return Response(
        content=md.encode("utf-8"),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(fname)}"},
    )
