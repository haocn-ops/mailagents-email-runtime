import { MailagentsAgentClient } from "../packages/mailagents-agent-client/dist/index.js";

const baseUrl = process.env.MAILAGENTS_BASE_URL ?? "https://mailagents-dev.izhenghaocn.workers.dev";
const adminSecret = process.env.MAILAGENTS_ADMIN_SECRET;
const tenantId = process.env.MAILAGENTS_TENANT_ID;
const decision = process.env.MAILAGENTS_REVIEW_DECISION;

if (!adminSecret || !tenantId) {
  console.error("MAILAGENTS_ADMIN_SECRET and MAILAGENTS_TENANT_ID are required");
  process.exit(1);
}

const client = new MailagentsAgentClient({ baseUrl, adminSecret });
const result = await client.adminReviewTenantOutboundAccessWorkflow({
  tenantId,
  receiptsLimit: 5,
  decision: decision || undefined,
});

console.log(JSON.stringify({
  tenantId: result.context.tenantId,
  currentOutboundStatus: result.context.sendPolicy.outboundStatus,
  effectiveOutboundStatus: result.effectiveSendPolicy.outboundStatus,
  suggestedActions: result.suggestedActions,
  decision: result.decision ?? null,
  decisionMessage: result.decisionResult?.message ?? null,
  pendingReceiptCount: result.context.summary.pendingReceiptCount,
}, null, 2));
