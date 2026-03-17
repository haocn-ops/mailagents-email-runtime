# Mailagents Email Runtime

An email-first AI agent runtime built on:

- Cloudflare Workers
- Cloudflare Email Routing
- Cloudflare Queues
- Cloudflare R2
- Cloudflare D1
- Amazon SES

## What It Includes

This repository includes:

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

## Quick Start

```bash
npm install
npm run check
npm run d1:migrate:local
npm run d1:seed:local
npm run dev:local
```

In another shell:

```bash
ADMIN_API_SECRET_FOR_SMOKE=your-admin-secret \
WEBHOOK_SHARED_SECRET_FOR_SMOKE=your-webhook-secret \
npm run smoke:local
```

See [`docs/local-dev.md`](docs/local-dev.md) for the full local setup flow.

## Key Files

- `docs/mvp-spec.md`
- `docs/ai-onboarding.md`
- `docs/ai-decision-rules.md`
- `docs/ai-auth.md`
- `docs/ai-agents.md`
- `docs/ai-mail-workflows.md`
- `docs/ai-debug.md`
- `docs/llms-agent-guide.md`
- `docs/mcp-tooling-draft.md`
- `docs/mcp-local.md`
- `docs/runtime-metadata.md`
- `docs/runtime-compatibility.md`
- `docs/runtime-compatibility.schema.json`
- `docs/agent-sdk-examples.md`
- `docs/agent-capabilities.json`
- `docs/agent-workflow-packs.md`
- `docs/agent-workflow-packs.json`
- `docs/local-dev.md`
- `docs/dev-bootstrap.md`
- `docs/deployment.md`
- `docs/testing.md`
- `docs/openapi.yaml`
- `llms-full.txt`
- `fixtures/ses/delivery.json`
- `migrations/0001_initial.sql`
- `seeds/0001_demo.sql`
- `wrangler.toml`
- `src/index.ts`
- `src/repositories/agents.ts`
- `src/repositories/mail.ts`

## Local Development

See [`docs/local-dev.md`](docs/local-dev.md) for:

- local Wrangler setup
- D1 migration commands
- seed commands
- `.dev.vars` usage
- demo API calls

See [`docs/ai-onboarding.md`](docs/ai-onboarding.md) and
[`docs/ai-decision-rules.md`](docs/ai-decision-rules.md) for:

- agent-focused setup guidance
- authentication and scope boundaries
- replay, retry, and send safety rules
- recommended API call sequences

See [`docs/llms-agent-guide.md`](docs/llms-agent-guide.md) for:

- the single best agent-first starting point
- capability discovery order
- stable error-handling guidance
- the recommended external-agent startup sequence

See [`docs/runtime-metadata.md`](docs/runtime-metadata.md) for:

- the versioned `/v2/meta/runtime` discovery endpoint
- the versioned `/v2/meta/compatibility` compatibility contract
- MCP capability discovery details
- runtime-exposed workflow and idempotency metadata

See [`docs/agent-sdk-examples.md`](docs/agent-sdk-examples.md) for:

- copyable HTTP and MCP integration examples
- compatibility contract usage
- stable error-handling patterns
- a minimal TypeScript integration snippet

See [`docs/agent-capabilities.json`](docs/agent-capabilities.json) for:

- a pinned machine-readable capability snapshot
- integration fixture data for SDKs or CI
- a stable example of current tools, workflows, and error codes

## Repo Hygiene

- `.dev.vars` is for local secrets and is gitignored
- `.wrangler/` contains local state and is gitignored
- `node_modules/` is gitignored
- [`SECURITY.md`](SECURITY.md) documents open source safety and secret handling expectations

See [`docs/testing.md`](docs/testing.md) for:

- local smoke flow
- deployed `dev` smoke flow
- SES webhook fixtures
- smoke script usage

See [`docs/deployment.md`](docs/deployment.md) for:

- real Cloudflare/AWS resource wiring
- environment-specific resource naming
- current `dev` worker URL and verification notes
- admin/debug route exposure guidance
- pre-deploy config validation
- deploy checklist

See [`docs/dev-bootstrap.md`](docs/dev-bootstrap.md) for:

- first real `dev` environment creation
- Cloudflare resource creation commands
- the order to migrate, seed, and deploy

Template scripts:

- [`scripts/bootstrap_dev_resources.sh`](scripts/bootstrap_dev_resources.sh)
- [`scripts/bootstrap_worker_secrets.sh`](scripts/bootstrap_worker_secrets.sh)

## Deployment Notes

- `wrangler.toml` intentionally uses placeholder environment IDs and domains
- real Cloudflare and SES values should be supplied per environment before deploy
- keep secrets in Cloudflare Worker secrets or local `.dev.vars`, not in git
- `npm run deploy:dev` updates the existing Cloudflare `dev` environment rather than creating a second one
- the current shared `dev` worker URL is `https://mailagents-dev.izhenghaocn.workers.dev`

## GitHub Actions Deploy

This repository includes a manual deploy workflow at [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

Set these GitHub Actions secrets before using it:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Then run the `Deploy` workflow and choose:

- `dev`
- `staging`
- `production`

You can also choose whether to run the demo seed during the deployment.

## Next Steps

1. Replace placeholder IDs and domains in `wrangler.toml`, then run `npm run config:check:dev`, `npm run config:check:staging`, or `npm run config:check:production`.
2. Connect real SES credentials and verify a true outbound send path.
3. Replace the MVP email parser with a full RFC-aware MIME parser if needed.
4. Add deeper D1/R2 integration assertions or a real test suite.
5. Further harden queue/webhook tenant ownership checks.

## License

This project is licensed under the Apache License 2.0. See [`LICENSE`](LICENSE).

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md) for notable project changes.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for local workflow, pull request expectations, and contribution guidelines.

## Code of Conduct

See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for collaboration expectations and reporting guidance.
