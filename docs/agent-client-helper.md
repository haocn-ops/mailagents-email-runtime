# Agent Client Helper

This repository includes a minimal TypeScript helper for external agent
integrations:

- [tools/agent_client.ts](../tools/agent_client.ts)
- [packages/mailagents-agent-client/src/index.ts](../packages/mailagents-agent-client/src/index.ts)

It is intentionally lightweight:

- package skeleton included
- no generated types
- no build step required inside this repository
- just a small wrapper around `fetch`
- repository helper now re-exports the package source to keep one implementation path

## What It Covers

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
- `getAdminMcpMetadata()`
- `getAdminWorkflowSurface()`
- `MailagentsOperatorClient`
- `MailagentsOperatorMailboxSession`
- `getCapabilitySurface()`
- `getWorkflowSurface()`
- `mintAccessToken()`
- `bootstrapMailboxAgent()`
- `openMailboxSession()`
- `reviewTenantOutboundAccess()`
- `inspectDeliveryCase()`
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
- `replyLatestInbound()`
- `callTool()`
- convenience helpers for:
  - `listTasks()`
  - `listMessages()`
  - `getMessage()`
  - `getMessageContent()`
  - `getThread()`
  - `sendMessage()`
  - `sendEmail()`
  - `replyToMessage()`
  - `createDraft()`
  - `getDraft()`
  - `sendDraft()`
  - `replayMessage()`
  - `replyToInboundEmail()`

## Why This Exists

The goal is to reduce boilerplate for agent builders who would otherwise start
from raw `curl` or handcrafted JSON-RPC payloads.

For operator agents, the helper can also hold an `adminSecret` and talk to the
separate `/admin/mcp` surface without mixing those calls into the normal bearer
token workflow.

If you want a narrower operator-facing entrypoint, use `client.operator()` to
switch into the typed `MailagentsOperatorClient` facade. That wrapper groups
runtime discovery, admin workflow discovery, mailbox-agent bootstrap, tenant
review, and delivery forensics under one admin-oriented surface.

If the operator flow ends in a mailbox-scoped bearer token, prefer
`operator.openMailboxSession()`. It returns a
`MailagentsOperatorMailboxSession` that already carries the bootstrap metadata,
recommended mailbox workflow, and a mailbox-scoped client for read/send/reply
helpers.

When admin routes are enabled, `getCompatibilityContract()` also carries an
optional `admin.mcp` section so SDK users can discover admin workflow packs
from the narrower compatibility contract before switching to admin MCP calls.

It is best treated as:

- a reference implementation
- a copyable starting point
- a basis for a future published SDK
- a package skeleton you can promote into a real npm client

## Example

```ts
import { MailagentsAgentClient } from "../tools/agent_client";

const client = new MailagentsAgentClient({
  baseUrl: "https://mailagents-dev.izhenghaocn.workers.dev",
  token: process.env.MAILAGENTS_TOKEN,
});

const mailbox = await client.getSelfMailbox();
const contract = await client.getCompatibilityContract();
const tasks = await client.listTasks();
const messages = await client.listMessages({ limit: 10, direction: "inbound" });

console.log(mailbox, contract, tasks, messages);
```

For mailbox-scoped agents, the default helper path is:

1. `publicSignup()`
2. `getSelfMailbox()`
3. `listTasks()` or `getMailboxWorkflowSurface()`
4. `listMessages()`
5. `sendMessage()` or `sendEmail()`
6. `replyLatestInbound()` or `replyToMessage()`

Use `createDraft()` and `sendDraft()` only when the workflow needs explicit
draft lifecycle control.

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

Expected environment variables:

- `MAILAGENTS_TOKEN`
- optional `MAILAGENTS_BASE_URL`
- `MAILAGENTS_AGENT_ID` for the reply example
- `MAILAGENTS_AGENT_ID` for the operator-send example

Package skeleton:

- [packages/mailagents-agent-client/package.json](../packages/mailagents-agent-client/package.json)
- [packages/mailagents-agent-client/README.md](../packages/mailagents-agent-client/README.md)
- run `npx tsc -p packages/mailagents-agent-client/tsconfig.json --noEmit` to check it
- or use `npm run check:agent-client`
- or use `npm run build:agent-client`

## Suggested Next Step

If this helper proves useful, the next natural evolution is:

- split types into a dedicated package
- add typed result models for more runtime objects
- publish a small npm client for external integrators

For the release-oriented next step, see
[docs/agent-client-release.md](../docs/agent-client-release.md).
