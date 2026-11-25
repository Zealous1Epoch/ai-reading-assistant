#!/bin/bash
# 对 PyInstaller onedir 产物内所有 Mach-O 做 ad-hoc 签名（macOS arm64 硬性要求：
# 无有效签名的二进制直接被内核拒绝加载）。无证书、零成本，只解“能不能跑”，
# 不解决 Gatekeeper 警告（那需要 $99 开发者账号 + 公证）。
# 用法：bash scripts/sign_adhoc.sh build/reader-dist/reader-server
set -euo pipefail
TARGET="${1:?用法: sign_adhoc.sh <onedir目录>}"
count=0
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -q "Mach-O"; then
    codesign --force --sign - "$f" >/dev/null 2>&1 || echo "  !! 签名失败: $f"
    count=$((count + 1))
  fi
done < <(find "$TARGET" -type f -print0)
echo "ad-hoc signed $count Mach-O files under $TARGET"
