#!/usr/bin/env bash
# 职责: 兼容旧版 macOS 双击启动入口。
# 关注点:
# - 不再直接依赖系统 node，统一转发到 portable bridge 入口。
# - 保持旧文件名可用，避免历史 README 或用户习惯失效。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

if [ -z "${BRIDGE_CONFIG_PATH:-}" ] && [ -f "$ROOT/config.json" ]; then
  case "$(uname -s)" in
    Darwin)
      PORTABLE_HOME="${BRIDGE_HOME:-$HOME/Library/Application Support/FeishuOpenCodeBridge}"
      ;;
    *)
      PORTABLE_HOME="${BRIDGE_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/FeishuOpenCodeBridge}"
      ;;
  esac
  if [ ! -f "$PORTABLE_HOME/config.json" ]; then
    export BRIDGE_CONFIG_PATH="$ROOT/config.json"
  fi
fi

exec "$ROOT/bridge" start
