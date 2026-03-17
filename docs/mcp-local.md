# Local MCP Usage

This repository now exposes a minimal HTTP MCP endpoint at `/mcp`.

Current support:

- `initialize`
- `tools/list`
- `tools/call`

## Prerequisites

1. start the local worker with `npm run dev:local`
2. mint a bearer token as described in [docs/local-dev.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/local-dev.md)
3. export it:

```bash
export TOKEN="REPLACE_WITH_TOKEN"
```

## Initialize

```bash
curl -sS http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {}
  }'
```

## List available tools

`tools/list` is filtered by the bearer token scopes on the request.

```bash
curl -sS http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }'
```

## Call a tool

Example: fetch a message

```bash
curl -sS http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "get_message",
      "arguments": {
        "messageId": "REPLACE_WITH_MESSAGE_ID"
      }
    }
  }'
```

Example: create a draft

```bash
curl -sS http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "create_draft",
      "arguments": {
        "agentId": "agt_demo",
        "tenantId": "t_demo",
        "mailboxId": "mbx_demo",
        "from": "agent@mail.example.com",
        "to": ["user@example.com"],
        "subject": "Hello from MCP",
        "text": "Draft created through the Mailagents MCP endpoint."
      }
    }
  }'
```

Example: run the composite reply workflow without sending

```bash
curl -sS http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4.5,
    "method": "tools/call",
    "params": {
      "name": "reply_to_inbound_email",
      "arguments": {
        "agentId": "agt_demo",
        "messageId": "REPLACE_WITH_MESSAGE_ID",
        "replyText": "Thanks for your message. We are looking into it now."
      }
    }
  }'
```

Example: send a draft idempotently

```bash
curl -sS http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 5,
    "method": "tools/call",
    "params": {
      "name": "send_draft",
      "arguments": {
        "draftId": "REPLACE_WITH_DRAFT_ID",
        "idempotencyKey": "mcp-send-001"
      }
    }
  }'
```

## Supported tools

- `create_agent`
- `bind_mailbox`
- `upsert_agent_policy`
- `reply_to_inbound_email`
- `operator_manual_send`
- `list_agent_tasks`
- `get_message`
- `get_message_content`
- `get_thread`
- `create_draft`
- `get_draft`
- `send_draft`
- `replay_message`

## Notes

- `tools/list` only shows tools allowed by the current token scopes
- `tools/call` reuses the same access checks as the HTTP API
- `bind_mailbox` now validates that both the agent and mailbox exist and belong to the declared tenant
- `send_draft` and `replay_message` support `idempotencyKey`
- `reply_to_inbound_email` can create a reply draft and optionally send when `send: true`
- when `reply_to_inbound_email` sends, the `idempotencyKey` is bound to the logical reply request so safe retries return the original workflow result instead of creating a second draft
- `operator_manual_send` can create an operator-guided draft and optionally send when `send: true`
- when `operator_manual_send` sends, the `idempotencyKey` is bound to the logical send request so safe retries return the original draft and outbound job
- this is a minimal HTTP MCP surface, not yet a full SDK package or hosted MCP distribution

## Error codes

Tool failures now return stable machine-readable error codes inside
`result.structuredContent.error.code`.

Current codes include:

- `auth_unauthorized`
- `auth_missing_scope`
- `access_tenant_denied`
- `access_agent_denied`
- `access_mailbox_denied`
- `invalid_arguments`
- `resource_agent_not_found`
- `resource_mailbox_not_found`
- `resource_message_not_found`
- `resource_thread_not_found`
- `resource_draft_not_found`
- `idempotency_conflict`
- `idempotency_in_progress`
- `tool_internal_error`
