"""批注导出（v3.7）：全书高亮+笔记 → Markdown「阅读轨迹」，落 Obsidian「读点书吧」文件夹

目录口径：settings_store.export_config()（运行时覆盖 > 默认 vault 路径），
接口 dir 参数最高优先（测试/换库用）。重复导出覆盖同名文件——轨迹是高亮批注
的衍生品，不是手稿，重导即最新全量。
章节结构按书当前章列表排；划线所属章若已不在书结构里（重切章漂移），归末尾「散页」。
"""
import os
import re
from datetime import datetime
from typing import List, Optional, Tuple

from app.services import highlight_store, settings_store

# 与 highlight_store.HL_COLORS 契约一致；图标+人话标签是导出文案的唯一真源
COLOR_META = [
    ("amber", "🟡", "重要"),
    ("green", "🟢", "喜欢"),
    ("blue", "🔵", "存疑"),
    ("pink", "🩷", "不认同"),
]
COLOR_ICON = {k: i for k, i, _ in COLOR_META}
COLOR_NAME = {k: n for k, _, n in COLOR_META}
COLOR_ORDER = {k: i for i, (k, _, _) in enumerate(COLOR_META)}

_BAD_FN = re.compile(r'[/\\:*?"<>|\r\n\t]')


def _color_of(h: dict) -> str:
    c = h.get("color") or "amber"
    return c if c in COLOR_ICON else "amber"


def safe_filename(title: str) -> str:
    name = _BAD_FN.sub("·", (title or "").strip()).strip(". ") or "书"
    return name[:60] + ".md"


def build_markdown(title: str, author: Optional[str],
                   chapters: List[Tuple[str, str]], highlights: List[dict]) -> str:
    """chapters=[(chapter_id, 章题)] 按书内顺序；highlights=highlight_store 全量条目"""
    now = datetime.now()
    noted = [h for h in highlights if (h.get("note") or "").strip()]

    def one_line(s: str) -> str:
        return " ".join((s or "").split())

    def render(items: List[dict]) -> List[str]:
        out: List[str] = []
        cur = None
        for h in sorted(items, key=lambda x: (COLOR_ORDER.get(_color_of(x), 9), x.get("created_at") or "")):
            c = _color_of(h)
            if c != cur:
                out.append("")
                out.append(f"**{COLOR_ICON[c]} {COLOR_NAME[c]}**")
                cur = c
            day = (h.get("created_at") or "")[:10]
            out.append(f"> {one_line(h.get('text'))}  `{day}`" if day else f"> {one_line(h.get('text'))}")
            if (h.get("note") or "").strip():
                out.append(f"> ✎ {one_line(h.get('note'))}")
        return out

    lines = [
        "---",
        f"title: 《{title}》阅读批注",
        f'book: "{title}"',
    ]
    if author and author != "未知作者":
        lines.append(f'author: "{author}"')
    lines += [
        f"exported_at: {now.strftime('%Y-%m-%d %H:%M')}",
        f"highlights: {len(highlights)}",
        f"notes: {len(noted)}",
        "tags: [读点书吧]",
        "---",
        "",
        f"# 《{title}》阅读批注",
        "",
        f"> {len(highlights)} 处高亮 · {len(noted)} 条笔记 · 导出于 {now.strftime('%Y-%m-%d')}",
        "",
        "> 图例：" + " · ".join(f"{i} {n}" for _, i, n in COLOR_META),
        "",
    ]

    by_chapter: dict = {}
    for h in highlights:
        by_chapter.setdefault(h.get("chapter_id"), []).append(h)

    done = set()
    for cid, ctitle in chapters:
        items = by_chapter.get(cid)
        if not items:
            continue
        done.add(cid)
        n = sum(1 for h in items if (h.get("note") or "").strip())
        lines += [f"## {ctitle}", "", f"{len(items)} 处" + (f" · {n} 条笔记" if n else "")]
        lines += render(items)
        lines.append("")

    orphan = [h for cid, hs in by_chapter.items() if cid not in done for h in hs]
    if orphan:
        lines += ["## 散页（原章节已重切）", ""]
        lines += render(orphan)
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def export_book(book_id: str, title: str, author: Optional[str],
                chapters: List[Tuple[str, str]], dir_override: Optional[str] = None) -> dict:
    """生成 Markdown 并写盘。返回 {ok, path, content, counts, write_error?}——写失败也回全文，前端可下载兜底"""
    highlights = highlight_store.list_highlights(book_id=book_id)
    content = build_markdown(title, author, chapters, highlights)
    d = os.path.expanduser((dir_override or "").strip()) if (dir_override or "").strip() else settings_store.export_config()["resolved"]
    path = os.path.join(d, safe_filename(title))
    counts = {"highlights": len(highlights),
              "notes": sum(1 for h in highlights if (h.get("note") or "").strip())}
    result = {"path": path, "content": content, "counts": counts, "book_title": title}
    try:
        os.makedirs(d, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, path)
        result["ok"] = True
    except Exception as e:  # noqa: BLE001 — 权限/磁盘/非法路径统一转成人话，content 仍可用
        result["ok"] = False
        result["write_error"] = str(e)[:200]
    return result
