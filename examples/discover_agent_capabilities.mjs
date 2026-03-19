import { MailagentsAgentClient } from "../packages/mailagents-agent-client/dist/index.js";

const baseUrl = process.env.MAILAGENTS_BASE_URL ?? "https://mailagents-dev.izhenghaocn.workers.dev";
const token = process.env.MAILAGENTS_TOKEN;

if (!token) {
  console.error("MAILAGENTS_TOKEN is required");
  process.exit(1);
}

const client = new MailagentsAgentClient({ baseUrl, token });
const compatibility = await client.getCompatibilityContract();
const tools = await client.listTools();

console.log(JSON.stringify({
  compatibilityVersion: compatibility.contract.version,
  stableErrorCodes: compatibility.guarantees.stableErrorCodes,
  visibleTools: tools.tools.map((tool) => ({
    name: tool.name,
    riskLevel: tool.annotations?.riskLevel,
    humanReviewRequired: tool.annotations?.humanReviewRequired,
    sendAdditionalScopes: tool.annotations?.sendAdditionalScopes ?? [],
  })),
}, null, 2));
