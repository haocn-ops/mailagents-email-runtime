import type { CreditLedgerEntryRecord } from "../../types";
import type {
  X402FacilitatorSettlementResponse,
  X402FacilitatorVerificationResponse,
} from "./x402-facilitator";
import type {
  TopupReceiptMetadata,
  UpgradeReceiptMetadata,
} from "./receipt-metadata";

export interface TopupSettlementLedgerMetadata {
  entryType: "topup";
  receiptType: "topup";
  confirmationMode: "manual_admin" | "facilitator";
  creditsRequested: number;
  facilitatorVerify?: X402FacilitatorVerificationResponse;
  facilitatorSettle?: X402FacilitatorSettlementResponse;
}

export interface OutboundUsageLedgerMetadata {
  entryType: "debit_send" | "debit_reply";
  usageType: "send" | "reply";
  chargeStage: "post_send";
  creditsCharged: number;
  messageId: string;
  outboundJobId: string;
  draftId?: string;
  draftCreatedVia?: string;
  recipientDomains: string[];
  externalDomains: string[];
}

export interface UpgradeCreditGrantLedgerMetadata {
  entryType: "adjustment";
  receiptType: "upgrade";
  confirmationMode: "manual_admin" | "facilitator";
  creditsGranted: number;
  targetPricingTier: "paid_review";
  facilitatorVerify?: X402FacilitatorVerificationResponse;
  facilitatorSettle?: X402FacilitatorSettlementResponse;
}

export type CreditLedgerMetadata =
  | TopupSettlementLedgerMetadata
  | UpgradeCreditGrantLedgerMetadata
  | OutboundUsageLedgerMetadata;
export type TypedTopupCreditLedgerEntryRecord = CreditLedgerEntryRecord<TopupSettlementLedgerMetadata>;
export type TypedUpgradeCreditLedgerEntryRecord = CreditLedgerEntryRecord<UpgradeCreditGrantLedgerMetadata>;
export type TypedOutboundUsageCreditLedgerEntryRecord = CreditLedgerEntryRecord<OutboundUsageLedgerMetadata>;
export type TypedCreditLedgerEntryRecord =
  | TypedTopupCreditLedgerEntryRecord
  | TypedUpgradeCreditLedgerEntryRecord
  | TypedOutboundUsageCreditLedgerEntryRecord;

export function isTopupSettlementLedgerEntry(
  entry: TypedCreditLedgerEntryRecord | null | undefined,
): entry is TypedTopupCreditLedgerEntryRecord {
  const metadata = entry?.metadata;
  return Boolean(
    entry
    && metadata
    && entry.entryType === "topup"
    && metadata.entryType === "topup"
    && "receiptType" in metadata
    && metadata.receiptType === "topup",
  );
}

export function isUpgradeCreditGrantLedgerEntry(
  entry: TypedCreditLedgerEntryRecord | null | undefined,
): entry is TypedUpgradeCreditLedgerEntryRecord {
  const metadata = entry?.metadata;
  return Boolean(
    entry
    && metadata
    && entry.entryType === "adjustment"
    && metadata.entryType === "adjustment"
    && "receiptType" in metadata
    && metadata.receiptType === "upgrade",
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function buildTopupSettlementLedgerMetadata(input: {
  receiptMetadata: TopupReceiptMetadata;
  confirmationMode: "manual_admin" | "facilitator";
  facilitatorVerify?: X402FacilitatorVerificationResponse;
  facilitatorSettle?: X402FacilitatorSettlementResponse;
}): TopupSettlementLedgerMetadata {
  return {
    entryType: "topup",
    receiptType: "topup",
    confirmationMode: input.confirmationMode,
    creditsRequested: input.receiptMetadata.creditsRequested,
    facilitatorVerify: input.facilitatorVerify,
    facilitatorSettle: input.facilitatorSettle,
  };
}

export function buildUpgradeCreditGrantLedgerMetadata(input: {
  receiptMetadata: UpgradeReceiptMetadata;
  confirmationMode: "manual_admin" | "facilitator";
  facilitatorVerify?: X402FacilitatorVerificationResponse;
  facilitatorSettle?: X402FacilitatorSettlementResponse;
}): UpgradeCreditGrantLedgerMetadata {
  return {
    entryType: "adjustment",
    receiptType: "upgrade",
    confirmationMode: input.confirmationMode,
    creditsGranted: input.receiptMetadata.includedCredits,
    targetPricingTier: input.receiptMetadata.targetPricingTier,
    facilitatorVerify: input.facilitatorVerify,
    facilitatorSettle: input.facilitatorSettle,
  };
}

export function buildOutboundUsageLedgerMetadata(input: {
  entryType: "debit_send" | "debit_reply";
  creditsCharged: number;
  messageId: string;
  outboundJobId: string;
  draftId?: string;
  draftCreatedVia?: string;
  recipientDomains: string[];
  externalDomains: string[];
}): OutboundUsageLedgerMetadata {
  return {
    entryType: input.entryType,
    usageType: input.entryType === "debit_reply" ? "reply" : "send",
    chargeStage: "post_send",
    creditsCharged: input.creditsCharged,
    messageId: input.messageId,
    outboundJobId: input.outboundJobId,
    draftId: input.draftId,
    draftCreatedVia: input.draftCreatedVia,
    recipientDomains: input.recipientDomains,
    externalDomains: input.externalDomains,
  };
}

export function serializeCreditLedgerMetadata(metadata: CreditLedgerMetadata): Record<string, unknown> {
  return metadata as unknown as Record<string, unknown>;
}

export function parseTypedCreditLedgerEntry(
  entry: CreditLedgerEntryRecord<object | undefined>,
): TypedCreditLedgerEntryRecord | undefined {
  const metadata = asRecord(entry.metadata);
  if (!metadata) {
    return undefined;
  }

  if (
    entry.entryType === "topup" &&
    metadata.entryType === "topup" &&
    metadata.receiptType === "topup" &&
    (metadata.confirmationMode === "manual_admin" || metadata.confirmationMode === "facilitator") &&
    typeof metadata.creditsRequested === "number"
  ) {
    return {
      ...entry,
      metadata: {
        entryType: "topup",
        receiptType: "topup",
        confirmationMode: metadata.confirmationMode,
        creditsRequested: metadata.creditsRequested,
        facilitatorVerify: metadata.facilitatorVerify as X402FacilitatorVerificationResponse | undefined,
        facilitatorSettle: metadata.facilitatorSettle as X402FacilitatorSettlementResponse | undefined,
      },
    };
  }

  if (
    entry.entryType === "adjustment" &&
    metadata.entryType === "adjustment" &&
    metadata.receiptType === "upgrade" &&
    (metadata.confirmationMode === "manual_admin" || metadata.confirmationMode === "facilitator") &&
    typeof metadata.creditsGranted === "number" &&
    metadata.targetPricingTier === "paid_review"
  ) {
    return {
      ...entry,
      metadata: {
        entryType: "adjustment",
        receiptType: "upgrade",
        confirmationMode: metadata.confirmationMode,
        creditsGranted: metadata.creditsGranted,
        targetPricingTier: "paid_review",
        facilitatorVerify: metadata.facilitatorVerify as X402FacilitatorVerificationResponse | undefined,
        facilitatorSettle: metadata.facilitatorSettle as X402FacilitatorSettlementResponse | undefined,
      },
    };
  }

  if (
    (entry.entryType === "debit_send" || entry.entryType === "debit_reply") &&
    metadata.entryType === entry.entryType &&
    (metadata.usageType === "send" || metadata.usageType === "reply") &&
    metadata.chargeStage === "post_send" &&
    typeof metadata.creditsCharged === "number" &&
    typeof metadata.messageId === "string" &&
    typeof metadata.outboundJobId === "string" &&
    Array.isArray(metadata.recipientDomains) &&
    Array.isArray(metadata.externalDomains)
  ) {
    const entryType = entry.entryType;
    return {
      ...entry,
      metadata: {
        entryType,
        usageType: metadata.usageType,
        chargeStage: "post_send",
        creditsCharged: metadata.creditsCharged,
        messageId: metadata.messageId,
        outboundJobId: metadata.outboundJobId,
        draftId: typeof metadata.draftId === "string" ? metadata.draftId : undefined,
        draftCreatedVia: typeof metadata.draftCreatedVia === "string" ? metadata.draftCreatedVia : undefined,
        recipientDomains: metadata.recipientDomains.filter((item): item is string => typeof item === "string"),
        externalDomains: metadata.externalDomains.filter((item): item is string => typeof item === "string"),
      },
    };
  }

  return undefined;
}
