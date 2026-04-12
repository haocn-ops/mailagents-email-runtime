import { checkOutboundCreditRequirement } from "./outbound-credits";
import { evaluateOutboundPolicy } from "./outbound-policy";
import type { Env } from "../types";

export class OutboundSendValidationError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "OutboundSendValidationError";
    this.status = status;
  }
}

export async function ensureSystemSendAllowed(env: Env, input: {
  tenantId: string;
  agentId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  sourceMessageId?: string;
  createdVia?: string;
}): Promise<void> {
  const cc = input.cc ?? [];
  const bcc = input.bcc ?? [];
  const decision = await evaluateOutboundPolicy(env, {
    tenantId: input.tenantId,
    agentId: input.agentId,
    to: input.to,
    cc,
    bcc,
  });
  if (!decision.ok) {
    const status = decision.code === "invalid_recipient_routing"
      ? 400
      : decision.code === "daily_quota_exceeded" || decision.code === "hourly_quota_exceeded"
        ? 429
        : 403;
    throw new OutboundSendValidationError(
      decision.message ?? "Outbound policy denied this send request",
      status,
    );
  }

  const creditCheck = await checkOutboundCreditRequirement(env, {
    tenantId: input.tenantId,
    to: input.to,
    cc,
    bcc,
    sourceMessageId: input.sourceMessageId,
    createdVia: input.createdVia,
  });
  if (!creditCheck.hasSufficientCredits) {
    throw new OutboundSendValidationError(
      `Insufficient credits for external sending. Required: ${creditCheck.creditsRequired}, available: ${creditCheck.availableCredits ?? 0}`,
      402,
    );
  }
}
