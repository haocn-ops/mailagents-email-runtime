import { MailagentsAgentClient } from "../packages/mailagents-agent-client/dist/index.js";

const baseUrl = process.env.MAILAGENTS_BASE_URL ?? "https://mailagents-dev.izhenghaocn.workers.dev";
const adminSecret = process.env.MAILAGENTS_ADMIN_SECRET;
const tenantId = process.env.MAILAGENTS_TENANT_ID;
const mailboxId = process.env.MAILAGENTS_MAILBOX_ID;
const agentId = process.env.MAILAGENTS_AGENT_ID;

if (!adminSecret || !tenantId || !mailboxId) {
  console.error("MAILAGENTS_ADMIN_SECRET, MAILAGENTS_TENANT_ID, and MAILAGENTS_MAILBOX_ID are required");
  process.exit(1);
}

const operator = new MailagentsAgentClient({ baseUrl, adminSecret }).operator();
const capabilitySurface = await operator.getCapabilitySurface();
const session = await operator.openMailboxSession({
  tenantId,
  mailboxId,
  agentId,
  mode: "send",
  expiresInSeconds: 1800,
});

const tools = await session.listTools();
const messages = await session.listMessages({ limit: 5, direction: "inbound" });

console.log(JSON.stringify({
  adminMcpPath: capabilitySurface.admin.metadata.path,
  expiresAt: session.expiresAt,
  scopeProfile: session.scopeProfile,
  scopedToolNames: tools.tools.map((tool) => tool.name),
  recommendedMailboxTools: session.workflow.recommended.map((tool) => tool.name),
  mailboxId: session.mailbox.id,
  mailboxAddress: session.mailbox.address,
  recentInboundCount: messages.items.length,
}, null, 2));
