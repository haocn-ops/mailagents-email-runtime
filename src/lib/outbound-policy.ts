import { getAgentPolicy } from "../repositories/agents";
import { ensureTenantBillingAccount } from "../repositories/billing";
import { getTenantOutboundUsageWindowCounts } from "../repositories/mail";
import { ensureTenantSendPolicy } from "../repositories/tenant-policies";
import { getOutboundRecipientRoutingValidationError, routeOutboundRecipients } from "./local-recipient-routing";
import { isDefaultSelfServeInternalOnlyAgentPolicy } from "./self-serve-agent-policy";
import type { Env } from "../types";

export interface OutboundPolicyDecision {
  ok: boolean;
  code?:
    | "access_mailbox_denied"
    | "invalid_recipient_routing"
    | "external_send_not_enabled"
    | "recipient_domain_not_allowed"
    | "daily_quota_exceeded"
    | "hourly_quota_exceeded";
  message?: string;
  recipientDomains?: string[];
  externalDomains?: string[];
  externalRecipientCount?: number;
}

export interface OutboundRecipientClassification {
  recipientDomains: string[];
  internalDomains: string[];
  externalDomains: string[];
  internalRecipientCount: number;
  externalRecipientCount: number;
  externalToRecipientCount: number;
}

function rollingWindowStart(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

export async function classifyOutboundRecipients(env: Env, input: {
  tenantId: string;
  to: string[];
  cc: string[];
  bcc: string[];
}): Promise<OutboundRecipientClassification> {
  const routed = await routeOutboundRecipients(env, input);

  return {
    recipientDomains: routed.recipientDomains,
    internalDomains: routed.internalDomains,
    externalDomains: routed.externalDomains,
    internalRecipientCount: routed.internalRecipientCount,
    externalRecipientCount: routed.externalRecipientCount,
    externalToRecipientCount: routed.externalToRecipientCount,
  };
}

export async function evaluateOutboundPolicy(env: Env, input: {
  tenantId: string;
  agentId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  excludeDraftR2Key?: string;
}): Promise<OutboundPolicyDecision> {
  const {
    recipientDomains,
    externalDomains,
    externalRecipientCount,
    externalToRecipientCount,
  } = await classifyOutboundRecipients(env, input);
  if (recipientDomains.length === 0) {
    return {
      ok: false,
      code: "recipient_domain_not_allowed",
      message: "At least one valid recipient domain is required",
    };
  }

  const routingValidationError = getOutboundRecipientRoutingValidationError({
    externalRecipientCount,
    externalToRecipientCount,
  });
  if (routingValidationError) {
    return {
      ok: false,
      code: "invalid_recipient_routing",
      message: routingValidationError,
      recipientDomains,
      externalDomains,
      externalRecipientCount,
    };
  }

  if (externalRecipientCount === 0) {
    return {
      ok: true,
      recipientDomains,
      externalDomains: [],
      externalRecipientCount: 0,
    };
  }

  const tenantPolicy = await ensureTenantSendPolicy(env, input.tenantId);
  const account = await ensureTenantBillingAccount(env, input.tenantId);
  const sendingUnlockedByPolicy =
    tenantPolicy.externalSendEnabled && tenantPolicy.outboundStatus === "external_enabled";
  // Queue-time revalidation can happen after the current send has already reserved its credit.
  // Treat reserved credits as sufficient to keep the credits-backed unlock active for that in-flight send.
  const sendingUnlockedByCredits = (account.availableCredits + account.reservedCredits) > 0;
  const externalSendingUnlockedByPolicy = sendingUnlockedByPolicy;
  const externalSendingUnlockedByCredits = sendingUnlockedByCredits;
  const externalSendingUnlocked =
    externalRecipientCount > 0 &&
    (externalSendingUnlockedByPolicy || externalSendingUnlockedByCredits);
  const quotaBypassUnlocked = sendingUnlockedByPolicy || sendingUnlockedByCredits;

  if (tenantPolicy.outboundStatus === "suspended") {
    return {
      ok: false,
      code: "access_mailbox_denied",
      message: "Outbound sending is suspended for this tenant",
    };
  }

  if (!externalSendingUnlockedByPolicy && !externalSendingUnlockedByCredits) {
    if (externalRecipientCount > 0) {
      return {
        ok: false,
        code: "external_send_not_enabled",
        message: `External sending requires available credits or an enabled outbound policy. Disallowed domains: ${externalDomains.join(", ")}`,
        recipientDomains,
        externalDomains,
        externalRecipientCount,
      };
    }
  }

  const agentPolicy = await getAgentPolicy(env, input.agentId);
  if (agentPolicy?.allowedRecipientDomains.length) {
    const bypassDefaultInternalOnlyAllowlist =
      externalDomains.length > 0 &&
      externalRecipientCount > 0 &&
      sendingUnlockedByCredits &&
      isDefaultSelfServeInternalOnlyAgentPolicy(agentPolicy, tenantPolicy.internalDomainAllowlist);

    if (!bypassDefaultInternalOnlyAllowlist) {
      const allowedDomains = new Set(agentPolicy.allowedRecipientDomains.map((item) => item.toLowerCase()));
      const disallowed = externalDomains.filter((domain) => !allowedDomains.has(domain));
      if (disallowed.length > 0) {
        return {
          ok: false,
          code: "recipient_domain_not_allowed",
          message: `Recipient domains are not allowed for this agent: ${disallowed.join(", ")}`,
          recipientDomains,
          externalDomains,
        };
      }
    }
  }

  if (
    !quotaBypassUnlocked &&
    (tenantPolicy.effectiveDailySendLimit !== null || tenantPolicy.effectiveHourlySendLimit !== null)
  ) {
    const usage = await getTenantOutboundUsageWindowCounts(env, {
      tenantId: input.tenantId,
      sinceHour: rollingWindowStart(1),
      sinceDay: rollingWindowStart(24),
      excludeDraftR2Key: input.excludeDraftR2Key,
    });

    if (
      tenantPolicy.effectiveDailySendLimit !== null &&
      usage.sentLastDay >= tenantPolicy.effectiveDailySendLimit
    ) {
      return {
        ok: false,
        code: "daily_quota_exceeded",
        message: `Free-tier daily send limit reached. Ordinary users can send up to ${tenantPolicy.effectiveDailySendLimit} email${tenantPolicy.effectiveDailySendLimit === 1 ? "" : "s"} in a rolling 24-hour window.`,
        recipientDomains,
        externalDomains,
      };
    }

    if (
      tenantPolicy.effectiveHourlySendLimit !== null &&
      usage.sentLastHour >= tenantPolicy.effectiveHourlySendLimit
    ) {
      return {
        ok: false,
        code: "hourly_quota_exceeded",
        message: `Free-tier hourly send limit reached. Ordinary users can send up to ${tenantPolicy.effectiveHourlySendLimit} email${tenantPolicy.effectiveHourlySendLimit === 1 ? "" : "s"} in a rolling 1-hour window.`,
        recipientDomains,
        externalDomains,
      };
    }
  }

  return {
    ok: true,
    recipientDomains,
    externalDomains,
    externalRecipientCount,
  };
}
