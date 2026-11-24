#!/usr/bin/env python3
"""索引 ↔ ChromaDB 向量一致性对账（第一期孤章/幽灵块可见化工具）。

背景：books_index.json 与 book_chapters_v2 曾出现"索引 17 章、向量只有 16 章"
（非暴力沟通首章清洗后为空、从未建块）——此前无任何工具能发现这种漂移。

用法（⚠️ 先停后端服务：chroma sqlite 不支持多进程并发读写）：
  PYTHONPATH=backend venv/bin/python scripts/audit_vectors.py            # 只查
  PYTHONPATH=backend venv/bin/python scripts/audit_vectors.py --fix      # 对缺失书用 uploads 原文件重解析并回写索引
"""

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import chromadb  # noqa: E402
from chromadb.config import Settings as ChromaSettings  # noqa: E402


def load_index() -> dict:
    with open(ROOT / "backend" / "data" / "books_index.json", encoding="utf-8") as f:
        return json.load(f)


def chapter_stats(collection, book_id: str):
    """返回该书在向量库中的 (distinct chapter_id 集合, 块数)"""
    res = collection.get(where={"book_id": book_id}, include=["metadatas"])
    ids = {m.get("chapter_id") for m in (res.get("metadatas") or [])}
    return ids, len(res.get("ids") or [])


def strip_content(ch: dict) -> dict:
    out = dict(ch)
    out["content"] = ""
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fix", action="store_true",
                    help="对索引↔向量不一致的书，用 uploads 原文件重跑解析并回写索引")
    args = ap.parse_args()

    books = load_index()
    client = chromadb.PersistentClient(
        path=str(ROOT / "backend" / "data" / "chroma_db"),
        settings=ChromaSettings(anonymized_telemetry=False),
    )
    col = client.get_collection("book_chapters_v2")

    bad_books = []
    print(f"{'书名':　<14s}{'索引章':>5s}{'向量章':>5s}{'块数':>5s}  问题")
    print("-" * 72)
    for bid, book in books.items():
        idx_ids = {c["chapter_id"] for c in book.get("chapters", [])}
        vec_ids, n_chunks = chapter_stats(col, bid)
        missing = idx_ids - vec_ids   # 孤章：索引有、向量无
        extra = vec_ids - idx_ids     # 幽灵块：向量有、索引无
        problems = []
        if missing:
            titles = [c.get("title", "?") for c in book["chapters"] if c["chapter_id"] in missing]
            problems.append(f"孤章{len(missing)}({','.join(titles[:3])})")
        if extra:
            problems.append(f"幽灵块章{len(extra)}")
        if not missing and not extra:
            problems.append("OK" if n_chunks else "OK(0块?!)")
        print(f"{book.get('title', bid)[:12]:　<14s}{len(idx_ids):>5d}{len(vec_ids):>5d}{n_chunks:>5d}  {'; '.join(problems)}")
        if missing or extra:
            bad_books.append(bid)

    if not args.fix:
        print(f"\n共 {len(books)} 本，{len(bad_books)} 本不一致。--fix 可用 uploads 原文件重解析修复。")
        return

    if not bad_books:
        print("\n无需修复。")
        return

    # fix 模式：完整 BookProcessor（需 embedding 模型 + LLM 配置），逐本重解析
    from app.services.book_processor import BookProcessor  # noqa: E402
    from app.config import get_settings  # noqa: E402
    import asyncio  # noqa: E402

    settings = get_settings()
    upload_dir = settings.upload_dir
    proc = BookProcessor()

    async def fix_one(bid: str):
        ext = next((e for e in ("pdf", "epub", "txt")
                    if os.path.exists(os.path.join(upload_dir, f"{bid}.{e}"))), None)
        if not ext:
            print(f"[fix] {bid}: uploads 缺源文件，跳过（需人工重传）")
            return False
        path = os.path.join(upload_dir, f"{bid}.{ext}")
        result = await proc.process_book(path, bid)
        data = result.model_dump(mode="json")
        data["chapters"] = [strip_content(c) for c in data.get("chapters", [])]
        # 保留原始展示信息（process_book 不知道上传时的文件名）
        data["original_filename"] = books[bid].get("original_filename")
        data["title"] = books[bid].get("title") or data["title"]
        books[bid] = data
        print(f"[fix] {bid}（{data.get('title')}）重解析完成：{data['total_chapters']} 章")
        return True

    async def fix_all():
        return await asyncio.gather(*[fix_one(b) for b in bad_books])

    fixed = asyncio.run(fix_all())

    if any(fixed):
        out = ROOT / "backend" / "data" / "books_index.json"
        with open(out, "w", encoding="utf-8") as f:
            json.dump(books, f, ensure_ascii=False, indent=2)
        print(f"[fix] 索引已回写 {out}（修复 {sum(1 for x in fixed if x)}/{len(bad_books)} 本）")


if __name__ == "__main__":
    main()
