# March 27 2026 Code Review Findings

This note archives the source-code review findings collected on 2026-03-27.
It is intentionally dated and may become stale as fixes land.

The original findings snapshot is preserved below. A short remediation update
was added on 2026-03-28 to record the follow-up fixes completed after the
initial review.

Use the main guides for current product behavior and supported workflows:

- [docs/README.md](../README.md)
- [docs/testing.md](../testing.md)
- [docs/ai-auth.md](../ai-auth.md)
- [docs/admin-mcp.md](../admin-mcp.md)

## Scope

Reviewed areas included:

- auth and mailbox-scoped access control
- admin site and admin MCP flows
- billing, x402 settlement, and ledger behavior
- outbound send queue, retries, and SES event handling
- self-serve signup and token reissue flows
- draft, replay, and idempotency paths
- task execution and agent deployment behavior

## Remediation Update (2026-03-28)

The current tree includes follow-up fixes beyond the original 2026-03-27
snapshot. This pass specifically addressed the outbound billing and retry
follow-ups below:

1. Fixed: admin outbound retry now validates job status, provider delivery
   evidence, and draft send eligibility before re-reserving credits, so a
   rejected retry no longer leaks a fresh reservation.
   Refs: `src/routes/site.ts:1619`, `src/routes/site.ts:1627`,
   `src/routes/site.ts:1634`, `src/routes/site.ts:1645`

2. Fixed: SES webhook reconciliation now treats any outbound with delivery
   evidence as delivered for billing/state resolution, so later bounce,
   complaint, or reject events no longer release credits for an already
   delivered send.
   Refs: `src/routes/api.ts:3338`, `src/routes/api.ts:3339`,
   `src/routes/api.ts:3342`, `src/routes/api.ts:3362`

3. Fixed: outbound settlement now treats an existing ledger entry as the
   durable settlement record and skips duplicate reserved-credit capture during
   replayed queue/webhook settlement paths.
   Refs: `src/lib/outbound-billing.ts:37`, `src/lib/outbound-billing.ts:61`

4. Fixed: `POST /v1/billing/payment/confirm` no longer replays local settlement
   side effects for receipts already marked `settled`. If a settled receipt is
   missing its local ledger record, the API now returns `409` and requires
   manual reconciliation instead of re-granting credits or re-enabling tenant
   send policy.
   Refs: `src/routes/api.ts:1189`, `src/routes/api.ts:4362`,
   `src/routes/api.ts:4373`

5. Fixed: REST draft/send helper paths now validate `from` against the mailbox
   address before draft creation, and they surface a `409` partial-success
   response when server-side state was already committed before a later error.
   This reduces blind client retries after ambiguous failures.
   Refs: `src/routes/api.ts:342`, `src/routes/api.ts:3470`,
   `src/routes/api.ts:3836`, `src/routes/api.ts:3890`

6. Fixed: admin MCP mailbox token minting now requires send-capable mailbox
   access before granting `draft:send` scope or `send` bootstrap mode. This
   prevents admin-issued mailbox tokens from advertising send flows that would
   later fail at runtime due to receive-only bindings.
   Refs: `src/routes/admin-mcp.ts:69`, `src/routes/admin-mcp.ts:545`,
   `src/routes/admin-mcp.ts:828`, `src/routes/admin-mcp.ts:902`

7. Fixed: generic admin `create_access_token` minting now rejects mailbox-
   scoped task/draft/replay tokens that omit `agentId`. This prevents issuing
   mailbox tokens whose scopes imply agent-bound workflows but whose claims
   could never satisfy runtime agent checks.
   Refs: `src/routes/admin-mcp.ts:70`, `src/routes/admin-mcp.ts:803`,
   `src/routes/admin-mcp.ts:813`

8. Hardening: `GET /v1/mailboxes/self/messages` now clamps `limit` with the
   same bounded parser used by other list endpoints instead of accepting an
   unbounded numeric query value.
   Refs: `src/routes/api.ts:1452`, `src/routes/api.ts:1468`,
   `src/routes/api.ts:4191`

9. Residual: `AGENT_EXECUTE_QUEUE` is still a manual-review placeholder rather
   than a full execution pipeline. The worker now safely lands in
   `needs_review` and acknowledges the queue item, but it still does not
   execute agent logic end-to-end.
   Refs: `src/handlers/queues.ts:267`, `src/handlers/queues.ts:293`,
   `src/handlers/queues.ts:297`

## Additional Follow-up (2026-03-29)

1. Fixed: `POST /v1/auth/token/rotate` self-mailbox delivery now enforces the
   same current mailbox-access check used by other mailbox-scoped routes.
   Mailbox-scoped tokens whose bound agent is no longer active for the target
   mailbox can no longer use stale claims to trigger self-mailbox token
   delivery.
   Refs: `src/routes/api.ts:727`, `src/routes/api.ts:765`,
   `src/routes/api.ts:3767`

2. Fixed: admin `inspect_delivery_case` now derives suppression lookups from
   draft payload `to/cc/bcc` recipients when available instead of relying only
   on stored `message.toAddr`. Multi-recipient outbound inspection now covers
   CC and BCC suppressions as well.
   Refs: `src/routes/admin-mcp.ts:542`, `src/routes/admin-mcp.ts:580`,
   `src/routes/admin-mcp.ts:654`

3. Fixed: inbound normalization now degrades to `needs_review` if
   `AGENT_EXECUTE_QUEUE` dispatch fails after task creation, instead of failing
   the whole ingest path. The runtime now records a review trace and dead-letter
   entry while preserving normalized inbound state.
   Refs: `src/handlers/queues.ts:88`, `src/handlers/queues.ts:249`,
   `src/handlers/queues.ts:328`

4. Fixed: deployment rollout now pauses the previously active target before
   activating the newly created deployment, with rollback restore on failure.
   This removes the deterministic unique-index conflict caused by trying to
   activate the new deployment while the old active deployment was still live.
   Refs: `src/repositories/agents.ts:656`, `src/repositories/agents.ts:679`,
   `src/repositories/agents.ts:684`

5. Fixed: token mint and rotate validation now refuse to perpetuate malformed
   mailbox-scoped task/draft/replay/send tokens. Mailbox-scoped tokens that
   imply agent-bound workflows now require `agentId`, and `draft:send` tokens
   must still resolve to send-capable mailbox access at validation time.
   Refs: `src/routes/api.ts:153`, `src/routes/api.ts:522`,
   `src/routes/api.ts:1927`, `src/routes/api.ts:4056`

6. Hardening: deployment activate, rollout, and rollback transitions now keep
   a status snapshot and restore prior deployment states if pause, activate, or
   finalize steps fail mid-flight. This reduces the chance that a partial
   failure leaves a target with no active deployment.
   Refs: `src/repositories/agents.ts:557`, `src/repositories/agents.ts:634`,
   `src/repositories/agents.ts:692`, `src/repositories/agents.ts:733`

7. Hardening: token rotation now also rejects mailbox-scoped claims bound to
   inactive mailboxes, so stale mailbox tokens cannot be renewed inline after
   the mailbox itself has been disabled.
   Refs: `src/routes/api.ts:4045`, `src/routes/api.ts:4053`

## Findings

1. Free-tier quota bypass only applies when `externalDomains.length > 0`, so
   internal-only sends still hit free quota even when tenant credits or policy
   should have unlocked sending.
   Refs: `src/lib/outbound-policy.ts:91`, `src/lib/outbound-policy.ts:137`

2. Tenant `internalDomainAllowlist` updates do not resync the default
   self-serve agent allowlist, so tenant policy and default agent recipient
   policy can drift apart.
   Refs: `src/routes/api.ts:920`, `src/lib/provisioning/signup.ts:225`,
   `src/lib/self-serve-agent-policy.ts:59`, `src/lib/outbound-policy.ts:115`

3. Reply-thread fallback ignores CC and BCC because only `messages.to_addr` is
   stored and matched.
   Refs: `src/repositories/mail.ts:703`, `src/repositories/mail.ts:1017`

4. Reply-thread fallback compares raw-trimmed referenced IDs against
   lowercased stored IDs, so case-only differences miss.
   Refs: `src/repositories/mail.ts:702`, `src/repositories/mail.ts:718`

5. Admin dashboard cookie stores raw `ADMIN_API_SECRET`.
   Refs: `src/routes/site.ts:2051`, `src/routes/site.ts:2054`

6. `/admin/api/*` JSON responses are cookie-authenticated but are not marked
   `private, no-store`.
   Refs: `src/routes/site.ts:1253`, `src/routes/site.ts:1272`,
   `src/lib/http.ts:12`

7. `inspect_delivery_case` suppression lookup breaks for multi-recipient
   outbound because it queries suppression with comma-joined `toAddr`.
   Refs: `src/routes/admin-mcp.ts:594`, `src/routes/admin-mcp.ts:612`,
   `src/routes/admin-mcp.ts:630`, `src/repositories/mail.ts:1632`

8. `create_access_token` in admin MCP can mint arbitrary claims without
   ownership validation.
   Refs: `src/routes/admin-mcp.ts:718`, `src/routes/admin-mcp.ts:748`

9. Legacy upgrade receipts with missing `includedCredits` settle using the
   current environment default, not the originally quoted credits.
   Refs: `src/lib/payments/receipt-metadata.ts:245`, `src/routes/api.ts:3625`,
   `src/lib/payments/x402.ts:215`

10. Upgrade settlement updates billing and send policy before ledger append,
    reconcile, and receipt settlement, so partial failure can leave a tenant
    upgraded without a settled receipt.
    Refs: `src/routes/api.ts:3639`, `src/routes/api.ts:3648`,
    `src/routes/api.ts:3662`, `src/routes/api.ts:3687`

11. Facilitator successful-settle can be re-sent after local finalize failure
    because verified receipts are auto-settled again and no explicit local
    idempotency key is sent to the facilitator.
    Refs: `src/routes/api.ts:3577`, `src/routes/api.ts:3581`,
    `src/routes/api.ts:713`, `src/routes/api.ts:821`,
    `src/lib/payments/x402-facilitator.ts:575`

12. Subject normalization strips only one `Re`, `Fwd`, or `Fw` prefix, which
    weakens thread fallback and thread creation for repeated prefixes.
    Refs: `src/lib/email-parser.ts:183`, `src/repositories/mail.ts:670`,
    `src/handlers/queues.ts:104`

13. Many tenant billing endpoints use `requireAuth([])`, so mailbox-scoped
    default and self-serve tokens can read tenant billing state and initiate
    topup, upgrade, and confirm flows.
    Refs: `src/routes/api.ts:634`, `src/routes/api.ts:643`,
    `src/routes/api.ts:654`, `src/routes/api.ts:665`,
    `src/routes/api.ts:773`, `src/routes/api.ts:1031`,
    `src/lib/provisioning/default-access.ts:4`, `src/routes/admin-mcp.ts:67`

14. Tenant DID routes also use `requireAuth([])`, so mailbox tokens can read
    and change tenant DID binding.
    Refs: `src/routes/api.ts:1079`, `src/routes/api.ts:1098`,
    `src/routes/api.ts:1113`, `src/routes/api.ts:1124`

15. `payment/confirm` on already settled upgrade receipts replays upgrade side
    effects and can re-enable tenants that operators had later reset or
    suspended.
    Refs: `src/routes/api.ts:1068`, `src/routes/api.ts:1076`,
    `src/routes/api.ts:3621`, `src/routes/api.ts:3639`,
    `src/routes/api.ts:3648`, `src/routes/api.ts:3657`,
    `src/routes/api.ts:956`, `src/routes/api.ts:983`

16. Admin site write endpoints are cookie-authenticated without CSRF or Origin
    defenses.
    Refs: `src/routes/site.ts:2041`, `src/routes/site.ts:2054`,
    `src/routes/site.ts:2087`, `src/routes/site.ts:1342`,
    `src/routes/site.ts:1586`, `src/routes/site.ts:1649`,
    `src/routes/site.ts:1764`, `src/routes/site.ts:1959`

17. `bootstrap_mailbox_agent_token` can advertise send tools without
    `agentId`, but those send tools require a single-agent token and fail at
    runtime.
    Refs: `src/routes/admin-mcp.ts:758`, `src/routes/admin-mcp.ts:769`,
    `src/routes/admin-mcp.ts:785`, `src/routes/mcp.ts:752`,
    `src/routes/mcp.ts:1503`

18. SES webhook charges credits on bounce, complaint, and reject by calling
    `settleOutboundUsageDebit()` instead of releasing the reservation.
    Refs: `src/routes/api.ts:2863`, `src/routes/api.ts:2870`,
    `src/routes/api.ts:2887`, `src/routes/site.ts:1705`,
    `src/lib/outbound-billing.ts:12`, `src/lib/outbound-billing.ts:66`

19. SES bounce and complaint normalization only captures the first recipient,
    so multi-recipient failures suppress only one address.
    Refs: `src/lib/ses-events.ts:50`, `src/lib/ses-events.ts:64`,
    `src/routes/api.ts:2902`

20. SES webhook overwrites message, job, and draft state per single event, so
    mixed-recipient outcomes can flip a delivered message back to failed.
    Refs: `src/routes/api.ts:2847`, `src/routes/api.ts:2863`,
    `src/routes/api.ts:2880`, `src/routes/api.ts:2887`,
    `src/handlers/queues.ts:49`

21. `token/rotate` self-mailbox delivery can send the rotated bearer token to
    arbitrary mailboxes, including cross-tenant mailboxes, when the claims have
    no `mailboxIds`.
    Refs: `src/routes/api.ts:607`, `src/routes/api.ts:613`,
    `src/lib/auth.ts:146`, `src/routes/api.ts:3278`,
    `src/routes/api.ts:3301`

22. SES webhook auth is fail-open when `WEBHOOK_SHARED_SECRET` is unset.
    Refs: `src/routes/api.ts:2799`, `src/routes/api.ts:2800`,
    `src/routes/api.ts:2834`, `src/routes/api.ts:2863`,
    `src/routes/api.ts:2902`

23. Agent-scoped REST and MCP routes rely on fail-open `enforceAgentAccess()`,
    so tenant tokens with matching scopes can target arbitrary `agentId`
    values across the tenant for mailbox listing, task listing, and policy
    update.
    Refs: `src/lib/auth.ts:138`, `src/routes/api.ts:2158`,
    `src/routes/api.ts:2171`, `src/routes/api.ts:2212`,
    `src/repositories/agents.ts:944`, `src/repositories/agents.ts:957`,
    `src/repositories/mail.ts:285`, `src/routes/mcp.ts:998`,
    `src/routes/mcp.ts:1405`

24. `POST /v1/agents/:agentId/drafts` accepts arbitrary `from`, but the later
    send path throws a plain `Error` and bubbles as `500`.
    Refs: `src/routes/api.ts:2541`, `src/routes/api.ts:2612`,
    `src/repositories/mail.ts:757`, `src/routes/api.ts:2688`,
    `src/repositories/mail.ts:965`, `src/repositories/mail.ts:978`,
    `src/routes/api.ts:2914`

25. Queue send path does not revalidate mailbox active state, mailbox binding,
    or outbound policy, so queued or retried jobs can still send after operator
    suspend, disable, or unbind actions.
    Refs: `src/routes/api.ts:3117`, `src/routes/api.ts:3137`,
    `src/handlers/queues.ts:409`, `src/handlers/queues.ts:433`,
    `src/routes/site.ts:1612`

26. Admin retry requeues failed outbound jobs without re-reserving or
    rechecking credits, and later settlement swallows missing capture, so
    retries can bypass the balance gate.
    Refs: `src/handlers/queues.ts:515`, `src/routes/site.ts:1612`,
    `src/lib/outbound-billing.ts:41`, `src/lib/outbound-billing.ts:62`,
    `src/repositories/billing.ts:535`, `src/repositories/billing.ts:583`

27. The `sending` timeout and manual-review branch can leave reserved credits
    stuck until manual resolution.
    Refs: `src/handlers/queues.ts:351`, `src/handlers/queues.ts:380`,
    `src/routes/site.ts:1649`, `src/routes/site.ts:1705`

28. `AGENT_EXECUTE_QUEUE` worker is effectively a no-op: it writes a trace and
    marks the task done, but never reads the message, creates a draft, updates
    the message, or enters `needs_review`.
    Refs: `src/handlers/queues.ts:153`, `src/handlers/queues.ts:166`,
    `src/handlers/queues.ts:193`, `src/handlers/queues.ts:238`

29. Task claim trusts stale queue payload `agentId`, `agentVersionId`, and
    `deploymentId`, and does not verify the latest assigned agent, so old retry
    messages can execute with outdated agent metadata.
    Refs: `src/repositories/mail.ts:1496`, `src/repositories/mail.ts:1552`,
    `src/handlers/queues.ts:176`, `src/handlers/queues.ts:196`,
    `src/handlers/queues.ts:204`, `src/routes/api.ts:208`,
    `src/routes/mcp.ts:105`

30. `AGENT_EXECUTE_QUEUE` failure can loop forever because the worker sets the
    task to failed, then `message.retry()`, and `claimTaskForExecution()` can
    reclaim failed tasks.
    Refs: `src/repositories/mail.ts:1552`, `src/handlers/queues.ts:193`,
    `src/handlers/queues.ts:245`

31. Deployment rollout and rollback are non-transactional two-step updates and
    can leave a target with no active deployment if the second step fails.
    Refs: `src/repositories/agents.ts:554`, `src/repositories/agents.ts:577`,
    `src/repositories/agents.ts:587`, `src/repositories/agents.ts:614`

32. `PATCH /v1/agents/:agentId/deployments/:deploymentId` can hit the active
    target unique index and bubble as `500` instead of `409 conflict`.
    Refs: `src/routes/api.ts:1948`, `src/repositories/agents.ts:533`,
    `migrations/0003_agent_deployment_history.sql:35`

33. Anonymous `POST /public/signup` can reconfigure zone-wide Cloudflare
    catch-all routing.
    Refs: `src/routes/api.ts:475`, `src/lib/provisioning/signup.ts:137`,
    `src/lib/provisioning/signup.ts:430`, `src/lib/cloudflare-email.ts:131`

34. Anonymous `POST /public/signup` has no rate limit or ownership proof and
    immediately returns an active mailbox-scoped bearer token for the new
    mailbox.
    Refs: `src/routes/api.ts:475`, `src/routes/api.ts:524`,
    `src/lib/provisioning/signup.ts:151`, `src/lib/provisioning/signup.ts:216`,
    `src/lib/provisioning/signup.ts:239`,
    `src/lib/provisioning/default-access.ts:31`

35. Outbound worker does not atomically claim `outbound_jobs`, so duplicate
    queue delivery or concurrent consumers can send the same email twice.
    Refs: `src/handlers/queues.ts:264`, `src/handlers/queues.ts:409`,
    `src/repositories/mail.ts:1702`

36. After the provider accepts a send, any later local persistence failure can
    push the job back into retry or failure and cause a duplicate send.
    Refs: `src/handlers/queues.ts:446`, `src/handlers/queues.ts:461`,
    `src/handlers/queues.ts:497`, `src/lib/ses.ts:85`

37. Several idempotency flows perform side effects before
    `completeIdempotencyKey()`, and they release the pending key if completion
    fails, so a retry with the same key can enqueue or send again instead of
    replaying the original result.
    Refs: `src/repositories/mail.ts:1188`, `src/repositories/mail.ts:1210`,
    `src/routes/api.ts:2473`, `src/routes/api.ts:2762`,
    `src/routes/api.ts:3223`, `src/routes/site.ts:1937`

38. `createDraft()` writes the full payload to R2 before inserting the draft
    row and does not clean up on insert failure, leaving orphan draft payloads.
    Some of those payloads contain bearer tokens.
    Refs: `src/repositories/mail.ts:757`, `src/repositories/mail.ts:770`,
    `src/lib/provisioning/signup.ts:251`, `src/routes/api.ts:3301`

39. `public/token/reissue` does not actually isolate the refreshed token to the
    operator inbox. A still-valid mailbox token can trigger reissue and then
    read the resulting outbound message content from the same mailbox to recover
    the new token.
    Refs: `src/routes/api.ts:524`, `src/routes/api.ts:565`,
    `src/routes/api.ts:2992`, `src/routes/api.ts:3024`,
    `src/lib/provisioning/default-access.ts:4`, `src/routes/api.ts:1240`,
    `src/routes/api.ts:1297`, `src/repositories/mail.ts:367`,
    `src/repositories/mail.ts:391`

40. Draft send itself is not atomically claimed. Two concurrent send requests
    for the same draft can both pass status checks and each create a new
    outbound job.
    Refs: `src/routes/api.ts:2688`, `src/routes/mcp.ts:1706`,
    `src/repositories/mail.ts:930`, `src/repositories/mail.ts:1035`,
    `migrations/0001_initial.sql:144`

41. `public/token/reissue` fails open when the `token_reissue_requests` table
    is unavailable, so the endpoint continues issuing refreshed tokens without
    cooldown or IP throttling.
    Refs: `src/routes/api.ts:544`, `src/routes/api.ts:561`,
    `src/repositories/token-reissue.ts:31`,
    `src/repositories/token-reissue.ts:55`

42. Mailbox-scoped self-serve token can read tasks from other mailboxes that
    share the same agent because task listing is keyed only by `assigned_agent`.
    Refs: `src/lib/provisioning/default-access.ts:4`, `src/routes/api.ts:2212`,
    `src/routes/mcp.ts:1405`, `src/repositories/mail.ts:285`

43. System-generated welcome and token reissue sends bypass outbound policy,
    and those routes are also credit-exempt, so they can send external email
    even when normal tenant sending is suspended, internal-only, or out of
    credits.
    Refs: `src/lib/provisioning/signup.ts:251`, `src/lib/provisioning/signup.ts:280`,
    `src/routes/api.ts:3024`, `src/routes/api.ts:3053`,
    `src/lib/outbound-credits.ts:16`, `src/repositories/mail.ts:947`

44. Anonymous `POST /public/signup` can be used as an external relay to any
    syntactically valid `operatorEmail`, because signup immediately queues a
    `system:signup_welcome` external send to that address.
    Refs: `src/routes/api.ts:475`, `src/lib/provisioning/signup.ts:83`,
    `src/lib/provisioning/signup.ts:112`, `src/lib/provisioning/signup.ts:251`,
    `src/lib/provisioning/signup.ts:280`, `src/lib/outbound-credits.ts:16`

45. Anonymous callers can use `public/token/reissue` to keep a mailbox under
    cooldown and block legitimate recovery attempts. The endpoint checks recent
    mailbox requests before proof of ownership, then logs a new cooldown record
    in `finally` even when delivery fails or the mailbox has no usable operator
    route.
    Refs: `src/routes/api.ts:540`, `src/routes/api.ts:545`,
    `src/routes/api.ts:565`, `src/routes/api.ts:571`,
    `src/repositories/token-reissue.ts:31`,
    `src/repositories/token-reissue.ts:55`

46. Anonymous `public/signup` discloses mailbox alias existence and reserved
    aliases through distinct `409` error messages, so callers can enumerate
    valid targets for later abuse such as token-reissue cooldown poisoning.
    Refs: `src/lib/provisioning/signup.ts:127`, `src/lib/provisioning/signup.ts:132`,
    `src/routes/api.ts:502`, `src/routes/api.ts:508`

47. Inbound SMTP acceptance does not deduplicate on `Message-ID`. Every
    delivery gets a fresh internal `messages.id`, and the later ingest path
    creates reply tasks keyed by that new source-message ID, so upstream
    redelivery of the same email can trigger duplicate agent executions or
    duplicate replies.
    Refs: `src/handlers/email.ts:23`, `src/handlers/email.ts:41`,
    `src/handlers/queues.ts:153`, `src/repositories/mail.ts:1445`,
    `migrations/0001_initial.sql:61`,
    `migrations/0011_messages_internet_message_id_index.sql:1`

48. `handleEmail()` writes the raw inbound `.eml` object to R2 before the
    `messages` insert and does not clean up on insert failure, leaving orphan
    raw-email blobs that still contain full message bodies and attachments.
    Refs: `src/handlers/email.ts:25`, `src/handlers/email.ts:28`,
    `src/handlers/email.ts:30`

49. `handleEmail()` persists the inbound message row before enqueueing
    `EMAIL_INGEST_QUEUE`. If queue send fails after the insert, this path has
    no compensating cleanup or fallback requeue, so the message can remain
    durably stranded in `received` with its raw body stored but never
    normalized or tasked.
    Refs: `src/handlers/email.ts:30`, `src/handlers/email.ts:44`,
    `src/handlers/email.ts:57`, `src/index.ts:121`

50. Email normalization writes normalized JSON and attachment blobs to R2
    before attachment metadata is committed, and `insertAttachments()` deletes
    old attachment rows without deleting their prior R2 objects. Replay or
    partial-failure paths can therefore leave orphan or stale attachment blobs
    behind indefinitely.
    Refs: `src/handlers/queues.ts:107`, `src/handlers/queues.ts:137`,
    `src/handlers/queues.ts:148`, `src/repositories/mail.ts:1359`

## Notes

- Some findings overlap or chain together. They are intentionally kept as
  separate records when the exploit surface or failure mode differs.
- The original review pass only recorded findings. Later remediation notes are
  tracked below when fixes land in the working tree.

## Remediation Notes

- 2026-03-27: working tree patches were applied for findings 47-50 covering
  inbound dedupe, raw-ingest cleanup, queue fallback/failed-state handling, and
  replay attachment R2 cleanup.
- 2026-03-27: working tree patches were applied for findings 5, 6, 16, 22, 23,
  and 42 covering signed admin session cookies, `private, no-store` admin API
  responses, same-origin enforcement for cookie-authenticated admin writes,
  fail-closed SES webhook auth, fail-closed agent-scoped route checks, and
  mailbox-filtered task listing.
- 2026-03-27: working tree patches were applied for findings 21, 24, 41, and
  45 covering mailbox-scoped enforcement for self-mailbox token delivery,
  early `from` validation on agent draft creation, fail-closed public token
  reissue when the rate-limit table is unavailable, and logging cooldown
  records only after a reissue is actually queued.
- 2026-03-27: working tree patches were applied for findings 4 and 12 covering
  case-insensitive `Message-ID` reply-thread matching and repeated
  `Re:/Fwd:/Fw:` prefix normalization.
- 2026-03-27: working tree patches were applied for finding 17 by requiring
  `agentId` when admin bootstrap tokens request `draft_only` or `send` scopes,
  so the issued token no longer advertises mailbox send capability it cannot
  actually exercise.
- 2026-03-27: working tree patches were applied for findings 10 and 15 covering
  safer upgrade settlement ordering and idempotent handling of already-settled
  upgrade receipts so `payment/confirm` no longer replays upgrade side effects.
- 2026-03-27: working tree patches were applied for findings 7, 18, 19, and
  20 covering multi-recipient suppression inspection, releasing reserved
  credits on bounce/complaint failures instead of charging them, capturing all
  SES recipients for suppression updates, and preventing later failure events
  from downgrading a message that already has delivery evidence.
- 2026-03-27: working tree patches were applied for findings 13 and 14 by
  blocking mailbox-scoped tokens from tenant-level billing and DID routes while
  preserving tenant-scoped access for broader operator tokens.
- 2026-03-27: working tree patches were applied for findings 31 and 32 by
  making deployment activation/rollback switch active targets conflict-safely
  and mapping deployment uniqueness races to consistent `409` API responses
  instead of partially mutating state or leaking raw database errors.
- 2026-03-27: working tree patches were applied for findings 43, 44, and 46 by
  routing self-serve welcome and token-reissue system sends through the normal
  outbound policy and credit checks, removing external-send credit exemptions
  for operator email delivery, and collapsing reserved/taken mailbox alias
  conflicts into a single non-enumerating public error message.
- 2026-03-27: working tree patches were applied for findings 25, 26, and 27 by
  revalidating mailbox state, send authorization, and outbound policy inside
  the outbound worker, requiring admin retry to pass the same guards and
  reserve credits again before requeue, and releasing reserved credits when a
  send attempt ages into manual-review uncertainty instead of leaving them
  stuck indefinitely.
- 2026-03-27: working tree patches were applied for findings 28, 29, and 30 by
  changing `AGENT_EXECUTE_QUEUE` from a false-success no-op into a
  review-escalation path that loads the task/source message, resolves the
  current execution target instead of trusting stale queue metadata, updates
  task assignment when the target moved, and stops reclaiming `failed` tasks in
  a retry loop.
- 2026-03-27: working tree patches were applied for findings 33 and 34 by
  disabling public-signup Cloudflare routing autoconfiguration unless the
  runtime explicitly opts in, and by disabling anonymous inline signup token
  return by default so mailbox-scoped credentials are no longer exposed
  directly in the public signup HTTP response.
- 2026-03-27: working tree patches were applied for findings 35 and 36 by
  atomically claiming outbound jobs before provider send attempts and treating
  post-acceptance local persistence failures as dead-letter/manual follow-up
  instead of retrying the provider send path and risking duplicate delivery.
- 2026-03-27: working tree patches were applied for findings 38 and 40 by
  cleaning up draft payload blobs when draft-row creation fails and making
  draft enqueue perform an atomic status claim before creating outbound
  messages/jobs so concurrent send requests cannot double-enqueue the same
  draft.
- 2026-03-27: working tree patches were applied for finding 39 by hiding
  operator-email token-reissue delivery messages from mailbox-scoped bearer
  tokens across both self-mailbox and generic message read/content routes, so
  a still-valid mailbox token can no longer recover the refreshed operator
  token from the same mailbox history.
- 2026-03-27: working tree patches were applied for finding 37 by keeping
  idempotency reservations in place once replay/send side effects have already
  been queued or draft-send state has already been created, instead of deleting
  the pending key after a later completion-record failure and allowing the same
  idempotency key to enqueue duplicate work on retry.
- 2026-03-27: working tree patches were applied for findings 1 and 2 by
  letting tenant credits or an explicitly enabled outbound policy bypass the
  free-tier quota gate for all sends, including internal-only recipients, and
  resyncing default self-serve agent recipient allowlists when the tenant
  internal-domain allowlist changes so default agent policy does not drift.
- 2026-03-28: working tree patches were applied for finding 3 by teaching
  reply-thread fallback to inspect outbound draft payload recipients, including
  `cc` and `bcc`, instead of matching only the persisted `messages.to_addr`
  column.
- 2026-03-28: working tree patches were applied for finding 8 by making the
  admin MCP `create_access_token` tool verify that any requested `agentId` and
  `mailboxIds` actually belong to the specified `tenantId` before minting the
  token.
- 2026-03-28: working tree patches were applied for finding 9 by making
  upgrade-settlement finalization fail closed when legacy receipt metadata is
  missing `includedCredits`, instead of silently substituting the current
  environment default and granting the wrong amount.
- 2026-03-28: working tree patches were applied for finding 11 by reusing a
  previously stored successful facilitator settle response when a receipt is
  already `verified`, so local finalize retries no longer call the facilitator
  settle endpoint again after an earlier settle succeeded remotely.
- 2026-03-28: additional hardening was applied for finding 11 by sending the
  local payment-receipt ID to the facilitator verify/settle endpoints as an
  idempotency key, giving remote settlement a stable deduplication handle even
  when a local persistence step fails after the facilitator already accepted
  the request.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by making the admin-only `POST /v1/auth/tokens` route verify that
  any requested `agentId` and `mailboxIds` belong to the specified `tenantId`,
  aligning it with the already-fixed admin MCP token minting path so the REST
  endpoint can no longer mint cross-tenant inconsistent bearer tokens.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by making the admin-secret tenant send-policy mutation routes honor
  `ADMIN_ROUTES_ENABLED` as well as `x-admin-secret`, so disabling admin
  routes on protected/public hosts now consistently hides both
  `PUT /v1/tenants/:tenantId/send-policy` and
  `POST /v1/tenants/:tenantId/send-policy/review-decision`.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by fixing `GET /v1/agents` so it no longer falls back to
  `listAgents(undefined)` and enumerates every tenant's agents when the caller
  omits the optional `tenantId` query parameter; the route now defaults to the
  authenticated caller's own `tenantId` and still rejects explicit
  cross-tenant queries.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by making the remaining agent-policy and agent-task read/write
  surfaces re-load the target agent and enforce that its persisted `tenantId`
  matches the authenticated claims before honoring `agentId`, reducing the
  blast radius of any previously minted inconsistent agent-scoped bearer
  tokens.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by making `requireTenantScopedAccess()` reject agent-scoped tokens
  as well as mailbox-scoped tokens, so the billing and tenant-DID routes now
  align with the documented "tenant-scoped bearer token" requirement instead
  of allowing any agent-bound token with the same tenant claim to operate on
  tenant-level resources.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by moving `GET /v1/tenants/:tenantId/send-policy` onto the same
  tenant-scoped gate as billing and DID routes, so mailbox-scoped and
  agent-scoped tokens can no longer read tenant-wide outbound policy state by
  tenant ID alone.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by filtering `GET /v1/agents/:agentId/mailboxes` through the
  authenticated token's `mailboxIds` whenever the token is mailbox-scoped, so
  a mailbox-bound token with `agent:read` can no longer enumerate every other
  mailbox bound to the same agent.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by tightening `GET /v1/agents` so agent-scoped tokens now only see
  their bound agent record and pure mailbox-scoped tokens cannot enumerate the
  tenant agent registry at all, instead of returning every agent in the tenant
  whenever the caller held `agent:read`.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by filtering `GET /v1/agents/:agentId/deployments` through
  `mailboxIds` for mailbox-scoped tokens, so a mailbox-bound reader can no
  longer discover deployments targeting other mailboxes on the same agent.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by moving the agent control-plane surfaces onto an explicit
  non-mailbox gate: mailbox-scoped tokens can no longer read or mutate agent
  config, versions, deployments, or policy through the REST agent registry
  routes, and the MCP `create_agent` / `upsert_agent_policy` tools now enforce
  the same boundary.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by making agent deployment creation and rollout verify that any
  mailbox `targetId` actually exists and belongs to the submitted `tenantId`,
  closing a cross-tenant execution-target pollution path where a tenant-scoped
  provisioning token could previously create active mailbox deployments
  pointing at a foreign or nonexistent mailbox ID.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by validating `PATCH /v1/agents/:agentId defaultVersionId` against
  the same agent, preventing control-plane callers from pointing an agent at a
  foreign or nonexistent version record and leaving default execution-version
  state inconsistent.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by making `resolveAgentExecutionTarget()` fail closed on mailbox
  tenant ownership: runtime execution-target resolution now loads the mailbox
  first, rejects requested agents from other tenants, filters mailbox
  deployments by `tenant_id`, and skips stale mailbox bindings/deployments
  whose resolved agent does not belong to the mailbox tenant, so legacy
  cross-tenant execution metadata in D1 can no longer steer queue ingest,
  token reissue, or send/reply flows onto a foreign tenant's agent.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by moving mailbox-binding mutation onto the same non-mailbox
  control-plane gate as the other agent registry writes: both
  `POST /v1/agents/:agentId/mailboxes` and the MCP `bind_mailbox` tool now
  reject mailbox-scoped tokens, so bearer tokens that combine `agentId` with
  `mailboxIds` can no longer mutate agent mailbox bindings.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by making `/v1/auth/token/rotate` re-validate persisted ownership
  for any bound `agentId` and `mailboxIds` before minting a replacement token,
  so legacy cross-tenant or dangling bearer tokens can no longer extend their
  lifetime indefinitely by rotating the stale claims in place.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by aligning MCP tool discovery with the mailbox-scoped control
  plane boundary: `tools/list` now hides `create_agent`, `bind_mailbox`, and
  `upsert_agent_policy` whenever the token carries `mailboxIds`, so
  mailbox-scoped callers no longer see control-plane tools that later fail at
  invocation time.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by aligning MCP tool discovery with the agent-bound execution
  boundary: `tools/list` now hides the draft/send/task/reply tools that
  require `claims.agentId` whenever the caller is using a tenant-only or
  mailbox-only token, so discovery no longer advertises a large set of tools
  that would deterministically fail on `requireSelfAgentId()` or
  `enforceAgentAccess()`.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by making `POST /v1/agents/:agentId/drafts` verify that the agent
  is actually active for the target mailbox via binding or mailbox deployment
  before persisting the draft, aligning the REST route with the already
  hardened MCP `create_draft` flow so agent-scoped tokens can no longer create
  arbitrary cross-mailbox draft records inside the same tenant.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by making the REST self-mailbox surfaces re-load the token's bound
  `agentId` from persisted state before using it: `/v1/mailboxes/self`,
  `/v1/mailboxes/self/tasks`, `/v1/mailboxes/self/send`,
  `/v1/messages/send`, and `/v1/messages/:messageId/reply` now fail closed if
  the bound agent is missing or belongs to another tenant, instead of trusting
  stale embedded claims until a later code path happens to reject them.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by making token issuance and rotation validate agent-mailbox
  relationship consistency, not just tenant ownership: admin REST
  `POST /v1/auth/tokens`, admin MCP `create_access_token` /
  `bootstrap_mailbox_agent_token`, and `/v1/auth/token/rotate` now require any
  minted or rotated `agentId + mailboxIds` combination to be backed by an
  active mailbox binding or mailbox deployment for every mailbox, so the
  platform no longer signs same-tenant but semantically invalid mixed-scope
  bearer tokens.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by moving the shared self-serve token issuer onto the same
  persisted ownership and activation checks: `issueSelfServeAccessToken()`
  now verifies the target agent and mailbox both belong to the tenant and are
  actually linked by an active mailbox binding or mailbox deployment before
  minting a self-serve bearer token, so internal signup/reissue flows can no
  longer silently recreate an inconsistent mailbox-agent token if a caller
  passes mismatched IDs.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by applying operator-token delivery visibility filtering to whole
  thread reads as well as per-message reads: REST `GET /v1/threads/:threadId`
  and MCP `get_thread` now strip mailbox-scoped hidden token-reissue messages
  from `thread.messages`, and fail closed if that leaves the thread empty, so
  mailbox-scoped callers can no longer recover hidden operator token emails by
  reading the enclosing thread instead of the individual message.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by extending the same mailbox-scoped operator-token visibility
  rules to MCP message reads: `list_messages`, `get_message`, and
  `get_message_content` now hide `system:token_reissue_operator_email`
  deliveries from mailbox-scoped callers, closing the remaining MCP-side read
  bypass after the REST surfaces and MCP `get_thread` were tightened.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by making self mailbox agent resolution fail closed on mailbox
  activation, not just tenant ownership: the REST self-mailbox/send/reply
  routes and MCP `send_email` / `reply_to_message` / self-agent
  `create_draft` path now require the token's bound `agentId` to be actively
  linked to the mailbox via binding or mailbox deployment before proceeding,
  so stale mixed-scope bearer tokens can no longer keep operating after the
  agent-mailbox relationship has been removed.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by extending mailbox-scoped operator-token visibility enforcement
  to message replay: REST `POST /v1/messages/:messageId/replay` and MCP
  `replay_message` now reject hidden `system:token_reissue_operator_email`
  messages for mailbox-scoped callers, preventing replay-based access to
  operator token delivery emails after the read surfaces were already locked
  down.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by making draft access fail closed on current agent-mailbox
  activation: REST `GET /v1/drafts/:draftId`, `DELETE /v1/drafts/:draftId`,
  `POST /v1/drafts/:draftId/send`, and MCP `create_draft`, `get_draft`,
  `send_draft`, `cancel_draft` now require the draft's `agentId` to still be
  actively linked to the draft mailbox by binding or mailbox deployment, so
  stale mixed-scope bearer tokens can no longer keep reading, cancelling, or
  sending drafts after the mailbox-agent relationship has been removed.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by making agent task listing filter mailbox-scoped claims through
  current activation instead of trusting stale token mailbox IDs: REST
  `GET /v1/agents/:agentId/tasks` and MCP `list_agent_tasks` now keep only the
  token mailboxes that are still actively linked to the agent by binding or
  mailbox deployment, and fail closed when none remain.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by closing the remaining MCP draft-only creation paths that still
  trusted stale mixed-scope claims: `reply_to_inbound_email` when `send=false`
  and `operator_manual_send` when `send=false` now require the supplied
  `agentId` to be actively linked to the mailbox before persisting a draft,
  instead of accepting any same-tenant agent/mailbox pair that happened to
  satisfy the bearer token claims.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by extending hidden operator-token message visibility enforcement
  to reply workflows: REST `POST /v1/messages/:messageId/reply` and MCP
  `reply_to_inbound_email` / `reply_to_message` now reject mailbox-scoped
  replies against hidden `system:token_reissue_operator_email` messages and
  build reply references from the mailbox-scoped filtered thread view, so a
  caller can no longer reply to or indirectly reference hidden operator token
  delivery emails by ID.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by extending the same mailbox-scoped hidden-message filtering to
  manual draft reference inputs: REST `POST /v1/agents/:agentId/drafts` and
  MCP `create_draft` / `operator_manual_send` now reject `sourceMessageId` or
  `threadId` inputs that point at mailbox-scoped hidden operator token
  delivery messages/threads, so callers can no longer rebuild a reply draft
  around a hidden token email by manually supplying its IDs.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by making completed idempotency replays re-check current mailbox
  authorization before replaying a stored success response: REST
  `createAndSendDraft()`, MCP `createAndSendDraftForMcp()`, MCP
  `reply_to_inbound_email`, and MCP `operator_manual_send` now validate the
  current agent-mailbox relationship and hidden-message visibility before
  returning a previously completed result for the same `idempotencyKey`, so
  stale mixed-scope tokens cannot use old idempotency keys to recover send
  results after access has been removed.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by extending the same completed-idempotency fail-closed behavior to
  replay and existing-draft send surfaces: REST `POST /v1/messages/:messageId/replay`,
  MCP `replay_message`, REST `POST /v1/drafts/:draftId/send`, and MCP
  `send_draft` now re-run the current replay target / send authorization
  checks before returning a previously completed response for the same
  `idempotencyKey`, so removed agent-mailbox links, hidden mailbox-scoped
  messages, or newly invalid send conditions can no longer be bypassed by
  replaying an old successful request.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by closing stale-draft hidden-reference leakage for mailbox-scoped
  callers: REST `GET /v1/drafts/:draftId` and MCP `get_draft` now redact
  mailbox-scoped hidden `sourceMessageId` / `threadId` references from legacy
  drafts, while REST `POST /v1/drafts/:draftId/send` and MCP `send_draft`
  reject sending a draft whose stored references point at hidden operator
  token-delivery messages or threads, so old pre-hardening drafts can no
  longer be used as a side channel back to hidden token-email context.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by closing one remaining REST agent control-plane read surface for
  mailbox-scoped tokens: `GET /v1/agents/:agentId/mailboxes` now enforces the
  same mailbox-token prohibition as the rest of the agent control-plane, so a
  mailbox-scoped bearer can no longer enumerate mailbox binding metadata for
  an agent even when it already knows the `agentId`.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by closing the mixed-scope self-token bypass on REST agent listing:
  `GET /v1/agents` now rejects any mailbox-scoped token before considering the
  token's bound `agentId`, so self-serve mailbox tokens can no longer recover
  their bound agent's control-plane metadata through the list endpoint just
  because they also carry an `agentId` claim.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by making mailbox read surfaces fail closed on current
  agent-mailbox activation for mixed-scope self tokens: REST
  `GET /v1/mailboxes/self/messages`, `GET /v1/mailboxes/self/messages/:messageId`,
  `GET /v1/mailboxes/self/messages/:messageId/content`, `GET /v1/messages/:messageId`,
  `GET /v1/messages/:messageId/content`, `GET /v1/threads/:threadId`, and
  `POST /v1/messages/:messageId/replay` plus MCP `list_messages`,
  `get_message`, `get_message_content`, `get_thread`, and `replay_message`
  now re-check that a token carrying both `agentId` and `mailboxIds` is still
  bound to the mailbox by an active binding or mailbox deployment, so stale
  self-serve tokens cannot keep reading or replaying mailbox content after the
  underlying agent-mailbox relationship has been removed.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by making the site admin console's `admin_send` idempotency replay
  path re-check current mailbox, reference, policy, and credit constraints
  before replaying a stored success response, so an old `idempotencyKey` can
  no longer resurrect a now-invalid admin send after the underlying send
  conditions have changed.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by making legacy draft sends and outbound retries re-validate the
  stored `threadId` / `sourceMessageId` linkage before execution: the shared
  draft send guard, site admin outbound retry path, queue worker, REST
  `POST /v1/drafts/:draftId/send`, and MCP `send_draft` now require any stored
  draft references to still exist inside the same tenant/mailbox and still
  match each other, so pre-hardening or manually-corrupted drafts can no
  longer be used to attach outbound mail to a foreign thread or source
  message during later retries or sends.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by fixing a fail-open regression in the public token reissue flow:
  `/public/token/reissue` no longer turns into a silent no-op when the
  optional token-reissue rate-limit tables are missing, and now continues with
  the generic reissue attempt while still suppressing mailbox-existence
  disclosure, so environments without those tables do not accidentally disable
  self-serve token reissue entirely.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by aligning MCP send validation with the REST send path:
  `createAndSendDraftForMcp()` now rejects sends where both `text` and `html`
  are empty, so MCP `send_email`, send-enabled reply workflows, and
  `operator_manual_send` can no longer bypass the REST-side empty-body guard
  and emit blank outbound mail.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by fixing a site-admin message-content error classification bug:
  `GET /admin/api/messages/:messageId/content` now returns a real 404 when the
  message is missing instead of surfacing the repository's not-found exception
  as a generic 502, which keeps admin tooling and diagnostics aligned with the
  actual failure mode.
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by aligning additional site-admin message diagnostics with real
  message existence: `GET /admin/api/messages/:messageId/events` and
  `GET /admin/api/messages/:messageId/outbound-job` now also return 404 when
  the message itself is missing, instead of silently returning an empty event
  list or misclassifying the failure as "outbound job not found".
- 2026-03-28: additional hardening was applied beyond the original 1-50
  findings by aligning MCP draft `from` validation with the REST contract:
  MCP `create_draft`, `operator_manual_send`, and the shared
  `createAndSendDraftForMcp()` send helper now reject any request whose
  `from` address does not match the target mailbox address before creating a
  draft or reserving a send outcome, so MCP callers can no longer persist
  spoofed draft metadata or strand idempotent send workflows in a
  side-effected failure after draft creation.
