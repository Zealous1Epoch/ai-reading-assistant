# Railway / 任意容器：FastAPI + 前端静态资源
FROM python:3.11-slim-bookworm

# python-magic 依赖系统 libmagic，无则 pip 通过后运行期仍会报错
RUN apt-get update \
    && apt-get install -y --no-install-recommends libmagic1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依赖单源：backend/requirements.txt（根目录 requirements.txt 为 -r 引用，不宜单独 COPY）
COPY backend/requirements.txt ./requirements-backend.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r ./requirements-backend.txt

COPY backend/ ./backend/
COPY frontend/ ./frontend/

WORKDIR /app/backend

# Railway 注入 PORT；本地 docker run 未设 PORT 时用 8000
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
