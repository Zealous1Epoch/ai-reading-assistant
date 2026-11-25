"""桌面版后端启动器（v3.9 打包入口，PyInstaller 冻结脚本）

与开发态 `python -m uvicorn app.main:app` 的区别：
- 端口由 Electron 壳随机分配（避免与本机已占 8000 的开发服务打架），走 --port 传入；
- 冻结态数据目录在用户数据目录（见 config.runtime_data_dir），这里负责首启创建；
- 关掉 chromadb 匿名遥测（离线分发的程序不该往外发心跳）。

用法（打包机与排障通用）：
    reader-server --port 8788
    reader-server --port 8788 --data-dir /tmp/factory-test   # 冒烟时隔离真实数据
"""
import argparse
import os
import sys


def main() -> None:
    parser = argparse.ArgumentParser(description="智能读书助手桌面版后端")
    parser.add_argument("--port", type=int, default=8788)
    parser.add_argument("--data-dir", default=None, help="覆盖可写数据目录（冒烟测试用）")
    args = parser.parse_args()

    if args.data_dir:
        os.environ["READER_DATA_DIR"] = args.data_dir
    # 必须在 chromadb 首次 import 前进环境
    os.environ.setdefault("ANONYMIZED_TELEMETRY", "False")

    # 冻结态首启：把可写目录先立起来（开发态路径已存在，等价空操作）
    from app.config import get_settings
    settings = get_settings()
    os.makedirs(settings.data_dir, exist_ok=True)
    os.makedirs(settings.upload_dir, exist_ok=True)

    print(f"[reader-server] data_dir={settings.data_dir}", flush=True)
    print(f"[reader-server] listening=http://127.0.0.1:{args.port}", flush=True)

    import uvicorn
    from app.main import app

    # 冻结态禁止 reload/workers（watchdog 在 bundle 里行为不可靠，单进程足够本地用）
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")


if __name__ == "__main__":
    main()
