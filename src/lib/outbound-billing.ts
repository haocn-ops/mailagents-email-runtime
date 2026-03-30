import { classifyOutboundUsageEntryType, getOutboundCreditRequirement } from "./outbound-credits";
import { buildOutboundUsageLedgerMetadata } from "./payments/ledger-metadata";
import {
  appendOutboundUsageLedgerEntry,
  captureTenantReservedCredits,
  getTypedCreditLedgerEntryByReferenceId,
  reconcileTenantAvailableCredits,
  releaseTenantReservedCredits,
} from "../repositories/billing";
import type { Env } from "../types";

export async function settleOutboundUsageDebit(env: Env, input: {
  tenantId: string;
  messageId: string;
  outboundJobId: string;
  draftId?: string;
  draftCreatedVia?: string;
  sourceMessageId?: string;
  to: string[];
  cc: string[];
  bcc: string[];
}): Promise<void> {
  const requirement = await getOutboundCreditRequirement(env, {
    tenantId: input.tenantId,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    sourceMessageId: input.sourceMessageId,
    createdVia: input.draftCreatedVia,
  });

  if (!requirement.requiresCredits) {
    return;
  }

  const entryType = classifyOutboundUsageEntryType({
    sourceMessageId: input.sourceMessageId,
    createdVia: input.draftCreatedVia,
  });

  const existing = await getTypedCreditLedgerEntryByReferenceId(env, input.tenantId, input.outboundJobId);
  if (!existing) {
    await appendOutboundUsageLedgerEntry(env, {
      tenantId: input.tenantId,
      entryType,
      creditsDelta: -requirement.creditsRequired,
      reason: "outbound_send_settlement",
      referenceId: input.outboundJobId,
      metadata: buildOutboundUsageLedgerMetadata({
        entryType,
        creditsCharged: requirement.creditsRequired,
        messageId: input.messageId,
        outboundJobId: input.outboundJobId,
        draftId: input.draftId,
        draftCreatedVia: input.draftCreatedVia,
        recipientDomains: requirement.recipientDomains,
        externalDomains: requirement.externalDomains,
      }),
    });
  } else {
    // The ledger entry is the durable settlement record. Avoid duplicate captures on retries
    // because another outbound job may now own the remaining reserved credits.
    await reconcileTenantAvailableCredits(env, input.tenantId);
    return;
  }

  await captureTenantReservedCredits(env, input.tenantId, requirement.creditsRequired).catch(() => null);
  await reconcileTenantAvailableCredits(env, input.tenantId);
}

export async function releaseOutboundUsageReservation(env: Env, input: {
  tenantId: string;
  outboundJobId: string;
  sourceMessageId?: string;
  draftCreatedVia?: string;
  to: string[];
  cc: string[];
  bcc: string[];
}): Promise<void> {
  const requirement = await getOutboundCreditRequirement(env, {
    tenantId: input.tenantId,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    sourceMessageId: input.sourceMessageId,
    createdVia: input.draftCreatedVia,
  });

  if (!requirement.requiresCredits) {
    return;
  }

  await releaseTenantReservedCredits(env, input.tenantId, requirement.creditsRequired);
}
