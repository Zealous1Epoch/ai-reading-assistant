from pydantic_settings import BaseSettings
from functools import lru_cache
from pathlib import Path
import os
import sys

# 项目根目录（backend/app/config.py → 上溯两级到项目根）
PROJECT_ROOT = Path(__file__).resolve().parents[2]

# ---- 桌面冻结模式（PyInstaller）路径适配（v3.9 打包）----
# 只读资源（前端 dist / 专家包 / embedding 模型）：冻结时打进 bundle，从 _MEIPASS 读；
# 可写数据（馆藏/划线/runtime_settings 密钥）：绝不进 bundle——mac 的 .app 可能因
# quarantine 被 Translocation 挂到只读随机路径，Windows 装到 Program Files 也不可写，
# 统一落 OS 用户数据目录。开发态一律维持原 PROJECT_ROOT 行为，零变化。
FROZEN = bool(getattr(sys, "frozen", False))
APP_DIR_NAME = "SmartReader"  # 目录名用 ASCII，Windows 中文路径会绊倒部分 C 扩展


def bundle_root() -> Path:
    """只读资源根目录：开发态=项目根，冻结态=PyInstaller 解包目录"""
    if FROZEN:
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return PROJECT_ROOT


def runtime_data_dir() -> Path:
    """可写数据根目录：开发态=backend/data（原行为），冻结态=OS 用户数据目录"""
    if not FROZEN:
        return PROJECT_ROOT / "backend" / "data"
    env = os.environ.get("READER_DATA_DIR")
    if env:
        return Path(env)
    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / APP_DIR_NAME
    if os.name == "nt":
        return Path(os.environ.get("APPDATA", str(home))) / APP_DIR_NAME
    return home / ".local" / "share" / APP_DIR_NAME


def find_env_file() -> str:
    """查找.env文件"""
    possible_paths = [
        ".env",
        "backend/.env",
        "../.env",
    ]
    for path in possible_paths:
        if os.path.exists(path):
            return path
    return ".env"


class Settings(BaseSettings):
    """应用配置"""
    app_name: str = "PageOn"
    app_env: str = "development"
    debug: bool = True

    # DeepSeek API
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: str = "deepseek-chat"

    # 百度 OCR（通用文字识别·高精度版）——扫描书云端兜底
    baidu_ocr_api_key: str = ""
    baidu_ocr_secret_key: str = ""

    # 路径（绝对锚定，与进程启动目录解耦；冻结态自动切到用户数据目录）
    upload_dir: str = str((runtime_data_dir() if FROZEN else PROJECT_ROOT / "uploads"))
    data_dir: str = str(runtime_data_dir())

    # 上传限制（MB）
    max_upload_size_mb: int = 200

    # RAG 检索
    embedding_provider: str = "bge"  # bge（本地中文模型）| chroma_default（英文 MiniLM，兜底）
    # 冻结态模型文件随 bundle 只读分发（models/ 由 spec 的 datas 打入）
    embedding_model_dir: str = str(
        (bundle_root() / "models" / "bge-small-zh-v1.5") if FROZEN
        else (PROJECT_ROOT / "backend" / "data" / "models" / "bge-small-zh-v1.5")
    )
    chunk_size: int = 650            # 检索切块目标字数
    chunk_overlap: int = 130         # 相邻块重叠字数（防句子跨块被切断）
    search_max_distance: float = 0.75  # cosine 距离阈值，超过视为无关，不进 LLM 上下文

    class Config:
        env_file = find_env_file()
        env_file_encoding = "utf-8"
        # .env 里出现未知键（如历史遗留的 DATABASE_URL）时忽略而不是报错
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
