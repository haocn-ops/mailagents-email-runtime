# x402 Real Payment Checklist

This document turns the existing x402 and `did:web` foundation into a concrete
checklist for a real testnet payment flow using:

- network: `eip155:84532`
- asset: `usdc`

That corresponds to Base Sepolia plus USDC, which matches the current runtime
defaults in [src/lib/payments/x402.ts](../src/lib/payments/x402.ts).

## Current Status

As of 2026-03-23, the runtime has already been verified for:

- `402 Payment Required` quote generation
- `payment-signature` capture into receipts
- real facilitator-backed settlement into ledger and billing account state
- production topups that auto-settle immediately after proof submission
- production upgrades that settle through the facilitator-backed flow
- Mailagents-hosted `did:web` document generation and public resolution

## Target Outcome

After completing this checklist, a tenant should be able to:

1. request a real x402 quote
2. pay on Base Sepolia in USDC
3. submit a real payment proof
4. pass facilitator `verify` and `settle`
5. receive credits or a plan upgrade in Mailagents

## 1. Wallet Preparation

Prepare a wallet on Base Sepolia with:

- enough ETH for gas
- enough USDC for the target test payment

Recommended first payments:

- topup: 25 credits
- upgrade: one `paid_review` upgrade transaction

## 2. Facilitator Preparation

The runtime already supports a facilitator adapter in
[src/lib/payments/x402-facilitator.ts](../src/lib/payments/x402-facilitator.ts).

Before real payment testing, configure a real facilitator that exposes:

- `/verify`
- `/settle`

Required environment variables:

- `X402_FACILITATOR_URL`
- `X402_FACILITATOR_VERIFY_PATH`
- `X402_FACILITATOR_SETTLE_PATH`
- `X402_FACILITATOR_AUTH_TOKEN`

Optional but recommended:

- `X402_DEFAULT_NETWORK_ID=eip155:84532`
- `X402_DEFAULT_ASSET=usdc`

## 3. Pay-To Configuration

Configure a real recipient for quotes:

- `X402_PAY_TO`

This value must resolve to the wallet or settlement target expected by the
facilitator and by the payer.

Without this step, quotes may still be generated, but they are not ready for a
real payment flow.

## 4. DID Preparation

For the first real payment, Mailagents-hosted DID is sufficient.

Verify these routes work in the target environment:

- `POST /v1/tenants/{tenantId}/did/hosted`
- `GET /v1/tenants/{tenantId}/did`
- `GET /did/tenants/{tenantId}/did.json`

Recommended DID expectations:

- the DID method is `did:web`
- the public document exposes `#api`, `#mcp`, and `#payment` service entries
- the `#payment` service points to the active billing API origin

## 5. First Real Topup Test

Use a newly created tenant for the first end-to-end run.

### Step 1

Create a tenant and mailbox using the signup API.

### Step 2

Create a hosted DID:

```http
POST /v1/tenants/{tenantId}/did/hosted
```

### Step 3

Request a topup quote without proof:

```http
POST /v1/billing/topup
```

Expected result:

- HTTP `402`
- `payment-required` header present
- quote references:
  - network `eip155:84532`
  - asset `usdc`
  - correct `tenantDid`
  - correct `payTo`

### Step 4

Pay the quote using the Base Sepolia wallet.

### Step 5

Submit the real proof with:

```http
POST /v1/billing/topup
payment-signature: <real proof>
```

Expected result:

- HTTP `200` when facilitator-backed settlement is enabled
- HTTP `202` only in environments that still require a later confirmation step
- receipt status `settled` or `pending`, depending on environment configuration

### Step 6

Confirm settlement only when the environment still returns a pending receipt:

```http
POST /v1/billing/payment/confirm
```

Expected result:

- facilitator `verify` succeeds
- facilitator `settle` succeeds
- receipt becomes `settled`
- ledger gets a `topup` entry
- `availableCredits` increases

### Step 7

Verify:

- `GET /v1/billing/account`
- `GET /v1/billing/ledger`
- `GET /v1/billing/receipts`

## 6. Real Upgrade Test

After topup passes, run the plan transition flow.

### Step 1

Request an upgrade quote:

```http
POST /v1/billing/upgrade-intent
```

### Step 2

Pay using the same wallet flow.

### Step 3

Submit proof. If the environment still returns a pending receipt, confirm it with
`POST /v1/billing/payment/confirm`.

Expected result:

- receipt status `settled`
- the billing and send-policy state moves to the configured post-upgrade target for that environment

## 7. Environment Variables Checklist

For the target environment, confirm:

- `X402_FACILITATOR_URL`
- `X402_FACILITATOR_VERIFY_PATH`
- `X402_FACILITATOR_SETTLE_PATH`
- `X402_FACILITATOR_AUTH_TOKEN`
- `X402_PAY_TO`
- `X402_DEFAULT_NETWORK_ID`
- `X402_DEFAULT_ASSET`

For DID and signup-driven onboarding, also confirm:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ZONE_ID`
- `CLOUDFLARE_EMAIL_DOMAIN`
- `CLOUDFLARE_EMAIL_WORKER`

## 8. Operational Risks

### Invalid Payment Proof

If the payer submits a malformed or unsupported proof:

- receipt should remain `pending` or become `failed`
- credits must not be granted

### Duplicate Settlement

Repeated proof submissions or confirm calls must not create duplicate ledger entries.

### Wrong Pay-To Address

If `X402_PAY_TO` does not match facilitator expectations, verification may pass
incorrectly or settlement may fail.

### Cross-Environment Drift

Do not assume local mock behavior matches real facilitator behavior.

The first real payment should always be run in a deployed environment after
facilitator configuration is complete.

## 9. Recommended Execution Order

1. configure facilitator credentials and `X402_PAY_TO`
2. verify hosted DID routes in the target environment
3. run one real topup payment
4. validate ledger and credit balance
5. run one real upgrade payment
6. validate plan and send-policy transition

## 10. Repo Touchpoints

The main implementation areas involved in real payment integration are:

- [src/lib/payments/x402.ts](../src/lib/payments/x402.ts)
- [src/lib/payments/x402-facilitator.ts](../src/lib/payments/x402-facilitator.ts)
- [src/lib/payments/receipt-metadata.ts](../src/lib/payments/receipt-metadata.ts)
- [src/lib/payments/ledger-metadata.ts](../src/lib/payments/ledger-metadata.ts)
- [src/repositories/billing.ts](../src/repositories/billing.ts)
- [src/routes/api.ts](../src/routes/api.ts)

Architecture context:

- [docs/x402-did-architecture-plan.md](./x402-did-architecture-plan.md)
- [docs/anti-abuse-implementation-plan.md](./anti-abuse-implementation-plan.md)
