# Agent Client Release Checklist

This page describes the minimum work needed to turn the repository package
skeleton into a real published npm package.

Current package skeleton:

- [packages/mailagents-agent-client/package.json](/Users/zh/Documents/codeX/mailagents_cloudflare2/packages/mailagents-agent-client/package.json)
- [packages/mailagents-agent-client/src/index.ts](/Users/zh/Documents/codeX/mailagents_cloudflare2/packages/mailagents-agent-client/src/index.ts)
- [packages/mailagents-agent-client/README.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/packages/mailagents-agent-client/README.md)
- [packages/mailagents-agent-client/CHANGELOG.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/packages/mailagents-agent-client/CHANGELOG.md)

## Current State

- package name reserved in repo as `@mailagents/agent-client`
- workspace-aware root scripts available
- package-local `build` and `check` scripts available
- package-local dry-run pack script available
- typed models added for discovery and high-value draft/send flows
- package-local changelog added
- not published
- still marked `private: true`

## Pre-Publish Changes

Before publishing:

1. remove `"private": true` from the package
2. confirm the package name and npm scope are correct
3. confirm license metadata
4. confirm repository metadata
5. confirm homepage and bugs links
6. confirm `publishConfig` is appropriate for the intended npm scope
7. confirm the public API surface in `src/index.ts`
8. decide whether the current typed surface is enough for a first release
9. update the package-local changelog for the release cut

## Validation Steps

Run:

```bash
npm run check:agent-client
npm run build:agent-client
npm run pack:agent-client:dry-run
```

Then verify:

- `dist/` contains `index.js` and `index.d.ts`
- `npm pack --dry-run` includes only the expected files
- README examples still match the exported API
- the package works against:
  - `/v2/meta/runtime`
  - `/v2/meta/compatibility`
  - `/v2/meta/compatibility/schema`
  - MCP `tools/list`
  - at least one MCP `tools/call` happy path

If local npm cache permissions get in the way of `npm pack --dry-run`, a
temporary cache override is a safe workaround:

```bash
npm_config_cache=/tmp/mailagents-npm-cache npm run pack:agent-client:dry-run
```

## Recommended First Release Scope

Keep the first published version small:

- runtime discovery
- compatibility contract lookup
- compatibility schema lookup
- MCP `tools/list`
- generic MCP `callTool`
- typed discovery models
- a few high-value typed convenience helpers

Avoid in v1:

- trying to type every runtime object
- code generation
- auth token minting helpers tied to admin secrets
- opinionated retry loops

## Suggested Future Enhancements

- typed result models for more MCP tools beyond the highest-traffic paths
- helper methods for error-code branching
- ESM and CJS packaging strategy if needed
- published examples package or starter repo
- integration tests that exercise the shared `dev` environment
