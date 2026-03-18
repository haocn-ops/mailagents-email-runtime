# Deployment Checklist

This document covers the minimum setup required to connect the project to real Cloudflare and AWS SES resources.

For the first real environment, see [docs/dev-bootstrap.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/dev-bootstrap.md).
For Worker secret setup templates, see [scripts/bootstrap_worker_secrets.sh](/Users/zh/Documents/codeX/mailagents_cloudflare2/scripts/bootstrap_worker_secrets.sh).

## Environments

This project now assumes three Cloudflare deployment environments:

- `dev`
- `staging`
- `production`

Local development continues to use the top-level bindings in [wrangler.toml](/Users/zh/Documents/codeX/mailagents_cloudflare2/wrangler.toml).

Current deployed `dev` environment:

- Worker name: `mailagents-dev`
- Worker URL: `https://mailagents-dev.izhenghaocn.workers.dev`
- D1 database: `mailagents-dev`
- R2 bucket: `mailagents-dev-email`
- Queues: `mailagents-dev-*`

As of 2026-03-18, the shared `dev` environment has also been validated with:

- remote D1 migration including `0002_agent_registry.sql`
- a published demo agent version for `agt_demo`
- an active mailbox deployment for `mbx_demo`
- a live inbound email that produced a deployment-aware `agent_run` trace in R2

Important:

- `npm run deploy:dev` updates this existing shared `dev` environment
- it does not create a separate, parallel `dev` worker
- full remote smoke depends on the current remote `ADMIN_API_SECRET`,
  `API_SIGNING_SECRET`, and `WEBHOOK_SHARED_SECRET` matching the smoke inputs

Current production status as of 2026-03-17:

- `mailagents-production` Worker is now deployed
- `env.production` in [wrangler.toml](/Users/zh/Documents/codeX/mailagents_cloudflare2/wrangler.toml)
  now points at the real production D1 database
- production route is attached as `api.mailagents.net/*`
- DNS for `api.mailagents.net` is still the remaining blocker
- see [docs/production-rollout-checklist.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/production-rollout-checklist.md)
  before attempting a production deploy or domain bind

## Cloudflare Resources

Create or identify, per environment:

- 1 D1 database
- 1 R2 bucket
- 4 Queues
  - `email-ingest`
  - `agent-execute`
  - `outbound-send`
  - `dead-letter`

Update [wrangler.toml](/Users/zh/Documents/codeX/mailagents_cloudflare2/wrangler.toml):

- set the real `database_id` for each environment
- set the real `bucket_name` for each environment
- verify queue names match your account
- set the correct `SES_REGION`
- set the correct `SES_FROM_DOMAIN` per environment
- set the correct `SES_CONFIGURATION_SET` per environment
- set `ADMIN_ROUTES_ENABLED` and `DEBUG_ROUTES_ENABLED` appropriately
- confirm the hourly cron trigger is enabled for idempotency cleanup
- set `IDEMPOTENCY_COMPLETED_RETENTION_HOURS` and `IDEMPOTENCY_PENDING_RETENTION_HOURS` as needed

Suggested naming:

- D1:
  - `mailagents-dev`
  - `mailagents-staging`
  - `mailagents-production`
- R2:
  - `mailagents-dev-email`
  - `mailagents-staging-email`
  - `mailagents-production-email`
- Queues:
  - `mailagents-dev-*`
  - `mailagents-staging-*`
  - `mailagents-production-*`

Recommended route exposure:

- `dev`
  - `ADMIN_ROUTES_ENABLED = "true"`
  - `DEBUG_ROUTES_ENABLED = "true"`
- `staging`
  - `ADMIN_ROUTES_ENABLED = "false"`
  - `DEBUG_ROUTES_ENABLED = "false"`
- `production`
  - `ADMIN_ROUTES_ENABLED = "false"`
  - `DEBUG_ROUTES_ENABLED = "false"`

## AWS SES Setup

You need:

- a verified sending domain or sender identity
- SMTP/API access credentials
- a configuration set for event publishing
- EventBridge destination enabled for SES events

Recommended:

- SPF
- DKIM
- DMARC
- a dedicated subdomain for outbound mail
- keep admin/debug APIs disabled outside local or tightly controlled environments

## Local Secret File

Fill [.dev.vars.example](/Users/zh/Documents/codeX/mailagents_cloudflare2/.dev.vars.example) into `.dev.vars` with real values for:

- `SES_ACCESS_KEY_ID`
- `SES_SECRET_ACCESS_KEY`
- `WEBHOOK_SHARED_SECRET`
- `API_SIGNING_SECRET`
- `ADMIN_API_SECRET`

These values are for local development only.
For deployed Cloudflare environments, store sensitive values as Worker secrets using `wrangler secret put`.

## Remote Worker Secrets

For each deployed environment, set these as secrets:

- `SES_ACCESS_KEY_ID`
- `SES_SECRET_ACCESS_KEY`
- `WEBHOOK_SHARED_SECRET`
- `API_SIGNING_SECRET`
- `ADMIN_API_SECRET`

Template helper:

```bash
bash scripts/bootstrap_worker_secrets.sh dev
bash scripts/bootstrap_worker_secrets.sh staging
bash scripts/bootstrap_worker_secrets.sh production
```

Important split:

- `wrangler.toml [vars]` / `[env.*.vars]`
  - non-sensitive config
  - queue names
  - bucket names
  - D1 bindings
  - cron triggers
  - `SES_REGION`
  - `SES_FROM_DOMAIN`
  - `SES_CONFIGURATION_SET`
  - `ADMIN_ROUTES_ENABLED`
  - `DEBUG_ROUTES_ENABLED`
  - idempotency retention windows
- Worker secrets
  - AWS access keys
  - webhook shared secret
  - token signing secret
  - admin secret

## Pre-Deploy Validation

Run:

```bash
npm run config:check
npm run config:check:dev
npm run config:check:staging
npm run config:check:production
```

This checks:

- the selected environment in `wrangler.toml` no longer uses placeholders
- `.dev.vars` no longer uses dummy secrets
- required local secrets are present

## Local Verification Before Deploy

Run:

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

Note:

- with fake SES credentials, the outbound job should move to `retry`
- with real SES credentials, the outbound send should progress further and produce a real `providerMessageId`

## Remote D1

Apply schema and seed to remote D1:

```bash
npm run d1:migrate:remote:dev
npm run d1:seed:remote:dev

npm run d1:migrate:remote:staging
npm run d1:seed:remote:staging

npm run d1:migrate:remote:production
npm run d1:seed:remote:production
```

Do this only after confirming the correct D1 database is configured in `wrangler.toml`.

These migration commands now apply all required schema layers in order:

1. `0001_initial.sql`
2. `0002_agent_registry.sql`
3. `0002_idempotency_keys.sql`
4. `0003_agent_deployment_history.sql`

If `mailagents-dev` was created before either `migrations/0002_agent_registry.sql` or
`migrations/0002_idempotency_keys.sql` existed, or before deployment history was rebuilt
by `migrations/0003_agent_deployment_history.sql`, run `npm run d1:migrate:remote:dev`
again before testing versioned agent execution, deployment rollout/rollback, send,
replay, or composite MCP send flows.

## Deploy

When config checks pass:

```bash
npm run deploy:dev
npm run deploy:staging
npm run deploy:production
```

Before deploy, make sure the corresponding Worker secrets were set for that environment.

For the current shared `dev` environment, keep these aligned before smoke testing:

- `ADMIN_API_SECRET`
- `API_SIGNING_SECRET`
- `WEBHOOK_SHARED_SECRET`

The default deployment also schedules the Worker every hour to prune stale
idempotency keys. Operators can manually verify or trigger cleanup through the
admin maintenance endpoints in controlled environments.

## Versioned Registry Verification

After running the remote migration, you can validate the versioned registry path in `dev`:

1. create an agent version for a seeded agent such as `agt_demo`
2. create an active mailbox deployment targeting `mbx_demo`
3. send a real test email to `agent@mailagents.net`
4. confirm the newest `agent_runs.trace_r2_key` is non-null
5. fetch that R2 trace object and verify it includes both `agentVersionId` and `deploymentId`
6. optionally validate `POST /deployments/rollout` and `POST /deployments/{deploymentId}/rollback`
   against the same mailbox target to confirm deployment history is preserved

This is the key check that distinguishes the new deployment-aware runtime from the
older mailbox-to-agent fallback path.

## GitHub Actions

This repository includes a manual GitHub Actions workflow at [`.github/workflows/deploy.yml`](/Users/zh/Documents/codeX/mailagents_cloudflare2/.github/workflows/deploy.yml).

Required repository or environment secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The workflow:

- installs dependencies
- runs `npm run check`
- runs the environment config check with local secret validation disabled
- applies the remote D1 migration
- optionally applies the demo seed
- deploys the selected Worker environment

Recommended setup:

- store `dev`, `staging`, and `production` approvals in GitHub Environments
- limit `production` workflow access to maintainers
- do not enable the demo seed for `production`

## Post-Deploy Checks

Verify:

- API responds on the deployed worker URL
- runtime metadata responds on `/v2/meta/runtime`
- auth token minting works
- agent creation works
- draft creation works
- SES webhook endpoint is reachable
- outbound jobs update status after SES callbacks

Example `dev` checks:

```bash
curl -sS https://mailagents-dev.izhenghaocn.workers.dev/v2/meta/runtime | jq '.server'

BASE_URL='https://mailagents-dev.izhenghaocn.workers.dev' \
ADMIN_API_SECRET_FOR_SMOKE=replace-with-admin-api-secret \
WEBHOOK_SHARED_SECRET_FOR_SMOKE=replace-with-shared-secret \
bash ./scripts/local_smoke.sh

BASE_URL='https://mailagents-dev.izhenghaocn.workers.dev' \
ADMIN_API_SECRET_FOR_SMOKE=replace-with-admin-api-secret \
bash ./scripts/mcp_smoke.sh
```

Known `dev` note:

- the invalid-mailbox MCP smoke assertion may return either
  `resource_mailbox_not_found` or `access_mailbox_denied`
  depending on whether token mailbox scope blocks the request before resource lookup

## Recommended Next Hardening

- replace the MVP MIME parser with a more complete parser if needed
- add integration assertions against D1 state after smoke flow
- restrict admin/debug endpoints by environment or feature flag
- add stronger queue/webhook tenant ownership checks
