# `@mailagents/agent-client`

Minimal TypeScript client skeleton for the Mailagents Email Runtime.

Current scope:

- runtime discovery
- compatibility contract lookup
- MCP `tools/list`
- MCP `tools/call`
- typed models for discovery and high-value draft/send workflows
- mailbox-first convenience helpers for common read, send, and reply flows
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
const recommended = await client.listRecommendedMailboxTools();

console.log(contract, tools, recommended);
```

Typed helpers currently cover:

- `getRuntimeMetadata()`
- `getCompatibilityContract()`
- `listTools()`
- `listRecommendedMailboxTools()`
- `createAgent()`
- `bindMailbox()`
- `listAgentTasks()`
- `listMessages()`
- `getMessage()`
- `getMessageContent()`
- `getThread()`
- `sendEmail()`
- `replyToMessage()`
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
  await client.sendEmail({
    to: ["user@example.com"],
    subject: "Hello from the mailbox-first helper",
    text: "Sent through the high-level helper method.",
    idempotencyKey: "send:demo:001",
  });
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

- [CHANGELOG.md](./CHANGELOG.md)
- [docs/agent-client-versioning.md](../../docs/agent-client-versioning.md)
- [docs/agent-client-release-notes-0.1.0.md](../../docs/agent-client-release-notes-0.1.0.md)

Publish preparation:

- `npm run check:agent-client`
- `npm run build:agent-client`
- `npm run pack:agent-client:dry-run`
- after removing `private: true`, `npm run publish:agent-client:dry-run`
