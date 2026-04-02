# AI Mail Workflows

This page covers how AI agents should read messages, inspect threads, use the
high-level mailbox send and reply surfaces, and fall back to explicit drafts
only when a workflow needs lower-level control.

## Core Endpoints

- `GET /v1/mailboxes/self`
- `GET /v1/mailboxes/self/messages`
- `GET /v1/mailboxes/self/messages/{messageId}`
- `GET /v1/mailboxes/self/messages/{messageId}/content`
- `POST /v1/messages/send`
- `POST /v1/messages/{messageId}/reply`
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

For mailbox-scoped agents, prefer:

- `GET /v1/mailboxes/self/messages`
- `GET /v1/mailboxes/self/messages/{messageId}`
- `GET /v1/mailboxes/self/messages/{messageId}/content`

These routes remove the need to carry `tenantId`, `agentId`, or `mailboxId`
through every read.

## Read Thread Context

Use `GET /v1/threads/{threadId}` when the reply depends on conversation history.

This is the right choice when:

- the latest message is part of an existing thread
- you need to avoid contradicting a prior reply
- you need to preserve context before drafting

## Send a New Message

Use `POST /v1/messages/send` when the agent wants to send a new outbound email
through the mailbox-scoped high-level path.

This route creates a draft internally, applies the normal policy checks, and
enqueues outbound delivery.

Common request fields:

- `to`
- `subject`
- `text` or `html`

Optional fields:

- `cc`
- `bcc`
- `attachments`
- `idempotencyKey`

Token requirements:

- `draft:create`
- `draft:send`
- matching mailbox when the token is mailbox-scoped

## Reply to an Existing Message

Use `POST /v1/messages/{messageId}/reply` when the agent wants to reply
on-thread without manually managing a draft lifecycle.

This route creates the reply draft internally, attaches reply headers, and
enqueues outbound delivery.

Common request fields:

- `text` or `html`

Optional fields:

- `attachments`
- `idempotencyKey`

Token requirements:

- `draft:create`
- `draft:send`
- `mail:read`
- matching mailbox when the token is mailbox-scoped

## Create a Draft Explicitly

Use `POST /v1/agents/{agentId}/drafts` only when the workflow needs an
explicit review point, visible draft state, or direct control over the draft
before send.

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
- `statusCheck.outboundJobPath`
- `statusCheck.draftPath`

Token requirements:

- `draft:send`
- matching tenant
- matching agent when the token is agent-scoped
- matching mailbox when the token is mailbox-scoped

Important send rules:

- sending is asynchronous
- accepted does not mean delivered
- poll `GET /v1/outbound-jobs/{outboundJobId}` for the current runtime view of
  `queued`, `retry`, `sent`, or `failed`
- if reply headers or attachments are present, the runtime uses the richer
  provider-specific send path; in SES-backed environments that usually means raw MIME send
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
4. prefer `POST /v1/messages/{messageId}/reply`
5. inspect outbound job or delivery state if send outcome is unclear

If the workflow requires explicit review:

1. read message metadata
2. read message content
3. read thread context when relevant
4. create draft
5. inspect draft
6. send draft explicitly

## Recommended New Outbound Workflow

1. inspect mailbox scope and intended recipients
2. prefer `POST /v1/messages/send`
3. reuse the same `idempotencyKey` for safe retries
4. inspect outbound job and delivery state before retrying an uncertain send

## Recommended Recovery Workflow

1. inspect current message state
2. decide whether `normalize` or `rerun_agent` is the right replay mode
3. replay
4. inspect resulting state
5. prefer the high-level reply or send route if the corrected workflow now
   clearly intends outbound delivery
6. create a fresh draft only when the workflow needs explicit review or draft
   lifecycle control
