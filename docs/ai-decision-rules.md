# AI Decision Rules

This document gives AI agents the operational rules they should follow when
deciding which Mailagents API action to take.

## 1. Authentication Decisions

Use a bearer token for normal product APIs.

Use `x-admin-secret` only for:

- token minting
- local or tightly controlled admin workflows
- local or tightly controlled debug inspection

Do not use admin or debug routes as the default integration path.

## 2. Scope Decisions

Choose the smallest scope set that works.

- use `mail:read` and `task:read` for read-only mail workflows
- add `draft:create` and `draft:send` for mailbox send and reply workflows
- add `mail:replay` only for debugging, recovery, or operator-approved reruns
- add agent management scopes only for setup and provisioning flows

If a token can be limited to specific mailboxes, include `mailboxIds`.

## 3. Agent and Mailbox Decisions

Create an agent when:

- a new logical assistant needs its own config
- a tenant needs isolation from another tenant's behavior
- a mailbox should route to a distinct agent identity

Bind a mailbox when:

- the mailbox should produce tasks for that agent
- the mailbox should be a valid outbound reply identity

Do not assume an agent can operate on a mailbox unless the mailbox is both:

- bound in data
- allowed by token scope when mailbox restrictions are present

## 4. Read Versus Write Decisions

Prefer read APIs first when the state is unclear.

Read first if you do not know:

- whether a task already exists
- whether a draft already exists
- whether a send job already ran
- whether a message was already normalized

Write only after confirming the intended next state.

## 5. High-Level Send Decisions

Prefer the high-level send and reply surfaces when:

- the workflow is a normal mailbox send or reply
- the agent does not need a visible draft lifecycle
- the runtime should manage draft creation internally

These high-level paths still create drafts internally for auditability and
delivery control.

## 6. Draft Decisions

Create a draft explicitly when:

- an agent has enough message and thread context to propose a reply
- a human or higher-level workflow may want to inspect before send
- the workflow must preserve explicit approval before delivery

Treat explicit drafts as the control point for workflows that need review or
manual approval before send.

## 7. Send Decisions

Send through a high-level route or send a draft only when:

- the mailbox identity is correct
- recipients are expected
- the composed payload is complete
- the workflow explicitly intends outbound delivery

Do not send when:

- the workflow is a replay or forensic inspection flow
- the runtime state is ambiguous
- there is evidence of a prior successful send that might make the action a
  duplicate

If a draft includes reply headers or attachments, expect the runtime to switch
to the richer provider-specific send path rather than the simplest payload
shape. For SES-backed environments that usually means raw MIME send.

## 8. Replay Decisions

Use replay when:

- re-normalizing a stored raw email
- rerunning agent execution after a bug fix or transient failure
- investigating lifecycle inconsistencies

Replay must not:

- silently create duplicate outbound email
- overwrite original raw artifacts
- skip traceability

Replay should:

- create a new agent execution record
- preserve linkage to the original message and thread
- require explicit send if a new replay-generated draft is produced

## 9. Retry Decisions

Assume queue delivery and external callbacks are at-least-once.

This means an AI agent should:

- expect duplicate deliveries
- read current state before issuing a compensating write
- avoid repeated send requests when status is uncertain

For outbound failures:

- inspect the outbound job state
- inspect message state
- inspect delivery events
- retry only when duplication risk is acceptable or explicitly controlled

When retrying a side-effecting request from a client or agent:

- reuse the same `idempotencyKey` for the same logical action
- do not reuse an `idempotencyKey` for a different request shape
- expect the runtime to return the original accepted response for safe repeats

## 10. Debug Decisions

Use debug routes only when:

- local development is active
- the environment intentionally enables them
- the operator has the admin secret

Prefer debug routes for:

- inspecting draft payloads in R2
- checking outbound job state
- checking message plus delivery event linkage

Do not build normal agent workflows on top of debug routes.

## 11. Safe Default Behaviors

When uncertain, default to:

1. read existing state
2. avoid duplicate send
3. avoid broad scopes
4. avoid admin and debug routes
5. require explicit send after replay

Idempotency records are not meant to live forever:

- completed records should be retained only long enough to cover realistic retry windows
- abandoned pending records should be cleaned up aggressively
- operators should run scheduled or manual cleanup for old idempotency records

## 12. Canonical Workflows

Provisioning workflow:

1. mint token
2. create agent
3. bind mailbox
4. optionally upsert policy

Reply workflow:

1. read task or message
2. read thread context
3. prefer `reply_to_message` or `POST /v1/messages/{messageId}/reply`
4. inspect outbound state if delivery is unclear

Explicit review workflow:

1. read task or message
2. read thread context
3. create draft
4. inspect draft
5. send draft explicitly

Recovery workflow:

1. inspect current state
2. replay normalize or execution
3. inspect outputs
4. prefer the high-level send or reply route if the corrected state now makes
   the intended action clear
5. create a fresh draft only when explicit review is needed
