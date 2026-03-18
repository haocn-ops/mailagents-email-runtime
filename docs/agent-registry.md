# Agent Registry Design

This document upgrades the MVP agent record model into a versioned registry suitable
for agent infrastructure.

## Why The MVP Was Not Enough

The initial MVP modeled agents as:

- an `agents` row
- mailbox bindings
- policy bindings
- execution records

That is enough for runtime dispatch, but not enough for a true control plane.

An infrastructure-grade registry must answer:

- which agent exists
- which version is currently published
- what capabilities it exposes
- what tools it can use
- where each version is deployed
- which mailbox or workflow is pinned to which version
- how to roll forward or roll back safely

## Design Goals

- separate stable agent identity from mutable configuration
- support versioning and deployment pinning
- make capabilities queryable instead of hiding everything in blobs
- preserve mailbox-based routing for the current email runtime
- keep the model extensible for non-email channels later

## Core Resources

### Agent

Stable identity for an agent family.

Fields:

- `id`
- `tenant_id`
- `slug`
- `name`
- `description`
- `status`
- `default_version_id`
- `created_at`
- `updated_at`

Suggested `status` values:

- `draft`
- `active`
- `disabled`
- `archived`

### Agent Version

Immutable version record for prompt, model, tools, and execution manifest.

Fields:

- `id`
- `agent_id`
- `version`
- `model`
- `config_r2_key`
- `manifest_r2_key`
- `status`
- `created_at`

Suggested `status` values:

- `draft`
- `published`
- `deprecated`

### Agent Capability

Query-friendly declaration of what an agent version can do.

Fields:

- `id`
- `agent_version_id`
- `capability`
- `config_json`
- `created_at`

Examples:

- `reply_email`
- `classify_email`
- `extract_invoice`
- `forward_message`
- `call_webhook`

### Agent Tool Binding

Concrete tool declarations for one agent version.

Fields:

- `id`
- `agent_version_id`
- `tool_name`
- `enabled`
- `config_json`
- `created_at`

### Agent Deployment

Pins one agent version to a runtime target.

Fields:

- `id`
- `tenant_id`
- `agent_id`
- `agent_version_id`
- `target_type`
- `target_id`
- `status`
- `created_at`
- `updated_at`

Suggested `target_type` values:

- `mailbox`
- `workflow`
- `tenant_default`

Suggested `status` values:

- `active`
- `paused`
- `rolled_back`

## Relationship To Existing MVP Tables

The current tables remain useful:

- `agent_mailboxes`
- `agent_policies`
- `agent_runs`

But their meaning shifts slightly:

- `agent_mailboxes` becomes a mailbox ownership or eligibility table
- `agent_deployments` becomes the source of truth for which version serves a mailbox
- `agent_policies` can stay agent-level for MVP, but version-level policy overrides can
  be added later if needed

## Recommended Resolution Logic

For inbound email:

1. resolve mailbox
2. find active mailbox deployment in `agent_deployments`
3. load the pinned `agent_version`
4. load capabilities and tool bindings
5. execute agent run against that exact version

This is the key improvement over the MVP model, which only resolved `agent_id`.

## Control Plane API

Recommended API surface:

- `POST /v1/agents`
- `GET /v1/agents`
- `GET /v1/agents/{agentId}`
- `PATCH /v1/agents/{agentId}`
- `POST /v1/agents/{agentId}/versions`
- `GET /v1/agents/{agentId}/versions`
- `GET /v1/agents/{agentId}/versions/{versionId}`
- `POST /v1/agents/{agentId}/deployments`
- `GET /v1/agents/{agentId}/deployments`
- `POST /v1/agents/{agentId}/mailboxes`
- `PUT /v1/agents/{agentId}/policy`

## Migration Strategy

The safest upgrade path is additive:

1. keep existing `agents`, `agent_mailboxes`, and `agent_policies`
2. add `agent_versions`, `agent_capabilities`, `agent_tool_bindings`, `agent_deployments`
3. backfill one `v1` version for each existing agent
4. set `agents.default_version_id`
5. update runtime resolution to prefer deployments and versions

## Why This Matters

Without a real registry, the platform cannot safely support:

- version rollouts
- rollbacks
- capability discovery
- per-mailbox version pinning
- reproducible audit
- future marketplace or hosted agent patterns

The registry is the control plane that makes the email runtime behave like infrastructure
instead of only a task router.
