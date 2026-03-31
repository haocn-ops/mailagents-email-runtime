#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="${BASE_URL:-https://mailagents-dev.izhenghaocn.workers.dev}"
BASE_RPC_URL="${BASE_RPC_URL:-https://sepolia.base.org}"
WALLET_JSON_PATH="${WALLET_JSON_PATH:-$REPO_ROOT/.secrets/dev-base-sepolia-wallet.json}"
ETHERS_PATH="${ETHERS_PATH:-$REPO_ROOT/node_modules/ethers}"
ADMIN_SECRET="${ADMIN_API_SECRET_FOR_SMOKE:-replace-with-admin-api-secret}"
CREDITS_TO_BUY="${CREDITS_TO_BUY:-25}"
OPERATOR_EMAIL="${OPERATOR_EMAIL_FOR_SMOKE:-hello@mailagents.net}"
PAYMENT_CONFIRM_MODE="${PAYMENT_CONFIRM_MODE_FOR_SMOKE:-facilitator}"
DEV_D1_NAME="${DEV_D1_NAME_FOR_SMOKE:-mailagents-dev}"
DEV_R2_BUCKET="${DEV_R2_BUCKET_FOR_SMOKE:-mailagents-dev-email}"

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

if [[ ! -e "$ETHERS_PATH" ]]; then
  echo "Missing ethers package at: $ETHERS_PATH" >&2
  echo "Set ETHERS_PATH or install ethers locally first." >&2
  exit 1
fi

if [[ "$PAYMENT_CONFIRM_MODE" != "manual" && "$PAYMENT_CONFIRM_MODE" != "facilitator" ]]; then
  echo "Unsupported PAYMENT_CONFIRM_MODE_FOR_SMOKE: $PAYMENT_CONFIRM_MODE" >&2
  echo "Use 'manual' or 'facilitator'." >&2
  exit 1
fi

if [[ "$PAYMENT_CONFIRM_MODE" == "manual" ]]; then
  echo "PAYMENT_CONFIRM_MODE_FOR_SMOKE=manual is no longer supported by /v1/billing/payment/confirm." >&2
  echo "Use PAYMENT_CONFIRM_MODE_FOR_SMOKE=facilitator or leave it unset." >&2
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
payload=json.load(open(sys.argv[1]))
token=payload.get("accessToken")
if isinstance(token, str) and token:
    print(token)
PY
)"

TENANT_ID="$(python3 - <<'PY' "$SIGNUP_JSON"
import json,sys
print(json.load(open(sys.argv[1]))['tenantId'])
PY
)"

if [[ -z "$TOKEN" ]]; then
  OUTBOUND_JOB_ID="$(python3 - <<'PY' "$SIGNUP_JSON"
import json,sys
payload=json.load(open(sys.argv[1]))
value=payload.get("outboundJobId")
if isinstance(value, str):
    print(value)
PY
)"

  if [[ -z "$OUTBOUND_JOB_ID" ]]; then
    echo "Signup did not return accessToken or outboundJobId." >&2
    cat "$SIGNUP_JSON" >&2
    exit 1
  fi

  DRAFT_META_JSON="$(new_temp)"
  DRAFT_PAYLOAD_JSON="$(new_temp)"
  echo "Signup did not inline a token. Resolving token from the queued welcome draft ..."
  env -u CLOUDFLARE_API_TOKEN wrangler d1 execute "$DEV_D1_NAME" \
    --remote \
    --env dev \
    --command "SELECT draft_r2_key FROM outbound_jobs WHERE id = '$OUTBOUND_JOB_ID' LIMIT 1;" \
    > "$DRAFT_META_JSON"

  DRAFT_R2_KEY="$(python3 - <<'PY' "$DRAFT_META_JSON"
import json,sys
raw=open(sys.argv[1]).read()
start=raw.find('[')
if start == -1:
    raise SystemExit("Could not parse Wrangler D1 response.")
payload=json.loads(raw[start:])
results=payload[0].get("results") or []
if not results or not results[0].get("draft_r2_key"):
    raise SystemExit("Could not find welcome draft key for signup.")
print(results[0]["draft_r2_key"])
PY
)"

  env -u CLOUDFLARE_API_TOKEN wrangler r2 object get "${DEV_R2_BUCKET}/${DRAFT_R2_KEY}" \
    --remote \
    --pipe > "$DRAFT_PAYLOAD_JSON"

  TOKEN="$(python3 - <<'PY' "$DRAFT_PAYLOAD_JSON"
import json,sys
payload=json.load(open(sys.argv[1]))
text=payload.get("text") or ""
if not isinstance(text, str):
    raise SystemExit("Welcome draft did not include a text body.")
marker="Default API access token"
if marker not in text:
    raise SystemExit("Welcome draft did not contain an access token section.")
parts=[line.strip() for line in text.splitlines()]
for idx,line in enumerate(parts):
    if line == marker:
        for candidate in parts[idx+1:]:
            if candidate.startswith("eyJ"):
                print(candidate)
                raise SystemExit(0)
        break
raise SystemExit("Could not extract access token from welcome draft.")
PY
)"
fi

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

QUOTE_STATUS="$(awk '/^HTTP\// { status=$2 } END { print status }' "$QUOTE_HEADERS")"
if [[ "$QUOTE_STATUS" != "402" ]]; then
  echo "Expected HTTP 402 from /v1/billing/topup but received ${QUOTE_STATUS:-<none>}." >&2
  cat "$QUOTE_JSON" >&2
  exit 1
fi

read -r PAY_TO AMOUNT_ATOMIC <<<"$(python3 - <<'PY' "$QUOTE_JSON"
import json,sys
obj=json.load(open(sys.argv[1]))
quote=obj.get("quote")
if not isinstance(quote, dict):
    print(json.dumps(obj, indent=2), file=sys.stderr)
    raise SystemExit("Topup quote response did not include a quote payload.")
pr=quote.get("paymentRequired")
if not isinstance(pr, dict):
    print(json.dumps(obj, indent=2), file=sys.stderr)
    raise SystemExit("Topup quote response did not include quote.paymentRequired.")
accepted=pr['accepts'][0]
print(accepted.get('payTo',''), accepted.get('amount',''))
PY
)"

if [[ -z "$PAY_TO" ]]; then
  echo "Quote did not include payTo. Configure X402_PAY_TO first." >&2
  exit 1
fi

echo "Creating facilitator-ready x402 EIP-3009 payload ..."
node - <<'NODE' "$QUOTE_JSON" "$PAYMENT_JSON" "$WALLET_JSON_PATH" "$ETHERS_PATH"
const fs = require("fs");
const {
  Wallet,
  randomBytes,
  hexlify,
} = require(process.argv[5]);
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
payload=json.load(open(sys.argv[1]))
receipt=payload.get("receipt")
if not isinstance(receipt, dict) or not receipt.get("id"):
    print("Topup proof submission did not return a receipt.", file=sys.stderr)
    print(json.dumps(payload, indent=2), file=sys.stderr)
    raise SystemExit(1)
print(receipt["id"])
PY
)"

CONFIRM_BODY="$(printf '{"receiptId":"%s"}' "$RECEIPT_ID")"

echo "Confirming receipt through facilitator-backed settlement ..."
curl --http1.1 --retry 3 --retry-delay 1 --retry-all-errors -sS \
  -X POST "$BASE_URL/v1/billing/payment/confirm" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  --data "$CONFIRM_BODY" > "$CONFIRM_JSON"

curl --http1.1 --retry 3 --retry-delay 1 --retry-all-errors -sS \
  "$BASE_URL/v1/billing/account" \
  -H "authorization: Bearer $TOKEN" > "$ACCOUNT_JSON"

curl --http1.1 --retry 3 --retry-delay 1 --retry-all-errors -sS \
  "$BASE_URL/v1/billing/ledger" \
  -H "authorization: Bearer $TOKEN" > "$LEDGER_JSON"

curl --http1.1 --retry 3 --retry-delay 1 --retry-all-errors -sS \
  "$BASE_URL/v1/billing/receipts" \
  -H "authorization: Bearer $TOKEN" > "$RECEIPTS_JSON"

python3 - <<'PY' "$SIGNUP_JSON" "$DID_JSON" "$QUOTE_HEADERS" "$QUOTE_JSON" "$PAYMENT_JSON" "$PENDING_JSON" "$CONFIRM_JSON" "$ACCOUNT_JSON" "$LEDGER_JSON" "$RECEIPTS_JSON" "$CREDITS_TO_BUY"
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
credits_requested=int(sys.argv[11])
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
assert pending["receipt"]["status"] in ("pending", "settled"), pending
assert confirm.get("verificationStatus") == "settled", confirm
assert confirm.get("receipt", {}).get("status") == "settled", confirm
assert account["availableCredits"] == credits_requested, account
assert ledger.get("items"), ledger
assert ledger["items"][0]["entryType"] == "topup", ledger["items"][0]
assert ledger["items"][0]["creditsDelta"] == credits_requested, ledger["items"][0]
assert receipts.get("items"), receipts
assert receipts["items"][0]["status"] == "settled", receipts["items"][0]
print("Real-chain topup smoke completed successfully.")
PY
