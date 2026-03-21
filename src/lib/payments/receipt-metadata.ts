import type { PaymentReceiptRecord, TenantOutboundStatus } from "../../types";
import type {
  X402FacilitatorSettlementResponse,
  X402FacilitatorVerificationResponse,
} from "./x402-facilitator";
import type {
  ParsedX402PaymentProof,
  X402PaymentPayload,
  X402PaymentRequirement,
  X402PaymentRequired,
  X402TopupQuote,
  X402UpgradeQuote,
} from "./x402";

export interface StoredX402PaymentProof {
  raw?: string;
  parsed?: Record<string, unknown>;
}

export type PaymentConfirmationMode = "manual_admin" | "facilitator";

interface X402ReceiptMetadataBase {
  tenantDid?: string;
  paymentProof: StoredX402PaymentProof;
  confirmationMode?: PaymentConfirmationMode;
  facilitatorVerify?: X402FacilitatorVerificationResponse;
  facilitatorSettle?: X402FacilitatorSettlementResponse;
  facilitatorStatusCode?: number;
  creditLedgerEntryId?: string;
  sendPolicyStatus?: TenantOutboundStatus;
}

export interface TopupReceiptMetadata extends X402ReceiptMetadataBase {
  receiptType: "topup";
  creditsRequested: number;
  quote: X402TopupQuote;
}

export interface UpgradeReceiptMetadata extends X402ReceiptMetadataBase {
  receiptType: "upgrade";
  targetPricingTier: "paid_review";
  quote: X402UpgradeQuote;
}

export type PaymentReceiptMetadata = TopupReceiptMetadata | UpgradeReceiptMetadata;
export type TopupPaymentReceiptRecord = PaymentReceiptRecord<TopupReceiptMetadata>;
export type UpgradePaymentReceiptRecord = PaymentReceiptRecord<UpgradeReceiptMetadata>;
export type TypedPaymentReceiptRecord = TopupPaymentReceiptRecord | UpgradePaymentReceiptRecord;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function asOutboundStatus(value: unknown): TenantOutboundStatus | undefined {
  return value === "internal_only" || value === "external_review" || value === "external_enabled" || value === "suspended"
    ? value
    : undefined;
}

function asConfirmationMode(value: unknown): PaymentConfirmationMode | undefined {
  return value === "manual_admin" || value === "facilitator" ? value : undefined;
}

function parseStoredPaymentProof(value: unknown): StoredX402PaymentProof | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const raw = asString(record.raw);
  const parsed = asRecord(record.parsed);
  if (!raw && !parsed) {
    return undefined;
  }

  return { raw, parsed };
}

function isTopupQuote(value: unknown): value is X402TopupQuote {
  const record = asRecord(value);
  const hasModernRequirements = asRecord(record?.paymentRequirements) && asRecord(record?.paymentRequired);
  const hasLegacyRequirements = asRecord(record?.paymentRequired);
  return Boolean(
    record &&
    typeof record.scheme === "string" &&
    typeof record.network === "string" &&
    typeof record.asset === "string" &&
    typeof record.credits === "number" &&
    typeof record.amountUsd === "string" &&
    typeof record.amountAtomic === "string" &&
    typeof record.description === "string" &&
    (typeof record.assetSymbol === "string" || typeof record.assetSymbol === "undefined") &&
    (hasModernRequirements || hasLegacyRequirements)
  );
}

function isUpgradeQuote(value: unknown): value is X402UpgradeQuote {
  const record = asRecord(value);
  const hasModernRequirements = asRecord(record?.paymentRequirements) && asRecord(record?.paymentRequired);
  const hasLegacyRequirements = asRecord(record?.paymentRequired);
  return Boolean(
    record &&
    typeof record.scheme === "string" &&
    typeof record.network === "string" &&
    typeof record.asset === "string" &&
    record.targetPricingTier === "paid_review" &&
    typeof record.amountUsd === "string" &&
    typeof record.amountAtomic === "string" &&
    typeof record.description === "string" &&
    (typeof record.assetSymbol === "string" || typeof record.assetSymbol === "undefined") &&
    (hasModernRequirements || hasLegacyRequirements)
  );
}

function parseMetadataBase(record: Record<string, unknown>): Omit<X402ReceiptMetadataBase, "paymentProof"> & {
  paymentProof?: StoredX402PaymentProof;
} {
  return {
    tenantDid: asString(record.tenantDid),
    paymentProof: parseStoredPaymentProof(record.paymentProof),
    confirmationMode: asConfirmationMode(record.confirmationMode),
    facilitatorVerify: record.facilitatorVerify as X402FacilitatorVerificationResponse | undefined,
    facilitatorSettle: record.facilitatorSettle as X402FacilitatorSettlementResponse | undefined,
    facilitatorStatusCode: asInteger(record.facilitatorStatusCode),
    creditLedgerEntryId: asString(record.creditLedgerEntryId),
    sendPolicyStatus: asOutboundStatus(record.sendPolicyStatus),
  };
}

export function buildTopupReceiptMetadata(input: {
  tenantDid?: string;
  creditsRequested: number;
  quote: X402TopupQuote;
  paymentProof: ParsedX402PaymentProof;
}): TopupReceiptMetadata {
  return {
    receiptType: "topup",
    tenantDid: input.tenantDid,
    creditsRequested: input.creditsRequested,
    quote: input.quote,
    paymentProof: {
      raw: input.paymentProof.raw,
      parsed: input.paymentProof.parsed,
    },
  };
}

export function buildUpgradeReceiptMetadata(input: {
  tenantDid?: string;
  targetPricingTier: "paid_review";
  quote: X402UpgradeQuote;
  paymentProof: ParsedX402PaymentProof;
}): UpgradeReceiptMetadata {
  return {
    receiptType: "upgrade",
    tenantDid: input.tenantDid,
    targetPricingTier: input.targetPricingTier,
    quote: input.quote,
    paymentProof: {
      raw: input.paymentProof.raw,
      parsed: input.paymentProof.parsed,
    },
  };
}

export function parsePaymentReceiptMetadata(
  receiptType: "topup" | "upgrade",
  value: object | undefined,
): PaymentReceiptMetadata | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const base = parseMetadataBase(record);
  if (!base.paymentProof) {
    return undefined;
  }

  if (receiptType === "topup") {
    const creditsRequested = asInteger(record.creditsRequested);
    if (!creditsRequested || !isTopupQuote(record.quote)) {
      return undefined;
    }

    return {
      receiptType: "topup",
      tenantDid: base.tenantDid,
      creditsRequested,
      quote: record.quote,
      paymentProof: base.paymentProof,
      confirmationMode: base.confirmationMode,
      facilitatorVerify: base.facilitatorVerify,
      facilitatorSettle: base.facilitatorSettle,
      facilitatorStatusCode: base.facilitatorStatusCode,
      creditLedgerEntryId: base.creditLedgerEntryId,
      sendPolicyStatus: base.sendPolicyStatus,
    };
  }

  if (record.targetPricingTier !== "paid_review" || !isUpgradeQuote(record.quote)) {
    return undefined;
  }

  return {
    receiptType: "upgrade",
    tenantDid: base.tenantDid,
    targetPricingTier: "paid_review",
    quote: record.quote,
    paymentProof: base.paymentProof,
    confirmationMode: base.confirmationMode,
    facilitatorVerify: base.facilitatorVerify,
    facilitatorSettle: base.facilitatorSettle,
    facilitatorStatusCode: base.facilitatorStatusCode,
    creditLedgerEntryId: base.creditLedgerEntryId,
    sendPolicyStatus: base.sendPolicyStatus,
  };
}

export function parseTypedPaymentReceipt(
  receipt: PaymentReceiptRecord<object | undefined>,
): TypedPaymentReceiptRecord | undefined {
  if (receipt.receiptType !== "topup" && receipt.receiptType !== "upgrade") {
    return undefined;
  }

  const metadata = parsePaymentReceiptMetadata(receipt.receiptType, receipt.metadata);
  if (!metadata) {
    return undefined;
  }

  return {
    ...receipt,
    metadata,
  } as TypedPaymentReceiptRecord;
}

export function getReceiptPaymentRequirements(metadata: PaymentReceiptMetadata | undefined): X402PaymentRequirement | null {
  if (!metadata) {
    return null;
  }

  return metadata.quote.paymentRequirements
    ?? getPaymentRequirementsFromRequired(metadata.quote.paymentRequired)
    ?? null;
}

export function getReceiptPaymentRequired(metadata: PaymentReceiptMetadata | undefined): X402PaymentRequired | null {
  return metadata?.quote.paymentRequired ?? null;
}

export function getReceiptPaymentPayload(metadata: PaymentReceiptMetadata | undefined): X402PaymentPayload | Record<string, unknown> | string | null {
  if (!metadata) {
    return null;
  }

  if (metadata.paymentProof.parsed) {
    return metadata.paymentProof.parsed as X402PaymentPayload | Record<string, unknown>;
  }

  return metadata.paymentProof.raw ?? null;
}

function getPaymentRequirementsFromRequired(value: unknown): X402PaymentRequirement | null {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.accepts) || record.accepts.length === 0) {
    return null;
  }

  const accepted = asRecord(record.accepts[0]);
  if (
    !accepted
    || typeof accepted.scheme !== "string"
    || typeof accepted.network !== "string"
    || typeof accepted.asset !== "string"
    || typeof accepted.amount !== "string"
    || typeof accepted.payTo !== "string"
    || typeof accepted.maxTimeoutSeconds !== "number"
  ) {
    return null;
  }

  return accepted as unknown as X402PaymentRequirement;
}

export function withReceiptConfirmation(
  metadata: PaymentReceiptMetadata,
  input: {
    confirmationMode: PaymentConfirmationMode;
    facilitatorStatusCode?: number;
    facilitatorVerify?: X402FacilitatorVerificationResponse;
    facilitatorSettle?: X402FacilitatorSettlementResponse;
    creditLedgerEntryId?: string;
    sendPolicyStatus?: TenantOutboundStatus;
  },
): PaymentReceiptMetadata {
  return {
    ...metadata,
    confirmationMode: input.confirmationMode,
    facilitatorStatusCode: input.facilitatorStatusCode ?? metadata.facilitatorStatusCode,
    facilitatorVerify: input.facilitatorVerify ?? metadata.facilitatorVerify,
    facilitatorSettle: input.facilitatorSettle ?? metadata.facilitatorSettle,
    creditLedgerEntryId: input.creditLedgerEntryId ?? metadata.creditLedgerEntryId,
    sendPolicyStatus: input.sendPolicyStatus ?? metadata.sendPolicyStatus,
  };
}

export function serializePaymentReceiptMetadata(metadata: PaymentReceiptMetadata): Record<string, unknown> {
  return metadata as unknown as Record<string, unknown>;
}
