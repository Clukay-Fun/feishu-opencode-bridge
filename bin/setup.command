#!/usr/bin/env bash
# 职责: 兼容旧版 macOS 双击安装入口。
# 关注点:
# - 不再维护独立 Node/Homebrew 安装逻辑，统一转发到 portable bridge 入口。
# - 保持旧文件名可用，避免历史 README 或用户习惯失效。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$ROOT/bin/bridge" onboard
