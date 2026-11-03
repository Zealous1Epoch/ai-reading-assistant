"""对话会话持久化：会话与消息存储到 data/chat_sessions.json

设计要点：
- 单文件 JSON + 线程锁，规模定位是个人书库（几百会话以内），不引入数据库
- 会话按 scope 区分：book=单书对话（挂 book_id），cross=对比阅读（不挂书）
- 标题自动取首条用户消息前 24 字；更新即刷 updated_at（列表按它倒序）
- 原子写盘（tmp + replace），中途断电不会把文件写成半截
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


def _path() -> str:
    return os.path.join(settings.data_dir, "chat_sessions.json")


def _load() -> Dict[str, dict]:
    p = _path()
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
        except Exception as e:
            print(f"读取会话文件失败: {e}")
    return {}


def _save(data: Dict[str, dict]):
    p = _path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, p)


_last_ts = [""]


def _now() -> str:
    # 毫秒精度 + 进程内单调：同一毫秒连续操作也能分出先后（列表按 updated_at 排序依赖它）
    ts = datetime.now().isoformat(timespec="milliseconds")
    if ts <= _last_ts[0]:
        from datetime import timedelta
        dt = datetime.fromisoformat(_last_ts[0]) + timedelta(milliseconds=1)
        ts = dt.isoformat(timespec="milliseconds")
    _last_ts[0] = ts
    return ts


def create_session(book_id: Optional[str] = None, scope: str = "book",
                   expert_id: Optional[str] = None, title: Optional[str] = None) -> dict:
    session = {
        "session_id": str(uuid.uuid4()),
        "scope": scope if scope in ("book", "cross") else "book",
        "book_id": book_id if scope == "book" else None,
        "expert_id": expert_id,
        "title": title or "新对话",
        "messages": [],
        "created_at": _now(),
        "updated_at": _now(),
    }
    with _lock:
        data = _load()
        data[session["session_id"]] = session
        _save(data)
    return session


def list_sessions(book_id: Optional[str] = None, scope: Optional[str] = None) -> List[dict]:
    """列表（不含消息正文，带 message_count），按 updated_at 倒序"""
    with _lock:
        data = _load()
    out = []
    for s in data.values():
        if scope and s.get("scope") != scope:
            continue
        if scope == "book" and book_id and s.get("book_id") != book_id:
            continue
        out.append({
            "session_id": s["session_id"],
            "scope": s.get("scope", "book"),
            "book_id": s.get("book_id"),
            "expert_id": s.get("expert_id"),
            "title": s.get("title", "新对话"),
            "message_count": len(s.get("messages", [])),
            "created_at": s.get("created_at"),
            "updated_at": s.get("updated_at"),
        })
    out.sort(key=lambda x: x.get("updated_at") or "", reverse=True)
    return out


def get_session(session_id: str) -> Optional[dict]:
    with _lock:
        data = _load()
    return data.get(session_id)


def delete_session(session_id: str) -> bool:
    with _lock:
        data = _load()
        if session_id not in data:
            return False
        del data[session_id]
        _save(data)
    return True


def delete_sessions_for_book(book_id: str) -> int:
    """删书时级联清理该书的会话"""
    with _lock:
        data = _load()
        doomed = [sid for sid, s in data.items() if s.get("book_id") == book_id]
        for sid in doomed:
            del data[sid]
        if doomed:
            _save(data)
    return len(doomed)


def append_messages(session_id: str, messages: List[Dict[str, Any]]) -> Optional[dict]:
    """向会话追加消息（{role, content, sources?}），自动起标题并刷时间"""
    with _lock:
        data = _load()
        session = data.get(session_id)
        if not session:
            return None
        for m in messages:
            entry = {"role": m.get("role", "user"), "content": m.get("content", ""), "time": _now()}
            if m.get("sources"):
                entry["sources"] = m["sources"]
            if m.get("kind"):
                entry["kind"] = m["kind"]
            session.setdefault("messages", []).append(entry)
        if session.get("title") in (None, "新对话"):
            first_user = next((m for m in session["messages"] if m.get("role") == "user"), None)
            if first_user:
                text = " ".join((first_user.get("content") or "").split())
                session["title"] = text[:24] + ("…" if len(text) > 24 else "")
        session["updated_at"] = _now()
        _save(data)
        return session
