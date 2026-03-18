#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
ADMIN_SECRET="${ADMIN_API_SECRET_FOR_SMOKE:-replace-with-admin-api-secret}"
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

load_local_secrets
wait_for_server

if [[ "$ADMIN_SECRET" == "replace-with-admin-api-secret" ]]; then
  echo "Missing admin secret. Set ADMIN_API_SECRET_FOR_SMOKE or configure ADMIN_API_SECRET in .dev.vars." >&2
  exit 1
fi

echo "Minting bearer token for MCP smoke..."
TOKEN="$(curl -sS -X POST "$BASE_URL/v1/auth/tokens" \
  -H 'content-type: application/json' \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d "{
    \"sub\": \"mcp-smoke\",
    \"tenantId\": \"$TENANT_ID\",
    \"scopes\": [
      \"agent:create\",
      \"agent:bind\",
      \"agent:update\",
      \"mail:read\",
      \"mail:replay\",
      \"task:read\",
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

echo "Initializing MCP endpoint..."
curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {}
  }' | jq -e '.result.serverInfo.name == "mailagents-runtime" and .result.meta.api.metaRuntimePath == "/v2/meta/runtime" and .result.meta.api.compatibilityPath == "/v2/meta/compatibility" and (.result.meta.mcp.tools | any(.name == "send_draft" and .riskLevel == "high_risk" and .humanReviewRequired == true)) and (.result.meta.mcp.tools | any(.name == "reply_to_inbound_email" and .supportsPartialAuthorization == true and (.sendAdditionalScopes | index("draft:send"))))' >/dev/null

echo "Checking runtime metadata endpoint..."
curl -sS "$BASE_URL/v2/meta/runtime" \
  | jq -e '.server.name == "mailagents-runtime" and (.mcp.tools | any(.name == "reply_to_inbound_email")) and .api.metaRuntimePath == "/v2/meta/runtime" and .api.compatibilityPath == "/v2/meta/compatibility" and .api.compatibilitySchemaPath == "/v2/meta/compatibility/schema"' >/dev/null

echo "Checking compatibility contract endpoint..."
curl -sS "$BASE_URL/v2/meta/compatibility" \
  | jq -e '.contract.name == "mailagents-agent-compatibility" and .contract.version == "2026-03-17" and .contract.changelogPath == "/CHANGELOG.md" and .evolution.deprecationPolicy.minimumNotice == "one compatibility version" and (.guarantees.stableErrorCodes | index("idempotency_conflict")) and (.errors | any(.code == "access_mailbox_denied" and .retryable == false))' >/dev/null

echo "Checking compatibility schema endpoint..."
curl -sS "$BASE_URL/v2/meta/compatibility/schema" \
  | jq -e '.title == "Mailagents Agent Compatibility Contract" and (.properties.discovery.properties.compatibilitySchemaPath.type == "string") and (.properties.errors.items.required | index("code"))' >/dev/null

echo "Listing scoped MCP tools..."
TOOLS_RESPONSE="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }')"
echo "$TOOLS_RESPONSE" | jq -e '.result.tools | any(.name == "reply_to_inbound_email")' >/dev/null
echo "$TOOLS_RESPONSE" | jq -e '.result.tools | any(.name == "create_agent")' >/dev/null
echo "$TOOLS_RESPONSE" | jq -e '.result.tools | any(.name == "operator_manual_send")' >/dev/null
echo "$TOOLS_RESPONSE" | jq -e '.result.tools | any(.name == "send_draft" and .annotations.riskLevel == "high_risk" and .annotations.humanReviewRequired == true and .annotations.sideEffecting == true)' >/dev/null
echo "$TOOLS_RESPONSE" | jq -e '.result.tools | any(.name == "get_message" and .annotations.riskLevel == "read" and .annotations.humanReviewRequired == false and .annotations.sideEffecting == false)' >/dev/null
echo "$TOOLS_RESPONSE" | jq -e '.result.tools | any(.name == "reply_to_inbound_email" and .annotations.supportsPartialAuthorization == true and (.annotations.sendAdditionalScopes | index("draft:send")))' >/dev/null
echo "$TOOLS_RESPONSE" | jq -e '.result.tools | any(.name == "operator_manual_send" and .annotations.supportsPartialAuthorization == true and (.annotations.sendAdditionalScopes | index("draft:send")))' >/dev/null

echo "Creating agent through MCP..."
CREATE_AGENT_RESPONSE="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 3,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"create_agent\",
      \"arguments\": {
        \"tenantId\": \"$TENANT_ID\",
        \"name\": \"MCP Smoke Agent\",
        \"mode\": \"assistant\",
        \"config\": {
          \"systemPrompt\": \"You are the MCP smoke test agent.\"
        }
      }
    }
  }")"
AGENT_ID="$(echo "$CREATE_AGENT_RESPONSE" | jq -r '.result.structuredContent.id')"
if [[ -z "$AGENT_ID" || "$AGENT_ID" == "null" ]]; then
  echo "Failed to create agent through MCP" >&2
  echo "$CREATE_AGENT_RESPONSE" >&2
  exit 1
fi

echo "Checking mailbox validation through MCP..."
INVALID_BIND_RESPONSE="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 31,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"bind_mailbox\",
      \"arguments\": {
        \"agentId\": \"$AGENT_ID\",
        \"tenantId\": \"$TENANT_ID\",
        \"mailboxId\": \"mbx_missing_for_mcp_smoke\",
        \"role\": \"primary\"
      }
    }
  }")"
# Depending on token mailbox scope, the runtime may reject the request at the
# auth layer before it reaches mailbox existence validation.
echo "$INVALID_BIND_RESPONSE" | jq -e '
  .result.isError == true and
  (
    .result.structuredContent.error.code == "resource_mailbox_not_found" or
    .result.structuredContent.error.code == "access_mailbox_denied"
  )
' >/dev/null

echo "Binding mailbox through MCP..."
curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 4,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"bind_mailbox\",
      \"arguments\": {
        \"agentId\": \"$AGENT_ID\",
        \"tenantId\": \"$TENANT_ID\",
        \"mailboxId\": \"$MAILBOX_ID\",
        \"role\": \"primary\"
      }
    }
  }" | jq -e --arg mailbox "$MAILBOX_ID" '.result.structuredContent.mailboxId == $mailbox' >/dev/null

echo "Creating a draft through MCP..."
CREATE_DRAFT_RESPONSE="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 5,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"create_draft\",
      \"arguments\": {
        \"agentId\": \"$AGENT_ID\",
        \"tenantId\": \"$TENANT_ID\",
        \"mailboxId\": \"$MAILBOX_ID\",
        \"from\": \"$FROM_EMAIL\",
        \"to\": [\"$TO_EMAIL\"],
        \"subject\": \"MCP smoke draft\",
        \"text\": \"Created via MCP smoke.\"
      }
    }
  }")"
DRAFT_ID="$(echo "$CREATE_DRAFT_RESPONSE" | jq -r '.result.structuredContent.id')"
if [[ -z "$DRAFT_ID" || "$DRAFT_ID" == "null" ]]; then
  echo "Failed to create draft through MCP" >&2
  echo "$CREATE_DRAFT_RESPONSE" >&2
  exit 1
fi

echo "Sending the draft idempotently through MCP..."
SEND_IDEMPOTENCY_KEY="mcp-smoke-send-$DRAFT_ID"
SEND_RESPONSE="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 6,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"send_draft\",
      \"arguments\": {
        \"draftId\": \"$DRAFT_ID\",
        \"idempotencyKey\": \"$SEND_IDEMPOTENCY_KEY\"
      }
    }
  }")"
OUTBOUND_JOB_ID="$(echo "$SEND_RESPONSE" | jq -r '.result.structuredContent.outboundJobId')"
echo "$SEND_RESPONSE" | jq -e '.result.structuredContent.status == "queued"' >/dev/null

SEND_RESPONSE_REPEAT="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 7,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"send_draft\",
      \"arguments\": {
        \"draftId\": \"$DRAFT_ID\",
        \"idempotencyKey\": \"$SEND_IDEMPOTENCY_KEY\"
      }
    }
  }")"
echo "$SEND_RESPONSE_REPEAT" | jq -e --arg outbound "$OUTBOUND_JOB_ID" '.result.structuredContent.outboundJobId == $outbound' >/dev/null

echo "Checking composite reply workflow success path through MCP..."
REPLY_WORKFLOW_IDEMPOTENCY_KEY="mcp-smoke-reply-$AGENT_ID"
REPLY_WORKFLOW_RESPONSE="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 8,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"reply_to_inbound_email\",
      \"arguments\": {
        \"agentId\": \"$AGENT_ID\",
        \"messageId\": \"$SEEDED_INBOUND_MESSAGE_ID\",
        \"replyText\": \"Thanks from the composite MCP workflow.\",
        \"send\": true,
        \"idempotencyKey\": \"$REPLY_WORKFLOW_IDEMPOTENCY_KEY\"
      }
    }
  }")"
REPLY_DRAFT_ID="$(echo "$REPLY_WORKFLOW_RESPONSE" | jq -r '.result.structuredContent.draft.id')"
REPLY_OUTBOUND_JOB_ID="$(echo "$REPLY_WORKFLOW_RESPONSE" | jq -r '.result.structuredContent.sendResult.outboundJobId')"
echo "$REPLY_WORKFLOW_RESPONSE" | jq -e --arg message "$SEEDED_INBOUND_MESSAGE_ID" '
  .result.structuredContent.sourceMessage.id == $message and
  .result.structuredContent.sendResult.status == "queued" and
  (.result.structuredContent.usedThreadContext == true or .result.structuredContent.usedThreadContext == false)
' >/dev/null
if [[ -z "$REPLY_DRAFT_ID" || "$REPLY_DRAFT_ID" == "null" || -z "$REPLY_OUTBOUND_JOB_ID" || "$REPLY_OUTBOUND_JOB_ID" == "null" ]]; then
  echo "Composite reply workflow did not return a draft and outbound job" >&2
  echo "$REPLY_WORKFLOW_RESPONSE" >&2
  exit 1
fi

echo "Checking composite reply workflow idempotency through MCP..."
REPLY_WORKFLOW_REPEAT="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 81,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"reply_to_inbound_email\",
      \"arguments\": {
        \"agentId\": \"$AGENT_ID\",
        \"messageId\": \"$SEEDED_INBOUND_MESSAGE_ID\",
        \"replyText\": \"Thanks from the composite MCP workflow.\",
        \"send\": true,
        \"idempotencyKey\": \"$REPLY_WORKFLOW_IDEMPOTENCY_KEY\"
      }
    }
  }")"
echo "$REPLY_WORKFLOW_REPEAT" | jq -e --arg draft "$REPLY_DRAFT_ID" --arg outbound "$REPLY_OUTBOUND_JOB_ID" '
  .result.structuredContent.draft.id == $draft and
  .result.structuredContent.sendResult.outboundJobId == $outbound and
  .result.structuredContent.sendResult.status == "queued"
' >/dev/null

echo "Checking operator manual send composite tool through MCP..."
MANUAL_SEND_IDEMPOTENCY_KEY="mcp-manual-send-$AGENT_ID"
MANUAL_SEND_RESPONSE="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 83,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"operator_manual_send\",
      \"arguments\": {
        \"agentId\": \"$AGENT_ID\",
        \"tenantId\": \"$TENANT_ID\",
        \"mailboxId\": \"$MAILBOX_ID\",
        \"from\": \"$FROM_EMAIL\",
        \"to\": [\"$TO_EMAIL\"],
        \"subject\": \"Operator manual send\",
        \"text\": \"Sent through the composite operator flow.\",
        \"send\": true,
        \"idempotencyKey\": \"$MANUAL_SEND_IDEMPOTENCY_KEY\"
      }
    }
  }")"
MANUAL_SEND_DRAFT_ID="$(echo "$MANUAL_SEND_RESPONSE" | jq -r '.result.structuredContent.draft.id')"
MANUAL_SEND_OUTBOUND_JOB_ID="$(echo "$MANUAL_SEND_RESPONSE" | jq -r '.result.structuredContent.sendResult.outboundJobId')"
echo "$MANUAL_SEND_RESPONSE" | jq -e '.result.structuredContent.sendRequested == true and .result.structuredContent.sendResult.status == "queued"' >/dev/null
if [[ -z "$MANUAL_SEND_DRAFT_ID" || "$MANUAL_SEND_DRAFT_ID" == "null" || -z "$MANUAL_SEND_OUTBOUND_JOB_ID" || "$MANUAL_SEND_OUTBOUND_JOB_ID" == "null" ]]; then
  echo "Composite operator manual send did not return a draft and outbound job" >&2
  echo "$MANUAL_SEND_RESPONSE" >&2
  exit 1
fi

echo "Checking operator manual send idempotency through MCP..."
MANUAL_SEND_REPEAT="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 84,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"operator_manual_send\",
      \"arguments\": {
        \"agentId\": \"$AGENT_ID\",
        \"tenantId\": \"$TENANT_ID\",
        \"mailboxId\": \"$MAILBOX_ID\",
        \"from\": \"$FROM_EMAIL\",
        \"to\": [\"$TO_EMAIL\"],
        \"subject\": \"Operator manual send\",
        \"text\": \"Sent through the composite operator flow.\",
        \"send\": true,
        \"idempotencyKey\": \"$MANUAL_SEND_IDEMPOTENCY_KEY\"
      }
    }
  }")"
echo "$MANUAL_SEND_REPEAT" | jq -e --arg draft "$MANUAL_SEND_DRAFT_ID" --arg outbound "$MANUAL_SEND_OUTBOUND_JOB_ID" '
  .result.structuredContent.draft.id == $draft and
  .result.structuredContent.sendResult.outboundJobId == $outbound and
  .result.structuredContent.sendRequested == true
' >/dev/null

echo "Checking composite reply workflow error path through MCP..."
REPLY_WORKFLOW_ERROR_RESPONSE="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 82,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"reply_to_inbound_email\",
      \"arguments\": {
        \"agentId\": \"$AGENT_ID\",
        \"messageId\": \"msg_missing_for_reply_smoke\",
        \"replyText\": \"Thanks from the composite MCP workflow.\"
      }
    }
  }")"
echo "$REPLY_WORKFLOW_ERROR_RESPONSE" | jq -e '.result.isError == true and .result.structuredContent.error.code == "resource_message_not_found"' >/dev/null

echo "Checking machine-readable MCP errors..."
ERROR_RESPONSE="$(curl -sS "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 9,
    "method": "tools/call",
    "params": {
      "name": "get_message",
      "arguments": {
        "messageId": "msg_does_not_exist"
      }
    }
  }')"
echo "$ERROR_RESPONSE" | jq -e '.result.isError == true and .result.structuredContent.error.code == "resource_message_not_found"' >/dev/null

echo "MCP smoke completed."
echo "Agent ID: $AGENT_ID"
echo "Draft ID: $DRAFT_ID"
echo "Outbound Job ID: $OUTBOUND_JOB_ID"
echo "Reply Draft ID: $REPLY_DRAFT_ID"
echo "Reply Outbound Job ID: $REPLY_OUTBOUND_JOB_ID"
echo "Manual Send Draft ID: $MANUAL_SEND_DRAFT_ID"
echo "Manual Send Outbound Job ID: $MANUAL_SEND_OUTBOUND_JOB_ID"
