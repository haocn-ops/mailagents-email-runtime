#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
ADMIN_SECRET="${ADMIN_API_SECRET_FOR_SMOKE:-replace-with-admin-api-secret}"
TENANT_ID="${TENANT_ID:-t_billing_smoke_$(date +%s)}"
AUTH_SCOPE="${AUTH_SCOPE_FOR_SMOKE:-task:read}"
RUN_ID="${RUN_ID_FOR_SMOKE:-$(date +%s)}"
TOPUP_PAYMENT_SIGNATURE="${X402_TOPUP_PAYMENT_SIGNATURE_FOR_SMOKE:-$(printf '{"tx":"local-smoke-topup-%s-%s"}' "$TENANT_ID" "$RUN_ID" | base64 | tr -d '\n')}"
UPGRADE_PAYMENT_SIGNATURE="${X402_UPGRADE_PAYMENT_SIGNATURE_FOR_SMOKE:-$(printf '{"tx":"local-smoke-upgrade-%s-%s"}' "$TENANT_ID" "$RUN_ID" | base64 | tr -d '\n')}"
PAYMENT_CONFIRM_MODE="${PAYMENT_CONFIRM_MODE_FOR_SMOKE:-facilitator}"
UPGRADE_INCLUDED_CREDITS="${UPGRADE_INCLUDED_CREDITS_FOR_SMOKE:-10000}"
EXPECTED_TOPUP_FAILURE_STAGE="${EXPECT_TOPUP_FAILURE_STAGE_FOR_SMOKE:-}"

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

if [[ "$PAYMENT_CONFIRM_MODE" != "facilitator" ]]; then
  echo "PAYMENT_CONFIRM_MODE_FOR_SMOKE=manual is no longer supported by /v1/billing/payment/confirm." >&2
  echo "Use facilitator mode (the current default) for local billing smoke." >&2
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
EXPECTED_DID_HOST="$(printf '%s' "$BASE_URL" | jq -sRr 'split("/") | .[2] | @uri')"
jq -e --arg tenant "$TENANT_ID" --arg did_host "$EXPECTED_DID_HOST" --arg base_url "$BASE_URL" '
  .tenantId == $tenant and
  .did == ("did:web:" + $did_host + ":did:tenants:" + $tenant) and
  .method == "did:web" and
  .documentUrl == (($base_url | sub("/$"; "")) + "/did/tenants/" + $tenant + "/did.json") and
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

echo "Verifying tenant cannot self-mark DID as verified..."
capture_request "PUT" "/v1/tenants/$TENANT_ID/did" '{
  "did": "did:web:malicious.example",
  "method": "did:web",
  "documentUrl": "https://malicious.example/.well-known/did.json",
  "status": "verified"
}' "authorization: Bearer $TOKEN"
assert_status "403"
jq -e '.error == "Tenants cannot self-mark DID bindings as verified"' "$LAST_BODY" >/dev/null

echo "Verifying tenant cannot set platform-managed DID verification fields..."
capture_request "PUT" "/v1/tenants/$TENANT_ID/did" '{
  "did": "did:web:pending.example",
  "method": "did:web",
  "documentUrl": "https://pending.example/.well-known/did.json",
  "status": "pending",
  "verificationMethodId": "did:web:pending.example#key-1",
  "verifiedAt": "2025-01-01T00:00:00.000Z",
  "service": []
}' "authorization: Bearer $TOKEN"
assert_status "403"
jq -e '.error == "verificationMethodId and verifiedAt are managed by the platform"' "$LAST_BODY" >/dev/null

echo "Verifying pending DID bindings are not published publicly..."
capture_request "PUT" "/v1/tenants/$TENANT_ID/did" '{
  "did": "did:web:pending.example",
  "method": "did:web",
  "documentUrl": "https://pending.example/.well-known/did.json",
  "status": "pending",
  "service": []
}' "authorization: Bearer $TOKEN"
assert_status "200"
capture_request "GET" "/did/tenants/$TENANT_ID/did.json" ""
assert_status "404"
jq -e '.error == "DID document not found"' "$LAST_BODY" >/dev/null

echo "Restoring hosted did:web binding..."
capture_request "POST" "/v1/tenants/$TENANT_ID/did/hosted" "" "authorization: Bearer $TOKEN"
assert_status "200"
DID="$(jq -r '.did' "$LAST_BODY")"
DOCUMENT_URL="$(jq -r '.documentUrl' "$LAST_BODY")"

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
  .quote.paymentRequirements.extra.credits == 25
' "$LAST_BODY" >/dev/null

echo "Submitting topup proof..."
capture_request "POST" "/v1/billing/topup" '{"credits":25}' \
  "authorization: Bearer $TOKEN" \
  "payment-signature: $TOPUP_PAYMENT_SIGNATURE"
if [[ -n "$EXPECTED_TOPUP_FAILURE_STAGE" ]]; then
  assert_status "402"
  TOPUP_RECEIPT_ID="$(jq -r '.receiptId' "$LAST_BODY")"
  if [[ -z "$TOPUP_RECEIPT_ID" || "$TOPUP_RECEIPT_ID" == "null" ]]; then
    echo "Expected facilitator failure response to include receiptId" >&2
    cat "$LAST_BODY" >&2
    exit 1
  fi

  case "$EXPECTED_TOPUP_FAILURE_STAGE" in
    verify)
      jq -e '
        .receiptId == .receipt.id and
        .receipt.receiptType == "topup" and
        .receipt.status == "failed" and
        .verificationStatus == "failed" and
        .settlement.type == "verify" and
        .settlement.isValid == false
      ' "$LAST_BODY" >/dev/null
      ;;
    settle)
      jq -e '
        .receiptId == .receipt.id and
        .receipt.receiptType == "topup" and
        .receipt.status == "verified" and
        .verificationStatus == "failed" and
        .settlement.type == "settle" and
        .settlement.settled == false
      ' "$LAST_BODY" >/dev/null
      ;;
    *)
      echo "Unsupported EXPECT_TOPUP_FAILURE_STAGE_FOR_SMOKE value: $EXPECTED_TOPUP_FAILURE_STAGE" >&2
      exit 1
      ;;
  esac

  capture_request "GET" "/v1/billing/receipts?limit=5" "" "authorization: Bearer $TOKEN"
  assert_status "200"
  jq -e --arg receipt "$TOPUP_RECEIPT_ID" '
    .items | any(.id == $receipt)
  ' "$LAST_BODY" >/dev/null

  echo "Verified facilitator failure response includes receiptId and persisted receipt."
  exit 0
fi
if [[ "$LAST_STATUS" != "200" && "$LAST_STATUS" != "202" ]]; then
  echo "Expected HTTP 200 or 202 but received $LAST_STATUS" >&2
  cat "$LAST_BODY" >&2
  exit 1
fi
TOPUP_RECEIPT_ID="$(jq -r '.receipt.id' "$LAST_BODY")"
jq -e '
  .receipt.receiptType == "topup" and
  (.receipt.status == "pending" or .receipt.status == "settled") and
  (
    (
      .creditsRequested == 25 and
      (.verificationStatus == "pending" or .verificationStatus == "settled")
    ) or (
      .verificationStatus == "settled" and
      .ledgerEntry.entryType == "topup" and
      .ledgerEntry.creditsDelta == 25 and
      .account.availableCredits == 25
    )
  )
' "$LAST_BODY" >/dev/null

echo "Replaying the same topup proof returns the same receipt..."
capture_request "POST" "/v1/billing/topup" '{"credits":25}' \
  "authorization: Bearer $TOKEN" \
  "payment-signature: $TOPUP_PAYMENT_SIGNATURE"
if [[ "$LAST_STATUS" != "200" && "$LAST_STATUS" != "202" ]]; then
  echo "Expected replay HTTP 200 or 202 but received $LAST_STATUS" >&2
  cat "$LAST_BODY" >&2
  exit 1
fi
jq -e --arg receipt "$TOPUP_RECEIPT_ID" '
  .receipt.id == $receipt and
  .receipt.receiptType == "topup" and
  (.verificationStatus == "pending" or .verificationStatus == "settled")
' "$LAST_BODY" >/dev/null

echo "Confirming topup settlement..."
CONFIRM_HEADERS=()
while IFS= read -r header; do
  CONFIRM_HEADERS+=("$header")
done < <(append_confirm_headers)
capture_request "POST" "/v1/billing/payment/confirm" "{
  \"receiptId\": \"$TOPUP_RECEIPT_ID\"
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
  .quote.targetPricingTier == "paid_review" and
  .quote.includedCredits > 0
' "$LAST_BODY" >/dev/null

echo "Submitting upgrade proof..."
capture_request "POST" "/v1/billing/upgrade-intent" '{"targetPricingTier":"paid_review"}' \
  "authorization: Bearer $TOKEN" \
  "payment-signature: $UPGRADE_PAYMENT_SIGNATURE"
if [[ "$LAST_STATUS" != "200" && "$LAST_STATUS" != "202" ]]; then
  echo "Expected HTTP 200 or 202 but received $LAST_STATUS" >&2
  cat "$LAST_BODY" >&2
  exit 1
fi
UPGRADE_RECEIPT_ID="$(jq -r '.receipt.id' "$LAST_BODY")"
jq -e '
  .receipt.receiptType == "upgrade" and
  (.receipt.status == "pending" or .receipt.status == "settled") and
  (
    (
      .targetPricingTier == "paid_review" and
      (.verificationStatus == "pending" or .verificationStatus == "settled")
    ) or (
      .verificationStatus == "settled" and
      .includedCredits > 0 and
      .account.pricingTier == "paid_active" and
      .sendPolicy.pricingTier == "paid_active" and
      .sendPolicy.outboundStatus == "external_enabled" and
      .sendPolicy.externalSendEnabled == true and
      .sendPolicy.reviewRequired == false
    )
  )
' "$LAST_BODY" >/dev/null

echo "Replaying the same upgrade proof returns the same receipt..."
capture_request "POST" "/v1/billing/upgrade-intent" '{"targetPricingTier":"paid_review"}' \
  "authorization: Bearer $TOKEN" \
  "payment-signature: $UPGRADE_PAYMENT_SIGNATURE"
if [[ "$LAST_STATUS" != "200" && "$LAST_STATUS" != "202" ]]; then
  echo "Expected replay HTTP 200 or 202 but received $LAST_STATUS" >&2
  cat "$LAST_BODY" >&2
  exit 1
fi
jq -e --arg receipt "$UPGRADE_RECEIPT_ID" '
  .receipt.id == $receipt and
  .receipt.receiptType == "upgrade" and
  (.verificationStatus == "pending" or .verificationStatus == "settled")
' "$LAST_BODY" >/dev/null

echo "Confirming upgrade settlement..."
CONFIRM_HEADERS=()
while IFS= read -r header; do
  CONFIRM_HEADERS+=("$header")
done < <(append_confirm_headers)
capture_request "POST" "/v1/billing/payment/confirm" "{
  \"receiptId\": \"$UPGRADE_RECEIPT_ID\"
}" "${CONFIRM_HEADERS[@]}"
assert_status "200"
jq -e --argjson upgrade_included_credits "$UPGRADE_INCLUDED_CREDITS" '
  .receipt.status == "settled" and
  .includedCredits == $upgrade_included_credits and
  .ledgerEntry.entryType == "adjustment" and
  .ledgerEntry.creditsDelta == $upgrade_included_credits and
  .account.pricingTier == "paid_active" and
  .sendPolicy.pricingTier == "paid_active" and
  .sendPolicy.outboundStatus == "external_enabled" and
  .sendPolicy.externalSendEnabled == true and
  .sendPolicy.reviewRequired == false and
  .verificationStatus == "settled"
' "$LAST_BODY" >/dev/null

echo "Re-checking final billing account and send policy..."
capture_request "GET" "/v1/billing/account" "" "authorization: Bearer $TOKEN"
assert_status "200"
jq -e --argjson upgrade_included_credits "$UPGRADE_INCLUDED_CREDITS" '
  .pricingTier == "paid_active" and
  .availableCredits == (25 + $upgrade_included_credits)
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
