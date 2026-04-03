#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
OPEN_CODE_DIR="$SCRIPT_DIR/.."
OPEN_CODE_CLI="$OPEN_CODE_DIR/opencode-cli"

if [ ! -f "$OPEN_CODE_CLI" ]; then
  echo "Could not find $OPEN_CODE_CLI"
  exit 1
fi

echo "Starting OpenCode Serve..."
"$OPEN_CODE_CLI" serve &
CLI_PID=$!

echo "Starting Feishu Bridge..."
cd "$SCRIPT_DIR"
npm run dev

# Ensure the background process is terminated when the script exits
trap "kill $CLI_PID" EXIT
