#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="${BASE_URL:-https://mailagents-dev.izhenghaocn.workers.dev}"
BASE_RPC_URL="${BASE_RPC_URL:-https://sepolia.base.org}"
WALLET_JSON_PATH="${WALLET_JSON_PATH:-$REPO_ROOT/.secrets/dev-base-sepolia-wallet.json}"
ADMIN_SECRET="${ADMIN_API_SECRET_FOR_SMOKE:-replace-with-admin-api-secret}"
CREDITS_TO_BUY="${CREDITS_TO_BUY:-25}"
OPERATOR_EMAIL="${OPERATOR_EMAIL_FOR_SMOKE:-hello@mailagents.net}"
PAYMENT_CONFIRM_MODE="${PAYMENT_CONFIRM_MODE_FOR_SMOKE:-manual}"

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

load_local_admin_secret() {
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

new_temp() {
  local path
  path="$(mktemp -t mailagents-real-chain-topup.XXXXXX)"
  TEMP_FILES+=("$path")
  printf '%s\n' "$path"
}

require_cmd curl
require_cmd jq
require_cmd python3
require_cmd node

trap cleanup EXIT

load_local_admin_secret

if [[ ! -f "$WALLET_JSON_PATH" ]]; then
  echo "Missing wallet file: $WALLET_JSON_PATH" >&2
  echo "Create or copy a funded Base Sepolia wallet into .secrets first." >&2
  exit 1
fi

if [[ "$PAYMENT_CONFIRM_MODE" != "manual" && "$PAYMENT_CONFIRM_MODE" != "facilitator" ]]; then
  echo "Unsupported PAYMENT_CONFIRM_MODE_FOR_SMOKE: $PAYMENT_CONFIRM_MODE" >&2
  echo "Use 'manual' or 'facilitator'." >&2
  exit 1
fi

if [[ "$PAYMENT_CONFIRM_MODE" == "manual" && "$ADMIN_SECRET" == "replace-with-admin-api-secret" ]]; then
  echo "Missing admin secret. Set ADMIN_API_SECRET_FOR_SMOKE or configure ADMIN_API_SECRET in .dev.vars." >&2
  exit 1
fi

TS="$(date +%s)"
ALIAS="x402real${TS}"
SIGNUP_BODY="$(printf '{"mailboxAlias":"%s","agentName":"X402 Real %s","operatorEmail":"%s","productName":"Mailagents Real Chain Payment","useCase":"Live chain-backed topup verification on dev"}' "$ALIAS" "$TS" "$OPERATOR_EMAIL")"
SIGNUP_JSON="$(new_temp)"
DID_JSON="$(new_temp)"
QUOTE_HEADERS="$(new_temp)"
QUOTE_JSON="$(new_temp)"
PAYMENT_JSON="$(new_temp)"
PENDING_JSON="$(new_temp)"
CONFIRM_JSON="$(new_temp)"
ACCOUNT_JSON="$(new_temp)"
LEDGER_JSON="$(new_temp)"
RECEIPTS_JSON="$(new_temp)"

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

echo "Requesting live topup quote ..."
curl --http1.1 --retry 3 --retry-delay 1 --retry-all-errors -sS \
  -D "$QUOTE_HEADERS" \
  -o "$QUOTE_JSON" \
  -X POST "$BASE_URL/v1/billing/topup" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  --data "{\"credits\":$CREDITS_TO_BUY}" > /dev/null

read -r PAY_TO AMOUNT_ATOMIC <<<"$(python3 - <<'PY' "$QUOTE_JSON"
import json,sys
obj=json.load(open(sys.argv[1]))
pr=obj['quote']['paymentRequired']
accepted=pr['accepts'][0]
print(accepted.get('payTo',''), accepted.get('amount',''))
PY
)"

if [[ -z "$PAY_TO" ]]; then
  echo "Quote did not include payTo. Configure X402_PAY_TO first." >&2
  exit 1
fi

if [[ "$PAYMENT_CONFIRM_MODE" == "manual" ]]; then
  echo "Sending real onchain USDC payment to $PAY_TO ..."
  node - <<'NODE' "$PAY_TO" "$AMOUNT_ATOMIC" "$PAYMENT_JSON" "$WALLET_JSON_PATH" "$BASE_RPC_URL"
const fs = require("fs");
const { JsonRpcProvider, Wallet, Contract } = require("/tmp/mailagents-x402-wallet/node_modules/ethers");
const payTo = process.argv[2];
const amountAtomic = process.argv[3];
const outputPath = process.argv[4];
const walletPath = process.argv[5];
const rpcUrl = process.argv[6];
const walletJson = JSON.parse(fs.readFileSync(walletPath, "utf8"));
const provider = new JsonRpcProvider(rpcUrl);
const wallet = new Wallet(walletJson.privateKey, provider);
const usdc = new Contract(
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  ["function transfer(address to, uint256 value) returns (bool)"],
  wallet,
);

(async () => {
  const tx = await usdc.transfer(payTo, amountAtomic);
  const receipt = await tx.wait();
  fs.writeFileSync(outputPath, JSON.stringify({
    payer: wallet.address,
    payTo,
    network: "eip155:84532",
    asset: "usdc",
    amountAtomic,
    txHash: tx.hash,
    receiptStatus: receipt.status,
    blockNumber: receipt.blockNumber,
  }, null, 2));
})().catch((err) => {
  console.error(err?.shortMessage || err?.message || String(err));
  process.exit(1);
});
NODE
else
  echo "Creating facilitator-ready x402 EIP-3009 payload ..."
  node - <<'NODE' "$QUOTE_JSON" "$PAYMENT_JSON" "$WALLET_JSON_PATH"
const fs = require("fs");
const {
  Wallet,
  randomBytes,
  hexlify,
} = require("/tmp/mailagents-x402-wallet/node_modules/ethers");
const quotePath = process.argv[2];
const outputPath = process.argv[3];
const walletPath = process.argv[4];
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
fi

PAYMENT_SIGNATURE="$(python3 - <<'PY' "$PAYMENT_JSON"
import base64,sys
raw=open(sys.argv[1],'rb').read()
print(base64.b64encode(raw).decode())
PY
)"

echo "Submitting payment proof to billing API ..."
curl --http1.1 --retry 3 --retry-delay 1 --retry-all-errors -sS \
  -X POST "$BASE_URL/v1/billing/topup" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H "payment-signature: $PAYMENT_SIGNATURE" \
  --data "{\"credits\":$CREDITS_TO_BUY}" > "$PENDING_JSON"

RECEIPT_ID="$(python3 - <<'PY' "$PENDING_JSON"
import json,sys
print(json.load(open(sys.argv[1]))['receipt']['id'])
PY
)"

if [[ "$PAYMENT_CONFIRM_MODE" == "manual" ]]; then
  TX_HASH="$(python3 - <<'PY' "$PAYMENT_JSON"
import json,sys
print(json.load(open(sys.argv[1]))['txHash'])
PY
)"
  CONFIRM_BODY="$(printf '{"receiptId":"%s","settlementReference":"%s"}' "$RECEIPT_ID" "$TX_HASH")"
else
  CONFIRM_BODY="$(printf '{"receiptId":"%s"}' "$RECEIPT_ID")"
fi

if [[ "$PAYMENT_CONFIRM_MODE" == "manual" ]]; then
  echo "Confirming receipt through manual admin settlement ..."
  curl --http1.1 --retry 3 --retry-delay 1 --retry-all-errors -sS \
    -X POST "$BASE_URL/v1/billing/payment/confirm" \
    -H "authorization: Bearer $TOKEN" \
    -H "x-admin-secret: $ADMIN_SECRET" \
    -H 'content-type: application/json' \
    --data "$CONFIRM_BODY" > "$CONFIRM_JSON"
else
  echo "Confirming receipt through facilitator-backed settlement ..."
  curl --http1.1 --retry 3 --retry-delay 1 --retry-all-errors -sS \
    -X POST "$BASE_URL/v1/billing/payment/confirm" \
    -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    --data "$CONFIRM_BODY" > "$CONFIRM_JSON"
fi

curl --http1.1 --retry 3 --retry-delay 1 --retry-all-errors -sS \
  "$BASE_URL/v1/billing/account" \
  -H "authorization: Bearer $TOKEN" > "$ACCOUNT_JSON"

curl --http1.1 --retry 3 --retry-delay 1 --retry-all-errors -sS \
  "$BASE_URL/v1/billing/ledger" \
  -H "authorization: Bearer $TOKEN" > "$LEDGER_JSON"

curl --http1.1 --retry 3 --retry-delay 1 --retry-all-errors -sS \
  "$BASE_URL/v1/billing/receipts" \
  -H "authorization: Bearer $TOKEN" > "$RECEIPTS_JSON"

python3 - <<'PY' "$SIGNUP_JSON" "$DID_JSON" "$QUOTE_HEADERS" "$QUOTE_JSON" "$PAYMENT_JSON" "$PENDING_JSON" "$CONFIRM_JSON" "$ACCOUNT_JSON" "$LEDGER_JSON" "$RECEIPTS_JSON"
import json,sys
signup=json.load(open(sys.argv[1]))
did=json.load(open(sys.argv[2]))
quote_headers=open(sys.argv[3]).read().splitlines()
quote=json.load(open(sys.argv[4]))
payment=json.load(open(sys.argv[5]))
pending=json.load(open(sys.argv[6]))
confirm=json.load(open(sys.argv[7]))
account=json.load(open(sys.argv[8]))
ledger=json.load(open(sys.argv[9]))
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
  "latestLedgerEntry": ledger["items"][0] if ledger.get("items") else None,
  "latestReceipt": receipts["items"][0] if receipts.get("items") else None,
}, indent=2))

assert pending["receipt"]["receiptType"] == "topup", pending
assert pending["receipt"]["status"] == "pending", pending
assert confirm.get("verificationStatus") == "settled", confirm
assert confirm.get("receipt", {}).get("status") == "settled", confirm
assert account["availableCredits"] == 25, account
assert ledger.get("items"), ledger
assert ledger["items"][0]["entryType"] == "topup", ledger["items"][0]
assert ledger["items"][0]["creditsDelta"] == 25, ledger["items"][0]
assert receipts.get("items"), receipts
assert receipts["items"][0]["status"] == "settled", receipts["items"][0]
print("Real-chain topup smoke completed successfully.")
PY
