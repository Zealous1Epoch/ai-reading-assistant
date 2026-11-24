"""待核对草稿存储（二期两阶段入库的中间态）。

解析产物先落 data/drafts/{book_id}.json（含章节全文 + 质检报告），
**draft 阶段完全不写 chroma、不写 books_index**——索引与向量库的
不一致（孤章/幽灵块）从机制上不可能再发生。用户核对 commit 后才落正式库。

文件即真源（不维护内存镜像），重启天然恢复；单本 ~1MB JSON 可接受。
"""

import json
import os
from datetime import datetime
from typing import List, Optional

from app.config import get_settings

settings = get_settings()
DRAFT_DIR = os.path.join(settings.data_dir, "drafts")


def _path(book_id: str) -> str:
    return os.path.join(DRAFT_DIR, f"{book_id}.json")


def save_draft(book_id: str, draft: dict) -> None:
    os.makedirs(DRAFT_DIR, exist_ok=True)
    draft.setdefault("created_at", datetime.now().isoformat())
    tmp = _path(book_id) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(draft, f, ensure_ascii=False)
    os.replace(tmp, _path(book_id))  # 原子替换，避免半截文件


def load_draft(book_id: str) -> Optional[dict]:
    p = _path(book_id)
    if not os.path.exists(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"[draft] 读取失败 {p}: {e}")
        return None


def delete_draft(book_id: str) -> None:
    try:
        os.remove(_path(book_id))
    except FileNotFoundError:
        pass


def list_drafts() -> List[dict]:
    """摘要列表（不展开章节正文），按创建时间倒序"""
    out: List[dict] = []
    if not os.path.isdir(DRAFT_DIR):
        return out
    for name in os.listdir(DRAFT_DIR):
        if not name.endswith(".json"):
            continue
        d = load_draft(name[:-5])
        if not d:
            continue
        qc = d.get("qc_report") or {}
        items = qc.get("items") or []
        out.append({
            "book_id": d.get("book_id"),
            "title": d.get("title"),
            "file_format": d.get("file_format"),
            "created_at": d.get("created_at"),
            "total_chapters": len(d.get("chapters") or []),
            "total_words": d.get("total_words", 0),
            "resegmented": bool(d.get("resegmented")),
            "blocking": any(i.get("level") == "blocking" for i in items),
            "warning_count": sum(1 for i in items if i.get("level") == "warning"),
            "info_count": sum(1 for i in items if i.get("level") == "info"),
            "auto_commit": bool(qc.get("auto_commit", False)),
        })
    out.sort(key=lambda x: x.get("created_at") or "", reverse=True)
    return out


def find_draft_by_hash(content_hash: str) -> Optional[dict]:
    """查重扩到草稿区：待核对的书被重复上传时不再双份解析"""
    if not content_hash:
        return None
    for brief in list_drafts():
        d = load_draft(brief["book_id"])
        if d and d.get("content_hash") == content_hash:
            return brief
    return None
