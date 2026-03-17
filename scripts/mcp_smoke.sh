#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
ADMIN_SECRET="${ADMIN_API_SECRET_FOR_SMOKE:-replace-with-admin-api-secret}"
TENANT_ID="${TENANT_ID:-t_demo}"
MAILBOX_ID="${MAILBOX_ID:-mbx_demo}"
FROM_EMAIL="${FROM_EMAIL:-agent@mail.example.com}"
TO_EMAIL="${TO_EMAIL:-user@example.com}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd jq

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
  }' | jq -e '.result.serverInfo.name == "mailagents-runtime"' >/dev/null

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
echo "$INVALID_BIND_RESPONSE" | jq -e '.result.isError == true and .result.structuredContent.error.code == "resource_mailbox_not_found"' >/dev/null

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

echo "Checking composite reply workflow through MCP..."
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
        \"messageId\": \"msg_missing_for_reply_smoke\",
        \"replyText\": \"Thanks from the composite MCP workflow.\"
      }
    }
  }" || true)"
echo "$REPLY_WORKFLOW_RESPONSE" | jq -e '.result.isError == true and .result.structuredContent.error.code == "resource_message_not_found"' >/dev/null

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
