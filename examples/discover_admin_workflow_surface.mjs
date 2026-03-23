import { MailagentsAgentClient } from "../packages/mailagents-agent-client/dist/index.js";

const baseUrl = process.env.MAILAGENTS_BASE_URL ?? "https://mailagents-dev.izhenghaocn.workers.dev";
const adminSecret = process.env.MAILAGENTS_ADMIN_SECRET;

if (!adminSecret) {
  console.error("MAILAGENTS_ADMIN_SECRET is required");
  process.exit(1);
}

const client = new MailagentsAgentClient({ baseUrl, adminSecret });
const workflowSurface = await client.getAdminWorkflowSurface();

console.log(JSON.stringify({
  adminMcpPath: workflowSurface.metadata.path,
  workflowNames: workflowSurface.workflows.map((workflow) => workflow.name),
  compositeTools: workflowSurface.compositeTools.map((tool) => tool.name),
  categoryCounts: {
    tokenAdmin: workflowSurface.tokenAdmin.length,
    registryAdmin: workflowSurface.registryAdmin.length,
    policyAdmin: workflowSurface.policyAdmin.length,
    debug: workflowSurface.debug.length,
    suppression: workflowSurface.suppression.length,
  },
  workflows: workflowSurface.workflows.map((workflow) => ({
    name: workflow.name,
    compositeTool: workflow.compositeTool,
    categories: workflow.categories,
    recommendedToolSequence: workflow.recommendedToolSequence,
    stopConditions: workflow.stopConditions,
  })),
}, null, 2));
