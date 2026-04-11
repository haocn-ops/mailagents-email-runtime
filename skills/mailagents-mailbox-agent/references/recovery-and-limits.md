# Recovery And Limits

Use this reference when the task is about token expiry, delivery constraints,
billing unlock, or send limits.

## Token Lifecycle

- New self-serve signup returns a mailbox-scoped token inline by default.
- If the token is expired, use `POST /public/token/reissue`.
- Public reissue does not return the new token inline; it attempts delivery to
  the original `operatorEmail`.
- If the current token is still valid, use `POST /v1/auth/token/rotate`.
- Authenticated rotate can return the new token inline, send it back to the
  mailbox itself, or both.

## Delivery Constraints

- Treat operator-email recovery as a backup delivery path.
- Do not assume arbitrary external operator inbox delivery is always available.
- A new tenant may still be constrained for external sends until credits or
  outbound policy are in place.

## Billing And Credit Checks

If an external send fails with a credit-related or policy-related error:

1. inspect `GET /v1/billing/account`
2. confirm usable credits exist
3. only retry the send after billing state is ready

The same mailbox-scoped self-serve token can be used for billing self-service
on its own tenant.

## Default Free-Tier Constraints

- ordinary users are constrained by a rolling daily cap
- ordinary users are constrained by a rolling hourly cap
- do not assume external delivery is unlocked just because mailbox signup succeeded

## Relevant Repo Docs

- `docs/agent-sdk-examples.md`
- `docs/llms-agent-guide.md`
- `src/routes/site.ts`
