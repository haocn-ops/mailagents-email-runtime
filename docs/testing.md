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

## Live `dev` Verification

As of 2026-03-18, the shared `dev` environment has been live-verified for:

- agent registration
- outbound SES send
- inbound email to `agent@mailagents.net`
- versioned registry resolution via `agent_versions` and `agent_deployments`
- deployment rollout and rollback against the same mailbox target

The validation sequence was:

1. deploy the latest `dev` Worker
2. apply remote D1 migrations including `0002_agent_registry.sql`
3. create a demo agent version for `agt_demo`
4. create an active mailbox deployment for `mbx_demo`
5. send a live email to `agent@mailagents.net`
6. confirm a new `tasks` row exists
7. confirm the new `agent_runs` row has a non-null `trace_r2_key`
8. fetch the trace object from remote R2 and verify it contains `agentVersionId` and `deploymentId`
9. roll the mailbox target to a newer deployment and then roll it back, confirming only one deployment remains `active`

## Live `production` Verification

As of 2026-03-18, production has been live-verified for:

- inbound email to `support@mailagents.net`
- task creation for `agt_support_primary`
- version-aware run tracing for `agv_support_v1`
- controlled outbound reply through SES

Verified production records:

- inbound message: `msg_48e8daa3d719442fadd210d33d298590`
- task: `tsk_842060e1e2904cb5be11612d0174573b`
- run: `run_tsk_842060e1e2904cb5be11612d0174573b`
- successful outbound draft: `drf_0609d3589a034460960f807fe0031cd3`
- successful outbound job: `obj_c1745e2c87e741baaf10b9e783ba7560`
- successful outbound message: `msg_7a423d1ac5234bdbb17cda24c1dce175`

One earlier outbound attempt intentionally revealed an environment dependency:

- failed outbound job: `obj_c175ddc4f9cd4581b230f802d95e4d72`
- failure cause: `Configuration set <mailagents-production> does not exist.`

That failure was resolved by creating the missing SES configuration set
`mailagents-production` in `us-east-1`, after which the reply path succeeded.

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
