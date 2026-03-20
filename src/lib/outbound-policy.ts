import { getAgentPolicy } from "../repositories/agents";
import { ensureTenantSendPolicy } from "../repositories/tenant-policies";
import type { Env } from "../types";

export interface OutboundPolicyDecision {
  ok: boolean;
  code?: "access_mailbox_denied" | "external_send_not_enabled" | "recipient_domain_not_allowed";
  message?: string;
  recipientDomains?: string[];
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

export async function evaluateOutboundPolicy(env: Env, input: {
  tenantId: string;
  agentId: string;
  to: string[];
  cc: string[];
  bcc: string[];
}): Promise<OutboundPolicyDecision> {
  const recipientDomains = collectRecipientDomains(input);
  if (recipientDomains.length === 0) {
    return {
      ok: false,
      code: "recipient_domain_not_allowed",
      message: "At least one valid recipient domain is required",
    };
  }

  const tenantPolicy = await ensureTenantSendPolicy(env, input.tenantId);
  if (tenantPolicy.outboundStatus === "suspended") {
    return {
      ok: false,
      code: "access_mailbox_denied",
      message: "Outbound sending is suspended for this tenant",
    };
  }

  const internalAllowlist = new Set(tenantPolicy.internalDomainAllowlist);
  const externalDomains = recipientDomains.filter((domain) => !internalAllowlist.has(domain));

  if (!tenantPolicy.externalSendEnabled || tenantPolicy.outboundStatus !== "external_enabled") {
    if (externalDomains.length > 0) {
      return {
        ok: false,
        code: "external_send_not_enabled",
        message: `External sending is not enabled for this tenant. Disallowed domains: ${externalDomains.join(", ")}`,
        recipientDomains,
      };
    }
  }

  const agentPolicy = await getAgentPolicy(env, input.agentId);
  if (agentPolicy?.allowedRecipientDomains.length) {
    const allowedDomains = new Set(agentPolicy.allowedRecipientDomains.map((item) => item.toLowerCase()));
    const disallowed = recipientDomains.filter((domain) => !allowedDomains.has(domain));
    if (disallowed.length > 0) {
      return {
        ok: false,
        code: "recipient_domain_not_allowed",
        message: `Recipient domains are not allowed for this agent: ${disallowed.join(", ")}`,
        recipientDomains,
      };
    }
  }

  return {
    ok: true,
    recipientDomains,
  };
}
