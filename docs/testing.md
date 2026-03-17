# Smoke Testing

This project currently uses a lightweight local smoke workflow instead of a full test framework.

## What it covers

The smoke flow exercises:

- admin token minting
- signed bearer auth
- agent creation
- mailbox binding
- mailbox listing assertion
- draft creation
- draft fetch assertion
- draft send enqueue
- persisted outbound job assertion
- SES webhook ingestion

The MCP smoke flow exercises:

- MCP `initialize`
- MCP `tools/list`
- `/v2/meta/compatibility`
- `/v2/meta/compatibility/schema`
- MCP provisioning tools
- MCP draft creation and send
- MCP idempotent send replay
- MCP composite reply workflow success path against seeded inbound mail
- MCP machine-readable error codes

## Prerequisites

- local worker already running with `npm run dev:local`
- local D1 already migrated and seeded
- `jq` installed

## Run the smoke script

```bash
chmod +x scripts/local_smoke.sh
ADMIN_API_SECRET_FOR_SMOKE=replace-with-admin-api-secret \
WEBHOOK_SHARED_SECRET_FOR_SMOKE=replace-with-shared-secret \
./scripts/local_smoke.sh
```

Optional overrides:

- `BASE_URL`
- `TENANT_ID`
- `MAILBOX_ID`

## Run the MCP smoke script

```bash
chmod +x scripts/mcp_smoke.sh
ADMIN_API_SECRET_FOR_SMOKE=replace-with-admin-api-secret \
./scripts/mcp_smoke.sh
```

Or:

```bash
npm run smoke:mcp:local
```

The MCP smoke script expects the demo seed to include:

- seeded inbound message `msg_demo_inbound`
- seeded thread `thr_demo_inbound`

## Run Against Deployed `dev`

The current shared `dev` environment is:

- `https://mailagents-dev.izhenghaocn.workers.dev`

Use the same scripts with `BASE_URL` overrides:

```bash
BASE_URL='https://mailagents-dev.izhenghaocn.workers.dev' \
ADMIN_API_SECRET_FOR_SMOKE=replace-with-admin-api-secret \
WEBHOOK_SHARED_SECRET_FOR_SMOKE=replace-with-shared-secret \
bash ./scripts/local_smoke.sh
```

```bash
BASE_URL='https://mailagents-dev.izhenghaocn.workers.dev' \
ADMIN_API_SECRET_FOR_SMOKE=replace-with-admin-api-secret \
bash ./scripts/mcp_smoke.sh
```

Before running remote smoke:

- deploy with `npm run deploy:dev`
- apply `npm run d1:migrate:remote:dev`
- apply `npm run d1:seed:remote:dev` if the seeded inbound MCP flow is needed
- confirm `ADMIN_API_SECRET`, `API_SIGNING_SECRET`, and `WEBHOOK_SHARED_SECRET` are configured as Worker secrets for `dev`

## Sample SES fixtures

Fixtures live in:

- [fixtures/ses/delivery.json](/Users/zh/Documents/codeX/mailagents_cloudflare2/fixtures/ses/delivery.json)
- [fixtures/ses/bounce.json](/Users/zh/Documents/codeX/mailagents_cloudflare2/fixtures/ses/bounce.json)

You can post them manually:

```bash
curl -X POST http://127.0.0.1:8787/v1/webhooks/ses \
  -H 'content-type: application/json' \
  -H 'x-webhook-shared-secret: replace-with-shared-secret' \
  --data-binary @fixtures/ses/delivery.json
```

## Notes

- The smoke script does not guarantee SES actually delivered an outbound message.
- It verifies that the local API and queue-facing lifecycle can be exercised end to end.
- It asserts key response fields with `jq` so obvious regressions fail fast.
- Debug endpoints are admin-secret protected and intended only for local/dev verification.
- For production confidence, add real integration tests around D1 state assertions and SES callback handling.
- In deployed `dev`, the negative MCP mailbox-binding check can legitimately return either
  `resource_mailbox_not_found` or `access_mailbox_denied`, depending on token mailbox scope.
