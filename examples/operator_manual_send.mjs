import { MailagentsAgentClient } from "../packages/mailagents-agent-client/dist/index.js";

const baseUrl = process.env.MAILAGENTS_BASE_URL ?? "https://mailagents-dev.izhenghaocn.workers.dev";
const token = process.env.MAILAGENTS_TOKEN;
const agentId = process.env.MAILAGENTS_AGENT_ID;
const tenantId = process.env.MAILAGENTS_TENANT_ID ?? "t_demo";
const mailboxId = process.env.MAILAGENTS_MAILBOX_ID ?? "mbx_demo";
const from = process.env.MAILAGENTS_FROM_EMAIL ?? "agent@mail.example.com";
const to = (process.env.MAILAGENTS_TO_EMAIL ?? "user@example.com").split(",");
const subject = process.env.MAILAGENTS_SUBJECT ?? "Operator manual send example";
const text = process.env.MAILAGENTS_TEXT ?? "Sent from the runnable Mailagents operator send example.";
const idempotencyKey = process.env.MAILAGENTS_IDEMPOTENCY_KEY ?? `example-manual-send-${Date.now()}`;

if (!token || !agentId) {
  console.error("MAILAGENTS_TOKEN and MAILAGENTS_AGENT_ID are required");
  process.exit(1);
}

const client = new MailagentsAgentClient({ baseUrl, token });
const payload = await client.operatorManualSend({
  agentId,
  tenantId,
  mailboxId,
  from,
  to,
  subject,
  text,
  send: true,
  idempotencyKey,
});

console.log(JSON.stringify({
  idempotencyKey,
  result: payload,
}, null, 2));
