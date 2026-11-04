"""划线高亮持久化（v2.7）

锚定设计（与卡片/chat_store 同风格：单文件 JSON + 线程锁 + 原子写）：
- 不用字符偏移锚定——前端渲染前 cleanChapterContent 会改写文本（剥页码/压缩空格），
  偏移对不上。改存 {chapter_id, start_p(段落块索引 data-p), text(选区原文)}，
  渲染时按「块索引 + 段内 indexOf(text)」逐块匹配包 <mark>；匹配不到优雅跳过
  （书重切章后 chapter_id 变化或选区跨版本，划线自然失效但不会错位标错地方）。
- start_p 仅作为加速提示与同段聚合依据，真正定位靠 text 在块内查找；
  跨段选区由前端拆成逐段片段分别入库。
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

TEXT_CAP = 2000   # 单条划线原文上限（超长选区截断，防误粘贴整章进来）


def _path() -> str:
    return os.path.join(settings.data_dir, "highlights.json")


def _load() -> Dict[str, dict]:
    p = _path()
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
        except Exception as e:
            print(f"读取划线文件失败: {e}")
    return {}


def _save(data: Dict[str, dict]):
    p = _path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, p)


def add_highlight(book_id: str, chapter_id: str, start_p: int,
                  text: str, chapter_title: Optional[str] = None) -> Optional[dict]:
    """新增划线。text 去空白后为空 → None；同书同章同段同文（去空白精确比对）→ 返回既有条目（幂等去重）"""
    text = (text or "").strip()[:TEXT_CAP]
    if not text:
        return None
    key = "".join(text.split())
    with _lock:
        data = _load()
        for h in data.values():
            if (h.get("book_id") == book_id and h.get("chapter_id") == chapter_id
                    and h.get("start_p") == start_p
                    and "".join((h.get("text") or "").split()) == key):
                return h   # 重复划线：不新增，直接回既有
        hl = {
            "highlight_id": str(uuid.uuid4()),
            "book_id": book_id,
            "chapter_id": chapter_id,
            "chapter_title": chapter_title,
            "start_p": int(start_p),
            "text": text,
            "created_at": datetime.now().isoformat(timespec="seconds"),
        }
        data[hl["highlight_id"]] = hl
        _save(data)
        return hl


def list_highlights(book_id: Optional[str] = None,
                    chapter_id: Optional[str] = None) -> List[dict]:
    with _lock:
        data = _load()
    out = [h for h in data.values()
           if (not book_id or h.get("book_id") == book_id)
           and (not chapter_id or h.get("chapter_id") == chapter_id)]
    out.sort(key=lambda h: (h.get("created_at") or "", h.get("highlight_id") or ""))
    return out


def count_by_book() -> Dict[str, int]:
    """书架徽标用：按书统计划线数"""
    with _lock:
        data = _load()
    out: Dict[str, int] = {}
    for h in data.values():
        b = h.get("book_id") or ""
        out[b] = out.get(b, 0) + 1
    return out


def delete_highlight(highlight_id: str) -> bool:
    with _lock:
        data = _load()
        if highlight_id not in data:
            return False
        del data[highlight_id]
        _save(data)
    return True


def delete_for_book(book_id: str) -> int:
    """删书级联清理"""
    with _lock:
        data = _load()
        doomed = [hid for hid, h in data.items() if h.get("book_id") == book_id]
        for hid in doomed:
            del data[hid]
        if doomed:
            _save(data)
    return len(doomed)
