# Tooling And Errors

Use this reference when the agent is already authenticated and needs to choose
the correct tool or branch safely on failures.

## Tool Preference Order

For mailbox-scoped workflows, prefer this order:

1. `list_messages`
2. `get_message` or `get_message_content`
3. `get_thread` if conversation context matters
4. `send_email` for new outbound mail
5. `reply_to_message` for on-thread responses

Use explicit draft control only when:

- the workflow needs a staged review
- send timing is intentionally delayed
- the user wants lower-level control over draft lifecycle

## MCP Annotations To Inspect

When reading `tools/list`, inspect:

- `riskLevel`
- `sideEffecting`
- `humanReviewRequired`
- `composite`
- `supportsPartialAuthorization`
- `sendAdditionalScopes`
- `recommendedForMailboxAgents`

## Stable Error Codes

Branch on these families instead of free-form text:

- `auth_unauthorized`
- `auth_missing_scope`
- `access_tenant_denied`
- `access_agent_denied`
- `access_mailbox_denied`
- `invalid_arguments`
- `insufficient_credits`
- `daily_quota_exceeded`
- `hourly_quota_exceeded`
- `resource_message_not_found`
- `resource_draft_not_found`
- `idempotency_conflict`
- `idempotency_in_progress`
- `tool_internal_error`

## Suggested Agent Behavior

- `auth_missing_scope`: stop and request broader authorization
- `access_mailbox_denied`: stop and request mailbox approval or a different token
- `resource_*_not_found`: refresh identifiers or upstream state
- `idempotency_in_progress`: retry after a short delay
- `idempotency_conflict`: treat as a different logical request unless the same
  logical send is intentionally being retried
- `insufficient_credits`: inspect billing state before attempting another send

## Side-Effect Rules

- Always include an `idempotencyKey` on retryable sends and replies.
- Reuse the same `idempotencyKey` for the same logical send.
- Read state before sending when mailbox or thread context is uncertain.
- Do not treat replay as implicit permission to send a new outbound message.

## Relevant Repo Docs

- `docs/mcp-local.md`
- `docs/agent-capabilities.json`
- `docs/runtime-compatibility.md`
