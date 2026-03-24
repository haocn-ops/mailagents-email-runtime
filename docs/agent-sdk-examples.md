# Agent SDK Examples

This page collects the smallest useful integration examples for external
agents, SDKs, and hosted orchestration systems.

Use it together with:

- [docs/ai-onboarding.md](../docs/ai-onboarding.md)
- [docs/runtime-compatibility.md](../docs/runtime-compatibility.md)
- [docs/mcp-local.md](../docs/mcp-local.md)
- [docs/agent-client-helper.md](../docs/agent-client-helper.md)

## 1. Discover Runtime Capabilities

Read the high-level runtime metadata:

```bash
curl -sS https://mailagents-dev.izhenghaocn.workers.dev/v2/meta/runtime | jq
```

Read the narrower compatibility contract:

```bash
curl -sS https://mailagents-dev.izhenghaocn.workers.dev/v2/meta/compatibility | jq
```

Read the JSON Schema for contract validation:

```bash
curl -sS https://mailagents-dev.izhenghaocn.workers.dev/v2/meta/compatibility/schema | jq
```

Read the pinned repository snapshot:

```bash
cat docs/agent-capabilities.json | jq
```

Recommended usage:

- use `/v2/meta/runtime` for richer environment-aware discovery
- use `/v2/meta/compatibility` for long-lived branching logic
- when admin routes are enabled, read `admin.mcp` from `/v2/meta/compatibility` for stable operator-workflow discovery
- use `/v2/meta/compatibility/schema` in CI or SDK validation
- use `docs/agent-capabilities.json` as a fixed admin-enabled example fixture when live calls are not desirable

## 2. Obtain a Scoped Bearer Token

For signup API onboarding, call `POST /public/signup` first and store the
returned mailbox-scoped bearer token from the signup response.

If that token expires later, call `POST /public/token/reissue`. The runtime
will only email the refreshed token to the original `operatorEmail` from signup;
it will not return the new token inline to the caller.

If the current signup API token is still valid and the agent wants to rotate it
without emailing the operator, call `POST /v1/auth/token/rotate`. That
authenticated route can return the rotated token inline, deliver it back to the
mailbox itself, or do both.

Use `POST /v1/auth/tokens` when you need a broader operator token, an
operator-provisioned workflow, or an environment where the mailbox was created
outside the signup API path.

Admin minting requires `x-admin-secret` and admin routes enabled in the environment.

```bash
curl -sS -X POST https://mailagents-dev.izhenghaocn.workers.dev/v1/auth/tokens \
  -H 'content-type: application/json' \
  -H 'x-admin-secret: REPLACE_WITH_ADMIN_SECRET' \
  -d '{
    "sub": "external-agent",
    "tenantId": "t_demo",
    "scopes": ["mail:read", "task:read", "draft:create", "draft:read", "draft:send"],
    "mailboxIds": ["mbx_demo"],
    "expiresInSeconds": 3600
  }'
```

Prefer:

- mailbox-scoped tokens
- short expirations
- only the scopes needed for the planned workflow

With a mailbox-scoped token, newer self routes remove the need to keep passing
`tenantId`, `mailboxId`, and `agentId` for common read and send operations.

Example:

```bash
curl -sS https://api.mailagents.net/v1/mailboxes/self \
  -H "authorization: Bearer $TOKEN" | jq

curl -sS 'https://api.mailagents.net/v1/mailboxes/self/messages?limit=10' \
  -H "authorization: Bearer $TOKEN" | jq
```

## 3. Discover MCP Tools

```bash
curl -sS https://mailagents-dev.izhenghaocn.workers.dev/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list",
    "params": {}
  }' | jq
```

Important fields in `tools/list`:

- `annotations.riskLevel`
- `annotations.sideEffecting`
- `annotations.humanReviewRequired`
- `annotations.supportsPartialAuthorization`
- `annotations.sendAdditionalScopes`

For composite tools:

- `requiredScopes` means the minimum needed to use the tool at all
- `sendAdditionalScopes` means the extra scopes needed for delivery behavior

For operator agents using `/admin/mcp`, prefer workflow-pack discovery before
planning from raw admin tools alone:

- `npm run example:agent:discover-admin`
- `npm run example:agent:admin-workflows`
- `npm run example:agent:operator-client`
- `npm run example:agent:admin-bootstrap`
- `npm run example:agent:admin-review`
- `npm run example:agent:admin-forensics`
- [docs/admin-mcp.md](../docs/admin-mcp.md)
- [docs/admin-workflow-packs.md](../docs/admin-workflow-packs.md)

If the admin flow ends in a mailbox-scoped token, prefer the SDK handoff
through `operator.openMailboxSession()` so the rest of the workflow can stay on
the mailbox-first read/send/reply helpers.

## 4. Read Before Acting

Safe read-only sequence for inbound handling:

```bash
curl -sS https://mailagents-dev.izhenghaocn.workers.dev/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "get_message",
      "arguments": {
        "messageId": "msg_demo_inbound"
      }
    }
  }'
```

Then optionally:

- `get_message_content`
- `get_thread`
- `list_agent_tasks`
- `list_messages`

## 5. Use the High-Level Send and Reply Routes First

For mailbox-scoped agents that do not need explicit draft lifecycle control,
you can now use the higher-level send routes directly:

```bash
curl -sS -X POST https://api.mailagents.net/v1/messages/send \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "to": ["user@example.com"],
    "subject": "Hello from Mailagents",
    "text": "Sent through the high-level send route.",
    "idempotencyKey": "sdk-send-001"
  }' | jq
```

Reply to an inbound message in one request:

```bash
curl -sS -X POST https://api.mailagents.net/v1/messages/msg_demo_inbound/reply \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "text": "Thanks for your message.",
    "idempotencyKey": "sdk-reply-001"
  }' | jq
```

The MCP equivalents are now available too:

```bash
curl -sS https://api.mailagents.net/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2.5,
    "method": "tools/call",
    "params": {
      "name": "send_email",
      "arguments": {
        "to": ["user@example.com"],
        "subject": "Hello from MCP",
        "text": "Sent through the MCP high-level send tool.",
        "idempotencyKey": "sdk-mcp-send-001"
      }
    }
  }' | jq
```

```bash
curl -sS https://api.mailagents.net/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2.75,
    "method": "tools/call",
    "params": {
      "name": "reply_to_message",
      "arguments": {
        "messageId": "msg_demo_inbound",
        "text": "Thanks for your message.",
        "idempotencyKey": "sdk-mcp-reply-001"
      }
    }
  }' | jq
```

List mailbox messages directly through MCP:

```bash
curl -sS https://api.mailagents.net/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2.9,
    "method": "tools/call",
    "params": {
      "name": "list_messages",
      "arguments": {
        "limit": 10,
        "direction": "inbound"
      }
    }
  }' | jq
```

## 6. Fall Back to Explicit Drafts Only When Needed

Use explicit draft creation only when your workflow needs a visible review step
or wants to control the draft lifecycle directly. For mailbox-scoped tokens,
`create_draft` can now infer mailbox context automatically, so you should not
pass `agentId`, `tenantId`, `mailboxId`, or `from` unless you are intentionally
using a broader operator token.

Create a draft directly:

```bash
curl -sS https://mailagents-dev.izhenghaocn.workers.dev/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "create_draft",
      "arguments": {
        "to": ["user@example.com"],
        "subject": "Hello from Mailagents",
        "text": "Draft created through MCP."
      }
    }
  }'
```

Send it idempotently:

```bash
curl -sS https://mailagents-dev.izhenghaocn.workers.dev/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "send_draft",
      "arguments": {
        "draftId": "REPLACE_WITH_DRAFT_ID",
        "idempotencyKey": "sdk-send-001"
      }
    }
  }'
```

Cancel it if your workflow decides not to send:

```bash
curl -sS https://mailagents-dev.izhenghaocn.workers.dev/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4.5,
    "method": "tools/call",
    "params": {
      "name": "cancel_draft",
      "arguments": {
        "draftId": "REPLACE_WITH_DRAFT_ID"
      }
    }
  }'
```

## 7. Use Composite Workflows

Reply to inbound mail without sending:

```bash
curl -sS https://mailagents-dev.izhenghaocn.workers.dev/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 5,
    "method": "tools/call",
    "params": {
      "name": "reply_to_inbound_email",
      "arguments": {
        "agentId": "agt_demo",
        "messageId": "msg_demo_inbound",
        "replyText": "Thanks for your message."
      }
    }
  }'
```

Reply and send with explicit idempotency:

```bash
curl -sS https://mailagents-dev.izhenghaocn.workers.dev/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 6,
    "method": "tools/call",
    "params": {
      "name": "reply_to_inbound_email",
      "arguments": {
        "agentId": "agt_demo",
        "messageId": "msg_demo_inbound",
        "replyText": "Thanks for your message.",
        "send": true,
        "idempotencyKey": "sdk-reply-001"
      }
    }
  }'
```

Operator-guided manual send:

```bash
curl -sS https://mailagents-dev.izhenghaocn.workers.dev/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 7,
    "method": "tools/call",
    "params": {
      "name": "operator_manual_send",
      "arguments": {
        "agentId": "agt_demo",
        "tenantId": "t_demo",
        "mailboxId": "mbx_demo",
        "from": "agent@mail.example.com",
        "to": ["user@example.com"],
        "subject": "Operator send",
        "text": "Sent through operator_manual_send.",
        "send": true,
        "idempotencyKey": "sdk-manual-send-001"
      }
    }
  }'
```

## 8. Branch on Stable Error Codes

Tool errors are returned in:

- `result.structuredContent.error.code`

Example categories you can branch on safely:

- auth: `auth_unauthorized`, `auth_missing_scope`
- access: `access_tenant_denied`, `access_agent_denied`, `access_mailbox_denied`
- resource: `resource_message_not_found`, `resource_thread_not_found`, `resource_draft_not_found`
- idempotency: `idempotency_conflict`, `idempotency_in_progress`

Suggested agent behavior:

- on `auth_missing_scope`, stop and request broader authorization
- on `access_mailbox_denied`, stop and request mailbox-scoped approval
- on `resource_*_not_found`, stop and refresh identifiers
- on `idempotency_in_progress`, retry after a short delay
- on `idempotency_conflict`, treat it as a new logical request or investigate caller reuse

## 9. Minimal TypeScript Example

```ts
type CompatibilityContract = {
  contract: { name: string; version: string; stability: string };
  guarantees: { stableErrorCodes: string[] };
};

async function readCompatibility(baseUrl: string): Promise<CompatibilityContract> {
  const response = await fetch(`${baseUrl}/v2/meta/compatibility`);
  if (!response.ok) {
    throw new Error(`Compatibility lookup failed: ${response.status}`);
  }
  return response.json() as Promise<CompatibilityContract>;
}

async function listTools(baseUrl: string, token: string) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });
  const payload = await response.json();
  return payload.result.tools;
}
```

If you want a copyable wrapper instead of starting from raw `fetch`, see
[docs/agent-client-helper.md](../docs/agent-client-helper.md).

If you want runnable repository examples, use:

- `npm run example:agent:discover`
- `npm run example:agent:reply-draft`
- `npm run example:agent:operator-send`

## 10. Recommended External-Agent Pattern

For long-lived integrations:

1. read `/v2/meta/compatibility`
2. validate the response against `/v2/meta/compatibility/schema`
3. obtain a least-privilege token, usually from `POST /public/signup`
4. call `tools/list`
5. plan with `riskLevel`, `humanReviewRequired`, and `sendAdditionalScopes`
6. prefer read calls before side effects
7. prefer `list_messages`, `send_email`, and `reply_to_message` for mailbox-scoped flows
8. use `idempotencyKey` on all retryable side-effecting sends or replays
9. branch only on stable error codes from the compatibility contract
