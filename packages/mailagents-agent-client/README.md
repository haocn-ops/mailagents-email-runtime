# `@mailagents/agent-client`

Minimal TypeScript client skeleton for the Mailagents Email Runtime.

Current scope:

- runtime discovery
- compatibility contract lookup
- MCP `tools/list`
- MCP `tools/call`
- a few convenience helpers for common draft and reply flows

## Status

- package skeleton only
- not published
- intended as a starting point for a future npm package

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
