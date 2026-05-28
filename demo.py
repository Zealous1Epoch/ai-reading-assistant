#!/usr/bin/env python3
"""
智能读书助手 — 端到端 Demo

演示核心流水线：
  上传书籍 → 文本提取 → AI/正则目录识别 → 置信度打分切分 → ChromaDB 存储 → 语义搜索

用法:
  python demo.py                    # 使用内置样书运行完整 Demo
  python demo.py <your_book.pdf>    # 使用你自己的 PDF/EPUB/TXT 文件
"""

import sys
import os
import asyncio
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "backend"))

from app.services.book_processor import BookProcessor
from app.config import get_settings

SEP = "=" * 60
SEP2 = "-" * 40


def banner(title: str):
    print(f"\n{'=' * 60}")
    print(f"  {title}")
    print(f"{'=' * 60}")


async def demo(file_path: str):
    book_id = f"demo_{Path(file_path).stem}"
    bp = BookProcessor(persist_directory="./data/chroma_db")

    # ── Step 1: 提取文本 ──────────────────────────────────────
    banner("Step 1: 文本提取")
    full_text, metadata = bp.extract_text(file_path, book_id)
    print(f"  书名: {metadata['title']}")
    print(f"  作者: {metadata['author']}")
    print(f"  格式: {metadata['format']}")
    print(f"  页数: {metadata.get('pages', 'N/A')}")
    print(f"  总字符数: {len(full_text):,}")
    print(f"  前120字预览: {full_text.strip()[:120]}...")

    # ── Step 2: AI 识别目录 ────────────────────────────────────
    banner("Step 2: AI 目录识别 (DeepSeek)")
    settings = get_settings()
    toc_items = []
    if settings.deepseek_api_key:
        print("  正在调用 DeepSeek 分析前 5000 字符...")
        toc_items = await bp.detect_toc_by_ai(full_text[:5000])
        if toc_items:
            print(f"  AI 识别到 {len(toc_items)} 个目录项:")
            for item in toc_items:
                indent = "  " * (item.level - 1)
                print(f"    {indent}[Lv{item.level}] {item.title}")
        else:
            print("  AI 未识别到目录，将降级为正则扫描")
    else:
        print("  未配置 API Key，跳过 AI 识别，直接使用正则扫描")

    # ── Step 3: 正则降级（需要时） ──────────────────────────────
    banner("Step 3: 正则扫描 (全文)")
    if not toc_items:
        toc_items = bp._fallback_toc_detection(full_text)
        print(f"  正则扫描到 {len(toc_items)} 个候选标题:")
        for item in toc_items:
            print(f"    [{item.title}] level={item.level}")

    # ── Step 4: 置信度打分 + 章节切分 ──────────────────────────
    banner("Step 4: 章节切分 (置信度打分 + 邻近去重)")
    chapters = bp.split_by_toc(full_text, toc_items)
    print(f"  切分出 {len(chapters)} 个章节:\n")
    for ch in chapters:
        preview = ch.content[:80].replace("\n", " ").strip()
        print(f"  [{ch.chapter_index:02d}] {ch.title}")
        print(f"       字数: {ch.word_count:,}  |  位置: {ch.start_position:,}")
        print(f"       预览: {preview}...")
        print()

    # ── Step 5: 向量化存储 ─────────────────────────────────────
    banner("Step 5: ChromaDB 向量化存储")
    for ch in chapters:
        ch.book_id = book_id
    await bp.store_chapters_to_chroma(book_id, chapters, book_title=metadata.get("title", ""))
    count = bp.collection.count()
    print(f"  已存储章节数: {len(chapters)}")
    print(f"  ChromaDB 总条目: {count}")

    # ── Step 6: 语义搜索演示 ───────────────────────────────────
    banner("Step 6: 语义搜索演示")
    queries = ["图灵测试是什么", "深度学习的重要突破", "Transformer架构"]
    for q in queries:
        print(f"\n  🔍 搜索: \"{q}\"")
        results = await bp.search_chapters(q, book_ids=[book_id], n_results=2)
        for j, r in enumerate(results):
            snippet = r.content_snippet[:100].replace("\n", " ")
            print(f"    [{j+1}] {r.title} (相关度: {r.relevance_score:.3f})")
            print(f"        {snippet}...")

    # ── 完成 ────────────────────────────────────────────────────
    banner("Demo 完成")
    print(f"  书名: {metadata['title']}")
    print(f"  章节数: {len(chapters)}")
    print(f"  总字数: {sum(c.word_count for c in chapters):,}")
    print(f"  向量库: {count} 条记录")
    print()


async def main():
    if len(sys.argv) > 1:
        file_path = sys.argv[1]
    else:
        file_path = os.path.join(os.path.dirname(__file__), "demo_data", "sample_book.txt")

    if not os.path.exists(file_path):
        print(f"❌ 文件不存在: {file_path}")
        sys.exit(1)

    await demo(file_path)


if __name__ == "__main__":
    asyncio.run(main())
