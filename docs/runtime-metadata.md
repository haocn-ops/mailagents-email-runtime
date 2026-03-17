# Runtime Metadata

This runtime exposes a versioned metadata endpoint at `/v2/meta/runtime`.

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

For each MCP tool, the metadata includes:

- `riskLevel`
- `sideEffecting`
- `humanReviewRequired`
- `composite`

The MCP `initialize` response also includes the same metadata under
`result.meta`, so agents can discover capabilities from either entry point.
