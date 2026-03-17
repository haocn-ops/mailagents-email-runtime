# Changelog

All notable changes to `@mailagents/agent-client` will be documented here.

## [Unreleased]

### Added

- package skeleton for `@mailagents/agent-client`
- runtime discovery helpers
- compatibility contract and schema helpers
- MCP `tools/list` and generic `callTool` support
- stable error-code helpers for MCP branching
- typed helpers for:
  - discovery
  - provisioning
  - read flows
  - draft/send flows
  - composite reply and operator-send flows

### Notes

- the package remains `private: true` and is not published yet
- dry-run packaging is already exercised from the monorepo root
- semver guidance now lives in [docs/agent-client-versioning.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/agent-client-versioning.md)
- draft first-release notes live in [docs/agent-client-release-notes-0.1.0.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/agent-client-release-notes-0.1.0.md)
