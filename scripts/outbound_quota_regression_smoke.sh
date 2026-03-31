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
FIRST_TO_EMAIL="${FIRST_TO_EMAIL:-quota-first-${RUN_ID}@mailagents.net}"
SECOND_TO_EMAIL="${SECOND_TO_EMAIL:-quota-second-${RUN_ID}@mailagents.net}"

TEMP_FILES=()
LAST_HEADERS=""
LAST_BODY=""
LAST_STATUS=""
MAILBOX_TOKEN=""
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
WHERE tenant_id = '$TENANT_ID' AND id != 'thr_demo_inbound';
DELETE FROM tenant_credit_ledger
WHERE tenant_id = '$TENANT_ID';
DELETE FROM tenant_payment_receipts
WHERE tenant_id = '$TENANT_ID';
DELETE FROM tenant_billing_accounts
WHERE tenant_id = '$TENANT_ID';
COMMIT;"
}

seed_failed_outbound_attempt() {
  local message_id="msg_quota_failed_${RUN_ID}"
  local outbound_job_id="obj_quota_failed_${RUN_ID}"
  local draft_r2_key="drafts/drf_quota_failed_${RUN_ID}.json"
  local timestamp
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  exec_sql "
BEGIN TRANSACTION;
INSERT INTO messages (
  id, tenant_id, mailbox_id, thread_id, direction, provider, from_addr, to_addr,
  subject, status, created_at
) VALUES (
  '$message_id', '$TENANT_ID', '$MAILBOX_ID', NULL, 'outbound', 'ses', '$MAILBOX_ADDRESS', '$FIRST_TO_EMAIL',
  'Quota regression seeded failed send', 'failed', '$timestamp'
);
INSERT INTO outbound_jobs (
  id, message_id, task_id, status, ses_region, retry_count, next_retry_at,
  last_error, draft_r2_key, created_at, updated_at
) VALUES (
  '$outbound_job_id', '$message_id', NULL, 'failed', 'us-east-1', 1, NULL,
  'seeded_failed_send_for_quota_regression', '$draft_r2_key', '$timestamp', '$timestamp'
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

require_cmd curl
require_cmd jq
require_cmd wrangler

trap cleanup EXIT

load_local_secrets
wait_for_server

if [[ "$ADMIN_SECRET" == "replace-with-admin-api-secret" ]]; then
  echo "Missing admin secret. Set ADMIN_API_SECRET_FOR_SMOKE or configure ADMIN_API_SECRET in .dev.vars." >&2
  exit 1
fi

echo "Minting seeded demo mailbox bearer token..."
capture_request "POST" "/v1/auth/tokens" "{
  \"sub\": \"outbound-quota-regression-smoke\",
  \"tenantId\": \"$TENANT_ID\",
  \"agentId\": \"$AGENT_ID\",
  \"mailboxIds\": [\"$MAILBOX_ID\"],
  \"scopes\": [\"draft:create\", \"draft:send\", \"draft:read\", \"mail:read\"],
  \"expiresInSeconds\": 3600
}" "x-admin-secret: $ADMIN_SECRET"
assert_status "201"
MAILBOX_TOKEN="$(jq -r '.token' "$LAST_BODY")"

echo "Loading seeded mailbox context..."
capture_request "GET" "/v1/mailboxes/self" "" "authorization: Bearer $MAILBOX_TOKEN"
assert_status "200"
MAILBOX_ADDRESS="$(jq -r '.address' "$LAST_BODY")"
jq -e --arg mailbox "$MAILBOX_ID" '.id == $mailbox and .status == "active"' "$LAST_BODY" >/dev/null

echo "Resetting demo tenant outbound state..."
reset_demo_outbound_state

echo "Ensuring demo tenant uses the free internal-only policy..."
capture_request "PUT" "/v1/tenants/$TENANT_ID/send-policy" '{
  "pricingTier": "free",
  "outboundStatus": "internal_only",
  "internalDomainAllowlist": ["mailagents.net"],
  "externalSendEnabled": false,
  "reviewRequired": true
}' "x-admin-secret: $ADMIN_SECRET"
assert_status "200"
jq -e '.pricingTier == "free" and .outboundStatus == "internal_only" and .externalSendEnabled == false' "$LAST_BODY" >/dev/null

echo "Seeding one failed outbound attempt inside the rolling quota window..."
seed_failed_outbound_attempt

echo "Sending the first legitimate internal email; failed sends should not consume quota..."
capture_request "POST" "/v1/messages/send" "{
  \"to\": [\"$FIRST_TO_EMAIL\"],
  \"subject\": \"Quota regression first send $RUN_ID\",
  \"text\": \"First legitimate send after a failed outbound should succeed.\",
  \"idempotencyKey\": \"quota-first-$RUN_ID\"
}" "authorization: Bearer $MAILBOX_TOKEN"
assert_status "202"
FIRST_OUTBOUND_JOB_ID="$(jq -r '.outboundJobId' "$LAST_BODY")"
jq -e '.status == "queued"' "$LAST_BODY" >/dev/null

wait_for_job_status "$FIRST_OUTBOUND_JOB_ID" "sent"
capture_request "GET" "/v1/debug/outbound-jobs/$FIRST_OUTBOUND_JOB_ID" "" "x-admin-secret: $ADMIN_SECRET"
assert_status "200"
jq -e '.status == "sent" and (.lastError == null or .lastError == "")' "$LAST_BODY" >/dev/null

echo "Sending a second legitimate internal email; the hourly limit should still apply after one successful send..."
capture_request "POST" "/v1/messages/send" "{
  \"to\": [\"$SECOND_TO_EMAIL\"],
  \"subject\": \"Quota regression second send $RUN_ID\",
  \"text\": \"Second send in the same rolling hour should be blocked.\",
  \"idempotencyKey\": \"quota-second-$RUN_ID\"
}" "authorization: Bearer $MAILBOX_TOKEN"
assert_status "429"
jq -e '.error | contains("Free-tier hourly send limit reached")' "$LAST_BODY" >/dev/null

echo "Outbound quota regression smoke completed."
echo "First outbound job: $FIRST_OUTBOUND_JOB_ID"
