# Agent Client Release Checklist

This page describes the minimum work needed to turn the repository package
skeleton into a real published npm package.

Current package skeleton:

- [packages/mailagents-agent-client/package.json](/Users/zh/Documents/codeX/mailagents_cloudflare2/packages/mailagents-agent-client/package.json)
- [packages/mailagents-agent-client/src/index.ts](/Users/zh/Documents/codeX/mailagents_cloudflare2/packages/mailagents-agent-client/src/index.ts)
- [packages/mailagents-agent-client/README.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/packages/mailagents-agent-client/README.md)
- [packages/mailagents-agent-client/CHANGELOG.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/packages/mailagents-agent-client/CHANGELOG.md)
- [docs/agent-client-versioning.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/agent-client-versioning.md)
- [docs/agent-client-release-notes-0.1.0.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/agent-client-release-notes-0.1.0.md)

## Current State

- package name reserved in repo as `@mailagents/agent-client`
- workspace-aware root scripts available
- package-local `build` and `check` scripts available
- package-local dry-run pack script available
- typed models added for discovery and high-value draft/send flows
- stable error-code helpers added for MCP branching
- package-local changelog added
- package is configured for publish dry-run validation
- not published

## Pre-Publish Changes

Before publishing:

1. confirm the package name and npm scope are correct
2. confirm license metadata
3. confirm repository metadata
4. confirm homepage and bugs links
5. confirm `publishConfig` is appropriate for the intended npm scope
6. confirm the public API surface in `src/index.ts`
7. decide whether the current typed surface is enough for a first release
8. update the package-local changelog for the release cut
9. finalize the draft first-release notes

## Validation Steps

Run:

```bash
npm run check:agent-client
npm run build:agent-client
npm run pack:agent-client:dry-run
```

Before the actual release, also run:

```bash
npm_config_cache=/tmp/mailagents-npm-cache npm run publish:agent-client:dry-run
```

You should also confirm the publishing account is authenticated for npm before
the real release cut.

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

The same cache override is also the recommended pattern for
`npm run publish:agent-client:dry-run`.

## Recommended First Release Scope

Keep the first published version small:

- runtime discovery
- compatibility contract lookup
- compatibility schema lookup
- MCP `tools/list`
- generic MCP `callTool`
- typed discovery models
- a few high-value typed convenience helpers
- stable error-code branching helpers

Avoid in v1:

- trying to type every runtime object
- code generation
- auth token minting helpers tied to admin secrets
- opinionated retry loops

## Versioning Guidance

Use the package policy in
[docs/agent-client-versioning.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/agent-client-versioning.md)
when deciding whether a change is patch, minor, or major.

## Suggested Future Enhancements

- typed result models for more MCP tools beyond the highest-traffic paths
- helper methods for error-code branching
- ESM and CJS packaging strategy if needed
- published examples package or starter repo
- integration tests that exercise the shared `dev` environment
