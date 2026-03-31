#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
RUN_ID="${RUN_ID:-$(date +%s)}"
ALIAS="unlock${RUN_ID}"
OP_EMAIL="${OP_EMAIL_FOR_SMOKE:-unlock-operator-${RUN_ID}@local.mailagents.test}"
LOCAL_D1_NAME="${LOCAL_D1_NAME_FOR_SMOKE:-mailagents-local}"
LOCAL_R2_BUCKET="${LOCAL_R2_BUCKET_FOR_SMOKE:-mailagents-local-email}"

TMP_FILES=()
LAST_HEADERS=""
LAST_BODY=""
LAST_STATUS=""

cleanup() {
  if [[ "${#TMP_FILES[@]}" -gt 0 ]]; then
    rm -f "${TMP_FILES[@]}"
  fi
}
trap cleanup EXIT

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

new_tmp() {
  local path
  path="$(mktemp -t upgrade-unlock-check.XXXXXX)"
  TMP_FILES+=("$path")
  printf '%s\n' "$path"
}

print_last_body() {
  if [[ -n "$LAST_BODY" && -f "$LAST_BODY" ]]; then
    cat "$LAST_BODY" >&2
  fi
}

expect_status() {
  local expected="$1"
  if [[ "$LAST_STATUS" != "$expected" ]]; then
    echo "Expected HTTP $expected but got $LAST_STATUS" >&2
    print_last_body
    exit 1
  fi
}

capture() {
  local method="$1"
  local path="$2"
  local data="$3"
  shift 3

  LAST_HEADERS="$(new_tmp)"
  LAST_BODY="$(new_tmp)"

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
    cmd+=("$1")
    shift
  done

  if [[ -n "$data" ]]; then
    cmd+=(-H "content-type: application/json" --data "$data")
  fi

  LAST_STATUS="$("${cmd[@]}")"
}

require_cmd curl
require_cmd jq
require_cmd python3
require_cmd wrangler

SIGNUP_JSON="$(new_tmp)"
curl -sS -X POST "$BASE_URL/public/signup" \
  -H 'content-type: application/json' \
  --data "{\"mailboxAlias\":\"$ALIAS\",\"agentName\":\"Unlock Check $RUN_ID\",\"operatorEmail\":\"$OP_EMAIL\",\"productName\":\"Mailagents Unlock Check\",\"useCase\":\"Verify upgrade unlocks external recipient policy\"}" \
  > "$SIGNUP_JSON"

TOKEN="$(jq -r '.accessToken' "$SIGNUP_JSON")"
TENANT_ID="$(jq -r '.tenantId' "$SIGNUP_JSON")"
AGENT_ID="$(jq -r '.agentId' "$SIGNUP_JSON")"
MAILBOX_ADDRESS="$(jq -r '.mailboxAddress' "$SIGNUP_JSON")"

if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  OUTBOUND_JOB_ID="$(jq -r '.outboundJobId // empty' "$SIGNUP_JSON")"
  if [[ -z "$OUTBOUND_JOB_ID" ]]; then
    echo "Signup did not return an access token or outboundJobId." >&2
    cat "$SIGNUP_JSON" >&2
    exit 1
  fi

  DRAFT_META_JSON="$(new_tmp)"
  DRAFT_PAYLOAD_JSON="$(new_tmp)"
  echo "Signup did not inline a token. Resolving token from the queued welcome draft..."
  wrangler d1 execute "$LOCAL_D1_NAME" --local \
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

  wrangler r2 object get "${LOCAL_R2_BUCKET}/${DRAFT_R2_KEY}" --local --pipe > "$DRAFT_PAYLOAD_JSON"

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

capture "POST" "/v1/billing/topup" '{"credits":25}' -H "authorization: Bearer $TOKEN"
echo "topup quote status=$LAST_STATUS"
expect_status "402"
TOPUP_PAYMENT_REQUIRED="$(awk 'BEGIN{IGNORECASE=1} /^payment-required:/ { sub(/\r$/, "", $2); print $2; exit }' "$LAST_HEADERS")"
if [[ -z "$TOPUP_PAYMENT_REQUIRED" ]]; then
  echo "Topup quote did not include payment-required header" >&2
  print_last_body
  exit 1
fi

TOPUP_SIG="$(printf '{"tx":"unlock-topup-%s"}' "$RUN_ID" | base64 | tr -d '\n')"
capture "POST" "/v1/billing/topup" '{"credits":25}' -H "authorization: Bearer $TOKEN" -H "payment-signature: $TOPUP_SIG"
echo "topup submit status=$LAST_STATUS"
if [[ "$LAST_STATUS" != "200" && "$LAST_STATUS" != "202" ]]; then
  echo "Expected topup proof submission to return 200 or 202" >&2
  print_last_body
  exit 1
fi
TOPUP_RECEIPT_ID="$(jq -r '.receipt.id' "$LAST_BODY")"

capture "POST" "/v1/billing/payment/confirm" "{\"receiptId\":\"$TOPUP_RECEIPT_ID\"}" -H "authorization: Bearer $TOKEN"
echo "topup confirm status=$LAST_STATUS"
expect_status "200"

capture "GET" "/v1/tenants/$TENANT_ID/send-policy" "" -H "authorization: Bearer $TOKEN"
echo "pre-upgrade send-policy status=$LAST_STATUS"
expect_status "200"
jq -e '.outboundStatus == "internal_only" and .externalSendEnabled == false' "$LAST_BODY" >/dev/null

PRE_UPGRADE_SEND_BODY="$(new_tmp)"
cat > "$PRE_UPGRADE_SEND_BODY" <<JSON
{
  "to": ["qa@example.com"],
  "subject": "Credit unlock regression pre-upgrade $RUN_ID",
  "text": "Mailbox $MAILBOX_ADDRESS should be able to target external domains as soon as it has credits."
}
JSON

capture "POST" "/v1/messages/send" "$(cat "$PRE_UPGRADE_SEND_BODY")" -H "authorization: Bearer $TOKEN"
echo "pre-upgrade external send status=$LAST_STATUS"
if [[ "$LAST_STATUS" != "202" ]]; then
  echo "Expected external send to be accepted after topup even before upgrade, got $LAST_STATUS" >&2
  print_last_body
  exit 1
fi
jq -e '.draft.id and .outboundJobId' "$LAST_BODY" >/dev/null

capture "POST" "/v1/billing/upgrade-intent" '{"targetPricingTier":"paid_review"}' -H "authorization: Bearer $TOKEN"
echo "upgrade quote status=$LAST_STATUS"
expect_status "402"
UPGRADE_PAYMENT_REQUIRED="$(awk 'BEGIN{IGNORECASE=1} /^payment-required:/ { sub(/\r$/, "", $2); print $2; exit }' "$LAST_HEADERS")"
if [[ -z "$UPGRADE_PAYMENT_REQUIRED" ]]; then
  echo "Upgrade quote did not include payment-required header" >&2
  print_last_body
  exit 1
fi

UPGRADE_SIG="$(printf '{"tx":"unlock-upgrade-%s"}' "$RUN_ID" | base64 | tr -d '\n')"
capture "POST" "/v1/billing/upgrade-intent" '{"targetPricingTier":"paid_review"}' -H "authorization: Bearer $TOKEN" -H "payment-signature: $UPGRADE_SIG"
echo "upgrade submit status=$LAST_STATUS"
if [[ "$LAST_STATUS" != "200" && "$LAST_STATUS" != "202" ]]; then
  echo "Expected upgrade proof submission to return 200 or 202" >&2
  print_last_body
  exit 1
fi
UPGRADE_RECEIPT_ID="$(jq -r '.receipt.id' "$LAST_BODY")"

capture "POST" "/v1/billing/payment/confirm" "{\"receiptId\":\"$UPGRADE_RECEIPT_ID\"}" -H "authorization: Bearer $TOKEN"
echo "upgrade confirm status=$LAST_STATUS"
expect_status "200"
jq -e '.sendPolicy.outboundStatus == "external_enabled" and .sendPolicy.externalSendEnabled == true' "$LAST_BODY" >/dev/null

SEND_BODY="$(new_tmp)"
cat > "$SEND_BODY" <<JSON
{
  "to": ["qa@example.com"],
  "subject": "Upgrade unlock regression $RUN_ID",
  "text": "Mailbox $MAILBOX_ADDRESS should be able to target external domains after upgrade."
}
JSON

capture "POST" "/v1/messages/send" "$(cat "$SEND_BODY")" -H "authorization: Bearer $TOKEN"
echo "external send status=$LAST_STATUS"

if [[ "$LAST_STATUS" != "202" ]]; then
  echo "Expected external send to be accepted after upgrade, got $LAST_STATUS" >&2
  print_last_body
  exit 1
fi

jq -e '.draft.id and .outboundJobId' "$LAST_BODY" >/dev/null

echo "upgrade_external_unlock_smoke passed"
echo "mailbox=$MAILBOX_ADDRESS"
echo "tenant=$TENANT_ID"
echo "agent=$AGENT_ID"
