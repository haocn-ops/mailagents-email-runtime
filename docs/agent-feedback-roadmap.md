# Agent Feedback Roadmap

This note translates a real user email from `hello@mailagents.net` into a
product-facing roadmap for the Mailagents Email Runtime.

## Summary

The user feedback is high quality and internally consistent. The user is not
asking for fundamentally new infrastructure. They are asking for a more
agent-native interface on top of the infrastructure that already exists.

The main signal is:

- the runtime is capable
- the current public interface still exposes too much internal control-plane shape
- agent integrations need fewer IDs, fewer steps, and more direct operations

## User Requests

The feedback asked for five improvements:

1. a direct send email API
2. a simpler message read flow
3. mailbox addresses as identifiers
4. cleaner MCP error payloads
5. an SDK or official agent template

## Product Interpretation

These requests cluster into three themes.

### 1. Reduce Workflow Friction

The user sees too many explicit steps for common agent actions:

- register
- store multiple IDs
- create draft
- send draft
- list tasks
- fetch message content

For infrastructure correctness, the current design is reasonable. For an
external agent, it feels too low level.

### 2. Hide Internal Identifiers

The user should not need to understand `tenantId`, `mailboxId`, and `agentId`
for every common operation when the bearer token already scopes the mailbox
context.

### 3. Improve Tool Ergonomics

The user expects:

- one-step send workflows
- richer list/read responses
- structured errors
- a canonical client path

## Priority

Recommended priority order:

1. High: add a direct send API
2. High: add mailbox-scoped self routes
3. Medium: support mailbox address lookup in public APIs
4. Medium: return cleaner MCP errors
5. Medium: publish SDK and starter template

## Recommended Changes

### Priority 1: Direct Send API

Do not remove the existing draft/send model. It provides:

- auditability
- policy enforcement
- explicit send boundaries
- async delivery handling

Instead, add a higher-level API that internally composes the existing draft and
send pipeline.

Recommended route:

- `POST /v1/messages/send`

Recommended behavior:

1. infer tenant and mailbox context from the bearer token when possible
2. create a draft internally
3. run policy checks
4. enqueue outbound send
5. return the created draft and outbound job

Example request:

```json
{
  "to": ["user@example.com"],
  "subject": "Hello",
  "text": "Draft and send in one call",
  "idempotencyKey": "send-001"
}
```

Example response:

```json
{
  "draftId": "drf_123",
  "outboundJobId": "obj_123",
  "status": "queued"
}
```

### Priority 2: Mailbox-Scoped Self Routes

The current API is still too control-plane-shaped for mailbox-scoped agents.

Recommended routes:

- `GET /v1/mailboxes/self/tasks`
- `GET /v1/mailboxes/self/messages`
- `GET /v1/mailboxes/self/messages/{messageId}`
- `GET /v1/mailboxes/self/messages/{messageId}/content`
- `POST /v1/mailboxes/self/send`
- `POST /v1/mailboxes/self/reply`

These routes should resolve:

- `tenantId`
- `agentId`
- `mailboxId`

from the bearer token whenever the token is mailbox-scoped.

This lets the agent work in the vocabulary it actually cares about:

- my mailbox
- my tasks
- this message
- send this reply

### Priority 3: Mailbox Address Identifiers

For cross-system integrations, mailbox addresses are more natural than opaque
IDs.

Recommended support:

- accept `mailboxAddress` anywhere `mailboxId` is currently optional
- keep `mailboxId` as the canonical internal representation
- normalize and resolve mailbox addresses server-side

### Priority 4: MCP Error Cleanup

The current MCP error surface should be easier for agents to parse.

Recommended shape:

```json
{
  "error": {
    "code": "access_mailbox_denied",
    "message": "Mailbox access is not allowed for this token",
    "details": {
      "mailboxId": "mbx_123"
    }
  }
}
```

Recommended rules:

- no nested JSON strings
- always emit stable machine-readable codes
- include optional structured details
- preserve human-readable messages

### Priority 5: SDK and Starter Template

The runtime now has enough stable surface area to justify an official thin SDK
layer.

Recommended minimum SDK helpers:

- `listTasks()`
- `getMessage()`
- `getMessageContent()`
- `sendMessage()`
- `replyToMessage()`
- `rotateToken()`

## Proposed API Additions

### New REST Routes

- `GET /v1/mailboxes/self`
- `GET /v1/mailboxes/self/tasks`
- `GET /v1/mailboxes/self/messages`
- `GET /v1/mailboxes/self/messages/{messageId}`
- `GET /v1/mailboxes/self/messages/{messageId}/content`
- `POST /v1/messages/send`
- `POST /v1/messages/{messageId}/reply`
- `POST /v1/mailboxes/self/send`
- `POST /v1/mailboxes/self/reply`

### New MCP Tools

- `list_messages`
- `send_email`
- `reply_to_message`
- `get_mailbox_context`

These should wrap the lower-level primitives rather than replacing them.

## Non-Goals

This feedback does not require:

- removing draft/send
- removing explicit IDs from all APIs
- removing tasks as the processing model
- changing the underlying Cloudflare or SES architecture

The architecture is mostly correct. The integration surface should become more
opinionated and easier to consume.

## Recommended Implementation Order

1. add `GET /v1/mailboxes/self/tasks`
2. add `GET /v1/mailboxes/self/messages` with light metadata
3. add `POST /v1/messages/send`
4. add `POST /v1/messages/{messageId}/reply`
5. clean up MCP error payload shape
6. ship the thin SDK wrapper

## Decision

Treat this feedback as a roadmap input, not a support request.

The key product move is:

- keep the infrastructure model intact
- add an agent-native facade on top of it

That is the fastest path to making Mailagents feel simpler without weakening
the runtime guarantees that already work.
