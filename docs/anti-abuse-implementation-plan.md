# Anti-Abuse Implementation Plan

This document maps the proposed abuse-prevention policy to the current
Mailagents runtime codebase.

## Policy Goals

- free and newly provisioned users can only send to Mailagents-managed inboxes
- paid users can send externally only after explicit enablement
- outbound access is rate-limited, auditable, and revocable
- reply flows follow the same outbound restrictions as new sends
- SES review can point to enforceable product controls, not just policy text

## Current Repo Shape

The current runtime already has useful building blocks:

- agent policy storage in [migrations/0001_initial.sql](/Users/zh/Documents/codeX/mailagents_cloudflare2/migrations/0001_initial.sql)
- policy read/write logic in [src/repositories/agents.ts](/Users/zh/Documents/codeX/mailagents_cloudflare2/src/repositories/agents.ts)
- agent policy API in [src/routes/api.ts](/Users/zh/Documents/codeX/mailagents_cloudflare2/src/routes/api.ts)
- signup defaults in [src/lib/provisioning/signup.ts](/Users/zh/Documents/codeX/mailagents_cloudflare2/src/lib/provisioning/signup.ts)
- high-level send entry points in [src/routes/api.ts](/Users/zh/Documents/codeX/mailagents_cloudflare2/src/routes/api.ts)
- high-level mailbox MCP send/reply entry points in [src/routes/mcp.ts](/Users/zh/Documents/codeX/mailagents_cloudflare2/src/routes/mcp.ts)

Existing `agent_policies` fields already include:

- `allowedRecipientDomains`
- `blockedSenderDomains`
- `allowedTools`

That means we can ship an internal-only send restriction quickly, then add
tenant plans and quotas as a second phase.

## Recommended Rollout

### Phase 1: Enforce Internal-Only Sending For New Signup Mailboxes

Goal:

- every new self-serve mailbox behaves like a free plan mailbox
- outbound `send_email`, `reply_to_message`, and HTTP send routes only allow
  recipients under `mailagents.net`

Changes:

1. change signup defaults in [src/lib/provisioning/signup.ts](/Users/zh/Documents/codeX/mailagents_cloudflare2/src/lib/provisioning/signup.ts)
   - set `allowedRecipientDomains` to `["mailagents.net"]`
   - keep `allowedTools` unchanged unless product intentionally wants to disable
     send for some plans

2. add a central outbound policy validator
   - create a new helper such as
     [src/lib/outbound-policy.ts](/Users/zh/Documents/codeX/mailagents_cloudflare2/src/lib/outbound-policy.ts)
   - validate:
     - normalized recipient domains from `to`, `cc`, `bcc`
     - policy allowlist
     - mailbox and agent active status
   - return a stable error code such as:
     - `recipient_domain_not_allowed`
     - `external_send_not_enabled`

3. call the validator from all send paths
   - HTTP self send in [src/routes/api.ts](/Users/zh/Documents/codeX/mailagents_cloudflare2/src/routes/api.ts)
   - HTTP message send/reply paths in [src/routes/api.ts](/Users/zh/Documents/codeX/mailagents_cloudflare2/src/routes/api.ts)
   - MCP `send_email` and `reply_to_message` in
     [src/routes/mcp.ts](/Users/zh/Documents/codeX/mailagents_cloudflare2/src/routes/mcp.ts)
   - shared helpers `createAndSendDraft` and `createAndSendDraftForMcp` are the
     best choke points

4. keep system-generated emails separate
   - signup welcome email and token reissue email are platform-controlled
     transactional sends
   - they should not inherit free-user outbound restrictions
   - if needed, pass a `policyBypassReason` only for explicit system flows

Why Phase 1 first:

- it matches the SES narrative immediately
- it requires no new commercial billing model to exist yet
- it closes the easiest abuse path with minimal schema work

### Phase 2: Add Tenant-Level Commercial Send Policy

The current repo has `tenantId` on many records, but no dedicated `tenants`
table. To model free versus paid safely, add a tenant-level send policy table.

Recommended schema:

- new migration:
  [migrations/0006_tenant_send_policies.sql](/Users/zh/Documents/codeX/mailagents_cloudflare2/migrations/0006_tenant_send_policies.sql)

Suggested table:

```sql
CREATE TABLE tenant_send_policies (
  tenant_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'free',
  outbound_status TEXT NOT NULL DEFAULT 'internal_only',
  internal_domain_allowlist_json TEXT NOT NULL,
  external_recipient_limit_daily INTEGER NOT NULL DEFAULT 0,
  internal_recipient_limit_daily INTEGER NOT NULL DEFAULT 20,
  max_unique_external_recipients_daily INTEGER NOT NULL DEFAULT 0,
  external_send_enabled INTEGER NOT NULL DEFAULT 0,
  review_required INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
```

Recommended enums:

- `plan`: `free`, `paid_review`, `paid_active`, `suspended`
- `outbound_status`: `internal_only`, `external_review`, `external_enabled`, `suspended`

Why tenant-level instead of agent-only:

- billing and abuse posture are commercial-account concepts
- one tenant may have multiple mailboxes and agents
- quota suspension should not require updating each agent separately

Repository changes:

- add repository functions in
  [src/repositories/agents.ts](/Users/zh/Documents/codeX/mailagents_cloudflare2/src/repositories/agents.ts)
  or a new repo file such as
  [src/repositories/tenant-policies.ts](/Users/zh/Documents/codeX/mailagents_cloudflare2/src/repositories/tenant-policies.ts)
  - `getTenantSendPolicy`
  - `upsertTenantSendPolicy`

API changes:

- add tenant send policy admin routes in
  [src/routes/api.ts](/Users/zh/Documents/codeX/mailagents_cloudflare2/src/routes/api.ts)
  - `GET /v1/tenants/:tenantId/send-policy`
  - `PUT /v1/tenants/:tenantId/send-policy`

Runtime rule:

- effective outbound policy = tenant policy first, then stricter agent policy
- agent policy should be treated as a narrowing override, not a widening one

### Phase 3: Add Rate Limits And Daily Quotas

Recipient domain restrictions stop the simplest abuse, but SES review will be
stronger if we also enforce rate and volume caps.

Recommended schema:

- new migration:
  [migrations/0007_outbound_usage_counters.sql](/Users/zh/Documents/codeX/mailagents_cloudflare2/migrations/0007_outbound_usage_counters.sql)

Suggested tables:

```sql
CREATE TABLE outbound_usage_windows (
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  window_type TEXT NOT NULL,
  window_start TEXT NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0,
  unique_recipient_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_type, scope_id, window_type, window_start)
);

CREATE TABLE outbound_recipient_fingerprints (
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  recipient_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope_type, scope_id, window_start, recipient_hash)
);
```

Recommended scope types:

- `tenant`
- `mailbox`

Recommended windows:

- `minute`
- `day`

Enforcement:

- check quota before `createDraft`
- increment counters only once the send request is accepted for queueing
- on idempotent replay, do not count again

Best integration points:

- [src/routes/api.ts](/Users/zh/Documents/codeX/mailagents_cloudflare2/src/routes/api.ts)
  `createAndSendDraft`
- [src/routes/mcp.ts](/Users/zh/Documents/codeX/mailagents_cloudflare2/src/routes/mcp.ts)
  `createAndSendDraftForMcp`

Recommended first limits:

- free:
  - external: `0/day`
  - internal: `20/day`
- paid_review:
  - external: `10/day`
  - internal: `100/day`
- paid_active:
  - external: `50/day` initial
  - internal: `200/day`

### Phase 4: Add Risk Events And Suspension Hooks

Recommended schema:

- new migration:
  [migrations/0008_risk_events.sql](/Users/zh/Documents/codeX/mailagents_cloudflare2/migrations/0008_risk_events.sql)

Suggested table:

```sql
CREATE TABLE risk_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  mailbox_id TEXT,
  agent_id TEXT,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  reason TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
```

Event examples:

- `recipient_domain_blocked`
- `external_send_blocked`
- `daily_quota_exceeded`
- `burst_rate_exceeded`
- `bounce_rate_high`
- `complaint_received`
- `manual_suspension`

This unlocks:

- auditability for SES review
- automated downgrade from `paid_active` to `paid_review`
- manual review queues and future admin UI

### Phase 5: Hook Bounce/Complaint Signals Into Policy

The repo already stores suppressions and delivery events. The next step is to
connect those signals back into account posture.

Touch points:

- suppression handling in
  [src/repositories/mail.ts](/Users/zh/Documents/codeX/mailagents_cloudflare2/src/repositories/mail.ts)
- SES event ingestion routes already documented in
  [docs/openapi.yaml](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/openapi.yaml)

Recommended behavior:

- complaint on any tenant:
  - record `risk_event`
  - temporarily freeze external sending
- repeated bounces:
  - lower quota automatically
- explicit admin review:
  - flip `outbound_status` to `suspended`

## Effective Enforcement Order

For every outbound send or reply:

1. validate token and tenant/mailbox binding
2. load tenant send policy
3. load agent policy
4. compute effective recipient allowlist
5. reject if mailbox or tenant is suspended
6. reject if any recipient domain is not allowed
7. reject if quota or burst limits are exceeded
8. reject if recipient is suppressed
9. enqueue outbound job
10. record counters and risk events

This ordering keeps rejects cheap and deterministic before queueing work.

## Fastest Repo-Safe Implementation Sequence

### PR 1

- add outbound policy helper
- enforce `allowedRecipientDomains`
- set signup default to `["mailagents.net"]`
- add stable errors for blocked external sends

### PR 2

- add `tenant_send_policies`
- add repository accessors
- add admin API routes for tenant send policy
- default every self-serve tenant to `free/internal_only`

### PR 3

- add usage counters
- enforce daily and per-minute limits
- add tests for idempotent replay and counter correctness

### PR 4

- add `risk_events`
- connect bounce/complaint signals to downgrade or suspension
- document SES-facing anti-abuse posture

## Test Matrix

Add coverage for:

1. free signup mailbox can send to `@mailagents.net`
2. free signup mailbox cannot send to `gmail.com`
3. free signup mailbox cannot reply to an external inbound sender
4. paid_review tenant can send only to explicitly allowed test domains
5. paid_active tenant can send externally within quota
6. quota-exceeded requests fail before outbound job creation
7. idempotent retries do not double-count quota
8. suspended tenant cannot use HTTP or MCP send paths

## SES Review Positioning

After Phase 1 and Phase 2 ship, the product can accurately state:

- newly registered free users cannot send to arbitrary internet recipients
- external sending is disabled by default
- only approved paid tenants can send externally
- outbound usage is rate-limited and auditable
- sending privileges can be narrowed, suspended, and restored centrally

That is the minimum posture needed to make the SES review narrative match the
runtime behavior.
