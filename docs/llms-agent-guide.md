# LLM Agent Guide

This is the single best starting point for an LLM agent or agent-platform
developer integrating with the Mailagents Email Runtime.

If you only read one page first, read this one.

## What This Runtime Is

Mailagents is an email-first AI agent runtime built on:

- Cloudflare Workers
- Cloudflare Email Routing
- Cloudflare Queues
- Cloudflare R2
- Cloudflare D1
- Amazon SES

It provides:

- inbound email ingestion and normalization
- tenant-scoped agent and mailbox access
- drafts as the control point for outbound side effects
- asynchronous outbound delivery through SES
- MCP tools and composite workflows for agent orchestration

## The Fastest Safe Mental Model

Think in this order:

1. discover capabilities
2. mint a least-privilege bearer token
3. read state before side effects
4. create a draft before send
5. use explicit `idempotencyKey` values for retryable side effects
6. branch only on stable error codes

## Start Here

Read these in order:

1. [docs/ai-onboarding.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/ai-onboarding.md)
2. [docs/ai-auth.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/ai-auth.md)
3. [docs/runtime-metadata.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/runtime-metadata.md)
4. [docs/runtime-compatibility.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/runtime-compatibility.md)
5. [docs/agent-sdk-examples.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/agent-sdk-examples.md)
6. [docs/agent-client-helper.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/agent-client-helper.md)

Use these as deeper references:

- [docs/ai-decision-rules.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/ai-decision-rules.md)
- [docs/agent-workflow-packs.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/agent-workflow-packs.md)
- [docs/agent-capabilities.json](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/agent-capabilities.json)
- [docs/agent-client-helper.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/agent-client-helper.md)
- [docs/mcp-local.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/mcp-local.md)
- [docs/openapi.yaml](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/openapi.yaml)
- `npm run example:agent:discover`
- `npm run example:agent:reply-draft`
- `npm run example:agent:operator-send`

## Capability Discovery

Three discovery layers are available:

1. runtime metadata
   Path: `/v2/meta/runtime`
   Use for richer environment-aware discovery.
2. compatibility contract
   Path: `/v2/meta/compatibility`
   Use for stable agent branching logic and long-lived integrations.
3. compatibility schema
   Path: `/v2/meta/compatibility/schema`
   Use for CI validation, SDK fixtures, and contract snapshot testing.
4. agent capabilities snapshot
   Path: `docs/agent-capabilities.json`
   Use as a repository-pinned example response and integration fixture.

Current shared `dev` URLs:

- [runtime metadata](https://mailagents-dev.izhenghaocn.workers.dev/v2/meta/runtime)
- [compatibility contract](https://mailagents-dev.izhenghaocn.workers.dev/v2/meta/compatibility)
- [compatibility schema](https://mailagents-dev.izhenghaocn.workers.dev/v2/meta/compatibility/schema)
- [agent capabilities snapshot](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/agent-capabilities.json)

## Authentication

Default integration auth is a signed bearer token.

Minimum common scopes by job:

- read-only mail agent
  - `mail:read`
  - `task:read`
- reply-capable mail agent
  - `mail:read`
  - `task:read`
  - `draft:create`
  - `draft:read`
  - `draft:send`
- provisioning agent
  - `agent:create`
  - `agent:update`
  - `agent:bind`
- recovery operator
  - `mail:replay`

Use:

- short expirations
- mailbox-scoped tokens when possible
- the narrowest scope set that still completes the workflow

## Core Safe Rules

- prefer reads before writes
- create drafts before any delivery step
- treat `send_draft` as the first real outbound side effect
- treat replay as recovery, not as implicit permission to send
- keep admin and debug routes out of normal agent workflows
- reuse the same `idempotencyKey` when retrying the same logical send or replay

## Best MCP Entry Points

Primitive tools:

- `get_message`
- `get_message_content`
- `get_thread`
- `create_draft`
- `get_draft`
- `send_draft`
- `replay_message`

Composite tools:

- `reply_to_inbound_email`
- `operator_manual_send`

When planning from `tools/list`, always inspect:

- `riskLevel`
- `sideEffecting`
- `humanReviewRequired`
- `supportsPartialAuthorization`
- `sendAdditionalScopes`

## Stable Error Handling

Do not branch on free-form error text.

Branch on stable MCP error codes from the compatibility contract, such as:

- `auth_unauthorized`
- `auth_missing_scope`
- `access_mailbox_denied`
- `resource_message_not_found`
- `resource_draft_not_found`
- `idempotency_conflict`
- `idempotency_in_progress`

Suggested behavior:

- `auth_missing_scope`
  Stop and request broader authorization.
- `access_mailbox_denied`
  Stop and request mailbox approval or a different token.
- `resource_*_not_found`
  Refresh identifiers or upstream state.
- `idempotency_in_progress`
  Retry after a short delay.
- `idempotency_conflict`
  Treat as a different logical request unless caller reuse is intentional.

## Best Next Document By Need

If you are trying to:

- understand the product and safety model
  - [docs/ai-onboarding.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/ai-onboarding.md)
- understand auth and scopes
  - [docs/ai-auth.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/ai-auth.md)
- orchestrate reply and send workflows
  - [docs/agent-workflow-packs.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/agent-workflow-packs.md)
- copy working requests quickly
  - [docs/agent-sdk-examples.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/agent-sdk-examples.md)
- start from a lightweight TypeScript helper
  - [docs/agent-client-helper.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/agent-client-helper.md)
- integrate against the stable contract
  - [docs/runtime-compatibility.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/runtime-compatibility.md)
- validate compatibility in CI
  - [docs/runtime-compatibility.schema.json](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/runtime-compatibility.schema.json)
- start from a pinned fixture instead of a live endpoint
  - [docs/agent-capabilities.json](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/agent-capabilities.json)

## Recommended External-Agent Startup Sequence

1. read `/v2/meta/compatibility`
2. validate against `/v2/meta/compatibility/schema`
3. mint a mailbox-scoped token
4. call `tools/list`
5. filter out tools that require human review when automation is not allowed
6. prefer read tools first
7. create drafts before sends
8. use `idempotencyKey` on side-effecting retries
9. record the compatibility version you integrated against
