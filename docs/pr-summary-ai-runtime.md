# PR Summary: AI Runtime Interface Hardening

## Summary

This change set makes the Mailagents runtime substantially more AI-friendly and
more production-safe for agent-driven workflows.

It adds:

- AI-focused onboarding and decision documentation
- a repository-level `llms-full.txt`
- page-level AI docs for auth, agents, mail workflows, and debug usage
- a draft MCP tool catalog and JSON schema
- OpenAPI updates to better match current implementation
- runtime idempotency for draft send, replay, and admin send flows
- hourly idempotency cleanup with configurable retention windows
- admin maintenance endpoints and dashboard visibility for idempotency records

## Why

Before this change, the repository had strong implementation building blocks but
the AI integration surface was fragmented:

- important operational rules were spread across code, spec notes, and local-dev docs
- OpenAPI did not fully reflect current route behavior
- `idempotencyKey` existed in API shape discussions but not in runtime behavior
- operators had no first-class way to inspect or clean up idempotency state

This PR closes those gaps and moves the project closer to a Resend-style
"AI-safe product interface" model.

## Main Changes

### 1. AI-facing docs

- Added onboarding, decision rules, auth, agents, mail workflow, and debug docs
- Added MCP/tooling drafts for future agent tooling work
- Added `llms-full.txt` as a single-file AI context source

### 2. OpenAPI and integration surface alignment

- Added missing debug routes to the OpenAPI doc
- Removed unsupported task list query options from the spec
- Added missing `tenantId` requirements to request schemas
- Documented current idempotency behavior for replay and send

### 3. Runtime idempotency

- Added `idempotency_keys` storage
- Implemented reservation, completion, and release logic
- Added idempotent handling for:
  - `POST /v1/drafts/{draftId}/send`
  - `POST /v1/messages/{messageId}/replay`
  - `POST /admin/api/send`

Behavior:

- same key + same logical request returns the original accepted response
- same key + different request shape returns `409`
- pending duplicate attempts return `409`

### 4. Cleanup and observability

- Added scheduled idempotency cleanup support
- Added configurable retention vars:
  - `IDEMPOTENCY_COMPLETED_RETENTION_HOURS`
  - `IDEMPOTENCY_PENDING_RETENTION_HOURS`
- Added admin APIs to:
  - list recent idempotency records
  - trigger cleanup manually
- Added an admin dashboard view for idempotency operations and cleanup

### 5. Verification

- `npm run check`
- `bash -n scripts/local_smoke.sh`
- local smoke script updated to verify idempotent send and replay behavior

## Follow-ups

- expose idempotency maintenance in a more polished dashboard summary card if needed
- add end-to-end integration assertions for scheduled cleanup
- consider surfacing idempotency conflict counts in observability or analytics
