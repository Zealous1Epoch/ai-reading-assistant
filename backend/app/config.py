from pydantic_settings import BaseSettings
from functools import lru_cache
from pathlib import Path
import os


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


# 项目根目录（backend/app/config.py → 上溯两级到项目根）
PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """应用配置"""
    app_name: str = "智能读书助手"
    app_env: str = "development"
    debug: bool = True

    # DeepSeek API
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: str = "deepseek-chat"

    # 路径（绝对锚定，与进程启动目录解耦）
    upload_dir: str = str(PROJECT_ROOT / "uploads")
    data_dir: str = str(PROJECT_ROOT / "backend" / "data")

    # 上传限制（MB）
    max_upload_size_mb: int = 200

    class Config:
        env_file = find_env_file()
        env_file_encoding = "utf-8"
        # .env 里出现未知键（如历史遗留的 DATABASE_URL）时忽略而不是报错
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
