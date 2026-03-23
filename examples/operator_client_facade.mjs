import { MailagentsAgentClient } from "../packages/mailagents-agent-client/dist/index.js";

const baseUrl = process.env.MAILAGENTS_BASE_URL ?? "https://mailagents-dev.izhenghaocn.workers.dev";
const adminSecret = process.env.MAILAGENTS_ADMIN_SECRET;
const tenantId = process.env.MAILAGENTS_TENANT_ID;
const mailboxId = process.env.MAILAGENTS_MAILBOX_ID;

if (!adminSecret) {
  console.error("MAILAGENTS_ADMIN_SECRET is required");
  process.exit(1);
}

const operator = new MailagentsAgentClient({
  baseUrl,
  adminSecret,
}).operator();

const capabilitySurface = await operator.getCapabilitySurface();
const payload = {
  discovery: {
    runtimeMetadataPath: capabilitySurface.runtime.api.metaRuntimePath,
    compatibilityPath: capabilitySurface.compatibility.discovery.compatibilityPath,
    adminMcpPath: capabilitySurface.admin.metadata.path,
  },
  workflowNames: capabilitySurface.admin.workflows.map((workflow) => workflow.name),
  compositeTools: capabilitySurface.admin.compositeTools.map((tool) => tool.name),
};

if (tenantId && mailboxId) {
  const session = await operator.openMailboxSession({
    tenantId,
    mailboxId,
    mode: "send",
  });

  const messages = await session.listMessages({ limit: 5, direction: "inbound" });

  payload.mailboxSession = {
    tenantId,
    mailboxId: session.mailbox.id,
    mailboxAddress: session.mailbox.address,
    scopeProfile: session.scopeProfile,
    nextSteps: session.nextSteps,
    visibleTools: session.visibleTools.map((tool) => tool.name),
    mailboxWorkflow: session.workflow.recommended.map((tool) => tool.name),
    recentInboundCount: messages.items.length,
  };
}

console.log(JSON.stringify(payload, null, 2));
