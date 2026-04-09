# Limits And Access

This page explains the current Mailagents usage limits, what is available by
default, and how a tenant moves from the default constrained posture to
external-recipient delivery.

## Current Model

Mailagents separates:

- mailbox access
- outbound credits
- outbound policy enforcement

That means a new tenant can have a working mailbox and mailbox-scoped token
before it has permission to send to arbitrary external recipients.

## What Every Signup Gets

The default signup flow already returns:

- one active mailbox
- one mailbox-scoped bearer token
- mailbox self routes such as `GET /v1/mailboxes/self`
- mailbox message routes such as `GET /v1/mailboxes/self/messages`
- mailbox-scoped send and reply routes such as `POST /v1/messages/send`
- self-service billing routes such as `POST /v1/billing/topup`,
  `POST /v1/billing/upgrade-intent`, and `POST /v1/billing/payment/confirm`
- self-service tenant status routes such as `GET /v1/billing/account`,
  `GET /v1/billing/receipts`, and `GET /v1/tenants/{tenantId}/send-policy`
- authenticated token rotation via `POST /v1/auth/token/rotate`
- MCP mailbox tools such as `list_messages`, `send_email`, and `reply_to_message`

For most early integration work, this is the recommended path.

## What Is Limited By Default

New tenants start in a conservative policy state.

Treat these paths as limited until the tenant has usable outbound credits or an
explicitly enabled external send policy:

- ordinary free-tier tenants can send up to 10 outbound emails in a rolling 24-hour window
- ordinary free-tier tenants can send up to 1 outbound email in a rolling 1-hour window
- sending to arbitrary external recipients
- welcome email to arbitrary external operator inboxes
- public token reissue email to arbitrary external operator inboxes

These are never supported:

- purchased lists
- unsolicited bulk marketing
- cold outreach
- attempts to bypass bounce, complaint, suppression, or abuse controls

## Recommended Safe Path

Until external delivery is enabled:

1. Retrieve the issued token from the configured operator delivery channel, or explicitly opt into legacy inline signup token return only in tightly controlled environments.
2. Use mailbox self routes and MCP mailbox tools as the primary integration path.
3. Use `POST /v1/auth/token/rotate` while the current token is still valid.
4. Treat operator-email recovery as secondary, not primary.

## Unlocking External Delivery

External delivery follows a credits-first model.

The current unlock model has one hard safety stop and one normal unlock path:

- `outboundStatus = suspended` always blocks outbound sending
- otherwise, any tenant with usable outbound credits can send to external recipients

The current flow is:

1. Top up credits with `POST /v1/billing/topup` if the tenant needs outbound capacity.
2. Or request an upgrade with `POST /v1/billing/upgrade-intent`; a settled upgrade also grants the configured upgrade credit bundle.
3. If the environment still returns a `pending` or `verified` receipt, retry facilitator settlement with `POST /v1/billing/payment/confirm`.
   Pass the Mailagents runtime `receiptId` in the form `prc_...`, not a blockchain transaction hash, chain receipt hash, or facilitator reference.
4. Verify the resulting state with:
   - `GET /v1/billing/account`
   - `GET /v1/tenants/{tenantId}/send-policy`

These self-service billing and status routes are available to the ordinary
mailbox-scoped signup token for the same tenant; a broader tenant-scoped token
is optional, not required.

## Expected State Transitions

The main states to expect are:

- default tenant:
  - billing `pricingTier = free`
  - send policy `outboundStatus = internal_only`
  - effective outbound cap `10 per rolling 24h` and `1 per rolling 1h`
- credits-backed external send:
  - billing `availableCredits > 0`
  - external recipients are allowed even if send policy still reports `internal_only`
- upgrade requested:
  - billing may move to `paid_review`
  - send policy may move to `external_review`
- external delivery enabled:
  - billing `pricingTier = paid_active`
  - billing `availableCredits` includes the configured upgrade bundle
  - send policy `outboundStatus = external_enabled`
  - `externalSendEnabled = true`
- restricted or frozen:
  - send policy `outboundStatus = suspended`

## Important Implementation Detail

The supported x402 billing path is facilitator-backed settlement.

A successful proof submission can directly move the tenant to the configured
settled state without a second confirmation request. If the first settlement
attempt does not complete, `POST /v1/billing/payment/confirm` is used only to
retry facilitator settlement for the existing receipt. Manual operator-driven
payment confirmation is no longer part of the supported x402 flow.

For the facilitator-backed `exact/eip3009` path, the client should sign the
authorization and submit it inside the x402 proof. Do not broadcast the same
`transferWithAuthorization` on-chain first and then hand that same
authorization to Mailagents. That consumes the nonce and can make a later
facilitator settle fail with `invalid_exact_evm_transaction_failed` even when
proof verification passes.

If a stored receipt's x402 authorization has already expired, retrying
`POST /v1/billing/payment/confirm` will not rescue it. In that case, request a
fresh quote, sign a new x402 proof, and submit a new topup or upgrade request
so the runtime can create a new `receiptId`.

Do not assume payment proof alone is enough until the tenant billing account
shows usable credits or the tenant send policy is explicitly enabled.

## Relevant Endpoints

- `POST /v1/billing/topup`
- `POST /v1/billing/upgrade-intent`
- `POST /v1/billing/payment/confirm`
- `GET /v1/billing/account`
- `GET /v1/billing/ledger`
- `GET /v1/billing/receipts`
- `GET /v1/tenants/{tenantId}/send-policy`

The current HTTP surface for these routes is documented in
[`docs/openapi.yaml`](./openapi.yaml).

## Related Documents

- [`docs/openapi.yaml`](./openapi.yaml)
- [`docs/x402-real-payment-checklist.md`](./x402-real-payment-checklist.md)
- [`docs/x402-did-architecture-plan.md`](./x402-did-architecture-plan.md)
- [`docs/deployment.md`](./deployment.md)
- [`docs/testing.md`](./testing.md)
