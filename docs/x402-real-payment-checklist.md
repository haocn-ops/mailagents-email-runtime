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

In other words, production is no longer in a "quote only" state. When the
environment has a working facilitator and the client submits a standards-shaped
`x402Version: 2` proof, the same billing endpoint can now return a fully
settled result without a separate confirm call.

## What Actually Creates A Receipt

This point is easy to misunderstand, so it is worth stating explicitly:

1. The first billing request is a quote request.
2. The second billing request is the proof-submission request.
3. Mailagents only creates a `receiptId` after it receives a
   `payment-signature` header on that second request.

That means:

- a blockchain transfer by itself does not create a Mailagents receipt
- a `402` quote response does not include a receipt
- a raw transaction hash is not enough
- the receipt is created only when the client replays the same billing route
  with a valid `payment-signature`

## Real Runtime Mode

Mailagents now uses a facilitator-backed settlement path for x402 billing.

### Facilitator Settlement

In this mode:

1. client requests quote
2. server returns `402`
3. client submits `payment-signature`
4. server calls facilitator `verify -> settle`
5. server returns `200`

Expected response shape:

- `verificationStatus = settled`
- `receipt.status = settled`
- for topups: `ledgerEntry` and updated `account`
- for upgrades: updated `account` and `sendPolicy`

If a receipt remains `pending` or `verified` because facilitator settlement did
not complete on the first try, `POST /v1/billing/payment/confirm` can be used as
a facilitator retry endpoint by submitting the `receiptId` only. Manual payment
confirmation is no longer part of the supported x402 flow.

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

- HTTP `200` when facilitator-backed settlement completes immediately
- HTTP `202` only if the receipt is captured but needs a later facilitator retry
- receipt status `settled` or `verified`/`pending`, depending on the exact retry state

### What The Client Must Actually Send

The most important implementation detail is the shape of the proof.

Mailagents does not expect:

- only a chain transaction hash
- only a block number
- only a transfer receipt
- a custom JSON blob without x402 metadata

Mailagents expects a base64-encoded JSON payload shaped like x402 v2. At
minimum, the decoded JSON should look like:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.mailagents.net/v1/billing/topup",
    "description": "Top up 1 Mailagents credits for tenant tnt_...",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "eip155:84532",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "amount": "10000",
    "payTo": "0x0b4fbD3AA802B9eAE9c5F6D4B5FE7ADd6eB1D3D2",
    "maxTimeoutSeconds": 300,
    "extra": {
      "assetTransferMethod": "eip3009",
      "name": "USDC",
      "version": "2"
    }
  },
  "payload": {
    "signature": "0x...",
    "authorization": {
      "from": "0x...",
      "to": "0x...",
      "value": "10000",
      "validAfter": "1774235547",
      "validBefore": "1774235877",
      "nonce": "0x..."
    }
  }
}
```

The entire JSON document above must be base64-encoded and sent as:

```http
payment-signature: <base64 encoded x402 payload>
```

### Minimal Proof Submission Example

```bash
PAYMENT_SIGNATURE="$(base64 < payment.json | tr -d '\n')"

curl --http1.1 -X POST https://api.mailagents.net/v1/billing/topup \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -H "payment-signature: $PAYMENT_SIGNATURE" \
  --data '{"credits":1}'
```

### Typical Success Response In Immediate-Settlement Mode

```json
{
  "receipt": {
    "id": "prc_...",
    "status": "settled"
  },
  "ledgerEntry": {
    "id": "led_..."
  },
  "account": {
    "availableCredits": 1
  },
  "verificationStatus": "settled",
  "message": "Payment receipt settled and credits applied."
}
```

### Step 6

Retry facilitator settlement only when the environment still returns a `pending`
or `verified` receipt:

```http
POST /v1/billing/payment/confirm
```

Expected result:

- facilitator `verify` and `settle` are retried
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

Submit proof. If the environment still returns a `pending` or `verified`
receipt, retry facilitator settlement with `POST /v1/billing/payment/confirm`.

Expected result:

- receipt status `settled`
- the billing and send-policy state moves to the configured post-upgrade target for that environment

### Typical Success Response For Upgrade

In production, a successfully settled upgrade can return a shape like:

```json
{
  "receipt": {
    "id": "prc_...",
    "status": "settled"
  },
  "account": {
    "pricingTier": "paid_active",
    "status": "active"
  },
  "sendPolicy": {
    "outboundStatus": "external_enabled",
    "externalSendEnabled": true,
    "reviewRequired": false
  },
  "verificationStatus": "settled"
}
```

Do not assume every environment will use these exact post-upgrade values. The
important point is that the settlement response itself tells you which target
state that environment applies.

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

The most common real-world variant is not a malformed signature, but a proof
document that is structurally incomplete for x402. For example:

- missing `x402Version`
- missing `resource`
- missing `accepted`
- missing `payload.authorization`
- submitting only a chain transaction record instead of an x402 proof object

### "No facilitator registered for x402 version: undefined"

This specific error almost always points to a client-side payload-shape problem,
not a missing server facilitator.

Interpret it as:

- the facilitator did receive a request
- but the decoded proof did not contain a usable `x402Version`
- so the facilitator treated the version as `undefined`

In practice, check these first:

1. Was the `payment-signature` header sent at all?
2. Does the decoded payload include `"x402Version": 2`?
3. Is the client sending the whole x402 proof object, not just tx metadata?
4. Does the proof include both `accepted` and `payload.authorization`?

Do not jump straight to "server facilitator is unconfigured" when this error
appears. A working facilitator can still return this exact error if the client
proof is not x402-shaped.

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
3. request a quote and inspect its `paymentRequired.accepts[0]`
4. generate a standards-shaped x402 v2 proof object
5. run one real topup payment
6. validate ledger and credit balance
7. run one real upgrade payment
8. validate plan and send-policy transition

## 10. Troubleshooting Decision Tree

Use this quick map when a real payment test fails.

### Case 1: The server returns `503 x402 billing is not configured`

Likely cause:

- environment missing `X402_PAY_TO`
- environment missing or misconfigured billing vars

Check:

- `X402_PAY_TO`
- `X402_DEFAULT_NETWORK_ID`
- `X402_DEFAULT_ASSET`

### Case 2: The server returns `402 Payment required`

Likely cause:

- this is still only the quote step
- the client has not replayed the request with `payment-signature` yet

### Case 3: The server returns `202 pending`

Likely cause:

- that environment still expects a later `POST /v1/billing/payment/confirm`
- or facilitator settlement is not enabled there

### Case 4: The server returns `No facilitator registered for x402 version: undefined`

Likely cause:

- proof shape is wrong
- `x402Version` missing from the decoded proof

Check:

- base64 decode the header value locally
- confirm the JSON includes `"x402Version": 2`
- confirm the proof is not just a raw tx hash or receipt

### Case 5: The server returns `200 settled` but credits or policy did not change

This should be treated as a real runtime bug. Capture:

- full response body
- receipt id
- tenant id
- quote body
- exact environment URL

## 11. Repo Touchpoints

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
