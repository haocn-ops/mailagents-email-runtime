#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
ADMIN_SECRET="${ADMIN_API_SECRET_FOR_SMOKE:-replace-with-admin-api-secret}"
WEBHOOK_SECRET="${WEBHOOK_SHARED_SECRET_FOR_SMOKE:-replace-with-shared-secret}"
TENANT_ID="${TENANT_ID:-t_demo}"
MAILBOX_ID="${MAILBOX_ID:-mbx_demo}"
FROM_EMAIL="${FROM_EMAIL:-agent@mail.example.com}"
TO_EMAIL="${TO_EMAIL:-user@example.com}"
SEEDED_INBOUND_MESSAGE_ID="${SEEDED_INBOUND_MESSAGE_ID:-msg_demo_inbound}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd jq

load_local_secrets() {
  local dev_vars="$REPO_ROOT/.dev.vars"
  if [[ ! -f "$dev_vars" ]]; then
    return
  fi

  if [[ "$ADMIN_SECRET" == "replace-with-admin-api-secret" || "$WEBHOOK_SECRET" == "replace-with-shared-secret" ]]; then
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

load_local_secrets
wait_for_server

if [[ "$ADMIN_SECRET" == "replace-with-admin-api-secret" ]]; then
  echo "Missing admin secret. Set ADMIN_API_SECRET_FOR_SMOKE or configure ADMIN_API_SECRET in .dev.vars." >&2
  exit 1
fi

if [[ "$WEBHOOK_SECRET" == "replace-with-shared-secret" ]]; then
  echo "Missing webhook secret. Set WEBHOOK_SHARED_SECRET_FOR_SMOKE or configure WEBHOOK_SHARED_SECRET in .dev.vars." >&2
  exit 1
fi

echo "Minting bearer token..."
TOKEN="$(curl -sS -X POST "$BASE_URL/v1/auth/tokens" \
  -H 'content-type: application/json' \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d "{
    \"sub\": \"local-smoke\",
    \"tenantId\": \"$TENANT_ID\",
    \"scopes\": [
      \"agent:create\",
      \"agent:read\",
      \"agent:update\",
      \"agent:bind\",
      \"task:read\",
      \"mail:read\",
      \"mail:replay\",
      \"draft:create\",
      \"draft:read\",
      \"draft:send\"
    ],
    \"mailboxIds\": [\"$MAILBOX_ID\"],
    \"expiresInSeconds\": 3600
  }" | jq -r '.token')"

if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "Failed to mint token" >&2
  exit 1
fi

echo "Creating agent..."
AGENT_RESPONSE="$(curl -sS -X POST "$BASE_URL/v1/agents" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d "{
    \"tenantId\": \"$TENANT_ID\",
    \"name\": \"Smoke Agent\",
    \"mode\": \"assistant\",
    \"config\": {
      \"systemPrompt\": \"You are the local smoke test agent.\",
      \"defaultModel\": \"gpt-5\",
      \"tools\": [\"reply_email\"]
    }
  }")"
AGENT_ID="$(echo "$AGENT_RESPONSE" | jq -r '.id')"

if [[ -z "$AGENT_ID" || "$AGENT_ID" == "null" ]]; then
  echo "Failed to create agent" >&2
  echo "$AGENT_RESPONSE" >&2
  exit 1
fi

echo "$AGENT_RESPONSE" | jq -e --arg tenant "$TENANT_ID" '.tenantId == $tenant' >/dev/null

echo "Binding mailbox..."
BIND_RESPONSE="$(curl -sS -X POST "$BASE_URL/v1/agents/$AGENT_ID/mailboxes" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d "{
    \"tenantId\": \"$TENANT_ID\",
    \"mailboxId\": \"$MAILBOX_ID\",
    \"role\": \"primary\"
  }")"
echo "$BIND_RESPONSE" | jq -e --arg mailbox "$MAILBOX_ID" '.mailboxId == $mailbox' >/dev/null

echo "Checking mailbox listing..."
curl -sS -X GET "$BASE_URL/v1/agents/$AGENT_ID/mailboxes" \
  -H "authorization: Bearer $TOKEN" | jq -e --arg mailbox "$MAILBOX_ID" '.items | any(.mailboxId == $mailbox)' >/dev/null

echo "Checking persisted agent state..."
curl -sS -X GET "$BASE_URL/v1/debug/agents/$AGENT_ID" \
  -H "x-admin-secret: $ADMIN_SECRET" | jq -e --arg tenant "$TENANT_ID" '.tenantId == $tenant' >/dev/null

echo "Creating draft..."
DRAFT_RESPONSE="$(curl -sS -X POST "$BASE_URL/v1/agents/$AGENT_ID/drafts" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d "{
    \"tenantId\": \"$TENANT_ID\",
    \"mailboxId\": \"$MAILBOX_ID\",
    \"from\": \"$FROM_EMAIL\",
    \"to\": [\"$TO_EMAIL\"],
    \"subject\": \"Smoke test email\",
    \"text\": \"Smoke test body\"
  }")"
DRAFT_ID="$(echo "$DRAFT_RESPONSE" | jq -r '.id')"

if [[ -z "$DRAFT_ID" || "$DRAFT_ID" == "null" ]]; then
  echo "Failed to create draft" >&2
  echo "$DRAFT_RESPONSE" >&2
  exit 1
fi

echo "$DRAFT_RESPONSE" | jq -e '.status == "draft"' >/dev/null

echo "Checking draft fetch..."
curl -sS -X GET "$BASE_URL/v1/drafts/$DRAFT_ID" \
  -H "authorization: Bearer $TOKEN" | jq -e --arg draft "$DRAFT_ID" '.id == $draft' >/dev/null

echo "Checking persisted draft payload..."
curl -sS -X GET "$BASE_URL/v1/debug/drafts/$DRAFT_ID" \
  -H "x-admin-secret: $ADMIN_SECRET" | jq -e --arg draft "$DRAFT_ID" '.draft.id == $draft and .payload.subject == "Smoke test email"' >/dev/null

echo "Enqueueing draft send..."
SEND_IDEMPOTENCY_KEY="smoke-send-$DRAFT_ID"
SEND_RESPONSE="$(curl -sS -X POST "$BASE_URL/v1/drafts/$DRAFT_ID/send" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d "{
    \"idempotencyKey\": \"$SEND_IDEMPOTENCY_KEY\"
  }")"

OUTBOUND_JOB_ID="$(echo "$SEND_RESPONSE" | jq -r '.outboundJobId')"
if [[ -z "$OUTBOUND_JOB_ID" || "$OUTBOUND_JOB_ID" == "null" ]]; then
  echo "Failed to enqueue draft send" >&2
  echo "$SEND_RESPONSE" >&2
  exit 1
fi
echo "$SEND_RESPONSE" | jq -e '.status == "queued"' >/dev/null

echo "Checking draft send idempotency..."
SEND_RESPONSE_REPEAT="$(curl -sS -X POST "$BASE_URL/v1/drafts/$DRAFT_ID/send" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d "{
    \"idempotencyKey\": \"$SEND_IDEMPOTENCY_KEY\"
  }")"
echo "$SEND_RESPONSE_REPEAT" | jq -e --arg outbound "$OUTBOUND_JOB_ID" --arg draft "$DRAFT_ID" '.outboundJobId == $outbound and .draftId == $draft and .status == "queued"' >/dev/null

echo "Checking persisted outbound job..."
OUTBOUND_JOB_RESPONSE="$(curl -sS -X GET "$BASE_URL/v1/debug/outbound-jobs/$OUTBOUND_JOB_ID" \
  -H "x-admin-secret: $ADMIN_SECRET")"
echo "$OUTBOUND_JOB_RESPONSE" | jq -e '.status == "queued" or .status == "sending" or .status == "sent" or .status == "retry"' >/dev/null
OUTBOUND_MESSAGE_ID="$(echo "$OUTBOUND_JOB_RESPONSE" | jq -r '.messageId')"

echo "Checking replay idempotency..."
REPLAY_IDEMPOTENCY_KEY="smoke-replay-$DRAFT_ID"
REPLAY_RESPONSE="$(curl -sS -X POST "$BASE_URL/v1/messages/$SEEDED_INBOUND_MESSAGE_ID/replay" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d "{
    \"mode\": \"rerun_agent\",
    \"agentId\": \"$AGENT_ID\",
    \"idempotencyKey\": \"$REPLAY_IDEMPOTENCY_KEY\"
  }")"
echo "$REPLAY_RESPONSE" | jq -e --arg message "$SEEDED_INBOUND_MESSAGE_ID" '.messageId == $message and .mode == "rerun_agent" and .status == "accepted"' >/dev/null
REPLAY_RESPONSE_REPEAT="$(curl -sS -X POST "$BASE_URL/v1/messages/$SEEDED_INBOUND_MESSAGE_ID/replay" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d "{
    \"mode\": \"rerun_agent\",
    \"agentId\": \"$AGENT_ID\",
    \"idempotencyKey\": \"$REPLAY_IDEMPOTENCY_KEY\"
  }")"
echo "$REPLAY_RESPONSE_REPEAT" | jq -e --arg message "$SEEDED_INBOUND_MESSAGE_ID" '.messageId == $message and .mode == "rerun_agent" and .status == "accepted"' >/dev/null

echo "Posting sample SES delivery event..."
WEBHOOK_RESPONSE="$(curl -sS -X POST "$BASE_URL/v1/webhooks/ses" \
  -H 'content-type: application/json' \
  -H "x-webhook-shared-secret: $WEBHOOK_SECRET" \
  --data-binary @fixtures/ses/delivery.json)"
echo "$WEBHOOK_RESPONSE" | jq -e '.received == true and .eventType == "delivery"' >/dev/null

echo "Smoke flow completed."
echo "Agent ID: $AGENT_ID"
echo "Draft ID: $DRAFT_ID"
echo "Outbound Job ID: $OUTBOUND_JOB_ID"
echo "Message ID in fixture is static; debug message-event assertions should be run against a real providerMessageId when available."
