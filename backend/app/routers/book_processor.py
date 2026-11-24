from fastapi import APIRouter, UploadFile, File, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse
from pydantic import BaseModel as PydanticBaseModel
from typing import Optional, List, Dict, Any
import hashlib
import uuid
import os
import json
import asyncio
from datetime import datetime

from app.config import get_settings
from app.models.book_models import BookAnalysisResult, ChapterSearchResult, Chapter
from app.services.book_processor import book_processor
from app.services import draft_store
from app.services.quality_check import EMPTY_AFTER_CLEAN

try:
    import magic
    HAS_MAGIC = True
except ImportError:
    HAS_MAGIC = False

settings = get_settings()

router = APIRouter(prefix="/books", tags=["书籍处理"])

# 绝对锚定路径（与进程启动目录解耦）
UPLOAD_DIR = settings.upload_dir
MAX_UPLOAD_BYTES = settings.max_upload_size_mb * 1024 * 1024
ALLOWED_EXTS = {"pdf", "epub", "txt"}
_CHUNK = 1024 * 1024  # 1MB

# 存储处理状态
processing_status = {}

# 存储分析结果
analysis_results = {}

# 上传时记录的原始文件名（analyze 完成后写入索引，进程重启丢失可接受）
_pending_meta = {}

# ---------- 磁盘持久化 ----------
BOOKS_INDEX_PATH = os.path.join(settings.data_dir, "books_index.json")


def _strip_content(chapter: dict) -> dict:
    """去掉章节正文，保留元信息"""
    ch = dict(chapter)
    ch["content"] = ""
    return ch


def _load_books_index() -> dict:
    """启动时从磁盘加载书籍索引"""
    if os.path.exists(BOOKS_INDEX_PATH):
        try:
            with open(BOOKS_INDEX_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"读取书籍索引失败: {e}")
    return {}


def _save_books_index():
    """将 analysis_results 写入磁盘（去掉章节正文）"""
    os.makedirs(os.path.dirname(BOOKS_INDEX_PATH), exist_ok=True)
    slim = {}
    for bid, result in analysis_results.items():
        data = result.model_dump(mode="json")
        data["chapters"] = [_strip_content(ch) for ch in data.get("chapters", [])]
        slim[bid] = data
    with open(BOOKS_INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump(slim, f, ensure_ascii=False, indent=2)


# 启动时恢复
for bid, data in _load_books_index().items():
    # 从 dict 重建 BookAnalysisResult（content 为空串，前端按需加载）
    result = BookAnalysisResult(**data)
    analysis_results[bid] = result


# ---------- 上传校验工具 ----------

def _extract_ext(filename: str) -> Optional[str]:
    """提取并校验扩展名；无扩展名/未知格式返回 None"""
    name = (filename or "").strip()
    if "." not in name or name.endswith("."):
        return None
    ext = name.rsplit(".", 1)[-1].lower()
    return ext if ext in ALLOWED_EXTS else None


async def _save_upload_stream(file: UploadFile, dest_path: str) -> str:
    """流式写盘 + 边写边算 SHA-256（大文件不占爆内存，超限即中止）"""
    h = hashlib.sha256()
    written = 0
    with open(dest_path, "wb") as f:
        while True:
            chunk = await file.read(_CHUNK)
            if not chunk:
                break
            written += len(chunk)
            if written > MAX_UPLOAD_BYTES:
                f.close()
                os.remove(dest_path)
                raise HTTPException(
                    status_code=413,
                    detail=f"文件超过 {settings.max_upload_size_mb}MB 上限"
                )
            h.update(chunk)
            f.write(chunk)
    if written == 0:
        os.remove(dest_path)
        raise HTTPException(status_code=400, detail="文件内容为空")
    return h.hexdigest()


def _verify_content(file_path: str, ext: str):
    """内容嗅探：拦截改扩展名的伪装文件。

    优先用 python-magic（Docker 镜像含 libmagic1）；本机没有 libmagic 时
    退化为零依赖的文件头魔数检查，保证任何环境都有一道底线防护。
    """
    if HAS_MAGIC:
        try:
            mime = magic.Magic(mime=True).from_file(file_path)
            ok = {
                "pdf": mime == "application/pdf",
                "epub": mime in ("application/epub+zip", "application/zip", "application/octet-stream"),
                "txt": mime.startswith("text/") or mime in (
                    "application/octet-stream", "inode/x-empty", "application/csv",
                    "application/json",
                ),
            }.get(ext, True)
            if not ok:
                os.remove(file_path)
                raise HTTPException(
                    status_code=400,
                    detail=f"文件实际内容与扩展名不符（检测为 {mime}），请检查文件是否损坏或伪装"
                )
            return
        except HTTPException:
            raise
        except Exception:
            pass  # libmagic 异常时走魔数兜底

    # 零依赖兜底：检查文件头魔数
    with open(file_path, "rb") as f:
        head = f.read(8)
    is_pdf = head.startswith(b"%PDF")
    is_zip = head[:2] == b"PK"
    if ext == "pdf" and not is_pdf:
        os.remove(file_path)
        raise HTTPException(status_code=400, detail="扩展名是 .pdf，但文件头不是 PDF 格式")
    if ext == "epub" and not is_zip:
        os.remove(file_path)
        raise HTTPException(status_code=400, detail="扩展名是 .epub，但不是有效的压缩包结构（EPUB 本质是 ZIP）")
    if ext == "txt" and (is_pdf or is_zip):
        os.remove(file_path)
        raise HTTPException(status_code=400, detail="扩展名是 .txt，但文件实际是 PDF/EPUB 伪装，请改为正确扩展名重传")


def _find_by_hash(content_hash: str) -> Optional[dict]:
    """按内容指纹查已存在的书籍（正式库 ∪ 待核对草稿），返回摘要或 None。

    查重必须覆盖 drafts：否则"上传→解析可疑落草稿→再传同一本"会双份解析。
    """
    for bid, result in analysis_results.items():
        if getattr(result, "content_hash", None) == content_hash:
            return {
                "book_id": bid,
                "title": result.title,
                "filename": getattr(result, "original_filename", None) or f"{bid}",
                "pending_review": False,
            }
    brief = draft_store.find_draft_by_hash(content_hash)
    if brief:
        return {
            "book_id": brief["book_id"],
            "title": brief.get("title") or brief["book_id"],
            "filename": brief.get("title") or brief["book_id"],
            "pending_review": True,
        }
    return None


# ---------- 两阶段入库（二期）：草稿落盘 / commit ----------

def _save_pack_as_draft(book_id: str, pack: dict, original_filename: Optional[str] = None):
    """解析产物进草稿区（不碰 chroma / 不碰正式索引）"""
    result: BookAnalysisResult = pack["result"]
    draft_store.save_draft(book_id, {
        "book_id": book_id,
        "title": result.title,
        "author": result.author,
        "file_format": result.file_format,
        "content_hash": result.content_hash,
        "original_filename": original_filename,
        "source": pack.get("source", "generic"),
        "resegmented": bool(pack.get("resegmented")),
        "chapters": [c.model_dump(mode="json") for c in result.chapters],
        "toc": [t.model_dump(mode="json") for t in result.toc],
        "total_words": result.total_words,
        "qc_report": pack["qc"].model_dump(mode="json"),
        "dropped_empty": list(pack.get("dropped_empty") or []),
    })


async def _persist_result(book_id: str, result: BookAnalysisResult,
                          dropped_empty: List[str], source: str) -> BookAnalysisResult:
    """commit 唯一原子点：写向量 → 写索引 → 删草稿。

    - 清洗后空章（R4 口径 <EMPTY_AFTER_CLEAN）在入库前从索引侧丢弃——
      孤章（索引有、向量无）从机制上不可能再出现
    - store 自带失败回滚；store 抛错则草稿原样保留，可修可重试
    - 重解析已入库书沿用原 created_at，书架排序不跳
    """
    drop_set = set(dropped_empty)
    kept = [c for c in result.chapters
            if c.chapter_id not in drop_set and (c.cleaned_word_count or 0) >= EMPTY_AFTER_CLEAN]
    if not kept:
        raise HTTPException(status_code=422, detail="所有章节清洗后为空，无法入库（疑似提取失败）")
    for i, c in enumerate(kept):
        c.chapter_index = i

    await book_processor.store_chapters_to_chroma(book_id, kept, book_title=result.title)

    result.chapters = kept
    result.total_chapters = len(kept)
    result.total_words = sum(c.word_count for c in kept)

    old = analysis_results.get(book_id)
    if old is not None:
        result.created_at = old.created_at
    analysis_results[book_id] = result
    _save_books_index()
    draft_store.delete_draft(book_id)

    rec = book_processor.reconcile_book(book_id, kept)
    if rec["missing"] or rec["extra"]:
        print(f"[commit] {book_id} 对账异常: 孤章 {len(rec['missing'])} / 幽灵块 {len(rec['extra'])}")
    print(f"[commit] {result.title} 入库完成（{len(kept)} 章，来源 {source}）")
    return result


def _hash_file(file_path: str) -> str:
    """分块计算文件 SHA-256（不整读进内存）"""
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def _apply_display_title(result: BookAnalysisResult, original_filename: Optional[str]):
    """TXT 书名取自原始文件名（文件已改名为 UUID，不能用路径 stem 当书名）"""
    if original_filename and result.file_format == "TXT":
        stem = os.path.splitext(os.path.basename(original_filename))[0]
        # 服务层无法获知原始文件名，书名暂为 UUID 或空 → 用原始文件名回填
        if stem and (not result.title or result.title == result.book_id):
            result.title = stem


def _find_book_file(book_id: str) -> Optional[str]:
    """定位已上传的书籍文件（绝对路径）"""
    for ext in ALLOWED_EXTS:
        p = os.path.join(UPLOAD_DIR, f"{book_id}.{ext}")
        if os.path.exists(p):
            return p
    return None


@router.post("/analyze/{book_id}", response_model=dict)
async def analyze_book(book_id: str, background_tasks: BackgroundTasks):
    """分析已上传的书籍（后台处理）"""
    file_path = _find_book_file(book_id)
    if not file_path:
        raise HTTPException(status_code=404, detail="书籍文件不存在")

    original_filename = _pending_meta.pop(book_id, {}).get("filename")

    # 更新状态
    processing_status[book_id] = {"status": "processing", "progress": 0}

    # 后台任务处理（二期两阶段：质检全绿自动入库，可疑落草稿等人工核对）
    async def process_task():
        try:
            processing_status[book_id] = {"status": "processing", "progress": 10}

            content_hash = _hash_file(file_path)
            dup = _find_by_hash(content_hash)
            if dup and dup["book_id"] != book_id:
                # 已有同内容的书：清理本次上传，避免重复入库
                os.remove(file_path)
                book_processor.delete_book_chapters(book_id)
                processing_status[book_id] = {
                    "status": "duplicate", "progress": 100,
                    "existing_book_id": dup["book_id"], "existing_title": dup["title"],
                    "existing_pending_review": bool(dup.get("pending_review")),
                }
                return

            pack = await book_processor.analyze_book(file_path, book_id, content_hash=content_hash)
            result = pack["result"]
            result.original_filename = original_filename
            _apply_display_title(result, original_filename)

            if pack["qc"].auto_commit:
                # 全绿直通入库（清洗后空章顺手正常化丢弃，不打扰人工）
                dropped = list(pack.get("dropped_empty") or [])
                if dropped:
                    print(f"[analyze] {book_id} 丢弃清洗后空章: {dropped}")
                await _persist_result(book_id, result, dropped, pack.get("source", "generic"))
                processing_status[book_id] = {
                    "status": "completed", "progress": 100,
                    "auto_committed": True, "dropped_empty": dropped,
                }
            else:
                _save_pack_as_draft(book_id, pack, original_filename)
                processing_status[book_id] = {
                    "status": "review_required", "progress": 100,
                    "blocking": any(i.level == "blocking" for i in pack["qc"].items),
                    "warning_count": sum(1 for i in pack["qc"].items if i.level == "warning"),
                    "resegmented": pack.get("resegmented", False),
                }

        except Exception as e:
            processing_status[book_id] = {"status": "failed", "error": str(e), "book_id": book_id}

    background_tasks.add_task(process_task)

    return {"message": "书籍分析任务已启动", "book_id": book_id}


@router.post("/analyze-sync/{book_id}", response_model=dict)
async def analyze_book_sync(book_id: str):
    """同步分析书籍（等待完成）。二期语义：全绿=直接入库并返回结果；
    可疑=落草稿返回 pending_review。"""
    file_path = _find_book_file(book_id)
    if not file_path:
        raise HTTPException(status_code=404, detail="书籍文件不存在")

    try:
        pack = await book_processor.analyze_book(
            file_path, book_id, content_hash=_hash_file(file_path)
        )
        result = pack["result"]
        result.original_filename = _pending_meta.pop(book_id, {}).get("filename")
        _apply_display_title(result, result.original_filename)
        if pack["qc"].auto_commit:
            result = await _persist_result(book_id, result, pack.get("dropped_empty") or [],
                                           pack.get("source", "generic"))
            return {"status": "committed", **result.model_dump(mode="json")}
        _save_pack_as_draft(book_id, pack, result.original_filename)
        return {"status": "review_required", "book_id": book_id,
                "blocking": any(i.level == "blocking" for i in pack["qc"].items)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"分析失败（源文件已保留）: {str(e)}")


@router.get("/status/{book_id}")
async def get_processing_status(book_id: str):
    """获取书籍处理状态（含OCR进度；内存态丢失时用草稿区兜底——重启恢复）"""
    ocr_progress = book_processor._ocr_progress.get(book_id)
    if book_id not in processing_status:
        if ocr_progress:
            return {"status": "ocr_processing", "progress": 0, "ocr_progress": ocr_progress}
        if draft_store.load_draft(book_id):
            return {"status": "review_required", "progress": 100}
        return {"status": "not_started", "progress": 0}
    result = dict(processing_status[book_id])
    if ocr_progress:
        result["ocr_progress"] = ocr_progress
    return result


@router.get("/analysis/{book_id}", response_model=BookAnalysisResult)
async def get_analysis_result(book_id: str):
    """获取书籍分析结果"""
    if book_id not in analysis_results:
        raise HTTPException(status_code=404, detail="分析结果不存在")

    return analysis_results[book_id]


@router.get("/{book_id}/chapters", response_model=list[Chapter])
async def get_book_chapters(book_id: str):
    """获取书籍的所有章节"""
    if book_id not in analysis_results:
        raise HTTPException(status_code=404, detail="书籍尚未分析")

    return analysis_results[book_id].chapters


@router.get("/chapters/{chapter_id}", response_model=Chapter)
async def get_chapter(chapter_id: str):
    """获取单个章节内容"""
    chapter = book_processor.get_chapter_by_id(chapter_id)
    if not chapter:
        raise HTTPException(status_code=404, detail="章节不存在")
    return chapter


@router.post("/upload")
async def upload_book(file: UploadFile = File(...)):
    """仅上传文件，返回 book_id（不阻塞等待分析）。

    带内容去重：如果库里已有同内容（SHA-256 相同）的书，
    不落盘新文件，直接返回 duplicate=true 和已有的 book_id。
    """
    suffix = _extract_ext(file.filename)
    if not suffix:
        raise HTTPException(status_code=400, detail="仅支持PDF、EPUB、TXT格式")

    os.makedirs(UPLOAD_DIR, exist_ok=True)

    # 先写临时文件算指纹，确认不是重复书再改名落位（避免孤儿文件）
    tmp_path = os.path.join(UPLOAD_DIR, f".uploading-{uuid.uuid4()}")
    try:
        content_hash = await _save_upload_stream(file, tmp_path)
        _verify_content(tmp_path, suffix)

        dup = _find_by_hash(content_hash)
        if dup:
            os.remove(tmp_path)
            return {
                "book_id": dup["book_id"],
                "filename": file.filename,
                "format": suffix,
                "duplicate": True,
                "existing_title": dup["title"],
                "pending_review": bool(dup.get("pending_review")),
            }

        book_id = str(uuid.uuid4())
        os.rename(tmp_path, os.path.join(UPLOAD_DIR, f"{book_id}.{suffix}"))
        _pending_meta[book_id] = {"filename": file.filename, "content_hash": content_hash}
    except HTTPException:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise
    except Exception as e:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise HTTPException(status_code=500, detail=f"上传失败: {str(e)}")

    return {"book_id": book_id, "filename": file.filename, "format": suffix, "duplicate": False}


@router.post("/upload-and-analyze", response_model=dict)
async def upload_and_analyze(file: UploadFile = File(...)):
    """上传并立即分析书籍（同步等待，适合小文件）。
    二期语义：全绿=直接入库返回结果；可疑=落草稿 pending_review。"""
    suffix = _extract_ext(file.filename)
    if not suffix:
        raise HTTPException(status_code=400, detail="仅支持PDF、EPUB、TXT格式")

    book_id = str(uuid.uuid4())
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    file_path = os.path.join(UPLOAD_DIR, f"{book_id}.{suffix}")

    try:
        content_hash = await _save_upload_stream(file, file_path)
        _verify_content(file_path, suffix)

        dup = _find_by_hash(content_hash)
        if dup and dup["book_id"] != book_id:
            os.remove(file_path)
            if dup.get("pending_review"):
                return {"status": "review_required", "book_id": dup["book_id"],
                        "existing_title": dup["title"], "duplicate": True}
            # 直接返回已存在书籍的分析结果
            return {"status": "committed",
                    **analysis_results[dup["book_id"]].model_dump(mode="json")}

        pack = await book_processor.analyze_book(
            file_path, book_id, content_hash=content_hash
        )
        result = pack["result"]
        result.original_filename = file.filename
        _apply_display_title(result, file.filename)
        if pack["qc"].auto_commit:
            result = await _persist_result(book_id, result, pack.get("dropped_empty") or [],
                                           pack.get("source", "generic"))
            return {"status": "committed", **result.model_dump(mode="json")}
        _save_pack_as_draft(book_id, pack, file.filename)
        return {"status": "review_required", "book_id": book_id}
    except HTTPException:
        if os.path.exists(file_path):
            os.remove(file_path)
        raise
    except Exception as e:
        # 分析失败保留源文件（uploads/{book_id}.{ext}）：修好解析逻辑后可直接
        # POST /books/analyze/{book_id} 重切，不必让用户重新上传。
        # 旧行为是 os.remove 删源文件，等于自断重试后路。
        raise HTTPException(
            status_code=500,
            detail=f"分析失败（源文件已保留，可调用 /books/analyze/{book_id} 重试）: {str(e)}",
        )


@router.post("/batch-upload")
async def batch_upload(files: List[UploadFile] = File(...)):
    """批量上传并分析书籍（带内容去重；解析阶段并行）"""
    if not files:
        raise HTTPException(status_code=400, detail="请选择要上传的文件")

    os.makedirs(UPLOAD_DIR, exist_ok=True)

    # Phase 1: 逐个流式落盘 + 指纹去重（批内互斥，同一批传两个相同文件也能识别）
    pending = []       # (book_id, file_path, filename, content_hash)
    batch_hashes = set()
    duplicates = []    # 被跳过的重复文件说明
    for file in files:
        suffix = _extract_ext(file.filename)
        if not suffix:
            duplicates.append({"file": file.filename, "reason": "不支持的格式"})
            continue
        tmp_path = os.path.join(UPLOAD_DIR, f".uploading-{uuid.uuid4()}")
        try:
            content_hash = await _save_upload_stream(file, tmp_path)
            _verify_content(tmp_path, suffix)
        except HTTPException as e:
            duplicates.append({"file": file.filename, "reason": str(e.detail)})
            continue

        dup = _find_by_hash(content_hash)
        if dup:
            os.remove(tmp_path)
            duplicates.append({
                "file": file.filename,
                "reason": "already_exists",
                "existing_book_id": dup["book_id"],
                "existing_title": dup["title"],
            })
            continue
        if content_hash in batch_hashes:
            os.remove(tmp_path)
            duplicates.append({"file": file.filename, "reason": "duplicate_in_batch"})
            continue

        batch_hashes.add(content_hash)
        book_id = str(uuid.uuid4())
        file_path = os.path.join(UPLOAD_DIR, f"{book_id}.{suffix}")
        os.rename(tmp_path, file_path)
        _pending_meta[book_id] = {"filename": file.filename}
        pending.append((book_id, file_path, file.filename, content_hash))

    if not pending:
        return {"results": [], "pending_review": [], "errors": duplicates, "duplicates": duplicates}

    # 解析阶段限并发：多本书同时打 DeepSeek + 写 Chroma 会互相拖慢
    _sem = asyncio.Semaphore(3)

    async def process_one(book_id: str, file_path: str, filename: str, content_hash: str):
        async with _sem:
            try:
                pack = await book_processor.analyze_book(
                    file_path, book_id, content_hash=content_hash
                )
                result = pack["result"]
                result.original_filename = filename
                _apply_display_title(result, filename)
                if pack["qc"].auto_commit:
                    result = await _persist_result(book_id, result,
                                                   pack.get("dropped_empty") or [],
                                                   pack.get("source", "generic"))
                    return {"success": True, "status": "committed", "file": filename,
                            "book_id": book_id, "title": result.title,
                            "total_chapters": result.total_chapters}
                # 可疑书不阻塞批次（D7）：落草稿，书架徽标汇总后逐本核对
                _save_pack_as_draft(book_id, pack, filename)
                return {"success": True, "status": "review_required", "file": filename,
                        "book_id": book_id, "title": result.title}
            except Exception as e:
                # 失败保留源文件：可单独 POST /books/analyze/{book_id} 重试，
                # 不再让用户重传（旧行为直接删文件，重切链路就此断头）
                return {"success": False, "file": filename, "book_id": book_id,
                        "error": str(e), "retry_path": f"/books/analyze/{book_id}"}

    outcomes = await asyncio.gather(
        *[process_one(bid, fp, fn, ch) for bid, fp, fn, ch in pending]
    )

    _save_books_index()

    committed = [{"book_id": o["book_id"], "title": o.get("title"),
                  "total_chapters": o.get("total_chapters"), "file": o["file"]}
                 for o in outcomes if o["success"] and o.get("status") == "committed"]
    reviews = [{"book_id": o["book_id"], "title": o.get("title"), "file": o["file"]}
               for o in outcomes if o["success"] and o.get("status") == "review_required"]
    errors = [{"file": o["file"], "book_id": o.get("book_id"), "error": o["error"]}
              for o in outcomes if not o["success"]]
    errors.extend(d for d in duplicates if d["reason"] not in ("already_exists", "duplicate_in_batch"))

    return {"results": committed, "pending_review": reviews,
            "errors": errors, "duplicates": duplicates}


# ---------- 待核对草稿（二期：人工核对关） ----------

class CommitBody(PydanticBaseModel):
    delete_chapter_ids: List[str] = []
    renames: Dict[str, str] = {}
    force: bool = False


@router.get("/reviews")
async def list_reviews():
    """待核对草稿列表（书架徽标数据源）"""
    return {"reviews": draft_store.list_drafts()}


@router.get("/reviews/{book_id}")
async def get_review(book_id: str):
    """草稿详情：章节行（含 QC 标色与正文头）+ 质检报告 + 将被丢弃的空章"""
    draft = draft_store.load_draft(book_id)
    if not draft:
        raise HTTPException(status_code=404, detail="草稿不存在或已处理")

    qc = draft.get("qc_report") or {}
    marks: Dict[str, List[dict]] = {}
    for it in qc.get("items", []):
        for cid in it.get("chapter_ids", []):
            marks.setdefault(cid, []).append(it)

    chapters = [{
        "chapter_id": c.get("chapter_id"),
        "title": c.get("title"),
        "word_count": c.get("word_count"),
        "cleaned_word_count": c.get("cleaned_word_count"),
        "level": c.get("level", 1),
        "chapter_index": c.get("chapter_index"),
        "content_head": (c.get("content") or "")[:300],
        "marks": marks.get(c.get("chapter_id"), []),
    } for c in draft.get("chapters", [])]

    dropped_ids = set(draft.get("dropped_empty") or [])
    dropped = [{"chapter_id": c.get("chapter_id"), "title": c.get("title")}
               for c in draft.get("chapters", []) if c.get("chapter_id") in dropped_ids]

    return {
        "book_id": book_id,
        "title": draft.get("title"),
        "file_format": draft.get("file_format"),
        "source": draft.get("source"),
        "resegmented": draft.get("resegmented", False),
        "created_at": draft.get("created_at"),
        "blocking": any(i.get("level") == "blocking" for i in qc.get("items", [])),
        "qc_report": qc,
        "chapters": chapters,
        "dropped": dropped,
    }


@router.post("/reviews/{book_id}/commit")
async def commit_review(book_id: str, body: CommitBody):
    """核对通过 → 正式入库（写向量 + 写索引 + 删草稿）。幂等：重复 commit 返回 409"""
    draft = draft_store.load_draft(book_id)
    if not draft:
        raise HTTPException(status_code=409, detail="草稿不存在或已处理（重复提交？）")

    qc = draft.get("qc_report") or {}
    blocking = [i for i in qc.get("items", []) if i.get("level") == "blocking"]
    if blocking and not body.force:
        raise HTTPException(status_code=409, detail=f"存在阻断性问题: {blocking[0].get('msg')}（确认可入库需 force=true）")

    try:
        chapters = [Chapter(**c) for c in draft.get("chapters", [])]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"草稿数据损坏: {e}")

    delete_set = set(body.delete_chapter_ids)
    chapters = [c for c in chapters if c.chapter_id not in delete_set]
    for c in chapters:
        if c.chapter_id in body.renames and body.renames[c.chapter_id].strip():
            c.title = body.renames[c.chapter_id].strip()[:200]
        c.book_id = book_id

    # R4 口径：清洗后空章入库前从索引侧正常化丢弃（孤章机制性消灭）
    dropped = list(draft.get("dropped_empty") or [])

    result = BookAnalysisResult(
        book_id=book_id,
        title=draft.get("title") or book_id,
        author=draft.get("author"),
        total_chapters=len(chapters),
        total_words=sum(c.word_count for c in chapters),
        chapters=chapters,
        toc=draft.get("toc", []),
        file_format=draft.get("file_format") or "Unknown",
        content_hash=draft.get("content_hash"),
        original_filename=draft.get("original_filename"),
    )
    result = await _persist_result(book_id, result, dropped, draft.get("source", "generic"))
    processing_status[book_id] = {"status": "completed", "progress": 100, "auto_committed": False}
    return {"status": "committed", "book_id": book_id,
            "title": result.title, "total_chapters": result.total_chapters,
            "dropped_empty": dropped}


@router.post("/reviews/{book_id}/discard")
async def discard_review(book_id: str):
    """放弃这本：删草稿 + 删源文件 + 清向量残留（对齐 DELETE /books 的清理口径）"""
    draft = draft_store.load_draft(book_id)
    if not draft:
        raise HTTPException(status_code=404, detail="草稿不存在或已处理")
    draft_store.delete_draft(book_id)
    file_path = _find_book_file(book_id)
    if file_path:
        os.remove(file_path)
    try:
        book_processor.delete_book_chapters(book_id)
    except Exception as e:
        print(f"[discard] 向量残留清理失败 {book_id}: {e}")
    processing_status.pop(book_id, None)
    return {"status": "discarded", "book_id": book_id}


@router.post("/reviews/{book_id}/resegment")
async def resegment_review(book_id: str):
    """人工兜底重切：用 uploads 原文件整体重跑解析（含自动 AI 重切判定）"""
    draft = draft_store.load_draft(book_id)
    if not draft:
        raise HTTPException(status_code=404, detail="草稿不存在或已处理")
    file_path = _find_book_file(book_id)
    if not file_path:
        raise HTTPException(status_code=409, detail="源文件缺失，请重新上传该书")

    pack = await book_processor.analyze_book(
        file_path, book_id, content_hash=draft.get("content_hash") or _hash_file(file_path)
    )
    result = pack["result"]
    result.original_filename = draft.get("original_filename")
    _apply_display_title(result, result.original_filename)
    if pack["qc"].auto_commit:
        result = await _persist_result(book_id, result, pack.get("dropped_empty") or [],
                                       pack.get("source", "generic"))
        processing_status[book_id] = {"status": "completed", "progress": 100}
        return {"status": "committed", "book_id": book_id,
                "title": result.title, "total_chapters": result.total_chapters}
    _save_pack_as_draft(book_id, pack, draft.get("original_filename"))
    qc: dict = pack["qc"].model_dump(mode="json")
    return {"status": "review_required", "book_id": book_id,
            "resegmented": pack.get("resegmented", False),
            "total_chapters": result.total_chapters,
            "blocking": any(i.level == "blocking" for i in pack["qc"].items)}


@router.get("/list")
async def list_books():
    """获取所有书籍列表"""
    # 按创建时间倒序
    books = list(analysis_results.values())
    books.sort(key=lambda b: b.created_at, reverse=True)
    return {"books": books}


@router.delete("/{book_id}")
async def delete_book(book_id: str):
    """删除书籍及其章节"""
    # 删除ChromaDB中的章节
    book_processor.delete_book_chapters(book_id)

    # 删除本地文件（绝对路径定位）
    file_path = _find_book_file(book_id)
    if file_path:
        os.remove(file_path)

    # 清理内存
    analysis_results.pop(book_id, None)
    processing_status.pop(book_id, None)
    _pending_meta.pop(book_id, None)

    # 级联清理该书的对话会话
    from app.services import chat_store
    chat_store.delete_sessions_for_book(book_id)

    # 级联清理该书的知识卡片（v2.3）
    from app.services import card_store
    card_store.delete_cards_for_book(book_id)

    # 级联清理该书的资产区（v2.4）
    from app.services import asset_store
    asset_store.delete_assets_for_book(book_id)

    # 级联清理该书的划线高亮（v2.7）
    from app.services import highlight_store
    highlight_store.delete_for_book(book_id)

    # 级联清理该书的逐题引导会话（v3.4）
    from app.services import guide_store
    guide_store.delete_guides_for_book(book_id)

    _save_books_index()

    return {"message": "书籍已删除", "book_id": book_id}
