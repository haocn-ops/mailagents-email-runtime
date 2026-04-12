import { dispatchEmailIngestWithFallback } from "./email-ingest";
import { buildRawMimeMessage } from "./mime";
import { createId } from "./ids";
import { nowIso } from "./time";
import {
  createInboundMessage,
  getInboundMessageByInternetMessageId,
} from "../repositories/mail";
import type { Env } from "../types";
import type { LocalMailboxRecipient } from "./local-recipient-routing";

interface AttachmentRef {
  filename?: unknown;
  contentType?: unknown;
  r2Key?: unknown;
}

interface LoadedAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

function messageIdDomain(from: string): string {
  const normalized = from.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at === -1 || at === normalized.length - 1) {
    return "internal.mailagents";
  }

  return normalized.slice(at + 1);
}

function buildDeterministicMessageId(outboundJobId: string, from: string): string {
  return `<${outboundJobId}@${messageIdDomain(from)}>`;
}

async function loadAttachments(env: Env, refs: AttachmentRef[]): Promise<LoadedAttachment[]> {
  const attachments: LoadedAttachment[] = [];

  for (const ref of refs) {
    const r2Key = typeof ref.r2Key === "string" ? ref.r2Key.trim() : "";
    if (!r2Key) {
      continue;
    }

    const object = await env.R2_EMAIL.get(r2Key);
    if (!object) {
      throw new Error(`Attachment not found in R2: ${r2Key}`);
    }

    attachments.push({
      filename: typeof ref.filename === "string" ? ref.filename : r2Key.split("/").pop() ?? "attachment.bin",
      contentType: typeof ref.contentType === "string" ? ref.contentType : object.httpMetadata?.contentType ?? "application/octet-stream",
      content: new Uint8Array(await object.arrayBuffer()),
    });
  }

  return attachments;
}

export async function deliverLocallyToMailboxes(env: Env, input: {
  outboundJobId: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachmentRefs?: AttachmentRef[];
  recipients: LocalMailboxRecipient[];
}): Promise<{ deliveredCount: number; messageId: string }> {
  if (!input.recipients.length) {
    return {
      deliveredCount: 0,
      messageId: buildDeterministicMessageId(input.outboundJobId, input.from),
    };
  }

  const internetMessageId = buildDeterministicMessageId(input.outboundJobId, input.from);
  const attachments = await loadAttachments(env, input.attachmentRefs ?? []);
  const rawBytes = buildRawMimeMessage({
    from: input.from,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    text: input.text,
    html: input.html,
    date: new Date().toUTCString(),
    messageId: internetMessageId,
    inReplyTo: input.inReplyTo,
    references: input.references,
    attachments,
  });

  for (const recipient of input.recipients) {
    const timestamp = nowIso();
    const inboundMessageId = createId("msg");
    const rawR2Key = `raw/${timestamp.slice(0, 4)}/${timestamp.slice(5, 7)}/${inboundMessageId}.eml`;
    await env.R2_EMAIL.put(rawR2Key, rawBytes, {
      httpMetadata: { contentType: "message/rfc822" },
    });

    let createdInbound = false;
    try {
      const created = await createInboundMessage(env, {
        id: inboundMessageId,
        tenantId: recipient.tenantId,
        mailboxId: recipient.mailboxId,
        provider: "internal",
        internetMessageId,
        fromAddr: input.from.trim().toLowerCase(),
        toAddr: recipient.address,
        status: "received",
        rawR2Key,
        receivedAt: timestamp,
        createdAt: timestamp,
      });
      createdInbound = created;

      if (!created) {
        await env.R2_EMAIL.delete(rawR2Key).catch(() => undefined);
        const existing = await getInboundMessageByInternetMessageId(env, recipient.mailboxId, internetMessageId);
        if (existing && (existing.status === "received" || existing.status === "failed") && existing.rawR2Key) {
          await dispatchEmailIngestWithFallback(env, {
            messageId: existing.id,
            tenantId: existing.tenantId,
            mailboxId: existing.mailboxId,
            rawR2Key: existing.rawR2Key,
          });
        }
        continue;
      }

      await dispatchEmailIngestWithFallback(env, {
        messageId: inboundMessageId,
        tenantId: recipient.tenantId,
        mailboxId: recipient.mailboxId,
        rawR2Key,
      });
    } catch (error) {
      if (!createdInbound) {
        await env.R2_EMAIL.delete(rawR2Key).catch(() => undefined);
      }
      throw error;
    }
  }

  return {
    deliveredCount: input.recipients.length,
    messageId: internetMessageId,
  };
}
