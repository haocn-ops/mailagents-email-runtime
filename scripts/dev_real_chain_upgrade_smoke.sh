#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="${BASE_URL:-https://mailagents-dev.izhenghaocn.workers.dev}"
WALLET_JSON_PATH="${WALLET_JSON_PATH:-$REPO_ROOT/.secrets/dev-base-sepolia-wallet.json}"
ETHERS_PATH="${ETHERS_PATH:-/tmp/mailagents-x402-wallet/node_modules/ethers}"
OPERATOR_EMAIL="${OPERATOR_EMAIL_FOR_SMOKE:-hello@mailagents.net}"

TEMP_FILES=()

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

new_temp() {
  local path
  path="$(mktemp -t mailagents-real-chain-upgrade.XXXXXX)"
  TEMP_FILES+=("$path")
  printf '%s\n' "$path"
}

require_cmd curl
require_cmd jq
require_cmd python3
require_cmd node

trap cleanup EXIT

if [[ ! -f "$WALLET_JSON_PATH" ]]; then
  echo "Missing wallet file: $WALLET_JSON_PATH" >&2
  echo "Create or copy a funded Base Sepolia wallet into .secrets first." >&2
  exit 1
fi

TS="$(date +%s)"
ALIAS="x402up${TS}"
SIGNUP_JSON="$(new_temp)"
DID_JSON="$(new_temp)"
QUOTE_HEADERS="$(new_temp)"
QUOTE_JSON="$(new_temp)"
PAYMENT_JSON="$(new_temp)"
PENDING_JSON="$(new_temp)"
CONFIRM_JSON="$(new_temp)"
ACCOUNT_JSON="$(new_temp)"
POLICY_JSON="$(new_temp)"
RECEIPTS_JSON="$(new_temp)"

SIGNUP_BODY="$(printf '{"mailboxAlias":"%s","agentName":"X402 Upgrade %s","operatorEmail":"%s","productName":"Mailagents Upgrade Real Chain","useCase":"Live facilitator-backed paid_review upgrade verification on dev"}' "$ALIAS" "$TS" "$OPERATOR_EMAIL")"

echo "Creating fresh signup on $BASE_URL ..."
curl --http1.1 --retry 3 --retry-delay 1 --retry-all-errors -sS \
  -X POST "$BASE_URL/public/signup" \
  -H 'content-type: application/json' \
  --data "$SIGNUP_BODY" > "$SIGNUP_JSON"

TOKEN="$(python3 - <<'PY' "$SIGNUP_JSON"
import json,sys
print(json.load(open(sys.argv[1]))['accessToken'])
PY
)"

TENANT_ID="$(python3 - <<'PY' "$SIGNUP_JSON"
import json,sys
print(json.load(open(sys.argv[1]))['tenantId'])
PY
)"

echo "Creating hosted did:web binding ..."
curl --http1.1 --retry 3 --retry-delay 1 --retry-all-errors -sS \
  -X POST "$BASE_URL/v1/tenants/$TENANT_ID/did/hosted" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  > "$DID_JSON"

echo "Requesting live upgrade quote ..."
curl --http1.1 --retry 3 --retry-delay 1 --retry-all-errors -sS \
  -D "$QUOTE_HEADERS" \
  -o "$QUOTE_JSON" \
  -X POST "$BASE_URL/v1/billing/upgrade-intent" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  --data '{"targetPricingTier":"paid_review"}' > /dev/null

echo "Creating facilitator-ready x402 EIP-3009 payload ..."
node - <<'NODE' "$QUOTE_JSON" "$PAYMENT_JSON" "$WALLET_JSON_PATH" "$ETHERS_PATH"
const fs = require("fs");
const quotePath = process.argv[2];
const outputPath = process.argv[3];
const walletPath = process.argv[4];
const ethersPath = process.argv[5];
const { Wallet, randomBytes, hexlify } = require(ethersPath);
const quoteEnvelope = JSON.parse(fs.readFileSync(quotePath, "utf8"));
const paymentRequired = quoteEnvelope.quote.paymentRequired;
const accepted = paymentRequired.accepts[0];
const resource = paymentRequired.resource;
const walletJson = JSON.parse(fs.readFileSync(walletPath, "utf8"));
const wallet = new Wallet(walletJson.privateKey);
const now = Math.floor(Date.now() / 1000);
const authorization = {
  from: wallet.address,
  to: accepted.payTo,
  value: accepted.amount,
  validAfter: String(Math.max(0, now - 30)),
  validBefore: String(now + Number(accepted.maxTimeoutSeconds || 300)),
  nonce: hexlify(randomBytes(32)),
};
const domain = {
  name: accepted?.extra?.name || "USDC",
  version: accepted?.extra?.version || "2",
  chainId: 84532,
  verifyingContract: accepted.asset,
};
const types = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

(async () => {
  const signature = await wallet.signTypedData(domain, types, authorization);
  fs.writeFileSync(outputPath, JSON.stringify({
    x402Version: 2,
    resource,
    accepted,
    payload: {
      signature,
      authorization,
    },
  }, null, 2));
})().catch((err) => {
  console.error(err?.shortMessage || err?.message || String(err));
  process.exit(1);
});
NODE

PAYMENT_SIGNATURE="$(python3 - <<'PY' "$PAYMENT_JSON"
import base64,sys
raw=open(sys.argv[1],'rb').read()
print(base64.b64encode(raw).decode())
PY
)"

echo "Submitting payment proof to upgrade API ..."
curl --http1.1 --retry 3 --retry-delay 1 --retry-all-errors -sS \
  -X POST "$BASE_URL/v1/billing/upgrade-intent" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H "payment-signature: $PAYMENT_SIGNATURE" \
  --data '{"targetPricingTier":"paid_review"}' > "$PENDING_JSON"

RECEIPT_ID="$(python3 - <<'PY' "$PENDING_JSON"
import json,sys
print(json.load(open(sys.argv[1]))['receipt']['id'])
PY
)"

echo "Confirming receipt through facilitator-backed settlement ..."
curl --http1.1 --retry 3 --retry-delay 1 --retry-all-errors -sS \
  -X POST "$BASE_URL/v1/billing/payment/confirm" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  --data "$(printf '{"receiptId":"%s"}' "$RECEIPT_ID")" > "$CONFIRM_JSON"

curl --http1.1 --retry 3 --retry-delay 1 --retry-all-errors -sS \
  "$BASE_URL/v1/billing/account" \
  -H "authorization: Bearer $TOKEN" > "$ACCOUNT_JSON"

curl --http1.1 --retry 3 --retry-delay 1 --retry-all-errors -sS \
  "$BASE_URL/v1/tenants/$TENANT_ID/send-policy" \
  -H "authorization: Bearer $TOKEN" > "$POLICY_JSON"

curl --http1.1 --retry 3 --retry-delay 1 --retry-all-errors -sS \
  "$BASE_URL/v1/billing/receipts" \
  -H "authorization: Bearer $TOKEN" > "$RECEIPTS_JSON"

python3 - <<'PY' "$SIGNUP_JSON" "$DID_JSON" "$QUOTE_HEADERS" "$QUOTE_JSON" "$PAYMENT_JSON" "$PENDING_JSON" "$CONFIRM_JSON" "$ACCOUNT_JSON" "$POLICY_JSON" "$RECEIPTS_JSON"
import json,sys
signup=json.load(open(sys.argv[1]))
did=json.load(open(sys.argv[2]))
quote_headers=open(sys.argv[3]).read().splitlines()
quote=json.load(open(sys.argv[4]))
payment=json.load(open(sys.argv[5]))
pending=json.load(open(sys.argv[6]))
confirm=json.load(open(sys.argv[7]))
account=json.load(open(sys.argv[8]))
policy=json.load(open(sys.argv[9]))
receipts=json.load(open(sys.argv[10]))
print(json.dumps({
  "mailboxAddress": signup["mailboxAddress"],
  "tenantId": signup["tenantId"],
  "tenantDid": did.get("did"),
  "quoteStatus": next((line.split()[1] for line in quote_headers if line.startswith("HTTP/")), None),
  "quote": {
    "scheme": quote["quote"]["scheme"],
    "network": quote["quote"]["network"],
    "asset": quote["quote"]["asset"],
    "assetSymbol": quote["quote"].get("assetSymbol"),
    "amountUsd": quote["quote"]["amountUsd"],
    "amountAtomic": quote["quote"]["amountAtomic"],
    "payTo": quote["quote"]["paymentRequired"]["accepts"][0].get("payTo"),
    "targetPricingTier": quote["quote"].get("targetPricingTier"),
  },
  "paymentSubmission": payment,
  "pendingReceipt": {
    "id": pending["receipt"]["id"],
    "status": pending["receipt"]["status"],
    "type": pending["receipt"]["receiptType"],
  },
  "confirm": {
    "verificationStatus": confirm.get("verificationStatus"),
    "message": confirm.get("message"),
    "receiptStatus": confirm.get("receipt", {}).get("status"),
    "ledgerEntryId": confirm.get("ledgerEntry", {}).get("id"),
  },
  "account": {
    "pricingTier": account["pricingTier"],
    "status": account["status"],
    "availableCredits": account["availableCredits"],
    "reservedCredits": account["reservedCredits"],
  },
  "sendPolicy": {
    "pricingTier": policy["pricingTier"],
    "outboundStatus": policy["outboundStatus"],
    "externalSendEnabled": policy["externalSendEnabled"],
    "reviewRequired": policy["reviewRequired"],
  },
  "latestReceipt": receipts["items"][0] if receipts.get("items") else None,
}, indent=2))
PY
