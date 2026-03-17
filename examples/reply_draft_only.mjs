const baseUrl = process.env.MAILAGENTS_BASE_URL ?? "https://mailagents-dev.izhenghaocn.workers.dev";
const token = process.env.MAILAGENTS_TOKEN;
const agentId = process.env.MAILAGENTS_AGENT_ID;
const messageId = process.env.MAILAGENTS_MESSAGE_ID ?? "msg_demo_inbound";

if (!token || !agentId) {
  console.error("MAILAGENTS_TOKEN and MAILAGENTS_AGENT_ID are required");
  process.exit(1);
}

const response = await fetch(`${baseUrl}/mcp`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "reply_to_inbound_email",
      arguments: {
        agentId,
        messageId,
        replyText: "Thanks for your message. This draft was created from the runnable example.",
        send: false,
      },
    },
  }),
});

const payload = await response.json();
if (!response.ok) {
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(payload, null, 2));
