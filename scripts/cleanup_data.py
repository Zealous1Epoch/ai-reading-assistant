"""一次性数据清理脚本：去重复书籍、清孤儿上传文件、清 ChromaDB 脏数据、回填内容指纹。

用法（在 backend/ 目录下运行）：
    ../venv/bin/python ../scripts/cleanup_data.py --dry-run   # 只报告，不动数据
    ../venv/bin/python ../scripts/cleanup_data.py             # 实际执行

安全措施：
    - 文件删除一律走 macOS 废纸篓（/usr/bin/trash），可恢复
    - books_index.json 修改前先备份
    - ChromaDB 删除的是"索引/演示中不存在的书"的章节，误删也可通过重传恢复
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "backend"))

from app.config import get_settings  # noqa: E402

settings = get_settings()
UPLOAD_DIR = settings.upload_dir
INDEX_PATH = os.path.join(settings.data_dir, "books_index.json")
CHROMA_DIR = os.path.join(settings.data_dir, "chroma_db")
ALLOWED_EXTS = ("pdf", "epub", "txt")


def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def find_book_file(book_id: str):
    for ext in ALLOWED_EXTS:
        p = os.path.join(UPLOAD_DIR, f"{book_id}.{ext}")
        if os.path.exists(p):
            return p
    return None


def trash(path: str, dry: bool):
    print(f"    🗑  {path}")
    if dry:
        return
    r = subprocess.run(["/usr/bin/trash", path], capture_output=True, text=True)
    if r.returncode != 0:
        # 废纸篓失败时不退回 rm，直接报错让人来看
        raise RuntimeError(f"移入废纸篓失败: {path}: {r.stderr}")


def fingerprint(book: dict):
    """无源文件时的重复判断指纹：书名+格式+章节数（标题可能因两次 AI 解析而略有差异）"""
    return (
        book.get("title"),
        book.get("file_format"),
        book.get("total_chapters"),
    )


def relink_orphans(index: dict, dry: bool):
    """把内容指纹匹配得上的孤儿文件重新认领为书籍源文件。

    背景：早期版本书籍文件在重启/迁移后与 book_id 断链（如 uploads/ 里
    留下 11 个 UUID 命名的 epub，但索引里的 book_id 都对不上文件名）。
    删除孤儿前必须先尝试认领，否则会误删仅存的源文件。
    """
    import shutil
    referenced = {find_book_file(bid) for bid in index} - {None}
    orphans = []
    for name in os.listdir(UPLOAD_DIR):
        p = os.path.join(UPLOAD_DIR, name)
        if os.path.isfile(p) and not name.startswith(".") and p not in referenced:
            orphans.append(p)

    # 无主书按 (title, format) 分组；孤儿按 sha256 分组
    need_file = [
        (bid, book) for bid, book in index.items()
        if find_book_file(bid) is None
    ]
    orphan_hash = {}
    for p in orphans:
        orphan_hash.setdefault(file_sha256(p), []).append(p)

    linked = 0
    for bid, book in need_file:
        ext_guess = {"PDF": "pdf", "EPUB": "epub", "TXT": "txt"}.get(book.get("file_format"))
        for h, paths in orphan_hash.items():
            # 用第一本候选书试解析成本太高，改为核对格式 + 标题（EPUB/TXT 标题内嵌于文件）
            cand = paths[0]
            if ext_guess and not cand.endswith(f".{ext_guess}"):
                continue
            title_ok = False
            if ext_guess == "epub":
                try:
                    from ebooklib import epub
                    b = epub.read_epub(cand)
                    t = b.get_metadata('DC', 'title')
                    title_ok = bool(t) and t[0][0] == book.get("title")
                except Exception:
                    continue
            elif ext_guess == "txt":
                title_ok = book.get("title") in Path(cand).stem
            if not title_ok:
                continue
            target = os.path.join(UPLOAD_DIR, f"{bid}.{ext_guess}")
            print(f"  认领: {os.path.basename(cand)[:12]}… → {bid[:8]}《{book['title']}》")
            if not dry:
                shutil.copy2(cand, target)
            linked += 1
            break
    print(f"  重新认领 {linked} 本")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只报告不修改")
    args = ap.parse_args()
    dry = args.dry_run
    print(f"模式: {'DRY-RUN（只报告）' if dry else '实际执行'}\n")

    with open(INDEX_PATH, "r", encoding="utf-8") as f:
        index = json.load(f)

    print("== 0. 孤儿文件认领（为丢源的书籍重新挂上文件）==")
    relink_orphans(index, dry)

    print(f"\n== 1. 书籍索引去重（现有 {len(index)} 本）==")
    # 分组：优先按内容指纹哈希，无文件的按章节标题指纹
    groups = {}
    for bid, book in index.items():
        fp = find_book_file(bid)
        if fp:
            key = ("hash", file_sha256(fp))
        else:
            key = ("fprint", fingerprint(book))
        groups.setdefault(key, []).append(bid)

    remove_ids = set()
    for key, bids in groups.items():
        if len(bids) <= 1:
            continue
        # 保留 created_at 最新的，其余删除
        bids.sort(key=lambda b: index[b].get("created_at", ""), reverse=True)
        keep, losers = bids[0], bids[1:]
        print(f"  重复组（保留《{index[keep]['title']}》{keep[:8]}）:")
        for l in losers:
            print(f"    删除 {l[:8]}《{index[l]['title']}》")
            remove_ids.add(l)

    # 1.5 死源低版本：文件已丢失、同名书存在但本章数更少（切分质量更差）→ 删除
    for bid, book in index.items():
        if bid in remove_ids or find_book_file(bid):
            continue
        same_title = [
            o for o, ob in index.items()
            if o != bid and o not in remove_ids
            and ob.get("title") == book.get("title")
            and ob.get("total_chapters", 0) > book.get("total_chapters", 0)
        ]
        if same_title:
            best = max(same_title, key=lambda o: index[o].get("total_chapters", 0))
            print(f"  低质重复：《{book['title']}》{bid[:8]}（{book.get('total_chapters')} 章，源文件已丢失）"
                  f" 劣于 {best[:8]}（{index[best].get('total_chapters')} 章）→ 删除")
            remove_ids.add(bid)

    if not dry:
        backup = INDEX_PATH + f".bak-{datetime.now():%Y%m%d%H%M%S}"
        shutil.copy2(INDEX_PATH, backup)
        print(f"  索引已备份 → {backup}")

    for l in remove_ids:
        index.pop(l, None)

    print(f"\n== 2. 清理未被索引引用的上传文件 ==")
    referenced = {find_book_file(bid) for bid in index} - {None}
    orphans = []
    if os.path.isdir(UPLOAD_DIR):
        for name in os.listdir(UPLOAD_DIR):
            p = os.path.join(UPLOAD_DIR, name)
            if os.path.isfile(p) and not name.startswith(".") and p not in referenced:
                orphans.append(p)
    for p in sorted(orphans):
        trash(p, dry)
    print(f"  孤儿文件 {len(orphans)} 个（被引用保留 {len(referenced)} 个）")

    print(f"\n== 3. 清理 ChromaDB 中无主章节 ==")
    import chromadb
    client = chromadb.PersistentClient(path=CHROMA_DIR)
    col = client.get_collection("book_chapters")
    data = col.get(include=["metadatas"])
    keep_ids = set(index.keys())
    stale = [i for i, m in zip(data["ids"], data["metadatas"]) if m.get("book_id") not in keep_ids]
    stale_books = sorted({m.get("book_title", "?") for i, m in zip(data["ids"], data["metadatas"]) if i in set(stale)})
    print(f"  无主章节 {len(stale)} 条，涉及书目: {stale_books}")
    if stale and not dry:
        for i in range(0, len(stale), 200):
            col.delete(ids=stale[i:i + 200])
        print("  已从 ChromaDB 删除")

    print(f"\n== 4. 为剩余书籍回填内容指纹 ==")
    filled = 0
    for bid, book in index.items():
        fp = find_book_file(bid)
        if fp and not book.get("content_hash"):
            book["content_hash"] = file_sha256(fp)
            book.setdefault("original_filename", os.path.basename(fp))
            filled += 1
    print(f"  回填 {filled} 本（此后重复上传即可被识别）")

    if not dry:
        with open(INDEX_PATH, "w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False, indent=2)
        print(f"\n✓ 清理完成，索引现存 {len(index)} 本书")
    else:
        print("\n（DRY-RUN 结束，未做任何修改）")


if __name__ == "__main__":
    main()
