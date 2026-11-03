#!/usr/bin/env python3
"""下载 bge-small-zh-v1.5 的 ONNX 版模型到 backend/data/models/。

用于中文语义检索（替代 ChromaDB 默认英文 MiniLM）。
仅首次运行需要；已存在的文件默认跳过（--force 重下）。

用法：
    python scripts/download_embedding_model.py [--quantized] [--force]

来源：hf-mirror.com 上的 Xenova/bge-small-zh-v1.5（ONNX 转换版）。
"""
import argparse
import shutil
import sys
import urllib.request
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = PROJECT_ROOT / "backend" / "data" / "models" / "bge-small-zh-v1.5"

BASE = "https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main"
FILES_COMMON = ["config.json", "tokenizer.json", "tokenizer_config.json"]


def download(url: str, dest: Path, force: bool = False) -> bool:
    if dest.exists() and not force and dest.stat().st_size > 0:
        print(f"  已存在，跳过: {dest.name} ({dest.stat().st_size/1e6:.1f} MB)")
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    print(f"  下载中: {url}")
    # hf-mirror 会拒绝 python 默认 UA（小文件 403），必须伪装浏览器
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as f:
            total = int(resp.headers.get("content-length", 0))
            done = 0
            while True:
                data = resp.read(1 << 20)
                if not data:
                    break
                f.write(data)
                done += len(data)
                if total:
                    print(f"\r    进度 {done/1e6:.1f}/{total/1e6:.1f} MB ({done*100//total}%)",
                          end="", flush=True)
        print()
        tmp.rename(dest)
        return True
    except Exception as e:
        print(f"\n  下载失败: {e}")
        tmp.unlink(missing_ok=True)
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quantized", action="store_true",
                    help="下载 int8 量化版（~24MB，速度更快、质量略降），默认全精度（~90MB）")
    ap.add_argument("--force", action="store_true", help="强制重新下载")
    args = ap.parse_args()

    model_file = "onnx/model_quantized.onnx" if args.quantized else "onnx/model.onnx"
    print(f"模型目录: {MODEL_DIR}")

    ok = True
    for f in FILES_COMMON:
        ok &= download(f"{BASE}/{f}", MODEL_DIR / f, args.force)
    ok &= download(f"{BASE}/{model_file}", MODEL_DIR / "onnx" / "model.onnx", args.force)

    if not ok:
        print("部分文件下载失败，请检查网络后重试")
        return 1

    # 冒烟：加载并编码一句话
    sys.path.insert(0, str(PROJECT_ROOT / "backend"))
    try:
        from app.services.embeddings import BGESmallZhONNXEmbeddingFunction
        ef = BGESmallZhONNXEmbeddingFunction(str(MODEL_DIR))
        vec = ef(["非暴力沟通的核心要素是什么？"])[0]
        norm = sum(x * x for x in vec) ** 0.5
        print(f"冒烟通过: 输出维度 {len(vec)}, L2 范数 {norm:.4f}（应≈1）")
    except Exception as e:
        print(f"模型文件已就位，但加载失败: {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
