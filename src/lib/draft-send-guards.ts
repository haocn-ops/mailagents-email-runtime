import { hasActiveMailboxBinding, hasActiveMailboxDeployment, getAgent, getMailboxById } from "../repositories/agents";
import { reserveTenantAvailableCredits } from "../repositories/billing";
import { getMessage, getThread } from "../repositories/mail";
import { checkOutboundCreditRequirement } from "./outbound-credits";
import { evaluateOutboundPolicy } from "./outbound-policy";
import type { Env } from "../types";

const SEND_CAPABLE_MAILBOX_ROLES = ["primary", "shared", "send_only"] as const;

export class DraftSendValidationError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "DraftSendValidationError";
    this.status = status;
  }
}

export async function readDraftRecipients(env: Env, draftR2Key: string): Promise<{
  to: string[];
  cc: string[];
  bcc: string[];
}> {
  const object = await env.R2_EMAIL.get(draftR2Key);
  if (!object) {
    throw new DraftSendValidationError("Draft payload not found", 404);
  }

  const payload = await object.json<Record<string, unknown>>();
  return {
    to: Array.isArray(payload.to) ? payload.to.filter((item): item is string => typeof item === "string") : [],
    cc: Array.isArray(payload.cc) ? payload.cc.filter((item): item is string => typeof item === "string") : [],
    bcc: Array.isArray(payload.bcc) ? payload.bcc.filter((item): item is string => typeof item === "string") : [],
  };
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

  const recipients = await readDraftRecipients(env, input.draftR2Key);
  const decision = await evaluateOutboundPolicy(env, {
    tenantId: input.tenantId,
    agentId: input.agentId,
    ...recipients,
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
