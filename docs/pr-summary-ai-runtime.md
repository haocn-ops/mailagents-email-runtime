# PR Summary: AI Runtime Interface Hardening

## Summary

This change set makes the Mailagents runtime substantially more AI-friendly and
more production-safe for agent-driven workflows.

It adds:

- AI-focused onboarding and decision documentation
- a repository-level `llms-full.txt`
- page-level AI docs for auth, agents, mail workflows, and debug usage
- a draft MCP tool catalog and JSON schema
- a minimal HTTP MCP endpoint with scoped tools
- versioned runtime metadata for HTTP and MCP discovery
- OpenAPI updates to better match current implementation
- runtime idempotency for draft send, replay, and admin send flows
- hourly idempotency cleanup with configurable retention windows
- admin maintenance endpoints and dashboard visibility for idempotency records
- workflow packs and composite MCP tools for orchestration
- local MCP smoke coverage

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
- Added reusable agent workflow packs in markdown and JSON form

### 2. MCP runtime surface

- Added a minimal `/mcp` endpoint
- Added scoped primitive tools for:
  - agent provisioning
  - mailbox binding
  - policy updates
  - task listing
  - message and thread reads
  - draft creation and send
  - replay
- Added composite workflow tools:
  - `reply_to_inbound_email`
- `operator_manual_send`
- Added stable machine-readable MCP error codes
- Added tool annotations for:
  - `riskLevel`
  - `sideEffecting`
  - `humanReviewRequired`
  - `composite`
- Added versioned runtime discovery via:
  - `GET /v2/meta/runtime`
  - `initialize.result.meta`

### 3. OpenAPI and integration surface alignment

- Added missing debug routes to the OpenAPI doc
- Removed unsupported task list query options from the spec
- Added missing `tenantId` requirements to request schemas
- Documented current idempotency behavior for replay and send

### 4. Runtime idempotency

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

### 5. Cleanup and observability

- Added scheduled idempotency cleanup support
- Added configurable retention vars:
  - `IDEMPOTENCY_COMPLETED_RETENTION_HOURS`
  - `IDEMPOTENCY_PENDING_RETENTION_HOURS`
- Added admin APIs to:
  - list recent idempotency records
  - trigger cleanup manually
- Added an admin dashboard view for idempotency operations and cleanup
- Added an admin dashboard overview card for AI runtime policy, including:
  - high-risk tools
  - tools that should expect human review
  - published composite workflows
  - admin/debug route gate status

### 6. Verification

- `npm run check`
- `bash -n scripts/local_smoke.sh`
- `bash -n scripts/mcp_smoke.sh`
- local smoke script updated to verify idempotent send and replay behavior
- local MCP smoke script added to verify:
  - MCP initialize and runtime metadata
  - primitive tools and composite tools
  - machine-readable error codes
  - idempotent send behavior
  - seeded inbound reply happy path
  - operator manual send happy path

## Follow-ups

- add end-to-end integration assertions for scheduled cleanup
- consider surfacing idempotency conflict counts in observability or analytics
- consider publishing the runtime metadata and risk annotations as a hosted compatibility contract for external agents
