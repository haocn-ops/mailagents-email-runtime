import { getAgentPolicy } from "../repositories/agents";
import { ensureTenantBillingAccount } from "../repositories/billing";
import { getTenantOutboundUsageWindowCounts } from "../repositories/mail";
import { ensureTenantSendPolicy } from "../repositories/tenant-policies";
import { isDefaultSelfServeInternalOnlyAgentPolicy } from "./self-serve-agent-policy";
import type { Env } from "../types";

export interface OutboundPolicyDecision {
  ok: boolean;
  code?:
    | "access_mailbox_denied"
    | "external_send_not_enabled"
    | "recipient_domain_not_allowed"
    | "daily_quota_exceeded"
    | "hourly_quota_exceeded";
  message?: string;
  recipientDomains?: string[];
  externalDomains?: string[];
}

export interface OutboundRecipientClassification {
  recipientDomains: string[];
  internalDomains: string[];
  externalDomains: string[];
}

function normalizeDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at === -1 || at === trimmed.length - 1) {
    return null;
  }

  return trimmed.slice(at + 1);
}

function collectRecipientDomains(input: { to: string[]; cc: string[]; bcc: string[] }): string[] {
  return Array.from(new Set(
    [...input.to, ...input.cc, ...input.bcc]
      .map((item) => normalizeDomain(item))
      .filter((item): item is string => Boolean(item))
  ));
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
  const recipientDomains = collectRecipientDomains(input);
  const tenantPolicy = await ensureTenantSendPolicy(env, input.tenantId);
  const internalAllowlist = new Set(tenantPolicy.internalDomainAllowlist);
  const internalDomains = recipientDomains.filter((domain) => internalAllowlist.has(domain));
  const externalDomains = recipientDomains.filter((domain) => !internalAllowlist.has(domain));

  return {
    recipientDomains,
    internalDomains,
    externalDomains,
  };
}

export async function evaluateOutboundPolicy(env: Env, input: {
  tenantId: string;
  agentId: string;
  to: string[];
  cc: string[];
  bcc: string[];
}): Promise<OutboundPolicyDecision> {
  const { recipientDomains, externalDomains } = await classifyOutboundRecipients(env, input);
  if (recipientDomains.length === 0) {
    return {
      ok: false,
      code: "recipient_domain_not_allowed",
      message: "At least one valid recipient domain is required",
    };
  }

  const tenantPolicy = await ensureTenantSendPolicy(env, input.tenantId);
  const account = await ensureTenantBillingAccount(env, input.tenantId);
  const sendingUnlockedByPolicy =
    tenantPolicy.externalSendEnabled && tenantPolicy.outboundStatus === "external_enabled";
  const sendingUnlockedByCredits = account.availableCredits > 0;
  const externalSendingUnlockedByPolicy = sendingUnlockedByPolicy;
  const externalSendingUnlockedByCredits = sendingUnlockedByCredits;
  const externalSendingUnlocked =
    externalDomains.length > 0 &&
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
    if (externalDomains.length > 0) {
      return {
        ok: false,
        code: "external_send_not_enabled",
        message: `External sending requires available credits or an enabled outbound policy. Disallowed domains: ${externalDomains.join(", ")}`,
        recipientDomains,
        externalDomains,
      };
    }
  }

  const agentPolicy = await getAgentPolicy(env, input.agentId);
  if (agentPolicy?.allowedRecipientDomains.length) {
    const bypassDefaultInternalOnlyAllowlist =
      externalDomains.length > 0 &&
      sendingUnlockedByCredits &&
      isDefaultSelfServeInternalOnlyAgentPolicy(agentPolicy, tenantPolicy.internalDomainAllowlist);

    if (!bypassDefaultInternalOnlyAllowlist) {
      const allowedDomains = new Set(agentPolicy.allowedRecipientDomains.map((item) => item.toLowerCase()));
      const disallowed = recipientDomains.filter((domain) => !allowedDomains.has(domain));
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
  };
}
