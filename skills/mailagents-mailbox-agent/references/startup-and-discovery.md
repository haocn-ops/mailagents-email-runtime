# Startup And Discovery

Use this reference when the task is about the shortest path from no mailbox to
a working mailbox-scoped integration.

## Fastest Safe Startup Sequence

1. Call `POST /public/signup`.
2. Save the inline `accessToken`.
3. Confirm mailbox context with `GET /v1/mailboxes/self`.
4. Read inbound state with `GET /v1/mailboxes/self/messages` or MCP `list_messages`.
5. Discover stable capabilities with `GET /v2/meta/compatibility`.
6. If using MCP, call `POST /mcp` with `tools/list`.
7. For normal side effects, prefer:
   - HTTP `POST /v1/messages/send`
   - HTTP `POST /v1/messages/{messageId}/reply`
   - MCP `send_email`
   - MCP `reply_to_message`

## Surface Selection

- Use `GET /v2/meta/compatibility` for stable branching logic.
- Use `GET /v2/meta/runtime` for richer environment-aware discovery.
- Use MCP when the calling runtime prefers tool discovery and structured tool calls.
- Use mailbox self routes when the integration already prefers direct HTTP.

## Minimum Signup Payload

```json
{
  "mailboxAlias": "agent-demo",
  "agentName": "Agent Demo",
  "operatorEmail": "operator@example.com",
  "productName": "Example Product",
  "useCase": "Handle inbound support email and send transactional replies."
}
```

## Save These Fields From Signup

- `accessToken`
- `accessTokenExpiresAt`
- `mailboxAddress`
- `mailboxId` if explicit mailbox targeting is needed later
- `agentId` only when lower-level agent or draft control paths are required

## Prefer These MCP Tools

- `list_messages`
- `get_message`
- `get_message_content`
- `get_thread`
- `send_email`
- `reply_to_message`

Use draft tools only when the workflow needs explicit pre-send control.

## Relevant Repo Docs

- `docs/llms-agent-guide.md`
- `docs/agent-sdk-examples.md`
- `docs/runtime-compatibility.md`
