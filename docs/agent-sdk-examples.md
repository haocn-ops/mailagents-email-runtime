# Agent SDK Examples

This page collects the smallest useful integration examples for external
agents, SDKs, and hosted orchestration systems.

Use it together with:

- [docs/ai-onboarding.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/ai-onboarding.md)
- [docs/runtime-compatibility.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/runtime-compatibility.md)
- [docs/mcp-local.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/mcp-local.md)

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

Recommended usage:

- use `/v2/meta/runtime` for richer environment-aware discovery
- use `/v2/meta/compatibility` for long-lived branching logic
- use `/v2/meta/compatibility/schema` in CI or SDK validation

## 2. Mint a Scoped Bearer Token

This requires `x-admin-secret` and admin routes enabled in the environment.

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

## 5. Draft Before Send

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
        "agentId": "agt_demo",
        "tenantId": "t_demo",
        "mailboxId": "mbx_demo",
        "from": "agent@mail.example.com",
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

## 6. Use Composite Workflows

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

## 7. Branch on Stable Error Codes

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

## 8. Minimal TypeScript Example

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

## 9. Recommended External-Agent Pattern

For long-lived integrations:

1. read `/v2/meta/compatibility`
2. validate the response against `/v2/meta/compatibility/schema`
3. mint a least-privilege token
4. call `tools/list`
5. plan with `riskLevel`, `humanReviewRequired`, and `sendAdditionalScopes`
6. prefer read calls before side effects
7. use `idempotencyKey` on all retryable side-effecting sends or replays
8. branch only on stable error codes from the compatibility contract
