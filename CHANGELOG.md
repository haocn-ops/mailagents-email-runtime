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
