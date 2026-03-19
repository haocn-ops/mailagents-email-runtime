import { MailagentsAgentClient } from "../packages/mailagents-agent-client/dist/index.js";

const baseUrl = process.env.MAILAGENTS_BASE_URL ?? "https://mailagents-dev.izhenghaocn.workers.dev";
const token = process.env.MAILAGENTS_TOKEN;
const agentId = process.env.MAILAGENTS_AGENT_ID;
const messageId = process.env.MAILAGENTS_MESSAGE_ID ?? "msg_demo_inbound";

if (!token || !agentId) {
  console.error("MAILAGENTS_TOKEN and MAILAGENTS_AGENT_ID are required");
  process.exit(1);
}

const client = new MailagentsAgentClient({ baseUrl, token });
const payload = await client.replyToInboundEmail({
  agentId,
  messageId,
  replyText: "Thanks for your message. This draft was created from the runnable example.",
  send: false,
});

console.log(JSON.stringify(payload, null, 2));
