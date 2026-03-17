# Suggested PR Title

Harden the AI runtime interface with docs, idempotency, cleanup, and admin tooling

## Suggested Commit Message

```text
Harden AI runtime docs and idempotent mail operations
```

## Suggested PR Body

### What changed

This PR makes the Mailagents runtime more usable for AI agents and safer for
repeatable mail operations.

It adds:

- AI-focused onboarding and decision docs
- `llms-full.txt` and page-level AI documentation
- MCP/tooling draft docs and schema
- versioned runtime metadata for HTTP and MCP discovery
- OpenAPI updates to match current route behavior
- idempotency support for:
  - draft send
  - message replay
  - admin send
- idempotency storage, retention cleanup, and admin inspection APIs
- hourly cleanup scheduling
- admin dashboard visibility for idempotency operations
- composite MCP tools for task-level workflows
- smoke coverage for MCP metadata, composite tools, and idempotent send behavior

### Why

Before this PR:

- the AI integration surface was spread across README, spec notes, and code
- OpenAPI did not fully match current runtime requirements
- `idempotencyKey` existed in API shape discussions but not in runtime behavior
- operators had no direct way to inspect or clean up idempotency state

This PR closes those gaps and moves the project toward a more explicit,
agent-friendly interface model.

### Highlights

#### AI-facing docs

- added onboarding, auth, agents, mail workflow, debug, and decision docs
- added a single-file `llms-full.txt`
- added MCP/tooling drafts for future agent integrations
- added runtime metadata docs and workflow-pack docs

#### MCP and runtime discovery

- added scoped MCP primitive tools plus composite tools:
  - `reply_to_inbound_email`
  - `operator_manual_send`
- added stable machine-readable MCP error codes
- added `GET /v2/meta/runtime`
- added shared runtime metadata in MCP `initialize.result.meta`
- exposed tool risk annotations:
  - `riskLevel`
  - `sideEffecting`
  - `humanReviewRequired`
  - `composite`

#### Runtime safety

- added idempotency storage and reservation/completion/release flow
- repeated send/replay requests with the same key now return the original
  accepted response instead of duplicating side effects
- conflicting reuse of the same key returns `409`
- composite send workflows now bind idempotency to the logical request, not just a transient draft id

#### Operations and maintenance

- added hourly scheduled cleanup for stale idempotency keys
- added retention vars:
  - `IDEMPOTENCY_COMPLETED_RETENTION_HOURS`
  - `IDEMPOTENCY_PENDING_RETENTION_HOURS`
- added admin APIs to list and prune idempotency records
- added an admin dashboard view for recent idempotency keys and manual cleanup
- added an admin dashboard overview card for AI runtime policy and tool risk visibility

### Verification

- `npm run check`
- `bash -n scripts/local_smoke.sh`
- `bash -n scripts/mcp_smoke.sh`

### Notes

- existing environments should apply `migrations/0002_idempotency_keys.sql`
- the full local smoke flow still requires a running worker, local D1, and
  configured secrets
- the demo seed now includes a fixed inbound message and thread so the MCP smoke
  can assert a real reply workflow success path
