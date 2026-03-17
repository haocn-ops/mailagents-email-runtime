# Runtime Compatibility Contract

This runtime exposes a compatibility contract at `/v2/meta/compatibility`.

Use it when an external agent, hosted integration, or SDK needs a more stable
machine-oriented contract than the higher-level runtime metadata endpoint.

Example:

```bash
curl -sS http://127.0.0.1:8787/v2/meta/compatibility | jq
```

The contract is intended to stabilize:

- compatibility versioning for external agents
- MCP discovery expectations
- stable tool annotation fields
- stable machine-readable MCP error codes
- idempotent operation names

Top-level fields:

- `contract`
- `discovery`
- `guarantees`
- `mcp`
- `workflows`
- `errors`
- `routes`

Key details:

- `contract.version` is the compatibility version for agent-facing integration behavior
- `discovery.runtimeMetadataPath` points to the richer runtime metadata endpoint
- `discovery.compatibilityPath` points back to this contract
- `guarantees.stableErrorCodes` lists the MCP error codes that callers may branch on
- `guarantees.stableToolAnnotations` lists the tool annotation fields expected to remain stable

This contract is especially useful for:

- external MCP clients
- hosted agent platforms
- generated SDKs or wrappers
- CI smoke checks that need stronger backward-compatibility assertions
