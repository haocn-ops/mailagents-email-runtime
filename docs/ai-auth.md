# AI Auth

This page explains how AI agents should authenticate to the Mailagents Email
Runtime.

## Authentication Types

The runtime has three authentication surfaces:

- bearer tokens for normal product APIs
- `x-admin-secret` for privileged admin routes
- `x-webhook-shared-secret` for SES webhook ingestion

For AI agents, bearer tokens are the default integration method.

## Minting a Bearer Token

Use `POST /v1/auth/tokens`.

Requirements:

- admin routes must be enabled
- caller must provide `x-admin-secret`
- `API_SIGNING_SECRET` must be configured

Required request fields:

- `sub`
- `tenantId`
- `scopes`

Optional request fields:

- `agentId`
- `mailboxIds`
- `expiresInSeconds`

Example:

```json
{
  "sub": "agent-worker",
  "tenantId": "t_demo",
  "agentId": "agt_demo",
  "scopes": ["mail:read", "task:read", "draft:create", "draft:read", "draft:send"],
  "mailboxIds": ["mbx_demo"],
  "expiresInSeconds": 3600
}
```

## Access Enforcement

The runtime enforces:

1. token signature and expiry
2. required scopes
3. tenant boundary
4. optional agent boundary
5. optional mailbox boundary

This means a valid token can still fail with `403` if:

- the tenant does not match
- the agent does not match `agentId`
- the mailbox is outside allowed `mailboxIds`
- the required scope is missing

## Scope Guidance

Read-only mail agent:

- `mail:read`
- `task:read`

Reply-capable mail agent:

- `mail:read`
- `task:read`
- `draft:create`
- `draft:read`
- `draft:send`

Provisioning agent:

- `agent:create`
- `agent:read`
- `agent:update`
- `agent:bind`

Recovery operator or recovery automation:

- `mail:replay`

Grant `mail:replay` sparingly. Replay has higher duplication risk than normal
read or draft flows.

## Best Practices

- use short expirations unless a longer-lived token is necessary
- include `agentId` when the token is meant for one specific agent
- include `mailboxIds` when the token should be limited to known mailboxes
- avoid using the admin secret as a general-purpose integration credential
- keep webhook secrets separate from bearer token and admin credentials

## Common Failures

- `401 Missing bearer token`: no `Authorization: Bearer ...` header
- `401 Invalid bearer token`: bad signature, malformed token, or expired token
- `403 Missing scopes`: token is valid but under-scoped
- `403 Tenant access denied`: token tenant does not match the resource
- `403 Agent access denied`: token agent restriction blocks the request
- `403 Mailbox access denied`: token mailbox restriction blocks the request
- `404 Admin routes are disabled`: token minting route is off in this environment
