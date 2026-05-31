#!/usr/bin/env bash
# 职责: 兼容旧版 macOS 双击启动入口。
# 关注点:
# - 不再直接依赖系统 node，统一转发到 portable bridge 入口。
# - 保持旧文件名可用，避免历史 README 或用户习惯失效。
# - 无 config.json 时自动引导 setup 向导。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 检测是否有可用配置
CONFIG_PATH="${BRIDGE_CONFIG_PATH:-}"
if [ -z "$CONFIG_PATH" ]; then
  case "$(uname -s)" in
    Darwin)
      PORTABLE_HOME="${BRIDGE_HOME:-$HOME/Library/Application Support/FeishuOpenCodeBridge}"
      ;;
    *)
      PORTABLE_HOME="${BRIDGE_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/FeishuOpenCodeBridge}"
      ;;
  esac
  if [ -f "$PORTABLE_HOME/config.json" ]; then
    export BRIDGE_CONFIG_PATH="$PORTABLE_HOME/config.json"
  elif [ -f "$ROOT/config.json" ]; then
    export BRIDGE_CONFIG_PATH="$ROOT/config.json"
  fi
fi

# 无配置时自动进入 setup 向导
if [ -z "${BRIDGE_CONFIG_PATH:-}" ]; then
  echo "首次启动，正在打开配置向导..."
  exec "$ROOT/bin/bridge" setup
fi

exec "$ROOT/bin/bridge" start
