#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
ADMIN_SECRET="${ADMIN_API_SECRET_FOR_SMOKE:-replace-with-admin-api-secret}"
TENANT_ID="${TENANT_ID:-t_billing_smoke_$(date +%s)}"
AUTH_SCOPE="${AUTH_SCOPE_FOR_SMOKE:-task:read}"
PAYMENT_SIGNATURE="${X402_PAYMENT_SIGNATURE_FOR_SMOKE:-eyJ0eCI6ImxvY2FsLXNtb2tlIn0=}"
PAYMENT_CONFIRM_MODE="${PAYMENT_CONFIRM_MODE_FOR_SMOKE:-manual}"

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

  LAST_HEADERS="$(mktemp -t mailagents-billing-headers.XXXXXX)"
  LAST_BODY="$(mktemp -t mailagents-billing-body.XXXXXX)"
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

header_value() {
  local name="$1"
  local target
  target="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
  awk -F': ' -v target="$target" '
    BEGIN { IGNORECASE = 1 }
    {
      gsub(/\r$/, "", $0)
      if (tolower($1) == target) {
        print $2
        exit
      }
    }
  ' "$LAST_HEADERS"
}

assert_status() {
  local expected="$1"
  if [[ "$LAST_STATUS" != "$expected" ]]; then
    echo "Expected HTTP $expected but received $LAST_STATUS" >&2
    cat "$LAST_BODY" >&2
    exit 1
  fi
}

append_confirm_headers() {
  local headers=()
  headers+=("authorization: Bearer $TOKEN")
  if [[ "$PAYMENT_CONFIRM_MODE" == "manual" ]]; then
    headers+=("x-admin-secret: $ADMIN_SECRET")
  fi
  printf '%s\n' "${headers[@]}"
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

echo "Minting tenant-scoped bearer token..."
capture_request "POST" "/v1/auth/tokens" "{
  \"sub\": \"billing-did-smoke\",
  \"tenantId\": \"$TENANT_ID\",
  \"scopes\": [\"$AUTH_SCOPE\"],
  \"expiresInSeconds\": 3600
}" "x-admin-secret: $ADMIN_SECRET"
assert_status "201"
TOKEN="$(jq -r '.token' "$LAST_BODY")"
jq -e '.token and .expiresAt' "$LAST_BODY" >/dev/null

echo "Checking default billing account..."
capture_request "GET" "/v1/billing/account" "" "authorization: Bearer $TOKEN"
assert_status "200"
jq -e --arg tenant "$TENANT_ID" '
  .tenantId == $tenant and
  .status == "trial" and
  .pricingTier == "free" and
  .availableCredits == 0 and
  .reservedCredits == 0
' "$LAST_BODY" >/dev/null

echo "Checking default tenant send policy..."
capture_request "GET" "/v1/tenants/$TENANT_ID/send-policy" "" "authorization: Bearer $TOKEN"
assert_status "200"
jq -e --arg tenant "$TENANT_ID" '
  .tenantId == $tenant and
  .pricingTier == "free" and
  .outboundStatus == "internal_only" and
  .externalSendEnabled == false and
  .reviewRequired == true and
  (.internalDomainAllowlist | index("mailagents.net") != null)
' "$LAST_BODY" >/dev/null

echo "Creating hosted did:web binding..."
capture_request "POST" "/v1/tenants/$TENANT_ID/did/hosted" "" "authorization: Bearer $TOKEN"
assert_status "200"
DID="$(jq -r '.did' "$LAST_BODY")"
DOCUMENT_URL="$(jq -r '.documentUrl' "$LAST_BODY")"
jq -e --arg tenant "$TENANT_ID" '
  .tenantId == $tenant and
  .method == "did:web" and
  .status == "verified" and
  (.service | length) >= 3
' "$LAST_BODY" >/dev/null

echo "Resolving public DID document..."
capture_request "GET" "/did/tenants/$TENANT_ID/did.json" ""
assert_status "200"
jq -e --arg did "$DID" '
  .id == $did and
  (.service | length) >= 3
' "$LAST_BODY" >/dev/null

echo "Requesting x402 topup quote..."
capture_request "POST" "/v1/billing/topup" '{"credits":25}' "authorization: Bearer $TOKEN"
assert_status "402"
TOPUP_REQUIREMENT="$(header_value "payment-required")"
if [[ -z "$TOPUP_REQUIREMENT" ]]; then
  echo "Expected payment-required header for topup quote" >&2
  exit 1
fi
jq -e --arg tenant "$TENANT_ID" '
  .error == "Payment required" and
  .protocol == "x402" and
  .tenantId == $tenant and
  .quote.credits == 25 and
  .quote.paymentRequired.extra.credits == 25
' "$LAST_BODY" >/dev/null

echo "Submitting topup proof..."
capture_request "POST" "/v1/billing/topup" '{"credits":25}' \
  "authorization: Bearer $TOKEN" \
  "payment-signature: $PAYMENT_SIGNATURE"
assert_status "202"
TOPUP_RECEIPT_ID="$(jq -r '.receipt.id' "$LAST_BODY")"
jq -e '
  .receipt.receiptType == "topup" and
  .receipt.status == "pending" and
  .creditsRequested == 25 and
  .verificationStatus == "pending"
' "$LAST_BODY" >/dev/null

echo "Confirming topup settlement..."
CONFIRM_HEADERS=()
while IFS= read -r header; do
  CONFIRM_HEADERS+=("$header")
done < <(append_confirm_headers)
capture_request "POST" "/v1/billing/payment/confirm" "{
  \"receiptId\": \"$TOPUP_RECEIPT_ID\",
  \"settlementReference\": \"smoke-topup-$TENANT_ID\"
}" "${CONFIRM_HEADERS[@]}"
assert_status "200"
jq -e '
  .receipt.status == "settled" and
  .ledgerEntry.entryType == "topup" and
  .ledgerEntry.creditsDelta == 25 and
  .account.availableCredits == 25 and
  .verificationStatus == "settled"
' "$LAST_BODY" >/dev/null

echo "Checking billing ledger and receipts..."
capture_request "GET" "/v1/billing/ledger?limit=5" "" "authorization: Bearer $TOKEN"
assert_status "200"
jq -e '
  (.items | length) >= 1 and
  .items[0].entryType == "topup" and
  .items[0].creditsDelta == 25
' "$LAST_BODY" >/dev/null

capture_request "GET" "/v1/billing/receipts?limit=5" "" "authorization: Bearer $TOKEN"
assert_status "200"
jq -e '
  (.items | length) >= 1 and
  .items[0].receiptType == "topup" and
  .items[0].status == "settled"
' "$LAST_BODY" >/dev/null

echo "Requesting upgrade quote..."
capture_request "POST" "/v1/billing/upgrade-intent" '{"targetPricingTier":"paid_review"}' "authorization: Bearer $TOKEN"
assert_status "402"
UPGRADE_REQUIREMENT="$(header_value "payment-required")"
if [[ -z "$UPGRADE_REQUIREMENT" ]]; then
  echo "Expected payment-required header for upgrade quote" >&2
  exit 1
fi
jq -e '
  .error == "Payment required" and
  .protocol == "x402" and
  .quote.targetPricingTier == "paid_review"
' "$LAST_BODY" >/dev/null

echo "Submitting upgrade proof..."
capture_request "POST" "/v1/billing/upgrade-intent" '{"targetPricingTier":"paid_review"}' \
  "authorization: Bearer $TOKEN" \
  "payment-signature: $PAYMENT_SIGNATURE"
assert_status "202"
UPGRADE_RECEIPT_ID="$(jq -r '.receipt.id' "$LAST_BODY")"
jq -e '
  .receipt.receiptType == "upgrade" and
  .receipt.status == "pending" and
  .targetPricingTier == "paid_review" and
  .verificationStatus == "pending"
' "$LAST_BODY" >/dev/null

echo "Confirming upgrade settlement..."
CONFIRM_HEADERS=()
while IFS= read -r header; do
  CONFIRM_HEADERS+=("$header")
done < <(append_confirm_headers)
capture_request "POST" "/v1/billing/payment/confirm" "{
  \"receiptId\": \"$UPGRADE_RECEIPT_ID\",
  \"settlementReference\": \"smoke-upgrade-$TENANT_ID\"
}" "${CONFIRM_HEADERS[@]}"
assert_status "200"
jq -e '
  .receipt.status == "settled" and
  .account.pricingTier == "paid_review" and
  .sendPolicy.pricingTier == "paid_review" and
  .sendPolicy.outboundStatus == "external_review" and
  .sendPolicy.externalSendEnabled == false and
  .verificationStatus == "settled"
' "$LAST_BODY" >/dev/null

echo "Approving external sending..."
capture_request "POST" "/v1/tenants/$TENANT_ID/send-policy/review-decision" '{
  "decision": "approve_external"
}' "x-admin-secret: $ADMIN_SECRET"
assert_status "200"
jq -e '
  .decision == "approve_external" and
  .sendPolicy.pricingTier == "paid_active" and
  .sendPolicy.outboundStatus == "external_enabled" and
  .sendPolicy.externalSendEnabled == true and
  .account.pricingTier == "paid_active"
' "$LAST_BODY" >/dev/null

echo "Re-checking final billing account and send policy..."
capture_request "GET" "/v1/billing/account" "" "authorization: Bearer $TOKEN"
assert_status "200"
jq -e '
  .pricingTier == "paid_active" and
  .availableCredits == 25
' "$LAST_BODY" >/dev/null

capture_request "GET" "/v1/tenants/$TENANT_ID/send-policy" "" "authorization: Bearer $TOKEN"
assert_status "200"
jq -e '
  .pricingTier == "paid_active" and
  .outboundStatus == "external_enabled" and
  .externalSendEnabled == true and
  .reviewRequired == false
' "$LAST_BODY" >/dev/null

echo "Billing + DID smoke flow completed."
echo "Tenant ID: $TENANT_ID"
echo "Payment confirm mode: $PAYMENT_CONFIRM_MODE"
echo "DID: $DID"
echo "DID Document URL: $DOCUMENT_URL"
echo "Topup receipt: $TOPUP_RECEIPT_ID"
echo "Upgrade receipt: $UPGRADE_RECEIPT_ID"
