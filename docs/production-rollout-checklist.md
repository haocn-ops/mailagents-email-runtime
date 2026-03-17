# Production Rollout Checklist

This checklist covers the remaining work before deploying the Mailagents
runtime to the real production environment and binding a custom domain.

Current blockers as of 2026-03-17:

- production D1 config in [wrangler.toml](/Users/zh/Documents/codeX/mailagents_cloudflare2/wrangler.toml) still contains placeholders
- `mailagents-production` Worker does not exist yet
- production Worker secrets are not set
- `dev` remote smoke cannot complete until the remote admin secret is aligned or updated

## 1. Cloudflare Production Resources

Provide or create:

- production D1 database id
- production R2 bucket name
- production queue names
- target custom domain for the runtime

Expected defaults in this repo:

- Worker name: `mailagents-production`
- D1 database name: `mailagents-production`
- R2 bucket: `mailagents-production-email`
- queues:
  - `mailagents-production-email-ingest`
  - `mailagents-production-agent-execute`
  - `mailagents-production-outbound-send`
  - `mailagents-production-dead-letter`

## 2. Production Secrets

Set these Worker secrets for `production`:

- `SES_ACCESS_KEY_ID`
- `SES_SECRET_ACCESS_KEY`
- `WEBHOOK_SHARED_SECRET`
- `API_SIGNING_SECRET`
- `ADMIN_API_SECRET`

Recommended:

- use production-unique values for all three app secrets
- keep `ADMIN_ROUTES_ENABLED=false`
- keep `DEBUG_ROUTES_ENABLED=false`

## 3. Repo Config Changes

Update [wrangler.toml](/Users/zh/Documents/codeX/mailagents_cloudflare2/wrangler.toml):

- replace `REPLACE_WITH_PRODUCTION_D1_DATABASE_ID`
- confirm production `SES_FROM_DOMAIN`
- confirm production `SES_CONFIGURATION_SET`
- add route or custom domain settings once the hostname is confirmed

Then run:

```bash
npm run config:check:production
```

## 4. Dev Validation Before Production

Before production rollout, restore full `dev` smoke coverage:

- align `dev` Worker `ADMIN_API_SECRET`
- align `dev` Worker `WEBHOOK_SHARED_SECRET` if needed
- rerun:

```bash
BASE_URL='https://mailagents-dev.izhenghaocn.workers.dev' \
ADMIN_API_SECRET_FOR_SMOKE='...' \
WEBHOOK_SHARED_SECRET_FOR_SMOKE='...' \
bash ./scripts/local_smoke.sh

BASE_URL='https://mailagents-dev.izhenghaocn.workers.dev' \
ADMIN_API_SECRET_FOR_SMOKE='...' \
bash ./scripts/mcp_smoke.sh
```

## 5. Production Rollout Sequence

Once config and secrets are ready:

```bash
npm run d1:migrate:remote:production
npm run deploy:production
```

Optional:

- do not run the demo seed in production unless explicitly intended

After deploy:

- verify `/v2/meta/runtime`
- verify `/v2/meta/compatibility`
- verify MCP `initialize`
- verify admin/debug routes are disabled

## 6. Domain Binding

After the production Worker exists:

- add the final production route or custom domain in Cloudflare
- update `wrangler.toml` if route config is managed in repo
- verify DNS is active
- verify HTTPS response on the final hostname
- rerun the read-only runtime checks on the final domain

## 7. What I Need From You

To continue execution, I need:

- the real production D1 database id
- the final production hostname
- a Cloudflare token with permission to deploy Workers and write Worker secrets
- confirmation of the production secret values to install
