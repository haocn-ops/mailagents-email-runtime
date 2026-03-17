# AI Mail Workflows

This page covers how AI agents should read messages, inspect threads, create
drafts, send drafts, and replay prior work safely.

## Core Endpoints

- `GET /v1/messages/{messageId}`
- `GET /v1/messages/{messageId}/content`
- `POST /v1/messages/{messageId}/replay`
- `GET /v1/threads/{threadId}`
- `POST /v1/agents/{agentId}/drafts`
- `GET /v1/drafts/{draftId}`
- `POST /v1/drafts/{draftId}/send`

## Read Message State

Use `GET /v1/messages/{messageId}` to inspect message metadata first.

This returns the state you need to decide:

- which tenant owns the message
- which mailbox owns the message
- whether the message is inbound or outbound
- whether the message has already been normalized or replied
- whether a thread is already attached

Use `GET /v1/messages/{messageId}/content` to read normalized text, HTML, and
attachments.

Token requirements for message reads:

- `mail:read`
- matching tenant
- matching mailbox when the token is mailbox-scoped

## Read Thread Context

Use `GET /v1/threads/{threadId}` when the reply depends on conversation history.

This is the right choice when:

- the latest message is part of an existing thread
- you need to avoid contradicting a prior reply
- you need to preserve context before drafting

## Create a Draft

Use `POST /v1/agents/{agentId}/drafts` when the agent is ready to propose a
reply but outbound delivery should remain explicit.

Required request fields in the current implementation:

- `tenantId`
- `mailboxId`
- `from`
- `to`
- `subject`

Common optional fields:

- `threadId`
- `sourceMessageId`
- `cc`
- `bcc`
- `text`
- `html`
- `inReplyTo`
- `references`
- `attachments`

Token requirements:

- `draft:create`
- matching tenant
- matching agent when the token is agent-scoped
- matching mailbox when the token is mailbox-scoped

## Inspect a Draft

Use `GET /v1/drafts/{draftId}` before sending when you need to confirm:

- correct mailbox
- correct recipients
- correct agent ownership
- correct draft status

Token requirements:

- `draft:read`
- matching tenant
- matching agent when the token is agent-scoped
- matching mailbox when the token is mailbox-scoped

## Send a Draft

Use `POST /v1/drafts/{draftId}/send` only when the workflow explicitly intends
real outbound delivery.

This endpoint enqueues async delivery and returns:

- `draftId`
- `outboundJobId`
- accepted `status`

Token requirements:

- `draft:send`
- matching tenant
- matching agent when the token is agent-scoped
- matching mailbox when the token is mailbox-scoped

Important send rules:

- sending is asynchronous
- accepted does not mean delivered
- if reply headers or attachments are present, the runtime uses SES raw MIME send
- when send state is uncertain, inspect job and message state before trying again

## Replay a Message

Use `POST /v1/messages/{messageId}/replay` only for recovery, debugging, or
operator-approved reruns.

Supported modes:

- `normalize`
- `rerun_agent`

Token requirements:

- `mail:replay`
- matching tenant
- matching mailbox when the token is mailbox-scoped

Replay safety rules:

- replay is not a shortcut to resend email
- replay should not silently create duplicate outbound side effects
- if replay results in a new draft, sending must still be explicit

## Recommended Reply Workflow

1. read message metadata
2. read message content
3. read thread context when relevant
4. create draft
5. inspect draft
6. send draft explicitly

## Recommended Recovery Workflow

1. inspect current message state
2. decide whether `normalize` or `rerun_agent` is the right replay mode
3. replay
4. inspect resulting state
5. create a fresh draft if needed
6. explicitly decide whether sending is safe
