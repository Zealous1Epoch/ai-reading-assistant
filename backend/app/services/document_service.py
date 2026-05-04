import fitz  # PyMuPDF
from pathlib import Path
from typing import Optional

# 尝试导入magic，如果失败则使用降级方案
try:
    import magic
    HAS_MAGIC = True
except ImportError:
    HAS_MAGIC = False


class DocumentService:
    """文档处理服务"""

    SUPPORTED_FORMATS = {
        "application/pdf": "pdf",
        "application/epub+zip": "epub",
        "text/plain": "txt",
    }

    def detect_format(self, file_path: str) -> Optional[str]:
        """检测文件格式"""
        if HAS_MAGIC:
            try:
                mime = magic.Magic(mime=True)
                file_type = mime.from_file(file_path)
                return self.SUPPORTED_FORMATS.get(file_type)
            except Exception:
                pass

        # 降级方案：使用文件扩展名
        suffix = Path(file_path).suffix.lower()
        format_map = {".pdf": "pdf", ".epub": "epub", ".txt": "txt"}
        return format_map.get(suffix)

    def extract_text_from_pdf(self, file_path: str) -> str:
        """从PDF提取文本"""
        doc = fitz.open(file_path)
        text = ""
        for page in doc:
            text += page.get_text()
        doc.close()
        return text

    def extract_text_from_txt(self, file_path: str) -> str:
        """从TXT提取文本"""
        with open(file_path, "r", encoding="utf-8") as f:
            return f.read()

    def extract_text(self, file_path: str) -> str:
        """提取文本（自动检测格式）"""
        path = Path(file_path)
        suffix = path.suffix.lower()

        if suffix == ".pdf":
            return self.extract_text_from_pdf(file_path)
        elif suffix == ".txt":
            return self.extract_text_from_txt(file_path)
        else:
            # 尝试自动检测
            file_format = self.detect_format(file_path)
            if file_format == "pdf":
                return self.extract_text_from_pdf(file_path)
            else:
                raise ValueError(f"不支持的文件格式: {suffix}")

    def get_pdf_metadata(self, file_path: str) -> dict:
        """获取PDF元数据"""
        doc = fitz.open(file_path)
        metadata = {
            "title": doc.metadata.get("title", ""),
            "author": doc.metadata.get("author", ""),
            "pages": len(doc),
            "format": "PDF",
        }
        doc.close()
        return metadata


# 单例
document_service = DocumentService()
