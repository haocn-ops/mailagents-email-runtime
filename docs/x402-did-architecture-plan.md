# x402 And did:web Architecture Plan

This document describes how to add x402-based payment flows and `did:web`
identity to Mailagents without coupling payment settlement directly to the
asynchronous email delivery pipeline.

## Design Goals

- use x402 for machine-payable billing flows
- use `did:web` for tenant identity and key discovery
- keep outbound email authorization under Mailagents policy control
- support the anti-abuse rollout documented in
  [docs/anti-abuse-implementation-plan.md](./anti-abuse-implementation-plan.md)
- avoid charging per outbound message at the transport layer in the first phase

## Recommended Product Model

Do not start with direct per-message onchain settlement for `send_email`.

Instead:

1. tenant pays through x402
2. Mailagents records the payment
3. Mailagents grants credits or upgrades the tenant plan
4. outbound sends consume credits and remain subject to anti-abuse policy

This keeps payment, entitlement, and asynchronous delivery concerns separate.

## Why Not Charge Per Email First

The current runtime sends mail asynchronously:

- request creates a draft
- request enqueues an outbound job
- actual SES delivery happens later
- final delivery can still fail after queue acceptance

If payment were attached directly to each outbound send request:

- refunds would become part of normal delivery failure handling
- retries would need chain-aware idempotency semantics
- delivery ambiguity would leak into billing

A prepaid credits model is safer for the first production integration.

## Recommended Capability Layers

### Layer 1: Identity

Use `did:web` to represent a tenant or Mailagents-managed tenant namespace.

Examples:

- tenant-controlled domain: `did:web:example.com`
- Mailagents-hosted namespace: `did:web:mailagents.net:tenants:acme`

Use DID documents for:

- payment verification key discovery
- service endpoint discovery
- tenant identity portability

Do not use DID as the only source of authorization. Keep authorization inside
Mailagents tokens and policy records.

### Layer 2: Billing And Entitlements

Use internal ledger records for:

- prepaid credits
- payment receipts
- tenant billing status
- plan transitions such as `free -> paid_review -> paid_active`

### Layer 3: Outbound Authorization

Use the anti-abuse policy layer for:

- internal-only versus external send enablement
- recipient allowlists
- daily quotas
- suspension and downgrade

### Layer 4: Delivery

Keep the existing outbound queue and SES integration unchanged for phase 1.

## Recommended Billing Flow

### Top Up Credits

Preferred flow:

1. client requests `POST /v1/billing/topup`
2. server responds with x402 payment requirements, or a conventional billing
   quote wrapper that can trigger `402 Payment Required`
3. client completes x402 payment
4. server verifies and settles payment
5. server records a receipt
6. server adds credits to the tenant ledger

### Upgrade External Send Capability

For external send enablement:

1. client requests `POST /v1/billing/upgrade-intent`
2. client pays via x402
3. tenant transitions to `paid_review`
4. internal review or policy automation promotes tenant to `paid_active`
5. outbound external send becomes available

This matches the SES anti-abuse story:

- payment alone does not automatically grant unlimited external send
- external send remains gated by review and risk controls

## `did:web` Integration Model

### DID Ownership Modes

Support two modes:

1. tenant-managed DID
   - tenant publishes its own DID document on its domain
   - Mailagents verifies control

2. Mailagents-hosted DID
   - Mailagents publishes the DID document under a Mailagents-owned namespace
   - useful for tenants without their own domain

Recommended first phase:

- support Mailagents-hosted `did:web`
- add tenant-managed DID later

### DID Document Uses

Recommended document fields:

- `verificationMethod`
- `authentication`
- `assertionMethod`
- `service`

Recommended `service` entries:

- `MailagentsApiService`
- `MailagentsMcpService`
- `MailagentsPaymentService`

Example conceptual service block:

```json
{
  "id": "did:web:mailagents.net:tenants:acme#payment",
  "type": "MailagentsPaymentService",
  "serviceEndpoint": "https://api.mailagents.net/v1/billing/topup"
}
```

Use cases:

- wallets and agents can discover where payment requests originate
- tenant metadata can expose authoritative API endpoints
- signed payment quotes can reference a stable DID

## Suggested New Tables

### `tenant_billing_accounts`

Purpose:

- the canonical billing state for a tenant

Suggested shape:

```sql
CREATE TABLE tenant_billing_accounts (
  tenant_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'trial',
  pricing_tier TEXT NOT NULL DEFAULT 'free',
  default_network TEXT,
  default_asset TEXT,
  available_credits INTEGER NOT NULL DEFAULT 0,
  reserved_credits INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
```

Recommended enums:

- `status`: `trial`, `active`, `delinquent`, `suspended`
- `pricing_tier`: `free`, `paid_review`, `paid_active`, `enterprise`

### `tenant_credit_ledger`

Purpose:

- append-only accounting for topups and usage

Suggested shape:

```sql
CREATE TABLE tenant_credit_ledger (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  credits_delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  payment_receipt_id TEXT,
  reference_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
```

Recommended `entry_type` values:

- `topup`
- `debit_send`
- `debit_reply`
- `refund`
- `adjustment`

### `tenant_payment_receipts`

Purpose:

- durable record of an x402-backed payment

Suggested shape:

```sql
CREATE TABLE tenant_payment_receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  receipt_type TEXT NOT NULL,
  payment_scheme TEXT NOT NULL,
  network TEXT,
  asset TEXT,
  amount_atomic TEXT NOT NULL,
  amount_display TEXT,
  payment_reference TEXT,
  settlement_reference TEXT,
  status TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Recommended `status` values:

- `pending`
- `verified`
- `settled`
- `failed`
- `refunded`

### `tenant_did_bindings`

Purpose:

- associate a tenant with a DID and verification state

Suggested shape:

```sql
CREATE TABLE tenant_did_bindings (
  tenant_id TEXT PRIMARY KEY,
  did TEXT NOT NULL UNIQUE,
  method TEXT NOT NULL,
  document_url TEXT,
  status TEXT NOT NULL,
  verification_method_id TEXT,
  service_json TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Recommended `status` values:

- `pending`
- `verified`
- `revoked`

## Suggested API Surface

### Billing

- `POST /v1/billing/topup`
- `POST /v1/billing/upgrade-intent`
- `POST /v1/billing/payment/confirm`
- `GET /v1/billing/balance`
- `GET /v1/billing/receipts`

### DID

- `GET /v1/tenants/:tenantId/did`
- `PUT /v1/tenants/:tenantId/did`
- `POST /v1/tenants/:tenantId/did/verify`

### Policy

- `GET /v1/tenants/:tenantId/send-policy`
- `PUT /v1/tenants/:tenantId/send-policy`

## x402 Integration Modes

### Mode A: Direct Verification In Mailagents

Mailagents verifies x402 payment headers directly.

Pros:

- fewer dependencies
- simpler architecture

Cons:

- Mailagents owns more chain/payment logic

### Mode B: Facilitator-Assisted Verification

Mailagents calls an x402 facilitator for verification and settlement.

Pros:

- cleaner separation
- easier to swap transport or asset details later

Cons:

- extra dependency

Recommended first phase:

- keep the Mailagents billing API structured so it can support either mode
- use a small adapter layer such as
  [src/lib/payments/x402.ts](../src/lib/payments/x402.ts)

## Recommended Runtime Flow

### `POST /v1/billing/topup`

1. authenticate tenant
2. build a payment quote
3. if payment proof is missing, return `402`
4. if payment proof is present, verify it
5. write `tenant_payment_receipts`
6. append `tenant_credit_ledger`
7. update `tenant_billing_accounts.available_credits`
8. return updated balance

### `send_email` Or `reply_to_message`

1. load tenant send policy
2. load agent policy
3. confirm external send entitlement
4. confirm recipient domains are allowed
5. confirm quota and rate limit
6. optionally reserve credits
7. create draft
8. enqueue outbound job
9. finalize credit debit

For phase 1, debit on queue acceptance is acceptable. Later, enterprise billing
could shift to debit-on-attempt or debit-on-delivery.

## Entitlement Model

Recommended rule set:

- `free`
  - external send disabled
  - internal send only
- `paid_review`
  - payment complete
  - external send still gated pending review
- `paid_active`
  - external send allowed
  - quota-limited
- `suspended`
  - no outbound send

This model is useful for both product policy and SES review posture.

## DID And Payment Binding

To make DID materially useful, bind payment and identity together:

- a payment quote can include the tenant DID
- a DID document can expose a payment service endpoint
- the signing key used for payment quote assertions can be listed in
  `assertionMethod`

This gives autonomous agents a way to verify:

- which tenant they are paying
- which endpoint is authoritative
- which key signs payment-related assertions

## Security And Abuse Notes

- never treat payment as sufficient authorization for outbound send
- keep mailbox-scoped tokens and send policy checks mandatory
- do not let DID ownership bypass tenant policy
- log every payment verification and policy decision
- keep risk events tied to tenant, mailbox, and payment receipt where possible

## Recommended Build Order

### Phase 1

- ship anti-abuse internal-only send defaults
- add `tenant_billing_accounts`
- add `tenant_credit_ledger`
- add `tenant_payment_receipts`

### Phase 2

- add `POST /v1/billing/topup`
- return x402-compatible payment requirements
- record successful topups as credits

### Phase 3

- add `tenant_did_bindings`
- support Mailagents-hosted `did:web`
- expose DID read/write APIs

### Phase 4

- connect payment success to plan upgrades
- add `paid_review -> paid_active` workflow
- document the SES anti-abuse posture in public and operator docs

### Phase 5

- support tenant-managed `did:web`
- optionally add facilitator-backed verification and settlement adapter

## Test Matrix

Add tests for:

1. unpaid topup request returns `402`
2. verified payment creates a receipt and credits ledger entry
3. duplicate payment confirmation is idempotent
4. free tenant with credits still cannot send externally
5. paid_review tenant cannot send externally until enabled
6. paid_active tenant can send externally within quota
7. suspended tenant cannot send even if credits are available
8. DID binding can be created, verified, and read back
9. DID changes do not silently widen send permissions

## Source References

- x402 overview and FAQ:
  [docs.x402.org](https://docs.x402.org/)
- DID Core:
  [www.w3.org/TR/did-core/](https://www.w3.org/TR/did-core/)
- `did:web` method:
  [w3c-ccg.github.io/did-method-web/](https://w3c-ccg.github.io/did-method-web/)
