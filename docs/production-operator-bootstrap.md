# Production Operator Bootstrap

This guide covers the safest first-write path for bringing a real operator-managed
agent online in production.

Use this only after:

- production deploy is complete
- [docs/production-rollout-checklist.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/production-rollout-checklist.md) is green
- [scripts/production_readonly_smoke.sh](/Users/zh/Documents/codeX/mailagents_cloudflare2/scripts/production_readonly_smoke.sh) passes

## Goal

Create, in order:

1. a production mailbox record
2. a production agent record
3. a published agent version
4. a mailbox deployment pinned to that version

Do this with a temporary operator token in a tightly controlled maintenance window.

## Recommended Order

1. verify the target mailbox address already routes to the production Cloudflare email worker
2. create the mailbox record in D1 if it does not already exist
3. create the agent
4. bind mailbox ownership eligibility with `POST /v1/agents/{agentId}/mailboxes`
5. create `v1` with `POST /v1/agents/{agentId}/versions`
6. create the first active deployment with `POST /v1/agents/{agentId}/deployments`
7. send one controlled inbound email to verify task creation
8. send one controlled outbound draft to verify SES path

## Verified Example

As of 2026-03-18, this flow has been verified in production for:

- mailbox: `support@mailagents.net`
- mailbox id: `mbx_support_primary`
- agent id: `agt_support_primary`
- version id: `agv_support_v1`
- deployment id: `agd_support_primary_v1`

Observed successful inbound runtime records:

- message id: `msg_48e8daa3d719442fadd210d33d298590`
- task id: `tsk_842060e1e2904cb5be11612d0174573b`
- run id: `run_tsk_842060e1e2904cb5be11612d0174573b`

The resulting trace confirmed:

- `agentVersionId = agv_support_v1`
- `deploymentId = agd_support_primary_v1`

Observed successful outbound runtime records:

- draft id: `drf_0609d3589a034460960f807fe0031cd3`
- outbound job id: `obj_c1745e2c87e741baaf10b9e783ba7560`
- outbound message id: `msg_7a423d1ac5234bdbb17cda24c1dce175`
- SES provider message id: `0100019cfef70701-b1f4aed7-daca-4655-9377-8497545211a9-000000`

This outbound verification used the same production support thread as the inbound
test and confirmed the full `draft -> queue -> SES -> D1 sent state` path.

## Safety Notes

- keep `ADMIN_ROUTES_ENABLED=false` in production outside the exact bootstrap window
- prefer a short-lived operator token with one mailbox in `mailboxIds`
- use a dedicated operator mailbox or verified test recipient for first outbound validation
- do not run demo seed data in production
- do not reuse `agt_demo` or `mbx_demo` identifiers in production
- if you test inbound by sending from SES, check the SES account suppression list first
- Cloudflare Email Routing rules must exist before inbound verification is meaningful
- the SES configuration set referenced by `SES_CONFIGURATION_SET` must already exist,
  or outbound jobs will fall into `retry` with a `Configuration set ... does not exist`
  error

## Suggested Naming

- mailbox ids: `mbx_support_primary`, `mbx_sales_primary`
- agent ids: `agt_support_v1`, `agt_sales_v1`
- version names: `support-v1`, `sales-v1`

## First Production Validation

After bootstrap, verify:

- a real inbound email creates a `tasks` row
- the resulting `agent_runs` row has a non-null `trace_r2_key`
- the fetched trace includes `agentVersionId` and `deploymentId`
- one controlled outbound draft reaches SES and records `provider_message_id`

If inbound does not arrive:

1. inspect Cloudflare Email Routing rules for the target address
2. confirm the rule action points to the production worker
3. verify the destination address is not on the SES account suppression list

If outbound falls into `retry` immediately:

1. inspect `outbound_jobs.last_error`
2. confirm the configured SES configuration set exists in the target AWS region
3. retry the failed outbound job only after the AWS-side dependency is fixed

## Rollout Model

Once the first production deployment exists:

- use `POST /v1/agents/{agentId}/deployments/rollout` for a new active version
- use `POST /v1/agents/{agentId}/deployments/{deploymentId}/rollback` to return to the prior version

The production schema now preserves deployment history and enforces only one `active`
deployment per target.
