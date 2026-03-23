# Admin MCP

This runtime now exposes a dedicated admin MCP surface at `/admin/mcp`.

Use it for operator-guided agents that already hold the runtime `x-admin-secret`
and need a tool-oriented interface for privileged tasks such as:

- minting bearer tokens for downstream mailbox or tenant workflows
- inspecting runtime state that is only available through debug surfaces
- updating tenant send policy during review or suspension flows
- managing suppressions

## Why This Is Separate From `/mcp`

The normal `/mcp` endpoint is the default mailbox and tenant workflow surface.
It is bearer-token based, least-privilege by design, and intended for normal
agent integrations.

`/admin/mcp` is intentionally separate because it:

- uses `x-admin-secret`, not bearer auth
- is gated by `ADMIN_ROUTES_ENABLED`
- exposes high-trust operator and forensic capabilities
- should not appear in default mailbox-agent workflow planning

This keeps normal agent discovery safe while still giving operator agents a
first-class MCP interface.

The TypeScript client also exposes typed admin helpers on top of this surface,
including:

- `withAdminSecret()`
- `getAdminMcpMetadata()`
- `getAdminWorkflowSurface()`
- `adminCreateAccessToken()`
- `adminBootstrapMailboxAgentToken()`
- `adminBootstrapMailboxAgentWorkflow()`
- `adminListAgents()`
- `adminGetTenantSendPolicy()`
- `adminApplyTenantSendPolicyReview()`
- `adminGetTenantReviewContext()`
- `adminReviewTenantOutboundAccessWorkflow()`
- `adminGetDebugMessage()`
- `adminInspectDeliveryCase()`
- `adminInspectDeliveryCaseWorkflow()`
- `adminAddSuppression()`

## Protocol

`/admin/mcp` supports the same minimal HTTP MCP methods as `/mcp`:

- `initialize`
- `tools/list`
- `tools/call`

Auth requirements:

- `ADMIN_ROUTES_ENABLED=true`
- header: `x-admin-secret: ...`

`initialize` returns the normal runtime metadata under `result.meta` plus an
`adminMcp` section describing the admin path, auth mode, admin tool list, and
the current admin workflow packs.

The narrower compatibility contract at `/v2/meta/compatibility` also exposes
an optional `admin.mcp` section when admin routes are enabled. That section is
useful for agents that want a more stable machine-readable discovery surface
before they call admin MCP directly.

Each admin workflow pack currently includes:

- `description`
- `goal`
- `categories`
- `recommendedToolSequence`
- `sideEffects`
- `stopConditions`

Current admin workflow packs:

- `bootstrap_mailbox_agent`
- `review_tenant_outbound_access`
- `forensic_delivery_inspection`

For a doc-first and machine-readable snapshot of those workflow packs, see:

- [docs/admin-workflow-packs.md](./admin-workflow-packs.md)
- [docs/admin-workflow-packs.json](./admin-workflow-packs.json)

## Current Tool Catalog

- `create_access_token`
- `bootstrap_mailbox_agent_token`
- `list_agents`
- `get_agent`
- `list_mailboxes`
- `get_mailbox`
- `get_tenant_send_policy`
- `upsert_tenant_send_policy`
- `apply_tenant_send_policy_review`
- `get_tenant_review_context`
- `get_debug_message`
- `get_debug_draft`
- `get_debug_outbound_job`
- `inspect_delivery_case`
- `get_suppression`
- `add_suppression`

The recommended pattern is:

1. use `create_access_token` to mint the narrowest bearer token needed
2. drop back to the normal `/mcp` or HTTP mailbox routes for standard work
3. reserve admin MCP for operator-only decisions and forensic inspection

For SDK users, `MailagentsAgentClient(...).operator().openMailboxSession()`
wraps that handoff directly: admin MCP performs the bootstrap, then the
returned mailbox session continues on the normal mailbox-scoped helper surface.

Runnable repository examples:

- `npm run example:agent:discover-admin`
- `npm run example:agent:admin-workflows`
- `npm run example:agent:operator-client`
- `npm run example:agent:admin-bootstrap`
- `npm run example:agent:admin-review`
- `npm run example:agent:admin-forensics`

## Local Example

List admin tools:

```bash
curl -sS http://127.0.0.1:8787/admin/mcp \
  -H 'content-type: application/json' \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list",
    "params": {}
  }'
```

Mint a mailbox-scoped bearer token:

```bash
curl -sS http://127.0.0.1:8787/admin/mcp \
  -H 'content-type: application/json' \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "create_access_token",
      "arguments": {
        "sub": "operator-agent",
        "tenantId": "t_demo",
        "agentId": "agt_demo",
        "scopes": ["mail:read", "draft:create", "draft:send"],
        "mailboxIds": ["mbx_demo"],
        "expiresInSeconds": 1800
      }
    }
  }'
```

Inspect a message plus delivery events:

```bash
curl -sS http://127.0.0.1:8787/admin/mcp \
  -H 'content-type: application/json' \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "get_debug_message",
      "arguments": {
        "messageId": "msg_demo_inbound"
      }
    }
  }'
```

## Safety Notes

- do not use admin MCP as the default integration path
- prefer minting a least-privilege bearer token and switching back to `/mcp`
- keep `ADMIN_ROUTES_ENABLED` off outside controlled environments unless there
  is an explicit operator need
- treat `upsert_tenant_send_policy`, `apply_tenant_send_policy_review`, and
  `add_suppression` as human-review actions
