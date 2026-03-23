# Runtime Metadata

This runtime exposes a versioned metadata endpoint at `/v2/meta/runtime`.
It also exposes a stricter compatibility contract at `/v2/meta/compatibility`.

Use it when an operator, agent, or integration needs to discover:

- runtime name and version
- supported HTTP and MCP surfaces
- available MCP tools and required scopes
- tool risk level and whether human review is expected
- workflow packs currently shipped with the runtime
- idempotency retention defaults
- whether admin and debug routes are enabled in the current environment

Example:

```bash
curl -sS http://127.0.0.1:8787/v2/meta/runtime | jq
```

The response is intended to be:

- stable enough for agent capability discovery
- environment-aware for admin/debug exposure and retention windows
- higher level than OpenAPI, especially for MCP and workflow-pack support

Current top-level fields:

- `server`
- `api`
- `mcp`
- `workflows`
- `idempotency`
- `routes`
- `delivery`

The `api` section includes:

- `metaRuntimePath`
- `compatibilityPath`
- `compatibilitySchemaPath`
- `mcpPath`
- `adminMcpPath` when admin routes are enabled

For each MCP tool, the metadata includes:

- `riskLevel`
- `sideEffecting`
- `humanReviewRequired`
- `composite`
- `supportsPartialAuthorization`
- `sendAdditionalScopes`
- `category`
- `recommendedForMailboxAgents`

`category` groups tools by the job they perform. Current categories are:

- `provisioning`
- `policy`
- `task_read`
- `mail_read`
- `thread_read`
- `draft_control`
- `mail_send`
- `mail_reply`
- `recovery`

`recommendedForMailboxAgents` marks the default mailbox-scoped workflow surface.
Today this is primarily:

- `list_messages`
- `send_email`
- `reply_to_message`

For composite tools that can either draft-only or draft-and-send:

- `requiredScopes` describes the minimum scopes needed to use the tool at all
- `sendAdditionalScopes` describes the extra scopes needed when the call will
  trigger delivery
- `supportsPartialAuthorization` indicates that a token may be allowed to use
  only the lower-risk subset of the tool behavior

The MCP `initialize` response also includes the same metadata under
`result.meta`, so agents can discover capabilities from either entry point.

When admin routes are enabled, operator agents can also use `api.adminMcpPath`
to discover the separate admin MCP surface. That endpoint is authenticated with
`x-admin-secret` and is intended only for high-trust operator workflows.

Admin MCP `initialize` also returns an `adminMcp` section under `result.meta`.
That section includes:

- admin auth mode and path
- admin tool summaries
- admin workflow packs with `goal`, `categories`,
  `recommendedToolSequence`, `sideEffects`, and `stopConditions`

This allows operator agents to discover not just which tools exist, but also
which multi-step workflows the runtime expects them to use.

For clients that need a narrower and more backward-compatible contract, see
[docs/runtime-compatibility.md](../docs/runtime-compatibility.md).

That contract also carries machine-readable evolution rules such as:

- compatibility-version bump triggers
- deprecation announcement policy
- a `deprecatedFields` list for pending removals
