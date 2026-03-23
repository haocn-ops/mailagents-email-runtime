# `@mailagents/agent-client`

Minimal TypeScript client skeleton for the Mailagents Email Runtime.

Current scope:

- runtime discovery
- compatibility contract lookup
- mailbox self-route helpers
- MCP `tools/list`
- MCP `tools/call`
- typed models for discovery and high-value REST + MCP mail workflows
- admin MCP helpers for operator agents
- mailbox-first convenience helpers for common read, send, and reply flows
- stable error-code helpers for branching on MCP failures

## Status

- lightweight in-repo package
- not published
- intended as a starting point for a future npm package
- package-local changelog available in `CHANGELOG.md`

## Example

```ts
import { MailagentsAgentClient } from "@mailagents/agent-client";

const client = new MailagentsAgentClient({
  baseUrl: "https://api.mailagents.net",
});

const signup = await client.publicSignup({
  productName: "Example Agent",
  operatorEmail: "operator@example.com",
  useCase: "Mailbox-first agent integration",
});

const authed = client.withToken(signup.accessToken!);
const mailbox = await authed.getSelfMailbox();
const contract = await authed.getCompatibilityContract();
const tasks = await authed.listTasks();
const messages = await authed.listMessages({ limit: 5, direction: "inbound" });
const sendResult = await authed.sendMessage({
  to: ["user@example.com"],
  subject: "Hello from Mailagents",
  text: "Sent through the high-level HTTP helper.",
  idempotencyKey: "sdk-send-001",
});

console.log(mailbox.address, contract, tasks.items.length, messages.items.length, sendResult.outboundJobId);
```

Typed helpers currently cover:

- `getRuntimeMetadata()`
- `getCompatibilityContract()`
- `getCompatibilitySchema()`
- `publicSignup()`
- `reissueAccessToken()`
- `createAccessToken()`
- `adminCreateAccessToken()`
- `adminBootstrapMailboxAgentToken()`
- `adminBootstrapMailboxAgentWorkflow()`
- `rotateAccessToken()`
- `rotateToken()`
- `withAdminSecret()`
- `operator()`
- `MailagentsOperatorClient`
- `MailagentsOperatorMailboxSession`
- `getCapabilitySurface()`
- `getWorkflowSurface()`
- `mintAccessToken()`
- `bootstrapMailboxAgent()`
- `openMailboxSession()`
- `reviewTenantOutboundAccess()`
- `inspectDeliveryCase()`
- `getAdminMcpMetadata()`
- `getAdminWorkflowSurface()`
- `listAdminTools()`
- `callAdminTool()`
- `adminListAgents()`
- `adminGetAgent()`
- `adminListMailboxes()`
- `adminGetMailbox()`
- `adminGetTenantSendPolicy()`
- `adminUpsertTenantSendPolicy()`
- `adminApplyTenantSendPolicyReview()`
- `adminGetTenantReviewContext()`
- `adminReviewTenantOutboundAccessWorkflow()`
- `adminGetDebugMessage()`
- `adminGetDebugDraft()`
- `adminGetDebugOutboundJob()`
- `adminInspectDeliveryCase()`
- `adminInspectDeliveryCaseWorkflow()`
- `adminGetSuppression()`
- `adminAddSuppression()`
- `getSelfMailbox()`
- `listTools()`
- `listRecommendedMailboxTools()`
- `getMailboxWorkflowSurface()`
- `createAgent()`
- `bindMailbox()`
- `listAgentTasks()`
- `listTasks()`
- `listSelfMailboxTasks()`
- `listSelfMailboxMessages()`
- `getSelfMailboxMessage()`
- `getSelfMailboxMessageContent()`
- `listMessages()`
- `getMessage()`
- `getMessageContent()`
- `getThread()`
- `sendMessage()`
- `sendSelfMailboxMessage()`
- `sendEmail()`
- `replyToMessage()`
- `replyLatestInbound()`
- `createDraft()`
- `getDraft()`
- `sendDraft()`
- `replayMessage()`
- `replyToInboundEmail()`
- `operatorManualSend()`

Runnable repository examples:

- `npm run example:agent:discover`
- `npm run example:agent:discover-admin`
- `npm run example:agent:admin-workflows`
- `npm run example:agent:operator-client`
- `npm run example:agent:admin-bootstrap`
- `npm run example:agent:admin-review`
- `npm run example:agent:admin-forensics`
- `npm run example:agent:mailbox-first`
- `npm run example:agent:reply-draft`
- `npm run example:agent:operator-send`

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
  const sendResult = await client.sendEmail({
    to: ["user@example.com"],
    subject: "Hello from the mailbox-first helper",
    text: "Sent through the high-level helper method.",
    idempotencyKey: "send:demo:001",
  });

  const replyResult = await client.replyLatestInbound({
    text: "Thanks for the inbound message.",
    idempotencyKey: "reply:latest:001",
  });

  console.log(sendResult.draft.id, replyResult.sourceMessageId);
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
- `npm_config_cache=/tmp/mailagents-npm-cache npm run publish:agent-client:dry-run`

Notes:

- `listMessages()` now prefers `GET /v1/mailboxes/self/messages` for mailbox-scoped flows and falls back to MCP only when an explicit `mailboxId` is supplied
- `getMessageContent()` and `getThread()` now use the documented HTTP read routes
- `createDraft()`, `getDraft()`, `sendDraft()`, and `listAgentTasks()` use the matching REST routes
- `sendEmail()` now prefers `POST /v1/messages/send` for mailbox-scoped flows and falls back to MCP only when an explicit `mailboxId` is supplied
- `replyToMessage()` uses `POST /v1/messages/{messageId}/reply`, while `callTool()` remains available for direct MCP access
- `withAdminSecret()`, `listAdminTools()`, and `callAdminTool()` target the separate `/admin/mcp` surface for operator-only workflows
- `getAdminMcpMetadata()` and `getAdminWorkflowSurface()` let operator agents discover workflow packs rather than planning only from raw admin tools
- the workflow helpers wrap common operator flows so an agent can execute bootstrap, tenant review, and delivery forensics without reassembling each step manually
- `operator()` returns a typed `MailagentsOperatorClient` facade so operator agents can stay on an admin-oriented surface instead of mixing raw `admin*` helper calls with mailbox helpers
- `openMailboxSession()` turns mailbox-agent bootstrap into a ready-to-use `MailagentsOperatorMailboxSession`, so operator flows can pivot directly into mailbox-scoped read/send/reply helpers
- `getCompatibilityContract()` now carries `admin.mcp` when admin routes are enabled, giving a narrower stable discovery path for admin workflow packs
