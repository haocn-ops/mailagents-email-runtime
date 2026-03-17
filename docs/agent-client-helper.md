# Agent Client Helper

This repository includes a minimal TypeScript helper for external agent
integrations:

- [tools/agent_client.ts](/Users/zh/Documents/codeX/mailagents_cloudflare2/tools/agent_client.ts)

It is intentionally lightweight:

- no package publishing
- no generated types
- no build step required inside this repository
- just a small wrapper around `fetch`

## What It Covers

- `getRuntimeMetadata()`
- `getCompatibilityContract()`
- `getCompatibilitySchema()`
- `listTools()`
- `callTool()`
- convenience helpers for:
  - `createDraft()`
  - `sendDraft()`
  - `replyToInboundEmail()`

## Why This Exists

The goal is to reduce boilerplate for agent builders who would otherwise start
from raw `curl` or handcrafted JSON-RPC payloads.

It is best treated as:

- a reference implementation
- a copyable starting point
- a basis for a future published SDK

## Example

```ts
import { MailagentsAgentClient } from "../tools/agent_client";

const client = new MailagentsAgentClient({
  baseUrl: "https://mailagents-dev.izhenghaocn.workers.dev",
  token: process.env.MAILAGENTS_TOKEN,
});

const contract = await client.getCompatibilityContract();
const tools = await client.listTools();

console.log(contract, tools);
```

Runnable repository examples:

- `npm run example:agent:discover`
- `npm run example:agent:reply-draft`
- `npm run example:agent:operator-send`

Expected environment variables:

- `MAILAGENTS_TOKEN`
- optional `MAILAGENTS_BASE_URL`
- `MAILAGENTS_AGENT_ID` for the reply example
- `MAILAGENTS_AGENT_ID` for the operator-send example

## Suggested Next Step

If this helper proves useful, the next natural evolution is:

- split types into a dedicated package
- add typed result models for common MCP tools
- publish a small npm client for external integrators
