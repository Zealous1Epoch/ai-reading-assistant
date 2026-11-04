"""知识卡片持久化 + Leitner 间隔重复（v2.3）

设计要点（与 chat_store 同风格）：
- 单文件 JSON + 线程锁 + 原子写（tmp + replace），个人书库规模不引入数据库
- Leitner 五盒：复习间隔 box1..box5 = 1/2/4/7/15 天（按 next_review 日期判定到期）
  * again（忘了）→ 回 box1，明天复习
  * good（记住了）→ box+1（封顶 5），按新盒间隔排期
  * easy（很熟）  → box+2（封顶 5），跳过一格
- 抽卡去重：同书内 front 去空白精确相同 → 跳过（同一章可反复抽不产生重复卡）
- 按日期（天粒度）而非时间戳排期：个人复习场景「今天到期」语义最直观
"""
import json
import os
import threading
import uuid
from datetime import date, datetime
from typing import Optional, List, Dict, Any

from app.config import get_settings

settings = get_settings()

_lock = threading.Lock()

LEITNER_DAYS = (1, 2, 4, 7, 15)   # box 1..5 的复习间隔（天）
FRONT_CAP = 200
BACK_CAP = 600
CITE_CAP = 300


def _path() -> str:
    return os.path.join(settings.data_dir, "cards.json")


def _load() -> Dict[str, dict]:
    p = _path()
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
        except Exception as e:
            print(f"读取卡片文件失败: {e}")
    return {}


def _save(data: Dict[str, dict]):
    p = _path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, p)


def _norm_front(text: str) -> str:
    """去重键：去全部空白后精确比对（LLM 重抽同一内容时空格差异不该算新卡）"""
    return "".join((text or "").split())


def _today() -> date:
    return date.today()


def _due_str(box: int, base: Optional[date] = None) -> str:
    d = base or _today()
    from datetime import timedelta
    return (d + timedelta(days=LEITNER_DAYS[max(1, min(box, 5)) - 1])).isoformat()


def add_cards(book_id: str, items: List[Dict[str, Any]],
              chapter_id: Optional[str] = None,
              chapter_title: Optional[str] = None) -> Dict[str, Any]:
    """批量入库（工具抽卡产出）。返回 {added, skipped, cards:[入库卡]}；front/back 任一为空跳过"""
    added, skipped = [], 0
    with _lock:
        data = _load()
        existing = {_norm_front(c.get("front", "")) for c in data.values() if c.get("book_id") == book_id}
        for it in items:
            front = str(it.get("front", "")).strip()[:FRONT_CAP]
            back = str(it.get("back", "")).strip()[:BACK_CAP]
            if not front or not back:
                skipped += 1
                continue
            if _norm_front(front) in existing:
                skipped += 1
                continue
            existing.add(_norm_front(front))
            card = {
                "card_id": str(uuid.uuid4()),
                "book_id": book_id,
                "chapter_id": chapter_id,
                "chapter_title": chapter_title,
                "front": front,
                "back": back,
                "cite": str(it.get("cite", "")).strip()[:CITE_CAP],
                "box": 1,
                "next_review": _today().isoformat(),   # 新卡当天即到期：抽完当天就能复习
                "created_at": datetime.now().isoformat(timespec="seconds"),
                "last_review": None,
                "reviews": 0,
                "correct": 0,
                "wrong": 0,
            }
            data[card["card_id"]] = card
            added.append(card)
        if added:
            _save(data)
    return {"added": len(added), "skipped": skipped, "cards": added}


def list_cards(book_id: Optional[str] = None) -> List[dict]:
    with _lock:
        data = _load()
    out = [c for c in data.values() if not book_id or c.get("book_id") == book_id]
    out.sort(key=lambda c: c.get("created_at") or "", reverse=True)
    return out


def due_cards(book_id: Optional[str] = None) -> List[dict]:
    """到期队列：难卡（低盒）优先，其次到期更早"""
    today = _today().isoformat()
    out = [c for c in list_cards(book_id) if (c.get("next_review") or "") <= today]
    out.sort(key=lambda c: (c.get("box", 1), c.get("next_review") or ""))
    return out


def stats(book_id: Optional[str] = None) -> dict:
    cards = list_cards(book_id)
    today = _today().isoformat()
    due = sum(1 for c in cards if (c.get("next_review") or "") <= today)
    return {"total": len(cards), "due": due}


def stats_by_book() -> Dict[str, dict]:
    out: Dict[str, dict] = {}
    with _lock:
        data = _load()
    today = _today().isoformat()
    for c in data.values():
        b = c.get("book_id") or ""
        s = out.setdefault(b, {"total": 0, "due": 0})
        s["total"] += 1
        if (c.get("next_review") or "") <= today:
            s["due"] += 1
    return out


def grade_card(card_id: str, result: str) -> Optional[dict]:
    """按复习结果移动 Leitner 盒并重新排期；卡片不存在返回 None"""
    box = {"again": lambda b: 1,
           "good": lambda b: min(b + 1, 5),
           "easy": lambda b: min(b + 2, 5)}.get(result)
    if box is None:
        raise ValueError(f"未知复习结果: {result}")
    with _lock:
        data = _load()
        card = data.get(card_id)
        if not card:
            return None
        card["box"] = box(int(card.get("box", 1) or 1))
        card["next_review"] = _due_str(card["box"])
        card["last_review"] = datetime.now().isoformat(timespec="seconds")
        card["reviews"] = int(card.get("reviews", 0)) + 1
        if result == "again":
            card["wrong"] = int(card.get("wrong", 0)) + 1
        else:
            card["correct"] = int(card.get("correct", 0)) + 1
        _save(data)
        return card


def delete_card(card_id: str) -> bool:
    with _lock:
        data = _load()
        if card_id not in data:
            return False
        del data[card_id]
        _save(data)
    return True


def delete_cards_for_book(book_id: str) -> int:
    """删书级联清理"""
    with _lock:
        data = _load()
        doomed = [cid for cid, c in data.items() if c.get("book_id") == book_id]
        for cid in doomed:
            del data[cid]
        if doomed:
            _save(data)
    return len(doomed)


def _tag_of(book_title: str) -> str:
    # Anki 标签不允许空格：书名压成下划线连接
    import re
    t = re.sub(r"\s+", "_", (book_title or "book").strip())
    return t[:40]


def anki_tsv(book_id: Optional[str] = None, title_of=None) -> str:
    """Anki 桌面版「文本分隔导入」兼容 TSV：正面<TAB>背面<TAB>标签。
    title_of: book_id -> 书名 的映射函数（标签用书名比 UUID 友好）"""
    cards = list_cards(book_id)
    lines = []
    for c in cards:
        front = c.get("front", "").replace("\t", " ").replace("\n", "<br>")
        back = c.get("back", "").replace("\t", " ").replace("\n", "<br>")
        title = title_of(c.get("book_id")) if title_of else (c.get("book_id") or "")
        lines.append(f"{front}\t{back}\t{_tag_of(title)}")
    return "\n".join(lines) + ("\n" if lines else "")
