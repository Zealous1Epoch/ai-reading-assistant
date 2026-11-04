"""本书资产区持久化（v2.4）

收藏从浏览器 localStorage 升级为后端资产：换设备不丢、删缓存不丢、删会话不影响归档。

设计要点（与 chat_store / card_store 同款）：
- 单文件 JSON + 线程锁 + 原子写（tmp + replace）
- type 三类：note=文字收藏（问答/摘录）、tool=AI 工具产出（含 html/mindmap artifact）、report=专家收束报告
- 资产是"归档"语义：会话删除不级联删资产（用户显式从资产区移除才删）
- 工具产出的 artifact 原文照存（html 全文 / mindmap JSON 字符串），资产区可重放
"""
import json
import os
import threading
import uuid
from datetime import datetime
from typing import Optional, List, Dict, Any

from app.config import get_settings

settings = get_settings()

_lock = threading.Lock()

ASSET_TYPES = ("note", "tool", "report")
OUTPUT_TYPES = ("text", "html", "mindmap", "cards", "audio")
TITLE_CAP = 200
CONTENT_CAP = 300_000   # html artifact 可能较大
SOURCE_CAP = 200


def _path() -> str:
    return os.path.join(settings.data_dir, "assets.json")


def _load() -> Dict[str, dict]:
    p = _path()
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
        except Exception as e:
            print(f"读取资产文件失败: {e}")
    return {}


def _save(data: Dict[str, dict]):
    p = _path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, p)


def add_asset(book_id: str, type: str, content: str,
              title: Optional[str] = None,
              tool_id: Optional[str] = None,
              tool_name: Optional[str] = None,
              output_type: Optional[str] = None,
              source: Optional[str] = None) -> dict:
    """收藏一条资产。type/content 非法抛 ValueError；返回入库条目"""
    if type not in ASSET_TYPES:
        raise ValueError(f"资产类型须为 {'/'.join(ASSET_TYPES)}")
    content = (content or "").strip()
    if not content:
        raise ValueError("资产内容不能为空")
    if not (book_id or "").strip():
        raise ValueError("资产必须归属某本书")
    if output_type is not None and output_type not in OUTPUT_TYPES:
        output_type = "text"
    asset = {
        "asset_id": str(uuid.uuid4()),
        "book_id": book_id.strip(),
        "type": type,
        "title": (str(title).strip() if title else None) or (tool_name or "收藏"),
        "content": content[:CONTENT_CAP],
        "tool_id": tool_id,
        "tool_name": tool_name,
        "output_type": output_type or "text",
        "source": (source or "").strip()[:SOURCE_CAP] or None,
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    with _lock:
        data = _load()
        data[asset["asset_id"]] = asset
        _save(data)
    return asset


def list_assets(book_id: Optional[str] = None, type: Optional[str] = None,
                q: Optional[str] = None) -> List[dict]:
    with _lock:
        data = _load()
    out = []
    ql = (q or "").strip().lower()
    for a in data.values():
        if book_id and a.get("book_id") != book_id:
            continue
        if type and a.get("type") != type:
            continue
        if ql and ql not in (a.get("title", "") + "\n" + a.get("content", "")).lower():
            continue
        out.append(a)
    out.sort(key=lambda a: a.get("created_at") or "", reverse=True)
    return out


def get_asset(asset_id: str) -> Optional[dict]:
    with _lock:
        return _load().get(asset_id)


def delete_asset(asset_id: str) -> bool:
    with _lock:
        data = _load()
        if asset_id not in data:
            return False
        del data[asset_id]
        _save(data)
    return True


def delete_assets_for_book(book_id: str) -> int:
    """删书级联清理"""
    with _lock:
        data = _load()
        doomed = [aid for aid, a in data.items() if a.get("book_id") == book_id]
        for aid in doomed:
            del data[aid]
        if doomed:
            _save(data)
    return len(doomed)


_TYPE_LABEL = {"note": "文字", "tool": "AI 产出", "report": "报告"}


def export_markdown(book_id: Optional[str] = None,
                    ids: Optional[List[str]] = None,
                    title_of=None) -> str:
    """导出 Markdown。ids 指定条目（顺序即导出序），否则按 book_id 全量"""
    if ids:
        with _lock:
            data = _load()
        assets = [data[i] for i in ids if i in data]
    else:
        assets = list_assets(book_id)
    if not assets:
        return ""
    book_title = title_of(assets[0].get("book_id")) if title_of else "资产区"
    lines = [f"# 《{book_title}》资产区导出",
             f"> {len(assets)} 条 · {datetime.now().strftime('%Y-%m-%d %H:%M')}", ""]
    for a in assets:
        head = _TYPE_LABEL.get(a.get("type"), a.get("type"))
        meta = [head]
        if a.get("tool_name"):
            meta.append(a["tool_name"])
        if a.get("source"):
            meta.append(a["source"])
        meta.append((a.get("created_at") or "")[:16].replace("T", " "))
        lines.append(f"## {a.get('title', '收藏')}")
        lines.append(f"> {' · '.join(meta)}")
        lines.append("")
        lines.append(a.get("content", ""))
        lines.append("")
        lines.append("---")
        lines.append("")
    return "\n".join(lines)
