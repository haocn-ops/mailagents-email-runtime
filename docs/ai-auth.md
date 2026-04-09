# AI Auth

This page explains how AI agents should authenticate to the Mailagents Email
Runtime.

## Authentication Types

The runtime has three authentication surfaces:

- bearer tokens for normal product APIs
- `x-admin-secret` for privileged admin routes
- `x-webhook-shared-secret` for SES webhook ingestion

For AI agents, bearer tokens are the default integration method.

## Signup API Tokens

The signup API at `POST /public/signup` issues a default bearer token for the
newly created mailbox when `API_SIGNING_SECRET` is configured.

The default signup API token is:

- mailbox-scoped to the new mailbox
- agent-scoped to the default agent created during signup
- returned inline in the signup API response by default
- optionally also delivered through the configured operator channel

Default scopes:

- `task:read`
- `mail:read`
- `draft:create`
- `draft:read`
- `draft:send`

These default scopes are enough for:

- mailbox self routes such as `GET /v1/mailboxes/self/messages`
- high-level send and reply routes such as `POST /v1/messages/send`
- self-service billing routes such as `POST /v1/billing/topup`,
  `POST /v1/billing/upgrade-intent`, and `POST /v1/billing/payment/confirm`
- self-service tenant status routes such as `GET /v1/billing/account`,
  `GET /v1/billing/receipts`, and `GET /v1/tenants/{tenantId}/send-policy`
- MCP mailbox tools such as `list_messages`, `send_email`, and
  `reply_to_message`

The default expiration can be controlled with
`SELF_SERVE_ACCESS_TOKEN_TTL_SECONDS`. If it is not set, the signup API token
defaults to 30 days.

Inline token behavior by route:

- `POST /public/signup` returns the initial mailbox-scoped `accessToken`
  inline by default
- `POST /public/token/reissue` is recovery-only and never returns the refreshed
  token inline
- `POST /v1/auth/token/rotate` is the authenticated proactive path and can
  return the rotated token inline

## Recovering an Expired Signup Token

If the signup API token expires, use `POST /public/token/reissue`.

Important behavior:

- provide `mailboxAlias` or `mailboxAddress`
- the API always returns a generic acceptance response
- the refreshed token is emailed only to the original `operatorEmail` from signup
- the refreshed token is never returned inline to the caller
- mailbox cooldowns and source-IP rate limits apply to reduce abuse

## Rotating a Still-Valid Signup Token

If the signup API token is still valid and the agent wants to rotate
proactively without emailing the operator, use `POST /v1/auth/token/rotate`.

Important behavior:

- the current bearer token must still be valid
- the route can return the rotated token inline
- the route can optionally deliver the rotated token to the mailbox itself
- the route does not email the original `operatorEmail`
- the old token remains valid unless a future revoke flow is added separately

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

These scopes cover both:

- the high-level mailbox send and reply surface
- the lower-level explicit draft lifecycle when needed

Provisioning agent:

- `agent:create`
- `agent:read`
- `agent:update`
- `agent:bind`

Recovery operator or recovery automation:

- `mail:replay`

Grant `mail:replay` sparingly. Replay has higher duplication risk than normal
read, send, or draft flows.

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
