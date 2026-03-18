#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
SMOKE_SCRIPT="${1:-$SCRIPT_DIR/local_smoke.sh}"
WORKER_LOG="$(mktemp -t mailagents-local-worker.XXXXXX.log)"
WORKER_PID=""

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

cleanup() {
  if [[ -n "$WORKER_PID" ]] && kill -0 "$WORKER_PID" >/dev/null 2>&1; then
    kill "$WORKER_PID" >/dev/null 2>&1 || true
    wait "$WORKER_PID" >/dev/null 2>&1 || true
  fi
}

server_is_ready() {
  curl --connect-timeout 1 --max-time 2 -fsS "$BASE_URL/" >/dev/null 2>&1
}

wait_for_server() {
  local attempt
  echo "Waiting for local worker at $BASE_URL ..."
  for attempt in $(seq 1 30); do
    if server_is_ready; then
      return 0
    fi
    sleep 1
  done

  echo "Local worker did not become ready. Recent log output:" >&2
  tail -n 40 "$WORKER_LOG" >&2 || true
  exit 1
}

require_cmd curl
require_cmd npm

if [[ ! -f "$SMOKE_SCRIPT" ]]; then
  echo "Smoke script not found: $SMOKE_SCRIPT" >&2
  exit 1
fi

trap cleanup EXIT

cd "$REPO_ROOT"
if server_is_ready; then
  echo "Reusing existing local worker at $BASE_URL"
else
  echo "Starting local worker for smoke run ..."
  npm run dev:local >"$WORKER_LOG" 2>&1 &
  WORKER_PID="$!"

  wait_for_server
fi

echo "Running smoke script: $SMOKE_SCRIPT"
bash "$SMOKE_SCRIPT"

echo "Smoke run completed."
