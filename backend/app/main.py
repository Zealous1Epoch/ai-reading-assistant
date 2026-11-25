from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from app.config import get_settings, FROZEN, bundle_root
from app.routers import chat, book_processor, search, analysis, tools, sessions, experts, cards, assets, audio, highlights, guides, settings as settings_router
import os

settings = get_settings()

app = FastAPI(
    title=settings.app_name,
    description="PageOn — 基于DeepSeek API的智能读书助手 - 支持智能章节切分和语义搜索",
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
app.include_router(sessions.router)
app.include_router(experts.router)
app.include_router(cards.router)
app.include_router(assets.router)
app.include_router(audio.router)
app.include_router(highlights.router)
app.include_router(guides.router)
app.include_router(settings_router.router)


# 前端页面路由
frontend_dir = os.path.join(os.path.dirname(__file__), "..", "..", "frontend")
# v3.9 打包：冻结态前端 dist 随 bundle 只读分发
dist_dir = os.path.join(bundle_root(), "frontend", "dist") if FROZEN else os.path.join(frontend_dir, "dist")

# 路径安全校验辅助函数
def safe_path(base_dir: str, filename: str) -> str | None:
    """返回合法路径，若路径越界返回 None"""
    abs_base = os.path.abspath(base_dir)
    abs_path = os.path.abspath(os.path.join(base_dir, filename))
    if not abs_path.startswith(abs_base + os.sep):
        return None
    return abs_path

# Vite 构建产物静态资源
@app.get("/assets/{filename:path}")
async def serve_assets(filename: str):
    file_path = safe_path(os.path.join(dist_dir, "assets"), filename)
    if file_path is None:
        return JSONResponse({"detail": "Forbidden"}, status_code=403)
    if not os.path.isfile(file_path):
        return JSONResponse({"detail": "File not found"}, status_code=404)
    return FileResponse(file_path)

# 静态资源路由（开发模式）
@app.get("/app.jsx")
async def serve_app_jsx():
    return FileResponse(os.path.join(frontend_dir, "app.jsx"), media_type="application/javascript")

@app.get("/components/{filename:path}")
async def serve_components(filename: str):
    """提供前端组件文件，确保 .jsx 使用正确的 MIME 类型"""
    file_path = safe_path(os.path.join(frontend_dir, "components"), filename)
    if file_path is None:
        return JSONResponse({"detail": "Forbidden"}, status_code=403)
    if not os.path.isfile(file_path):
        return JSONResponse({"detail": "File not found"}, status_code=404)
    media_type = "application/javascript" if filename.endswith(".jsx") else None
    return FileResponse(file_path, media_type=media_type)

@app.get("/vendor/{filename:path}")
async def serve_vendor(filename: str):
    """提供本地 vendor 静态文件"""
    file_path = safe_path(os.path.join(frontend_dir, "vendor"), filename)
    if file_path is None:
        return JSONResponse({"detail": "Forbidden"}, status_code=403)
    if not os.path.isfile(file_path):
        return JSONResponse({"detail": "File not found"}, status_code=404)
    return FileResponse(file_path)


@app.get("/")
async def serve_frontend():
    """提供前端页面"""
    # 优先使用 Vite 构建产物。逐请求现查（v3.5 教训：启动时一次性 isdir 判定会被
    # npm build 清空 dist 的窗口期骗到，导致服务的是引 /src/main.jsx 的源码 index——
    # 浏览器白屏且资源全 404 的玄学现场）
    headers = {"Cache-Control": "no-cache, no-store, must-revalidate"}
    if os.path.isdir(os.path.join(dist_dir, "assets")):
        return FileResponse(os.path.join(dist_dir, "index.html"), headers=headers)
    frontend_path = os.path.join(frontend_dir, "index.html")
    if os.path.exists(frontend_path):
        return FileResponse(frontend_path, headers=headers)
    return {"message": "PageOn API", "version": "1.0.0", "docs": "/docs"}


@app.get("/health")
async def health_check():
    return {"status": "healthy"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
