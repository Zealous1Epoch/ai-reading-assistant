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
        # 绝对路径
        "/Users/pp/Python（Ai）/智能读书助手/.env",
        "/Users/pp/Python（Ai）/智能读书助手/backend/.env",
    ]
    for path in possible_paths:
        if os.path.exists(path):
            return path
    return ".env"


class Settings(BaseSettings):
    """应用配置"""
    app_name: str = "智能读书助手"
    app_env: str = "development"
    debug: bool = True

    # DeepSeek API
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: str = "deepseek-chat"

    # 数据库
    database_url: str = "sqlite:///./data/books.db"

    # Redis
    redis_url: str = "redis://localhost:6379/0"

    class Config:
        env_file = find_env_file()
        env_file_encoding = "utf-8"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
