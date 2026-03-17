# Runtime Compatibility Contract

This runtime exposes a compatibility contract at `/v2/meta/compatibility`.
It also exposes a JSON Schema for that contract at `/v2/meta/compatibility/schema`.

Use it when an external agent, hosted integration, or SDK needs a more stable
machine-oriented contract than the higher-level runtime metadata endpoint.

Example:

```bash
curl -sS http://127.0.0.1:8787/v2/meta/compatibility | jq

curl -sS http://127.0.0.1:8787/v2/meta/compatibility/schema | jq
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
- `evolution`
- `guarantees`
- `mcp`
- `workflows`
- `errors`
- `routes`

Key details:

- `contract.version` is the compatibility version for agent-facing integration behavior
- `contract.changelogPath` points to the repository changelog used for rollout notes
- `discovery.runtimeMetadataPath` points to the richer runtime metadata endpoint
- `discovery.compatibilityPath` points back to this contract
- `discovery.compatibilitySchemaPath` points to the JSON Schema for contract validation
- `evolution.versioningPolicy` explains which changes are additive and which require a compatibility version bump
- `evolution.deprecationPolicy` explains how removals should be announced
- `evolution.deprecatedFields` is the machine-readable place to watch for pending removals
- `guarantees.stableErrorCodes` lists the MCP error codes that callers may branch on
- `guarantees.stableToolAnnotations` lists the tool annotation fields expected to remain stable

This contract is especially useful for:

- external MCP clients
- hosted agent platforms
- generated SDKs or wrappers
- CI smoke checks that need stronger backward-compatibility assertions

The schema endpoint is especially useful for:

- CI compatibility checks
- SDK fixture validation
- contract snapshot testing
- generated clients that validate responses before use

Current deprecation stance:

- additive optional fields may appear without a compatibility version bump
- stable fields and stable error codes should be announced as deprecated before removal
- the target minimum notice window is one compatibility version
