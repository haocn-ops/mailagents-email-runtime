# AI Onboarding

This guide is the fastest way for an AI agent or agent-building developer to
understand how to work with the Mailagents Email Runtime safely.

## What This Runtime Does

Mailagents is an email-first AI agent runtime built on Cloudflare Workers,
Cloudflare Email Routing, Cloudflare Queues, Cloudflare R2, Cloudflare D1, and
a configurable outbound provider such as Amazon SES or Resend.

Core runtime flow:

1. inbound email is accepted for a mailbox
2. the raw email is stored in R2 and a message row is written to D1
3. a queue job normalizes the email, finds or creates a thread, stores
   attachments, and creates a task
4. an assigned agent can read mailbox messages and tasks through mailbox-scoped APIs or MCP tools
5. high-level send and reply calls create drafts internally and enqueue outbound delivery through the configured provider
6. delivery or bounce events are mapped back to the message

## Core Objects

- `tenant`: isolation boundary for data and access control
- `agent`: runtime actor with config, mode, and mailbox bindings
- `mailbox`: inbound and outbound email identity
- `message`: inbound or outbound email record
- `thread`: conversation grouping for messages
- `task`: work item created from inbound mail
- `draft`: proposed outbound email payload before send
- `outbound_job`: async send lifecycle record for provider delivery

## Authentication Model

Bearer tokens are signed and must include:

- `sub`
- `tenantId`
- `scopes`
- optional `agentId`
- optional `mailboxIds`
- `exp`

The runtime enforces access in this order:

1. the token must be valid and unexpired
2. required scopes must be present
3. the token tenant must match the target tenant
4. if `agentId` is present, the target agent must match
5. if `mailboxIds` are present, the target mailbox must be allowed

Admin and debug routes are separate from bearer-auth API routes:

- admin routes require `x-admin-secret`
- debug routes should stay disabled outside local or tightly controlled
  environments

For mailbox creation through the signup API, `POST /public/signup` issues a
default mailbox-scoped bearer token for the created mailbox. By default that
token is delivered through the configured operator channel instead of the
anonymous HTTP response. Legacy inline return can be re-enabled only with
explicit runtime opt-in.

## Minimum Safe Scopes

For a read-and-reply agent, the minimum useful scopes are:

- `mail:read`
- `task:read`
- `draft:create`
- `draft:read`
- `draft:send`

These scopes are sufficient for both:

- the high-level mailbox self routes such as `GET /v1/mailboxes/self/messages`
  and `POST /v1/messages/send`
- the MCP mailbox tools such as `list_messages`, `send_email`, and
  `reply_to_message`

Additional scopes such as `agent:create`, `agent:update`, `agent:bind`, or
`mail:replay` should only be granted when the agent truly needs them.

## Recommended Call Sequence

For local development:

1. run `npm install`
2. run `npm run d1:migrate:local`
3. run `npm run d1:seed:local`
4. run `npm run dev:local`
5. call `POST /v1/auth/tokens` with the admin secret to mint a bearer token
6. create an agent with `POST /v1/agents`
7. bind a mailbox with `POST /v1/agents/{agentId}/mailboxes`
8. call `POST /mcp` with `tools/list` or use `GET /v1/mailboxes/self`
9. list messages with `list_messages` or `GET /v1/mailboxes/self/messages`
10. send with `send_email` or `POST /v1/messages/send`
11. reply with `reply_to_message` or `POST /v1/messages/{messageId}/reply`

For production onboarding through the signup API:

1. call `POST /public/signup`
2. retrieve the mailbox-scoped bearer token from the configured operator delivery channel
3. confirm mailbox context with `GET /v1/mailboxes/self`
4. if the workflow will target arbitrary external recipients, check `GET /v1/billing/account` and `/limits` before the first outbound send
5. call `POST /mcp` with `tools/list` to discover the runtime surface
6. use that token for `list_messages`, `send_email`, `reply_to_message`, or the mailbox self routes
7. when a send is accepted, keep `outboundJobId` and poll `GET /v1/outbound-jobs/{outboundJobId}` until `finalDeliveryState` becomes `sent` or `failed`
8. if the token expires, call `POST /public/token/reissue`
9. retrieve the refreshed token from the original `operatorEmail`
10. if the token is still valid and the agent wants to rotate it proactively,
   call `POST /v1/auth/token/rotate`
11. use `delivery: "inline"` for immediate return, `delivery: "self_mailbox"`
   to send the refreshed token back to the mailbox itself, or `delivery:
   "both"` for both channels
12. fall back to `POST /v1/auth/tokens` only for broader operator workflows or
   operator-managed provisioning

`POST /public/token/reissue` is intentionally recovery-only:

- it accepts `mailboxAlias` or `mailboxAddress`
- it always returns a generic acceptance response
- it never returns the refreshed token directly
- it sends the refreshed token only to the original `operatorEmail`
- mailbox cooldowns and source-IP rate limits apply

`POST /v1/auth/token/rotate` is the proactive, authenticated path:

- it requires a still-valid bearer token
- it can return the rotated token inline
- it can optionally send the rotated token to the mailbox itself
- it does not email the original `operatorEmail`
- the previous token remains valid

For incoming mail handling:

1. identify the mailbox from the inbound address
2. persist the raw message
3. normalize asynchronously
4. create a task
5. let the agent inspect mailbox messages, tasks, and related message content
6. use high-level reply or send routes for most workflows
7. drop down to explicit draft creation only when the workflow needs a visible review step

## Rules That Matter Most

- Treat replay as a debugging and recovery feature, not a shortcut to send mail
  again.
- Never assume replayed work should auto-send outbound email.
- Expect cross-system callbacks and queue delivery to be at-least-once.
- Use mailbox-scoped tokens where possible.
- Prefer `list_messages`, `send_email`, and `reply_to_message` as the default
  mailbox workflow surface.
- Use explicit draft creation only when the workflow needs human review or
  draft lifecycle control.
- Prefer the smallest scope set that still completes the task.
- Keep admin and debug access out of normal agent workflows.

## Side Effects

Read-only operations:

- fetch agent metadata
- list tasks
- read messages
- list mailbox messages through self routes or MCP
- read threads
- inspect drafts

Write operations with persistent side effects:

- create or update agent
- bind mailbox
- send email through high-level routes or MCP tools
- reply to a message through high-level routes or MCP tools
- create draft
- send draft
- replay message processing

High-risk operations:

- any send action that can reach a real recipient
- any replay action combined with broad permissions
- any use of admin or debug routes in shared environments

## Error Handling Guidance

- `401` usually means missing or invalid bearer token, or invalid admin secret
- `403` usually means the token lacks the required scope or access boundary
- `404` on admin or debug routes can mean the route is disabled, not just missing
- outbound send failures should be treated as async job failures first, not as
  proof that nothing happened remotely
- side-effecting retries should reuse the same `idempotencyKey` when the caller
  is retrying the same send or replay request

When unsure whether an outbound action succeeded:

1. inspect the draft
2. inspect the outbound job and prefer `finalDeliveryState` over the initial accepted status
3. inspect the message delivery events
4. avoid re-sending until state is confirmed

## Idempotency Retention

The runtime stores idempotency records so repeated send or replay requests can
return the original accepted response.

Operational defaults:

- completed idempotency records are retained for 168 hours
- pending idempotency records are retained for 1 hour

These windows are configurable through Worker vars:

- `IDEMPOTENCY_COMPLETED_RETENTION_HOURS`
- `IDEMPOTENCY_PENDING_RETENTION_HOURS`

Cleanup can be driven by:

- the Worker `scheduled` handler
- the admin maintenance endpoint for manual runs

## Best References

- OpenAPI: [`docs/openapi.yaml`](../docs/openapi.yaml)
- local setup: [`docs/local-dev.md`](../docs/local-dev.md)
- smoke flow: [`docs/testing.md`](../docs/testing.md)
- product and security model: [`docs/mvp-spec.md`](../docs/mvp-spec.md)
