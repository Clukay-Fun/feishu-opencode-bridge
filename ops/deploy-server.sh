#!/usr/bin/env bash
set -euo pipefail

SERVER_DIR="${SERVER_DIR:-/srv/feishu-opencode-bridge}"

: "${SERVER_HOST:?Set SERVER_HOST before running deploy-server.sh}"
: "${SERVER_USER:?Set SERVER_USER before running deploy-server.sh}"
: "${SSH_KEY:?Set SSH_KEY before running deploy-server.sh}"
: "${PUBLIC_HEALTH_URL:?Set PUBLIC_HEALTH_URL before running deploy-server.sh}"

SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes)
RSYNC_RSH="ssh -i $SSH_KEY -o BatchMode=yes"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[1/4] Sync project to $SERVER_USER@$SERVER_HOST:$SERVER_DIR"
rsync -az --delete \
  --include "/src/***" \
  --include "/ops/***" \
  --include "/Dockerfile" \
  --include "/docker-compose.yml" \
  --include "/docker-compose.tunnel.yml" \
  --include "/.dockerignore" \
  --include "/package.json" \
  --include "/package-lock.json" \
  --include "/tsconfig.json" \
  --include "/config.example.json" \
  --include "/config.general.example.json" \
  --include "/config.legal.example.json" \
  --include "/AGENTS.md" \
  --include "/CODEX.md" \
  --include "/README.md" \
  --include "/README.en.md" \
  --include "/LICENSE" \
  --exclude "*" \
  -e "$RSYNC_RSH" \
  "$ROOT_DIR/" \
  "$SERVER_USER@$SERVER_HOST:$SERVER_DIR/"

echo "      Remove stale non-runtime files from previous full sync"
"${SSH[@]}" "$SERVER_USER@$SERVER_HOST" \
  "cd '$SERVER_DIR' && rm -rf .claude .github .opencode .runtime artifacts bin coverage docs release test turn-files node_modules dist .DS_Store"

echo "[2/4] Rebuild and restart Bridge"
"${SSH[@]}" "$SERVER_USER@$SERVER_HOST" \
  "cd '$SERVER_DIR' && docker compose up -d"

echo "[3/4] Ensure tunnel and OpenCode are running"
"${SSH[@]}" "$SERVER_USER@$SERVER_HOST" \
  "cd '$SERVER_DIR' && docker compose -f docker-compose.tunnel.yml --env-file .env.tunnel up -d && systemctl --user restart opencode-bridge.service"

echo "[4/4] Verify health"
"${SSH[@]}" "$SERVER_USER@$SERVER_HOST" \
  "cd '$SERVER_DIR' && docker compose ps && curl -fsS '$PUBLIC_HEALTH_URL' >/dev/null"

echo "Deploy complete: $PUBLIC_HEALTH_URL"
