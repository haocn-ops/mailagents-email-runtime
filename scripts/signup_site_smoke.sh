#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
ADMIN_SECRET="${ADMIN_API_SECRET_FOR_SMOKE:-replace-with-admin-api-secret}"
RUN_ID="${RUN_ID_FOR_SMOKE:-$(date +%s)}"
RESERVED_ALIAS="${RESERVED_ALIAS_FOR_SMOKE:-hello}"
SIGNUP_ALIAS="${SIGNUP_ALIAS_FOR_SMOKE:-signup-$RUN_ID}"
OPERATOR_EMAIL="${OPERATOR_EMAIL_FOR_SMOKE:-signup-$RUN_ID@example.com}"

TEMP_FILES=()
LAST_HEADERS=""
LAST_BODY=""
LAST_STATUS=""
ACCESS_TOKEN=""
TENANT_TOKEN=""
TENANT_ID=""
MAILBOX_ID=""
MAILBOX_ADDRESS=""
OUTBOUND_JOB_ID=""

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

  LAST_HEADERS="$(mktemp -t mailagents-signup-headers.XXXXXX)"
  LAST_BODY="$(mktemp -t mailagents-signup-body.XXXXXX)"
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

echo "Checking public site route on the main worker..."
capture_request "GET" "/" "" 
assert_status "200"
grep -q "Mailagents" "$LAST_BODY"

echo "Checking admin dashboard route on the main worker..."
capture_request "GET" "/admin" ""
assert_status "200"
grep -q "Admin Dashboard" "$LAST_BODY"

echo "Checking reserved signup alias rejection..."
capture_request "POST" "/public/signup" "{
  \"mailboxAlias\": \"$RESERVED_ALIAS\",
  \"agentName\": \"Reserved Alias Smoke Agent\",
  \"operatorEmail\": \"$OPERATOR_EMAIL\",
  \"productName\": \"Reserved Alias Smoke\",
  \"useCase\": \"Verifying reserved aliases are blocked.\"
}"
assert_status "409"
jq -e --arg alias "$RESERVED_ALIAS" '.error | contains($alias) and contains("reserved")' "$LAST_BODY" >/dev/null

echo "Creating a self-serve signup on the merged worker..."
capture_request "POST" "/public/signup" "{
  \"mailboxAlias\": \"$SIGNUP_ALIAS\",
  \"agentName\": \"Signup Smoke Agent\",
  \"operatorEmail\": \"$OPERATOR_EMAIL\",
  \"productName\": \"Signup Smoke\",
  \"useCase\": \"Verifying self-serve signup and welcome email behavior.\"
}"
assert_status "201"
jq -e --arg alias "$SIGNUP_ALIAS" '
  .mailboxAddress == ($alias + "@local.mailagents.test") and
  .routingStatus == "skipped" and
  (.welcomeStatus == "queued" or .welcomeStatus == "failed")
' "$LAST_BODY" >/dev/null
TENANT_ID="$(jq -r '.tenantId' "$LAST_BODY")"
MAILBOX_ID="$(jq -r '.mailboxId' "$LAST_BODY")"
MAILBOX_ADDRESS="$(jq -r '.mailboxAddress' "$LAST_BODY")"
OUTBOUND_JOB_ID="$(jq -r '.outboundJobId // empty' "$LAST_BODY")"
ACCESS_TOKEN="$(jq -r '.accessToken // empty' "$LAST_BODY")"

if [[ -n "$ACCESS_TOKEN" ]]; then
  TENANT_TOKEN="$ACCESS_TOKEN"
else
  echo "Signup did not return an access token, minting a tenant-scoped token for verification..."
  capture_request "POST" "/v1/auth/tokens" "{
    \"sub\": \"signup-site-smoke\",
    \"tenantId\": \"$TENANT_ID\",
    \"mailboxIds\": [\"$MAILBOX_ID\"],
    \"scopes\": [\"mail:read\"],
    \"expiresInSeconds\": 3600
  }" "x-admin-secret: $ADMIN_SECRET"
  assert_status "201"
  TENANT_TOKEN="$(jq -r '.token' "$LAST_BODY")"
fi

echo "Checking mailbox-scoped access for the new signup..."
capture_request "GET" "/v1/mailboxes/self" "" "authorization: Bearer $TENANT_TOKEN"
assert_status "200"
jq -e --arg mailbox "$MAILBOX_ID" --arg address "$MAILBOX_ADDRESS" '
  .id == $mailbox and
  .address == $address and
  .status == "active"
' "$LAST_BODY" >/dev/null

echo "Checking that welcome delivery does not create billing debits..."
capture_request "GET" "/v1/billing/account" "" "authorization: Bearer $TENANT_TOKEN"
assert_status "200"
jq -e '.availableCredits == 0 and .reservedCredits == 0' "$LAST_BODY" >/dev/null

if [[ -n "$OUTBOUND_JOB_ID" ]]; then
  wait_for_job_status "$OUTBOUND_JOB_ID" "sent"

  capture_request "GET" "/v1/debug/outbound-jobs/$OUTBOUND_JOB_ID" "" "x-admin-secret: $ADMIN_SECRET"
  assert_status "200"
  jq -e '.status == "sent" and (.lastError == null or .lastError == "")' "$LAST_BODY" >/dev/null
fi

capture_request "GET" "/v1/billing/account" "" "authorization: Bearer $TENANT_TOKEN"
assert_status "200"
jq -e '.availableCredits == 0 and .reservedCredits == 0' "$LAST_BODY" >/dev/null

capture_request "GET" "/v1/billing/ledger?limit=20" "" "authorization: Bearer $TENANT_TOKEN"
assert_status "200"
jq -e --arg outbound "$OUTBOUND_JOB_ID" '
  if ($outbound | length) > 0
  then (.items | map(select(.referenceId == $outbound)) | length) == 0
  else (.items | length) == 0
  end
' "$LAST_BODY" >/dev/null

echo "Signup + site smoke flow completed."
echo "Tenant ID: $TENANT_ID"
echo "Mailbox ID: $MAILBOX_ID"
echo "Mailbox Address: $MAILBOX_ADDRESS"
if [[ -n "$OUTBOUND_JOB_ID" ]]; then
  echo "Welcome outbound job: $OUTBOUND_JOB_ID"
fi
