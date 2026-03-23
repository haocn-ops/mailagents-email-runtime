import { MailagentsAgentClient } from "../packages/mailagents-agent-client/dist/index.js";

const baseUrl = process.env.MAILAGENTS_BASE_URL ?? "https://mailagents-dev.izhenghaocn.workers.dev";
const adminSecret = process.env.MAILAGENTS_ADMIN_SECRET;
const messageId = process.env.MAILAGENTS_MESSAGE_ID;
const draftId = process.env.MAILAGENTS_DRAFT_ID;
const outboundJobId = process.env.MAILAGENTS_OUTBOUND_JOB_ID;
const email = process.env.MAILAGENTS_EMAIL;

if (!adminSecret || (!messageId && !draftId && !outboundJobId && !email)) {
  console.error(
    "MAILAGENTS_ADMIN_SECRET and one of MAILAGENTS_MESSAGE_ID, MAILAGENTS_DRAFT_ID, MAILAGENTS_OUTBOUND_JOB_ID, or MAILAGENTS_EMAIL are required"
  );
  process.exit(1);
}

const client = new MailagentsAgentClient({ baseUrl, adminSecret });
const result = await client.adminInspectDeliveryCaseWorkflow({
  messageId,
  draftId,
  outboundJobId,
  email,
});

console.log(JSON.stringify({
  lookup: result.inspection.lookup,
  summary: result.summary,
}, null, 2));
