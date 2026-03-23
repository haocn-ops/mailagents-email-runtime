import { MailagentsAgentClient } from "../packages/mailagents-agent-client/dist/index.js";

const baseUrl = process.env.MAILAGENTS_BASE_URL ?? "https://mailagents-dev.izhenghaocn.workers.dev";
const adminSecret = process.env.MAILAGENTS_ADMIN_SECRET;

if (!adminSecret) {
  console.error("MAILAGENTS_ADMIN_SECRET is required");
  process.exit(1);
}

const client = new MailagentsAgentClient({ baseUrl, adminSecret });
const runtime = await client.getRuntimeMetadata();
const compatibility = await client.getCompatibilityContract();
const adminMcp = await client.getAdminMcpMetadata();
const tools = await client.listAdminTools();

console.log(JSON.stringify({
  adminMcpPath: runtime.api.adminMcpPath ?? null,
  compatibilityAdminPath: compatibility.admin?.mcp.path ?? null,
  adminEnabled: runtime.routes.adminEnabled,
  debugEnabled: runtime.routes.debugEnabled,
  workflowNames: adminMcp.workflows.map((workflow) => workflow.name),
  compatibilityWorkflowNames: compatibility.admin?.mcp.workflows.map((workflow) => workflow.name) ?? [],
  adminTools: tools.tools.map((tool) => ({
    name: tool.name,
    category: tool.annotations.category,
    riskLevel: tool.annotations.riskLevel,
    humanReviewRequired: tool.annotations.humanReviewRequired,
  })),
}, null, 2));
