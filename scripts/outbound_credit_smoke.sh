#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
ADMIN_SECRET="${ADMIN_API_SECRET_FOR_SMOKE:-replace-with-admin-api-secret}"
TENANT_ID="${TENANT_ID:-t_demo}"
AGENT_ID="${AGENT_ID:-agt_demo}"
MAILBOX_ID="${MAILBOX_ID:-mbx_demo}"
SUCCESS_TO_EMAIL="${SUCCESS_TO_EMAIL:-credit-success-$(date +%s)@example.com}"
BLOCKED_TO_EMAIL="${BLOCKED_TO_EMAIL:-credit-blocked-$(date +%s)@example.com}"
PAYMENT_SIGNATURE="${X402_PAYMENT_SIGNATURE_FOR_SMOKE:-eyJ0eCI6ImxvY2FsLWNyZWRpdC1zbW9rZSJ9}"

TEMP_FILES=()
LAST_HEADERS=""
LAST_BODY=""
LAST_STATUS=""
TOKEN=""

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

trap cleanup EXIT

load_local_secrets
wait_for_server

if [[ "$ADMIN_SECRET" == "replace-with-admin-api-secret" ]]; then
  echo "Missing admin secret. Set ADMIN_API_SECRET_FOR_SMOKE or configure ADMIN_API_SECRET in .dev.vars." >&2
  exit 1
fi

echo "Minting seeded demo tenant bearer token..."
capture_request "POST" "/v1/auth/tokens" "{
  \"sub\": \"outbound-credit-smoke\",
  \"tenantId\": \"$TENANT_ID\",
  \"agentId\": \"$AGENT_ID\",
  \"mailboxIds\": [\"$MAILBOX_ID\"],
  \"scopes\": [\"draft:create\", \"draft:send\", \"draft:read\", \"mail:read\"],
  \"expiresInSeconds\": 3600
}" "x-admin-secret: $ADMIN_SECRET"
assert_status "201"
TOKEN="$(jq -r '.token' "$LAST_BODY")"

echo "Checking seeded self mailbox..."
capture_request "GET" "/v1/mailboxes/self" "" "authorization: Bearer $TOKEN"
assert_status "200"
jq -e --arg mailbox "$MAILBOX_ID" '.id == $mailbox and .status == "active"' "$LAST_BODY" >/dev/null

echo "Top up demo tenant credits..."
capture_request "POST" "/v1/billing/topup" '{"credits":5}' \
  "authorization: Bearer $TOKEN" \
  "payment-signature: $PAYMENT_SIGNATURE"
assert_status "202"
TOPUP_RECEIPT_ID="$(jq -r '.receipt.id' "$LAST_BODY")"

capture_request "POST" "/v1/billing/payment/confirm" "{
  \"receiptId\": \"$TOPUP_RECEIPT_ID\",
  \"settlementReference\": \"smoke-credit-topup-$TENANT_ID\"
}" "authorization: Bearer $TOKEN" "x-admin-secret: $ADMIN_SECRET"
assert_status "200"
jq -e '.account.availableCredits >= 5 and .account.reservedCredits == 0' "$LAST_BODY" >/dev/null

echo "Enabling external sending for the demo tenant..."
capture_request "PUT" "/v1/tenants/$TENANT_ID/send-policy" '{
  "pricingTier": "paid_active",
  "outboundStatus": "external_enabled",
  "internalDomainAllowlist": ["mailagents.net"],
  "externalSendEnabled": true,
  "reviewRequired": false
}' "authorization: Bearer $TOKEN"
assert_status "200"
jq -e '.pricingTier == "paid_active" and .outboundStatus == "external_enabled" and .externalSendEnabled == true' "$LAST_BODY" >/dev/null

echo "Sending an external email to verify credit reservation..."
capture_request "POST" "/v1/mailboxes/self/send" "{
  \"to\": [\"$SUCCESS_TO_EMAIL\"],
  \"subject\": \"Credit smoke success\",
  \"text\": \"Testing outbound credit reservation and capture.\"
}" "authorization: Bearer $TOKEN"
assert_status "202"
SUCCESS_OUTBOUND_JOB_ID="$(jq -r '.outboundJobId' "$LAST_BODY")"

capture_request "GET" "/v1/billing/account" "" "authorization: Bearer $TOKEN"
assert_status "200"
jq -e '
  .availableCredits == 4 and
  .reservedCredits == 1
' "$LAST_BODY" >/dev/null

echo "Waiting for successful send capture..."
wait_for_job_status "$SUCCESS_OUTBOUND_JOB_ID" "sent"

capture_request "GET" "/v1/billing/account" "" "authorization: Bearer $TOKEN"
assert_status "200"
jq -e '
  .availableCredits == 4 and
  .reservedCredits == 0
' "$LAST_BODY" >/dev/null

capture_request "GET" "/v1/billing/ledger?limit=10" "" "authorization: Bearer $TOKEN"
assert_status "200"
jq -e --arg outbound "$SUCCESS_OUTBOUND_JOB_ID" '
  (.items | map(select(.entryType == "debit_send" and .referenceId == $outbound)) | length) == 1 and
  (.items | map(select(.entryType == "debit_send" and .referenceId == $outbound))[0].creditsDelta) == -1
' "$LAST_BODY" >/dev/null

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
}" "authorization: Bearer $TOKEN"
assert_status "202"
BLOCKED_OUTBOUND_JOB_ID="$(jq -r '.outboundJobId' "$LAST_BODY")"

wait_for_job_status "$BLOCKED_OUTBOUND_JOB_ID" "failed"

capture_request "GET" "/v1/billing/account" "" "authorization: Bearer $TOKEN"
assert_status "200"
jq -e '
  .availableCredits == 4 and
  .reservedCredits == 0
' "$LAST_BODY" >/dev/null

capture_request "GET" "/v1/billing/ledger?limit=20" "" "authorization: Bearer $TOKEN"
assert_status "200"
jq -e --arg blocked "$BLOCKED_OUTBOUND_JOB_ID" '
  (.items | map(select(.referenceId == $blocked)) | length) == 0
' "$LAST_BODY" >/dev/null

echo "Outbound credit smoke flow completed."
echo "Tenant ID: $TENANT_ID"
echo "Mailbox ID: $MAILBOX_ID"
echo "Success outbound job: $SUCCESS_OUTBOUND_JOB_ID"
echo "Blocked outbound job: $BLOCKED_OUTBOUND_JOB_ID"
