#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
ADMIN_SECRET="${ADMIN_API_SECRET_FOR_SMOKE:-replace-with-admin-api-secret}"
WEBHOOK_SECRET="${WEBHOOK_SHARED_SECRET_FOR_SMOKE:-}"
TENANT_ID="${TENANT_ID:-t_demo}"
AGENT_ID="${AGENT_ID:-agt_demo}"
MAILBOX_ID="${MAILBOX_ID:-mbx_demo}"
SUCCESS_TO_EMAIL="${SUCCESS_TO_EMAIL:-credit-success-$(date +%s)@example.com}"
BLOCKED_TO_EMAIL="${BLOCKED_TO_EMAIL:-credit-blocked-$(date +%s)@example.com}"

TEMP_FILES=()
LAST_HEADERS=""
LAST_BODY=""
LAST_STATUS=""
TENANT_TOKEN=""
MAILBOX_TOKEN=""

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

  if [[ "$ADMIN_SECRET" == "replace-with-admin-api-secret" || -z "$WEBHOOK_SECRET" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$dev_vars"
    set +a
    ADMIN_SECRET="${ADMIN_API_SECRET_FOR_SMOKE:-${ADMIN_API_SECRET:-$ADMIN_SECRET}}"
    WEBHOOK_SECRET="${WEBHOOK_SHARED_SECRET_FOR_SMOKE:-${WEBHOOK_SHARED_SECRET:-$WEBHOOK_SECRET}}"
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

  LAST_HEADERS="$(mktemp -t mailagents-credit-headers.XXXXXX)"
  LAST_BODY="$(mktemp -t mailagents-credit-body.XXXXXX)"
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

seed_available_credits() {
  local credits="$1"
  local timestamp
  local ledger_id
  local reference_id
  local metadata_json
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  ledger_id="led_smoke_${TENANT_ID}_$(date +%s)_$RANDOM"
  reference_id="smoke-credit-topup-${TENANT_ID}-$(date +%s)-$RANDOM"
  metadata_json="$(jq -cn --argjson credits "$credits" '{
    entryType: "topup",
    receiptType: "topup",
    confirmationMode: "manual_admin",
    creditsRequested: $credits
  }')"

  exec_sql "
BEGIN TRANSACTION;
UPDATE tenant_billing_accounts
SET available_credits = available_credits + $credits,
    updated_at = '$timestamp'
WHERE tenant_id = '$TENANT_ID';
INSERT INTO tenant_credit_ledger (
  id, tenant_id, entry_type, credits_delta, reason, payment_receipt_id,
  reference_id, metadata_json, created_at
) VALUES (
  '$ledger_id', '$TENANT_ID', 'topup', $credits, 'smoke_credit_topup', NULL,
  '$reference_id', '$metadata_json', '$timestamp'
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

wait_for_billing_account_state() {
  local expected_available="$1"
  local expected_reserved="$2"
  local attempt

  for attempt in $(seq 1 40); do
    capture_request "GET" "/v1/billing/account" "" "authorization: Bearer $TENANT_TOKEN"
    if [[ "$LAST_STATUS" == "200" ]] && jq -e \
      --argjson expected_available "$expected_available" \
      --argjson expected_reserved "$expected_reserved" '
        .availableCredits == $expected_available and
        .reservedCredits == $expected_reserved
      ' "$LAST_BODY" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for billing account to reach the expected balance" >&2
  cat "$LAST_BODY" >&2
  exit 1
}

wait_for_credit_ledger_debit() {
  local outbound_job_id="$1"
  local expected_delta="$2"
  local attempt

  for attempt in $(seq 1 40); do
    capture_request "GET" "/v1/billing/ledger?limit=20" "" "authorization: Bearer $TENANT_TOKEN"
    if [[ "$LAST_STATUS" == "200" ]] && jq -e \
      --arg outbound "$outbound_job_id" \
      --argjson expected_delta "$expected_delta" '
        (.items | map(select(.entryType == "debit_send" and .referenceId == $outbound)) | length) == 1 and
        (.items | map(select(.entryType == "debit_send" and .referenceId == $outbound))[0].creditsDelta) == $expected_delta
      ' "$LAST_BODY" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for debit ledger entry for outbound job $outbound_job_id" >&2
  cat "$LAST_BODY" >&2
  exit 1
}

wait_for_credit_ledger_absence() {
  local outbound_job_id="$1"
  local attempt

  for attempt in $(seq 1 40); do
    capture_request "GET" "/v1/billing/ledger?limit=20" "" "authorization: Bearer $TENANT_TOKEN"
    if [[ "$LAST_STATUS" == "200" ]] && jq -e \
      --arg outbound "$outbound_job_id" '
        (.items | map(select(.referenceId == $outbound)) | length) == 0
      ' "$LAST_BODY" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for ledger to exclude outbound job $outbound_job_id" >&2
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

echo "Minting seeded demo tenant-scoped bearer token..."
capture_request "POST" "/v1/auth/tokens" "{
  \"sub\": \"outbound-credit-smoke\",
  \"tenantId\": \"$TENANT_ID\",
  \"scopes\": [\"agent:read\"],
  \"expiresInSeconds\": 3600
}" "x-admin-secret: $ADMIN_SECRET"
assert_status "201"
TENANT_TOKEN="$(jq -r '.token' "$LAST_BODY")"

echo "Minting seeded demo mailbox bearer token..."
capture_request "POST" "/v1/auth/tokens" "{
  \"sub\": \"outbound-credit-smoke-mailbox\",
  \"tenantId\": \"$TENANT_ID\",
  \"agentId\": \"$AGENT_ID\",
  \"mailboxIds\": [\"$MAILBOX_ID\"],
  \"scopes\": [\"draft:create\", \"draft:send\", \"draft:read\", \"mail:read\"],
  \"expiresInSeconds\": 3600
}" "x-admin-secret: $ADMIN_SECRET"
assert_status "201"
MAILBOX_TOKEN="$(jq -r '.token' "$LAST_BODY")"

echo "Checking seeded self mailbox..."
capture_request "GET" "/v1/mailboxes/self" "" "authorization: Bearer $MAILBOX_TOKEN"
assert_status "200"
jq -e --arg mailbox "$MAILBOX_ID" '.id == $mailbox and .status == "active"' "$LAST_BODY" >/dev/null

echo "Resetting demo tenant outbound and billing state..."
reset_demo_outbound_state

echo "Capturing starting billing balance..."
capture_request "GET" "/v1/billing/account" "" "authorization: Bearer $TENANT_TOKEN"
assert_status "200"
STARTING_AVAILABLE_CREDITS="$(jq -r '.availableCredits' "$LAST_BODY")"
STARTING_RESERVED_CREDITS="$(jq -r '.reservedCredits' "$LAST_BODY")"

echo "Seeding demo tenant credits directly for reservation smoke..."
seed_available_credits 5

capture_request "GET" "/v1/billing/account" "" "authorization: Bearer $TENANT_TOKEN"
assert_status "200"
TOPUP_AVAILABLE_CREDITS="$(jq -r '.availableCredits' "$LAST_BODY")"
TOPUP_RESERVED_CREDITS="$(jq -r '.reservedCredits' "$LAST_BODY")"
jq -e --argjson start_available "$STARTING_AVAILABLE_CREDITS" --argjson start_reserved "$STARTING_RESERVED_CREDITS" '
  .availableCredits == ($start_available + 5) and
  .reservedCredits == $start_reserved
' "$LAST_BODY" >/dev/null

echo "Keeping the demo tenant on an internal-only send policy to verify credits unlock external sending..."
capture_request "PUT" "/v1/tenants/$TENANT_ID/send-policy" '{
  "pricingTier": "paid_active",
  "outboundStatus": "internal_only",
  "internalDomainAllowlist": ["mailagents.net"],
  "externalSendEnabled": false,
  "reviewRequired": true
}' "x-admin-secret: $ADMIN_SECRET"
assert_status "200"
jq -e '.pricingTier == "paid_active" and .outboundStatus == "internal_only" and .externalSendEnabled == false' "$LAST_BODY" >/dev/null

echo "Sending an external email to verify credit reservation..."
capture_request "POST" "/v1/mailboxes/self/send" "{
  \"to\": [\"$SUCCESS_TO_EMAIL\"],
  \"subject\": \"Credit smoke success\",
  \"text\": \"Testing outbound credit reservation and capture.\"
}" "authorization: Bearer $MAILBOX_TOKEN"
assert_status "202"
SUCCESS_OUTBOUND_JOB_ID="$(jq -r '.outboundJobId' "$LAST_BODY")"
SUCCESS_DRAFT_ID="$(jq -r '.draft.id' "$LAST_BODY")"

capture_request "GET" "/v1/billing/account" "" "authorization: Bearer $TENANT_TOKEN"
assert_status "200"
jq -e --argjson topup_available "$TOPUP_AVAILABLE_CREDITS" --argjson topup_reserved "$TOPUP_RESERVED_CREDITS" '
  .availableCredits == ($topup_available - 1) and
  .reservedCredits == ($topup_reserved + 1)
' "$LAST_BODY" >/dev/null

echo "Waiting for successful send capture..."
wait_for_job_status "$SUCCESS_OUTBOUND_JOB_ID" "sent"

capture_request "GET" "/v1/debug/outbound-jobs/$SUCCESS_OUTBOUND_JOB_ID" "" "x-admin-secret: $ADMIN_SECRET"
assert_status "200"
SUCCESS_MESSAGE_ID="$(jq -r '.messageId' "$LAST_BODY")"
jq -e '.status == "sent"' "$LAST_BODY" >/dev/null

capture_request "GET" "/v1/debug/messages/$SUCCESS_MESSAGE_ID" "" "x-admin-secret: $ADMIN_SECRET"
assert_status "200"
SUCCESS_PROVIDER_MESSAGE_ID="$(jq -r '.message.providerMessageId' "$LAST_BODY")"
jq -e '
  .message.status == "replied" and
  (.message.providerMessageId | type) == "string"
' "$LAST_BODY" >/dev/null

echo "Waiting for billing settlement after the successful send..."
wait_for_billing_account_state "$((TOPUP_AVAILABLE_CREDITS - 1))" "$TOPUP_RESERVED_CREDITS"

capture_request "GET" "/v1/billing/account" "" "authorization: Bearer $TENANT_TOKEN"
assert_status "200"
jq -e --argjson topup_available "$TOPUP_AVAILABLE_CREDITS" --argjson topup_reserved "$TOPUP_RESERVED_CREDITS" '
  .availableCredits == ($topup_available - 1) and
  .reservedCredits == $topup_reserved
' "$LAST_BODY" >/dev/null

wait_for_credit_ledger_debit "$SUCCESS_OUTBOUND_JOB_ID" -1

capture_request "GET" "/v1/billing/ledger?limit=10" "" "authorization: Bearer $TENANT_TOKEN"
assert_status "200"
jq -e --arg outbound "$SUCCESS_OUTBOUND_JOB_ID" '
  (.items | map(select(.entryType == "debit_send" and .referenceId == $outbound)) | length) == 1 and
  (.items | map(select(.entryType == "debit_send" and .referenceId == $outbound))[0].creditsDelta) == -1
' "$LAST_BODY" >/dev/null

echo "Posting SES bounce webhook for the successful send..."
WEBHOOK_PAYLOAD="$(mktemp -t mailagents-outbound-webhook.XXXXXX.json)"
TEMP_FILES+=("$WEBHOOK_PAYLOAD")
jq -n \
  --arg provider "$SUCCESS_PROVIDER_MESSAGE_ID" \
  --arg message "$SUCCESS_MESSAGE_ID" \
  --arg outbound "$SUCCESS_OUTBOUND_JOB_ID" \
  --arg recipient "$SUCCESS_TO_EMAIL" '
  {
    "detail-type": "SES Email Event",
    "source": "aws.ses",
    "detail": {
      "eventType": "Bounce",
      "mail": {
        "messageId": $provider,
        "tags": {
          "message_id": [$message],
          "outbound_job_id": [$outbound]
        }
      },
      "bounce": {
        "bounceType": "Permanent",
        "bouncedRecipients": [
          {
            "emailAddress": $recipient
          }
        ]
      }
    }
  }
' > "$WEBHOOK_PAYLOAD"

WEBHOOK_HEADERS=()
if [[ -n "$WEBHOOK_SECRET" ]]; then
  WEBHOOK_HEADERS+=("x-webhook-shared-secret: $WEBHOOK_SECRET")
fi
if [[ "${#WEBHOOK_HEADERS[@]}" -gt 0 ]]; then
  capture_request "POST" "/v1/webhooks/ses" "$(cat "$WEBHOOK_PAYLOAD")" "${WEBHOOK_HEADERS[@]}"
else
  capture_request "POST" "/v1/webhooks/ses" "$(cat "$WEBHOOK_PAYLOAD")"
fi
assert_status "202"
jq -e '
  .provider == "ses" and
  .received == true and
  .eventType == "bounce"
' "$LAST_BODY" >/dev/null

capture_request "GET" "/v1/debug/messages/$SUCCESS_MESSAGE_ID" "" "x-admin-secret: $ADMIN_SECRET"
assert_status "200"
jq -e '
  .message.status == "failed" and
  (.deliveryEvents | map(select(.eventType == "bounce")) | length) >= 1
' "$LAST_BODY" >/dev/null

capture_request "GET" "/v1/debug/drafts/$SUCCESS_DRAFT_ID" "" "x-admin-secret: $ADMIN_SECRET"
assert_status "200"
jq -e '.draft.status == "failed"' "$LAST_BODY" >/dev/null

capture_request "GET" "/v1/debug/outbound-jobs/$SUCCESS_OUTBOUND_JOB_ID" "" "x-admin-secret: $ADMIN_SECRET"
assert_status "200"
jq -e '.status == "failed" and .lastError == "Permanent"' "$LAST_BODY" >/dev/null

echo "Verifying sent jobs with provider identifiers cannot be retried..."
capture_request "POST" "/admin/api/outbound-jobs/$SUCCESS_OUTBOUND_JOB_ID/retry" "" "x-admin-secret: $ADMIN_SECRET"
assert_status "409"
jq -e '.error == "Outbound jobs with provider delivery events cannot be retried from the queue state"' "$LAST_BODY" >/dev/null

echo "Creating a suppression to verify reservation release on failure..."
capture_request "POST" "/v1/debug/suppressions" "{
  \"email\": \"$BLOCKED_TO_EMAIL\",
  \"reason\": \"outbound_credit_smoke\",
  \"source\": \"debug_smoke\"
}" "x-admin-secret: $ADMIN_SECRET"
assert_status "201"

echo "Sending to a suppressed external recipient..."
capture_request "POST" "/v1/mailboxes/self/send" "{
  \"to\": [\"$BLOCKED_TO_EMAIL\"],
  \"subject\": \"Credit smoke blocked\",
  \"text\": \"This should fail and release the reserved credit.\"
}" "authorization: Bearer $MAILBOX_TOKEN"
assert_status "202"
BLOCKED_OUTBOUND_JOB_ID="$(jq -r '.outboundJobId' "$LAST_BODY")"

wait_for_job_status "$BLOCKED_OUTBOUND_JOB_ID" "failed"

echo "Waiting for reserved credit release after the blocked send..."
wait_for_billing_account_state "$((TOPUP_AVAILABLE_CREDITS - 1))" "$TOPUP_RESERVED_CREDITS"

capture_request "GET" "/v1/billing/account" "" "authorization: Bearer $TENANT_TOKEN"
assert_status "200"
jq -e --argjson topup_available "$TOPUP_AVAILABLE_CREDITS" --argjson topup_reserved "$TOPUP_RESERVED_CREDITS" '
  .availableCredits == ($topup_available - 1) and
  .reservedCredits == $topup_reserved
' "$LAST_BODY" >/dev/null

wait_for_credit_ledger_absence "$BLOCKED_OUTBOUND_JOB_ID"

capture_request "GET" "/v1/billing/ledger?limit=20" "" "authorization: Bearer $TENANT_TOKEN"
assert_status "200"
jq -e --arg blocked "$BLOCKED_OUTBOUND_JOB_ID" '
  (.items | map(select(.referenceId == $blocked)) | length) == 0
' "$LAST_BODY" >/dev/null

echo "Outbound credit smoke flow completed."
echo "Tenant ID: $TENANT_ID"
echo "Mailbox ID: $MAILBOX_ID"
echo "Success outbound job: $SUCCESS_OUTBOUND_JOB_ID"
echo "Blocked outbound job: $BLOCKED_OUTBOUND_JOB_ID"
