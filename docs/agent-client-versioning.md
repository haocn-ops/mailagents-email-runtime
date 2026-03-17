# Agent Client Versioning Policy

This page defines how `@mailagents/agent-client` should evolve once it becomes
a published package.

Related files:

- [packages/mailagents-agent-client/package.json](/Users/zh/Documents/codeX/mailagents_cloudflare2/packages/mailagents-agent-client/package.json)
- [packages/mailagents-agent-client/CHANGELOG.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/packages/mailagents-agent-client/CHANGELOG.md)
- [docs/runtime-compatibility.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/runtime-compatibility.md)

## Goals

- keep the first public package small and predictable
- align SDK changes with the runtime compatibility contract
- avoid breaking external agents through accidental surface changes

## Semver Rules

Use standard semver for the npm package.

### Patch Releases

Use patch releases for:

- internal implementation fixes with no public API change
- documentation-only updates
- narrower type corrections that do not invalidate correct callers
- additional stable error-code helpers that do not change existing behavior

### Minor Releases

Use minor releases for:

- new helper methods
- new typed models
- support for newly added stable runtime fields
- support for new MCP tools or workflow helpers
- additive options on existing methods

### Major Releases

Use major releases for:

- removing exported APIs
- renaming exported types or methods
- changing method signatures in a way that breaks existing callers
- changing runtime assumptions in a way that requires consumer rewrites

## Relationship To Runtime Compatibility

The runtime publishes its own compatibility contract:

- [docs/runtime-compatibility.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/runtime-compatibility.md)

The package should follow these rules:

- additive runtime fields can be supported in a package minor release
- runtime compatibility-version bumps do not automatically require a package major release
- package major releases should be rare and driven by SDK surface breaks, not by additive runtime growth
- if the runtime deprecates a field the SDK exposes directly, the SDK should first mark that export as deprecated before removing it in a later major release

## First Public Release Boundary

The intended `0.1.x` release line should stay focused on:

- runtime discovery
- compatibility contract and schema lookup
- `tools/list`
- generic `callTool`
- typed helpers for high-traffic provisioning, read, and draft/send flows
- stable error-code branching helpers

It should avoid:

- token mint helpers tied to admin secrets
- code generation
- retry frameworks
- broad type coverage for every runtime object

## Release Discipline

For each release:

1. update [packages/mailagents-agent-client/CHANGELOG.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/packages/mailagents-agent-client/CHANGELOG.md)
2. confirm the exported API in [packages/mailagents-agent-client/src/index.ts](/Users/zh/Documents/codeX/mailagents_cloudflare2/packages/mailagents-agent-client/src/index.ts)
3. run `npm run check:agent-client`
4. run `npm run build:agent-client`
5. run `npm_config_cache=/tmp/mailagents-npm-cache npm run pack:agent-client:dry-run`
6. verify examples and README still match the shipped package surface
