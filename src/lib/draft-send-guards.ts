import { hasActiveMailboxBinding, hasActiveMailboxDeployment, getAgent, getMailboxById } from "../repositories/agents";
import { reserveTenantAvailableCredits } from "../repositories/billing";
import { getAttachmentOwnerByR2Key, getMessage, getThread } from "../repositories/mail";
import { checkOutboundCreditRequirement } from "./outbound-credits";
import { evaluateOutboundPolicy } from "./outbound-policy";
import type { Env } from "../types";

const SEND_CAPABLE_MAILBOX_ROLES = ["primary", "shared", "send_only"] as const;

type DraftAttachment = {
  filename: string;
  contentType: string;
  r2Key: string;
};

type DraftRecipients = {
  to: string[];
  cc: string[];
  bcc: string[];
};

const DRAFT_RECIPIENTS_VALIDATION_MESSAGE =
  "Draft recipients must include a non-empty to array and optional cc/bcc string arrays";

export class DraftSendValidationError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "DraftSendValidationError";
    this.status = status;
  }
}

async function readDraftPayload(env: Env, draftR2Key: string): Promise<Record<string, unknown>> {
  const object = await env.R2_EMAIL.get(draftR2Key);
  if (!object) {
    throw new DraftSendValidationError("Draft payload not found", 404);
  }

  return object.json<Record<string, unknown>>();
}

function parseDraftRecipientList(
  value: unknown,
  field: "to" | "cc" | "bcc",
): string[] {
  if (value === undefined || value === null) {
    if (field === "to") {
      throw new DraftSendValidationError(DRAFT_RECIPIENTS_VALIDATION_MESSAGE, 400);
    }
    return [];
  }

  if (!Array.isArray(value)) {
    throw new DraftSendValidationError(DRAFT_RECIPIENTS_VALIDATION_MESSAGE, 400);
  }

  const items = value.map((item) => typeof item === "string" ? item.trim() : "");
  if (items.some((item) => !item)) {
    throw new DraftSendValidationError(DRAFT_RECIPIENTS_VALIDATION_MESSAGE, 400);
  }
  if (field === "to" && items.length === 0) {
    throw new DraftSendValidationError(DRAFT_RECIPIENTS_VALIDATION_MESSAGE, 400);
  }

  return items;
}

function parseDraftRecipients(payload: Record<string, unknown>): DraftRecipients {
  return {
    to: parseDraftRecipientList(payload.to, "to"),
    cc: parseDraftRecipientList(payload.cc, "cc"),
    bcc: parseDraftRecipientList(payload.bcc, "bcc"),
  };
}

function parseDraftAttachments(payload: Record<string, unknown>): DraftAttachment[] {
  if (payload.attachments === undefined || payload.attachments === null) {
    return [];
  }
  if (!Array.isArray(payload.attachments)) {
    throw new DraftSendValidationError("Draft attachments must be an array when provided", 400);
  }

  return payload.attachments.map((item) => {
    if (
      typeof item !== "object"
      || item === null
      || typeof (item as { filename?: unknown }).filename !== "string"
      || typeof (item as { contentType?: unknown }).contentType !== "string"
      || typeof (item as { r2Key?: unknown }).r2Key !== "string"
    ) {
      throw new DraftSendValidationError("Draft attachments must include filename, contentType, and r2Key", 400);
    }

    return {
      filename: (item as { filename: string }).filename,
      contentType: (item as { contentType: string }).contentType,
      r2Key: (item as { r2Key: string }).r2Key,
    };
  });
}

async function validateStoredDraftPayload(env: Env, input: {
  tenantId: string;
  mailboxId: string;
  mailboxAddress: string;
  draftR2Key: string;
}): Promise<DraftRecipients> {
  const payload = await readDraftPayload(env, input.draftR2Key);
  const from = typeof payload.from === "string" ? payload.from.trim().toLowerCase() : "";
  const expectedFrom = input.mailboxAddress.trim().toLowerCase();
  if (!from || from !== expectedFrom) {
    throw new DraftSendValidationError("from must match the mailbox address", 400);
  }

  const attachments = parseDraftAttachments(payload);
  for (const attachment of attachments) {
    const r2Key = attachment.r2Key.trim();
    if (!r2Key) {
      throw new DraftSendValidationError("Attachment r2Key is required", 400);
    }

    const owner = await getAttachmentOwnerByR2Key(env, r2Key);
    if (!owner) {
      throw new DraftSendValidationError("Attachment not found", 404);
    }
    if (owner.tenantId !== input.tenantId) {
      throw new DraftSendValidationError("Attachment does not belong to tenant", 409);
    }
    if (owner.mailboxId !== input.mailboxId) {
      throw new DraftSendValidationError("Attachment does not belong to mailbox", 409);
    }
  }

  return parseDraftRecipients(payload);
}

export async function readDraftRecipients(env: Env, draftR2Key: string): Promise<DraftRecipients> {
  return parseDraftRecipients(await readDraftPayload(env, draftR2Key));
}

export async function ensureDraftSendAllowed(env: Env, input: {
  tenantId: string;
  agentId: string;
  mailboxId: string;
  draftR2Key: string;
  threadId?: string;
  sourceMessageId?: string;
}): Promise<void> {
  const mailbox = await getMailboxById(env, input.mailboxId);
  if (!mailbox) {
    throw new DraftSendValidationError("Mailbox not found", 404);
  }
  if (mailbox.tenant_id !== input.tenantId) {
    throw new DraftSendValidationError("Mailbox does not belong to tenant", 409);
  }
  if (mailbox.status !== "active") {
    throw new DraftSendValidationError("Mailbox is not active", 409);
  }

  const agent = await getAgent(env, input.agentId);
  if (!agent) {
    throw new DraftSendValidationError("Agent not found", 404);
  }
  if (agent.tenantId !== input.tenantId) {
    throw new DraftSendValidationError("Agent does not belong to tenant", 409);
  }

  const hasBinding = await hasActiveMailboxBinding(env, {
    agentId: input.agentId,
    mailboxId: input.mailboxId,
    roles: [...SEND_CAPABLE_MAILBOX_ROLES],
  });
  const hasAnyBinding = await hasActiveMailboxBinding(env, {
    agentId: input.agentId,
    mailboxId: input.mailboxId,
  });
  const hasDeployment = await hasActiveMailboxDeployment(env, {
    agentId: input.agentId,
    mailboxId: input.mailboxId,
  });
  if (!hasBinding && (!hasDeployment || hasAnyBinding)) {
    throw new DraftSendValidationError("Agent is not allowed to send for mailbox", 403);
  }

  if (input.threadId) {
    const thread = await getThread(env, input.threadId);
    if (!thread) {
      throw new DraftSendValidationError("Thread not found", 404);
    }
    if (thread.tenantId !== input.tenantId) {
      throw new DraftSendValidationError("Thread does not belong to tenant", 409);
    }
    if (thread.mailboxId !== input.mailboxId) {
      throw new DraftSendValidationError("Thread does not belong to mailbox", 409);
    }
  }

  if (input.sourceMessageId) {
    const sourceMessage = await getMessage(env, input.sourceMessageId);
    if (!sourceMessage) {
      throw new DraftSendValidationError("Source message not found", 404);
    }
    if (sourceMessage.tenantId !== input.tenantId) {
      throw new DraftSendValidationError("Source message does not belong to tenant", 409);
    }
    if (sourceMessage.mailboxId !== input.mailboxId) {
      throw new DraftSendValidationError("Source message does not belong to mailbox", 409);
    }
    if (input.threadId && sourceMessage.threadId !== input.threadId) {
      throw new DraftSendValidationError("Source message does not belong to thread", 409);
    }
  }

  const recipients = await validateStoredDraftPayload(env, {
    tenantId: input.tenantId,
    mailboxId: input.mailboxId,
    mailboxAddress: mailbox.address,
    draftR2Key: input.draftR2Key,
  });
  const decision = await evaluateOutboundPolicy(env, {
    tenantId: input.tenantId,
    agentId: input.agentId,
    ...recipients,
    excludeDraftR2Key: input.draftR2Key,
  });
  if (!decision.ok) {
    const status = decision.code === "daily_quota_exceeded" || decision.code === "hourly_quota_exceeded" ? 429 : 403;
    throw new DraftSendValidationError(
      decision.message ?? "Outbound policy denied this send request",
      status,
    );
  }
}

export async function reserveDraftSendCredits(env: Env, input: {
  tenantId: string;
  draftR2Key: string;
  sourceMessageId?: string;
  createdVia?: string;
}): Promise<void> {
  const recipients = await readDraftRecipients(env, input.draftR2Key);
  const creditCheck = await checkOutboundCreditRequirement(env, {
    tenantId: input.tenantId,
    ...recipients,
    sourceMessageId: input.sourceMessageId,
    createdVia: input.createdVia,
  });

  if (!creditCheck.hasSufficientCredits) {
    throw new DraftSendValidationError(
      `Insufficient credits for external sending. Required: ${creditCheck.creditsRequired}, available: ${creditCheck.availableCredits ?? 0}`,
      402,
    );
  }

  if (!creditCheck.requiresCredits) {
    return;
  }

  const reserved = await reserveTenantAvailableCredits(env, input.tenantId, creditCheck.creditsRequired);
  if (!reserved) {
    throw new DraftSendValidationError(
      `Insufficient credits for external sending. Required: ${creditCheck.creditsRequired}`,
      402,
    );
  }
}
