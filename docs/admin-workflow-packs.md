# Admin Workflow Packs

This document defines reusable operator-facing workflow packs for agents that
use the dedicated admin MCP surface at `/admin/mcp`.

These packs sit above individual admin tools. They are intended to help an
operator-guided agent decide:

- which admin tools to combine
- where the side-effect boundary is
- when to hand control back to a human

Use them together with:

- [docs/admin-mcp.md](./admin-mcp.md)
- [docs/runtime-metadata.md](./runtime-metadata.md)
- [docs/agent-client-helper.md](./agent-client-helper.md)

## 1. `bootstrap_mailbox_agent`

### Goal

Mint the narrowest viable mailbox-scoped bearer token, then return the agent to
the normal mailbox workflow surface.

### Tool sequence

1. `get_mailbox`
2. `get_agent`
   Use when a downstream mailbox token should be bound to a specific agent.
3. `bootstrap_mailbox_agent_token`

### Side-effect boundary

- `get_mailbox` and `get_agent` are read-only
- `bootstrap_mailbox_agent_token` mints a new bearer token

### Recommended stop conditions

Stop when:

- mailbox identity or tenant ownership is unclear
- the requested token scope exceeds the mailbox workflow need
- the intended agent binding is ambiguous

## 2. `review_tenant_outbound_access`

### Goal

Gather billing and policy context before deciding whether a tenant should be
approved for external send, reset back to review, or suspended.

### Tool sequence

1. `get_tenant_send_policy`
2. `list_mailboxes`
3. `get_tenant_review_context`
4. `apply_tenant_send_policy_review`

Optional direct override:

1. `upsert_tenant_send_policy`

### Side-effect boundary

- `get_tenant_send_policy`, `list_mailboxes`, and `get_tenant_review_context`
  are read-only
- `apply_tenant_send_policy_review` changes the effective outbound state
- `upsert_tenant_send_policy` is a higher-trust direct policy override

### Recommended stop conditions

Stop when:

- the tenant identity or mailbox inventory is incomplete
- payment state is still ambiguous or disputed
- the review outcome would broaden outbound access without operator approval

## 3. `forensic_delivery_inspection`

### Goal

Correlate message, draft, outbound-job, delivery-event, and suppression state
before taking remediation actions on a delivery incident.

### Tool sequence

1. `get_debug_message`
2. `get_debug_draft`
3. `get_debug_outbound_job`
4. `get_suppression`
5. `inspect_delivery_case`

Optional remediation:

1. `add_suppression`

### Side-effect boundary

- `get_debug_message`, `get_debug_draft`, `get_debug_outbound_job`,
  `get_suppression`, and `inspect_delivery_case` are read-only
- `add_suppression` changes future delivery behavior

### Recommended stop conditions

Stop when:

- the lookup target does not uniquely identify the delivery case
- delivery evidence is incomplete and requires provider-side logs
- adding a suppression would materially change customer delivery behavior
  without human review

## Suggested Next Step

These workflow packs are exposed from admin MCP `initialize` under
`result.meta.adminMcp.workflows`, and the TypeScript helper can normalize them
through `getAdminWorkflowSurface()`.

Matching higher-level helper methods:

- `adminBootstrapMailboxAgentWorkflow()`
- `adminReviewTenantOutboundAccessWorkflow()`
- `adminInspectDeliveryCaseWorkflow()`
