#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
BASE_ORIGIN="${BASE_ORIGIN:-${BASE_URL%/}}"
ADMIN_SECRET="${ADMIN_API_SECRET_FOR_SMOKE:-replace-with-admin-api-secret}"
TENANT_ID="${TENANT_ID:-t_demo}"
MAILBOX_ID="${MAILBOX_ID:-mbx_demo}"
FROM_EMAIL="${FROM_EMAIL:-agent@mailagents.net}"
TO_EMAIL="${TO_EMAIL:-peer@mailagents.net}"
SEEDED_INBOUND_MESSAGE_ID="${SEEDED_INBOUND_MESSAGE_ID:-msg_demo_inbound}"
PREPARE_SMOKE_TENANT_POLICY="${PREPARE_SMOKE_TENANT_POLICY:-1}"
TEMP_FILES=()
LAST_HEADERS=""
LAST_BODY=""
LAST_STATUS=""
CURL_BASE_ARGS=()
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

capture_request() {
  local method="$1"
  local path="$2"
  local data="$3"
  shift 3

  LAST_HEADERS="$("$MKTEMP_BIN" -t mailagents-mcp-headers.XXXXXX)"
  LAST_BODY="$("$MKTEMP_BIN" -t mailagents-mcp-body.XXXXXX)"
  TEMP_FILES+=("$LAST_HEADERS" "$LAST_BODY")

  local cmd=(
    curl
    -sS
    -o "$LAST_BODY"
    -D "$LAST_HEADERS"
    -w "%{http_code}"
    -X "$method"
    "$BASE_URL$path"
  )

  while [[ "$#" -gt 0 ]]; do
    cmd+=(-H "$1")
    shift
  done

  if [[ -n "$data" ]]; then
    cmd+=(-H "content-type: application/json" --data "$data")
  fi

  LAST_STATUS="$("${cmd[@]}")"
}

assert_status() {
  local expected="$1"
  if [[ "$LAST_STATUS" != "$expected" ]]; then
    echo "Expected HTTP $expected but received $LAST_STATUS" >&2
    cat "$LAST_BODY" >&2
    exit 1
  fi
}

assert_empty_body() {
  if [[ -s "$LAST_BODY" ]]; then
    echo "Expected empty response body" >&2
    cat "$LAST_BODY" >&2
    exit 1
  fi
}

header_value() {
  local header_name="$1"
  grep -i "^${header_name}:" "$LAST_HEADERS" \
    | head -n 1 \
    | sed -E 's/^[^:]+:[[:space:]]*//; s/\r$//'
}

assert_header_contains() {
  local header_name="$1"
  local expected_fragment="$2"
  local actual
  actual="$(header_value "$header_name")"
  if [[ "$actual" != *"$expected_fragment"* ]]; then
    echo "Expected header $header_name to contain: $expected_fragment" >&2
    cat "$LAST_HEADERS" >&2
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

prepare_curl_base_args() {
  local host_port
  local host
  local port
  local ip

  if [[ "$BASE_URL" == http://127.0.0.1:* || "$BASE_URL" == http://localhost:* || "$BASE_URL" == https://127.0.0.1:* || "$BASE_URL" == https://localhost:* ]]; then
    return
  fi

  host_port="${BASE_URL#*://}"
  host_port="${host_port%%/*}"
  host="${host_port%%:*}"
  port="${host_port#*:}"
  if [[ "$host" == "$host_port" ]]; then
    if [[ "$BASE_URL" == https://* ]]; then
      port=443
    else
      port=80
    fi
  fi

  if command -v dig >/dev/null 2>&1; then
    ip="$( { dig +short "$host" 2>/dev/null || true; } | awk 'NF { print; exit }' )"
    if [[ -n "$ip" ]]; then
      CURL_BASE_ARGS=(--resolve "${host}:${port}:${ip}")
    fi
  fi
}

curl() {
  command curl "${CURL_BASE_ARGS[@]}" "$@"
}

read_dev_var() {
  local key="$1"
  local dev_vars="$REPO_ROOT/.dev.vars"
  if [[ ! -f "$dev_vars" ]]; then
    return 1
  fi

  awk -F= -v key="$key" '$1 == key { print substr($0, length($1) + 2); exit }' "$dev_vars"
}

load_local_secrets() {
  if [[ "$ADMIN_SECRET" == "replace-with-admin-api-secret" ]]; then
    ADMIN_SECRET="$(read_dev_var "ADMIN_API_SECRET" || true)"
    ADMIN_SECRET="${ADMIN_SECRET:-replace-with-admin-api-secret}"
  fi
}

wait_for_server() {
  local attempt
  local connect_timeout=1
  local max_time=2

  if [[ "$BASE_URL" != http://127.0.0.1:* && "$BASE_URL" != http://localhost:* && "$BASE_URL" != https://127.0.0.1:* && "$BASE_URL" != https://localhost:* ]]; then
    connect_timeout=5
    max_time=10
  fi

  echo "Waiting for smoke target at $BASE_URL ..."
  for attempt in $(seq 1 20); do
    if curl --connect-timeout "$connect_timeout" --max-time "$max_time" -sS -o /dev/null "$BASE_URL/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "Smoke target is not reachable at $BASE_URL. Start the worker first, for example with: npm run dev:local" >&2
  exit 1
}

ensure_demo_tenant_send_policy() {
  if [[ "$PREPARE_SMOKE_TENANT_POLICY" != "1" || "$TENANT_ID" != "t_demo" ]]; then
    return
  fi

  local current_policy
  local pricing_tier
  local outbound_status

  current_policy="$(curl -sS "$BASE_URL/admin/mcp" \
    -H 'content-type: application/json' \
    -H "x-admin-secret: $ADMIN_SECRET" \
    -d "{
      \"jsonrpc\": \"2.0\",
      \"id\": 1.96,
      \"method\": \"tools/call\",
      \"params\": {
        \"name\": \"get_tenant_send_policy\",
        \"arguments\": {
          \"tenantId\": \"$TENANT_ID\"
        }
      }
    }")"

  pricing_tier="$(echo "$current_policy" | jq -r '.result.structuredContent.pricingTier // empty')"
  outbound_status="$(echo "$current_policy" | jq -r '.result.structuredContent.outboundStatus // empty')"

  if [[ "$pricing_tier" == "paid_active" && "$outbound_status" == "external_enabled" ]]; then
    return
  fi

  echo "Preparing demo tenant outbound policy for smoke..."
  curl -sS "$BASE_URL/admin/mcp" \
    -H 'content-type: application/json' \
    -H "x-admin-secret: $ADMIN_SECRET" \
    -d "{
      \"jsonrpc\": \"2.0\",
      \"id\": 1.965,
      \"method\": \"tools/call\",
      \"params\": {
        \"name\": \"apply_tenant_send_policy_review\",
        \"arguments\": {
          \"tenantId\": \"$TENANT_ID\",
          \"decision\": \"approve_external\"
        }
      }
    }" | jq -e '
      .result.structuredContent.sendPolicy.pricingTier == "paid_active" and
      .result.structuredContent.sendPolicy.outboundStatus == "external_enabled" and
      .result.structuredContent.sendPolicy.externalSendEnabled == true and
      .result.structuredContent.sendPolicy.reviewRequired == false and
      .result.structuredContent.account.pricingTier == "paid_active"
    ' >/dev/null
}

load_local_secrets
prepare_curl_base_args
wait_for_server

if [[ "$ADMIN_SECRET" == "replace-with-admin-api-secret" ]]; then
  echo "Missing admin secret. Set ADMIN_API_SECRET_FOR_SMOKE or configure ADMIN_API_SECRET in .dev.vars." >&2
  exit 1
fi

echo "Minting tenant control-plane token for MCP smoke..."
TOKEN="$(curl -sS -X POST "$BASE_URL/v1/auth/tokens" \
  -H 'content-type: application/json' \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d "{
    \"sub\": \"mcp-smoke\",
    \"tenantId\": \"$TENANT_ID\",
    \"scopes\": [
      \"agent:create\",
      \"agent:bind\",
      \"agent:update\",
      \"mail:read\",
      \"mail:replay\",
      \"task:read\",
      \"draft:create\",
      \"draft:read\",
      \"draft:send\"
    ],
    \"expiresInSeconds\": 3600
  }" | jq -r '.token')"

if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "Failed to mint token" >&2
  exit 1
fi

echo "Checking MCP transport OPTIONS response..."
capture_request "OPTIONS" "/mcp" ""
assert_status 204
assert_empty_body
assert_header_contains "allow" "GET, POST, OPTIONS"
assert_header_contains "access-control-allow-methods" "GET, POST, OPTIONS"
assert_header_contains "access-control-allow-headers" "authorization"

echo "Checking admin MCP transport OPTIONS response..."
capture_request "OPTIONS" "/admin/mcp" ""
assert_status 204
assert_empty_body
assert_header_contains "allow" "GET, POST, OPTIONS"
assert_header_contains "access-control-allow-methods" "GET, POST, OPTIONS"
assert_header_contains "access-control-allow-headers" "x-admin-secret"

echo "Checking MCP transport GET placeholder..."
capture_request "GET" "/mcp" ""
assert_status 405
assert_empty_body
assert_header_contains "allow" "GET, POST, OPTIONS"

echo "Checking admin MCP transport GET placeholder..."
capture_request "GET" "/admin/mcp" ""
assert_status 405
assert_empty_body
assert_header_contains "allow" "GET, POST, OPTIONS"

echo "Checking MCP transport rejects cross-origin browser requests..."
capture_request "POST" "/mcp" '{
  "jsonrpc": "2.0",
  "id": 0.25,
  "method": "initialize",
  "params": {}
}' "Origin: https://example.com"
assert_status 403
jq -e '.error == "Origin not allowed"' "$LAST_BODY" >/dev/null

echo "Checking admin MCP transport rejects cross-origin browser requests..."
capture_request "POST" "/admin/mcp" '{
  "jsonrpc": "2.0",
  "id": 0.26,
  "method": "initialize",
  "params": {}
}' "Origin: https://example.com" "x-admin-secret: $ADMIN_SECRET"
assert_status 403
jq -e '.error == "Origin not allowed"' "$LAST_BODY" >/dev/null

echo "Checking MCP transport accepts same-origin browser requests..."
capture_request "POST" "/mcp" '{
  "jsonrpc": "2.0",
  "id": 0.27,
  "method": "initialize",
  "params": {}
}' "Origin: $BASE_ORIGIN"
assert_status 200
assert_header_contains "access-control-allow-origin" "$BASE_ORIGIN"
jq -e '.result.serverInfo.name == "mailagents-runtime"' "$LAST_BODY" >/dev/null

echo "Checking admin MCP transport accepts same-origin browser requests..."
capture_request "POST" "/admin/mcp" '{
  "jsonrpc": "2.0",
  "id": 0.28,
  "method": "initialize",
  "params": {}
}' "Origin: $BASE_ORIGIN" "x-admin-secret: $ADMIN_SECRET"
assert_status 200
assert_header_contains "access-control-allow-origin" "$BASE_ORIGIN"
jq -e '.result.serverInfo.name == "mailagents-runtime"' "$LAST_BODY" >/dev/null

echo "Checking MCP JSON-RPC notifications return 202 without a body..."
capture_request "POST" "/mcp" '{
  "jsonrpc": "2.0",
  "method": "initialize",
  "params": {}
}' "accept: application/json, text/event-stream"
assert_status 202
assert_empty_body

echo "Checking admin MCP JSON-RPC notifications return 202 without a body..."
capture_request "POST" "/admin/mcp" '{
  "jsonrpc": "2.0",
  "method": "initialize",
  "params": {}
}' "accept: application/json, text/event-stream" "x-admin-secret: $ADMIN_SECRET"
assert_status 202
assert_empty_body

echo "Checking MCP batch requests..."
capture_request "POST" "/mcp" '[
  {
    "jsonrpc": "2.0",
    "id": "batch-init",
    "method": "initialize",
    "params": {}
  },
  {
    "jsonrpc": "2.0",
    "id": "batch-list",
    "method": "tools/list",
    "params": {}
  }
]' "accept: application/json, text/event-stream" "authorization: Bearer $TOKEN"
assert_status 200
jq -e '
  type == "array" and
  length == 2 and
  any(.id == "batch-init" and .result.serverInfo.name == "mailagents-runtime") and
  any(.id == "batch-list" and (.result.tools | any(.name == "create_agent")))
' "$LAST_BODY" >/dev/null

echo "Checking MCP empty batch rejection..."
capture_request "POST" "/mcp" '[]'
assert_status 400
jq -e '.error.code == -32600 and .error.message == "Invalid Request"' "$LAST_BODY" >/dev/null

echo "Checking MCP parse error handling..."
capture_request "POST" "/mcp" '{"jsonrpc":"2.0","id":"bad-json","method":"initialize","params":'
assert_status 400
jq -e '.error.code == -32700 and .error.message == "Parse error"' "$LAST_BODY" >/dev/null

echo "Checking MCP ignores posted JSON-RPC responses..."
capture_request "POST" "/mcp" '{
  "jsonrpc": "2.0",
  "id": "client-response",
  "result": {
    "ok": true
  }
}' "accept: application/json, text/event-stream"
assert_status 202
assert_empty_body

echo "Checking admin MCP batch requests..."
capture_request "POST" "/admin/mcp" '[
  {
    "jsonrpc": "2.0",
    "id": "admin-batch-init",
    "method": "initialize",
    "params": {}
  },
  {
    "jsonrpc": "2.0",
    "id": "admin-batch-list",
    "method": "tools/list",
    "params": {}
  }
]' "accept: application/json, text/event-stream" "x-admin-secret: $ADMIN_SECRET"
assert_status 200
jq -e '
  type == "array" and
  length == 2 and
  any(.id == "admin-batch-init" and .result.serverInfo.name == "mailagents-runtime") and
  any(.id == "admin-batch-list" and (.result.tools | any(.name == "create_access_token")))
' "$LAST_BODY" >/dev/null

echo "Checking admin MCP empty batch rejection..."
capture_request "POST" "/admin/mcp" '[]' "x-admin-secret: $ADMIN_SECRET"
assert_status 400
jq -e '.error.code == -32600 and .error.message == "Invalid Request"' "$LAST_BODY" >/dev/null

echo "Checking admin MCP parse error handling..."
capture_request "POST" "/admin/mcp" '{"jsonrpc":"2.0","id":"admin-bad-json","method":"initialize","params":' "x-admin-secret: $ADMIN_SECRET"
assert_status 400
jq -e '.error.code == -32700 and .error.message == "Parse error"' "$LAST_BODY" >/dev/null

echo "Checking admin MCP ignores posted JSON-RPC responses..."
capture_request "POST" "/admin/mcp" '{
  "jsonrpc": "2.0",
  "id": "admin-client-response",
  "result": {
    "ok": true
  }
}' "accept: application/json, text/event-stream" "x-admin-secret: $ADMIN_SECRET"
assert_status 202
assert_empty_body

echo "Checking top-level MCP auth error shape..."
curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 0.5,
    "method": "tools/list",
    "params": {}
  }' | jq -e '.error.message == "Unauthorized" and .error.data.errorCode == "auth_unauthorized"' >/dev/null

echo "Checking top-level admin MCP auth error shape..."
curl -sS "$BASE_URL/admin/mcp" \
  -H 'content-type: application/json' \
  -H 'x-admin-secret: invalid-secret' \
  -d '{
    "jsonrpc": "2.0",
    "id": 0.75,
    "method": "initialize",
    "params": {}
  }' | jq -e '.error.message == "Admin secret required" and .error.data.errorCode == "auth_unauthorized"' >/dev/null

echo "Initializing MCP endpoint..."
curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {}
  }' | jq -e '.result.serverInfo.name == "mailagents-runtime" and .result.meta.api.metaRuntimePath == "/v2/meta/runtime" and .result.meta.api.compatibilityPath == "/v2/meta/compatibility" and (.result.meta.mcp.tools | any(.name == "send_draft" and .riskLevel == "high_risk" and .humanReviewRequired == true)) and (.result.meta.mcp.tools | any(.name == "reply_to_inbound_email" and .supportsPartialAuthorization == true and (.sendAdditionalScopes | index("draft:send"))))' >/dev/null

echo "Checking runtime metadata endpoint..."
curl -sS "$BASE_URL/v2/meta/runtime" \
  | jq -e '.server.name == "mailagents-runtime" and (.mcp.tools | any(.name == "reply_to_inbound_email")) and .api.metaRuntimePath == "/v2/meta/runtime" and .api.compatibilityPath == "/v2/meta/compatibility" and .api.compatibilitySchemaPath == "/v2/meta/compatibility/schema" and .api.adminMcpPath == "/admin/mcp"' >/dev/null

echo "Initializing admin MCP endpoint..."
curl -sS "$BASE_URL/admin/mcp" \
  -H 'content-type: application/json' \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1.5,
    "method": "initialize",
    "params": {}
  }' | jq -e '.result.serverInfo.name == "mailagents-runtime" and .result.meta.api.adminMcpPath == "/admin/mcp" and .result.meta.adminMcp.path == "/admin/mcp" and (.result.meta.adminMcp.tools | any(.name == "create_access_token")) and (.result.meta.adminMcp.workflows | any(.name == "bootstrap_mailbox_agent" and .goal != null and (.recommendedToolSequence | index("bootstrap_mailbox_agent_token")) and (.categories | index("token_admin")) and (.stopConditions | length) >= 1))' >/dev/null

echo "Listing admin MCP tools..."
curl -sS "$BASE_URL/admin/mcp" \
  -H 'content-type: application/json' \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1.75,
    "method": "tools/list",
    "params": {}
  }' | jq -e '.result.tools | any(.name == "get_debug_message" and .annotations.category == "debug") and any(.name == "create_access_token" and .annotations.category == "token_admin") and any(.name == "bootstrap_mailbox_agent_token") and any(.name == "get_tenant_review_context") and any(.name == "inspect_delivery_case")' >/dev/null

echo "Minting token through admin MCP..."
curl -sS "$BASE_URL/admin/mcp" \
  -H 'content-type: application/json' \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 1.9,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"create_access_token\",
      \"arguments\": {
        \"sub\": \"admin-mcp-smoke\",
        \"tenantId\": \"$TENANT_ID\",
        \"scopes\": [\"mail:read\"],
        \"mailboxIds\": [\"$MAILBOX_ID\"],
        \"expiresInSeconds\": 600
      }
    }
  }" | jq -e '.result.structuredContent.token | type == "string"' >/dev/null

echo "Bootstrapping mailbox-agent token through admin MCP..."
curl -sS "$BASE_URL/admin/mcp" \
  -H 'content-type: application/json' \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 1.95,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"bootstrap_mailbox_agent_token\",
      \"arguments\": {
        \"tenantId\": \"$TENANT_ID\",
        \"mailboxId\": \"$MAILBOX_ID\",
        \"mode\": \"send\"
      }
    }
  }" | jq -e '.result.isError == true and .result.structuredContent.error.code == "invalid_arguments" and .result.structuredContent.error.message == "agentId is required for draft_only and send mailbox bootstrap tokens"' >/dev/null

echo "Fetching tenant review context through admin MCP..."
curl -sS "$BASE_URL/admin/mcp" \
  -H 'content-type: application/json' \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 1.97,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"get_tenant_review_context\",
      \"arguments\": {
        \"tenantId\": \"$TENANT_ID\",
        \"receiptsLimit\": 5
      }
    }
  }" | jq -e --arg tenant "$TENANT_ID" '.result.structuredContent.tenantId == $tenant and (.result.structuredContent.summary.suggestedActions | type == "array")' >/dev/null

ensure_demo_tenant_send_policy

echo "Inspecting seeded delivery case through admin MCP..."
curl -sS "$BASE_URL/admin/mcp" \
  -H 'content-type: application/json' \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 1.98,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"inspect_delivery_case\",
      \"arguments\": {
        \"messageId\": \"$SEEDED_INBOUND_MESSAGE_ID\"
      }
    }
  }" | jq -e --arg message "$SEEDED_INBOUND_MESSAGE_ID" '.result.structuredContent.lookup.type == "message" and .result.structuredContent.message.id == $message' >/dev/null

echo "Checking compatibility contract endpoint..."
curl -sS "$BASE_URL/v2/meta/compatibility" \
  | jq -e '.contract.name == "mailagents-agent-compatibility" and .contract.version == "2026-03-17" and .contract.changelogPath == "/CHANGELOG.md" and .discovery.adminMcpPath == "/admin/mcp" and .admin.mcp.path == "/admin/mcp" and .admin.mcp.auth.header == "x-admin-secret" and (.admin.mcp.workflows | any(.name == "bootstrap_mailbox_agent" and .goal != null and (.categories | index("token_admin")) and (.recommendedToolSequence | index("bootstrap_mailbox_agent_token")))) and .evolution.deprecationPolicy.minimumNotice == "one compatibility version" and (.guarantees.stableErrorCodes | index("idempotency_conflict")) and (.guarantees.stableErrorCodes | index("route_disabled")) and (.errors | any(.code == "access_mailbox_denied" and .retryable == false))' >/dev/null

echo "Checking compatibility schema endpoint..."
curl -sS "$BASE_URL/v2/meta/compatibility/schema" \
  | jq -e '.title == "Mailagents Agent Compatibility Contract" and (.properties.discovery.properties.compatibilitySchemaPath.type == "string") and (.properties.errors.items.required | index("code"))' >/dev/null

echo "Listing scoped MCP tools..."
TOOLS_RESPONSE="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }')"
echo "$TOOLS_RESPONSE" | jq -e '.result.tools | any(.name == "create_agent")' >/dev/null
echo "$TOOLS_RESPONSE" | jq -e '.result.tools | any(.name == "list_messages" and .annotations.riskLevel == "read" and .annotations.sideEffecting == false)' >/dev/null
echo "$TOOLS_RESPONSE" | jq -e '.result.tools | any(.name == "get_message" and .annotations.riskLevel == "read" and .annotations.humanReviewRequired == false and .annotations.sideEffecting == false)' >/dev/null
echo "$TOOLS_RESPONSE" | jq -e '.result.tools | any(.name == "replay_message" and .annotations.riskLevel == "high_risk" and .annotations.humanReviewRequired == true and .annotations.sideEffecting == true)' >/dev/null
echo "$TOOLS_RESPONSE" | jq -e '.result.tools | any(.name == "bind_mailbox") | not' >/dev/null
echo "$TOOLS_RESPONSE" | jq -e '.result.tools | any(.name == "send_email") | not' >/dev/null
echo "$TOOLS_RESPONSE" | jq -e '.result.tools | any(.name == "reply_to_inbound_email") | not' >/dev/null

echo "Creating agent through MCP..."
CREATE_AGENT_RESPONSE="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 3,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"create_agent\",
      \"arguments\": {
        \"tenantId\": \"$TENANT_ID\",
        \"name\": \"MCP Smoke Agent\",
        \"mode\": \"assistant\",
        \"config\": {
          \"systemPrompt\": \"You are the MCP smoke test agent.\"
        }
      }
    }
  }")"
AGENT_ID="$(echo "$CREATE_AGENT_RESPONSE" | jq -r '.result.structuredContent.id')"
if [[ -z "$AGENT_ID" || "$AGENT_ID" == "null" ]]; then
  echo "Failed to create agent through MCP" >&2
  echo "$CREATE_AGENT_RESPONSE" >&2
  exit 1
fi

echo "Minting agent-bound control-plane token for MCP smoke..."
AGENT_CONTROL_TOKEN="$(curl -sS -X POST "$BASE_URL/v1/auth/tokens" \
  -H 'content-type: application/json' \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d "{
    \"sub\": \"mcp-smoke-agent-control\",
    \"tenantId\": \"$TENANT_ID\",
    \"agentId\": \"$AGENT_ID\",
    \"scopes\": [
      \"agent:bind\",
      \"mail:read\",
      \"mail:replay\",
      \"task:read\",
      \"draft:create\",
      \"draft:read\",
      \"draft:send\"
    ],
    \"expiresInSeconds\": 3600
  }" | jq -r '.token')"

if [[ -z "$AGENT_CONTROL_TOKEN" || "$AGENT_CONTROL_TOKEN" == "null" ]]; then
  echo "Failed to mint agent-bound control-plane token" >&2
  exit 1
fi

echo "Checking mailbox validation through MCP..."
INVALID_BIND_RESPONSE="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_CONTROL_TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 31,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"bind_mailbox\",
      \"arguments\": {
        \"agentId\": \"$AGENT_ID\",
        \"tenantId\": \"$TENANT_ID\",
        \"mailboxId\": \"mbx_missing_for_mcp_smoke\",
        \"role\": \"primary\"
      }
    }
  }")"
# Depending on token mailbox scope, the runtime may reject the request at the
# auth layer before it reaches mailbox existence validation.
echo "$INVALID_BIND_RESPONSE" | jq -e '
  .result.isError == true and
  (
    .result.structuredContent.error.code == "resource_mailbox_not_found" or
    .result.structuredContent.error.code == "access_mailbox_denied"
  )
' >/dev/null

echo "Binding mailbox through MCP..."
curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_CONTROL_TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 4,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"bind_mailbox\",
      \"arguments\": {
        \"agentId\": \"$AGENT_ID\",
        \"tenantId\": \"$TENANT_ID\",
        \"mailboxId\": \"$MAILBOX_ID\",
        \"role\": \"primary\"
      }
    }
  }" | jq -e --arg mailbox "$MAILBOX_ID" '.result.structuredContent.mailboxId == $mailbox' >/dev/null

echo "Minting mailbox-scoped agent token for high-level MCP tools..."
AGENT_TOKEN="$(curl -sS -X POST "$BASE_URL/v1/auth/tokens" \
  -H 'content-type: application/json' \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d "{
    \"sub\": \"mcp-smoke-agent\",
    \"tenantId\": \"$TENANT_ID\",
    \"agentId\": \"$AGENT_ID\",
    \"scopes\": [
      \"mail:read\",
      \"task:read\",
      \"draft:create\",
      \"draft:read\",
      \"draft:send\"
    ],
    \"mailboxIds\": [\"$MAILBOX_ID\"],
    \"expiresInSeconds\": 3600
  }" | jq -r '.token')"

if [[ -z "$AGENT_TOKEN" || "$AGENT_TOKEN" == "null" ]]; then
  echo "Failed to mint mailbox-scoped agent token" >&2
  exit 1
fi

echo "Listing messages through MCP high-level mailbox tool..."
LIST_MESSAGES_RESPONSE="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 4.25,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"list_messages\",
      \"arguments\": {
        \"limit\": 5,
        \"direction\": \"inbound\"
      }
    }
  }")"
echo "$LIST_MESSAGES_RESPONSE" | jq -e --arg mailbox "$MAILBOX_ID" '.result.structuredContent.mailbox.id == $mailbox and (.result.structuredContent.items | type == "array")' >/dev/null

echo "Creating a draft through MCP..."
CREATE_DRAFT_RESPONSE="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_CONTROL_TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 5,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"create_draft\",
      \"arguments\": {
        \"agentId\": \"$AGENT_ID\",
        \"tenantId\": \"$TENANT_ID\",
        \"mailboxId\": \"$MAILBOX_ID\",
        \"from\": \"$FROM_EMAIL\",
        \"to\": [\"$TO_EMAIL\"],
        \"subject\": \"MCP smoke draft\",
        \"text\": \"Created via MCP smoke.\"
      }
    }
  }")"
DRAFT_ID="$(echo "$CREATE_DRAFT_RESPONSE" | jq -r '.result.structuredContent.id')"
if [[ -z "$DRAFT_ID" || "$DRAFT_ID" == "null" ]]; then
  echo "Failed to create draft through MCP" >&2
  echo "$CREATE_DRAFT_RESPONSE" >&2
  exit 1
fi

echo "Creating and cancelling a disposable draft through mailbox-scoped MCP..."
CANCEL_DRAFT_RESPONSE="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 5.1,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"create_draft\",
      \"arguments\": {
        \"to\": [\"$TO_EMAIL\"],
        \"subject\": \"MCP disposable draft\",
        \"text\": \"Disposable draft for cancel_draft smoke.\"
      }
    }
  }")"
CANCEL_DRAFT_ID="$(echo "$CANCEL_DRAFT_RESPONSE" | jq -r '.result.structuredContent.id')"
if [[ -z "$CANCEL_DRAFT_ID" || "$CANCEL_DRAFT_ID" == "null" ]]; then
  echo "Failed to create disposable draft through mailbox-scoped MCP" >&2
  echo "$CANCEL_DRAFT_RESPONSE" >&2
  exit 1
fi

CANCEL_RESPONSE="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 5.15,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"cancel_draft\",
      \"arguments\": {
        \"draftId\": \"$CANCEL_DRAFT_ID\"
      }
    }
  }")"
echo "$CANCEL_RESPONSE" | jq -e --arg draft "$CANCEL_DRAFT_ID" '
  .result.structuredContent.ok == true and
  .result.structuredContent.id == $draft and
  .result.structuredContent.status == "cancelled"
' >/dev/null

echo "Sending email through MCP high-level send tool..."
SEND_EMAIL_IDEMPOTENCY_KEY="mcp-send-email-$AGENT_ID"
SEND_EMAIL_RESPONSE="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 5.25,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"send_email\",
      \"arguments\": {
        \"to\": [\"$TO_EMAIL\"],
        \"subject\": \"MCP high-level send\",
        \"text\": \"Sent through the high-level send_email MCP tool.\",
        \"idempotencyKey\": \"$SEND_EMAIL_IDEMPOTENCY_KEY\"
      }
    }
  }")"
SEND_EMAIL_DRAFT_ID="$(echo "$SEND_EMAIL_RESPONSE" | jq -r '.result.structuredContent.draft.id')"
SEND_EMAIL_OUTBOUND_JOB_ID="$(echo "$SEND_EMAIL_RESPONSE" | jq -r '.result.structuredContent.outboundJobId')"
echo "$SEND_EMAIL_RESPONSE" | jq -e '.result.structuredContent.status == "queued"' >/dev/null
if [[ -z "$SEND_EMAIL_DRAFT_ID" || "$SEND_EMAIL_DRAFT_ID" == "null" || -z "$SEND_EMAIL_OUTBOUND_JOB_ID" || "$SEND_EMAIL_OUTBOUND_JOB_ID" == "null" ]]; then
  echo "High-level MCP send_email did not return a draft and outbound job" >&2
  echo "$SEND_EMAIL_RESPONSE" >&2
  exit 1
fi

echo "Checking send_email idempotency through MCP..."
SEND_EMAIL_REPEAT="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 5.5,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"send_email\",
      \"arguments\": {
        \"to\": [\"$TO_EMAIL\"],
        \"subject\": \"MCP high-level send\",
        \"text\": \"Sent through the high-level send_email MCP tool.\",
        \"idempotencyKey\": \"$SEND_EMAIL_IDEMPOTENCY_KEY\"
      }
    }
  }")"
echo "$SEND_EMAIL_REPEAT" | jq -e --arg draft "$SEND_EMAIL_DRAFT_ID" --arg outbound "$SEND_EMAIL_OUTBOUND_JOB_ID" '
  .result.structuredContent.draft.id == $draft and
  .result.structuredContent.outboundJobId == $outbound and
  .result.structuredContent.status == "queued"
' >/dev/null

echo "Sending the draft idempotently through MCP..."
SEND_IDEMPOTENCY_KEY="mcp-smoke-send-$DRAFT_ID"
SEND_RESPONSE="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_CONTROL_TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 6,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"send_draft\",
      \"arguments\": {
        \"draftId\": \"$DRAFT_ID\",
        \"idempotencyKey\": \"$SEND_IDEMPOTENCY_KEY\"
      }
    }
  }")"
OUTBOUND_JOB_ID="$(echo "$SEND_RESPONSE" | jq -r '.result.structuredContent.outboundJobId')"
echo "$SEND_RESPONSE" | jq -e '.result.structuredContent.status == "queued"' >/dev/null

SEND_RESPONSE_REPEAT="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_CONTROL_TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 7,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"send_draft\",
      \"arguments\": {
        \"draftId\": \"$DRAFT_ID\",
        \"idempotencyKey\": \"$SEND_IDEMPOTENCY_KEY\"
      }
    }
  }")"
echo "$SEND_RESPONSE_REPEAT" | jq -e --arg outbound "$OUTBOUND_JOB_ID" '.result.structuredContent.outboundJobId == $outbound' >/dev/null

echo "Checking composite reply workflow success path through MCP..."
REPLY_WORKFLOW_IDEMPOTENCY_KEY="mcp-smoke-reply-$AGENT_ID"
REPLY_WORKFLOW_RESPONSE="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_CONTROL_TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 8,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"reply_to_inbound_email\",
      \"arguments\": {
        \"agentId\": \"$AGENT_ID\",
        \"messageId\": \"$SEEDED_INBOUND_MESSAGE_ID\",
        \"replyText\": \"Thanks from the composite MCP workflow.\",
        \"send\": true,
        \"idempotencyKey\": \"$REPLY_WORKFLOW_IDEMPOTENCY_KEY\"
      }
    }
  }")"
REPLY_DRAFT_ID="$(echo "$REPLY_WORKFLOW_RESPONSE" | jq -r '.result.structuredContent.draft.id')"
REPLY_OUTBOUND_JOB_ID="$(echo "$REPLY_WORKFLOW_RESPONSE" | jq -r '.result.structuredContent.sendResult.outboundJobId')"
echo "$REPLY_WORKFLOW_RESPONSE" | jq -e --arg message "$SEEDED_INBOUND_MESSAGE_ID" '
  .result.structuredContent.sourceMessage.id == $message and
  .result.structuredContent.sendResult.status == "queued" and
  (.result.structuredContent.usedThreadContext == true or .result.structuredContent.usedThreadContext == false)
' >/dev/null
if [[ -z "$REPLY_DRAFT_ID" || "$REPLY_DRAFT_ID" == "null" || -z "$REPLY_OUTBOUND_JOB_ID" || "$REPLY_OUTBOUND_JOB_ID" == "null" ]]; then
  echo "Composite reply workflow did not return a draft and outbound job" >&2
  echo "$REPLY_WORKFLOW_RESPONSE" >&2
  exit 1
fi

echo "Checking composite reply workflow idempotency through MCP..."
REPLY_WORKFLOW_REPEAT="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_CONTROL_TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 81,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"reply_to_inbound_email\",
      \"arguments\": {
        \"agentId\": \"$AGENT_ID\",
        \"messageId\": \"$SEEDED_INBOUND_MESSAGE_ID\",
        \"replyText\": \"Thanks from the composite MCP workflow.\",
        \"send\": true,
        \"idempotencyKey\": \"$REPLY_WORKFLOW_IDEMPOTENCY_KEY\"
      }
    }
  }")"
echo "$REPLY_WORKFLOW_REPEAT" | jq -e --arg draft "$REPLY_DRAFT_ID" --arg outbound "$REPLY_OUTBOUND_JOB_ID" '
  .result.structuredContent.draft.id == $draft and
  .result.structuredContent.sendResult.outboundJobId == $outbound and
  .result.structuredContent.sendResult.status == "queued"
' >/dev/null

echo "Checking operator manual send composite tool through MCP..."
MANUAL_SEND_IDEMPOTENCY_KEY="mcp-manual-send-$AGENT_ID"
MANUAL_SEND_RESPONSE="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_CONTROL_TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 83,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"operator_manual_send\",
      \"arguments\": {
        \"agentId\": \"$AGENT_ID\",
        \"tenantId\": \"$TENANT_ID\",
        \"mailboxId\": \"$MAILBOX_ID\",
        \"from\": \"$FROM_EMAIL\",
        \"to\": [\"$TO_EMAIL\"],
        \"subject\": \"Operator manual send\",
        \"text\": \"Sent through the composite operator flow.\",
        \"send\": true,
        \"idempotencyKey\": \"$MANUAL_SEND_IDEMPOTENCY_KEY\"
      }
    }
  }")"
MANUAL_SEND_DRAFT_ID="$(echo "$MANUAL_SEND_RESPONSE" | jq -r '.result.structuredContent.draft.id')"
MANUAL_SEND_OUTBOUND_JOB_ID="$(echo "$MANUAL_SEND_RESPONSE" | jq -r '.result.structuredContent.sendResult.outboundJobId')"
echo "$MANUAL_SEND_RESPONSE" | jq -e '.result.structuredContent.sendRequested == true and .result.structuredContent.sendResult.status == "queued"' >/dev/null
if [[ -z "$MANUAL_SEND_DRAFT_ID" || "$MANUAL_SEND_DRAFT_ID" == "null" || -z "$MANUAL_SEND_OUTBOUND_JOB_ID" || "$MANUAL_SEND_OUTBOUND_JOB_ID" == "null" ]]; then
  echo "Composite operator manual send did not return a draft and outbound job" >&2
  echo "$MANUAL_SEND_RESPONSE" >&2
  exit 1
fi

echo "Checking operator manual send idempotency through MCP..."
MANUAL_SEND_REPEAT="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_CONTROL_TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 84,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"operator_manual_send\",
      \"arguments\": {
        \"agentId\": \"$AGENT_ID\",
        \"tenantId\": \"$TENANT_ID\",
        \"mailboxId\": \"$MAILBOX_ID\",
        \"from\": \"$FROM_EMAIL\",
        \"to\": [\"$TO_EMAIL\"],
        \"subject\": \"Operator manual send\",
        \"text\": \"Sent through the composite operator flow.\",
        \"send\": true,
        \"idempotencyKey\": \"$MANUAL_SEND_IDEMPOTENCY_KEY\"
      }
    }
  }")"
echo "$MANUAL_SEND_REPEAT" | jq -e --arg draft "$MANUAL_SEND_DRAFT_ID" --arg outbound "$MANUAL_SEND_OUTBOUND_JOB_ID" '
  .result.structuredContent.draft.id == $draft and
  .result.structuredContent.sendResult.outboundJobId == $outbound and
  .result.structuredContent.sendRequested == true
' >/dev/null

echo "Checking composite reply workflow error path through MCP..."
REPLY_WORKFLOW_ERROR_RESPONSE="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_CONTROL_TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 82,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"reply_to_inbound_email\",
      \"arguments\": {
        \"agentId\": \"$AGENT_ID\",
        \"messageId\": \"msg_missing_for_reply_smoke\",
        \"replyText\": \"Thanks from the composite MCP workflow.\"
      }
    }
  }")"
echo "$REPLY_WORKFLOW_ERROR_RESPONSE" | jq -e '.result.isError == true and .result.structuredContent.error.code == "resource_message_not_found"' >/dev/null

echo "Checking reply_to_message high-level MCP tool..."
REPLY_TO_MESSAGE_KEY="mcp-reply-message-$AGENT_ID"
REPLY_TO_MESSAGE_RESPONSE="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 8.5,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"reply_to_message\",
      \"arguments\": {
        \"messageId\": \"$SEEDED_INBOUND_MESSAGE_ID\",
        \"text\": \"Thanks from reply_to_message.\",
        \"idempotencyKey\": \"$REPLY_TO_MESSAGE_KEY\"
      }
    }
  }")"
REPLY_TO_MESSAGE_DRAFT_ID="$(echo "$REPLY_TO_MESSAGE_RESPONSE" | jq -r '.result.structuredContent.draft.id')"
REPLY_TO_MESSAGE_OUTBOUND_JOB_ID="$(echo "$REPLY_TO_MESSAGE_RESPONSE" | jq -r '.result.structuredContent.outboundJobId')"
echo "$REPLY_TO_MESSAGE_RESPONSE" | jq -e --arg message "$SEEDED_INBOUND_MESSAGE_ID" '
  .result.structuredContent.sourceMessageId == $message and
  .result.structuredContent.status == "queued"
' >/dev/null
if [[ -z "$REPLY_TO_MESSAGE_DRAFT_ID" || "$REPLY_TO_MESSAGE_DRAFT_ID" == "null" || -z "$REPLY_TO_MESSAGE_OUTBOUND_JOB_ID" || "$REPLY_TO_MESSAGE_OUTBOUND_JOB_ID" == "null" ]]; then
  echo "High-level MCP reply_to_message did not return a draft and outbound job" >&2
  echo "$REPLY_TO_MESSAGE_RESPONSE" >&2
  exit 1
fi

echo "Checking reply_to_message idempotency through MCP..."
REPLY_TO_MESSAGE_REPEAT="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 8.6,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"reply_to_message\",
      \"arguments\": {
        \"messageId\": \"$SEEDED_INBOUND_MESSAGE_ID\",
        \"text\": \"Thanks from reply_to_message.\",
        \"idempotencyKey\": \"$REPLY_TO_MESSAGE_KEY\"
      }
    }
  }")"
echo "$REPLY_TO_MESSAGE_REPEAT" | jq -e --arg draft "$REPLY_TO_MESSAGE_DRAFT_ID" --arg outbound "$REPLY_TO_MESSAGE_OUTBOUND_JOB_ID" '
  .result.structuredContent.draft.id == $draft and
  .result.structuredContent.outboundJobId == $outbound and
  .result.structuredContent.status == "queued"
' >/dev/null

echo "Checking machine-readable MCP errors..."
ERROR_RESPONSE="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 9,
    "method": "tools/call",
    "params": {
      "name": "get_message",
      "arguments": {
        "messageId": "msg_does_not_exist"
      }
    }
  }')"
echo "$ERROR_RESPONSE" | jq -e '.result.isError == true and .result.structuredContent.error.code == "resource_message_not_found"' >/dev/null

echo "MCP smoke completed."
echo "Agent ID: $AGENT_ID"
echo "Draft ID: $DRAFT_ID"
echo "Outbound Job ID: $OUTBOUND_JOB_ID"
echo "send_email Draft ID: $SEND_EMAIL_DRAFT_ID"
echo "send_email Outbound Job ID: $SEND_EMAIL_OUTBOUND_JOB_ID"
echo "Reply Draft ID: $REPLY_DRAFT_ID"
echo "Reply Outbound Job ID: $REPLY_OUTBOUND_JOB_ID"
echo "reply_to_message Draft ID: $REPLY_TO_MESSAGE_DRAFT_ID"
echo "reply_to_message Outbound Job ID: $REPLY_TO_MESSAGE_OUTBOUND_JOB_ID"
echo "Manual Send Draft ID: $MANUAL_SEND_DRAFT_ID"
echo "Manual Send Outbound Job ID: $MANUAL_SEND_OUTBOUND_JOB_ID"
