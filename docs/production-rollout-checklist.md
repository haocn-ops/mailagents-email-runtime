# Production Rollout Checklist

This checklist covers the remaining work before deploying the Mailagents
runtime to the real production environment and binding a custom domain.

Current blockers as of 2026-03-17:

- production D1 config in [wrangler.toml](/Users/zh/Documents/codeX/mailagents_cloudflare2/wrangler.toml) still contains placeholders
- `mailagents-production` Worker does not exist yet
- production Worker secrets are not set
- `dev` remote smoke cannot complete until the remote admin secret is aligned or updated
- `mailagents.net` resolves, but `api.mailagents.net` does not currently resolve in DNS

## 1. Cloudflare Production Resources

Provide or create:

- production D1 database id
- production R2 bucket name
- production queue names
- target custom domain for the runtime

Observed current state:

- root site `mailagents.net` is live
- likely API hostname `api.mailagents.net` is not currently resolvable

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

## 8. Minimum Cloudflare Permissions

The current token can read some account resources, including:

- D1 database list
- R2 bucket list
- Workers Queue list
- existing `dev` Worker deployment and secret names

It is still missing the write path needed for rollout.

The next token should be able to:

- deploy or update Workers
- write Worker secrets
- create or update D1 bindings through deploy
- create or confirm production queues and R2 buckets if they do not exist
- manage the final API hostname binding

Practical minimum access:

- Workers Scripts: Edit
- Workers Routes or Custom Domains: Edit
- D1: Edit
- Queues: Edit
- R2: Edit
- Zone DNS: Edit for the zone that will host the API domain

If you prefer narrower access:

- pre-create the production D1 database, R2 bucket, queues, and DNS record yourself
- then I only need a token that can:
  - deploy Workers
  - update Worker secrets
  - attach the Worker to the already prepared route or custom domain
