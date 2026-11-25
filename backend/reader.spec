# -*- mode: python ; coding: utf-8 -*-
# 智能读书助手桌面版后端冻结配置（v3.9 打包）
# 用法（在 backend/ 目录）：
#   pyinstaller reader.spec --noconfirm
# 产出 dist/reader-server/（onedir：启动快、遥测 dylib 不每次解包、杀软误报率低）
#
# datas 契约（与代码里的 bundle_root() 读取路径一一对应，改这边必须同步改那边）：
#   frontend/dist      ← app.main dist_dir（FROZEN 分支）
#   experts/           ← app.services.experts _PACK_DIR（FROZEN 分支）
#   models/bge-...     ← config.embedding_model_dir（FROZEN 分支）

import os
from PyInstaller.utils.hooks import collect_all, collect_data_files

binaries, datas, hiddenimports = [], [], []

# chromadb：迁移脚本/json 配置/原生 bindings 全是坑，整包收集最稳
for pkg in ("chromadb", "onnxruntime", "tokenizers", "edge_tts", "ebooklib"):
    b, d, h = collect_all(pkg)
    binaries += b
    datas += d
    hiddenimports += h

# 前端与静态资源（相对 SPECPATH=backend/）
datas += [
    (os.path.join(SPECPATH, "..", "frontend", "dist"), "frontend/dist"),
    (os.path.join(SPECPATH, "app", "experts"), "experts"),
    (os.path.join(SPECPATH, "data", "models", "bge-small-zh-v1.5"), "models/bge-small-zh-v1.5"),
]

# uvicorn 运行时按字符串挑选 loop/protocol 实现，静态分析看不见
hiddenimports += [
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.protocols.lifespan",
    "uvicorn.protocols.lifespan.on",
    "pymupdf",
]

# python-magic 依赖系统 libmagic，别的机器上没装 homebrew 就是哑弹——
# 干脆排除，代码里 HAS_MAGIC=False 走扩展名降级路径（document_service/book_processor 已有）
excludes = ["magic", "pytest", "tkinter", "PyQt5", "PySide2"]

a = Analysis(
    ["server_launcher.py"],
    pathex=[SPECPATH],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="reader-server",
    debug=False,
    strip=False,
    upx=False,
    console=False,  # Windows 不弹黑框；排障时临时改 True 看日志
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="reader-server",
)
