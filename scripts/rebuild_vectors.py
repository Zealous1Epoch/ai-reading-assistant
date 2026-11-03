#!/usr/bin/env python3
"""把旧集合 book_chapters（整章一向量 + 英文 MiniLM）重建为
book_chapters_v2（滑窗切块 + bge-zh + cosine）。

章节正文旧库里就有，无需重跑 AI 章节切分，零 LLM 成本。

用法：
    python scripts/rebuild_vectors.py            # 重建全部藏书
    python scripts/rebuild_vectors.py <book_id>  # 只重建一本
    python scripts/rebuild_vectors.py --dry-run  # 只统计不动库
"""
import asyncio
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "backend"))

from app.config import get_settings  # noqa: E402
from app.models.book_models import Chapter  # noqa: E402
from app.services.book_processor import book_processor  # noqa: E402

settings = get_settings()
INDEX_PATH = Path(settings.data_dir) / "books_index.json"
OLD_COLLECTION = "book_chapters"


def load_old_chapters(old_col, book_id: str):
    """从旧集合取一本书的整章记录（旧记录 id 即 chapter_id，doc 即清洗后全文）"""
    res = old_col.get(where={"book_id": book_id}, include=["documents", "metadatas"])
    chapters = []
    for doc_id, doc, meta in zip(res["ids"], res["documents"], res["metadatas"]):
        chapters.append(Chapter(
            chapter_id=meta.get("chapter_id", doc_id),
            book_id=book_id,
            title=meta.get("title", ""),
            content=doc,
            word_count=meta.get("word_count", len(doc)),
            chapter_index=meta.get("chapter_index", 0),
        ))
    return sorted(chapters, key=lambda c: c.chapter_index)


async def main() -> int:
    args = [a for a in sys.argv[1:] if a != "--dry-run"]
    dry_run = "--dry-run" in sys.argv[1:]

    if not INDEX_PATH.exists():
        print(f"索引不存在: {INDEX_PATH}")
        return 1
    index = json.loads(INDEX_PATH.read_text(encoding="utf-8"))
    book_ids = args if args else list(index.keys())

    try:
        old_col = book_processor.chroma_client.get_collection(OLD_COLLECTION)
    except Exception:
        print(f"旧集合 {OLD_COLLECTION} 不存在——馆藏若为空可忽略；否则需重新上传解析")
        return 1

    total_chunks = 0
    for bid in book_ids:
        entry = index.get(bid) or {}
        title = entry.get("title", bid[:8])
        chapters = load_old_chapters(old_col, bid)
        if not chapters:
            print(f"[跳过] {title}: 旧集合中没有章节数据")
            continue

        chunk_count = sum(
            len(book_processor._split_into_chunks(ch.content)) for ch in chapters
        )
        total_chunks += chunk_count
        status = "旧记录" if not dry_run else "dry-run"
        print(f"[{status}] {title}: {len(chapters)} 章 → {chunk_count} 块")
        if not dry_run:
            await book_processor.store_chapters_to_chroma(bid, chapters, book_title=title)

    print(f"\n合计 {total_chunks} 块" + ("（dry-run，未写库）" if dry_run else "，已写入 book_chapters_v2"))
    if not dry_run:
        print(f"新集合当前条数: {book_processor.collection.count()}")
        print("验证无误后，可手动删除旧集合（保留期间可回滚）")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
