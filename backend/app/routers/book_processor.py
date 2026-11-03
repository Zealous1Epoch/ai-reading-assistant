from fastapi import APIRouter, UploadFile, File, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse
from typing import Optional, List
import hashlib
import uuid
import os
import json
import asyncio
from datetime import datetime

from app.config import get_settings
from app.models.book_models import BookAnalysisResult, ChapterSearchResult, Chapter
from app.services.book_processor import book_processor

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
    """按内容指纹查已存在的书籍，返回 {book_id, title, filename} 或 None"""
    for bid, result in analysis_results.items():
        if getattr(result, "content_hash", None) == content_hash:
            return {
                "book_id": bid,
                "title": result.title,
                "filename": getattr(result, "original_filename", None) or f"{bid}",
            }
    return None


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

    # 后台任务处理
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
                }
                return

            result = await book_processor.process_book(file_path, book_id, content_hash=content_hash)
            result.original_filename = original_filename
            _apply_display_title(result, original_filename)

            processing_status[book_id] = {"status": "completed", "progress": 100}
            analysis_results[book_id] = result
            _save_books_index()

        except Exception as e:
            processing_status[book_id] = {"status": "failed", "error": str(e)}

    background_tasks.add_task(process_task)

    return {"message": "书籍分析任务已启动", "book_id": book_id}


@router.post("/analyze-sync/{book_id}", response_model=BookAnalysisResult)
async def analyze_book_sync(book_id: str):
    """同步分析书籍（等待完成）"""
    file_path = _find_book_file(book_id)
    if not file_path:
        raise HTTPException(status_code=404, detail="书籍文件不存在")

    try:
        result = await book_processor.process_book(
            file_path, book_id, content_hash=_hash_file(file_path)
        )
        result.original_filename = _pending_meta.pop(book_id, {}).get("filename")
        _apply_display_title(result, result.original_filename)
        analysis_results[book_id] = result
        _save_books_index()
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"分析失败: {str(e)}")


@router.get("/status/{book_id}")
async def get_processing_status(book_id: str):
    """获取书籍处理状态（含OCR进度）"""
    ocr_progress = book_processor._ocr_progress.get(book_id)
    if book_id not in processing_status:
        if ocr_progress:
            return {"status": "ocr_processing", "progress": 0, "ocr_progress": ocr_progress}
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


@router.post("/upload-and-analyze", response_model=BookAnalysisResult)
async def upload_and_analyze(file: UploadFile = File(...)):
    """上传并立即分析书籍（同步等待，适合小文件）"""
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
            # 直接返回已存在书籍的分析结果（附带提示字段由响应模型省略）
            return analysis_results[dup["book_id"]]

        result = await book_processor.process_book(
            file_path, book_id, content_hash=content_hash
        )
        result.original_filename = file.filename
        _apply_display_title(result, file.filename)
        analysis_results[book_id] = result
        _save_books_index()
        return result
    except HTTPException:
        if os.path.exists(file_path):
            os.remove(file_path)
        raise
    except Exception as e:
        if os.path.exists(file_path):
            os.remove(file_path)
        raise HTTPException(status_code=500, detail=f"分析失败: {str(e)}")


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
        return {"results": [], "errors": duplicates, "duplicates": duplicates}

    # 解析阶段限并发：多本书同时打 DeepSeek + 写 Chroma 会互相拖慢
    _sem = asyncio.Semaphore(3)

    async def process_one(book_id: str, file_path: str, filename: str, content_hash: str):
        async with _sem:
            try:
                result = await book_processor.process_book(
                    file_path, book_id, content_hash=content_hash
                )
                result.original_filename = filename
                _apply_display_title(result, filename)
                analysis_results[book_id] = result
                return {"success": True, "result": result.model_dump(), "file": filename}
            except Exception as e:
                if os.path.exists(file_path):
                    os.remove(file_path)
                return {"success": False, "file": filename, "error": str(e)}

    outcomes = await asyncio.gather(
        *[process_one(bid, fp, fn, ch) for bid, fp, fn, ch in pending]
    )

    _save_books_index()

    results = [o["result"] for o in outcomes if o["success"]]
    errors = [{"file": o["file"], "error": o["error"]} for o in outcomes if not o["success"]]
    errors.extend(d for d in duplicates if d["reason"] not in ("already_exists", "duplicate_in_batch"))

    return {"results": results, "errors": errors, "duplicates": duplicates}


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

    _save_books_index()

    return {"message": "书籍已删除", "book_id": book_id}
