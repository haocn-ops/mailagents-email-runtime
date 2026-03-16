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
  - `SES_REGION`
  - `SES_FROM_DOMAIN`
  - `SES_CONFIGURATION_SET`
  - `ADMIN_ROUTES_ENABLED`
  - `DEBUG_ROUTES_ENABLED`
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

## Deploy

When config checks pass:

```bash
npm run deploy:dev
npm run deploy:staging
npm run deploy:production
```

Before deploy, make sure the corresponding Worker secrets were set for that environment.

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
- auth token minting works
- agent creation works
- draft creation works
- SES webhook endpoint is reachable
- outbound jobs update status after SES callbacks

## Recommended Next Hardening

- replace the MVP MIME parser with a more complete parser if needed
- add integration assertions against D1 state after smoke flow
- restrict admin/debug endpoints by environment or feature flag
- add stronger queue/webhook tenant ownership checks
