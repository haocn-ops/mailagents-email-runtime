import { dispatchEmailIngestWithFallback } from "../lib/email-ingest";
import { createId } from "../lib/ids";
import { enqueueDeadLetter } from "../lib/queue";
import { nowIso } from "../lib/time";
import { getMailboxByAddress } from "../repositories/agents";
import { createInboundMessage, getInboundMessageByInternetMessageId, normalizeInternetMessageId, updateMessageStatus } from "../repositories/mail";
import type { EmailIngestJob, Env } from "../types";

interface ForwardableEmailMessage {
  from: string;
  to: string;
  headers: Headers;
  raw: ReadableStream<Uint8Array>;
  setReject: (reason: string) => void;
}

function reasonFromError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown_error";
}

async function deleteR2Object(env: Env, r2Key: string): Promise<void> {
  await env.R2_EMAIL.delete(r2Key).catch(() => undefined);
}

async function failInboundMessage(env: Env, input: {
  messageId: string;
  source: string;
  error: unknown;
}): Promise<void> {
  await updateMessageStatus(env, input.messageId, "failed").catch(() => undefined);
  await enqueueDeadLetter(env, {
    source: input.source,
    refId: input.messageId,
    reason: reasonFromError(input.error),
  }).catch(() => undefined);
}

async function resumeExistingInboundMessage(env: Env, payload: EmailIngestJob): Promise<void> {
  try {
    await dispatchEmailIngestWithFallback(env, payload);
  } catch (error) {
    await failInboundMessage(env, {
      messageId: payload.messageId,
      source: "email-receive-resume",
      error,
    });
    throw error;
  }
}

export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const normalizedTo = message.to.toLowerCase();
  const mailbox = await getMailboxByAddress(env, normalizedTo);

  if (!mailbox || mailbox.status !== "active") {
    message.setReject("Unknown mailbox");
    return;
  }

  const internetMessageId = normalizeInternetMessageId(message.headers.get("message-id"));
  if (internetMessageId) {
    const existing = await getInboundMessageByInternetMessageId(env, mailbox.id, internetMessageId);
    if (existing) {
      if ((existing.status === "received" || existing.status === "failed") && existing.rawR2Key) {
        await resumeExistingInboundMessage(env, {
          messageId: existing.id,
          tenantId: existing.tenantId,
          mailboxId: existing.mailboxId,
          rawR2Key: existing.rawR2Key,
        });
      }
      return;
    }
  }

  const messageId = createId("msg");
  const receivedAt = nowIso();
  const rawR2Key = `raw/${receivedAt.slice(0, 4)}/${receivedAt.slice(5, 7)}/${messageId}.eml`;
  const rawBytes = new Uint8Array(await new Response(message.raw).arrayBuffer());

  await env.R2_EMAIL.put(rawR2Key, rawBytes);

  const created = await createInboundMessage(env, {
    id: messageId,
    tenantId: mailbox.tenant_id,
    mailboxId: mailbox.id,
    provider: "cloudflare",
    internetMessageId,
    fromAddr: message.from,
    toAddr: normalizedTo,
    status: "received",
    rawR2Key,
    receivedAt,
    createdAt: receivedAt,
  }).catch(async (error) => {
    await deleteR2Object(env, rawR2Key);
    throw error;
  });

  if (!created) {
    await deleteR2Object(env, rawR2Key);
    if (internetMessageId) {
      const existing = await getInboundMessageByInternetMessageId(env, mailbox.id, internetMessageId);
      if (existing && (existing.status === "received" || existing.status === "failed") && existing.rawR2Key) {
        await resumeExistingInboundMessage(env, {
          messageId: existing.id,
          tenantId: existing.tenantId,
          mailboxId: existing.mailboxId,
          rawR2Key: existing.rawR2Key,
        });
      }
    }
    return;
  }

  const payload: EmailIngestJob = {
    messageId,
    tenantId: mailbox.tenant_id,
    mailboxId: mailbox.id,
    rawR2Key,
  };

  try {
    await dispatchEmailIngestWithFallback(env, payload);
  } catch (error) {
    await failInboundMessage(env, {
      messageId,
      source: "email-receive",
      error,
    });
    throw error;
  }
}
