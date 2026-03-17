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
      name: "operator_manual_send",
      arguments: {
        agentId,
        tenantId,
        mailboxId,
        from,
        to,
        subject,
        text,
        send: true,
        idempotencyKey,
      },
    },
  }),
});

const payload = await response.json();
if (!response.ok) {
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  idempotencyKey,
  result: payload,
}, null, 2));
