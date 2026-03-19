# March 2026 Runtime Verification Record

This page preserves dated runtime verification notes from the March 2026
bootstrap and rollout window.

Use the main guides for current instructions:

- [docs/testing.md](../testing.md)
- [docs/deployment.md](../deployment.md)
- [docs/production-rollout-checklist.md](../production-rollout-checklist.md)
- [docs/production-operator-bootstrap.md](../production-operator-bootstrap.md)

## Shared `dev` Verification

As of 2026-03-18, the shared `dev` environment was live-verified for:

- agent registration
- outbound SES send
- inbound email to `agent@mailagents.net`
- versioned registry resolution via `agent_versions` and `agent_deployments`
- deployment rollout and rollback against the same mailbox target

Validation sequence:

1. deploy the latest `dev` Worker
2. apply remote D1 migrations including `0002_agent_registry.sql`
3. create a demo agent version for `agt_demo`
4. create an active mailbox deployment for `mbx_demo`
5. send a live email to `agent@mailagents.net`
6. confirm a new `tasks` row exists
7. confirm the new `agent_runs` row has a non-null `trace_r2_key`
8. fetch the trace object from remote R2 and verify it contains `agentVersionId` and `deploymentId`
9. roll the mailbox target to a newer deployment and then roll it back, confirming only one deployment remains `active`

## Production Verification

As of 2026-03-18, production was live-verified for:

- inbound email to `support@mailagents.net`
- task creation for `agt_support_primary`
- version-aware run tracing for `agv_support_v1`
- controlled outbound reply through SES

Verified production records:

- inbound message: `msg_48e8daa3d719442fadd210d33d298590`
- task: `tsk_842060e1e2904cb5be11612d0174573b`
- run: `run_tsk_842060e1e2904cb5be11612d0174573b`
- successful outbound draft: `drf_0609d3589a034460960f807fe0031cd3`
- successful outbound job: `obj_c1745e2c87e741baaf10b9e783ba7560`
- successful outbound message: `msg_7a423d1ac5234bdbb17cda24c1dce175`

One earlier outbound attempt intentionally revealed an environment dependency:

- failed outbound job: `obj_c175ddc4f9cd4581b230f802d95e4d72`
- failure cause: `Configuration set <mailagents-production> does not exist.`

That failure was resolved by creating the missing SES configuration set
`mailagents-production` in `us-east-1`, after which the reply path succeeded.

Important SES sandbox note during this verification window:

- these production checks proved the runtime could handle internal mailbox flows and could send through SES to verified paths used during operator validation
- until SES production access is approved for unrestricted sending in the active AWS account and region, do not assume delivery to arbitrary external recipients will succeed
- black-box outbound tests for external delivery should continue to use verified inboxes such as internal operator mailboxes
