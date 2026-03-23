# Limits And Access

This page explains the current Mailagents usage limits, what is available by
default, and how a tenant moves from the default constrained posture to
external-recipient delivery.

## Current Model

Mailagents separates:

- mailbox access
- outbound credits
- external-send enablement

That means a new tenant can have a working mailbox and mailbox-scoped token
before it has permission to send to arbitrary external recipients.

## What Every Signup Gets

The default signup flow already returns:

- one active mailbox
- one mailbox-scoped bearer token
- mailbox self routes such as `GET /v1/mailboxes/self`
- mailbox message routes such as `GET /v1/mailboxes/self/messages`
- mailbox-scoped send and reply routes such as `POST /v1/messages/send`
- authenticated token rotation via `POST /v1/auth/token/rotate`
- MCP mailbox tools such as `list_messages`, `send_email`, and `reply_to_message`

For most early integration work, this is the recommended path.

## What Is Limited By Default

New tenants start in a conservative policy state.

Treat these paths as limited until the tenant has credits and a send policy that
explicitly enables external delivery:

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

1. Save the inline `accessToken` returned by signup.
2. Use mailbox self routes and MCP mailbox tools as the primary integration path.
3. Use `POST /v1/auth/token/rotate` while the current token is still valid.
4. Treat operator-email recovery as secondary, not primary.

## Unlocking External Delivery

External delivery is not just a payment switch. The current unlock model has
two gates:

- billing capacity
- outbound policy enablement

The current flow is:

1. Top up credits when the tenant needs outbound capacity.
2. Request an upgrade with `POST /v1/billing/upgrade-intent`.
3. Complete payment confirmation with `POST /v1/billing/payment/confirm`.
4. Verify the resulting state with:
   - `GET /v1/billing/account`
   - `GET /v1/tenants/{tenantId}/send-policy`

## Expected State Transitions

The main states to expect are:

- default tenant:
  - billing `pricingTier = free`
  - send policy `outboundStatus = internal_only`
- upgrade requested:
  - billing may move to `paid_review`
  - send policy may move to `external_review`
- external delivery enabled:
  - billing `pricingTier = paid_active`
  - send policy `outboundStatus = external_enabled`
  - `externalSendEnabled = true`
- restricted or frozen:
  - send policy `outboundStatus = suspended`

## Important Implementation Detail

The repository currently supports two settlement styles:

- facilitator-backed settlement
- manual operator-assisted settlement

If the active environment has facilitator-backed settlement enabled, a
successful upgrade confirmation can directly move the tenant to
`paid_active / external_enabled`.

If the active environment is still using manual settlement or manual review,
the payment receipt can be captured first and Mailagents finalizes the enablement
after confirmation.

Do not assume payment alone unlocks arbitrary external delivery until the
tenant send policy shows that external delivery is enabled.

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
