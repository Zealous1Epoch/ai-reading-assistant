from fastapi import APIRouter, UploadFile, File, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse
from typing import Optional, List
import uuid
import os
import json
import asyncio
from datetime import datetime

from app.models.book_models import BookAnalysisResult, ChapterSearchResult, Chapter
from app.services.book_processor import book_processor

router = APIRouter(prefix="/books", tags=["书籍处理"])

# 存储处理状态
processing_status = {}

# 存储分析结果
analysis_results = {}

# ---------- 磁盘持久化 ----------
BOOKS_INDEX_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
    "data", "books_index.json"
)


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


@router.post("/analyze/{book_id}", response_model=dict)
async def analyze_book(book_id: str, background_tasks: BackgroundTasks):
    """分析已上传的书籍（后台处理）"""
    file_path = f"uploads/{book_id}"

    # 查找文件（支持多种格式）
    for ext in [".pdf", ".epub", ".txt"]:
        test_path = f"{file_path}{ext}"
        if os.path.exists(test_path):
            file_path = test_path
            break
    else:
        raise HTTPException(status_code=404, detail="书籍文件不存在")

    # 更新状态
    processing_status[book_id] = {"status": "processing", "progress": 0}

    # 后台任务处理
    async def process_task():
        try:
            processing_status[book_id] = {"status": "processing", "progress": 10}

            result = await book_processor.process_book(file_path, book_id)

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
    file_path = f"uploads/{book_id}"

    # 查找文件
    for ext in [".pdf", ".epub", ".txt"]:
        test_path = f"{file_path}{ext}"
        if os.path.exists(test_path):
            file_path = test_path
            break
    else:
        raise HTTPException(status_code=404, detail="书籍文件不存在")

    try:
        result = await book_processor.process_book(file_path, book_id)
        analysis_results[book_id] = result
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
    """仅上传文件，返回 book_id（不阻塞等待分析）"""
    if not file.filename:
        raise HTTPException(status_code=400, detail="文件名不能为空")

    suffix = file.filename.split(".")[-1].lower()
    if suffix not in ["pdf", "epub", "txt"]:
        raise HTTPException(status_code=400, detail="仅支持PDF、EPUB、TXT格式")

    book_id = str(uuid.uuid4())
    upload_dir = "uploads"
    os.makedirs(upload_dir, exist_ok=True)

    file_path = os.path.join(upload_dir, f"{book_id}.{suffix}")
    with open(file_path, "wb") as f:
        content = await file.read()
        f.write(content)

    return {"book_id": book_id, "filename": file.filename, "format": suffix}


@router.post("/upload-and-analyze", response_model=BookAnalysisResult)
async def upload_and_analyze(file: UploadFile = File(...)):
    """上传并立即分析书籍（同步等待，适合小文件）"""
    if not file.filename:
        raise HTTPException(status_code=400, detail="文件名不能为空")

    suffix = file.filename.split(".")[-1].lower()
    if suffix not in ["pdf", "epub", "txt"]:
        raise HTTPException(status_code=400, detail="仅支持PDF、EPUB、TXT格式")

    book_id = str(uuid.uuid4())
    upload_dir = "uploads"
    os.makedirs(upload_dir, exist_ok=True)

    file_path = os.path.join(upload_dir, f"{book_id}.{suffix}")

    with open(file_path, "wb") as f:
        content = await file.read()
        f.write(content)

    try:
        result = await book_processor.process_book(file_path, book_id)
        analysis_results[book_id] = result
        _save_books_index()
        return result
    except Exception as e:
        if os.path.exists(file_path):
            os.remove(file_path)
        raise HTTPException(status_code=500, detail=f"分析失败: {str(e)}")


@router.post("/batch-upload")
async def batch_upload(files: List[UploadFile] = File(...)):
    """批量上传并分析书籍（并行处理）"""
    if not files:
        raise HTTPException(status_code=400, detail="请选择要上传的文件")

    # 校验文件格式
    upload_dir = "uploads"
    os.makedirs(upload_dir, exist_ok=True)

    # 保存所有文件
    pending = []
    for file in files:
        if not file.filename:
            continue
        suffix = file.filename.split(".")[-1].lower()
        if suffix not in ["pdf", "epub", "txt"]:
            continue
        book_id = str(uuid.uuid4())
        file_path = os.path.join(upload_dir, f"{book_id}.{suffix}")
        content = await file.read()
        with open(file_path, "wb") as f:
            f.write(content)
        pending.append((book_id, file_path, file.filename))

    if not pending:
        raise HTTPException(status_code=400, detail="没有有效的书籍文件")

    # 并行处理所有书籍
    async def process_one(book_id: str, file_path: str, filename: str):
        try:
            result = await book_processor.process_book(file_path, book_id)
            analysis_results[book_id] = result
            return {"success": True, "result": result.model_dump(), "file": filename}
        except Exception as e:
            if os.path.exists(file_path):
                os.remove(file_path)
            return {"success": False, "file": filename, "error": str(e)}

    outcomes = await asyncio.gather(*[process_one(bid, fp, fn) for bid, fp, fn in pending])

    _save_books_index()

    results = [o["result"] for o in outcomes if o["success"]]
    errors = [{"file": o["file"], "error": o["error"]} for o in outcomes if not o["success"]]

    return {"results": results, "errors": errors}


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

    # 删除本地文件
    for ext in [".pdf", ".epub", ".txt"]:
        file_path = f"uploads/{book_id}{ext}"
        if os.path.exists(file_path):
            os.remove(file_path)

    # 清理内存
    if book_id in analysis_results:
        del analysis_results[book_id]
    if book_id in processing_status:
        del processing_status[book_id]

    _save_books_index()

    return {"message": "书籍已删除", "book_id": book_id}
