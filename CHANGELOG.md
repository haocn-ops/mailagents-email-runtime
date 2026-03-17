# Changelog

All notable changes to this project will be documented in this file.

The format is inspired by Keep a Changelog and follows a simple unreleased-first structure.

## [Unreleased]

### Added

- email-first AI agent runtime scaffold on Cloudflare Workers, R2, D1, Queues, and Amazon SES
- inbound email handling, normalization, threading, and task creation
- outbound draft creation and SES sending support, including Raw MIME handling
- SES webhook ingestion for delivery lifecycle events
- D1-backed repositories for agents, mailboxes, messages, threads, tasks, drafts, and outbound jobs
- signed bearer token auth with tenant, agent, mailbox, and scope checks
- local smoke testing flow, fixtures, and debug endpoints
- multi-environment Wrangler configuration for local, dev, staging, and production
- GitHub Actions CI and manual deploy workflow
- AI-focused documentation set:
  - `docs/ai-onboarding.md`
  - `docs/ai-decision-rules.md`
  - `docs/ai-auth.md`
  - `docs/ai-agents.md`
  - `docs/ai-mail-workflows.md`
  - `docs/ai-debug.md`
  - `docs/mcp-tooling-draft.md`
  - `docs/mcp-tools.schema.json`
  - `llms-full.txt`
- idempotency support for draft send, message replay, and admin send flows
- idempotency key storage and retention cleanup:
  - `migrations/0002_idempotency_keys.sql`
  - scheduled cleanup handler
  - admin maintenance APIs for listing and pruning idempotency keys
- admin dashboard idempotency operations view
- open source project files:
  - `LICENSE`
  - `SECURITY.md`
  - `CONTRIBUTING.md`
  - `CODE_OF_CONDUCT.md`
  - issue templates
  - pull request template

### Changed

- sanitized tracked configuration to avoid committing live infrastructure identifiers
- adjusted queue handling to normalize Cloudflare queue names across environments
- updated README and deployment docs for open source and GitHub-based workflows
- aligned `docs/openapi.yaml` with current route behavior, request requirements, and debug endpoints
- updated local smoke coverage to assert idempotent send and replay behavior
- added hourly cron configuration and retention vars for idempotency cleanup
