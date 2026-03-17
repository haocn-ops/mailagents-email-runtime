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

The `api` section includes:

- `metaRuntimePath`
- `compatibilityPath`
- `compatibilitySchemaPath`
- `mcpPath`

For each MCP tool, the metadata includes:

- `riskLevel`
- `sideEffecting`
- `humanReviewRequired`
- `composite`
- `supportsPartialAuthorization`
- `sendAdditionalScopes`

For composite tools that can either draft-only or draft-and-send:

- `requiredScopes` describes the minimum scopes needed to use the tool at all
- `sendAdditionalScopes` describes the extra scopes needed when the call will
  trigger delivery
- `supportsPartialAuthorization` indicates that a token may be allowed to use
  only the lower-risk subset of the tool behavior

The MCP `initialize` response also includes the same metadata under
`result.meta`, so agents can discover capabilities from either entry point.

For clients that need a narrower and more backward-compatible contract, see
[docs/runtime-compatibility.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/runtime-compatibility.md).

That contract also carries machine-readable evolution rules such as:

- compatibility-version bump triggers
- deprecation announcement policy
- a `deprecatedFields` list for pending removals
