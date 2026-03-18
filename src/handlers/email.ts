import { createId } from "../lib/ids";
import { nowIso } from "../lib/time";
import { ensureManagedContactAliasMailbox, isManagedContactAliasAddress } from "../lib/contact-aliases";
import { getMailboxByAddress } from "../repositories/agents";
import type { EmailIngestJob, Env } from "../types";

interface ForwardableEmailMessage {
  from: string;
  to: string;
  headers: Headers;
  raw: ReadableStream<Uint8Array>;
  setReject: (reason: string) => void;
}

export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const normalizedTo = message.to.toLowerCase();
  let mailbox = await getMailboxByAddress(env, normalizedTo);
  if (!mailbox && isManagedContactAliasAddress(env, normalizedTo)) {
    await ensureManagedContactAliasMailbox(env, normalizedTo);
    mailbox = await getMailboxByAddress(env, normalizedTo);
  }

  if (!mailbox || mailbox.status !== "active") {
    message.setReject("Unknown mailbox");
    return;
  }

  const messageId = createId("msg");
  const receivedAt = nowIso();
  const rawR2Key = `raw/${receivedAt.slice(0, 4)}/${receivedAt.slice(5, 7)}/${messageId}.eml`;
  const rawBytes = new Uint8Array(await new Response(message.raw).arrayBuffer());

  await env.R2_EMAIL.put(rawR2Key, rawBytes);

  await env.D1_DB.prepare(
    `INSERT INTO messages (
      id, tenant_id, mailbox_id, direction, provider, internet_message_id,
      from_addr, to_addr, status, raw_r2_key, received_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    messageId,
    mailbox.tenant_id,
    mailbox.id,
    "inbound",
    "cloudflare",
    message.headers.get("message-id"),
    message.from,
    normalizedTo,
    "received",
    rawR2Key,
    receivedAt,
    receivedAt
  ).run();

  const payload: EmailIngestJob = {
    messageId,
    tenantId: mailbox.tenant_id,
    mailboxId: mailbox.id,
    rawR2Key,
  };

  await env.EMAIL_INGEST_QUEUE.send(payload);
}
