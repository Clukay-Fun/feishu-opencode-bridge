#!/bin/bash
cd "$(dirname "$0")"

resolve_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi

  for candidate in \
    "${HOMEBREW_NODE_PREFIX:-}/bin/node" \
    "/opt/homebrew/opt/node@20/bin/node" \
    "/usr/local/opt/node@20/bin/node" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node"
  do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

NODE_BIN="$(resolve_node || true)"
if [ -z "$NODE_BIN" ]; then
  if command -v brew >/dev/null 2>&1; then
    echo "未检测到 Node.js，正在通过 Homebrew 安装..."
    brew install node@20 || exit 1
    HOMEBREW_NODE_PREFIX="$(brew --prefix node@20 2>/dev/null || true)"
    NODE_BIN="$(resolve_node || true)"
  else
    echo "未检测到 Node.js，请先安装 Node.js 20+ 后重试。"
    exit 1
  fi
fi

if [ -z "$NODE_BIN" ]; then
  echo "Node.js 已安装，但当前 shell 仍无法定位 node。请重新打开终端后重试。"
  exit 1
fi

NODE_DIR="$(dirname "$NODE_BIN")"
export PATH="$NODE_DIR:$PATH"
"$NODE_BIN" scripts/onboard.mjs
