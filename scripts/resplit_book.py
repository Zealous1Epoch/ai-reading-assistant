#!/usr/bin/env python3
"""零 AI 成本重切分章节：用索引里已存的 TOC 重新锚定章节，并用本地
bge embedding 重建向量块。

背景：AI/正则 TOC 链路（split_by_toc）修复了目录页掩码与父子标题合并
后，存量书籍需要按新逻辑重切分。EPUB 原生目录链路（章节无
start_position）不受影响，脚本会自动跳过。

用法（项目根目录）：
    PYTHONPATH=backend venv/bin/python scripts/resplit_book.py --all [--dry-run]
    PYTHONPATH=backend venv/bin/python scripts/resplit_book.py <book_id> ... [--dry-run]
"""
import argparse
import asyncio
import glob
import json
import os
import shutil
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from app.config import get_settings  # noqa: E402
from app.services.book_processor import BookProcessor  # noqa: E402
from app.models.book_models import TocItem  # noqa: E402

settings = get_settings()
INDEX_PATH = os.path.join(settings.data_dir, "books_index.json")


def resplit_one(bp: BookProcessor, bid: str, entry: dict, dry_run: bool) -> bool:
    """返回 True 表示该本已重建（需要写回索引）"""
    title = entry.get("title", bid)
    toc_raw = entry.get("toc") or []
    if not toc_raw:
        print(f"[跳过] {title}: 索引里没有已存 TOC")
        return False

    files = glob.glob(os.path.join(settings.upload_dir, f"{bid}.*"))
    if not files:
        print(f"[跳过] {title}: 找不到原始文件 uploads/{bid}.*")
        return False

    old_chs = entry.get("chapters") or []
    if old_chs and all(c.get("start_position") is None for c in old_chs):
        print(f"[跳过] {title}: 走 EPUB 原生目录链路，章节顺序本就正确")
        return False

    toc_items = [TocItem(**t) for t in toc_raw]
    full_text, _meta = bp.extract_text(files[0], bid)
    chapters = bp.split_by_toc(full_text, toc_items)
    if not chapters:
        print(f"[失败] {title}: 新逻辑切出 0 章，保持原状")
        return False

    for c in chapters:
        c.book_id = bid

    print(f"=== {title}: {len(old_chs)} 章 -> {len(chapters)} 章 ===")
    for c in chapters:
        print(f"  {c.chapter_index:3d} {c.title}  (start={c.start_position}, wc={c.word_count})")

    if dry_run:
        return False

    # 重建向量（store 内部先删本书旧块，幂等；chapter_id 已换新）
    asyncio.run(bp.store_chapters_to_chroma(bid, chapters, book_title=title))

    entry["chapters"] = [
        {**c.model_dump(mode="json"), "content": ""} for c in chapters
    ]
    entry["total_chapters"] = len(chapters)
    entry["total_words"] = sum(c.word_count for c in chapters)
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("books", nargs="*", help="要重切的 book_id")
    ap.add_argument("--all", action="store_true", help="索引里全部书籍")
    ap.add_argument("--dry-run", action="store_true", help="只打印新章节列表，不写盘")
    args = ap.parse_args()

    with open(INDEX_PATH, encoding="utf-8") as f:
        index = json.load(f)

    targets = list(index.keys()) if args.all else args.books
    if not targets:
        ap.error("请指定 book_id 或 --all")

    bp = BookProcessor()  # 加载 ChromaDB + 本地 bge embedding

    changed = []
    for bid in targets:
        entry = index.get(bid)
        if not entry:
            print(f"[跳过] {bid}: 不在索引中")
            continue
        if resplit_one(bp, bid, entry, args.dry_run):
            changed.append(bid)

    if args.dry_run or not changed:
        print("完成：无索引改动" if not changed else "完成（dry-run）")
        return

    backup = INDEX_PATH + f".bak-{time.strftime('%Y%m%d-%H%M%S')}"
    shutil.copy2(INDEX_PATH, backup)
    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    print(f"完成：重建 {len(changed)} 本；旧索引已备份到 {backup}")


if __name__ == "__main__":
    main()
