# Agent Workflow Packs

This document defines reusable workflow packs for AI agents using the
Mailagents runtime.

Each pack combines:

- the intended job to perform
- the recommended tool sequence
- side-effect boundaries
- retry and failure behavior
- stop conditions that should hand control back to a human or operator

These packs are meant to sit above raw API docs and above individual MCP tool
definitions.

## 1. `reply_to_inbound_email`

### Goal

Read inbound mail, gather enough thread context, draft a reply, and send only
when the workflow explicitly intends delivery.

### Inputs

- `agentId`
- `messageId`
- optional `threadId`
- optional `idempotencyKey` for send

### Tool sequence

1. `get_message`
2. `get_message_content`
3. `get_thread`
   Use only when the message already belongs to a thread or reply context is needed.
4. `create_draft`
5. `get_draft`
6. `send_draft`

### Side-effect boundary

- `get_message`, `get_message_content`, and `get_thread` are read-only
- `create_draft` persists a draft
- `send_draft` is the first outbound delivery side effect

### Recommended stop conditions

Stop and require human or higher-level workflow input when:

- the message belongs to the wrong mailbox scope
- the reply intent is ambiguous
- the recipient list looks unsafe
- policy would require review
- the prior send state is unclear

### Retry behavior

- reads can be repeated normally
- draft creation should not be repeated blindly if a usable draft already exists
- repeated send attempts should reuse the same `idempotencyKey`

### Recovery behavior

- if send fails ambiguously, inspect the draft and outbound state before trying again
- if the content pipeline looks stale, prefer a replay workflow rather than forcing a new send

## 2. `operator_manual_send`

### Goal

Allow an operator or operator-guided agent to compose and send a message through
the normal draft and queue path.

### Inputs

- `agentId` or operator identity
- `tenantId`
- `mailboxId`
- recipients
- subject
- body
- optional reply headers
- optional `idempotencyKey`

### Tool sequence

1. `create_draft`
2. `get_draft`
3. `send_draft`

### Composite tool

This workflow can also be executed through the composite MCP tool
`operator_manual_send`.

### Side-effect boundary

- the only outbound delivery side effect is `send_draft`
- draft creation is persistent but not yet delivery

### Recommended stop conditions

Stop when:

- the sender mailbox is not clearly correct
- recipients are broad or unexpected
- the message should instead be sent by a product workflow rather than an operator path

### Retry behavior

- if the same logical manual send is retried, reuse the same `idempotencyKey`
- if the message content changes materially, generate a new key and treat it as a new send

### Recovery behavior

- if the draft already exists and is correct, avoid creating another one
- if send state is uncertain, inspect outbound state instead of re-sending immediately

## 3. `replay_and_recover_message`

### Goal

Recover from stale normalization, replay an execution path, and re-establish a
safe path to a corrected draft or follow-up action.

### Inputs

- `messageId`
- replay `mode`
- optional `agentId`
- optional replay `idempotencyKey`

### Tool sequence

1. `get_message`
2. `get_message_content`
   Useful for inspecting what the runtime currently knows.
3. `replay_message`
4. `get_message`
5. `get_message_content`
6. optionally `get_thread`
7. optionally `create_draft`
8. optionally `get_draft`
9. optionally `send_draft`

### Side-effect boundary

- replay is itself a stateful recovery action
- replay must not be treated as implicit permission to send
- any send after replay is a separate explicit decision

### Recommended stop conditions

Stop when:

- replayed state still looks inconsistent
- the requested mode does not match the recovery goal
- the original message no longer appears safe to act on
- the workflow would produce outbound delivery without clear approval

### Retry behavior

- reuse the same replay `idempotencyKey` for the same logical recovery request
- do not reuse a replay key for a different mode or a different target message

### Recovery behavior

- if replay succeeds, re-read state before deciding the next step
- if replay produces a new draft, treat send as a fresh explicit action with its own idempotency control

## Workflow Design Rules

- prefer read operations before side effects
- isolate send as a distinct decision point
- separate replay from send
- use idempotency on repeated side-effecting calls
- make stop conditions explicit so agents know when to defer

## Suggested Next Step

These workflow packs can be used as:

- prompt snippets for agent orchestration
- machine-readable workflow metadata
- future composite MCP tools or server-side runbooks
