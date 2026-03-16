# Dev Environment Bootstrap

This guide covers how to create the first real Cloudflare `dev` environment for this project.

## Goal

Provision:

- one D1 database
- one R2 bucket
- four Queues
- one deployed Worker in `env.dev`

## 1. Log in to Cloudflare

```bash
wrangler login
```

## 2. Create Cloudflare resources

Use the template helper:

```bash
bash scripts/bootstrap_dev_resources.sh
```

Or run the commands manually:

```bash
wrangler d1 create mailagents-dev
wrangler r2 bucket create mailagents-dev-email
wrangler queues create mailagents-dev-email-ingest
wrangler queues create mailagents-dev-agent-execute
wrangler queues create mailagents-dev-outbound-send
wrangler queues create mailagents-dev-dead-letter
```

## 3. Copy the generated D1 database ID

When `wrangler d1 create mailagents-dev` succeeds, Cloudflare returns a `database_id`.
Paste that value into:

- [wrangler.toml](/Users/zh/Documents/codeX/mailagents_cloudflare2/wrangler.toml)

Specifically:

- `env.dev.d1_databases[0].database_id`

## 4. Configure SES-related values for dev

Update:

- `env.dev.vars.SES_FROM_DOMAIN`
- `env.dev.vars.SES_CONFIGURATION_SET`

Recommended:

- use a dedicated dev sending subdomain
- use a dev-only SES configuration set

Example:

- `SES_FROM_DOMAIN = "dev.mail.yourdomain.com"`
- `SES_CONFIGURATION_SET = "mailagents-dev"`

## 5. Set Worker secrets for dev

Print the commands:

```bash
bash scripts/bootstrap_worker_secrets.sh dev
```

Then run the printed `wrangler secret put` commands and enter real secret values.

## 6. Validate config

```bash
npm run config:check:dev
```

This should pass before any remote migration or deploy.

## 7. Apply remote dev schema

```bash
npm run d1:migrate:remote:dev
npm run d1:seed:remote:dev
```

## 8. Deploy dev

```bash
npm run deploy:dev
```

## 9. Verify deployed dev

After deploy, verify:

- worker responds
- auth token route works if `ADMIN_ROUTES_ENABLED=true`
- agent creation works
- draft creation works
- SES webhook endpoint is reachable

## 10. Recommended next step

Once `dev` works end to end:

1. create `staging`
2. disable admin/debug routes there
3. run remote migration/seed for `staging`
4. deploy `staging`

## Notes

- Keep `staging` and `production` admin/debug routes disabled by default.
- Do not reuse production SES identities or configuration sets in `dev`.
