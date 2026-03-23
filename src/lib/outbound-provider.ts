import { buildRawMimeMessage } from "./mime";
import { sendSesRawEmail, sendSesSimpleEmail } from "./ses";
import type { Env, OutboundProvider } from "../types";

interface EmailTag {
  Name: string;
  Value: string;
}

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

export interface OutboundDraftSendInput {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachmentRefs?: AttachmentRef[];
  replyToAddresses?: string[];
  emailTags?: EmailTag[];
}

export interface OutboundSendResult {
  provider: OutboundProvider;
  messageId: string;
}

function isEnabled(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function getMockSendDelayMs(env: Env): number {
  const raw = env.SES_MOCK_SEND_DELAY_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function getOutboundProvider(env: Env): OutboundProvider {
  const raw = (env.OUTBOUND_PROVIDER ?? "ses").trim().toLowerCase();
  return raw === "resend" ? "resend" : "ses";
}

async function maybeSendMock(env: Env): Promise<string | null> {
  if (!isEnabled(env.SES_MOCK_SEND)) {
    return null;
  }

  const delayMs = getMockSendDelayMs(env);
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return `mock-outbound-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

async function sendWithResend(env: Env, input: OutboundDraftSendInput): Promise<OutboundSendResult> {
  if (!env.RESEND_API_KEY) {
    throw new Error("Resend API key is not configured");
  }

  const attachments = await loadAttachments(env, input.attachmentRefs ?? []);
  const headers: Record<string, string> = {};
  if (input.inReplyTo) {
    headers["In-Reply-To"] = input.inReplyTo;
  }
  if (input.references?.length) {
    headers.References = input.references.join(" ");
  }

  const payload = {
    from: input.from,
    to: input.to,
    ...(input.cc?.length ? { cc: input.cc } : {}),
    ...(input.bcc?.length ? { bcc: input.bcc } : {}),
    subject: input.subject,
    ...(input.html !== undefined ? { html: input.html } : {}),
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.replyToAddresses?.length
      ? { reply_to: input.replyToAddresses.length === 1 ? input.replyToAddresses[0] : input.replyToAddresses }
      : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(attachments.length
      ? {
          attachments: attachments.map((attachment) => ({
            filename: attachment.filename,
            content: toBase64(attachment.content),
          })),
        }
      : {}),
    ...(input.emailTags?.length
      ? {
          tags: input.emailTags.map((tag) => ({
            name: tag.Name,
            value: tag.Value,
          })),
        }
      : {}),
  };

  const endpoint = `${(env.RESEND_API_BASE_URL ?? "https://api.resend.com").replace(/\/+$/, "")}/emails`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Resend send failed (${response.status}): ${errorText}`);
  }

  const result = await response.json<{ id?: string }>();
  if (!result.id) {
    throw new Error("Resend send succeeded without id");
  }

  return {
    provider: "resend",
    messageId: result.id,
  };
}

async function sendWithSes(env: Env, input: OutboundDraftSendInput): Promise<OutboundSendResult> {
  const hasRawFeatures = Boolean((input.attachmentRefs?.length ?? 0) > 0 || input.inReplyTo || (input.references?.length ?? 0) > 0);

  if (!hasRawFeatures) {
    const result = await sendSesSimpleEmail(env, {
      from: input.from,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.text,
      html: input.html,
      replyToAddresses: input.replyToAddresses,
      configurationSetName: env.SES_CONFIGURATION_SET,
      emailTags: input.emailTags ?? [],
    });

    return {
      provider: "ses",
      messageId: result.messageId,
    };
  }

  const attachments = await loadAttachments(env, input.attachmentRefs ?? []);
  const rawData = buildRawMimeMessage({
    from: input.from,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    replyTo: input.replyToAddresses,
    subject: input.subject,
    text: input.text,
    html: input.html,
    inReplyTo: input.inReplyTo,
    references: input.references,
    attachments,
  });

  const result = await sendSesRawEmail(env, {
    from: input.from,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    rawData,
    configurationSetName: env.SES_CONFIGURATION_SET,
    emailTags: input.emailTags ?? [],
  });

  return {
    provider: "ses",
    messageId: result.messageId,
  };
}

export async function sendOutboundDraft(env: Env, input: OutboundDraftSendInput): Promise<OutboundSendResult> {
  const mockMessageId = await maybeSendMock(env);
  if (mockMessageId) {
    return {
      provider: getOutboundProvider(env),
      messageId: mockMessageId,
    };
  }

  const provider = getOutboundProvider(env);
  if (provider === "resend") {
    return await sendWithResend(env, input);
  }

  return await sendWithSes(env, input);
}
