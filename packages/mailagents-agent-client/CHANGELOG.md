# Changelog

All notable changes to `@mailagents/agent-client` will be documented here.

## [Unreleased]

### Added

- package skeleton for `@mailagents/agent-client`
- runtime discovery helpers
- compatibility contract and schema helpers
- admin token minting helper for `POST /v1/auth/tokens`
- mailbox self-route helpers for mailbox, task, message, and content reads
- high-level REST send helpers for `POST /v1/messages/send` and `POST /v1/mailboxes/self/send`
- REST-backed agent task and draft lifecycle helpers
- message replay helper for `POST /v1/messages/{messageId}/replay`
- MCP `tools/list` and generic `callTool` support
- stable error-code helpers for MCP branching
- typed helpers for:
  - discovery
  - provisioning
  - read flows
  - draft/send flows
  - composite reply and operator-send flows

### Changed

- `listMessages()` now prefers the mailbox self-route surface when no explicit `mailboxId` is supplied
- `getMessageContent()`, `getThread()`, `createDraft()`, `getDraft()`, `sendDraft()`, and `listAgentTasks()` now follow the documented HTTP routes
- `sendEmail()` now prefers the high-level HTTP send route when no explicit `mailboxId` is supplied
- `replyToMessage()` now follows the documented high-level HTTP reply route
- high-level send and reply result types now match the runtime response shape with `draft`, `outboundJobId`, and reply metadata

### Notes

- the package is publish-configured but not published yet
- dry-run packaging is already exercised from the monorepo root
- semver guidance now lives in [docs/agent-client-versioning.md](../../docs/agent-client-versioning.md)
- draft first-release notes live in [docs/agent-client-release-notes-0.1.0.md](../../docs/agent-client-release-notes-0.1.0.md)
