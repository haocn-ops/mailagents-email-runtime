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

TEMP_FILES=()
LAST_HEADERS=""
LAST_BODY=""
LAST_STATUS=""
TOKEN=""
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

  LAST_HEADERS="$(mktemp -t mailagents-uncertain-headers.XXXXXX)"
  LAST_BODY="$(mktemp -t mailagents-uncertain-body.XXXXXX)"
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

seed_uncertain_job() {
  local draft_id="$1"
  local draft_r2_key="$2"
  local recipient="$3"
  local subject="$4"
  local message_id="$5"
  local outbound_job_id="$6"
  local evidence_mode="${7:-none}"
  local timestamp
  local delivery_sql=""

  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  if [[ "$evidence_mode" == "delivery" ]]; then
    delivery_sql="
INSERT INTO delivery_events (
  id, message_id, provider, provider_message_id, event_type, payload_r2_key, created_at
) VALUES (
  'evt_${outbound_job_id}', '$message_id', 'ses', 'mock-provider-${outbound_job_id}', 'delivery', 'events/smoke/${outbound_job_id}.json', '$timestamp'
);"
  fi

  exec_sql "
BEGIN TRANSACTION;
UPDATE tenant_billing_accounts
SET available_credits = available_credits - 1,
    reserved_credits = reserved_credits + 1,
    updated_at = '$timestamp'
WHERE tenant_id = '$TENANT_ID';
UPDATE drafts
SET status = 'failed',
    updated_at = '$timestamp'
WHERE id = '$draft_id';
INSERT INTO messages (
  id, tenant_id, mailbox_id, thread_id, direction, provider, internet_message_id,
  provider_message_id, from_addr, to_addr, subject, snippet, status, raw_r2_key,
  normalized_r2_key, received_at, sent_at, created_at
) VALUES (
  '$message_id', '$TENANT_ID', '$MAILBOX_ID', NULL, 'outbound', 'ses', NULL,
  NULL, '$MAILBOX_ADDRESS', '$recipient', '$subject', NULL, 'failed', NULL,
  NULL, NULL, NULL, '$timestamp'
);
INSERT INTO outbound_jobs (
  id, message_id, task_id, status, ses_region, retry_count, next_retry_at,
  last_error, draft_r2_key, created_at, updated_at
) VALUES (
  '$outbound_job_id', '$message_id', NULL, 'failed', 'us-east-1', 1, NULL,
  'send_attempt_uncertain_manual_review_required', '$draft_r2_key', '$timestamp', '$timestamp'
);
$delivery_sql
COMMIT;"
}

create_manual_resolution_draft() {
  local recipient="$1"
  local subject="$2"

  capture_request "POST" "/v1/agents/$AGENT_ID/drafts" "{
    \"tenantId\": \"$TENANT_ID\",
    \"mailboxId\": \"$MAILBOX_ID\",
    \"from\": \"$MAILBOX_ADDRESS\",
    \"to\": [\"$recipient\"],
    \"subject\": \"$subject\",
    \"text\": \"Testing uncertain send manual resolution.\"
  }" "authorization: Bearer $TOKEN"
  assert_status "201"
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

echo "Minting seeded demo tenant bearer token..."
capture_request "POST" "/v1/auth/tokens" "{
  \"sub\": \"outbound-uncertain-smoke\",
  \"tenantId\": \"$TENANT_ID\",
  \"agentId\": \"$AGENT_ID\",
  \"mailboxIds\": [\"$MAILBOX_ID\"],
  \"scopes\": [\"draft:create\", \"draft:send\", \"draft:read\", \"mail:read\"],
  \"expiresInSeconds\": 3600
}" "x-admin-secret: $ADMIN_SECRET"
assert_status "201"
TOKEN="$(jq -r '.token' "$LAST_BODY")"

echo "Loading seeded mailbox..."
capture_request "GET" "/v1/mailboxes/self" "" "authorization: Bearer $TOKEN"
assert_status "200"
MAILBOX_ADDRESS="$(jq -r '.address' "$LAST_BODY")"
jq -e --arg mailbox "$MAILBOX_ID" '.id == $mailbox and .status == "active"' "$LAST_BODY" >/dev/null

echo "Resetting demo tenant outbound and billing state..."
reset_demo_outbound_state

echo "Capturing starting billing balance..."
capture_request "GET" "/v1/billing/account" "" "authorization: Bearer $TOKEN"
assert_status "200"
STARTING_AVAILABLE_CREDITS="$(jq -r '.availableCredits' "$LAST_BODY")"
STARTING_RESERVED_CREDITS="$(jq -r '.reservedCredits' "$LAST_BODY")"

echo "Seeding demo tenant credits directly for uncertain-send smoke..."
seed_available_credits 5

capture_request "GET" "/v1/billing/account" "" "authorization: Bearer $TOKEN"
assert_status "200"
TOPUP_AVAILABLE_CREDITS="$(jq -r '.availableCredits' "$LAST_BODY")"
TOPUP_RESERVED_CREDITS="$(jq -r '.reservedCredits' "$LAST_BODY")"
jq -e --argjson start_available "$STARTING_AVAILABLE_CREDITS" --argjson start_reserved "$STARTING_RESERVED_CREDITS" '
  .availableCredits == ($start_available + 5) and
  .reservedCredits == $start_reserved
' "$LAST_BODY" >/dev/null

echo "Enabling external sending for the demo tenant..."
capture_request "PUT" "/v1/tenants/$TENANT_ID/send-policy" '{
  "pricingTier": "paid_active",
  "outboundStatus": "external_enabled",
  "internalDomainAllowlist": ["mailagents.net"],
  "externalSendEnabled": true,
  "reviewRequired": false
}' "x-admin-secret: $ADMIN_SECRET"
assert_status "200"

echo "Creating uncertain job that should be released as not_sent..."
RECIPIENT_NOT_SENT="uncertain-not-sent-$RUN_ID@example.com"
SUBJECT_NOT_SENT="Uncertain manual resolution not_sent"
create_manual_resolution_draft "$RECIPIENT_NOT_SENT" "$SUBJECT_NOT_SENT"
NOT_SENT_DRAFT_ID="$(jq -r '.id' "$LAST_BODY")"
NOT_SENT_DRAFT_R2_KEY="$(jq -r '.draftR2Key' "$LAST_BODY")"
NOT_SENT_MESSAGE_ID="msg_uncertain_not_sent_${RUN_ID}"
NOT_SENT_JOB_ID="obj_uncertain_not_sent_${RUN_ID}"
seed_uncertain_job "$NOT_SENT_DRAFT_ID" "$NOT_SENT_DRAFT_R2_KEY" "$RECIPIENT_NOT_SENT" "$SUBJECT_NOT_SENT" "$NOT_SENT_MESSAGE_ID" "$NOT_SENT_JOB_ID"

capture_request "GET" "/v1/billing/account" "" "authorization: Bearer $TOKEN"
assert_status "200"
jq -e --argjson topup_available "$TOPUP_AVAILABLE_CREDITS" --argjson topup_reserved "$TOPUP_RESERVED_CREDITS" '
  .availableCredits == ($topup_available - 1) and
  .reservedCredits == ($topup_reserved + 1)
' "$LAST_BODY" >/dev/null

capture_request "POST" "/admin/api/outbound-jobs/$NOT_SENT_JOB_ID/manual-resolution" '{
  "resolution": "not_sent"
}' "x-admin-secret: $ADMIN_SECRET"
assert_status "200"
jq -e '.ok == true and .status == "failed" and .billingResolution == "released"' "$LAST_BODY" >/dev/null

capture_request "GET" "/v1/billing/account" "" "authorization: Bearer $TOKEN"
assert_status "200"
jq -e --argjson topup_available "$TOPUP_AVAILABLE_CREDITS" --argjson topup_reserved "$TOPUP_RESERVED_CREDITS" '
  .availableCredits == $topup_available and
  .reservedCredits == $topup_reserved
' "$LAST_BODY" >/dev/null

capture_request "GET" "/v1/debug/outbound-jobs/$NOT_SENT_JOB_ID" "" "x-admin-secret: $ADMIN_SECRET"
assert_status "200"
jq -e '.status == "failed" and .lastError == "manual_send_not_sent_confirmed"' "$LAST_BODY" >/dev/null

capture_request "GET" "/v1/debug/messages/$NOT_SENT_MESSAGE_ID" "" "x-admin-secret: $ADMIN_SECRET"
assert_status "200"
jq -e '.message.status == "failed"' "$LAST_BODY" >/dev/null

capture_request "GET" "/v1/debug/drafts/$NOT_SENT_DRAFT_ID" "" "x-admin-secret: $ADMIN_SECRET"
assert_status "200"
jq -e '.draft.status == "failed"' "$LAST_BODY" >/dev/null

echo "Creating uncertain job that should be settled as sent..."
RECIPIENT_SENT="uncertain-sent-$RUN_ID@example.com"
SUBJECT_SENT="Uncertain manual resolution sent"
create_manual_resolution_draft "$RECIPIENT_SENT" "$SUBJECT_SENT"
SENT_DRAFT_ID="$(jq -r '.id' "$LAST_BODY")"
SENT_DRAFT_R2_KEY="$(jq -r '.draftR2Key' "$LAST_BODY")"
SENT_MESSAGE_ID="msg_uncertain_sent_${RUN_ID}"
SENT_JOB_ID="obj_uncertain_sent_${RUN_ID}"
seed_uncertain_job "$SENT_DRAFT_ID" "$SENT_DRAFT_R2_KEY" "$RECIPIENT_SENT" "$SUBJECT_SENT" "$SENT_MESSAGE_ID" "$SENT_JOB_ID"

capture_request "POST" "/admin/api/outbound-jobs/$SENT_JOB_ID/manual-resolution" '{
  "resolution": "sent"
}' "x-admin-secret: $ADMIN_SECRET"
assert_status "200"
jq -e '.ok == true and .status == "sent" and .billingResolution == "settled"' "$LAST_BODY" >/dev/null

capture_request "GET" "/v1/billing/account" "" "authorization: Bearer $TOKEN"
assert_status "200"
jq -e --argjson topup_available "$TOPUP_AVAILABLE_CREDITS" --argjson topup_reserved "$TOPUP_RESERVED_CREDITS" '
  .availableCredits == ($topup_available - 1) and
  .reservedCredits == $topup_reserved
' "$LAST_BODY" >/dev/null

capture_request "GET" "/v1/billing/ledger?limit=20" "" "authorization: Bearer $TOKEN"
assert_status "200"
jq -e --arg outbound "$SENT_JOB_ID" '
  (.items | map(select(.entryType == "debit_send" and .referenceId == $outbound)) | length) == 1 and
  (.items | map(select(.entryType == "debit_send" and .referenceId == $outbound))[0].creditsDelta) == -1
' "$LAST_BODY" >/dev/null

capture_request "GET" "/v1/debug/messages/$SENT_MESSAGE_ID" "" "x-admin-secret: $ADMIN_SECRET"
assert_status "200"
jq -e '.message.status == "replied"' "$LAST_BODY" >/dev/null

capture_request "GET" "/v1/debug/drafts/$SENT_DRAFT_ID" "" "x-admin-secret: $ADMIN_SECRET"
assert_status "200"
jq -e '.draft.status == "sent"' "$LAST_BODY" >/dev/null

echo "Creating uncertain job with delivery evidence to verify not_sent is rejected..."
RECIPIENT_EVIDENCE="uncertain-evidence-$RUN_ID@example.com"
SUBJECT_EVIDENCE="Uncertain manual resolution evidence"
create_manual_resolution_draft "$RECIPIENT_EVIDENCE" "$SUBJECT_EVIDENCE"
EVIDENCE_DRAFT_ID="$(jq -r '.id' "$LAST_BODY")"
EVIDENCE_DRAFT_R2_KEY="$(jq -r '.draftR2Key' "$LAST_BODY")"
EVIDENCE_MESSAGE_ID="msg_uncertain_evidence_${RUN_ID}"
EVIDENCE_JOB_ID="obj_uncertain_evidence_${RUN_ID}"
seed_uncertain_job "$EVIDENCE_DRAFT_ID" "$EVIDENCE_DRAFT_R2_KEY" "$RECIPIENT_EVIDENCE" "$SUBJECT_EVIDENCE" "$EVIDENCE_MESSAGE_ID" "$EVIDENCE_JOB_ID" "delivery"

capture_request "POST" "/admin/api/outbound-jobs/$EVIDENCE_JOB_ID/manual-resolution" '{
  "resolution": "not_sent"
}' "x-admin-secret: $ADMIN_SECRET"
assert_status "409"
jq -e '.error == "Outbound job already has delivery evidence and cannot be resolved as not_sent"' "$LAST_BODY" >/dev/null

capture_request "POST" "/admin/api/outbound-jobs/$EVIDENCE_JOB_ID/manual-resolution" '{
  "resolution": "sent"
}' "x-admin-secret: $ADMIN_SECRET"
assert_status "200"
jq -e '.ok == true and .status == "sent" and .billingResolution == "settled"' "$LAST_BODY" >/dev/null

capture_request "GET" "/v1/billing/account" "" "authorization: Bearer $TOKEN"
assert_status "200"
jq -e --argjson topup_available "$TOPUP_AVAILABLE_CREDITS" --argjson topup_reserved "$TOPUP_RESERVED_CREDITS" '
  .availableCredits == ($topup_available - 2) and
  .reservedCredits == $topup_reserved
' "$LAST_BODY" >/dev/null

echo "Creating uncertain job with a missing draft payload to verify manual resolution fails closed..."
RECIPIENT_MISSING="uncertain-missing-$RUN_ID@example.com"
SUBJECT_MISSING="Uncertain manual resolution missing payload"
create_manual_resolution_draft "$RECIPIENT_MISSING" "$SUBJECT_MISSING"
MISSING_DRAFT_ID="$(jq -r '.id' "$LAST_BODY")"
MISSING_DRAFT_R2_KEY="$(jq -r '.draftR2Key' "$LAST_BODY")"
MISSING_MESSAGE_ID="msg_uncertain_missing_${RUN_ID}"
MISSING_JOB_ID="obj_uncertain_missing_${RUN_ID}"
MISSING_R2_KEY="drafts/missing-payload/${MISSING_DRAFT_ID}.json"
seed_uncertain_job "$MISSING_DRAFT_ID" "$MISSING_DRAFT_R2_KEY" "$RECIPIENT_MISSING" "$SUBJECT_MISSING" "$MISSING_MESSAGE_ID" "$MISSING_JOB_ID"

exec_sql "
BEGIN TRANSACTION;
UPDATE drafts
SET draft_r2_key = '$MISSING_R2_KEY'
WHERE id = '$MISSING_DRAFT_ID';
UPDATE outbound_jobs
SET draft_r2_key = '$MISSING_R2_KEY'
WHERE id = '$MISSING_JOB_ID';
COMMIT;"

capture_request "POST" "/admin/api/outbound-jobs/$MISSING_JOB_ID/manual-resolution" '{
  "resolution": "sent"
}' "x-admin-secret: $ADMIN_SECRET"
assert_status "502"
jq -e '.error == "Draft payload not found"' "$LAST_BODY" >/dev/null

capture_request "GET" "/v1/debug/outbound-jobs/$MISSING_JOB_ID" "" "x-admin-secret: $ADMIN_SECRET"
assert_status "200"
jq -e '.status == "failed" and .lastError == "send_attempt_uncertain_manual_review_required"' "$LAST_BODY" >/dev/null

echo "Outbound uncertain manual resolution smoke flow completed."
echo "Tenant ID: $TENANT_ID"
echo "Mailbox ID: $MAILBOX_ID"
echo "Released uncertain job: $NOT_SENT_JOB_ID"
echo "Settled uncertain job: $SENT_JOB_ID"
echo "Evidence uncertain job: $EVIDENCE_JOB_ID"
echo "Missing-payload uncertain job: $MISSING_JOB_ID"
