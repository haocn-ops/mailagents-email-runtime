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

## Additional Follow-up (2026-03-30)

1. Fixed: agent-targeted REST and MCP routes no longer require tenant-scoped
   provisioning tokens to carry a matching `agentId`. The runtime now enforces
   exact agent matching only when the bearer token is itself agent-scoped,
   aligning implementation with the documented "matching agent when the token
   is agent-scoped" rule while preserving tenant and mailbox boundary checks.
   Refs: `src/lib/auth.ts:146`, `src/routes/api.ts:2043`,
   `src/routes/mcp.ts:1292`, `src/routes/api.ts:4165`

2. Hardening: `/admin/api/send` now returns a partial-success `409` once draft
   state has already been created, instead of falling through as a generic
   `502`. This reduces accidental duplicate admin sends after enqueue or
   idempotency-record persistence failures.
   Refs: `src/routes/site.ts:1858`, `src/routes/site.ts:1988`,
   `src/routes/site.ts:2012`

3. Hardening: REST `POST /v1/drafts/:draftId/send` and MCP `send_draft` now
   re-validate the stored draft payload `from` address and attachment
   ownership before enqueue. Legacy malformed drafts now fail as explicit
   client errors instead of bubbling generic repository-layer `500`s during
   send.
   Refs: `src/routes/api.ts:387`, `src/routes/api.ts:405`,
   `src/routes/mcp.ts:286`, `src/routes/mcp.ts:304`

4. Hardening: admin console list endpoints now clamp `limit` consistently
   instead of accepting arbitrary numeric query values. This applies to admin
   message, outbound job, draft, and idempotency-record listings.
   Refs: `src/routes/site.ts:1486`, `src/routes/site.ts:1581`,
   `src/routes/site.ts:1796`, `src/routes/site.ts:2242`

5. Hardening: the shared draft-send guard used by queue delivery and admin
   outbound-job retry now also re-validates the stored draft payload `from`
   address plus attachment ownership and shape before any async send path can
   proceed. Legacy malformed drafts therefore fail as explicit client-facing
   validation errors instead of surfacing later as generic send or repository
   failures during retry execution.
   Refs: `src/lib/draft-send-guards.ts:24`, `src/lib/draft-send-guards.ts:63`,
   `src/handlers/queues.ts:552`, `src/routes/site.ts:1637`

6. Verified: free-tier quota bypass for unlocked tenants now applies even on
   internal-only sends. The current outbound-policy path derives
   `quotaBypassUnlocked` directly from tenant credits or enabled policy rather
   than gating it on the presence of external recipients.
   Refs: `src/lib/outbound-policy.ts:86`, `src/lib/outbound-policy.ts:94`,
   `src/lib/outbound-policy.ts:138`

7. Verified: tenant `internalDomainAllowlist` updates now resync default
   self-serve agent recipient policies when the allowlist changes, so the
   default per-agent policy no longer drifts from tenant send policy.
   Refs: `src/routes/api.ts:1196`,
   `src/lib/self-serve-agent-policy.ts:102`

8. Verified: the site-admin browser session cookie now stores a signed
   `site-admin` session token rather than the raw `ADMIN_API_SECRET`, and
   `/admin/api/*` responses are normalized to `private, no-store` headers.
   Refs: `src/routes/site.ts:2142`, `src/routes/site.ts:2197`,
   `src/routes/site.ts:2282`

9. Hardening: `enqueueDraftSend()` now rolls draft state back fully when any
   pre-enqueue validation or credit reservation step fails after the draft has
   been claimed for send. Previously, malformed legacy drafts or insufficient
   credits could leave the draft stuck in `queued` with a speculative
   thread assignment even though no outbound job was created.
   Refs: `src/repositories/mail.ts:792`, `src/repositories/mail.ts:1124`

10. Verified: reply-thread fallback no longer relies solely on
    `messages.to_addr`; when outbound history came from a stored draft, the
    fallback recipient matcher now supplements recipients from the draft
    payload's `to`, `cc`, and `bcc` fields.
    Refs: `src/repositories/mail.ts:750`, `src/repositories/mail.ts:873`

11. Verified: subject normalization now strips repeated `Re:`, `Fwd:`, and
    `Fw:` prefixes instead of only one layer, improving thread matching for
    longer reply/forward chains.
    Refs: `src/lib/email-parser.ts:183`

12. Verified: tenant billing and DID routes now reject mailbox- or
    agent-scoped tokens by enforcing tenant-scoped access, and site-admin
    cookie-authenticated write actions now require same-origin requests.
    Refs: `src/routes/api.ts:876`, `src/routes/api.ts:1031`,
    `src/routes/api.ts:1369`, `src/routes/site.ts:2275`

13. Hardening: draft-send rollback now also deletes any brand-new outbound
    thread created speculatively for the failed enqueue attempt, as long as no
    draft or message still references it. This prevents malformed drafts or
    failed pre-enqueue checks from accumulating orphan thread rows.
    Refs: `src/repositories/mail.ts:809`, `src/repositories/mail.ts:1197`

14. Hardening: inbound email normalization now cleans up newly written R2
    blobs when later persistence fails. If normalized message state cannot be
    committed, the fresh normalized JSON blob is deleted; if attachment-row
    persistence fails, the just-uploaded attachment blobs are deleted; and
    stale superseded attachment blobs are now deleted immediately after a
    successful row swap instead of waiting until the end of the ingest path.
    Refs: `src/handlers/queues.ts:181`, `src/handlers/queues.ts:195`,
    `src/handlers/queues.ts:212`, `src/handlers/queues.ts:230`

15. Hardening: review-escalation trace creation now rolls back its persistence
    artifacts if the later `agent_runs` insert or task status update fails.
    This prevents `recordTaskNeedsReview()` from leaving orphan trace blobs or
    half-written run rows behind when the queue fallback path itself hits a D1
    error.
    Refs: `src/handlers/queues.ts:109`, `src/handlers/queues.ts:130`,
    `src/handlers/queues.ts:151`

16. Hardening: agent creation and agent-version creation now clean up newly
    written config/manifest R2 blobs if later D1 inserts fail, and
    `createAgentVersion()` also removes any partially inserted capability/tool
    rows during rollback. This prevents orphan agent artifacts from surviving
    failed create flows.
    Refs: `src/repositories/agents.ts:262`, `src/repositories/agents.ts:266`,
    `src/repositories/agents.ts:421`, `src/repositories/agents.ts:475`

17. Hardening: the SES webhook path now defers writing the raw event payload
    blob until after message/tag consistency checks pass, and it deletes that
    blob if the `delivery_events` row insert fails. This prevents mismatch
    rejections or insert errors from leaving orphan webhook payload objects in
    R2.
    Refs: `src/routes/api.ts:3420`, `src/routes/api.ts:3442`,
    `src/routes/api.ts:3447`

18. Hardening: `updateAgent()` no longer overwrites the existing config blob
    in place before the SQL update commits. Config updates now write a fresh
    R2 object, switch the database pointer atomically, delete that fresh blob
    on SQL failure, and only then best-effort delete the superseded prior
    config blob. This prevents failed agent updates from silently mutating live
    config content.
    Refs: `src/repositories/agents.ts:321`, `src/repositories/agents.ts:337`,
    `src/repositories/agents.ts:344`, `src/repositories/agents.ts:367`

19. Hardening: orphan thread cleanup now also covers inbound normalization and
    reply-thread fallback attachment paths. If a newly created thread cannot be
    attached to a message because the later message update fails, the runtime
    now deletes that thread when it remains unreferenced.
    Refs: `src/repositories/mail.ts:809`, `src/repositories/mail.ts:929`,
    `src/handlers/queues.ts:204`

20. Hardening: idempotent replay/send flows now consistently mark
    queue-enqueued work as partial-success if `completeIdempotencyKey()`
    fails after the replay or draft-send job has already been accepted. This
    now covers REST `message_replay` and idempotent draft-send plus the MCP
    `reply_to_inbound_email`, `operator_manual_send`, `send_draft`, and
    `replay_message` tools, which previously could surface a generic internal
    error after side effects had already been committed.
    Refs: `src/routes/api.ts:2986`, `src/routes/api.ts:3358`,
    `src/routes/mcp.ts:1609`, `src/routes/mcp.ts:1813`,
    `src/routes/mcp.ts:2260`, `src/routes/mcp.ts:2438`,
    `src/routes/mcp.ts:2612`

21. Hardening: self-serve signup rollback now deletes tenant-scoped mail blobs
    and review traces in addition to agent config artifacts. If onboarding
    fails after partial mailbox/message creation, cleanup now removes raw and
    normalized message blobs, draft payloads, attachment objects, SES webhook
    payloads, task result blobs, and `agent_runs` trace artifacts instead of
    leaving those objects orphaned in R2 or D1.
    Refs: `src/lib/provisioning/signup.ts:357`,
    `src/lib/provisioning/signup.ts:367`,
    `src/lib/provisioning/signup.ts:478`

22. Hardening: site-admin idempotent `/admin/api/send` recovery now stores the
    accepted outbound job id on the still-pending idempotency row before the
    completion record is finalized. If `completeIdempotencyKey()` fails after
    queue acceptance, a same-key retry can now restore the queued send result
    instead of staying stuck on an unrecoverable generic "in progress"
    response until background idempotency cleanup deletes the row.
    Refs: `src/repositories/mail.ts:1412`, `src/routes/site.ts:1923`,
    `src/routes/site.ts:1955`, `src/routes/site.ts:2004`

23. Hardening: the same recoverable-pending idempotency pattern now also
    covers REST and MCP draft-send flows. Shared create-and-send helpers plus
    direct `send_draft` routes now persist the committed draft or outbound job
    id onto the pending idempotency row before final completion, allowing a
    same-key retry to restore the already-queued send result instead of being
    trapped behind a stale `pending` response after a late completion-write
    failure.
    Refs: `src/routes/api.ts:3331`, `src/routes/api.ts:4015`,
    `src/routes/mcp.ts:1251`, `src/routes/mcp.ts:1527`,
    `src/routes/mcp.ts:1722`, `src/routes/mcp.ts:2214`

24. Hardening: admin contact-alias creation/bootstrap now rolls back a
    just-created local mailbox row if the later Cloudflare Email Routing
    upsert fails. Previously, `/admin/api/contact-aliases` could leave
    half-configured aliases in D1 that appeared provisioned locally even
    though no worker routing rule was actually created upstream.
    Refs: `src/repositories/agents.ts:1243`, `src/repositories/agents.ts:1304`,
    `src/routes/site.ts:1381`, `src/routes/site.ts:1434`

25. Hardening: contact-alias deletion now disables the local mailbox in
    addition to removing the explicit routing rule, and later admin/bootstrap
    provisioning re-activates the mailbox when recreating the alias. This
    closes the gap where a "deleted" alias could still accept mail through a
    catch-all worker route, and it prevents recreated aliases from remaining
    silently inactive in D1.
    Refs: `src/repositories/agents.ts:1304`, `src/repositories/agents.ts:1325`,
    `src/routes/site.ts:1380`, `src/routes/site.ts:1490`,
    `src/lib/contact-aliases.ts:31`

26. Hardening: `public/token/reissue` no longer fails with a late server error
    after the operator-email reissue message has already been queued. If the
    post-send cooldown log insert fails, the endpoint now records an internal
    error but still returns the same generic accepted response instead of
    surfacing a misleading failure after side effects were already committed.
    Refs: `src/routes/api.ts:774`, `src/routes/api.ts:796`,
    `src/repositories/token-reissue.ts:52`

27. Hardening: admin contact-alias creation is now restricted to the fixed
    public aliases that the dashboard and site actually manage:
    `hello`, `security`, `privacy`, and `dmarc`. This prevents the control
    plane from creating hidden worker-routed aliases that never appeared in
    the alias list or public-site configuration flows.
    Refs: `src/routes/site.ts:1358`, `src/routes/site.ts:1372`,
    `src/routes/site.ts:4793`, `src/routes/site.ts:5202`

28. Hardening: automatic x402 settlement paths now retry once against the
    freshly reloaded receipt when the first settlement/finalization attempt
    fails after mutating local receipt state. This lets topup, upgrade-intent,
    and receipt-confirm requests recover within the same call when the first
    pass already advanced the receipt or ledger locally before a later write
    failed.
    Refs: `src/routes/api.ts:966`, `src/routes/api.ts:1078`,
    `src/routes/api.ts:1355`, `src/routes/api.ts:4529`

29. Hardening: contact-alias deletion now refuses manual removal when managed
    bootstrap maintenance is enabled, and alias-delete rollback restores the
    mailbox status if the later Cloudflare rule deletion fails. This prevents
    a misleading "deleted" control-plane action that would be auto-recreated
    on the next request, and it avoids leaving the local mailbox disabled when
    upstream rule deletion errors out.
    Refs: `src/index.ts:22`, `src/routes/site.ts:1298`,
    `src/routes/site.ts:1480`, `src/routes/site.ts:6070`

30. Hardening: idempotent `message_replay` now uses the same recoverable
    pending pattern as draft-send. Once normalize/rerun replay has already
    been queued, the pending idempotency row is marked with committed state so
    a same-key retry returns the accepted replay result instead of remaining
    stuck on a stale `pending` response after a late completion-write failure.
    Refs: `src/routes/api.ts:2973`, `src/routes/api.ts:3017`,
    `src/routes/mcp.ts:2424`, `src/routes/mcp.ts:2480`

31. Hardening: `/admin/api/contact-aliases/bootstrap` now rehydrates the local
    mailbox even when `overwrite=false` and the Cloudflare routing rule already
    exists. Previously this path skipped immediately on existing rules, so a
    drifted or inactive local alias mailbox could remain broken while the
    dashboard still reported the alias as already configured upstream.
    Refs: `src/routes/site.ts:1443`, `src/routes/site.ts:1457`,
    `src/handlers/email.ts:58`

32. Hardening: admin alias inspection now reports the local mailbox state for
    each contact alias instead of only showing upstream Cloudflare rule state.
    This makes drift visible when a routing rule still exists but the worker
    would reject mail because the corresponding local mailbox is missing or
    inactive.
    Refs: `src/routes/site.ts:1323`, `src/routes/site.ts:6079`,
    `src/handlers/email.ts:58`

33. Hardening: sensitive system-send failures now best-effort delete the
    underlying draft when enqueue never committed an outbound job. Token
    reissue and signup welcome flows previously could leave unsent drafts whose
    bodies still contained live access tokens after `createDraft()` succeeded
    but `enqueueDraftSend()` failed; those drafts are now scrubbed unless a
    queued job already references the same draft blob, and the cleanup is
    restricted to pre-send `draft`/`approved` rows so it cannot race into
    deleting a draft that has already been claimed as `queued`.
    Refs: `src/repositories/mail.ts:1122`, `src/routes/api.ts:3775`,
    `src/routes/api.ts:4203`, `src/lib/provisioning/signup.ts:257`

34. Hardening: idempotency persistence now fails closed if the reservation row
    is no longer pending when committed resource IDs or final completed
    responses are written back. Previously `updateIdempotencyKeyResource()`
    and `completeIdempotencyKey()` treated `UPDATE 0 rows` as success, which
    could silently lose the recovery record after row drift or premature
    cleanup and reopen duplicate execution windows on the next retry.
    Refs: `src/repositories/mail.ts:1441`, `src/repositories/mail.ts:1468`

35. Hardening: idempotent pending replay/admin-send recovery now re-runs the
    same current authorization and validation gates as completed replay
    recovery before returning a stored accepted result. This aligns
    `pending + resourceId` behavior with the already fail-closed completed
    branches, so stale keys can no longer recover queued replay/admin-send
    results after current access or send conditions have become invalid.
    Refs: `src/routes/api.ts:2991`, `src/routes/mcp.ts:2443`,
    `src/routes/site.ts:2036`

36. Hardening: admin `manual-resolution` now updates the outbound job's final
    status only after the associated message/draft state has been reconciled.
    Previously the route could clear the job's `uncertain` marker first and
    then fail while updating the message or draft, leaving the operator unable
    to retry the same manual resolution even though local state was only
    partially repaired; the route now also requires the job to still be in
    `failed` status before accepting manual resolution.
    Refs: `src/routes/site.ts:1809`, `src/routes/site.ts:1831`,
    `src/routes/site.ts:1852`

37. Hardening: payment auto-settlement same-request recovery now also retries
    when a credit-ledger entry was committed but the receipt row itself had not
    changed yet. Previously a topup or upgrade could append its durable ledger
    settlement record and then fail before refreshing the receipt, causing the
    in-request retry helper to miss the partial commit and return a generic
    error instead of converging through the existing-ledger replay path.
    Refs: `src/routes/api.ts:4581`

38. Hardening: SES webhook handling now backfills `provider_message_id` and
    `sent_at` when a terminal event locates the outbound message only through
    signed mail tags after provider-acceptance persistence had failed locally.
    Previously those messages could keep processing events via the tag path
    while remaining permanently detached from their provider message id for
    later lookups and diagnostics. Delivery-event persistence is now also
    deduplicated by a deterministic SES payload key so webhook retries after a
    later local-state failure do not keep appending duplicate delivery events.
    Refs: `src/repositories/mail.ts:1919`, `src/repositories/mail.ts:1991`,
    `src/routes/api.ts:206`, `src/routes/api.ts:3510`

39. Hardening: admin outbound retry now rolls back the whole requeue transition
    if any local state update fails before the queue send completes. Previously
    only `OUTBOUND_SEND_QUEUE.send()` was covered by rollback, so a mid-flight
    failure after credits were re-reserved could leave the job marked `queued`
    without a real queue item and with message/draft state only partially
    updated; the route now also rejects orphaned outbound jobs whose message
    row is already missing instead of requeueing them into a guaranteed worker
    failure, and it snapshots draft recipients before retry so rollback can
    still release reserved credits even if the draft blob becomes unreadable
    mid-failure.
    Refs: `src/routes/site.ts:1713`, `src/routes/site.ts:1738`,
    `src/routes/site.ts:1747`

40. Hardening: resurrecting a previously failed task back to `queued` now also
    clears the stale `result_r2_key`. Previously `getOrCreateTaskForSourceMessage()`
    reused the old failure trace while changing the task status back to queued,
    leaving task inspection with a misleading pointer to obsolete review/output
    data from the prior failed run.
    Refs: `src/repositories/mail.ts:1816`

41. Hardening: outbound worker recovery for stuck `sending` jobs now updates
    the message state before finalizing the job status in both recovered-sent
    and recovered-failed branches. Previously these paths could leave
    `messages.status` stuck at `tasked` even after provider evidence or
    terminal delivery events had already promoted the job to `sent`/`failed`.
    The worker now also isolates local recovery-write failures from the outer
    send-attempt error handler, so already-evidenced sends are retried only for
    local state convergence instead of being downgraded into generic
    `retry`/`failed` resend paths, and duplicate/late queue deliveries for an
    already-`sent` job now self-heal any stale message/draft terminal state
    before settling billing.
    Refs: `src/handlers/queues.ts:407`, `src/handlers/queues.ts:450`

42. Hardening: `updateTaskStatus()` now honors explicit `null` for
    `resultR2Key` instead of silently preserving the old trace via `COALESCE`.
    This aligns the repository helper with its type contract
    (`string | null | undefined`) and prevents future task-status transitions
    from accidentally retaining stale trace pointers when a caller intends to
    clear them.
    Refs: `src/repositories/mail.ts:1902`

43. Hardening: the `agent-execute` worker's final catch path now explicitly
    clears `resultR2Key` when downgrading a task to `needs_review`. This keeps
    the emergency fallback from inheriting any stale prior trace pointer if a
    queued task reaches the catch path before a fresh review trace can be
    recorded.
    Refs: `src/handlers/queues.ts:369`

44. Hardening: core outbound/message state-update helpers now fail closed when
    their target row has disappeared instead of treating `UPDATE 0 rows` as a
    successful state convergence. Previously `backfillMessageProviderAcceptance()`,
    `updateMessageStatus()`, `updateOutboundJobStatus()`, `markDraftStatus()`,
    and `markMessageSent()` could silently no-op after local drift or partial
    cleanup, allowing queue/webhook/admin recovery paths to keep advancing as
    if message, draft, or outbound-job state had been repaired when the target
    record was actually gone.
    Refs: `src/repositories/mail.ts:1997`, `src/repositories/mail.ts:2003`,
    `src/repositories/mail.ts:2022`, `src/repositories/mail.ts:2075`,
    `src/repositories/mail.ts:2114`, `src/repositories/mail.ts:2122`

45. Hardening: deployment activation/rollout/rollback transitions now also
    fail closed if any targeted `agent_deployments` row disappears mid-flight.
    Previously the internal `setDeploymentStatus()` helpers treated `UPDATE 0
    rows` as success, so a concurrently deleted deployment could let a
    multi-step transition continue and persist a partially applied deployment
    topology while the repository layer still reported success.
    Refs: `src/repositories/agents.ts:634`, `src/repositories/agents.ts:657`,
    `src/repositories/agents.ts:680`

46. Hardening: `updateAgent()` now also fails closed when the target agent row
    disappears after the current config has already been read or a fresh config
    blob has been uploaded. Previously an `UPDATE 0 rows` race could fall
    through as if the write had succeeded, leaving the newly uploaded config
    blob orphaned and even deleting the still-current prior blob before the
    final reload noticed the agent was gone.
    Refs: `src/repositories/agents.ts:321`, `src/repositories/agents.ts:344`,
    `src/repositories/agents.ts:364`

47. Hardening: inbound normalization now fails closed if the target message row
    or selected thread row disappears before the normalized state is attached.
    `updateInboundMessageNormalized()` now requires the destination thread to
    still exist at write time, and `updateThreadTimestamp()` no longer treats
    `UPDATE 0 rows` as success. This prevents ingest from silently pointing a
    message at a vanished thread or continuing after thread/message drift as if
    normalization had committed cleanly.
    Refs: `src/repositories/mail.ts:1596`, `src/repositories/mail.ts:1606`,
    `src/repositories/mail.ts:1632`

48. Hardening: `updateTenantBillingAccountProfile()` no longer falls back to
    `ensureTenantBillingAccount()` after the update write. Previously, if the
    billing-account row disappeared between the initial ensure and the later
    update/readback, the helper could silently recreate a fresh default
    `trial/free` account and return that instead of surfacing the lost update.
    The repository now fails closed on `UPDATE 0 rows` and reloads the actual
    updated row directly.
    Refs: `src/repositories/billing.ts:170`, `src/repositories/billing.ts:184`,
    `src/repositories/billing.ts:209`

49. Hardening: tenant credit-account mutation helpers now also stop using
    `ensureTenantBillingAccount()` as their post-update read path. Previously
    `reconcileTenantAvailableCredits()`, `reserveTenantAvailableCredits()`,
    `releaseTenantReservedCredits()`, `captureTenantReservedCredits()`, and
    `decrementTenantAvailableCredits()` could recreate a brand-new default
    billing account if the original row disappeared after a successful balance
    update, masking lost state and returning balances that no longer reflected
    the just-applied mutation.
    Refs: `src/repositories/billing.ts:519`, `src/repositories/billing.ts:550`,
    `src/repositories/billing.ts:577`, `src/repositories/billing.ts:604`,
    `src/repositories/billing.ts:629`

50. Hardening: idempotent create-and-send flows no longer get stuck on a
    permanently `pending` draft-send reservation after `createDraft()`
    succeeded but `enqueueDraftSend()` failed. REST and MCP now persist the new
    `draft.id` onto the pending idempotency row immediately after draft
    creation, and same-key recovery will resume enqueue from that stored draft
    when no outbound job exists yet. Previously the runtime returned a
    partial-success error that advised retrying with the same key, but that key
    could not recover because the reservation still had no resource pointer.
    Refs: `src/routes/api.ts:249`, `src/routes/api.ts:4125`,
    `src/routes/mcp.ts:146`, `src/routes/mcp.ts:1294`

51. Hardening: site-admin idempotent `/admin/api/send` now follows the same
    draft-first recovery pattern. The route now records the new `draft.id`
    before enqueue, and replay recovery can resume from either a stored draft
    id or a stored outbound-job id. Previously, if draft creation succeeded but
    enqueue failed, the endpoint returned a partial-success conflict that
    advised retrying with the same key, yet that key remained stuck on a
    `pending` reservation with no recoverable resource pointer.
    Refs: `src/routes/site.ts:1077`, `src/routes/site.ts:2096`,
    `src/routes/site.ts:2117`

52. Hardening: successful `pending + resourceId` idempotency recovery now also
    best-effort repairs the reservation row back to `completed` instead of
    returning a restored result while leaving the key permanently pending. This
    now covers REST replay/draft-send/create-and-send, MCP replay/draft-send
    and send workflows, plus site-admin send recovery. Previously the same-key
    retry could restore the already committed work but every later retry still
    hit the expensive recovery path until background cleanup eventually deleted
    the stale pending row.
    Refs: `src/routes/api.ts:208`, `src/routes/api.ts:3030`,
    `src/routes/api.ts:3416`, `src/routes/api.ts:4138`,
    `src/routes/mcp.ts:109`, `src/routes/mcp.ts:1292`,
    `src/routes/mcp.ts:1592`, `src/routes/mcp.ts:1827`,
    `src/routes/mcp.ts:2317`, `src/routes/mcp.ts:2505`,
    `src/routes/site.ts:280`, `src/routes/site.ts:2081`

53. Hardening: draft/message thread-link helpers now fail closed if either the
    target row or destination thread row disappears before the relationship is
    written. `assignDraftThreadId()`, `restoreDraftSendState()`, and
    `assignMessageThreadId()` previously treated `UPDATE 0 rows` as success,
    which could let outbound enqueue rollback or reply-thread reconciliation
    continue after local drift as if the draft/message had been attached back to
    a valid thread when no such link was actually persisted.
    Refs: `src/repositories/mail.ts:780`, `src/repositories/mail.ts:800`,
    `src/repositories/mail.ts:842`

54. Hardening: task assignment/status mutation helpers now also fail closed
    when the target task row disappears. `updateTaskAssignment()` and
    `updateTaskStatus()` previously treated `UPDATE 0 rows` as success, which
    could let agent-execute recovery and review-escalation paths proceed as if
    a task had been reassigned or downgraded to `needs_review` even after the
    task itself had already been deleted concurrently.
    Refs: `src/repositories/mail.ts:1925`, `src/repositories/mail.ts:1942`

55. Hardening: control-plane writes that create or upsert agent-scoped child
    records now clean up after concurrent parent deletion. `bindMailbox()` now
    removes a freshly inserted `agent_mailboxes` row if the agent or mailbox is
    gone by post-write verification, and `upsertAgentPolicy()` now deletes the
    just-written policy row and fails if the parent agent disappeared during the
    write. This prevents orphan mailbox bindings or policy rows from surviving a
    race against agent/mailbox deletion.
    Refs: `src/repositories/agents.ts:1105`, `src/repositories/agents.ts:1149`,
    `src/repositories/agents.ts:1181`, `src/repositories/agents.ts:1211`

56. Hardening: agent creation and agent-version creation now also clean up
    freshly written config/manifest artifacts if the final read-back step fails
    after inserts already succeeded. Previously a concurrent delete between the
    insert and final `getAgent()` / `getAgentVersion()` could surface as a load
    failure while leaving the new config blob, manifest blob, or capability/tool
    rows orphaned.
    Refs: `src/repositories/agents.ts:250`, `src/repositories/agents.ts:289`,
    `src/repositories/agents.ts:425`, `src/repositories/agents.ts:518`

57. Hardening: `createAgentDeployment()` now performs post-write existence
    verification for the parent agent, agent version, and mailbox target (for
    mailbox deployments), and it deletes the fresh deployment row if any of
    those resources disappeared concurrently. Previously a deployment insert
    could succeed against stale prevalidation and leave an orphaned active or
    paused deployment row behind even though the target resources were already
    gone by the time the repository returned.
    Refs: `src/repositories/agents.ts:566`, `src/repositories/agents.ts:604`

58. Hardening: `createDraft()` now also verifies that the referenced agent,
    mailbox, optional thread, and optional source message still exist after the
    draft row is inserted, and it cleans up both the draft row and draft blob if
    that finalization check fails. Previously a concurrent delete after outer
    route validation could leave orphan draft state behind, and a final read-back
    failure only deleted the blob on insert errors, not after the row had
    already been written.
    Refs: `src/repositories/mail.ts:972`, `src/repositories/mail.ts:1037`,
    `src/repositories/mail.ts:1074`

59. Hardening: task creation paths now also verify that the mailbox, source
    message, and optional assigned agent still exist after a new task row is
    inserted. This applies to both `createTask()` and the new-row branch of
    `getOrCreateTaskForSourceMessage()`. Previously a concurrent delete after
    outer replay/ingest validation could leave orphan tasks behind even though
    their source message or mailbox had already disappeared before the
    repository returned.
    Refs: `src/repositories/mail.ts:1803`, `src/repositories/mail.ts:1843`,
    `src/repositories/mail.ts:1910`

60. Hardening: attachment persistence during inbound normalization now also
    verifies that the owning message still exists before and after swapping the
    attachment rows. Previously `insertAttachments()` could delete the prior
    attachment set and insert a fresh one even after the parent message had been
    concurrently removed, leaving orphan attachment rows for a vanished message.
    Refs: `src/repositories/mail.ts:1720`, `src/repositories/mail.ts:1730`,
    `src/repositories/mail.ts:1788`

61. Hardening: `ensureMailboxWithStatus()` now performs a final read-back when
    it creates a new mailbox instead of returning a speculative object directly
    from the insert inputs. Previously a concurrently deleted mailbox row could
    still be reported back to callers as successfully created even though it no
    longer existed by the time control returned to the route.
    Refs: `src/repositories/agents.ts:1309`, `src/repositories/agents.ts:1358`

62. Hardening: inbound message creation now performs a final mailbox-existence
    check after inserting the new `messages` row and removes that row again if
    the mailbox disappeared concurrently. Previously `createInboundMessage()`
    could report success and leave an orphan inbound message row behind even
    though the owning mailbox had already been deleted in the short window after
    raw email persistence and route-level mailbox validation.
    Refs: `src/repositories/mail.ts:358`, `src/repositories/mail.ts:372`,
    `src/repositories/mail.ts:414`

63. Hardening: `createTypedTenantPaymentReceipt()` now removes the newly created
    receipt row if the follow-up typed parse fails or the persisted metadata's
    `receiptType` does not match the requested typed helper. Previously this
    helper could throw while still leaving behind a malformed or mismatched
    payment-receipt row for later settlement/replay code to trip over.
    Refs: `src/repositories/billing.ts:445`, `src/repositories/billing.ts:449`

64. Hardening: typed credit-ledger append helpers now remove a freshly inserted
    ledger row if the subsequent typed lookup/parse fails. This applies to
    topup settlement, upgrade credit grant, and outbound usage ledger writes.
    Previously these helpers could throw while still leaving behind a brand-new
    ledger row whose metadata no longer parsed as the expected typed shape.
    Refs: `src/repositories/billing.ts:698`, `src/repositories/billing.ts:739`,
    `src/repositories/billing.ts:780`

65. Hardening: the failed-task reuse branch in
    `getOrCreateTaskForSourceMessage()` now also fails closed if the stale task
    row disappears before it can be reset back to queued. Previously that raw
    `UPDATE tasks ... WHERE id = ?` ignored `0 rows`, so a concurrently deleted
    failed task could still be returned to callers as if it had been
    successfully resurrected for replay or agent execution.
    Refs: `src/repositories/mail.ts:1988`, `src/repositories/mail.ts:1996`

66. Hardening: typed payment-receipt status updates now fail closed on `UPDATE
    0 rows`, and `updateTypedTenantPaymentReceiptStatus()` now best-effort
    restores the previous receipt snapshot if the post-update typed parse
    fails. Previously the helper could overwrite a receipt with malformed
    merged metadata, throw during typed re-parse, and leave the now-invalid row
    behind for later billing or settlement paths to trip over.
    Refs: `src/repositories/billing.ts:458`, `src/repositories/billing.ts:511`,
    `src/repositories/billing.ts:535`

67. Hardening: `updateMailboxStatus()` now fails closed if the mailbox row
    disappears during the status flip instead of returning `null` after an
    `UPDATE 0 rows` no-op. This closes a remaining repository-level silent
    failure where alias bootstrap and admin alias-management flows could keep
    reverting or deactivating mailboxes as if the status change had applied
    even though the mailbox had already been deleted concurrently.
    Refs: `src/repositories/agents.ts:1388`, `src/routes/site.ts:1437`,
    `src/routes/site.ts:1493`, `src/lib/contact-aliases.ts:45`

68. Hardening: suppression upsert during SES bounce/complaint handling no
    longer treats a raced-away existing row as a successful update. The
    `addSuppression()` helper now only returns success from its update branch
    when the `UPDATE` actually changed a row, allowing the caller to fall back
    to insert/retry if the previously selected suppression was deleted in the
    short gap before the write. Previously that race could silently skip
    persisting the suppression altogether and allow later outbound sends to a
    bounced or complained-about recipient.
    Refs: `src/repositories/mail.ts:2216`, `src/repositories/mail.ts:2234`,
    `src/routes/api.ts:3627`

69. Hardening: `getOrCreateThread()` no longer returns a speculative success
    object immediately after inserting a new thread row. New thread creation
    now verifies that the parent mailbox still exists, deletes the fresh thread
    if that mailbox disappeared concurrently, and performs a final read-back
    before returning. Previously inbound normalization and outbound draft-send
    thread creation could continue with an orphaned or already-deleted thread
    id after a post-insert mailbox/thread race.
    Refs: `src/repositories/mail.ts:652`, `src/repositories/mail.ts:729`,
    `src/handlers/queues.ts:183`, `src/repositories/mail.ts:1335`

70. Hardening: `bindMailbox()` now also performs a final read-back before
    returning a newly inserted binding instead of synthesizing a success object
    from the insert inputs. The helper already cleaned up if the parent agent
    or mailbox disappeared; with this change it also fails closed if the fresh
    `agent_mailboxes` row itself vanishes before control returns, preventing
    API, MCP, or signup flows from reporting a mailbox binding that no longer
    exists.
    Refs: `src/repositories/agents.ts:1143`, `src/repositories/agents.ts:1196`,
    `src/routes/api.ts:2668`, `src/lib/provisioning/signup.ts:188`

71. Hardening: task creation helpers now also perform a final read-back before
    returning a just-inserted or freshly reset task row. This now covers
    `createTask()` plus both the new-row and failed-task-reset branches of
    `getOrCreateTaskForSourceMessage()`. Previously these paths could still
    hand callers a synthesized queued task object after the row had already
    disappeared again, even though parent-existence cleanup and `UPDATE 0
    rows` checks had already been tightened.
    Refs: `src/repositories/mail.ts:1901`, `src/repositories/mail.ts:1938`,
    `src/repositories/mail.ts:1943`, `src/repositories/mail.ts:2018`

72. Hardening: `enqueueDraftSend()` now verifies that the freshly inserted
    outbound `messages` row and `outbound_jobs` row can still be read back
    before the queue send is committed. Previously a concurrent delete in the
    short gap after insert could still leave the helper enqueueing work and
    returning success for a vanished outbound job or message, pushing the later
    worker failure onto an already-accepted send request.
    Refs: `src/repositories/mail.ts:1297`, `src/repositories/mail.ts:1434`,
    `src/repositories/mail.ts:1438`

73. Hardening: inbound message creation now also confirms that the newly
    inserted `messages` row itself can still be read back during finalization,
    not just that the parent mailbox still exists. Previously `createInboundMessage()`
    could return success after a concurrent delete removed the fresh inbound
    row, causing `handleEmail()` to keep the raw email object and queue a
    normalize job for a message id that no longer existed.
    Refs: `src/repositories/mail.ts:372`, `src/repositories/mail.ts:390`,
    `src/handlers/email.ts:92`

74. Hardening: thread-link mutation helpers now require the destination thread
    to still belong to an existing mailbox that matches the draft/message being
    updated, and thread timestamp refresh now also fails closed if the thread's
    mailbox has disappeared. This tightens `assignDraftThreadId()`,
    `restoreDraftSendState()`, `assignMessageThreadId()`,
    `updateInboundMessageNormalized()`, and `updateThreadTimestamp()` so
    inbound normalization, reply reconciliation, and draft-send rollback can no
    longer silently attach state to an orphaned thread row whose mailbox was
    deleted concurrently.
    Refs: `src/repositories/mail.ts:827`, `src/repositories/mail.ts:850`,
    `src/repositories/mail.ts:893`, `src/repositories/mail.ts:1740`,
    `src/repositories/mail.ts:1779`

75. Hardening: idempotent queued-send recovery now also requires the outbound
    `messages` row to still exist before replaying a stored queued result. This
    covers REST `restoreDraftSendReplay()` / `restoreEnqueuedDraftSend()`, MCP
    `restoreDraftSendReplay()` / `restoreEnqueuedDraftSend()`, and site-admin
    `restoreAdminSendReplay()`. Previously these helpers could return a queued
    success response as long as the draft and outbound-job rows were still
    present, even if the underlying outbound message had already disappeared
    and the later worker run was guaranteed to fail.
    Refs: `src/routes/api.ts:263`, `src/routes/api.ts:299`,
    `src/routes/mcp.ts:160`, `src/routes/mcp.ts:196`,
    `src/routes/site.ts:1092`

76. Hardening: normalize replay now verifies that the referenced raw email
    object still exists in R2 before returning an accepted replay response or
    enqueuing the ingest job. This covers both REST `POST /v1/messages/:id/replay`
    and the MCP replay tool. Previously these paths only checked `rawR2Key`
    was populated on the message row, so a message whose raw `.eml` object had
    already been deleted could still be replayed as accepted even though the
    worker would deterministically fail on "Raw email object not found".
    Refs: `src/routes/api.ts:2992`, `src/routes/api.ts:2998`,
    `src/routes/mcp.ts:2473`, `src/routes/mcp.ts:2479`

77. Hardening: thread reads and thread lookup/reuse now ignore orphan thread
    rows whose mailbox has already been deleted. `getThread()` no longer returns
    those rows, and the existing/concurrent branches of `getOrCreateThread()`
    now only reuse threads whose parent mailbox still exists. Previously stale
    orphan threads could still be surfaced to read/reply flows or reused during
    new inbound/outbound thread resolution even though later write paths would
    fail closed against the missing mailbox.
    Refs: `src/repositories/mail.ts:596`, `src/repositories/mail.ts:661`,
    `src/routes/api.ts:3156`, `src/routes/mcp.ts:2019`

78. Hardening: mailbox-binding reads now ignore orphan `agent_mailboxes` rows
    whose mailbox has already been deleted. This tightens
    `hasActiveMailboxBinding()`, `getAgentMailboxBinding()`, and
    `listAgentMailboxes()`, so stale bindings can no longer keep satisfying
    mailbox-access checks or keep showing up in control-plane listings after
    the underlying mailbox has gone away.
    Refs: `src/repositories/agents.ts:1082`, `src/repositories/agents.ts:1137`,
    `src/repositories/agents.ts:1220`, `src/routes/api.ts:2710`

79. Hardening: deployment reads and deployment-backed mailbox access checks now
    ignore orphan `agent_deployments` rows whose agent, agent version, or
    mailbox target has already disappeared. This tightens
    `getAgentDeployment()`, `listAgentDeployments()`,
    `listActiveDeploymentsForTarget()`, `hasActiveMailboxDeployment()`, and the
    mailbox-target deployment queries inside `resolveAgentExecutionTarget()`,
    so stale deployment rows can no longer keep satisfying active-mailbox
    access or appear in deployment control-plane views after their backing
    resources are gone.
    Refs: `src/repositories/agents.ts:729`, `src/repositories/agents.ts:866`,
    `src/repositories/agents.ts:897`, `src/repositories/agents.ts:1201`

80. Hardening: `getThread()` now only includes messages from the same mailbox
    as the thread row itself. Previously the thread read path loaded all
    `messages` rows sharing the `thread_id`, so any legacy or manually
    corrupted cross-mailbox message linkage could bleed foreign mailbox content
    into thread views and reply-context construction even after newer write
    paths had been tightened to fail closed.
    Refs: `src/repositories/mail.ts:596`, `src/repositories/mail.ts:620`,
    `src/routes/api.ts:3156`, `src/routes/mcp.ts:2019`

81. Hardening: outbound-job reads now ignore orphan `outbound_jobs` rows whose
    backing outbound `messages` row has already disappeared. This tightens
    `listOutboundJobs()`, `getOutboundJob()`, `getOutboundJobByMessageId()`,
    and `getOutboundJobByDraftR2Key()`, so admin views, webhook lookups, and
    idempotent send-recovery paths no longer treat a job with no surviving
    message record as a valid queued/sent delivery state.
    Refs: `src/repositories/mail.ts:636`, `src/repositories/mail.ts:1724`,
    `src/repositories/mail.ts:1742`, `src/repositories/mail.ts:1762`

82. Hardening: draft reads now ignore orphan `drafts` rows whose backing agent
    or mailbox has already disappeared. This tightens `getDraft()`,
    `listDrafts()`, and `getDraftByR2Key()`, so send/recovery routes and admin
    draft listings no longer treat a draft with no surviving execution agent or
    mailbox as a valid editable/sendable resource.
    Refs: `src/repositories/mail.ts:1174`, `src/repositories/mail.ts:1223`,
    `src/repositories/mail.ts:1286`, `src/routes/site.ts:1925`

83. Hardening: task reads now ignore orphan `tasks` rows whose mailbox, source
    message, or assigned agent has already disappeared. This tightens
    `listTasks()`, `getTaskBySourceMessageId()`, and `getTask()`, so worker
    execution, replay-task reuse, and task listing endpoints no longer treat a
    stale task with missing backing resources as a runnable or visible task.
    Refs: `src/repositories/mail.ts:297`, `src/repositories/mail.ts:2187`,
    `src/repositories/mail.ts:2224`, `src/handlers/queues.ts:324`

84. Hardening: message reads now ignore orphan `messages` rows whose mailbox
    has already disappeared. This tightens `getMessage()`,
    `getInboundMessageByInternetMessageId()`, `listMessages()`, and
    `getMessageByProviderMessageId()`, so mailbox-scoped reads, webhook
    lookups, and replay/message inspection paths no longer treat a message with
    no surviving mailbox as a valid resource.
    Refs: `src/repositories/mail.ts:365`, `src/repositories/mail.ts:385`,
    `src/repositories/mail.ts:511`, `src/repositories/mail.ts:2367`

85. Hardening: attachment ownership lookup by `r2Key` now also requires the
    owning message's mailbox to still exist. `getAttachmentOwnerByR2Key()`
    drives draft/send attachment validation; previously it could still report a
    tenant/mailbox owner through a stale `messages` row even after the mailbox
    itself had been deleted, allowing legacy orphan attachments to keep passing
    ownership checks.
    Refs: `src/repositories/mail.ts:632`, `src/routes/api.ts:380`,
    `src/lib/draft-send-guards.ts:93`

86. Hardening: reply-context thread lookup now ignores cross-mailbox or orphan
    thread state when resolving a thread from referenced message ids or
    outbound fallback history. `findThreadByInternetMessageIds()` and
    `findThreadByReplyContext()` now only reuse a thread when it still belongs
    to the same mailbox as the backing message and that mailbox still exists.
    Previously legacy or manually corrupted message/thread links could steer
    inbound normalization onto a foreign or orphaned thread before later write
    paths had a chance to fail closed.
    Refs: `src/repositories/mail.ts:844`, `src/repositories/mail.ts:1014`,
    `src/handlers/queues.ts:177`

87. Hardening: thread reads and thread creation/reuse now also require thread
    tenant consistency with the backing mailbox. `getThread()`,
    `getOrCreateThread()`, `findThreadByInternetMessageIds()`, and
    `findThreadByReplyContext()` now reject threads whose `tenant_id` no longer
    matches the mailbox tenant, and new-thread finalization now verifies the
    target mailbox belongs to the expected tenant. This closes another legacy
    corruption path where a cross-tenant thread row could still be surfaced or
    reused as long as the mailbox id itself existed.
    Refs: `src/repositories/mail.ts:596`, `src/repositories/mail.ts:661`,
    `src/repositories/mail.ts:844`, `src/repositories/mail.ts:1014`

88. Hardening: draft reads now also require tenant consistency between the
    draft row and its backing agent/mailbox. `getDraft()`, `listDrafts()`, and
    `getDraftByR2Key()` no longer accept a draft merely because the referenced
    agent and mailbox ids still exist; they now require both resources to still
    belong to `drafts.tenant_id`. This closes a legacy corruption path where a
    cross-tenant draft row could still be surfaced through read/send/recovery
    flows as long as its foreign agent and mailbox records were present.
    Refs: `src/repositories/mail.ts:1174`, `src/repositories/mail.ts:1223`,
    `src/repositories/mail.ts:1286`

89. Hardening: mailbox binding / mailbox deployment access helpers now also
    require tenant consistency, not just row existence. `hasActiveMailboxBinding()`,
    `getAgentMailboxBinding()`, and `listAgentMailboxes()` now require the
    binding tenant to still match both the mailbox tenant and the agent tenant;
    `hasActiveMailboxDeployment()` now requires the deployment tenant to still
    match both the agent tenant and the mailbox tenant. This closes the
    remaining stale-access path where cross-tenant legacy rows could still
    satisfy active-mailbox permission checks as long as the referenced ids were
    present.
    Refs: `src/repositories/agents.ts:1163`, `src/repositories/agents.ts:1201`,
    `src/repositories/agents.ts:1238`, `src/repositories/agents.ts:1320`

90. Hardening: deployment control-plane reads and mailbox-execution target
    resolution now also require tenant consistency, not just parent existence.
    `listActiveDeploymentsForTarget()`, `getAgentDeployment()`,
    `listAgentDeployments()`, and the deployment/binding fallback queries inside
    `resolveAgentExecutionTarget()` now require deployment and binding tenants
    to still match their backing agent/mailbox tenants. This closes the
    remaining path where cross-tenant legacy rows could still appear in
    deployment listings or influence execution-target selection for a mailbox.
    Refs: `src/repositories/agents.ts:732`, `src/repositories/agents.ts:866`,
    `src/repositories/agents.ts:897`, `src/repositories/agents.ts:929`

91. Hardening: thread reads and reply-context lookup now also require message
    tenant consistency. `getThread()` now only includes messages whose
    `tenant_id` still matches the thread tenant, and both
    `findThreadByInternetMessageIds()` and `findThreadByReplyContext()` now
    filter candidate messages by `input.tenantId`. This closes the remaining
    legacy-corruption path where cross-tenant message rows sharing the same
    mailbox/thread linkage could still influence thread reconstruction.
    Refs: `src/repositories/mail.ts:596`, `src/repositories/mail.ts:844`,
    `src/repositories/mail.ts:1014`

92. Hardening: inbound-message lookup by `internet_message_id` now also
    requires mailbox tenant consistency, matching the other message read
    helpers. `getInboundMessageByInternetMessageId()` previously only checked
    that the mailbox id still existed, so a legacy row whose `tenant_id` no
    longer matched the mailbox tenant could still be treated as the canonical
    inbound dedupe/resume target.
    Refs: `src/repositories/mail.ts:385`, `src/handlers/email.ts:71`

93. Hardening: thread-link mutation helpers now also require tenant
    consistency, not just mailbox-id equality. `assignDraftThreadId()`,
    `restoreDraftSendState()`, `assignMessageThreadId()`,
    `updateInboundMessageNormalized()`, and `updateThreadTimestamp()` now
    require the destination thread tenant to still match the draft/message
    tenant and the backing mailbox tenant. This closes the remaining
    legacy-corruption path where a cross-tenant thread row reusing the same
    mailbox id could still be reattached during draft send, rollback, or
    inbound normalization.
    Refs: `src/repositories/mail.ts:934`, `src/repositories/mail.ts:958`,
    `src/repositories/mail.ts:1004`, `src/repositories/mail.ts:1941`,
    `src/repositories/mail.ts:1981`

94. Hardening: agent policy and agent version reads now fail closed on orphaned
    parent agents. `getAgentPolicy()`, `upsertAgentPolicy()` final read-back,
    `getAgentVersion()`, and `listAgentVersions()` now all require the backing
    `agents` row to still exist before treating the policy/version as valid.
    This closes the remaining control-plane path where legacy orphan
    `agent_policies` or `agent_versions` rows could still be surfaced through
    API, queue, or provisioning flows after the agent itself had been deleted.
    Refs: `src/repositories/agents.ts:236`, `src/repositories/agents.ts:546`,
    `src/repositories/agents.ts:563`, `src/repositories/agents.ts:1418`

95. Hardening: agent deployment creation now also fails closed on tenant drift
    during post-write finalization and cleans up if the final read-back no
    longer passes deployment validation. `createAgentDeployment()` now requires
    the parent agent tenant and mailbox target tenant to still match the
    deployment tenant, and it deletes the fresh deployment row if the final
    `getAgentDeployment()` read returns null. This closes the remaining path
    where a legacy cross-tenant mailbox row or other post-insert drift could
    leave behind an unreadable orphan deployment after creation failed.
    Refs: `src/repositories/agents.ts:581`, `src/repositories/agents.ts:619`,
    `src/repositories/agents.ts:633`

96. Hardening: mailbox binding creation now also fails closed on tenant drift
    during post-write finalization and cleans up if the final read-back no
    longer passes binding validation. `bindMailbox()` now requires the parent
    agent tenant and mailbox tenant to still match the binding tenant, and it
    deletes the fresh binding row if the final `getAgentMailboxBinding()` read
    returns null. This closes the remaining path where a legacy cross-tenant
    mailbox or agent row could leave behind an unreadable orphan binding after
    creation failed.
    Refs: `src/repositories/agents.ts:1345`, `src/repositories/agents.ts:1389`,
    `src/repositories/agents.ts:1398`

97. Hardening: agent updates now normalize and validate `defaultVersionId` at
    the repository layer instead of relying on route callers. `updateAgent()`
    now treats an empty string as clearing the default version (`NULL`) and
    rejects any non-empty version id that does not belong to the same agent
    before writing config or metadata changes. This closes the path where API
    or internal callers could persist an empty-string foreign key or a foreign
    agent version onto `agents.default_version_id`.
    Refs: `src/repositories/agents.ts:332`, `src/routes/api.ts:2205`

98. Hardening: deployment rollout/rollback now also fail closed if the final
    deployment read-back no longer passes validation after the status topology
    has already been rewritten. `rolloutAgentDeployment()` now best-effort
    restores prior deployment statuses and deletes the just-created deployment
    when the promoted deployment cannot be read back, while
    `rollbackAgentDeployment()` now restores the snapshot and throws instead of
    silently returning `null`. This closes the remaining path where parent/tenant
    drift after status transitions could leave partially switched deployment
    state behind while the repository misreported the outcome.
    Refs: `src/repositories/agents.ts:813`, `src/repositories/agents.ts:858`,
    `src/repositories/agents.ts:909`

99. Hardening: task execution claim now uses the same parent-consistency gates
    as task reads and cleans up if post-claim validation still fails. `claimTaskForExecution()`
    no longer promotes a task to `running` unless its mailbox, source message,
    and assigned agent still exist inside the same tenant, and it now deletes
    the task if a concurrent drift makes the claimed row fail the subsequent
    `getTask()` validation. This closes the worker path where an orphan task
    could be stranded in hidden `running` state after `handleAgentExecute()`
    immediately treated it as nonexistent.
    Refs: `src/repositories/mail.ts:2333`, `src/handlers/queues.ts:318`

100. Hardening: outbound job reads and send-claim now require the backing
    message to still pass mailbox/tenant validation, not just raw message-row
    existence. `getOutboundJob()`, `getOutboundJobByMessageId()`, and
    `getOutboundJobByDraftR2Key()` now require the owning message's mailbox to
    still exist and match `messages.tenant_id`, and `claimOutboundJobForSend()`
    now uses the same gate plus post-claim read-back cleanup. This closes the
    worker path where a hidden/corrupted message row could leave an outbound
    job repeatedly claimed for send even though the subsequent message load
    would immediately treat it as invalid.
    Refs: `src/repositories/mail.ts:1883`, `src/repositories/mail.ts:2618`,
    `src/handlers/queues.ts:389`, `src/handlers/queues.ts:595`

101. Hardening: SES webhook fallback status updates by `provider_message_id`
     now use the same mailbox/tenant visibility gate as
     `getMessageByProviderMessageId()`. `updateMessageStatusByProviderMessageId()`
     previously updated any raw `messages.provider_message_id` match, even if
     that message had already become hidden by mailbox/tenant drift. This
     closes the remaining webhook path where terminal delivery events could
     still mutate a corrupted hidden message row through the provider-id
     fallback branch.
     Refs: `src/repositories/mail.ts:2511`, `src/routes/api.ts:3630`

102. Hardening: `updateAgent()` now delays old-config cleanup until after the
     updated agent row has been read back successfully. If the agent disappears
     after the `UPDATE` commits but before final read-back, the repository now
     deletes the newly uploaded config blob and preserves the previous config
     blob instead of deleting the last known-good artifact before surfacing the
     failure. This closes the remaining post-update race that could orphan the
     fresh config and discard the prior one in the same failed update.
     Refs: `src/repositories/agents.ts:340`

103. Hardening: draft send claim now requires the draft's parent agent and
     mailbox to still exist inside the same tenant, and `enqueueDraftSend()`
     now re-validates the claimed draft before creating outbound message/job
     state. This closes the remaining race where a draft could be promoted to
     `queued` after parent drift and then continue into send-side effects even
     though the repository's normal draft reads would already hide it as
     invalid.
     Refs: `src/repositories/mail.ts:1472`, `src/repositories/mail.ts:1504`

104. Hardening: direct message-status mutation helpers now also require the
     owning mailbox to still exist and match `messages.tenant_id`. This tightens
     `backfillMessageProviderAcceptance()`, `updateMessageStatus()`, and
     `markMessageSent()` so webhook and queue recovery paths can no longer keep
     mutating a hidden/corrupted message row merely because its raw `id` still
     exists in `messages`.
     Refs: `src/repositories/mail.ts:2551`, `src/repositories/mail.ts:2576`,
     `src/repositories/mail.ts:2706`

105. Hardening: remaining draft/outbound rollback helpers now also respect the
     same visibility rules as normal draft/job reads. `restoreDraftSendState()`
     and `markDraftStatus()` now require the draft's parent agent/mailbox to
     still exist in the same tenant, while `updateOutboundJobStatus()` now
     requires the backing message to still pass mailbox/tenant validation. This
     closes the remaining rollback/recovery path where hidden invalid drafts or
     outbound jobs could still be mutated directly even though normal reads had
     already filtered them out.
     Refs: `src/repositories/mail.ts:958`, `src/repositories/mail.ts:2649`,
     `src/repositories/mail.ts:2698`

106. Hardening: task mutation helpers now also use the same parent-consistency
     rules as task reads/claims. `updateTaskAssignment()` and
     `updateTaskStatus()` now require the task's mailbox, source message, and
     assigned agent linkage to still be valid before mutating the row, so queue
     recovery can no longer keep rewriting a hidden invalid task just because
     its raw `tasks.id` still exists.
     Refs: `src/repositories/mail.ts:2429`, `src/repositories/mail.ts:2468`

107. Hardening: deployment status mutation helpers now also require the same
     parent/version/target validity as deployment reads. `setDeploymentStatus()`
     and `setDeploymentsStatus()` no longer rewrite raw `agent_deployments`
     rows whose backing agent, agent version, or mailbox target has already
     drifted out of validity, which closes the remaining topology-update path
     where rollout/rollback could still mutate hidden invalid deployments
     directly before later read-back failed.
     Refs: `src/repositories/agents.ts:718`, `src/repositories/agents.ts:762`

108. Hardening: single-deployment status updates now also fail closed if the
     final deployment read-back disappears after the status change has already
     committed. `updateAgentDeploymentStatus()` now snapshots prior status,
     restores it on post-update read-back failure, and throws instead of
     returning `null`, which closes the API path where a successful deployment
     state change could be misreported as "not found" after later validation
     drift.
     Refs: `src/repositories/agents.ts:661`, `src/routes/api.ts:2480`

109. Hardening: unique-conflict create paths now self-heal hidden invalid
     binding/deployment rows before giving up. `createAgentDeployment()` now
     removes stale invalid active deployments blocking the active-target unique
     index and retries once, while `bindMailbox()` now removes stale invalid
     `(agent_id, mailbox_id)` rows blocking its unique constraint and retries
     once. This closes the remaining control-plane repair path where legacy
     orphan rows could be invisible to normal reads yet still permanently block
     recreating the correct deployment or mailbox binding.
     Refs: `src/repositories/agents.ts:598`, `src/repositories/agents.ts:642`,
     `src/repositories/agents.ts:1494`, `migrations/0001_initial.sql:22`,
     `migrations/0003_agent_deployment_history.sql:35`

110. Hardening: `getOrCreateThread()` now requires tenant consistency on both
     the pre-existing lookup and the unique-conflict retry lookup, and it now
     verifies the inserted row with `tenant_id + mailbox_id` on final read-back.
     Previously a legacy cross-tenant thread row reusing the same
     `mailbox_id/thread_key` could be returned directly to new inbound/draft
     flows after mailbox drift, even though the caller supplied a different
     tenant context.
     Refs: `src/repositories/mail.ts:738`

111. Hardening: inbound receive dedupe now only treats visible same-tenant
     mailbox messages as duplicates, and it now fails closed if insertion gets
     skipped without any visible existing message to resume. `createInboundMessage()`
     now excludes hidden invalid inbound rows from its `NOT EXISTS` check,
     deletes stale hidden duplicates when needed, and throws instead of
     returning `false` if no visible duplicate actually exists. This closes the
     ingest path where a corrupt hidden inbound row could suppress a new
     message while `handleEmail()` could not find any valid message to resume.
     Refs: `src/repositories/mail.ts:414`, `src/repositories/mail.ts:447`,
     `src/handlers/email.ts:55`

112. Hardening: `getOrCreateThread()` now self-heals hidden invalid
     `mailbox_id/thread_key` collisions before giving up on unique-conflict
     inserts. When the unique index fires but no visible concurrent thread can
     be read back for the caller's tenant/mailbox, the repository now removes
     stale invalid blocking rows and retries once. This closes the remaining
     repair gap where orphan or tenant-drifted thread rows could stay invisible
     to normal reads yet still permanently block thread recreation.
     Refs: `src/repositories/mail.ts:806`, `src/repositories/mail.ts:834`,
     `migrations/0001_initial.sql:58`

113. Hardening: task dedupe/reset now also aligns with visible task validity
     instead of trusting raw `tasks` rows. `getOrCreateTaskForSourceMessage()`
     now excludes hidden invalid task rows from its `NOT EXISTS` guard, removes
     stale invalid duplicates when they block recreation, and applies the same
     mailbox/message/assigned-agent validity checks when resetting a failed
     task back to queued work. This closes the path where an orphan or
     tenant-drifted task could stay invisible to normal task reads yet still
     block new task creation or be mutated directly during failed-task reuse.
     Refs: `src/repositories/mail.ts:2274`, `src/repositories/mail.ts:2363`,
     `src/repositories/mail.ts:2443`

114. Hardening: draft cleanup now no longer lets hidden invalid outbound-job
     rows block deletion of unsent drafts. `deleteDraftIfUnqueued()` now
     removes stale outbound jobs whose backing message/mailbox no longer passes
     visibility checks, and its `NOT EXISTS` guard now only treats visible
     outbound jobs as a real send blocker. This closes the cleanup path where a
     corrupt hidden job could strand sensitive token/signup draft payloads and
     prevent best-effort rollback from deleting a draft that no live send flow
     could actually resume.
     Refs: `src/repositories/mail.ts:1547`, `src/repositories/mail.ts:1576`,
     `src/routes/api.ts:3925`, `src/lib/provisioning/signup.ts:301`

115. Hardening: thread cleanup now only treats visible message/draft
     references as real blockers. `deleteThreadIfUnreferenced()` now ignores
     hidden invalid messages and drafts whose mailbox/agent parents no longer
     pass normal read visibility, so rollback after inbound normalization or
     reply-thread assignment failure can still remove a freshly created thread
     instead of leaving it stranded behind invisible corrupt references.
     Refs: `src/repositories/mail.ts:1095`, `src/repositories/mail.ts:1277`,
     `src/repositories/mail.ts:1852`

116. Hardening: mailbox cleanup now aligns its "unused" test with visible
     child validity instead of raw child-row existence. `deleteMailboxIfUnreferenced()`
     now only lets valid mailbox bindings, deployments, threads, messages,
     drafts, and tasks block deletion, so contact-alias rollback and similar
     cleanup flows are no longer permanently stuck behind hidden invalid child
     rows that normal repository reads already ignore.
     Refs: `src/repositories/agents.ts:1757`, `src/routes/site.ts:1450`,
     `src/routes/site.ts:1522`

117. Hardening: `createDraft()` now also removes the freshly inserted `drafts`
     row when the final repository read-back fails after the draft blob has
     already been written. Previously this branch only deleted `draftR2Key`,
     which could leave behind a hidden invalid draft row that normal reads no
     longer returned but later cleanup and rollback logic still had to work
     around.
     Refs: `src/repositories/mail.ts:1283`, `src/repositories/mail.ts:1399`

118. Hardening: task creation paths now also delete the freshly inserted task
     row if the final filtered read-back fails after insert/finalization.
     `createTask()` and the insert-success branch of
     `getOrCreateTaskForSourceMessage()` previously could throw on a hidden
     read-back miss while leaving behind a just-created task row that normal
     task reads no longer returned. They now clean that row up before failing.
     Refs: `src/repositories/mail.ts:2402`, `src/repositories/mail.ts:2441`,
     `src/repositories/mail.ts:2447`

119. Hardening: inbound message creation now also removes the freshly inserted
     `messages` row when final read-back fails after mailbox existence has
     already been rechecked. Previously `createInboundMessage()` only cleaned
     the row up when the mailbox had disappeared, but a later filtered
     `getMessage()` miss could still leave behind a hidden invalid inbound row
     while the caller separately cleaned only the raw R2 blob.
     Refs: `src/repositories/mail.ts:447`, `src/repositories/mail.ts:482`

120. Hardening: `getOrCreateThread()` now also removes the freshly inserted
     `threads` row when its final `id + tenant_id + mailbox_id` read-back
     fails after mailbox revalidation. Previously that branch threw directly,
     which could leave behind a hidden invalid thread row even though the
     repository had already concluded the stored thread no longer matched the
     caller's tenant/mailbox context.
     Refs: `src/repositories/mail.ts:809`, `src/repositories/mail.ts:943`

121. Hardening: delivery-event dedupe now also ignores hidden invalid prior
     rows instead of treating them as permanent duplicates. `insertDeliveryEvent()`
     now only lets visible events block the same `payload_r2_key`, removes
     stale invalid delivery-event rows whose backing message/mailbox no longer
     passes normal visibility, and fails closed if insertion is skipped without
     any visible existing event. This closes the webhook path where a corrupt
     old event row could suppress future event persistence while still leaving
     operators with stale ghost event history.
     Refs: `src/repositories/mail.ts:2825`, `src/repositories/mail.ts:2882`,
     `src/routes/api.ts:3552`

122. Hardening: draft send claim now also cleans up a newly hidden invalid
     draft if post-claim read-back fails and state restoration cannot be
     applied. `enqueueDraftSend()` already restored the prior status when
     possible, but previously a claim that turned the draft `queued` just
     before agent/mailbox drift could still leave behind a hidden invalid draft
     row and blob after the restore path failed. It now deletes that draft row
     and payload blob in the unrecoverable branch.
     Refs: `src/repositories/mail.ts:1697`, `src/repositories/mail.ts:1722`

123. Hardening: direct send of an existing draft now re-validates stored
     `threadId` / `sourceMessageId` before enqueue in both REST and MCP, not
     just in the idempotent replay branch. Previously a non-idempotent
     `send_draft` call could still enqueue a draft whose stored reply/thread
     linkage had drifted or disappeared after creation, even though the same
     draft would be rejected when sent through the idempotent path.
     Refs: `src/routes/api.ts:3492`, `src/routes/mcp.ts:2389`

124. Hardening: draft reads now fail closed when optional `thread_id` or
     `source_message_id` drift out of validity. `getDraft()`,
     `getDraftByR2Key()`, and `listDrafts()` now require any stored draft
     thread/message linkage to still exist inside the same tenant/mailbox and
     still pass mailbox visibility, so queue workers, REST, and MCP no longer
     treat stale reply/thread context as a valid draft record after the backing
     thread or source message has disappeared.
     Refs: `src/repositories/mail.ts:1413`, `src/repositories/mail.ts:1522`,
     `src/repositories/mail.ts:1615`

125. Hardening: hidden invalid drafts created by the stricter draft visibility
     rules no longer break best-effort draft cleanup. `deleteDraftIfUnqueued()`
     now falls back to a raw draft row lookup when `getDraft()` intentionally
     hides a drifted draft, so rollback paths can still delete an unsent draft
     and its blob after stale `thread_id` / `source_message_id` linkage has
     made the draft invisible to normal reads.
     Refs: `src/repositories/mail.ts:1730`, `src/repositories/mail.ts:1769`

126. Hardening: agent reads now mask stale `default_version_id` values instead
     of returning a broken default-version pointer. `getAgent()` and
     `listAgents()` now only surface `defaultVersionId` when the referenced
     version still exists and still belongs to the same agent, so fallback
     execution-target resolution and control-plane reads no longer propagate an
     invalid default version id after version drift or deletion.
     Refs: `src/repositories/agents.ts:303`, `src/repositories/agents.ts:326`

127. Hardening: existing outbound-job lifecycle paths no longer confuse a
     drifted draft reference with a truly missing draft after draft reads were
     tightened. A dedicated `getDraftByR2KeyForOutboundLifecycle()` helper now
     preserves agent/mailbox-valid drafts for queue/webhook/admin recovery and
     inspection flows even when their optional reply/thread linkage has drifted,
     so these paths keep performing fail-closed draft validation and state
     repair instead of silently treating the draft as absent.
     Refs: `src/repositories/mail.ts:1730`, `src/handlers/queues.ts:400`,
     `src/routes/api.ts:3586`, `src/routes/site.ts:1098`,
     `src/routes/admin-mcp.ts:680`

128. Hardening: list/read helpers for thread-adjacent outbound state now align
     with the same mailbox visibility rules as their single-record lookups.
     `getThread()` now only includes messages that still pass normal message
     visibility, `listOutboundJobs()` no longer lists jobs whose backing
     message is hidden behind a stale/orphan mailbox reference, and
     `listDeliveryEventsByMessageId()` now suppresses events for hidden invalid
     messages instead of leaking them through list endpoints after the parent
     message has drifted out of visibility.
     Refs: `src/repositories/mail.ts:737`, `src/repositories/mail.ts:779`,
     `src/repositories/mail.ts:3185`

129. Hardening: `provider_message_id` lookup/update paths now fail closed on
     ambiguity instead of treating a non-unique provider id as a safe single
     row key. `getMessageByProviderMessageId()` now only resolves when exactly
     one visible message matches, webhook status updates only touch a uniquely
     visible target, and both provider-acceptance write paths now refuse to
     assign a provider message id that is already attached to another visible
     message, preventing duplicate/corrupted rows from causing arbitrary reads
     or multi-row terminal-event state changes.
     Refs: `src/repositories/mail.ts:391`, `src/repositories/mail.ts:3223`,
     `src/repositories/mail.ts:3240`, `src/repositories/mail.ts:3458`

130. Hardening: outbound-job lookup and creation by `draft_r2_key` / `message_id`
     now also fail closed on ambiguity instead of treating non-unique rows as
     a valid single-job state. `getOutboundJobByMessageId()` and
     `getOutboundJobByDraftR2Key()` now only resolve a uniquely visible job,
     and `enqueueDraftSend()` now performs visible-job dedupe plus hidden-row
     self-heal before inserting, so corrupted duplicate jobs can no longer be
     silently picked as the "latest" row or expanded by creating yet another
     outbound job for the same draft.
     Refs: `src/repositories/mail.ts:785`, `src/repositories/mail.ts:2104`,
     `src/repositories/mail.ts:2398`, `src/repositories/mail.ts:2414`

131. Hardening: draft lookup by `draft_r2_key` now also fails closed on
     ambiguity instead of returning whichever visible row happened to sort
     first. Both `getDraftByR2Key()` and
     `getDraftByR2KeyForOutboundLifecycle()` now require exactly one visible
     draft match, so REST/MCP/admin/queue paths no longer treat duplicated
     draft blobs as a trustworthy single draft record after corruption or
     manual data drift.
     Refs: `src/repositories/mail.ts:1741`, `src/repositories/mail.ts:1850`

132. Hardening: inbound-message and task lookups by natural dedupe keys now
     also fail closed on ambiguity instead of silently choosing one visible
     row. `getInboundMessageByInternetMessageId()` and
     `getTaskBySourceMessageId()` now require exactly one visible match, so
     inbound replay/dedupe and task recovery paths will surface duplicated
     visible rows as corruption instead of treating an arbitrary oldest/newest
     row as authoritative.
     Refs: `src/repositories/mail.ts:437`, `src/repositories/mail.ts:2916`

133. Hardening: exact thread resolution by reply/reference message ids now
     also fails closed on ambiguity instead of picking whichever matching
     thread happened to contain the newest visible message. 
     `findThreadByInternetMessageIds()` now only resolves when a referenced
     internet-message-id maps to exactly one visible thread, so reply-context
     recovery cannot silently attach follow-up mail to the wrong split or
     duplicated thread after data drift.
     Refs: `src/repositories/mail.ts:1079`

134. Hardening: reply-context fallback no longer lets duplicated visible
     outbound jobs skew recipient matching or candidate selection. The fallback
     message scan now only considers messages with at most one visible
     outbound-job match, and it only loads a `draft_r2_key` when that visible
     outbound-job association is unique, so corrupted duplicate jobs cannot
     cause reply-thread recovery to read an arbitrary draft payload and route a
     reply onto the wrong thread.
     Refs: `src/repositories/mail.ts:1295`

135. Hardening: tenant outbound-usage window counts now dedupe by message id
     before summing, so duplicated outbound-job / draft join rows can no
     longer inflate per-hour or per-day send counts for the same outbound
     message during quota and policy checks.
     Refs: `src/repositories/mail.ts:2274`

136. Hardening: attachment owner lookup by `r2_key` now also fails closed on
     ambiguity instead of returning whichever visible attachment row matched
     first. `getAttachmentOwnerByR2Key()` now resolves only a uniquely visible
     owner tuple after de-duplicating same-message rows, so attachment
     validation and send checks cannot silently treat a cross-message shared
     blob key as belonging to an arbitrary tenant/mailbox.
     Refs: `src/repositories/mail.ts:760`

137. Hardening: tenant outbound-usage window counts now also ignore hidden
     outbound messages whose mailbox no longer passes visibility checks. Quota
     and policy accounting no longer lets orphaned mailbox/message rows keep
     consuming send capacity after the backing mailbox has drifted out of the
     visible runtime state.
     Refs: `src/repositories/mail.ts:2274`

138. Hardening: quota accounting now only excludes `system:%` sends when the
     outbound message still has exactly one visible draft association proving
     that origin. Ambiguous or duplicated draft/job associations no longer let
     sent mail escape hourly/daily quota checks just because one joined draft
     row happened to look system-generated.
     Refs: `src/repositories/mail.ts:2274`

139. Hardening: reply-context fallback now only reads recipient hints from a
     draft blob when the associated `draft_r2_key` still resolves to exactly
     one visible lifecycle-valid draft in the same tenant/mailbox. Hidden,
     stale, or cross-tenant draft rows can no longer keep influencing thread
     recovery just because an old outbound job still points at the blob key.
     Refs: `src/repositories/mail.ts:1146`

140. Fixed: admin MCP tenant send-policy updates now resync default
     self-serve agent recipient allowlists when `internalDomainAllowlist`
     changes, matching the REST admin path. Updating tenant internal domains
     through `upsert_tenant_send_policy` no longer leaves default internal-only
     agent policies pinned to the old allowlist.
     Refs: `src/routes/admin-mcp.ts:18`, `src/routes/admin-mcp.ts:1048`

141. Hardening: implicit mailbox-to-agent resolution now fails closed on
     ambiguity instead of picking the oldest active binding. `resolveAssignedAgent()`
     now requires exactly one visible agent binding for the mailbox, so
     multi-bound or drifted mailbox-agent rows can no longer silently route
     future task assignment to an arbitrary agent.
     Refs: `src/repositories/mail.ts:2716`

142. Hardening: billing receipt and ledger lookups by pseudo-unique keys now
     also fail closed on ambiguity instead of silently picking the newest row.
     Payment-proof replay detection plus settlement/replay lookup paths now
     reject legacy duplicate `payment_proof_fingerprint`, `payment_receipt_id`,
     or `reference_id` records with an explicit `409`, so billing flows no
     longer reuse or settle against an arbitrary row when pre-index data drift
     violates the intended uniqueness contract.
     Refs: `src/repositories/billing.ts:71`, `src/repositories/billing.ts:290`,
     `src/repositories/billing.ts:316`, `src/repositories/billing.ts:346`,
     `src/routes/api.ts:99`, `src/routes/api.ts:3690`

143. Hardening: receipt settlement now also fails closed when an existing
     ledger row linked by `payment_receipt_id` has the wrong semantic type for
     the receipt being settled. Topup receipts now require a topup settlement
     ledger, and upgrade receipts now require an upgrade credit-grant ledger;
     legacy or corrupted rows of another typed ledger kind are rejected with a
     `409` instead of being silently reused as if they were valid settlement
     records.
     Refs: `src/lib/payments/ledger-metadata.ts:55`,
     `src/lib/payments/ledger-metadata.ts:69`,
     `src/repositories/billing.ts:759`, `src/repositories/billing.ts:788`,
     `src/repositories/billing.ts:811`, `src/repositories/billing.ts:840`,
     `src/routes/api.ts:131`, `src/routes/api.ts:4753`,
     `src/routes/api.ts:4851`

144. Hardening: payment-receipt create/update paths now classify receipt-key
     uniqueness collisions as explicit billing conflicts instead of bubbling
     generic repository errors. If `payment_proof_fingerprint`,
     `paymentReference`, or `settlementReference` is already owned by another
     receipt, the repository now raises a fail-closed billing uniqueness error
     that the API maps to `409`, avoiding misleading `500`s during x402 proof
     capture or facilitator confirmation.
     Refs: `src/repositories/billing.ts:93`,
     `src/repositories/billing.ts:382`, `src/repositories/billing.ts:423`,
     `src/repositories/billing.ts:510`, `src/repositories/billing.ts:545`,
     `src/routes/api.ts:3690`

145. Hardening: `POST /v1/auth/token/rotate` now completes all
     `self_mailbox` / `both` delivery preflight validation before minting the
     rotated token. Mailbox-scope, mailbox selection, current mailbox access,
     and self-agent binding checks no longer happen after token issuance, so a
     request that ultimately returns `400` or `403` cannot silently create a
     fresh access token the caller never receives.
     Refs: `src/routes/api.ts:864`, `src/routes/api.ts:879`,
     `src/routes/api.ts:896`

146. Hardening: agent control-plane unique-key conflicts are now surfaced as
     explicit registry conflicts instead of bubbling generic server errors.
     Duplicate tenant-local agent slugs and duplicate `(agent_id, version)`
     inserts now raise a dedicated conflict error that the API maps to `409`,
     so create/update versioning flows no longer misclassify routine uniqueness
     violations as `500`s.
     Refs: `src/repositories/agents.ts:149`,
     `src/repositories/agents.ts:299`, `src/repositories/agents.ts:434`,
     `src/repositories/agents.ts:588`, `src/routes/api.ts:32`,
     `src/routes/api.ts:3712`

147. Hardening: DID binding upserts now classify cross-tenant DID uniqueness
     collisions as explicit conflicts instead of bubbling generic database
     errors. Because `tenant_did_bindings.did` is globally unique, attempting
     to bind a DID already owned by another tenant now raises a dedicated
     conflict error that the API maps to `409`, avoiding misleading `500`s on
     hosted DID bootstrap or tenant-managed DID updates.
     Refs: `src/repositories/did-bindings.ts:18`,
     `src/repositories/did-bindings.ts:117`, `src/routes/api.ts:113`,
     `src/routes/api.ts:3720`

148. Hardening: public self-serve signup now fail-closes deterministic
     provisioning collisions as `409` instead of misclassifying them as `502`.
     Because `/public/signup` wraps provisioning errors locally and only trusts
     `SignupError` for status selection, agent-registry, mailbox-binding, or
     deployment conflicts raised during self-serve control-plane bootstrap no
     longer bypass the API's global conflict mapping and surface as misleading
     upstream failures.
     Refs: `src/lib/provisioning/signup.ts:13`,
     `src/lib/provisioning/signup.ts:18`, `src/lib/provisioning/signup.ts:91`,
     `src/lib/provisioning/signup.ts:333`, `src/routes/api.ts:773`

149. Hardening: managed contact-alias bootstrap now preserves cross-tenant
     mailbox ownership collisions as explicit mailbox conflicts instead of
     rethrowing them as generic errors. If a managed alias address like
     `hello@...` is already owned by another tenant, the admin create/bootstrap
     routes now keep returning `409` through their existing mailbox-conflict
     mapping rather than surfacing a misleading `502`.
     Refs: `src/lib/contact-aliases.ts:35`,
     `src/lib/contact-aliases.ts:56`, `src/routes/site.ts:1458`,
     `src/routes/site.ts:1533`

150. Hardening: managed contact-alias delete now fails closed on mailbox
     ownership drift instead of claiming success or deleting routing state for
     a foreign tenant. If the alias mailbox exists but is no longer owned by
     the managed contact-alias tenant, `/admin/api/contact-aliases/:alias`
     now returns `409` before mutating mailbox status or Cloudflare routing,
     preserving the drift for manual reconciliation.
     Refs: `src/routes/site.ts:1557`, `src/routes/site.ts:1564`,
     `src/routes/site.ts:1571`

151. Hardening: admin alias health views now fail closed on disabled routing
     rules and mailbox-ownership drift instead of treating any matching
     Cloudflare rule as "configured". The admin bootstrap overview and
     `/admin/api/contact-aliases` now only mark a managed alias healthy when
     its routing rule is enabled and its mailbox is still the active mailbox
     owned by `CONTACT_ALIAS_TENANT_ID`, so dashboard health no longer masks
     broken or hijacked alias state.
     Refs: `src/routes/site.ts:267`, `src/routes/site.ts:1053`,
     `src/routes/site.ts:1066`, `src/routes/site.ts:1378`,
     `src/routes/site.ts:1391`

152. Hardening: site-admin outbound retry and manual-resolution routes now
     preserve explicit `SiteRequestError` classifications instead of collapsing
     them into generic `502`s. Draft-payload loss, replay drift, or other
     admin-specific `404`/`409` reconciliation failures raised inside these
     workflows now surface with their intended status codes, keeping manual
     recovery tooling aligned with the actual failure mode.
     Refs: `src/routes/site.ts:1188`, `src/routes/site.ts:1833`,
     `src/routes/site.ts:1834`, `src/routes/site.ts:1918`,
     `src/routes/site.ts:1919`

153. Hardening: site-admin contact-alias bootstrap no longer skips broken
     existing rules just because a same-address rule row already exists. With
     `overwrite=false`, bootstrap now only treats an alias as already satisfied
     when the matching rule is enabled and still points at the expected worker;
     disabled or misrouted rules are repaired instead of being silently left in
     place.
     Refs: `src/routes/site.ts:273`, `src/routes/site.ts:1505`,
     `src/routes/site.ts:1526`

154. Hardening: malformed stored draft recipients no longer fail open as empty
     recipient sets during send, retry, or manual billing reconciliation.
     Shared draft-send validation, REST/MCP draft-send preflight, site-admin
     recovery helpers, and the repository enqueue path now require a non-empty
     `to` array plus well-formed optional `cc`/`bcc` arrays, so corrupted
     legacy draft payloads cannot bypass outbound policy or undercharge credit
     checks by degrading recipient fields to `[]`.
     Refs: `src/lib/draft-send-guards.ts:22`,
     `src/lib/draft-send-guards.ts:42`, `src/routes/api.ts:420`,
     `src/routes/mcp.ts:304`, `src/routes/site.ts:1205`,
     `src/repositories/mail.ts:2079`

155. Hardening: malformed stored draft attachments no longer fail open as
     "no attachments" during send and retry flows. Shared draft-send
     validation, REST/MCP draft-send preflight, and the repository enqueue path
     now reject non-array `attachments` payloads instead of silently dropping
     them, so corrupted legacy drafts cannot lose attachment validation or
     attachment delivery semantics just because the stored payload shape is
     wrong.
     Refs: `src/lib/draft-send-guards.ts:74`,
     `src/routes/api.ts:489`, `src/routes/mcp.ts:369`,
     `src/repositories/mail.ts:2112`

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
