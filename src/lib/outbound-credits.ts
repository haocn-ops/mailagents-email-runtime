import { ensureTenantBillingAccount } from "../repositories/billing";
import { classifyOutboundRecipients } from "./outbound-policy";
import type { CreditLedgerEntryType, Env } from "../types";

export type OutboundUsageEntryType = Extract<CreditLedgerEntryType, "debit_send" | "debit_reply">;

export interface OutboundCreditRequirement {
  entryType: OutboundUsageEntryType;
  creditsRequired: number;
  requiresCredits: boolean;
  recipientDomains: string[];
  externalDomains: string[];
}

const DEFAULT_OUTBOUND_CREDITS_PER_SEND = 1;
const CREDIT_EXEMPT_CREATED_VIA = new Set([
  "system:signup_welcome",
  "system:token_reissue_operator_email",
  "system:token_reissue_self_mailbox",
]);

function isCreditExemptCreatedVia(createdVia: string | undefined): boolean {
  return CREDIT_EXEMPT_CREATED_VIA.has(createdVia?.toLowerCase() ?? "");
}

export function classifyOutboundUsageEntryType(input: {
  sourceMessageId?: string;
  createdVia?: string;
}): OutboundUsageEntryType {
  if (input.sourceMessageId) {
    return "debit_reply";
  }

  const createdVia = input.createdVia?.toLowerCase() ?? "";
  if (createdVia.includes("reply")) {
    return "debit_reply";
  }

  return "debit_send";
}

export function getOutboundCreditsRequired(_entryType: OutboundUsageEntryType): number {
  return DEFAULT_OUTBOUND_CREDITS_PER_SEND;
}

export async function getOutboundCreditRequirement(env: Env, input: {
  tenantId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  sourceMessageId?: string;
  createdVia?: string;
}): Promise<OutboundCreditRequirement> {
  const classification = await classifyOutboundRecipients(env, {
    tenantId: input.tenantId,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
  });

  const entryType = classifyOutboundUsageEntryType(input);
  if (isCreditExemptCreatedVia(input.createdVia)) {
    return {
      entryType,
      creditsRequired: 0,
      requiresCredits: false,
      recipientDomains: classification.recipientDomains,
      externalDomains: classification.externalDomains,
    };
  }

  return {
    entryType,
    creditsRequired: getOutboundCreditsRequired(entryType),
    requiresCredits: classification.externalDomains.length > 0,
    recipientDomains: classification.recipientDomains,
    externalDomains: classification.externalDomains,
  };
}

export async function checkOutboundCreditRequirement(env: Env, input: {
  tenantId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  sourceMessageId?: string;
  createdVia?: string;
}): Promise<OutboundCreditRequirement & {
  availableCredits?: number;
  hasSufficientCredits: boolean;
}> {
  const requirement = await getOutboundCreditRequirement(env, input);
  if (!requirement.requiresCredits) {
    return {
      ...requirement,
      hasSufficientCredits: true,
    };
  }

  const account = await ensureTenantBillingAccount(env, input.tenantId);
  return {
    ...requirement,
    availableCredits: account.availableCredits,
    hasSufficientCredits: account.availableCredits >= requirement.creditsRequired,
  };
}
