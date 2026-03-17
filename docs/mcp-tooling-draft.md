# MCP Tooling Draft

This document proposes a minimal MCP-style tool surface for Mailagents.

The goal is to let AI agents interact with the runtime through strongly shaped
tools instead of loosely assembled HTTP calls.

## Design Goals

- expose the most common workflows first
- keep tools aligned with existing HTTP APIs
- preserve current auth boundaries
- make risky actions explicit
- bias toward read-before-write behavior

## Proposed Tool Set

### `mint_access_token`

Purpose:

- create a tenant-scoped bearer token for normal API use

Inputs:

- `sub`
- `tenantId`
- `scopes`
- optional `agentId`
- optional `mailboxIds`
- optional `expiresInSeconds`

Notes:

- should require operator-provided admin secret
- should be marked privileged

### `create_agent`

Purpose:

- provision a new agent

Inputs:

- `tenantId`
- `name`
- `mode`
- optional `config`

### `bind_mailbox`

Purpose:

- attach a mailbox to an agent

Inputs:

- `agentId`
- `tenantId`
- `mailboxId`
- `role`

### `upsert_agent_policy`

Purpose:

- enforce reply and delivery safety controls

Inputs:

- `agentId`
- `autoReplyEnabled`
- `humanReviewRequired`
- `confidenceThreshold`
- `maxAutoRepliesPerThread`
- optional `allowedRecipientDomains`
- optional `blockedSenderDomains`
- optional `allowedTools`

### `list_agent_tasks`

Purpose:

- fetch current work for an agent

Inputs:

- `agentId`
- optional `status`

### `get_message`

Purpose:

- fetch message metadata

Inputs:

- `messageId`

### `get_message_content`

Purpose:

- fetch normalized content and attachment metadata

Inputs:

- `messageId`

### `get_thread`

Purpose:

- fetch message history for reply context

Inputs:

- `threadId`

### `create_draft`

Purpose:

- create a proposed outbound reply

Inputs:

- `agentId`
- `tenantId`
- `mailboxId`
- `from`
- `to`
- `subject`
- optional `threadId`
- optional `sourceMessageId`
- optional `cc`
- optional `bcc`
- optional `text`
- optional `html`
- optional `inReplyTo`
- optional `references`
- optional `attachments`

### `get_draft`

Purpose:

- inspect a draft before send

Inputs:

- `draftId`

### `send_draft`

Purpose:

- enqueue outbound delivery

Inputs:

- `draftId`

Safety notes:

- mark as side-effecting
- require explicit confirmation in higher-risk environments
- when retrying the same logical send, reuse the same `idempotencyKey`

### `replay_message`

Purpose:

- re-normalize or rerun agent processing

Inputs:

- `messageId`
- `mode`
- optional `agentId`

Safety notes:

- mark as high-risk
- do not chain automatically into `send_draft`
- when retrying the same logical replay, reuse the same `idempotencyKey`

### `inspect_outbound_job`

Purpose:

- inspect queued, retry, sent, or failed outbound state

Inputs:

- `outboundJobId`

Notes:

- this can wrap the debug endpoint and should be disabled when debug routes are
  unavailable

## Tool Behavior Rules

- tools should preserve current HTTP auth boundaries
- tools should return normalized error categories when possible
- tools should clearly mark side-effecting versus read-only actions
- replay and send should be visibly separated in the tool catalog
- side-effecting tools should expose `idempotencyKey` when the underlying API supports it

## Recommended First Release

If implementing incrementally, start with:

1. `list_agent_tasks`
2. `get_message`
3. `get_message_content`
4. `get_thread`
5. `create_draft`
6. `get_draft`
7. `send_draft`

This gives an agent enough power to complete the main read-reply workflow
without exposing provisioning and debug complexity on day one.
