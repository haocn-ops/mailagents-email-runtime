# AI Agents

This page covers agent provisioning, mailbox binding, and task access.

## Core Endpoints

- `POST /v1/agents`
- `GET /v1/agents/{agentId}`
- `PATCH /v1/agents/{agentId}`
- `POST /v1/agents/{agentId}/mailboxes`
- `GET /v1/agents/{agentId}/mailboxes`
- `PUT /v1/agents/{agentId}/policy`
- `GET /v1/agents/{agentId}/tasks`

## Create an Agent

Use `POST /v1/agents` when a tenant needs a new runtime identity with its own
configuration.

Required behavior from the caller:

- token must include `agent:create`
- request `tenantId` must match the token tenant

Required request fields in the current implementation:

- `tenantId`
- `name`
- `mode`

The runtime currently supports these agent modes:

- `assistant`
- `autonomous`
- `review_only`

## Update an Agent

Use `PATCH /v1/agents/{agentId}` to change:

- name
- status
- mode
- config

Token requirements:

- `agent:update`
- matching tenant
- matching `agentId` if the token is agent-scoped

## Bind a Mailbox

Use `POST /v1/agents/{agentId}/mailboxes` to connect an agent to a mailbox.

Required request fields in the current implementation:

- `tenantId`
- `mailboxId`
- `role`

Supported binding roles:

- `primary`
- `shared`
- `send_only`
- `receive_only`

Binding rules:

- the token must include `agent:bind`
- the token tenant must match `tenantId`
- if the token is agent-scoped, `agentId` must match
- if the token is mailbox-scoped, `mailboxId` must be allowed

## Agent Policy

Use `PUT /v1/agents/{agentId}/policy` to define reply constraints and safety
controls.

Required policy fields in the current implementation:

- `autoReplyEnabled`
- `humanReviewRequired`
- `confidenceThreshold`
- `maxAutoRepliesPerThread`

Optional policy fields:

- `allowedRecipientDomains`
- `blockedSenderDomains`
- `allowedTools`

This is an important place to encode operational rules instead of relying on
prompt text alone.

## Task Access

Use `GET /v1/agents/{agentId}/tasks` to list work assigned to the agent.

Token requirements:

- `task:read`
- matching `agentId` when the token is agent-scoped

Optional query filter:

- `status`: `queued`, `running`, `done`, `needs_review`, or `failed`

## Recommended Provisioning Flow

1. mint a token for the target tenant
2. create the agent
3. bind one or more mailboxes
4. upsert policy
5. read tasks for the bound mailbox context

## Safe Defaults

- prefer one token per agent workflow rather than one broad token for all agents
- bind only the mailboxes the agent truly needs
- use policy fields to enforce delivery constraints
- do not assume mailbox access unless both binding and token policy allow it
