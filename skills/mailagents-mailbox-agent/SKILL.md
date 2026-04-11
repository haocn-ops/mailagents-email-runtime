---
name: mailagents-mailbox-agent
description: Use when an agent needs to onboard to Mailagents, obtain or recover a mailbox-scoped token, discover mailbox-safe capabilities, read mailbox state, send transactional email, or reply on-thread through HTTP or MCP. This skill is for normal mailbox-agent workflows on `mailagents.net` and `api.mailagents.net`, not admin or debug workflows.
---

# Mailagents Mailbox Agent

## Overview

Use this skill for the normal Mailagents happy path: provision a mailbox, keep
work mailbox-scoped, discover available tools, read state first, then send or
reply with the least privilege needed.

This skill is intentionally biased toward the simplest safe surfaces:

- `POST /public/signup` for self-serve onboarding
- `/v2/meta/compatibility` or MCP `tools/list` for discovery
- mailbox self routes for direct HTTP reads
- `list_messages`, `send_email`, and `reply_to_message` for common MCP flows
- `POST /v1/messages/send` and `POST /v1/messages/{messageId}/reply` for common HTTP flows

Do not use this skill for `/admin/mcp`, `x-admin-secret`, debug endpoints, or
operator-only remediation flows.

## Use This Skill When

- a user wants to integrate an agent with Mailagents
- a workflow needs a new `@mailagents.net` mailbox
- an agent needs to read inbound messages safely before acting
- an agent needs to send transactional mail or reply on-thread
- a mailbox-scoped token has expired and recovery or rotation is needed
- the caller needs to understand which MCP tools are currently available

## Do Not Use This Skill When

- the task is cold outreach, bulk newsletters, or any unsupported send pattern
- the workflow needs admin-only actions, tenant review, or debug inspection
- the workflow needs message replay unless the user explicitly asks for recovery
- the workflow is really about the internal implementation of the runtime rather
  than using the runtime as an external agent

## Default Workflow

1. If no bearer token exists yet, call `POST /public/signup`.
2. Save `accessToken` from the signup response immediately.
3. Discover the stable runtime contract with `GET /v2/meta/compatibility`.
4. If using MCP, call `POST /mcp` with `tools/list`.
5. Read state before side effects:
   - `GET /v1/mailboxes/self`
   - `GET /v1/mailboxes/self/messages`
   - or MCP `list_messages`
6. Prefer the high-level mailbox surfaces:
   - HTTP `POST /v1/messages/send`
   - HTTP `POST /v1/messages/{messageId}/reply`
   - MCP `send_email`
   - MCP `reply_to_message`
7. Include an explicit `idempotencyKey` on side-effecting sends and replies.
8. Branch only on stable error codes, not free-form error text.
9. If the token is expired, use `POST /public/token/reissue`.
10. If the token is still valid and rotation is desired, use `POST /v1/auth/token/rotate`.

## Decision Rules

- Prefer mailbox-scoped tokens over broader operator tokens.
- Prefer reads before writes when mailbox state is unclear.
- Prefer high-level send and reply surfaces over explicit draft management.
- Use explicit draft lifecycle control only when the workflow really needs a
  review, hold, or send-later step.
- Keep admin and debug routes out of standard mailbox-agent flows.
- Reuse the same `idempotencyKey` when retrying the same logical send or reply.
- Do not branch on human-readable error strings.
- Do not assume external delivery is always unlocked for a new tenant.

## Workflow Selection

### If you need the shortest path to a working mailbox

Use:

- `POST /public/signup`
- `GET /v1/mailboxes/self`
- `GET /v1/mailboxes/self/messages`
- `POST /v1/messages/send`
- `POST /v1/messages/{messageId}/reply`

Read [references/startup-and-discovery.md](references/startup-and-discovery.md).

### If you are running inside a tool-calling agent runtime

Use:

- `GET /v2/meta/compatibility`
- MCP `tools/list`
- MCP `list_messages`
- MCP `send_email`
- MCP `reply_to_message`

When planning from `tools/list`, inspect tool annotations for:

- `riskLevel`
- `sideEffecting`
- `humanReviewRequired`
- `supportsPartialAuthorization`
- `sendAdditionalScopes`

Read [references/tooling-and-errors.md](references/tooling-and-errors.md).

### If you need explicit send control

Use the draft path instead of the high-level send path:

- MCP `create_draft`
- MCP `get_draft`
- MCP `send_draft`
- MCP `cancel_draft`

or the matching lower-level HTTP draft routes.

Only choose this path when the workflow needs a staged draft or a deliberate
send decision.

### If the token is expired or delivery is constrained

- Use `POST /public/token/reissue` when the token has already expired.
- Use `POST /v1/auth/token/rotate` when the current token is still valid.
- Treat public reissue email delivery as operator-channel recovery, not as a
  fresh inline token mint.
- If outbound delivery fails due to credits or policy, inspect billing state
  before retrying sends.

Read [references/recovery-and-limits.md](references/recovery-and-limits.md).

## Safe Defaults

- Start with `/v2/meta/compatibility` for stable branching logic.
- Use `/v2/meta/runtime` only when richer environment-aware discovery is needed.
- For a pinned example fixture inside this repo, read `docs/agent-capabilities.json`.
- Prefer `list_messages`, `send_email`, and `reply_to_message` for mailbox-scoped MCP flows.
- Prefer mailbox self routes for direct HTTP integrations.

## Common Starting Requests

### Self-serve signup

```json
POST /public/signup
{
  "mailboxAlias": "agent-demo",
  "agentName": "Agent Demo",
  "operatorEmail": "operator@example.com",
  "productName": "Example Product",
  "useCase": "Handle inbound support email and send transactional replies."
}
```

Save:

- `accessToken`
- `mailboxAddress`
- `mailboxId` if later workflows need explicit mailbox targeting
- `agentId` only if you need lower-level draft or control-plane paths later

### MCP tool discovery

```json
POST /mcp
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

### MCP read-first flow

```json
POST /mcp
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "list_messages",
    "arguments": {
      "limit": 10,
      "direction": "inbound"
    }
  }
}
```

### MCP high-level reply

```json
POST /mcp
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "reply_to_message",
    "arguments": {
      "messageId": "REPLACE_WITH_MESSAGE_ID",
      "text": "Thanks for your message.",
      "idempotencyKey": "reply-demo-001"
    }
  }
}
```

## What To Read Next

- For the fast path and endpoint overview:
  [references/startup-and-discovery.md](references/startup-and-discovery.md)
- For tool preferences, annotations, and stable error handling:
  [references/tooling-and-errors.md](references/tooling-and-errors.md)
- For token recovery, billing, and delivery constraints:
  [references/recovery-and-limits.md](references/recovery-and-limits.md)

## Repo Sources Behind This Skill

Load these only when deeper detail is needed:

- `docs/llms-agent-guide.md`
- `docs/agent-sdk-examples.md`
- `docs/runtime-compatibility.md`
- `docs/mcp-local.md`
- `docs/agent-capabilities.json`
- `src/routes/site.ts`
