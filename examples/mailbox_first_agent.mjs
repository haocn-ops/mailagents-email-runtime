import { MailagentsAgentClient } from "../packages/mailagents-agent-client/dist/index.js";

const baseUrl = process.env.MAILAGENTS_BASE_URL ?? "https://api.mailagents.net";
const operatorEmail = process.env.MAILAGENTS_OPERATOR_EMAIL;

if (!operatorEmail) {
  console.error("MAILAGENTS_OPERATOR_EMAIL is required");
  process.exit(1);
}

const mailboxAlias = process.env.MAILAGENTS_MAILBOX_ALIAS;
const useCase = process.env.MAILAGENTS_USE_CASE ?? "Mailbox-first SDK example";

const bootstrap = await MailagentsAgentClient.bootstrapMailboxAgent(
  { baseUrl },
  {
    productName: "Mailbox First Example Agent",
    operatorEmail,
    mailboxAlias,
    useCase,
  }
);

const { signup, client } = bootstrap;
const workflow = await client.getMailboxWorkflowSurface();
const messages = await client.listMessages({ limit: 5, direction: "inbound" });

console.log(JSON.stringify({
  mailbox: signup.mailbox,
  agent: signup.agent,
  recommendedTools: workflow.recommended.map((tool) => tool.name),
  readTools: workflow.reads.map((tool) => tool.name),
  sendTools: workflow.sends.map((tool) => tool.name),
  replyTools: workflow.replies.map((tool) => tool.name),
  recentInboundCount: messages.items.length,
}, null, 2));
