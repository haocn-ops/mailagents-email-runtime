#!/usr/bin/env bash

set -euo pipefail

BASE_URL="${BASE_URL:-https://api.mailagents.net}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

request_probe() {
  local name="$1"
  shift

  local body_file="$TMP_DIR/${name}.body"
  local header_file="$TMP_DIR/${name}.headers"
  local exit_file="$TMP_DIR/${name}.exit"
  local status_file="$TMP_DIR/${name}.status"
  local status
  local exit_code

  : > "$body_file"
  : > "$header_file"
  set +e
  status="$(curl -sS \
    --connect-timeout 10 \
    --max-time 20 \
    --retry 2 \
    --retry-delay 1 \
    --retry-all-errors \
    -o "$body_file" \
    -D "$header_file" \
    -w '%{http_code}' \
    "$@")"
  exit_code=$?
  set -e
  if [[ -z "$status" ]]; then
    status="000"
  fi
  printf '%s' "$exit_code" > "$exit_file"
  printf '%s' "$status" > "$status_file"
}

read_status() {
  cat "$TMP_DIR/$1.status"
}

read_exit_code() {
  cat "$TMP_DIR/$1.exit"
}

read_json_string() {
  local file="$1"
  local expr="$2"
  jq -r "try (($expr) | if . == null then empty else . end) catch empty" "$file" 2>/dev/null || true
}

trap cleanup EXIT

require_cmd curl
require_cmd jq

request_probe runtime "${BASE_URL}/v2/meta/runtime"
request_probe compatibility "${BASE_URL}/v2/meta/compatibility"
request_probe admin_mcp \
  -X POST "${BASE_URL}/admin/mcp" \
  -H 'content-type: application/json' \
  -H 'x-admin-secret: invalid-secret' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
request_probe auth_tokens \
  -X POST "${BASE_URL}/v1/auth/tokens" \
  -H 'content-type: application/json' \
  --data '{"sub":"probe","tenantId":"t_probe","scopes":["agent:read"]}'
request_probe debug "${BASE_URL}/v1/debug/agents/agt_demo"

RUNTIME_FILE="$TMP_DIR/runtime.body"
COMPATIBILITY_FILE="$TMP_DIR/compatibility.body"
ADMIN_MCP_FILE="$TMP_DIR/admin_mcp.body"
AUTH_TOKENS_FILE="$TMP_DIR/auth_tokens.body"
DEBUG_FILE="$TMP_DIR/debug.body"

runtime_admin_enabled="$(read_json_string "$RUNTIME_FILE" '.routes.adminEnabled')"
runtime_debug_enabled="$(read_json_string "$RUNTIME_FILE" '.routes.debugEnabled')"
runtime_admin_mcp_path="$(read_json_string "$RUNTIME_FILE" '.api.adminMcpPath')"
runtime_outbound_provider="$(read_json_string "$RUNTIME_FILE" '.delivery.outboundProvider')"

compat_admin_enabled="$(read_json_string "$COMPATIBILITY_FILE" '.routes.adminEnabled')"
compat_debug_enabled="$(read_json_string "$COMPATIBILITY_FILE" '.routes.debugEnabled')"
compat_admin_mcp_path="$(read_json_string "$COMPATIBILITY_FILE" '.discovery.adminMcpPath')"

admin_mcp_status="$(read_status admin_mcp)"
admin_mcp_exit_code="$(read_exit_code admin_mcp)"
admin_mcp_error_message="$(read_json_string "$ADMIN_MCP_FILE" '.error.message')"
admin_mcp_error_detail="$(read_json_string "$ADMIN_MCP_FILE" '.error.data.error')"

auth_tokens_status="$(read_status auth_tokens)"
auth_tokens_exit_code="$(read_exit_code auth_tokens)"
auth_tokens_error="$(read_json_string "$AUTH_TOKENS_FILE" '.error')"

debug_status="$(read_status debug)"
debug_exit_code="$(read_exit_code debug)"
debug_error="$(read_json_string "$DEBUG_FILE" '.error')"

runtime_status="$(read_status runtime)"
runtime_exit_code="$(read_exit_code runtime)"
compat_status="$(read_status compatibility)"
compat_exit_code="$(read_exit_code compatibility)"

admin_metadata_live="false"
admin_route_live="false"
drift_detected="false"
network_failures=()
admin_mcp_disabled="false"

if [[ "$runtime_exit_code" != "0" || "$runtime_status" == "000" ]]; then
  network_failures+=("runtime metadata")
fi

if [[ "$compat_exit_code" != "0" || "$compat_status" == "000" ]]; then
  network_failures+=("compatibility metadata")
fi

if [[ "$admin_mcp_exit_code" != "0" || "$admin_mcp_status" == "000" ]]; then
  network_failures+=("admin MCP probe")
fi

if [[ "$auth_tokens_exit_code" != "0" || "$auth_tokens_status" == "000" ]]; then
  network_failures+=("admin auth probe")
fi

if [[ "$debug_exit_code" != "0" || "$debug_status" == "000" ]]; then
  network_failures+=("debug probe")
fi

if [[ "$runtime_admin_enabled" == "true" || "$compat_admin_enabled" == "true" || -n "$runtime_admin_mcp_path" || -n "$compat_admin_mcp_path" ]]; then
  admin_metadata_live="true"
fi

if [[ "$admin_mcp_status" == "400" && "$admin_mcp_error_message" == "Admin routes are disabled" ]]; then
  admin_mcp_disabled="true"
fi

if [[ "$admin_mcp_disabled" != "true" || "$auth_tokens_status" != "404" ]]; then
  admin_route_live="true"
fi

if [[ "$runtime_admin_enabled" != "false" || "$compat_admin_enabled" != "false" ]]; then
  drift_detected="true"
fi

if [[ -n "$runtime_admin_mcp_path" || -n "$compat_admin_mcp_path" ]]; then
  drift_detected="true"
fi

if [[ "$admin_mcp_disabled" != "true" ]]; then
  drift_detected="true"
fi

if [[ "$auth_tokens_status" != "404" || "$auth_tokens_error" != "Admin routes are disabled" ]]; then
  drift_detected="true"
fi

if [[ "$runtime_debug_enabled" != "false" || "$compat_debug_enabled" != "false" || "$debug_status" != "404" || "$debug_error" != "Debug routes are disabled" ]]; then
  drift_detected="true"
fi

echo "Production live drift check for ${BASE_URL}"
echo "Expected production posture: admin routes disabled, debug routes disabled"
echo
echo "Runtime metadata:"
echo "  adminEnabled=${runtime_admin_enabled:-<missing>}"
echo "  debugEnabled=${runtime_debug_enabled:-<missing>}"
echo "  adminMcpPath=${runtime_admin_mcp_path:-<none>}"
echo "  outboundProvider=${runtime_outbound_provider:-<missing>}"
echo
echo "Compatibility metadata:"
echo "  adminEnabled=${compat_admin_enabled:-<missing>}"
echo "  debugEnabled=${compat_debug_enabled:-<missing>}"
echo "  adminMcpPath=${compat_admin_mcp_path:-<none>}"
echo
echo "Admin MCP probe:"
echo "  status=${admin_mcp_status}"
echo "  errorMessage=${admin_mcp_error_message:-<missing>}"
echo "  errorDetail=${admin_mcp_error_detail:-<missing>}"
echo
echo "Admin auth probe:"
echo "  status=${auth_tokens_status}"
echo "  error=${auth_tokens_error:-<missing>}"
echo
echo "Debug probe:"
echo "  status=${debug_status}"
echo "  error=${debug_error:-<missing>}"
echo

if (( ${#network_failures[@]} > 0 )); then
  echo "Result: INCONCLUSIVE"
  echo "Network probe failures prevented a reliable live diagnosis."
  printf 'Failed probes: %s\n' "$(IFS=', '; echo "${network_failures[*]}")"
  echo "Recommended next step: retry this command when DNS/network access is stable."
  exit 2
fi

if [[ "$drift_detected" != "true" ]]; then
  echo "Result: PASS"
  echo "Live production behavior matches the repo expectation."
  exit 0
fi

echo "Result: FAIL"
echo "Live production behavior diverges from the repo expectation."

if [[ "$admin_metadata_live" == "true" && "$admin_route_live" == "true" ]]; then
  echo "Likely cause: live production currently has public-host admin exposure enabled, or was deployed from a config artifact that enabled it."
elif [[ "$admin_metadata_live" == "true" ]]; then
  echo "Likely cause: metadata advertises the admin surface even though the route probe does not fully agree."
elif [[ "$admin_route_live" == "true" ]]; then
  echo "Likely cause: admin routes are reachable even though discovery metadata does not fully admit it."
fi

echo "Recommended next step: verify the live Cloudflare production vars for mailagents-production, then redeploy and rerun this check."
exit 1
