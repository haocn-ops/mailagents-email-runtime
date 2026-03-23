# AI Debug

This page explains how to use debug and admin endpoints safely.

For operator agents that prefer MCP instead of raw HTTP debug routes, see
[docs/admin-mcp.md](./admin-mcp.md).

## Core Debug Endpoints

- `GET /v1/debug/agents/{agentId}`
- `GET /v1/debug/mailboxes/{mailboxId}`
- `GET /v1/debug/messages/{messageId}`
- `GET /v1/debug/drafts/{draftId}`
- `GET /v1/debug/outbound-jobs/{outboundJobId}`
- `GET /v1/debug/suppressions/{email}`

Related admin maintenance endpoints:

- `GET /admin/api/maintenance/idempotency-keys`
- `POST /admin/api/maintenance/idempotency-cleanup`

## Access Requirements

Debug endpoints require:

- debug routes enabled in the environment
- valid `x-admin-secret`

Token-based bearer auth is not used for these endpoints.

## When to Use Debug Endpoints

Use them for:

- local development
- controlled operator workflows
- forensic inspection when normal APIs do not expose enough detail

Do not use them for:

- normal agent integrations
- public or customer-facing workflows
- broad autonomous actions in shared environments

## What Each Endpoint Is Good For

`GET /v1/debug/agents/{agentId}`

- inspect stored agent metadata directly

`GET /v1/debug/mailboxes/{mailboxId}`

- confirm mailbox records during routing and binding investigation

`GET /v1/debug/messages/{messageId}`

- inspect message state together with delivery events

`GET /v1/debug/drafts/{draftId}`

- inspect draft metadata and the underlying R2 payload

`GET /v1/debug/outbound-jobs/{outboundJobId}`

- inspect async delivery state when send is queued, retrying, or failed

`GET /v1/debug/suppressions/{email}`

- inspect suppression state for a destination address

`GET /admin/api/maintenance/idempotency-keys`

- inspect recent idempotency records
- filter by `operation`, `status`, and `limit`
- verify whether a repeated send or replay reused a prior response

`POST /admin/api/maintenance/idempotency-cleanup`

- run idempotency retention cleanup immediately
- verify how many stale records were removed

## Practical Rules

- prefer normal read APIs first
- switch to debug only when deeper internal state is required
- never make debug routes part of the normal happy path
- keep debug routes disabled outside local or tightly controlled environments

## Failure Interpretation

- `401 Invalid admin secret`: wrong or missing `x-admin-secret`
- `404 Debug routes are disabled`: feature flag is off for the environment
- `404 ... not found`: the route is enabled but the resource does not exist
