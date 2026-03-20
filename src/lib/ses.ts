import { signAwsRequest } from "./aws";
import type { Env } from "../types";

export interface SesSimpleSendInput {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  configurationSetName: string;
  emailTags: Array<{ Name: string; Value: string }>;
  replyToAddresses?: string[];
}

export interface SesRawSendInput {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  rawData: Uint8Array;
  configurationSetName: string;
  emailTags: Array<{ Name: string; Value: string }>;
}

export interface SesSendResult {
  messageId: string;
}

function isMockSesEnabled(env: Env): boolean {
  return ["1", "true", "yes", "on"].includes((env.SES_MOCK_SEND ?? "").toLowerCase());
}

function getMockSesDelayMs(env: Env): number {
  const raw = env.SES_MOCK_SEND_DELAY_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function requireSesCredentials(env: Env): { accessKeyId: string; secretAccessKey: string } {
  const accessKeyId = env.SES_ACCESS_KEY_ID ?? env.SES_ACCESS_KEY;
  const secretAccessKey = env.SES_SECRET_ACCESS_KEY ?? env.SES_SECRET_KEY;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("SES credentials are not configured");
  }

  return { accessKeyId, secretAccessKey };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function sendSesPayload(env: Env, body: string): Promise<SesSendResult> {
  if (isMockSesEnabled(env)) {
    const delayMs = getMockSesDelayMs(env);
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return { messageId: `mock-ses-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` };
  }

  const { accessKeyId, secretAccessKey } = requireSesCredentials(env);
  const endpoint = `https://email.${env.SES_REGION}.amazonaws.com/v2/email/outbound-emails`;

  const headers = await signAwsRequest({
    method: "POST",
    url: endpoint,
    service: "ses",
    region: env.SES_REGION,
    accessKeyId,
    secretAccessKey,
    body,
    headers: {
      "content-type": "application/json",
    },
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SES send failed (${response.status}): ${errorText}`);
  }

  const payload = await response.json<{ MessageId?: string }>();
  if (!payload.MessageId) {
    throw new Error("SES send succeeded without MessageId");
  }

  return { messageId: payload.MessageId };
}

export async function sendSesSimpleEmail(env: Env, input: SesSimpleSendInput): Promise<SesSendResult> {
  const body = JSON.stringify({
    FromEmailAddress: input.from,
    Destination: {
      ToAddresses: input.to,
      CcAddresses: input.cc ?? [],
      BccAddresses: input.bcc ?? [],
    },
    ReplyToAddresses: input.replyToAddresses ?? [],
    Content: {
      Simple: {
        Subject: { Data: input.subject, Charset: "UTF-8" },
        Body: {
          ...(input.text ? { Text: { Data: input.text, Charset: "UTF-8" } } : {}),
          ...(input.html ? { Html: { Data: input.html, Charset: "UTF-8" } } : {}),
        },
      },
    },
    ConfigurationSetName: input.configurationSetName,
    EmailTags: input.emailTags,
  });

  return await sendSesPayload(env, body);
}

export async function sendSesRawEmail(env: Env, input: SesRawSendInput): Promise<SesSendResult> {
  const body = JSON.stringify({
    FromEmailAddress: input.from,
    Destination: {
      ToAddresses: input.to,
      CcAddresses: input.cc ?? [],
      BccAddresses: input.bcc ?? [],
    },
    Content: {
      Raw: {
        Data: toBase64(input.rawData),
      },
    },
    ConfigurationSetName: input.configurationSetName,
    EmailTags: input.emailTags,
  });

  return await sendSesPayload(env, body);
}
