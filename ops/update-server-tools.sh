#!/usr/bin/env bash
set -euo pipefail

SERVER_DIR="${SERVER_DIR:-/srv/feishu-opencode-bridge}"

: "${SERVER_HOST:?Set SERVER_HOST before running update-server-tools.sh}"
: "${SERVER_USER:?Set SERVER_USER before running update-server-tools.sh}"
: "${SSH_KEY:?Set SSH_KEY before running update-server-tools.sh}"

UPDATE_LARK=1
UPDATE_OPENCODE=0
UPDATE_CLOUDFLARED=0

usage() {
  cat <<'USAGE'
Usage: ops/update-server-tools.sh [options]

Update server-side CLI/tooling dependencies without redeploying bridge code.

Options:
  --lark-cli       Update @larksuite/cli. This is enabled by default.
  --opencode      Update opencode-ai and restart opencode-bridge.service.
  --cloudflared   Pull the cloudflared image and restart the tunnel compose service.
  --all           Update lark-cli, opencode, and cloudflared.
  --no-lark-cli   Skip @larksuite/cli.
  -h, --help      Show this help.

Environment:
  SERVER_HOST     Required target host.
  SERVER_USER     Required SSH user.
  SERVER_DIR      Default: /srv/feishu-opencode-bridge
  SSH_KEY         Required SSH private key path.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lark-cli)
      UPDATE_LARK=1
      ;;
    --no-lark-cli)
      UPDATE_LARK=0
      ;;
    --opencode)
      UPDATE_OPENCODE=1
      ;;
    --cloudflared)
      UPDATE_CLOUDFLARED=1
      ;;
    --all)
      UPDATE_LARK=1
      UPDATE_OPENCODE=1
      UPDATE_CLOUDFLARED=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes)

remote_run() {
  "${SSH[@]}" "$SERVER_USER@$SERVER_HOST" "$1"
}

if [[ "$UPDATE_LARK" -eq 1 ]]; then
  echo "[lark-cli] Update @larksuite/cli"
  remote_run "set -euo pipefail
sudo -n npm install -g --prefix /usr/local @larksuite/cli@latest
lark-cli --version 2>/dev/null || lark-cli version"
fi

if [[ "$UPDATE_OPENCODE" -eq 1 ]]; then
  echo "[opencode] Update opencode-ai and restart OpenCode service"
  remote_run "set -euo pipefail
sudo -n npm install -g opencode-ai@latest
systemctl --user restart opencode-bridge.service
sleep 3
systemctl --user is-active opencode-bridge.service
opencode --version"
fi

if [[ "$UPDATE_CLOUDFLARED" -eq 1 ]]; then
  echo "[cloudflared] Pull image and restart tunnel service"
  remote_run "set -euo pipefail
cd '$SERVER_DIR'
docker compose -f docker-compose.tunnel.yml --env-file .env.tunnel pull cloudflared
docker compose -f docker-compose.tunnel.yml --env-file .env.tunnel up -d cloudflared
docker compose -f docker-compose.tunnel.yml --env-file .env.tunnel ps cloudflared"
fi

echo "Server tool update complete."
