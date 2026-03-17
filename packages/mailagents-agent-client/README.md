# `@mailagents/agent-client`

Minimal TypeScript client skeleton for the Mailagents Email Runtime.

Current scope:

- runtime discovery
- compatibility contract lookup
- MCP `tools/list`
- MCP `tools/call`
- typed models for discovery and high-value draft/send workflows
- a few convenience helpers for common draft and reply flows
- stable error-code helpers for branching on MCP failures

## Status

- package skeleton only
- not published
- intended as a starting point for a future npm package
- package-local changelog available in `CHANGELOG.md`

## Example

```ts
import { MailagentsAgentClient } from "@mailagents/agent-client";

const client = new MailagentsAgentClient({
  baseUrl: "https://mailagents-dev.izhenghaocn.workers.dev",
  token: process.env.MAILAGENTS_TOKEN,
});

const contract = await client.getCompatibilityContract();
const tools = await client.listTools();

console.log(contract, tools);
```

Typed helpers currently cover:

- `getRuntimeMetadata()`
- `getCompatibilityContract()`
- `listTools()`
- `createAgent()`
- `bindMailbox()`
- `listAgentTasks()`
- `getMessage()`
- `getMessageContent()`
- `getThread()`
- `createDraft()`
- `sendDraft()`
- `replyToInboundEmail()`
- `operatorManualSend()`

Error helpers currently cover:

- `STABLE_MAILAGENTS_ERROR_CODES`
- `isMailagentsClientError()`
- `hasMailagentsErrorCode()`
- `isRetryableMailagentsError()`

Example:

```ts
import {
  MailagentsAgentClient,
  hasMailagentsErrorCode,
  isRetryableMailagentsError,
} from "@mailagents/agent-client";

const client = new MailagentsAgentClient({
  baseUrl: "https://mailagents-dev.izhenghaocn.workers.dev",
  token: process.env.MAILAGENTS_TOKEN,
});

try {
  await client.sendDraft("draft_123", "send:demo:001");
} catch (error) {
  if (hasMailagentsErrorCode(error, "idempotency_conflict")) {
    console.log("Do not retry with a different logical request.");
  } else if (isRetryableMailagentsError(error)) {
    console.log("Safe to retry after a short delay.");
  } else {
    throw error;
  }
}
```

Release tracking:

- [CHANGELOG.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/packages/mailagents-agent-client/CHANGELOG.md)
