# Mailagents Email Runtime

An email-first AI agent runtime built on:

- Cloudflare Workers
- Cloudflare Email Routing
- Cloudflare Queues
- Cloudflare R2
- Cloudflare D1
- Amazon SES

## Current Status

This repository includes:

- product and architecture documentation in `docs/`
- D1 migrations in `migrations/`
- OpenAPI draft in `docs/openapi.yaml`
- Cloudflare Worker scaffold in `src/`

Implemented runtime capabilities:

- D1-backed HTTP APIs for agents, mailbox bindings, policies, tasks, messages, threads, and drafts
- R2-backed storage for agent configs, draft payloads, and runtime artifacts
- inbound email normalization with parsed content, thread state, attachments, and task creation
- SES delivery event ingestion with persisted lifecycle records
- tenant-scoped signed bearer-token auth for agent, task, mail, and draft operations
- outbound SES sending, including `Raw` MIME for replies and attachments
- mailbox-specific routing for inbound handling and replay jobs
- versioned agent registry with mailbox deployments and deployment-aware execution traces
- site, admin dashboard, contact inbox, and alias-management routes in the main Worker when the related bindings are configured

Verified environments:

- shared `dev` has been verified end to end for agent registration, inbound mail, outbound SES send, and deployment-aware agent execution traces
- production has been verified end to end for `support@mailagents.net`, including mailbox bootstrap, Cloudflare Email Routing, inbound task creation, version-aware execution traces, and a controlled outbound reply with a recorded `provider_message_id`

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

## Documentation

See [`docs/README.md`](docs/README.md) for the full documentation map by reader type and task.

Recommended by persona:

- product integrator: [`docs/llms-agent-guide.md`](docs/llms-agent-guide.md), [`docs/agent-sdk-examples.md`](docs/agent-sdk-examples.md), [`docs/openapi.yaml`](docs/openapi.yaml)
- agent developer: [`docs/mcp-local.md`](docs/mcp-local.md), [`docs/agent-sdk-examples.md`](docs/agent-sdk-examples.md), [`docs/runtime-metadata.md`](docs/runtime-metadata.md)
- advanced operator: [`docs/deployment.md`](docs/deployment.md), [`docs/testing.md`](docs/testing.md), [`docs/x402-real-payment-checklist.md`](docs/x402-real-payment-checklist.md)

Recommended entry points:

- [`docs/llms-agent-guide.md`](docs/llms-agent-guide.md) for the fastest agent-integrator overview
- [`docs/local-dev.md`](docs/local-dev.md) for local setup, migrations, seeds, and demo API calls
- [`docs/deployment.md`](docs/deployment.md) for Cloudflare and SES environment wiring
- [`docs/testing.md`](docs/testing.md) for smoke flows, fixtures, and current coverage guidance
- [`docs/x402-real-payment-checklist.md`](docs/x402-real-payment-checklist.md) for the first real Base Sepolia + USDC payment run
- [`docs/archive/README.md`](docs/archive/README.md) for dated rollout and verification records
- [`docs/runtime-metadata.md`](docs/runtime-metadata.md) and [`docs/runtime-compatibility.md`](docs/runtime-compatibility.md) for discovery and stable integration contracts
- [`docs/agent-sdk-examples.md`](docs/agent-sdk-examples.md) and [`docs/agent-client-helper.md`](docs/agent-client-helper.md) for copyable integration examples and the TypeScript helper
- [`docs/production-rollout-checklist.md`](docs/production-rollout-checklist.md) and [`docs/production-operator-bootstrap.md`](docs/production-operator-bootstrap.md) for production rollout and operator bootstrap

## Project Layout

Key repo locations:

- `src/index.ts` — main Worker entrypoint
- `src/repositories/agents.ts` and `src/repositories/mail.ts` — core D1-backed data access
- `migrations/` — schema history, including registry, idempotency, token-reissue, and draft-audit changes
- `seeds/0001_demo.sql` — local demo seed data
- `fixtures/ses/delivery.json` and `fixtures/ses/bounce.json` — webhook fixtures
- `packages/mailagents-agent-client/` — publishable client package skeleton
- `docs/openapi.yaml` — HTTP API draft
- `docs/agent-capabilities.json` — pinned capability snapshot
- `llms-full.txt` — combined LLM-facing runtime guidance
- `wrangler.toml` — local and remote environment bindings

## Repo Hygiene

- `.dev.vars` is for local secrets and is gitignored
- `.wrangler/` contains local state and is gitignored
- `node_modules/` is gitignored
- [`SECURITY.md`](SECURITY.md) documents open source safety and secret handling expectations

Operational references:

- [`docs/testing.md`](docs/testing.md) — smoke flows, webhook fixtures, and current coverage guidance
- [`docs/archive/README.md`](docs/archive/README.md) — dated rollout and verification records
- [`docs/deployment.md`](docs/deployment.md) — shared deployment checklist and environment wiring
- [`docs/production-rollout-checklist.md`](docs/production-rollout-checklist.md) — production rollout record and caveats
- [`docs/production-operator-bootstrap.md`](docs/production-operator-bootstrap.md) — first safe production write path
- [`docs/x402-real-payment-checklist.md`](docs/x402-real-payment-checklist.md) — first real testnet payment runbook
- [`docs/dev-bootstrap.md`](docs/dev-bootstrap.md) — first real `dev` environment bootstrap

Template scripts:

- [`scripts/bootstrap_dev_resources.sh`](scripts/bootstrap_dev_resources.sh)
- [`scripts/bootstrap_worker_secrets.sh`](scripts/bootstrap_worker_secrets.sh)
- [`scripts/bootstrap_x402_payment.sh`](scripts/bootstrap_x402_payment.sh)
- [`scripts/backfill_message_subjects.mjs`](scripts/backfill_message_subjects.mjs)

## Deploy

- See [`docs/deployment.md`](docs/deployment.md) for the shared deployment checklist and environment wiring details
- See [`docs/production-rollout-checklist.md`](docs/production-rollout-checklist.md) for the live production rollout record and SES caveats
- `wrangler.toml` contains a mix of intentionally public, non-secret runtime config and placeholders for not-yet-provisioned environments
- keep secrets in Cloudflare Worker secrets or local `.dev.vars`, not in git
- `npm run deploy:dev` updates the existing shared `dev` environment at `https://mailagents-dev.izhenghaocn.workers.dev`
- the environment-specific `d1:migrate` scripts apply the full schema chain, including registry, idempotency, token-reissue, and draft-audit migrations
- keep `CONTACT_ALIAS_ROUTING_BOOTSTRAP_ENABLED=false` outside the single environment that should own managed alias routing
- use [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) for manual GitHub Actions deploys after setting `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
- run `npm run smoke:production:readonly` after production deploys to verify runtime metadata plus admin/debug route exposure

## Next Steps

1. Keep the full migration chain, including registry, idempotency, token-reissue, and draft-audit migrations, in all future environment rollouts.
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
