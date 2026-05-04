from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from app.config import get_settings
from app.routers import chat, books, book_processor, search, analysis, tools
import os

settings = get_settings()

app = FastAPI(
    title=settings.app_name,
    description="基于DeepSeek API的智能读书助手 - 支持智能章节切分和语义搜索",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc"
)

# CORS配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册路由
app.include_router(chat.router)
app.include_router(book_processor.router)
app.include_router(search.router)
app.include_router(analysis.router)
app.include_router(tools.router)


# 前端页面路由
frontend_dir = os.path.join(os.path.dirname(__file__), "..", "..", "frontend")

# 挂载拆分后的组件目录和 app.jsx
if os.path.isdir(os.path.join(frontend_dir, "components")):
    app.mount("/components", StaticFiles(directory=os.path.join(frontend_dir, "components")), name="components")

@app.get("/app.jsx")
async def serve_app_jsx():
    return FileResponse(os.path.join(frontend_dir, "app.jsx"))

@app.get("/")
async def serve_frontend():
    """提供前端页面"""
    frontend_path = os.path.join(frontend_dir, "index.html")
    if os.path.exists(frontend_path):
        return FileResponse(frontend_path)
    return {"message": "智能读书助手 API", "version": "1.0.0", "docs": "/docs"}


@app.get("/health")
async def health_check():
    return {"status": "healthy"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
