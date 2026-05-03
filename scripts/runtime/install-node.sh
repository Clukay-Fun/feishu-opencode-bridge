#!/usr/bin/env bash
# 职责: 为 macOS / Linux portable 包下载并解压 Node.js。
# 关注点:
# - 只写入项目 .runtime/node，不安装到系统目录。
# - 根据 uname 结果选择 Node 官方 archive。
# - 由 bridge 启动脚本调用，不依赖仓库内 Node 脚本。
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
VERSION="${BRIDGE_NODE_VERSION:-v22.15.0}"
RUNTIME_DIR="$ROOT/.runtime"
NODE_DIR="$RUNTIME_DIR/node"
NODE_BIN="$NODE_DIR/bin/node"

if [ -x "$NODE_BIN" ]; then
  echo "检测到 portable Node: $NODE_BIN"
  exit 0
fi

machine="$(uname -m)"
case "$machine" in
  arm64|aarch64) node_arch="arm64" ;;
  *) node_arch="x64" ;;
esac

system="$(uname -s)"
case "$system" in
  Darwin)
    platform="darwin"
    ext="tar.gz"
    ;;
  Linux)
    platform="linux"
    ext="tar.xz"
    ;;
  *)
    echo "暂不支持自动下载 Node: $system $machine" >&2
    exit 1
    ;;
esac

name="node-$VERSION-$platform-$node_arch"
url="https://nodejs.org/dist/$VERSION/$name.$ext"
archive="$RUNTIME_DIR/$name.$ext"
tmp_dir="$RUNTIME_DIR/node-download"

echo "未检测到 Node，正在下载 portable Node $VERSION ($platform-$node_arch)，预计 30-60 秒..."
mkdir -p "$RUNTIME_DIR"
rm -rf "$tmp_dir" "$archive"

if command -v curl >/dev/null 2>&1; then
  curl -fL "$url" -o "$archive"
elif command -v wget >/dev/null 2>&1; then
  wget "$url" -O "$archive"
else
  echo "未检测到 curl 或 wget，无法自动下载 Node。" >&2
  exit 1
fi

mkdir -p "$tmp_dir"
tar -xf "$archive" -C "$tmp_dir"
rm -rf "$NODE_DIR"
mv "$tmp_dir/$name" "$NODE_DIR"
rm -rf "$tmp_dir" "$archive"

if [ ! -x "$NODE_BIN" ]; then
  echo "Node 下载完成但未找到可执行文件: $NODE_BIN" >&2
  exit 1
fi

echo "portable Node 已就绪: $NODE_BIN"
