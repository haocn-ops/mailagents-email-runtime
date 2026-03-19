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
- D1 migrations in `migrations/`
- OpenAPI draft in `docs/openapi.yaml`
- Cloudflare Worker scaffold in `src/`

The code started as a scaffold, but the HTTP API now uses D1-backed repositories for
agents, mailbox bindings, policies, tasks, messages, threads, and drafts.
Agent configs and draft payloads are stored in R2, and the outbound queue now contains
the first real SES sender implementation using SigV4-signed API v2 requests.
Inbound email normalization now parses raw email into normalized content, thread state,
attachment objects, and tasks. SES webhooks now persist delivery lifecycle events.
The HTTP API now enforces tenant-scoped signed bearer tokens for agent, task, mail,
and draft operations.
Outbound sending now supports SES `Raw` MIME when drafts include reply headers or attachments.
Inbound email and replay jobs now carry mailbox-specific routing data instead of relying on demo defaults.
The runtime now also supports a versioned agent registry with mailbox deployments, and the
shared `dev` environment has been verified end to end for agent registration, inbound mail,
outbound SES send, and deployment-aware agent execution traces.
The same runtime module now also includes the public website and admin dashboard routes,
so the main Worker can serve site, mailbox admin, contact inbox, and alias-management
features when the corresponding Cloudflare email bindings are configured.
Production has also been verified end to end for `support@mailagents.net`, including
mailbox bootstrap, Cloudflare Email Routing, inbound task creation, version-aware
agent execution traces, and a controlled outbound reply through SES with a recorded
`provider_message_id`.

Current SES limitation as of 2026-03-18:

- treat external outbound SES delivery as sandbox-limited unless production access is explicitly reapproved in the active AWS account and region
- internal mailbox routing and internal operator verification flows can still work within the current setup
- for SES-backed outbound validation, only send to verified identities or verified test recipients
- successful runtime delivery to `support@mailagents.net` or other verified inboxes does not imply unrestricted outbound sending to arbitrary external customer addresses

## Agent Quick Start

For external agents, the default production flow is now:

1. `POST https://api.mailagents.net/public/signup`
2. store the returned mailbox-scoped bearer token
3. call `POST /mcp` with method `tools/list`
4. read inbound mail with `list_messages` or `GET /v1/mailboxes/self/messages`
5. send new mail with `send_email` or `POST /v1/messages/send`
6. reply on-thread with `reply_to_message` or `POST /v1/messages/{messageId}/reply`

Minimal MCP-first example:

```bash
curl -sS -X POST https://api.mailagents.net/public/signup \
  -H 'content-type: application/json' \
  -d '{
    "mailboxAlias": "agent-demo",
    "agentName": "Agent Demo",
    "operatorEmail": "operator@example.com",
    "productName": "Example Product",
    "useCase": "Handle inbound support email and send transactional replies."
  }'

curl -sS -X POST https://api.mailagents.net/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list",
    "params": {}
  }'

curl -sS -X POST https://api.mailagents.net/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "send_email",
      "arguments": {
        "to": ["recipient@example.com"],
        "subject": "Hello from Mailagents",
        "text": "Sent through the mailbox-scoped MCP tool.",
        "idempotencyKey": "send-demo-001"
      }
    }
  }'
```

See:

- [`docs/agent-sdk-examples.md`](docs/agent-sdk-examples.md)
- [`docs/mcp-local.md`](docs/mcp-local.md)
- [`docs/openapi.yaml`](docs/openapi.yaml)

## Local Development Quick Start

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
- `docs/agent-feedback-roadmap.md`
- `docs/agent-registry.md`
- `docs/ai-mail-workflows.md`
- `docs/ai-debug.md`
- `docs/llms-agent-guide.md`
- `docs/mcp-local.md`
- `docs/runtime-metadata.md`
- `docs/runtime-compatibility.md`
- `docs/runtime-compatibility.schema.json`
- `docs/agent-sdk-examples.md`
- `docs/agent-capabilities.json`
- `docs/agent-client-helper.md`
- `docs/agent-client-release.md`
- `docs/agent-workflow-packs.md`
- `docs/agent-workflow-packs.json`
- `docs/local-dev.md`
- `docs/dev-bootstrap.md`
- `docs/deployment.md`
- `docs/production-rollout-checklist.md`
- `docs/production-operator-bootstrap.md`
- `docs/testing.md`
- `docs/openapi.yaml`
- `llms-full.txt`
- `fixtures/ses/delivery.json`
- `migrations/0001_initial.sql`
- `migrations/0002_agent_registry.sql`
- `migrations/0002_idempotency_keys.sql`
- `migrations/0003_agent_deployment_history.sql`
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

See [`docs/agent-client-helper.md`](docs/agent-client-helper.md) for:

- a lightweight TypeScript client wrapper
- a copyable starting point for external SDKs
- a path toward a future published client

See [`docs/agent-registry.md`](docs/agent-registry.md) for:

- the versioned agent registry model
- agent versions, capabilities, tools, and deployments
- the migration path from MVP agent records to a real control plane

See [`docs/agent-client-release.md`](docs/agent-client-release.md) for:

- the package publish checklist
- pre-release validation steps
- recommended first-release scope

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
- live inbound/outbound verification notes
- SES webhook fixtures
- smoke script usage

See [`docs/deployment.md`](docs/deployment.md) for:

- real Cloudflare/AWS resource wiring
- environment-specific resource naming
- current `dev` worker URL and verification notes
- admin/debug route exposure guidance
- pre-deploy config validation
- deploy checklist

See [`docs/production-rollout-checklist.md`](docs/production-rollout-checklist.md) for:

- the current production blockers
- the exact inputs still needed for a real rollout
- the production deploy and domain-binding sequence

See [`docs/production-operator-bootstrap.md`](docs/production-operator-bootstrap.md) for:

- the first safe write path in production
- mailbox, agent, version, and deployment bootstrap order
- post-bootstrap validation expectations
- a real verified `support@mailagents.net` production example

See [`docs/dev-bootstrap.md`](docs/dev-bootstrap.md) for:

- first real `dev` environment creation
- Cloudflare resource creation commands
- the order to migrate, seed, and deploy

Template scripts:

- [`scripts/bootstrap_dev_resources.sh`](scripts/bootstrap_dev_resources.sh)
- [`scripts/bootstrap_worker_secrets.sh`](scripts/bootstrap_worker_secrets.sh)
- [`scripts/backfill_message_subjects.mjs`](scripts/backfill_message_subjects.mjs)

## Deployment Notes

- `wrangler.toml` intentionally uses placeholder environment IDs and domains
- real Cloudflare and SES values should be supplied per environment before deploy
- keep secrets in Cloudflare Worker secrets or local `.dev.vars`, not in git
- `npm run deploy:dev` updates the existing Cloudflare `dev` environment rather than creating a second one
- the current shared `dev` worker URL is `https://mailagents-dev.izhenghaocn.workers.dev`
- `npm run d1:migrate:*` now applies the base schema, versioned agent registry schema, idempotency schema, and deployment-history schema in sequence
- `wrangler.site.toml` remains available as a standalone site-only deployment profile, but
  `src/index.ts` now exposes the same site/admin routes for the main runtime worker
- keep `CONTACT_ALIAS_ROUTING_BOOTSTRAP_ENABLED=false` outside the environment that should
  actively own `hello/security/privacy/dmarc` alias routing

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

## Production Read-Only Smoke

Run:

```bash
npm run smoke:production:readonly
```

This verifies:

- production runtime metadata
- production compatibility metadata
- admin routes are disabled
- debug routes are disabled

## Next Steps

1. Keep `0002_agent_registry.sql` in all future environment migrations so versioned runtime resolution stays enabled.
2. Replace the MVP email parser with a full RFC-aware MIME parser if needed.
3. Add deeper D1/R2 integration assertions or a real test suite.
4. Further harden queue/webhook tenant ownership checks.
5. Add richer operator workflows around approvals and replay on top of the new deployment rollout/rollback primitives.

## License

This project is licensed under the Apache License 2.0. See [`LICENSE`](LICENSE).

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md) for notable project changes.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for local workflow, pull request expectations, and contribution guidelines.

## Code of Conduct

See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for collaboration expectations and reporting guidance.
