#!/usr/bin/env bash

set -euo pipefail

BASE_URL="${BASE_URL:-https://api.mailagents.net}"
TEMP_FILES=()
MKTEMP_BIN="${MKTEMP_BIN:-/usr/bin/mktemp}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

cleanup() {
  if [[ "${#TEMP_FILES[@]}" -gt 0 ]]; then
    rm -f "${TEMP_FILES[@]}"
  fi
}

track_temp_file() {
  TEMP_FILES+=("$1")
}

new_temp_file() {
  local file
  file="$("$MKTEMP_BIN" -t mailagents-prod-public.XXXXXX)"
  track_temp_file "$file"
  printf '%s\n' "$file"
}

capture_response() {
  local headers_file="$1"
  local body_file="$2"
  shift 2
  curl -sS -D "$headers_file" -o "$body_file" -w "%{http_code}" "$@"
}

require_header() {
  local headers_file="$1"
  local expected="$2"
  if ! grep -Fqi "$expected" "$headers_file"; then
    echo "Missing expected header '$expected'" >&2
    cat "$headers_file" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd jq
if [[ ! -x "$MKTEMP_BIN" ]]; then
  MKTEMP_BIN="$(command -v mktemp || true)"
fi
if [[ -z "$MKTEMP_BIN" ]]; then
  echo "Missing required command: mktemp" >&2
  exit 1
fi
require_cmd "$MKTEMP_BIN"

trap cleanup EXIT

echo "Checking home page..."
HOME_HEADERS="$(new_temp_file)"
HOME_BODY="$(new_temp_file)"
HOME_STATUS="$(capture_response "$HOME_HEADERS" "$HOME_BODY" "$BASE_URL/")"
[[ "$HOME_STATUS" == "200" ]]
require_header "$HOME_HEADERS" "content-type: text/html"

echo "Checking runtime metadata..."
RUNTIME_HEADERS="$(new_temp_file)"
RUNTIME_BODY="$(new_temp_file)"
RUNTIME_STATUS="$(capture_response "$RUNTIME_HEADERS" "$RUNTIME_BODY" "$BASE_URL/v2/meta/runtime")"
[[ "$RUNTIME_STATUS" == "200" ]]
jq -e '.server.name == "mailagents-runtime" and (.api.supportedHttpVersions | index("v2") != null) and .routes.adminEnabled == false and .routes.debugEnabled == false' \
  "$RUNTIME_BODY" >/dev/null

echo "Checking compatibility metadata..."
COMPAT_HEADERS="$(new_temp_file)"
COMPAT_BODY="$(new_temp_file)"
COMPAT_STATUS="$(capture_response "$COMPAT_HEADERS" "$COMPAT_BODY" "$BASE_URL/v2/meta/compatibility")"
[[ "$COMPAT_STATUS" == "200" ]]
jq -e '.contract.name == "mailagents-agent-compatibility" and .routes.adminEnabled == false and .routes.debugEnabled == false' \
  "$COMPAT_BODY" >/dev/null

echo "Checking compatibility schema..."
SCHEMA_HEADERS="$(new_temp_file)"
SCHEMA_BODY="$(new_temp_file)"
SCHEMA_STATUS="$(capture_response "$SCHEMA_HEADERS" "$SCHEMA_BODY" "$BASE_URL/v2/meta/compatibility/schema")"
[[ "$SCHEMA_STATUS" == "200" ]]
jq -e '.type == "object" and (.required | index("contract") != null) and (.required | index("routes") != null) and .properties.contract.type == "object" and .properties.routes.type == "object"' \
  "$SCHEMA_BODY" >/dev/null

echo "Checking public signup method guard..."
SIGNUP_GET_HEADERS="$(new_temp_file)"
SIGNUP_GET_BODY="$(new_temp_file)"
SIGNUP_GET_STATUS="$(capture_response "$SIGNUP_GET_HEADERS" "$SIGNUP_GET_BODY" "$BASE_URL/public/signup")"
[[ "$SIGNUP_GET_STATUS" == "405" ]]
require_header "$SIGNUP_GET_HEADERS" "allow: POST"
require_header "$SIGNUP_GET_HEADERS" "access-control-allow-methods: POST, OPTIONS"
jq -e '.error == "method not allowed; use POST"' "$SIGNUP_GET_BODY" >/dev/null

echo "Checking public signup content-type guard..."
SIGNUP_TYPE_HEADERS="$(new_temp_file)"
SIGNUP_TYPE_BODY="$(new_temp_file)"
SIGNUP_TYPE_STATUS="$(capture_response "$SIGNUP_TYPE_HEADERS" "$SIGNUP_TYPE_BODY" \
  -X POST "$BASE_URL/public/signup" \
  -H 'content-type: text/plain' \
  --data 'hello')"
[[ "$SIGNUP_TYPE_STATUS" == "415" ]]
jq -e '.error == "content-type must be application/json"' "$SIGNUP_TYPE_BODY" >/dev/null

echo "Checking public signup JSON object guard..."
SIGNUP_ARRAY_HEADERS="$(new_temp_file)"
SIGNUP_ARRAY_BODY="$(new_temp_file)"
SIGNUP_ARRAY_STATUS="$(capture_response "$SIGNUP_ARRAY_HEADERS" "$SIGNUP_ARRAY_BODY" \
  -X POST "$BASE_URL/public/signup" \
  -H 'content-type: application/json' \
  --data '[]')"
[[ "$SIGNUP_ARRAY_STATUS" == "400" ]]
jq -e '.error == "JSON body must be an object" and .values == {}' "$SIGNUP_ARRAY_BODY" >/dev/null

echo "Checking public signup required-field validation..."
SIGNUP_EMPTY_HEADERS="$(new_temp_file)"
SIGNUP_EMPTY_BODY="$(new_temp_file)"
SIGNUP_EMPTY_STATUS="$(capture_response "$SIGNUP_EMPTY_HEADERS" "$SIGNUP_EMPTY_BODY" \
  -X POST "$BASE_URL/public/signup" \
  -H 'content-type: application/json' \
  --data '{}')"
[[ "$SIGNUP_EMPTY_STATUS" == "400" ]]
jq -e '.error == "Mailbox alias, agent name, operator email, product name, and use case are all required." and .values.mailboxAlias == "" and .values.agentName == "" and .values.operatorEmail == "" and .values.productName == "" and .values.useCase == ""' \
  "$SIGNUP_EMPTY_BODY" >/dev/null

echo "Checking public signup field validation..."
SIGNUP_INVALID_HEADERS="$(new_temp_file)"
SIGNUP_INVALID_BODY="$(new_temp_file)"
SIGNUP_INVALID_STATUS="$(capture_response "$SIGNUP_INVALID_HEADERS" "$SIGNUP_INVALID_BODY" \
  -X POST "$BASE_URL/public/signup" \
  -H 'content-type: application/json' \
  --data '{"mailboxAlias":"Bad Alias","agentName":"Demo Agent","operatorEmail":"not-an-email","productName":"MailAgents","useCase":"Testing"}')"
[[ "$SIGNUP_INVALID_STATUS" == "400" ]]
jq -e '.error == "Mailbox alias must be 3-32 characters and use lowercase letters, numbers, dot, dash, underscore, or plus." and .values.mailboxAlias == "bad alias" and .values.operatorEmail == "not-an-email"' \
  "$SIGNUP_INVALID_BODY" >/dev/null

echo "Checking public token-reissue method guard..."
REISSUE_GET_HEADERS="$(new_temp_file)"
REISSUE_GET_BODY="$(new_temp_file)"
REISSUE_GET_STATUS="$(capture_response "$REISSUE_GET_HEADERS" "$REISSUE_GET_BODY" "$BASE_URL/public/token/reissue")"
[[ "$REISSUE_GET_STATUS" == "405" ]]
require_header "$REISSUE_GET_HEADERS" "allow: POST"
require_header "$REISSUE_GET_HEADERS" "access-control-allow-methods: POST, OPTIONS"
jq -e '.error == "method not allowed; use POST"' "$REISSUE_GET_BODY" >/dev/null

echo "Checking public token-reissue CORS preflight..."
REISSUE_OPTIONS_HEADERS="$(new_temp_file)"
REISSUE_OPTIONS_BODY="$(new_temp_file)"
REISSUE_OPTIONS_STATUS="$(capture_response "$REISSUE_OPTIONS_HEADERS" "$REISSUE_OPTIONS_BODY" \
  -X OPTIONS "$BASE_URL/public/token/reissue")"
[[ "$REISSUE_OPTIONS_STATUS" == "204" ]]
require_header "$REISSUE_OPTIONS_HEADERS" "access-control-allow-methods: POST, OPTIONS"
require_header "$REISSUE_OPTIONS_HEADERS" "access-control-allow-origin: *"

echo "Checking public token-reissue invalid JSON..."
REISSUE_INVALID_JSON_HEADERS="$(new_temp_file)"
REISSUE_INVALID_JSON_BODY="$(new_temp_file)"
REISSUE_INVALID_JSON_STATUS="$(capture_response "$REISSUE_INVALID_JSON_HEADERS" "$REISSUE_INVALID_JSON_BODY" \
  -X POST "$BASE_URL/public/token/reissue" \
  -H 'content-type: application/json' \
  --data '{')"
[[ "$REISSUE_INVALID_JSON_STATUS" == "400" ]]
jq -e '.error == "Invalid JSON body"' "$REISSUE_INVALID_JSON_BODY" >/dev/null

echo "Checking public token-reissue JSON object guard..."
REISSUE_ARRAY_HEADERS="$(new_temp_file)"
REISSUE_ARRAY_BODY="$(new_temp_file)"
REISSUE_ARRAY_STATUS="$(capture_response "$REISSUE_ARRAY_HEADERS" "$REISSUE_ARRAY_BODY" \
  -X POST "$BASE_URL/public/token/reissue" \
  -H 'content-type: application/json' \
  --data '[]')"
[[ "$REISSUE_ARRAY_STATUS" == "400" ]]
jq -e '.error == "JSON body must be an object"' "$REISSUE_ARRAY_BODY" >/dev/null

echo "Checking public token-reissue required-field validation..."
REISSUE_EMPTY_HEADERS="$(new_temp_file)"
REISSUE_EMPTY_BODY="$(new_temp_file)"
REISSUE_EMPTY_STATUS="$(capture_response "$REISSUE_EMPTY_HEADERS" "$REISSUE_EMPTY_BODY" \
  -X POST "$BASE_URL/public/token/reissue" \
  -H 'content-type: application/json' \
  --data '{}')"
[[ "$REISSUE_EMPTY_STATUS" == "400" ]]
jq -e '.error == "mailboxAlias or mailboxAddress is required"' "$REISSUE_EMPTY_BODY" >/dev/null

echo "Checking public token-reissue alias validation..."
REISSUE_ALIAS_HEADERS="$(new_temp_file)"
REISSUE_ALIAS_BODY="$(new_temp_file)"
REISSUE_ALIAS_STATUS="$(capture_response "$REISSUE_ALIAS_HEADERS" "$REISSUE_ALIAS_BODY" \
  -X POST "$BASE_URL/public/token/reissue" \
  -H 'content-type: application/json' \
  --data '{"mailboxAlias":"Bad Alias"}')"
[[ "$REISSUE_ALIAS_STATUS" == "400" ]]
jq -e '.error == "mailboxAlias must be 3-32 characters, start with a letter or digit, and use only lowercase letters, digits, ., _, +, or -"' \
  "$REISSUE_ALIAS_BODY" >/dev/null

echo "Checking public token-reissue generic accepted response..."
REISSUE_ACCEPT_HEADERS="$(new_temp_file)"
REISSUE_ACCEPT_BODY="$(new_temp_file)"
REISSUE_ACCEPT_STATUS="$(capture_response "$REISSUE_ACCEPT_HEADERS" "$REISSUE_ACCEPT_BODY" \
  -X POST "$BASE_URL/public/token/reissue" \
  -H 'content-type: application/json' \
  --data '{"mailboxAddress":"nobody@example.invalid"}')"
[[ "$REISSUE_ACCEPT_STATUS" == "202" ]]
jq -e '.accepted == true and .message == "If the mailbox exists, a refreshed access token will be emailed to the original operator inbox."' \
  "$REISSUE_ACCEPT_BODY" >/dev/null

echo "Checking admin MCP remains disabled..."
ADMIN_MCP_HEADERS="$(new_temp_file)"
ADMIN_MCP_BODY="$(new_temp_file)"
ADMIN_MCP_STATUS="$(capture_response "$ADMIN_MCP_HEADERS" "$ADMIN_MCP_BODY" \
  -X POST "$BASE_URL/admin/mcp" \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"production-public-smoke","version":"1.0.0"}}}')"
[[ "$ADMIN_MCP_STATUS" == "400" ]]
jq -e '.error.message == "Admin routes are disabled" and .error.data.errorCode == "route_disabled" and .error.data.status == 404' \
  "$ADMIN_MCP_BODY" >/dev/null

echo "Production public black-box smoke passed for ${BASE_URL}"
