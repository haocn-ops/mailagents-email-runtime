#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
ADMIN_SECRET="${ADMIN_API_SECRET_FOR_SMOKE:-replace-with-admin-api-secret}"
TENANT_ID="${TENANT_ID:-t_demo}"
AGENT_ID="${AGENT_ID:-agt_demo}"
MAILBOX_ID="${MAILBOX_ID:-mbx_demo}"
RUN_ID="${RUN_ID_FOR_SMOKE:-$(date +%s)}"
INTERNAL_MAILBOX_ID="${INTERNAL_MAILBOX_ID:-mbx_quota_internal}"
INTERNAL_MAILBOX_ADDRESS="${INTERNAL_MAILBOX_ADDRESS:-quota-recipient@mailagents.net}"
EXTERNAL_TO_EMAIL="${EXTERNAL_TO_EMAIL:-quota-external-${RUN_ID}@example.com}"
FIRST_INTERNAL_SUBJECT="Internal routing first send ${RUN_ID}"
SECOND_INTERNAL_SUBJECT="Internal routing second send ${RUN_ID}"

TEMP_FILES=()
LAST_HEADERS=""
LAST_BODY=""
LAST_STATUS=""
SENDER_TOKEN=""
RECIPIENT_TOKEN=""
CONTROL_TOKEN=""
MAILBOX_ADDRESS=""

cleanup() {
  if [[ "${#TEMP_FILES[@]}" -gt 0 ]]; then
    rm -f "${TEMP_FILES[@]}"
  fi
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

load_local_secrets() {
  local dev_vars="$REPO_ROOT/.dev.vars"
  if [[ ! -f "$dev_vars" ]]; then
    return
  fi

  if [[ "$ADMIN_SECRET" == "replace-with-admin-api-secret" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$dev_vars"
    set +a
    ADMIN_SECRET="${ADMIN_API_SECRET_FOR_SMOKE:-${ADMIN_API_SECRET:-$ADMIN_SECRET}}"
  fi
}

wait_for_server() {
  local attempt
  echo "Waiting for smoke target at $BASE_URL ..."
  for attempt in $(seq 1 20); do
    if curl --connect-timeout 1 --max-time 2 -fsS "$BASE_URL/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "Smoke target is not reachable at $BASE_URL. Start the worker first, for example with: npm run dev:local" >&2
  exit 1
}

capture_request() {
  local method="$1"
  local path="$2"
  local data="$3"
  shift 3

  LAST_HEADERS="$(mktemp -t mailagents-quota-headers.XXXXXX)"
  LAST_BODY="$(mktemp -t mailagents-quota-body.XXXXXX)"
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

exec_sql() {
  local sql="$1"
  wrangler d1 execute mailagents-local --local --command "$sql" >/dev/null
}

reset_demo_outbound_state() {
  exec_sql "
BEGIN TRANSACTION;
DELETE FROM delivery_events
WHERE message_id IN (
  SELECT id
  FROM messages
  WHERE tenant_id = '$TENANT_ID' AND direction = 'outbound'
);
DELETE FROM outbound_jobs
WHERE message_id IN (
  SELECT id
  FROM messages
  WHERE tenant_id = '$TENANT_ID' AND direction = 'outbound'
);
DELETE FROM drafts
WHERE tenant_id = '$TENANT_ID';
DELETE FROM idempotency_keys
WHERE tenant_id = '$TENANT_ID';
DELETE FROM messages
WHERE tenant_id = '$TENANT_ID' AND direction = 'outbound';
DELETE FROM threads
WHERE tenant_id = '$TENANT_ID' AND mailbox_id = '$MAILBOX_ID' AND id != 'thr_demo_inbound';
COMMIT;"
}

reset_internal_recipient_mailbox() {
  exec_sql "
BEGIN TRANSACTION;
DELETE FROM agent_runs
WHERE task_id IN (
  SELECT id
  FROM tasks
  WHERE mailbox_id = '$INTERNAL_MAILBOX_ID'
);
DELETE FROM tasks
WHERE mailbox_id = '$INTERNAL_MAILBOX_ID';
DELETE FROM attachments
WHERE message_id IN (
  SELECT id
  FROM messages
  WHERE mailbox_id = '$INTERNAL_MAILBOX_ID'
);
DELETE FROM messages
WHERE mailbox_id = '$INTERNAL_MAILBOX_ID';
DELETE FROM threads
WHERE mailbox_id = '$INTERNAL_MAILBOX_ID';
DELETE FROM agent_mailboxes
WHERE mailbox_id = '$INTERNAL_MAILBOX_ID';
DELETE FROM mailboxes
WHERE id = '$INTERNAL_MAILBOX_ID';
INSERT INTO mailboxes (
  id, tenant_id, address, status, created_at
) VALUES (
  '$INTERNAL_MAILBOX_ID', '$TENANT_ID', '$INTERNAL_MAILBOX_ADDRESS', 'active', '2026-03-16T00:00:00.000Z'
);
COMMIT;"
}

wait_for_job_status() {
  local outbound_job_id="$1"
  local expected_status="$2"
  local attempt

  for attempt in $(seq 1 40); do
    capture_request "GET" "/v1/debug/outbound-jobs/$outbound_job_id" "" "x-admin-secret: $ADMIN_SECRET"
    if [[ "$LAST_STATUS" == "200" ]] && jq -e --arg status "$expected_status" '.status == $status' "$LAST_BODY" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for outbound job $outbound_job_id to reach status $expected_status" >&2
  cat "$LAST_BODY" >&2
  exit 1
}

wait_for_recipient_message() {
  local subject="$1"
  local attempt

  for attempt in $(seq 1 40); do
    capture_request "GET" "/v1/mailboxes/self/messages?direction=inbound&limit=20&search=$(python3 - <<'PY' "$subject"
import sys, urllib.parse
print(urllib.parse.quote(sys.argv[1]))
PY
)" "" "authorization: Bearer $RECIPIENT_TOKEN"
    if [[ "$LAST_STATUS" == "200" ]] && jq -e --arg subject "$subject" '
      .items
      | map(select(.subject == $subject and .provider == "internal"))
      | length >= 1
    ' "$LAST_BODY" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for recipient mailbox to receive subject: $subject" >&2
  cat "$LAST_BODY" >&2
  exit 1
}

require_cmd curl
require_cmd jq
require_cmd wrangler
require_cmd python3

trap cleanup EXIT

load_local_secrets
wait_for_server

if [[ "$ADMIN_SECRET" == "replace-with-admin-api-secret" ]]; then
  echo "Missing admin secret. Set ADMIN_API_SECRET_FOR_SMOKE or configure ADMIN_API_SECRET in .dev.vars." >&2
  exit 1
fi

echo "Resetting demo outbound state and preparing a real internal recipient mailbox..."
reset_demo_outbound_state
reset_internal_recipient_mailbox

echo "Minting sender mailbox bearer token..."
capture_request "POST" "/v1/auth/tokens" "{
  \"sub\": \"outbound-quota-regression-sender\",
  \"tenantId\": \"$TENANT_ID\",
  \"agentId\": \"$AGENT_ID\",
  \"mailboxIds\": [\"$MAILBOX_ID\"],
  \"scopes\": [\"draft:create\", \"draft:send\", \"draft:read\", \"mail:read\"],
  \"expiresInSeconds\": 3600
}" "x-admin-secret: $ADMIN_SECRET"
assert_status "201"
SENDER_TOKEN="$(jq -r '.token' "$LAST_BODY")"

echo "Minting recipient mailbox read token..."
capture_request "POST" "/v1/auth/tokens" "{
  \"sub\": \"outbound-quota-regression-recipient\",
  \"tenantId\": \"$TENANT_ID\",
  \"mailboxIds\": [\"$INTERNAL_MAILBOX_ID\"],
  \"scopes\": [\"mail:read\"],
  \"expiresInSeconds\": 3600
}" "x-admin-secret: $ADMIN_SECRET"
assert_status "201"
RECIPIENT_TOKEN="$(jq -r '.token' "$LAST_BODY")"

echo "Minting control-plane token for agent policy updates..."
capture_request "POST" "/v1/auth/tokens" "{
  \"sub\": \"outbound-quota-regression-control\",
  \"tenantId\": \"$TENANT_ID\",
  \"agentId\": \"$AGENT_ID\",
  \"scopes\": [\"agent:update\"],
  \"expiresInSeconds\": 3600
}" "x-admin-secret: $ADMIN_SECRET"
assert_status "201"
CONTROL_TOKEN="$(jq -r '.token' "$LAST_BODY")"

echo "Loading seeded sender mailbox context..."
capture_request "GET" "/v1/mailboxes/self" "" "authorization: Bearer $SENDER_TOKEN"
assert_status "200"
MAILBOX_ADDRESS="$(jq -r '.address' "$LAST_BODY")"
jq -e --arg mailbox "$MAILBOX_ID" '.id == $mailbox and .status == "active"' "$LAST_BODY" >/dev/null

echo "Loading internal recipient mailbox context..."
capture_request "GET" "/v1/mailboxes/self" "" "authorization: Bearer $RECIPIENT_TOKEN"
assert_status "200"
jq -e --arg mailbox "$INTERNAL_MAILBOX_ID" --arg address "$INTERNAL_MAILBOX_ADDRESS" '
  .id == $mailbox and .address == $address and .status == "active"
' "$LAST_BODY" >/dev/null

echo "Ensuring demo tenant stays on the default internal-only policy..."
capture_request "PUT" "/v1/tenants/$TENANT_ID/send-policy" '{
  "pricingTier": "free",
  "outboundStatus": "internal_only",
  "internalDomainAllowlist": ["mailagents.net"],
  "externalSendEnabled": false,
  "reviewRequired": true
}' "x-admin-secret: $ADMIN_SECRET"
assert_status "200"
jq -e '.pricingTier == "free" and .outboundStatus == "internal_only" and .externalSendEnabled == false' "$LAST_BODY" >/dev/null

echo "Restricting the sender agent allowlist to example.com so true internal mailbox delivery must bypass domain policy..."
capture_request "PUT" "/v1/agents/$AGENT_ID/policy" '{
  "autoReplyEnabled": false,
  "humanReviewRequired": true,
  "confidenceThreshold": 0.85,
  "maxAutoRepliesPerThread": 1,
  "allowedRecipientDomains": ["example.com"],
  "blockedSenderDomains": [],
  "allowedTools": ["reply_email"]
}' "authorization: Bearer $CONTROL_TOKEN"
assert_status "200"
jq -e '.allowedRecipientDomains == ["example.com"]' "$LAST_BODY" >/dev/null

echo "Sending the first internal mailbox-to-mailbox message; it should succeed despite the external-only domain allowlist..."
capture_request "POST" "/v1/messages/send" "{
  \"to\": [\"$INTERNAL_MAILBOX_ADDRESS\"],
  \"subject\": \"$FIRST_INTERNAL_SUBJECT\",
  \"text\": \"First internal mailbox delivery should bypass external restrictions.\",
  \"idempotencyKey\": \"internal-first-$RUN_ID\"
}" "authorization: Bearer $SENDER_TOKEN"
assert_status "202"
FIRST_OUTBOUND_JOB_ID="$(jq -r '.outboundJobId' "$LAST_BODY")"
jq -e '.status == "queued"' "$LAST_BODY" >/dev/null
wait_for_job_status "$FIRST_OUTBOUND_JOB_ID" "sent"
wait_for_recipient_message "$FIRST_INTERNAL_SUBJECT"

echo "Sending the second internal mailbox-to-mailbox message; internal mail should remain unrestricted and not hit the external hourly cap..."
capture_request "POST" "/v1/messages/send" "{
  \"to\": [\"$INTERNAL_MAILBOX_ADDRESS\"],
  \"subject\": \"$SECOND_INTERNAL_SUBJECT\",
  \"text\": \"Second internal mailbox delivery should also succeed.\",
  \"idempotencyKey\": \"internal-second-$RUN_ID\"
}" "authorization: Bearer $SENDER_TOKEN"
assert_status "202"
SECOND_OUTBOUND_JOB_ID="$(jq -r '.outboundJobId' "$LAST_BODY")"
jq -e '.status == "queued"' "$LAST_BODY" >/dev/null
wait_for_job_status "$SECOND_OUTBOUND_JOB_ID" "sent"
wait_for_recipient_message "$SECOND_INTERNAL_SUBJECT"

echo "Verifying the recipient inbox now contains both internal messages..."
capture_request "GET" "/v1/mailboxes/self/messages?direction=inbound&limit=20" "" "authorization: Bearer $RECIPIENT_TOKEN"
assert_status "200"
jq -e --arg first "$FIRST_INTERNAL_SUBJECT" --arg second "$SECOND_INTERNAL_SUBJECT" '
  (.items | map(select(.provider == "internal" and .subject == $first)) | length) >= 1 and
  (.items | map(select(.provider == "internal" and .subject == $second)) | length) >= 1
' "$LAST_BODY" >/dev/null

echo "Checking that external sending is still blocked under the same internal-only tenant policy..."
capture_request "POST" "/v1/messages/send" "{
  \"to\": [\"$EXTERNAL_TO_EMAIL\"],
  \"subject\": \"Blocked external send $RUN_ID\",
  \"text\": \"External sending should still require explicit enablement.\",
  \"idempotencyKey\": \"external-blocked-$RUN_ID\"
}" "authorization: Bearer $SENDER_TOKEN"
assert_status "403"
jq -e '.error | contains("External sending requires available credits or an enabled outbound policy")' "$LAST_BODY" >/dev/null

echo "Outbound quota regression smoke completed."
