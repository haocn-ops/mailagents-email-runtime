# Agent Client Helper

This repository includes a minimal TypeScript helper for external agent
integrations:

- [tools/agent_client.ts](/Users/zh/Documents/codeX/mailagents_cloudflare2/tools/agent_client.ts)
- [packages/mailagents-agent-client/src/index.ts](/Users/zh/Documents/codeX/mailagents_cloudflare2/packages/mailagents-agent-client/src/index.ts)

It is intentionally lightweight:

- package skeleton included
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
- a package skeleton you can promote into a real npm client

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

Package skeleton:

- [packages/mailagents-agent-client/package.json](/Users/zh/Documents/codeX/mailagents_cloudflare2/packages/mailagents-agent-client/package.json)
- [packages/mailagents-agent-client/README.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/packages/mailagents-agent-client/README.md)
- run `npx tsc -p packages/mailagents-agent-client/tsconfig.json --noEmit` to check it
- or use `npm run check:agent-client`
- or use `npm run build:agent-client`

## Suggested Next Step

If this helper proves useful, the next natural evolution is:

- split types into a dedicated package
- add typed result models for common MCP tools
- publish a small npm client for external integrators

For the release-oriented next step, see
[docs/agent-client-release.md](/Users/zh/Documents/codeX/mailagents_cloudflare2/docs/agent-client-release.md).
