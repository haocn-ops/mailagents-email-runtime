import type { DeliveryEventType } from "../types";

export interface NormalizedSesEvent {
  providerMessageId?: string;
  eventType: DeliveryEventType;
  mailTags: Record<string, string>;
  recipient?: string;
  recipients: string[];
  reason?: string;
  raw: unknown;
}

function normalizeRecipients(values: unknown[]): string[] {
  return values
    .map((value) => {
      if (typeof value === "string") {
        return value.trim().toLowerCase();
      }
      if (value && typeof value === "object" && typeof (value as { emailAddress?: unknown }).emailAddress === "string") {
        return (value as { emailAddress: string }).emailAddress.trim().toLowerCase();
      }
      return "";
    })
    .filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);
}

function toTagMap(tags: unknown): Record<string, string> {
  if (!tags || typeof tags !== "object") {
    return {};
  }

  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags as Record<string, unknown>)) {
    if (Array.isArray(value) && typeof value[0] === "string") {
      map[key] = value[0];
    } else if (typeof value === "string") {
      map[key] = value;
    }
  }
  return map;
}

export function normalizeSesEvent(payload: unknown): NormalizedSesEvent {
  const event = payload as Record<string, unknown>;
  const detail = (event.detail ?? payload) as Record<string, unknown>;
  const eventType = String(detail.eventType ?? detail["event-type"] ?? "unknown").toLowerCase();
  const mail = (detail.mail ?? {}) as Record<string, unknown>;
  const tags = toTagMap(mail.tags);
  const providerMessageId = typeof mail.messageId === "string" ? mail.messageId : undefined;

  if (eventType === "delivery") {
    const delivery = (detail.delivery ?? {}) as Record<string, unknown>;
    const recipients = normalizeRecipients(Array.isArray(delivery.recipients) ? delivery.recipients : []);
    return {
      providerMessageId,
      eventType: "delivery",
      mailTags: tags,
      recipient: recipients[0],
      recipients,
      raw: payload,
    };
  }

  if (eventType === "bounce") {
    const bounce = (detail.bounce ?? {}) as Record<string, unknown>;
    const recipients = normalizeRecipients(Array.isArray(bounce.bouncedRecipients) ? bounce.bouncedRecipients : []);
    return {
      providerMessageId,
      eventType: "bounce",
      mailTags: tags,
      recipient: recipients[0],
      recipients,
      reason: typeof bounce.bounceType === "string" ? bounce.bounceType : undefined,
      raw: payload,
    };
  }

  if (eventType === "complaint") {
    const complaint = (detail.complaint ?? {}) as Record<string, unknown>;
    const recipients = normalizeRecipients(Array.isArray(complaint.complainedRecipients) ? complaint.complainedRecipients : []);
    return {
      providerMessageId,
      eventType: "complaint",
      mailTags: tags,
      recipient: recipients[0],
      recipients,
      reason: typeof complaint.complaintFeedbackType === "string" ? complaint.complaintFeedbackType : undefined,
      raw: payload,
    };
  }

  if (eventType === "reject") {
    return {
      providerMessageId,
      eventType: "reject",
      recipients: [],
      mailTags: tags,
      raw: payload,
    };
  }

  return {
    providerMessageId,
    eventType: "unknown",
    recipients: [],
    mailTags: tags,
    raw: payload,
  };
}
