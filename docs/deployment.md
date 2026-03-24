# Deployment Checklist

This document covers the minimum setup required to connect the project to real Cloudflare resources and a supported outbound email provider.

For the first real environment, see [docs/dev-bootstrap.md](../docs/dev-bootstrap.md).
For Worker secret setup templates, see [scripts/bootstrap_worker_secrets.sh](../scripts/bootstrap_worker_secrets.sh).

## Environments

This project now assumes three Cloudflare deployment environments:

- `dev`
- `staging`
- `production`

Local development continues to use the top-level bindings in [wrangler.toml](../wrangler.toml).

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

Current production status as of 2026-03-24:

- `mailagents-production` Worker is now deployed
- `env.production` in [wrangler.toml](../wrangler.toml)
  now points at the real production D1 database
- production routes are attached for `api.mailagents.net/*`,
  `mailagents.net/*`, and `www.mailagents.net/*`
- production currently uses `OUTBOUND_PROVIDER = "resend"`
- `api.mailagents.net` and `mailagents.net` respond successfully
- see [docs/production-rollout-checklist.md](../docs/production-rollout-checklist.md)
  for the rollout record, production sequence, and remaining operational caveats

## Cloudflare Resources

Create or identify, per environment:

- 1 D1 database
- 1 R2 bucket
- 4 Queues
  - `email-ingest`
  - `agent-execute`
  - `outbound-send`
  - `dead-letter`

Update [wrangler.toml](../wrangler.toml):

- set the real `database_id` for each environment
- set the real `bucket_name` for each environment
- verify queue names match your account
- set the correct `SES_REGION`
- set the correct `SES_FROM_DOMAIN` per environment
- set the correct `SES_CONFIGURATION_SET` per environment
- set `OUTBOUND_PROVIDER` to the active provider (`ses` or `resend`)
- set `RESEND_API_BASE_URL` when using Resend (default `https://api.resend.com`)
- set `ADMIN_ROUTES_ENABLED` and `DEBUG_ROUTES_ENABLED` appropriately
- keep `ADMIN_ROUTES_ALLOW_PUBLIC_HOSTS` and `DEBUG_ROUTES_ALLOW_PUBLIC_HOSTS`
  unset or `"false"` unless a controlled public-host bootstrap window
  explicitly needs them
- set `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_EMAIL_DOMAIN`, and `CLOUDFLARE_EMAIL_WORKER`
  for environments that should expose contact inbox and alias-management features
- optionally set `SELF_SERVE_REQUIRE_CONFIGURED_ROUTING = "false"` only in
  non-production environments when signup should continue even if routing
  automation cannot reconcile Cloudflare Email Routing in that environment
- keep `CONTACT_ALIAS_ROUTING_BOOTSTRAP_ENABLED` disabled unless that runtime is
  intended to automatically own and reconcile managed contact aliases
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
  - keep `ADMIN_ROUTES_ALLOW_PUBLIC_HOSTS = "false"` unless `dev` is intentionally exposed on a `mailagents.net` host
  - keep `DEBUG_ROUTES_ALLOW_PUBLIC_HOSTS = "false"` unless `dev` is intentionally exposed on a `mailagents.net` host
- `staging`
  - `ADMIN_ROUTES_ENABLED = "false"`
  - `DEBUG_ROUTES_ENABLED = "false"`
  - `ADMIN_ROUTES_ALLOW_PUBLIC_HOSTS = "false"`
  - `DEBUG_ROUTES_ALLOW_PUBLIC_HOSTS = "false"`
- `production`
  - `ADMIN_ROUTES_ENABLED = "false"`
  - `DEBUG_ROUTES_ENABLED = "false"`
  - `ADMIN_ROUTES_ALLOW_PUBLIC_HOSTS = "false"`
  - `DEBUG_ROUTES_ALLOW_PUBLIC_HOSTS = "false"`
  - `CONTACT_ALIAS_ROUTING_BOOTSTRAP_ENABLED = "false"` until production should own alias routing

Runtime/site note:

- the main runtime Worker (`src/index.ts`) now includes the public site and admin dashboard routes
- production routing should attach `api.mailagents.net`, `mailagents.net`, and `www.mailagents.net` to the same Worker
- do not enable automatic alias bootstrap in more than one live Worker for the same domain unless you intentionally want them to compete for ownership

## Outbound Provider Setup

Choose one outbound provider path for each environment.

### Resend

You need:

- a verified sending domain in Resend
- a `RESEND_API_KEY` Worker secret
- `OUTBOUND_PROVIDER = "resend"`

Recommended:

- keep inbound routing on Cloudflare and migrate outbound first
- verify the same domain used by mailbox `from` addresses for the shortest path
- keep `RESEND_API_BASE_URL = "https://api.resend.com"` unless you intentionally proxy the API

Current live note:

- production currently uses Resend for outbound delivery
- if you are reading older rollout notes that mention SES-specific outbound
  behavior, treat those as historical context unless the target environment is
  explicitly configured back to `OUTBOUND_PROVIDER = "ses"`

### AWS SES

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

Current SES restriction as of 2026-03-18 for SES-backed environments:

- assume the project is still operating under SES sandbox constraints for external-recipient planning
- internal mailbox routing and internal operator inbox flows are not blocked by that SES production-access decision
- validate SES outbound only with verified sender identities and verified recipient addresses
- do not treat a successful send to an internal or verified inbox as proof that arbitrary external customer delivery is enabled

## Local Secret File

Fill [.dev.vars.example](../.dev.vars.example) into `.dev.vars` with real values for:

- `OUTBOUND_PROVIDER`
- `SES_ACCESS_KEY_ID`
- `SES_SECRET_ACCESS_KEY`
- `RESEND_API_KEY`
- `WEBHOOK_SHARED_SECRET`
- `API_SIGNING_SECRET`
- `ADMIN_API_SECRET`

These values are for local development only.
For deployed Cloudflare environments, store sensitive values as Worker secrets using `wrangler secret put`.

## Remote Worker Secrets

For each deployed environment, set these as secrets:

- `RESEND_API_KEY` when `OUTBOUND_PROVIDER=resend`
- `SES_ACCESS_KEY_ID`
- `SES_SECRET_ACCESS_KEY`
- `WEBHOOK_SHARED_SECRET`
- `API_SIGNING_SECRET`
- `ADMIN_API_SECRET`
- `CLOUDFLARE_API_TOKEN` when the runtime should manage Cloudflare Email Routing from the admin UI or automatic alias bootstrap
- `X402_FACILITATOR_AUTH_TOKEN` when using a real x402 facilitator
- `X402_PAY_TO` when you want quotes to point at a real settlement recipient

Template helper:

```bash
bash scripts/bootstrap_worker_secrets.sh dev
bash scripts/bootstrap_worker_secrets.sh staging
bash scripts/bootstrap_worker_secrets.sh production
```

For x402-specific payment setup:

```bash
bash scripts/bootstrap_x402_payment.sh dev
bash scripts/bootstrap_x402_payment.sh production
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
  - `OUTBOUND_PROVIDER`
  - `RESEND_API_BASE_URL`
  - `ADMIN_ROUTES_ENABLED`
  - `DEBUG_ROUTES_ENABLED`
  - idempotency retention windows
- Worker secrets
  - AWS access keys
  - Resend API key
  - webhook shared secret
  - token signing secret
  - admin secret
  - optional Cloudflare API token for Email Routing admin
  - optional x402 facilitator auth token
  - optional x402 settlement recipient when you do not want it stored in plain vars

## x402 Real Payment Configuration

For the first real Base Sepolia + USDC payment flow, confirm:

- `X402_FACILITATOR_URL`
- `X402_FACILITATOR_VERIFY_PATH`
- `X402_FACILITATOR_SETTLE_PATH`
- `X402_FACILITATOR_AUTH_TOKEN`
- `X402_PAY_TO`
- `X402_DEFAULT_SCHEME=exact`
- `X402_DEFAULT_NETWORK_ID=eip155:84532`
- `X402_DEFAULT_ASSET=usdc`
- `X402_PRICE_PER_CREDIT_USD`
- `X402_UPGRADE_PRICE_USD`

Recommended split:

- Worker secrets
  - `X402_FACILITATOR_AUTH_TOKEN`
  - `X402_PAY_TO`
- `wrangler.toml` vars
  - `X402_FACILITATOR_URL`
  - `X402_FACILITATOR_VERIFY_PATH`
  - `X402_FACILITATOR_SETTLE_PATH`
  - `X402_DEFAULT_SCHEME`
  - `X402_DEFAULT_NETWORK_ID`
  - `X402_DEFAULT_ASSET`
  - `X402_PRICE_PER_CREDIT_USD`
  - `X402_UPGRADE_PRICE_USD`

Before running the first real payment in `dev`, also verify:

- hosted DID routes resolve publicly
- the generated quote includes the expected `payTo`
- the facilitator expects the same chain and asset as the runtime quote

See [docs/x402-real-payment-checklist.md](./x402-real-payment-checklist.md) for
the full runbook.

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
- if the AWS account or active SES region still lacks production access, real external outbound validation remains limited to verified recipients
- with `OUTBOUND_PROVIDER=resend`, outbound validation depends on a verified Resend sender domain and `RESEND_API_KEY`

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
5. `0004_token_reissue_requests.sql`
6. `0005_draft_origin_audit.sql`

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

This repository includes a manual GitHub Actions workflow at [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml).

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
