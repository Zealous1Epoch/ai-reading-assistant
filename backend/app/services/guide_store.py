"""逐题引导会话持久化（v3.4 导读优先）

把「读书十问」「导读」从一次性输出改造成**一题一停**的引导会话：
- 出题阶段：一次性把整份题单（十问 / 预读问题）生成好存下来（题面 + 指路章），
  进度由服务端本地切片跟踪 current_index——模型绝不自行决定跳到第几题（硬门禁的地基）。
- 每题状态：reader/coach 多轮问答 turns → 出小结 summary → resolved；
  下一题只在 strict=True（读书十问）时强制要求 summary 已生成，导读 soft 模式答一句即可推进。
- 核心概述 overview 压到全部走完才由 reveal_overview 揭示，防提前剧透。
- 单文件 JSON + 线程锁 + 原子写（tmp + replace），与 card_store / chat_store 同风格。
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

KIND_STRICT = ("questions",)   # 读书十问：答完+小结+确认，三关齐才下一题
Q_CAP = 300                     # 单题题面上限
POINTER_CAP = 60                # 指路章名上限
OVERVIEW_CAP = 4000             # 核心概述上限
TURN_CAP = 4000                 # 单轮发言上限


def _path() -> str:
    return os.path.join(settings.data_dir, "guides.json")


def _load() -> Dict[str, dict]:
    p = _path()
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
        except Exception as e:
            print(f"读取引导会话文件失败: {e}")
    return {}


def _save(data: Dict[str, dict]):
    p = _path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, p)


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _blank_per_q(n: int) -> List[dict]:
    return [{"turns": [], "summary": "", "resolved": False} for _ in range(n)]


def create_guide(book_id: str, kind: str, title: str,
                 questions: List[Dict[str, Any]],
                 scope_label: str = "",
                 chapter_id: Optional[str] = None,
                 overview: str = "") -> dict:
    """题单生成后建会话。questions: [{q, pointer}]；空题面丢弃。
    strict = kind 在读书十问类，必须逐题小结确认才推进；否则（导读）软模式。"""
    clean_q = []
    for it in questions:
        q = str((it or {}).get("q", "")).strip()[:Q_CAP]
        if not q:
            continue
        clean_q.append({"q": q, "pointer": str((it or {}).get("pointer", "")).strip()[:POINTER_CAP]})
    guide = {
        "guide_id": str(uuid.uuid4()),
        "book_id": book_id,
        "kind": kind,
        "strict": kind in KIND_STRICT,
        "title": (title or "逐题引导").strip()[:80],
        "scope_label": (scope_label or "").strip()[:80],
        "chapter_id": chapter_id,
        "questions": clean_q,
        "check": [],
        "closing": "",
        "overview": (overview or "").strip()[:OVERVIEW_CAP],
        "overview_revealed": False,
        "current_index": 0,
        "per_q": _blank_per_q(len(clean_q)),
        "status": "in_progress",
        "created_at": _now(),
        "updated_at": _now(),
    }
    with _lock:
        data = _load()
        data[guide["guide_id"]] = guide
        _save(data)
    return guide


def get_guide(guide_id: str) -> Optional[dict]:
    with _lock:
        return _load().get(guide_id)


def list_guides(book_id: Optional[str] = None) -> List[dict]:
    with _lock:
        data = _load()
    out = [g for g in data.values() if not book_id or g.get("book_id") == book_id]
    out.sort(key=lambda g: g.get("updated_at") or "", reverse=True)
    return out


def _in_range(guide: dict, q_index: int) -> bool:
    return 0 <= q_index < len(guide.get("questions") or [])


def append_turn(guide_id: str, q_index: int, role: str, text: str) -> Optional[dict]:
    """追加一轮问答（role: reader|coach）。越界或会话缺失返回 None。"""
    text = str(text or "").strip()[:TURN_CAP]
    if not text:
        return get_guide(guide_id)
    with _lock:
        data = _load()
        g = data.get(guide_id)
        if not g or not _in_range(g, q_index):
            return None
        g["per_q"][q_index]["turns"].append({"role": role, "text": text})
        g["updated_at"] = _now()
        _save(data)
        return g


def set_summary(guide_id: str, q_index: int, summary: str) -> Optional[dict]:
    """写入本题小结并标记 resolved——strict 模式这是放行下一题的凭证。"""
    with _lock:
        data = _load()
        g = data.get(guide_id)
        if not g or not _in_range(g, q_index):
            return None
        g["per_q"][q_index]["summary"] = str(summary or "").strip()[:TURN_CAP]
        g["per_q"][q_index]["resolved"] = True
        g["updated_at"] = _now()
        _save(data)
        return g


def can_advance(guide: dict, q_index: int) -> bool:
    """门禁判定：strict（读书十问）必须已出小结才放行下一题；
    soft（导读）不硬卡——想过就翻篇，也可自愿作答/要小结。"""
    if not guide.get("strict"):
        return True
    q = (guide.get("per_q") or [])[q_index]
    return bool(q.get("resolved"))


def advance(guide_id: str) -> Optional[dict]:
    """确认推进到下一题；末题走完后置 status=done。不满足门禁由调用方（路由）先拦。"""
    with _lock:
        data = _load()
        g = data.get(guide_id)
        if not g:
            return None
        nxt = int(g.get("current_index", 0)) + 1
        if nxt >= len(g.get("questions") or []):
            g["status"] = "done"
            g["current_index"] = len(g.get("questions") or [])   # 停在末尾，收束页取全部小结
        else:
            g["current_index"] = nxt
        g["updated_at"] = _now()
        _save(data)
        return g


def jump_to(guide_id: str, q_index: int) -> Optional[dict]:
    """续跑/回看：跳到指定题（不越过已答区做门禁，只允许回看或停在当前题）。"""
    with _lock:
        data = _load()
        g = data.get(guide_id)
        if not g or not _in_range(g, q_index):
            return None
        if q_index > int(g.get("current_index", 0)):
            return None   # 不许借 jump 跳过门禁向前
        g["current_index"] = q_index
        g["updated_at"] = _now()
        _save(data)
        return g


def reveal_overview(guide_id: str) -> Optional[dict]:
    """全部走完才揭示核心概述；置 overview_revealed。"""
    with _lock:
        data = _load()
        g = data.get(guide_id)
        if not g:
            return None
        g["overview_revealed"] = True
        g["updated_at"] = _now()
        _save(data)
        return g


def set_checklist(guide_id: str, checklist: List[str]) -> Optional[dict]:
    """导读单专用：读后自查清单（与 overview 同属"答完才见"区，但清单不揭spoiler，前端在概述阶段一起给出）。"""
    clean = [str(c).strip()[:200] for c in (checklist or []) if str(c).strip()][:6]
    with _lock:
        data = _load()
        g = data.get(guide_id)
        if not g:
            return None
        g["check"] = clean
        g["updated_at"] = _now()
        _save(data)
        return g


def set_closing(guide_id: str, closing: str) -> Optional[dict]:
    with _lock:
        data = _load()
        g = data.get(guide_id)
        if not g:
            return None
        g["closing"] = str(closing or "").strip()[:4000]
        g["updated_at"] = _now()
        _save(data)
        return g


def delete_guide(guide_id: str) -> bool:
    with _lock:
        data = _load()
        if guide_id not in data:
            return False
        del data[guide_id]
        _save(data)
    return True


def delete_guides_for_book(book_id: str) -> int:
    """删书级联清理"""
    with _lock:
        data = _load()
        doomed = [gid for gid, g in data.items() if g.get("book_id") == book_id]
        for gid in doomed:
            del data[gid]
        if doomed:
            _save(data)
    return len(doomed)
