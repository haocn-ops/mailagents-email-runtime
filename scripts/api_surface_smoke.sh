#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
ADMIN_SECRET="${ADMIN_API_SECRET_FOR_SMOKE:-replace-with-admin-api-secret}"
TENANT_ID="${TENANT_ID:-t_demo}"
MAILBOX_ID="${MAILBOX_ID:-mbx_demo}"
FROM_EMAIL="${FROM_EMAIL:-agent@mailagents.net}"
TO_EMAIL="${TO_EMAIL:-peer@mailagents.net}"
SEEDED_INBOUND_MESSAGE_ID="${SEEDED_INBOUND_MESSAGE_ID:-msg_demo_inbound}"
PREPARE_SMOKE_TENANT_POLICY="${PREPARE_SMOKE_TENANT_POLICY:-1}"
TEMP_FILES=()
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

track_temp_file() {
  TEMP_FILES+=("$1")
}

new_temp_file() {
  local file
  file="$("$MKTEMP_BIN" -t mailagents-api-smoke.XXXXXX)"
  track_temp_file "$file"
  printf '%s\n' "$file"
}

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

  echo "Waiting for API smoke target at $BASE_URL ..."
  for attempt in $(seq 1 20); do
    if curl --connect-timeout "$connect_timeout" --max-time "$max_time" -sS -o /dev/null "$BASE_URL/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "API smoke target is not reachable at $BASE_URL." >&2
  exit 1
}

mint_token() {
  local payload="$1"
  curl -sS -X POST "$BASE_URL/v1/auth/tokens" \
    -H 'content-type: application/json' \
    -H "x-admin-secret: $ADMIN_SECRET" \
    -d "$payload"
}

capture_status() {
  local output_file="$1"
  shift
  curl -sS -o "$output_file" -w "%{http_code}" "$@"
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
      \"id\": 96,
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

  echo "Preparing demo tenant outbound policy for API smoke..."
  curl -sS "$BASE_URL/admin/mcp" \
    -H 'content-type: application/json' \
    -H "x-admin-secret: $ADMIN_SECRET" \
    -d "{
      \"jsonrpc\": \"2.0\",
      \"id\": 97,
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
      .result.structuredContent.sendPolicy.outboundStatus == "external_enabled"
    ' >/dev/null
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

load_local_secrets
prepare_curl_base_args
wait_for_server

if [[ "$ADMIN_SECRET" == "replace-with-admin-api-secret" ]]; then
  echo "Missing admin secret. Set ADMIN_API_SECRET_FOR_SMOKE or configure ADMIN_API_SECRET in .dev.vars." >&2
  exit 1
fi

ensure_demo_tenant_send_policy

echo "Minting tenant-scoped control token..."
TENANT_TOKEN="$(mint_token "{
  \"sub\": \"api-smoke-tenant\",
  \"tenantId\": \"$TENANT_ID\",
  \"scopes\": [
    \"agent:create\",
    \"agent:read\",
    \"mail:read\",
    \"mail:replay\",
    \"task:read\",
    \"draft:create\",
    \"draft:read\",
    \"draft:send\"
  ],
  \"expiresInSeconds\": 3600
}" | jq -r '.token')"
if [[ -z "$TENANT_TOKEN" || "$TENANT_TOKEN" == "null" ]]; then
  echo "Failed to mint tenant-scoped token" >&2
  exit 1
fi

echo "Creating REST smoke agent..."
CREATE_AGENT_RESPONSE="$(curl -sS -X POST "$BASE_URL/v1/agents" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TENANT_TOKEN" \
  -d "{
    \"tenantId\": \"$TENANT_ID\",
    \"name\": \"API Smoke Agent $(date +%s)\",
    \"mode\": \"assistant\",
    \"config\": {
      \"systemPrompt\": \"You are the API smoke test agent.\"
    }
  }")"
AGENT_ID="$(echo "$CREATE_AGENT_RESPONSE" | jq -r '.id')"
if [[ -z "$AGENT_ID" || "$AGENT_ID" == "null" ]]; then
  echo "Failed to create REST smoke agent" >&2
  echo "$CREATE_AGENT_RESPONSE" >&2
  exit 1
fi

echo "Minting agent-bound control token..."
AGENT_CONTROL_TOKEN="$(mint_token "{
  \"sub\": \"api-smoke-agent-control\",
  \"tenantId\": \"$TENANT_ID\",
  \"agentId\": \"$AGENT_ID\",
  \"scopes\": [
    \"agent:read\",
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
  echo "Failed to mint agent-bound control token" >&2
  exit 1
fi

echo "Binding mailbox through REST..."
BIND_RESPONSE="$(curl -sS -X POST "$BASE_URL/v1/agents/$AGENT_ID/mailboxes" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_CONTROL_TOKEN" \
  -d "{
    \"tenantId\": \"$TENANT_ID\",
    \"mailboxId\": \"$MAILBOX_ID\",
    \"role\": \"primary\"
  }")"
echo "$BIND_RESPONSE" | jq -e --arg mailbox "$MAILBOX_ID" '.mailboxId == $mailbox' >/dev/null

echo "Minting mailbox-scoped agent token..."
AGENT_TOKEN="$(mint_token "{
  \"sub\": \"api-smoke-agent\",
  \"tenantId\": \"$TENANT_ID\",
  \"agentId\": \"$AGENT_ID\",
  \"scopes\": [
    \"agent:read\",
    \"mail:read\",
    \"mail:replay\",
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

echo "Checking mailbox-scoped self routes..."
SELF_MAILBOX="$(curl -sS "$BASE_URL/v1/mailboxes/self" -H "authorization: Bearer $AGENT_TOKEN")"
echo "$SELF_MAILBOX" | jq -e --arg mailbox "$MAILBOX_ID" --arg agent "$AGENT_ID" '
  .id == $mailbox and .agentId == $agent
' >/dev/null

MAILBOX_AGENT_LIST_BODY="$(new_temp_file)"
MAILBOX_AGENT_LIST_STATUS="$(capture_status "$MAILBOX_AGENT_LIST_BODY" "$BASE_URL/v1/agents" -H "authorization: Bearer $AGENT_TOKEN")"
[[ "$MAILBOX_AGENT_LIST_STATUS" == "403" ]]
jq -e '.error == "Mailbox-scoped tokens cannot list tenant agents"' "$MAILBOX_AGENT_LIST_BODY" >/dev/null

LIST_SELF_RESPONSE="$(curl -sS "$BASE_URL/v1/mailboxes/self/messages?limit=5&direction=inbound" -H "authorization: Bearer $AGENT_TOKEN")"
echo "$LIST_SELF_RESPONSE" | jq -e '.items | type == "array"' >/dev/null

MESSAGE_RESPONSE="$(curl -sS "$BASE_URL/v1/messages/$SEEDED_INBOUND_MESSAGE_ID" -H "authorization: Bearer $AGENT_TOKEN")"
THREAD_ID="$(echo "$MESSAGE_RESPONSE" | jq -r '.threadId')"
echo "$MESSAGE_RESPONSE" | jq -e --arg message "$SEEDED_INBOUND_MESSAGE_ID" '
  .id == $message and .direction == "inbound"
' >/dev/null
if [[ -z "$THREAD_ID" || "$THREAD_ID" == "null" ]]; then
  echo "Seeded inbound message is missing threadId" >&2
  exit 1
fi

SELF_MESSAGE_RESPONSE="$(curl -sS "$BASE_URL/v1/mailboxes/self/messages/$SEEDED_INBOUND_MESSAGE_ID" -H "authorization: Bearer $AGENT_TOKEN")"
echo "$SELF_MESSAGE_RESPONSE" | jq -e --arg message "$SEEDED_INBOUND_MESSAGE_ID" '.id == $message' >/dev/null

MESSAGE_CONTENT_RESPONSE="$(curl -sS "$BASE_URL/v1/messages/$SEEDED_INBOUND_MESSAGE_ID/content" -H "authorization: Bearer $AGENT_TOKEN")"
echo "$MESSAGE_CONTENT_RESPONSE" | jq -e 'has("text") or has("html") or has("attachments")' >/dev/null

SELF_MESSAGE_CONTENT_RESPONSE="$(curl -sS "$BASE_URL/v1/mailboxes/self/messages/$SEEDED_INBOUND_MESSAGE_ID/content" -H "authorization: Bearer $AGENT_TOKEN")"
echo "$SELF_MESSAGE_CONTENT_RESPONSE" | jq -e 'has("text") or has("html") or has("attachments")' >/dev/null

THREAD_RESPONSE="$(curl -sS "$BASE_URL/v1/threads/$THREAD_ID" -H "authorization: Bearer $AGENT_TOKEN")"
echo "$THREAD_RESPONSE" | jq -e --arg thread "$THREAD_ID" '.id == $thread and (.messages | type == "array")' >/dev/null

echo "Checking REST draft lifecycle..."
CREATE_DRAFT_RESPONSE="$(curl -sS -X POST "$BASE_URL/v1/agents/$AGENT_ID/drafts" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_TOKEN" \
  -d "{
    \"tenantId\": \"$TENANT_ID\",
    \"mailboxId\": \"$MAILBOX_ID\",
    \"from\": \"$FROM_EMAIL\",
    \"to\": [\"$TO_EMAIL\"],
    \"subject\": \"REST smoke draft\",
    \"text\": \"Created via REST smoke.\"
  }")"
DRAFT_ID="$(echo "$CREATE_DRAFT_RESPONSE" | jq -r '.id')"
if [[ -z "$DRAFT_ID" || "$DRAFT_ID" == "null" ]]; then
  echo "Failed to create REST smoke draft" >&2
  echo "$CREATE_DRAFT_RESPONSE" >&2
  exit 1
fi

GET_DRAFT_RESPONSE="$(curl -sS "$BASE_URL/v1/drafts/$DRAFT_ID" -H "authorization: Bearer $AGENT_TOKEN")"
echo "$GET_DRAFT_RESPONSE" | jq -e --arg draft "$DRAFT_ID" '.id == $draft and .status == "draft"' >/dev/null

DISPOSABLE_DRAFT_RESPONSE="$(curl -sS -X POST "$BASE_URL/v1/agents/$AGENT_ID/drafts" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_TOKEN" \
  -d "{
    \"tenantId\": \"$TENANT_ID\",
    \"mailboxId\": \"$MAILBOX_ID\",
    \"from\": \"$FROM_EMAIL\",
    \"to\": [\"$TO_EMAIL\"],
    \"subject\": \"REST disposable draft\",
    \"text\": \"Disposable draft.\"
  }")"
DISPOSABLE_DRAFT_ID="$(echo "$DISPOSABLE_DRAFT_RESPONSE" | jq -r '.id')"
if [[ -z "$DISPOSABLE_DRAFT_ID" || "$DISPOSABLE_DRAFT_ID" == "null" ]]; then
  echo "Failed to create disposable REST draft" >&2
  echo "$DISPOSABLE_DRAFT_RESPONSE" >&2
  exit 1
fi

CANCEL_DRAFT_RESPONSE="$(curl -sS -X DELETE "$BASE_URL/v1/drafts/$DISPOSABLE_DRAFT_ID" -H "authorization: Bearer $AGENT_TOKEN")"
echo "$CANCEL_DRAFT_RESPONSE" | jq -e --arg draft "$DISPOSABLE_DRAFT_ID" '
  .ok == true and .id == $draft and .status == "cancelled"
' >/dev/null

echo "Checking REST send and reply idempotency..."
SEND_DRAFT_KEY="api-smoke-send-$DRAFT_ID"
SEND_DRAFT_RESPONSE="$(curl -sS -X POST "$BASE_URL/v1/drafts/$DRAFT_ID/send" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_TOKEN" \
  -d "{
    \"idempotencyKey\": \"$SEND_DRAFT_KEY\"
  }")"
OUTBOUND_JOB_ID="$(echo "$SEND_DRAFT_RESPONSE" | jq -r '.outboundJobId')"
echo "$SEND_DRAFT_RESPONSE" | jq -e --arg draft "$DRAFT_ID" '.draftId == $draft and .status == "queued"' >/dev/null

SEND_DRAFT_REPEAT="$(curl -sS -X POST "$BASE_URL/v1/drafts/$DRAFT_ID/send" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_TOKEN" \
  -d "{
    \"idempotencyKey\": \"$SEND_DRAFT_KEY\"
  }")"
echo "$SEND_DRAFT_REPEAT" | jq -e --arg outbound "$OUTBOUND_JOB_ID" '.outboundJobId == $outbound and .status == "queued"' >/dev/null

SELF_SEND_KEY="api-smoke-self-send-$AGENT_ID"
SELF_SEND_RESPONSE="$(curl -sS -X POST "$BASE_URL/v1/messages/send" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_TOKEN" \
  -d "{
    \"to\": [\"$TO_EMAIL\"],
    \"subject\": \"REST self send\",
    \"text\": \"Sent via /v1/messages/send\",
    \"idempotencyKey\": \"$SELF_SEND_KEY\"
  }")"
SELF_SEND_DRAFT_ID="$(echo "$SELF_SEND_RESPONSE" | jq -r '.draft.id')"
SELF_SEND_OUTBOUND_JOB_ID="$(echo "$SELF_SEND_RESPONSE" | jq -r '.outboundJobId')"
echo "$SELF_SEND_RESPONSE" | jq -e '.status == "queued"' >/dev/null

SELF_SEND_REPEAT="$(curl -sS -X POST "$BASE_URL/v1/messages/send" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_TOKEN" \
  -d "{
    \"to\": [\"$TO_EMAIL\"],
    \"subject\": \"REST self send\",
    \"text\": \"Sent via /v1/messages/send\",
    \"idempotencyKey\": \"$SELF_SEND_KEY\"
  }")"
echo "$SELF_SEND_REPEAT" | jq -e --arg draft "$SELF_SEND_DRAFT_ID" --arg outbound "$SELF_SEND_OUTBOUND_JOB_ID" '
  .draft.id == $draft and .outboundJobId == $outbound and .status == "queued"
' >/dev/null

REPLY_KEY="api-smoke-reply-$AGENT_ID"
REPLY_RESPONSE="$(curl -sS -X POST "$BASE_URL/v1/messages/$SEEDED_INBOUND_MESSAGE_ID/reply" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_TOKEN" \
  -d "{
    \"text\": \"Reply via REST smoke\",
    \"idempotencyKey\": \"$REPLY_KEY\"
  }")"
REPLY_DRAFT_ID="$(echo "$REPLY_RESPONSE" | jq -r '.draft.id')"
REPLY_OUTBOUND_JOB_ID="$(echo "$REPLY_RESPONSE" | jq -r '.outboundJobId')"
echo "$REPLY_RESPONSE" | jq -e --arg message "$SEEDED_INBOUND_MESSAGE_ID" '
  .sourceMessageId == $message and .status == "queued"
' >/dev/null

REPLY_REPEAT="$(curl -sS -X POST "$BASE_URL/v1/messages/$SEEDED_INBOUND_MESSAGE_ID/reply" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_TOKEN" \
  -d "{
    \"text\": \"Reply via REST smoke\",
    \"idempotencyKey\": \"$REPLY_KEY\"
  }")"
echo "$REPLY_REPEAT" | jq -e --arg draft "$REPLY_DRAFT_ID" --arg outbound "$REPLY_OUTBOUND_JOB_ID" '
  .draft.id == $draft and .outboundJobId == $outbound and .status == "queued"
' >/dev/null

echo "Checking REST replay paths..."
NORMALIZE_REPLAY_ERROR="$(new_temp_file)"
NORMALIZE_REPLAY_STATUS="$(capture_status "$NORMALIZE_REPLAY_ERROR" \
  -X POST "$BASE_URL/v1/messages/$SEEDED_INBOUND_MESSAGE_ID/replay" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_TOKEN" \
  -d '{
    "mode": "normalize"
  }')"
[[ "$NORMALIZE_REPLAY_STATUS" == "400" ]]
jq -e '.error == "normalize replay requires the message to have raw email content"' "$NORMALIZE_REPLAY_ERROR" >/dev/null

RERUN_REPLAY_KEY="api-smoke-rerun-$AGENT_ID"
RERUN_REPLAY_RESPONSE="$(curl -sS -X POST "$BASE_URL/v1/messages/$SEEDED_INBOUND_MESSAGE_ID/replay" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_TOKEN" \
  -d "{
    \"mode\": \"rerun_agent\",
    \"agentId\": \"$AGENT_ID\",
    \"idempotencyKey\": \"$RERUN_REPLAY_KEY\"
  }")"
echo "$RERUN_REPLAY_RESPONSE" | jq -e --arg message "$SEEDED_INBOUND_MESSAGE_ID" '
  .messageId == $message and .mode == "rerun_agent" and .status == "accepted"
' >/dev/null

RERUN_REPLAY_REPEAT="$(curl -sS -X POST "$BASE_URL/v1/messages/$SEEDED_INBOUND_MESSAGE_ID/replay" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_TOKEN" \
  -d "{
    \"mode\": \"rerun_agent\",
    \"agentId\": \"$AGENT_ID\",
    \"idempotencyKey\": \"$RERUN_REPLAY_KEY\"
  }")"
echo "$RERUN_REPLAY_REPEAT" | jq -e --arg message "$SEEDED_INBOUND_MESSAGE_ID" '
  .messageId == $message and .mode == "rerun_agent" and .status == "accepted"
' >/dev/null

echo "Checking admin diagnostics..."
ADMIN_MESSAGES_RESPONSE="$(curl -sS "$BASE_URL/admin/api/messages?limit=5" -H "x-admin-secret: $ADMIN_SECRET")"
echo "$ADMIN_MESSAGES_RESPONSE" | jq -e '.items | type == "array"' >/dev/null

ADMIN_MESSAGE_RESPONSE="$(curl -sS "$BASE_URL/admin/api/messages/$SEEDED_INBOUND_MESSAGE_ID" -H "x-admin-secret: $ADMIN_SECRET")"
echo "$ADMIN_MESSAGE_RESPONSE" | jq -e --arg message "$SEEDED_INBOUND_MESSAGE_ID" '.id == $message and .direction == "inbound"' >/dev/null

ADMIN_MESSAGE_CONTENT_RESPONSE="$(curl -sS "$BASE_URL/admin/api/messages/$SEEDED_INBOUND_MESSAGE_ID/content" -H "x-admin-secret: $ADMIN_SECRET")"
echo "$ADMIN_MESSAGE_CONTENT_RESPONSE" | jq -e 'has("text") or has("html") or has("attachments")' >/dev/null

ADMIN_EVENTS_RESPONSE="$(curl -sS "$BASE_URL/admin/api/messages/$SEEDED_INBOUND_MESSAGE_ID/events" -H "x-admin-secret: $ADMIN_SECRET")"
echo "$ADMIN_EVENTS_RESPONSE" | jq -e '.items | type == "array"' >/dev/null

MISSING_CONTENT_BODY="$(new_temp_file)"
MISSING_CONTENT_STATUS="$(capture_status "$MISSING_CONTENT_BODY" "$BASE_URL/admin/api/messages/msg_missing_for_api_smoke/content" -H "x-admin-secret: $ADMIN_SECRET")"
[[ "$MISSING_CONTENT_STATUS" == "404" ]]
jq -e '.error == "Message not found"' "$MISSING_CONTENT_BODY" >/dev/null

MISSING_EVENTS_BODY="$(new_temp_file)"
MISSING_EVENTS_STATUS="$(capture_status "$MISSING_EVENTS_BODY" "$BASE_URL/admin/api/messages/msg_missing_for_api_smoke/events" -H "x-admin-secret: $ADMIN_SECRET")"
[[ "$MISSING_EVENTS_STATUS" == "404" ]]
jq -e '.error == "Message not found"' "$MISSING_EVENTS_BODY" >/dev/null

MISSING_OUTBOUND_BODY="$(new_temp_file)"
MISSING_OUTBOUND_STATUS="$(capture_status "$MISSING_OUTBOUND_BODY" "$BASE_URL/admin/api/messages/msg_missing_for_api_smoke/outbound-job" -H "x-admin-secret: $ADMIN_SECRET")"
[[ "$MISSING_OUTBOUND_STATUS" == "404" ]]
jq -e '.error == "Message not found"' "$MISSING_OUTBOUND_BODY" >/dev/null

ADMIN_OUTBOUND_JOBS_RESPONSE="$(curl -sS "$BASE_URL/admin/api/outbound-jobs?limit=10" -H "x-admin-secret: $ADMIN_SECRET")"
echo "$ADMIN_OUTBOUND_JOBS_RESPONSE" | jq -e '.items | type == "array" and length > 0' >/dev/null
LOOKUP_MESSAGE_ID="$(echo "$ADMIN_OUTBOUND_JOBS_RESPONSE" | jq -r '.items[] | select(.messageId != null) | .messageId' | head -n 1)"
LOOKUP_OUTBOUND_JOB_ID="$(echo "$ADMIN_OUTBOUND_JOBS_RESPONSE" | jq -r '.items[] | select(.messageId != null) | .id' | head -n 1)"
if [[ -z "$LOOKUP_MESSAGE_ID" || -z "$LOOKUP_OUTBOUND_JOB_ID" ]]; then
  echo "Admin outbound job list did not include a message-linked job" >&2
  echo "$ADMIN_OUTBOUND_JOBS_RESPONSE" >&2
  exit 1
fi

ADMIN_OUTBOUND_LOOKUP_RESPONSE="$(curl -sS "$BASE_URL/admin/api/messages/$LOOKUP_MESSAGE_ID/outbound-job" -H "x-admin-secret: $ADMIN_SECRET")"
echo "$ADMIN_OUTBOUND_LOOKUP_RESPONSE" | jq -e --arg outbound "$LOOKUP_OUTBOUND_JOB_ID" '.id == $outbound' >/dev/null

echo "Checking token rotation..."
TENANT_READ_TOKEN="$(mint_token "{
  \"sub\": \"api-smoke-rotate-tenant\",
  \"tenantId\": \"$TENANT_ID\",
  \"scopes\": [\"mail:read\"],
  \"expiresInSeconds\": 3600
}" | jq -r '.token')"
MAILBOX_READ_TOKEN="$(mint_token "{
  \"sub\": \"api-smoke-rotate-mailbox\",
  \"tenantId\": \"$TENANT_ID\",
  \"scopes\": [\"mail:read\"],
  \"mailboxIds\": [\"$MAILBOX_ID\"],
  \"expiresInSeconds\": 3600
}" | jq -r '.token')"

ROTATE_INLINE_RESPONSE="$(curl -sS -X POST "$BASE_URL/v1/auth/token/rotate" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MAILBOX_READ_TOKEN" \
  -d '{
    "delivery": "inline"
  }')"
echo "$ROTATE_INLINE_RESPONSE" | jq -e '
  (.token | type == "string") and
  .delivery == "inline" and
  .deliveryStatus == "skipped" and
  .oldTokenRemainsValid == true
' >/dev/null

ROTATE_SELF_BODY="$(new_temp_file)"
ROTATE_SELF_STATUS="$(capture_status "$ROTATE_SELF_BODY" \
  -X POST "$BASE_URL/v1/auth/token/rotate" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TENANT_READ_TOKEN" \
  -d '{
    "delivery": "self_mailbox"
  }')"
[[ "$ROTATE_SELF_STATUS" == "400" ]]
jq -e '.error == "self_mailbox delivery requires a mailbox-scoped token"' "$ROTATE_SELF_BODY" >/dev/null

echo "Checking tenant-only and public boundary behavior..."
BOUNDARY_TENANT_TOKEN="$(mint_token "{
  \"sub\": \"api-smoke-boundary-tenant\",
  \"tenantId\": \"$TENANT_ID\",
  \"scopes\": [\"agent:create\", \"agent:read\", \"mail:read\"],
  \"expiresInSeconds\": 3600
}" | jq -r '.token')"
BOUNDARY_MAILBOX_TOKEN="$(mint_token "{
  \"sub\": \"api-smoke-boundary-mailbox\",
  \"tenantId\": \"$TENANT_ID\",
  \"scopes\": [\"agent:read\", \"mail:read\"],
  \"mailboxIds\": [\"$MAILBOX_ID\"],
  \"expiresInSeconds\": 3600
}" | jq -r '.token')"

BOUNDARY_AGENT_RESPONSE="$(curl -sS -X POST "$BASE_URL/v1/agents" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $BOUNDARY_TENANT_TOKEN" \
  -d "{
    \"tenantId\": \"$TENANT_ID\",
    \"name\": \"Boundary Agent $(date +%s)\",
    \"mode\": \"assistant\",
    \"config\": {}
  }")"
BOUNDARY_AGENT_ID="$(echo "$BOUNDARY_AGENT_RESPONSE" | jq -r '.id')"
if [[ -z "$BOUNDARY_AGENT_ID" || "$BOUNDARY_AGENT_ID" == "null" ]]; then
  echo "Failed to create boundary agent" >&2
  echo "$BOUNDARY_AGENT_RESPONSE" >&2
  exit 1
fi

AGENT_MAILBOXES_BODY="$(new_temp_file)"
AGENT_MAILBOXES_STATUS="$(capture_status "$AGENT_MAILBOXES_BODY" "$BASE_URL/v1/agents/$BOUNDARY_AGENT_ID/mailboxes" -H "authorization: Bearer $BOUNDARY_MAILBOX_TOKEN")"
[[ "$AGENT_MAILBOXES_STATUS" == "403" ]]
jq -e '.error == "Mailbox-scoped tokens cannot access agent control-plane resources"' "$AGENT_MAILBOXES_BODY" >/dev/null

BILLING_ACCOUNT_BODY="$(new_temp_file)"
BILLING_ACCOUNT_STATUS="$(capture_status "$BILLING_ACCOUNT_BODY" "$BASE_URL/v1/billing/account" -H "authorization: Bearer $BOUNDARY_MAILBOX_TOKEN")"
[[ "$BILLING_ACCOUNT_STATUS" == "403" ]]
jq -e '.error == "Only tenant-scoped tokens can access tenant-level resources"' "$BILLING_ACCOUNT_BODY" >/dev/null

BILLING_LEDGER_BODY="$(new_temp_file)"
BILLING_LEDGER_STATUS="$(capture_status "$BILLING_LEDGER_BODY" "$BASE_URL/v1/billing/ledger" -H "authorization: Bearer $BOUNDARY_MAILBOX_TOKEN")"
[[ "$BILLING_LEDGER_STATUS" == "403" ]]
jq -e '.error == "Only tenant-scoped tokens can access tenant-level resources"' "$BILLING_LEDGER_BODY" >/dev/null

DID_BODY="$(new_temp_file)"
DID_STATUS="$(capture_status "$DID_BODY" "$BASE_URL/v1/tenants/$TENANT_ID/did" -H "authorization: Bearer $BOUNDARY_MAILBOX_TOKEN")"
[[ "$DID_STATUS" == "403" ]]
jq -e '.error == "Only tenant-scoped tokens can access tenant-level resources"' "$DID_BODY" >/dev/null

REISSUE_EXISTING="$(curl -sS -X POST "$BASE_URL/public/token/reissue" \
  -H 'content-type: application/json' \
  -d "{
    \"mailboxAddress\": \"$FROM_EMAIL\"
  }")"
echo "$REISSUE_EXISTING" | jq -e '.accepted == true and (.message | type == "string")' >/dev/null

REISSUE_MISSING="$(curl -sS -X POST "$BASE_URL/public/token/reissue" \
  -H 'content-type: application/json' \
  -d '{
    "mailboxAddress": "missing-mailbox-do-not-exist@mailagents.net"
  }')"
echo "$REISSUE_MISSING" | jq -e '.accepted == true and (.message | type == "string")' >/dev/null

if [[ "$(echo "$REISSUE_EXISTING" | jq -c .)" != "$(echo "$REISSUE_MISSING" | jq -c .)" ]]; then
  echo "Existing vs missing token reissue responses differ" >&2
  echo "$REISSUE_EXISTING" >&2
  echo "$REISSUE_MISSING" >&2
  exit 1
fi

echo "API surface smoke completed."
echo "Agent ID: $AGENT_ID"
echo "Draft ID: $DRAFT_ID"
echo "Outbound Job ID: $OUTBOUND_JOB_ID"
echo "reply Draft ID: $REPLY_DRAFT_ID"
echo "Boundary Agent ID: $BOUNDARY_AGENT_ID"
