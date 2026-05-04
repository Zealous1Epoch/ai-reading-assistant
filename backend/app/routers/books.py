from fastapi import APIRouter, UploadFile, File, HTTPException
from app.models.schemas import UploadResponse, BookInfo
from app.services.document_service import document_service
import uuid
import os

router = APIRouter(prefix="/books", tags=["书籍管理"])

# 临时存储（后续可替换为数据库）
books_storage = {}


@router.post("/upload", response_model=UploadResponse)
async def upload_book(file: UploadFile = File(...)):
    """上传书籍"""
    # 检查文件格式
    if not file.filename:
        raise HTTPException(status_code=400, detail="文件名不能为空")

    suffix = file.filename.split(".")[-1].lower()
    if suffix not in ["pdf", "txt", "epub"]:
        raise HTTPException(status_code=400, detail="仅支持PDF、TXT、EPUB格式")

    # 保存文件
    book_id = str(uuid.uuid4())
    upload_dir = "uploads"
    os.makedirs(upload_dir, exist_ok=True)

    file_path = os.path.join(upload_dir, f"{book_id}.{suffix}")

    with open(file_path, "wb") as f:
        content = await file.read()
        f.write(content)

    # 提取元数据
    try:
        if suffix == "pdf":
            metadata = document_service.get_pdf_metadata(file_path)
        else:
            metadata = {
                "title": file.filename,
                "author": None,
                "pages": None,
                "format": suffix.upper()
            }

        book_info = BookInfo(
            id=book_id,
            title=metadata.get("title") or file.filename,
            author=metadata.get("author"),
            pages=metadata.get("pages"),
            format=metadata.get("format"),
            file_path=file_path
        )

        books_storage[book_id] = book_info

        return UploadResponse(
            message="上传成功",
            book_id=book_id,
            book_info=book_info
        )

    except Exception as e:
        # 清理文件
        if os.path.exists(file_path):
            os.remove(file_path)
        raise HTTPException(status_code=500, detail=f"处理文件失败: {str(e)}")


@router.get("/{book_id}", response_model=BookInfo)
async def get_book(book_id: str):
    """获取书籍信息"""
    if book_id not in books_storage:
        raise HTTPException(status_code=404, detail="书籍不存在")
    return books_storage[book_id]


@router.get("/")
async def list_books():
    """列出所有书籍"""
    return {"books": list(books_storage.values())}
