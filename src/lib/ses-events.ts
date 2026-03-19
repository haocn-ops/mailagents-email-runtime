import type { DeliveryEventType } from "../types";

export interface NormalizedSesEvent {
  providerMessageId?: string;
  eventType: DeliveryEventType;
  mailTags: Record<string, string>;
  recipient?: string;
  reason?: string;
  raw: unknown;
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
    const recipients = Array.isArray(delivery.recipients) ? delivery.recipients : [];
    return {
      providerMessageId,
      eventType: "delivery",
      mailTags: tags,
      recipient: typeof recipients[0] === "string" ? recipients[0] : undefined,
      raw: payload,
    };
  }

  if (eventType === "bounce") {
    const bounce = (detail.bounce ?? {}) as Record<string, unknown>;
    const bounced = Array.isArray(bounce.bouncedRecipients) ? bounce.bouncedRecipients : [];
    const first = (bounced[0] ?? {}) as Record<string, unknown>;
    return {
      providerMessageId,
      eventType: "bounce",
      mailTags: tags,
      recipient: typeof first.emailAddress === "string" ? first.emailAddress : undefined,
      reason: typeof bounce.bounceType === "string" ? bounce.bounceType : undefined,
      raw: payload,
    };
  }

  if (eventType === "complaint") {
    const complaint = (detail.complaint ?? {}) as Record<string, unknown>;
    const complained = Array.isArray(complaint.complainedRecipients) ? complaint.complainedRecipients : [];
    const first = (complained[0] ?? {}) as Record<string, unknown>;
    return {
      providerMessageId,
      eventType: "complaint",
      mailTags: tags,
      recipient: typeof first.emailAddress === "string" ? first.emailAddress : undefined,
      reason: typeof complaint.complaintFeedbackType === "string" ? complaint.complaintFeedbackType : undefined,
      raw: payload,
    };
  }

  if (eventType === "reject") {
    return {
      providerMessageId,
      eventType: "reject",
      mailTags: tags,
      raw: payload,
    };
  }

  return {
    providerMessageId,
    eventType: "unknown",
    mailTags: tags,
    raw: payload,
  };
}
