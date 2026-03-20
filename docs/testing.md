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
- MCP mailbox-scoped `list_messages`
- MCP draft creation and send
- MCP high-level `send_email`
- MCP high-level `reply_to_message`
- MCP idempotent send replay
- MCP composite reply workflow success path against seeded inbound mail
- MCP machine-readable error codes

The billing + DID smoke flow exercises:

- tenant-scoped bearer token minting
- default billing account initialization
- default tenant send policy initialization
- hosted `did:web` binding creation
- public DID document resolution
- x402 `402 Payment Required` quote flow for topups
- pending topup receipt creation
- manual payment settlement into the credit ledger
- x402 upgrade intent quote flow
- `paid_review` upgrade settlement
- admin approval transition to `paid_active`

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

## Run the billing + DID smoke script

```bash
chmod +x scripts/billing_did_smoke.sh
ADMIN_API_SECRET_FOR_SMOKE=replace-with-admin-api-secret \
./scripts/billing_did_smoke.sh
```

Or:

```bash
npm run smoke:billing:local
npm run smoke:billing:local:auto
npm run smoke:billing:facilitator:local:auto
```

Optional overrides:

- `BASE_URL`
- `TENANT_ID`
- `AUTH_SCOPE_FOR_SMOKE`
- `X402_PAYMENT_SIGNATURE_FOR_SMOKE`
- `PAYMENT_CONFIRM_MODE_FOR_SMOKE`

`PAYMENT_CONFIRM_MODE_FOR_SMOKE=manual` uses the existing admin-confirm path.
`PAYMENT_CONFIRM_MODE_FOR_SMOKE=facilitator` exercises facilitator-backed
confirmation and expects the worker environment to set
`X402_FACILITATOR_URL=mock://local` or a real facilitator base URL.

For the local mock facilitator path, the fastest command is:

```bash
npm run smoke:billing:facilitator:local:auto
```

The D1 migrate scripts are now safe to rerun against an existing local or remote
database. They record applied files in `schema_migrations` and bootstrap that
state from the already-present schema when upgrading an older environment.

## Run the outbound credit smoke script

This smoke focuses on the reserve -> capture -> release path for external sends.
It expects the local demo seed (`t_demo`, `mbx_demo`, `agt_demo`) to be present.

```bash
chmod +x scripts/outbound_credit_smoke.sh
ADMIN_API_SECRET_FOR_SMOKE=replace-with-admin-api-secret \
SES_MOCK_SEND=true \
SES_MOCK_SEND_DELAY_MS=1500 \
./scripts/outbound_credit_smoke.sh
```

Or:

```bash
npm run smoke:credits:local
npm run smoke:credits:local:auto
```

Notes:

- `smoke:credits:local:auto` starts the worker with `SES_MOCK_SEND=true` and a
  small mock delay so the script can assert the intermediate
  `availableCredits/reservedCredits` reservation state before capture.
- The script tops up the seeded demo tenant, enables external sending, verifies
  one successful external send captures a reserved credit, then verifies one
  suppressed-recipient send releases its reservation without adding a debit
  ledger entry.
- Run `npm run d1:seed:local` first if the demo tenant or mailbox is missing.

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
- billing + DID smoke also requires migrations `0006` through `0008`, because it exercises billing accounts, DID bindings, and tenant send policies

## Historical Verification Records

The main purpose of this page is to explain current smoke coverage and how to
run it.

For dated `dev` and production verification records from the March 2026 rollout
window, see [docs/archive/2026-03-runtime-verification.md](./archive/2026-03-runtime-verification.md).

Current interpretation guidance:

- shared `dev` has been verified live during the current rollout era, but the detailed dated evidence now lives in the archive
- production has also been verified for the controlled support-mailbox path, but dated record IDs and incident notes now live in the archive
- treat any archived verification record as evidence from a specific point in time, not as proof that the same state still holds today

## Sample SES fixtures

Fixtures live in:

- [fixtures/ses/delivery.json](../fixtures/ses/delivery.json)
- [fixtures/ses/bounce.json](../fixtures/ses/bounce.json)

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
- The billing + DID smoke intentionally uses manual settlement via `x-admin-secret`; it is a regression harness for the current skeleton flow, not proof that a facilitator integration is live.
- For production confidence, add real integration tests around D1 state assertions and SES callback handling.
- If SES is still sandbox-limited, external outbound smoke coverage must be scoped to verified recipient addresses.
- In deployed `dev`, the negative MCP mailbox-binding check can legitimately return either
  `resource_mailbox_not_found` or `access_mailbox_denied`, depending on token mailbox scope.
- historical rollout-era evidence now lives under [docs/archive/](./archive/README.md)

## Historical Subject Backfill

When older inbound messages were normalized before RFC 2047 subject decoding landed,
their stored `messages.subject` values may still look like `=?UTF-8?...?=`.

Use the backfill tool to preview and optionally repair those rows from raw EML in R2:

```bash
npm run backfill:subjects:dev -- --dry-run
npm run backfill:subjects:production -- --dry-run
```

To scope the scan:

```bash
node ./scripts/backfill_message_subjects.mjs --env production --mailbox mbx_4ee06ae7768c4b3f95f22cb2e7b57ce4 --limit 20
node ./scripts/backfill_message_subjects.mjs --env production --message-id msg_f025694cda9043bab2521bfabd338bff
```

To apply updates after reviewing the dry run:

```bash
node ./scripts/backfill_message_subjects.mjs --env production --apply --limit 20
```

The tool only updates inbound messages whose stored subject currently begins with
an encoded-word prefix and whose raw `.eml` object still exists in R2.
