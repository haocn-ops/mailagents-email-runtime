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

The signup + site smoke flow exercises:

- merged runtime worker serving the public site at `/`
- merged runtime worker serving the admin dashboard at `/admin`
- reserved self-serve aliases rejected at `POST /public/signup`
- successful self-serve signup against the local `.test` domain when routing bootstrap is intentionally skipped
- mailbox-scoped access token usability after signup
- welcome-email delivery without creating billing reservations or debit ledger entries

The MCP smoke flow exercises:

- MCP transport `OPTIONS` and placeholder `GET` handling
- MCP JSON-RPC notifications, batches, parse errors, and empty-batch rejection
- MCP same-origin `Origin` enforcement for browser-style callers
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
npm run smoke:mcp:dev
```

The MCP smoke script expects the demo seed to include:

- seeded inbound message `msg_demo_inbound`
- seeded thread `thr_demo_inbound`

When targeting deployed `dev`, the script defaults to the admin secret in
`.dev.vars`. Override `ADMIN_API_SECRET_FOR_SMOKE` explicitly if the deployed
environment uses a different admin secret.

## Run the production public black-box smoke

This production-safe smoke covers only public or intentionally disabled
surfaces:

- home page availability
- runtime and compatibility metadata
- public signup method, content-type, JSON-shape, and field validation
- public token-reissue method, CORS, JSON-shape, required-field, and alias validation
- generic accepted token-reissue response for a clearly nonexistent mailbox
- admin MCP disabled posture without requiring an admin secret

Run:

```bash
npm run smoke:production:public
BASE_URL=https://api.mailagents.net bash ./scripts/production_public_blackbox_smoke.sh
```

Optional overrides:

- `BASE_URL`

This smoke is intended for production-like environments where admin and debug
routes are disabled. The broader post-deploy verifier now runs both:

- `bash ./scripts/production_readonly_smoke.sh`
- `bash ./scripts/production_public_blackbox_smoke.sh`

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

`PAYMENT_CONFIRM_MODE_FOR_SMOKE=facilitator` exercises facilitator-backed
confirmation and expects the worker environment to set
`X402_FACILITATOR_URL=mock://local` or a real facilitator base URL.

For the local mock facilitator path, the fastest command is:

```bash
npm run smoke:billing:facilitator:local:auto
```

## Run the dev real-chain topup smoke

This flow is the closest current check to a real x402 payment:

- it requests a live `402` topup quote from deployed `dev`
- it submits a real signed x402 v2 `exact/eip3009` proof to `POST /v1/billing/topup`
- with facilitator-backed `dev`, the payment receipt may already be `settled` in the initial topup response
- it retries `POST /v1/billing/payment/confirm` by `receiptId` only when a facilitator-backed retry is still needed

Prerequisites:

- deployed `dev` has `X402_PAY_TO` configured
- [`.secrets/dev-base-sepolia-wallet.json`](../.secrets/dev-base-sepolia-wallet.json) exists locally and holds a funded Base Sepolia wallet
- the wallet has enough Base Sepolia ETH for gas and USDC for the requested amount
- local `ethers` is available, or set `ETHERS_PATH`

Run:

```bash
npm run smoke:billing:dev:real-chain
npm run smoke:billing:dev:real-chain:facilitator
npm run smoke:billing:dev:real-chain:upgrade
```

If the wallet is low on Base Sepolia funds, you can refill it from the local
CDP faucet helper:

```bash
npm run faucet:cdp -- --token usdc
npm run faucet:cdp -- --token eth --token usdc --with-balances
npm run faucet:cdp -- --balances-only
```

This helper expects:

- [`.secrets/cdp_api_key.json`](../.secrets/cdp_api_key.json) with a valid CDP
  API key
- [`.secrets/dev-base-sepolia-wallet.json`](../.secrets/dev-base-sepolia-wallet.json)
  with the destination Base Sepolia address

Optional overrides:

- `CDP_API_KEY_JSON_PATH`
- `WALLET_JSON_PATH`
- `FAUCET_ADDRESS`
- `FAUCET_NETWORK`
- `FAUCET_TOKENS`

Optional overrides:

- `BASE_URL`
- `BASE_RPC_URL`
- `WALLET_JSON_PATH`
- `ETHERS_PATH`
- `CREDITS_TO_BUY`
- `OPERATOR_EMAIL_FOR_SMOKE`
- `PAYMENT_CONFIRM_MODE_FOR_SMOKE`

This script proves:

- the live quote fields are correct
- the current `payTo` address is really reachable onchain
- chain-backed payment proof capture works against deployed `dev`
- settlement lands in receipts, ledger, and billing account state

Current note:

- `PAYMENT_CONFIRM_MODE_FOR_SMOKE=manual` is no longer supported because
  `POST /v1/billing/payment/confirm` now only retries facilitator-backed
  settlement by `receiptId`
- use the default facilitator path, or set
  `PAYMENT_CONFIRM_MODE_FOR_SMOKE=facilitator` explicitly
- the facilitator variant proves the deployed runtime can automatically execute
  `verify -> settle`, but it still does not prove a third-party facilitator is
  live unless the environment points at a real one

## Run the dev real-chain upgrade smoke

This flow exercises the paid upgrade path with the same live `dev` deployment:

- it requests a live `402` upgrade quote from deployed `dev`
- it builds a real x402 v2 `exact/eip3009` payment payload against Base Sepolia USDC
- it submits that payload to `POST /v1/billing/upgrade-intent`
- it expects the facilitator-backed path to settle immediately
- it verifies the tenant lands in the environment's configured post-upgrade state

Prerequisites:

- deployed `dev` has `X402_PAY_TO` configured
- deployed `dev` points `X402_FACILITATOR_URL` at a working facilitator
- [`.secrets/dev-base-sepolia-wallet.json`](../.secrets/dev-base-sepolia-wallet.json) exists locally and holds a funded Base Sepolia wallet
- the wallet has enough Base Sepolia ETH for gas and USDC for the quoted amount

Run:

```bash
npm run smoke:billing:dev:real-chain:upgrade
```

Optional overrides:

- `BASE_URL`
- `WALLET_JSON_PATH`
- `ETHERS_PATH`
- `OPERATOR_EMAIL_FOR_SMOKE`

Current note:

- with facilitator-backed `dev`, the initial `upgrade-intent` response may
  already return a `settled` receipt before the explicit confirm retry runs

This script proves:

- low-value upgrade quotes display correctly, including sub-cent prices like `0.001`
- the facilitator-backed `upgrade-intent` flow accepts a real signed x402 payload
- successful settlement applies the configured upgrade transition for that environment

## Run the local upgrade-unlock regression smoke

This regression covers the exact flow that previously broke:

- self-serve signup starts with an internal-only agent recipient allowlist
- topup settles successfully
- external send is accepted immediately after topup, even while send policy still
  reports `internal_only`
- upgrade settles successfully
- external send is still accepted after upgrade without requiring a manual
  `agent:update` policy patch

Run:

```bash
npm run smoke:upgrade-unlock:local:auto
```

This script proves credits now unlock external recipient delivery for the
default self-serve agent policy, and that the later upgrade path does not
reintroduce the old `allowedRecipientDomains=["mailagents.net"]` restriction.

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
  `availableCredits/reservedCredits` reservation state before capture. The flag is
  currently reused as the generic outbound mock toggle even when `OUTBOUND_PROVIDER=resend`.
- The script seeds additional local credits into the demo tenant, keeps the
  tenant send policy on `internal_only`, verifies one successful external send
  still captures a reserved credit, then verifies one suppressed-recipient send
  releases its reservation without adding a debit ledger entry.
- Run `npm run d1:seed:local` first if the demo tenant or mailbox is missing.

## Run the signup + site smoke script

This smoke focuses on the merged-worker setup and self-serve signup regressions.

```bash
chmod +x scripts/signup_site_smoke.sh
ADMIN_API_SECRET_FOR_SMOKE=replace-with-admin-api-secret \
SES_MOCK_SEND=true \
SES_MOCK_SEND_DELAY_MS=1500 \
./scripts/signup_site_smoke.sh
```

Or:

```bash
npm run smoke:signup:local
npm run smoke:signup:local:auto
```

Notes:

- `smoke:signup:local:auto` starts the local worker with mocked outbound delivery
  so the welcome email can complete deterministically.
- The script verifies the same local worker serves `/`, `/admin`, and
  `/public/signup`, which is the intended post-merge deployment model.
- It rejects the reserved `hello` alias, creates a new self-serve mailbox, then
  verifies the welcome send does not create any billing reservation or ledger debit.

## Run the outbound uncertain-resolution smoke script

This smoke focuses on the admin manual-resolution path for uncertain sends.

```bash
chmod +x scripts/outbound_uncertain_resolution_smoke.sh
ADMIN_API_SECRET_FOR_SMOKE=replace-with-admin-api-secret \
./scripts/outbound_uncertain_resolution_smoke.sh
```

Or:

```bash
npm run smoke:uncertain:local
npm run smoke:uncertain:local:auto
```

Notes:

- The script covers `not_sent`, `sent`, and delivery-evidence conflict handling.
- It now also verifies that a missing draft payload causes manual resolution to
  fail closed instead of settling or releasing billing with empty recipients.
- For local setup, it seeds credits directly into the demo tenant so the smoke
  stays focused on uncertain-send resolution rather than the separate x402 topup flow.

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

- The smoke script does not guarantee the configured outbound provider actually delivered an outbound message.
- It verifies that the local API and queue-facing lifecycle can be exercised end to end.
- It asserts key response fields with `jq` so obvious regressions fail fast.
- Debug endpoints are admin-secret protected and intended only for local/dev verification.
- The billing + DID smoke intentionally uses manual settlement via `x-admin-secret`; it is a regression harness for the current skeleton flow, not proof that a facilitator integration is live.
- For the first real Base Sepolia + USDC payment run, follow [docs/x402-real-payment-checklist.md](./x402-real-payment-checklist.md) after facilitator credentials and `X402_PAY_TO` are configured.
- For production confidence, add real integration tests around D1 state assertions and provider callback handling.
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
