#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
SMOKE_SCRIPT="${1:-$SCRIPT_DIR/local_smoke.sh}"
WORKER_LOG="$(mktemp -t mailagents-local-worker.XXXXXX.log)"
WORKER_PID=""
ENV_OVERLAY_FILE=""
DEV_VARS_FILE="$REPO_ROOT/.dev.vars"

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
  if [[ -n "$ENV_OVERLAY_FILE" && -f "$ENV_OVERLAY_FILE" ]]; then
    rm -f "$ENV_OVERLAY_FILE"
  fi
}

prepare_env_overlay() {
  local var_name
  local wrote_any=0
  local passthrough_vars=(
    SES_MOCK_SEND
    SES_MOCK_SEND_DELAY_MS
    OUTBOUND_SEND_IN_DOUBT_GRACE_SECONDS
    X402_PAY_TO
    X402_DEFAULT_SCHEME
    X402_DEFAULT_NETWORK_ID
    X402_DEFAULT_ASSET
    X402_PRICE_PER_CREDIT_USD
    X402_UPGRADE_PRICE_USD
    X402_FACILITATOR_URL
    X402_FACILITATOR_VERIFY_PATH
    X402_FACILITATOR_SETTLE_PATH
    X402_FACILITATOR_AUTH_TOKEN
    X402_FACILITATOR_MOCK_VERIFY_RESULT
    X402_FACILITATOR_MOCK_SETTLE_RESULT
  )

  ENV_OVERLAY_FILE="$(mktemp -t mailagents-local-worker-env.XXXXXX)"
  : >"$ENV_OVERLAY_FILE"

  for var_name in "${passthrough_vars[@]}"; do
    if [[ -n "${!var_name+x}" ]]; then
      printf '%s=%s\n' "$var_name" "${!var_name}" >>"$ENV_OVERLAY_FILE"
      wrote_any=1
    fi
  done

  if [[ "$wrote_any" -eq 0 ]]; then
    rm -f "$ENV_OVERLAY_FILE"
    ENV_OVERLAY_FILE=""
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
prepare_env_overlay

cd "$REPO_ROOT"
echo "Preparing local D1 schema for smoke run ..."
npm run d1:migrate:local
echo "Seeding local D1 demo data for smoke run ..."
npm run d1:seed:local

if server_is_ready; then
  echo "Reusing existing local worker at $BASE_URL"
else
  echo "Starting local worker for smoke run ..."
  if [[ -n "$ENV_OVERLAY_FILE" ]]; then
    if [[ -f "$DEV_VARS_FILE" ]]; then
      npm run dev:local -- --env-file "$DEV_VARS_FILE" --env-file "$ENV_OVERLAY_FILE" >"$WORKER_LOG" 2>&1 &
    else
      npm run dev:local -- --env-file "$ENV_OVERLAY_FILE" >"$WORKER_LOG" 2>&1 &
    fi
  else
    npm run dev:local >"$WORKER_LOG" 2>&1 &
  fi
  WORKER_PID="$!"

  wait_for_server
fi

echo "Running smoke script: $SMOKE_SCRIPT"
bash "$SMOKE_SCRIPT"

echo "Smoke run completed."
