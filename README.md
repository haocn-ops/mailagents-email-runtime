# Mailagents Cloudflare MVP

This repository contains the MVP scaffold for an email-first AI agent runtime built on:

- Cloudflare Workers
- Cloudflare Email Routing
- Cloudflare Queues
- Cloudflare R2
- Cloudflare D1
- Amazon SES

## Current State

The repository currently includes:

- product and architecture documentation in `docs/`
- initial D1 schema in `migrations/`
- OpenAPI draft in `docs/openapi.yaml`
- Cloudflare Worker scaffold in `src/`

The code is still a scaffold, but the HTTP API now uses D1-backed repositories for
agents, mailbox bindings, policies, tasks, messages, threads, and drafts.
Agent configs and draft payloads are stored in R2, and the outbound queue now contains
the first real SES sender implementation using SigV4-signed API v2 requests.
Inbound email normalization now parses raw email into normalized content, thread state,
attachment objects, and tasks. SES webhooks now persist delivery lifecycle events.
The HTTP API now enforces tenant-scoped signed bearer tokens for agent, task, mail,
and draft operations.
Outbound sending now supports SES `Raw` MIME when drafts include reply headers or attachments.
Inbound email and replay jobs now carry mailbox-specific routing data instead of relying on demo defaults.

## Key Files

- `docs/mvp-spec.md`
- `docs/local-dev.md`
- `docs/dev-bootstrap.md`
- `docs/deployment.md`
- `docs/testing.md`
- `docs/openapi.yaml`
- `fixtures/ses/delivery.json`
- `migrations/0001_initial.sql`
- `seeds/0001_demo.sql`
- `wrangler.toml`
- `src/index.ts`
- `src/repositories/agents.ts`
- `src/repositories/mail.ts`

## Local Development

See [docs/local-dev.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/local-dev.md) for:

- local Wrangler setup
- D1 migration commands
- seed commands
- `.dev.vars` usage
- demo API calls

## Repo Hygiene

- `.dev.vars` is for local secrets and is gitignored
- `.wrangler/` contains local state and is gitignored
- `node_modules/` is gitignored

See [docs/testing.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/testing.md) for:

- local smoke flow
- SES webhook fixtures
- smoke script usage

See [docs/deployment.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/deployment.md) for:

- real Cloudflare/AWS resource wiring
- environment-specific resource naming
- admin/debug route exposure guidance
- pre-deploy config validation
- deploy checklist

See [docs/dev-bootstrap.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/dev-bootstrap.md) for:

- first real `dev` environment creation
- Cloudflare resource creation commands
- the order to migrate, seed, and deploy

Template scripts:

- [scripts/bootstrap_dev_resources.sh](/Users/zh/Documents/codeX/mailagents_cloudflare2/scripts/bootstrap_dev_resources.sh)
- [scripts/bootstrap_worker_secrets.sh](/Users/zh/Documents/codeX/mailagents_cloudflare2/scripts/bootstrap_worker_secrets.sh)

## Next Steps

1. Replace placeholder IDs and domains in `wrangler.toml`, then run `npm run config:check:dev`, `npm run config:check:staging`, or `npm run config:check:production`.
2. Connect real SES credentials and verify a true outbound send path.
3. Replace the MVP email parser with a full RFC-aware MIME parser if needed.
4. Add deeper D1/R2 integration assertions or a real test suite.
5. Further harden queue/webhook tenant ownership checks.
