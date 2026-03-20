import type { CreditLedgerEntryRecord } from "../../types";
import type {
  X402FacilitatorSettlementResponse,
  X402FacilitatorVerificationResponse,
} from "./x402-facilitator";
import type { TopupReceiptMetadata } from "./receipt-metadata";

export interface TopupSettlementLedgerMetadata {
  entryType: "topup";
  receiptType: "topup";
  confirmationMode: "manual_admin" | "facilitator";
  creditsRequested: number;
  facilitatorVerify?: X402FacilitatorVerificationResponse;
  facilitatorSettle?: X402FacilitatorSettlementResponse;
}

export type TypedCreditLedgerEntryRecord = CreditLedgerEntryRecord<TopupSettlementLedgerMetadata>;

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

export function serializeCreditLedgerMetadata(metadata: TopupSettlementLedgerMetadata): Record<string, unknown> {
  return metadata as unknown as Record<string, unknown>;
}

export function parseTypedCreditLedgerEntry(
  entry: CreditLedgerEntryRecord<object | undefined>,
): TypedCreditLedgerEntryRecord | undefined {
  const metadata = asRecord(entry.metadata);
  if (
    entry.entryType !== "topup" ||
    !metadata ||
    metadata.entryType !== "topup" ||
    metadata.receiptType !== "topup" ||
    (metadata.confirmationMode !== "manual_admin" && metadata.confirmationMode !== "facilitator") ||
    typeof metadata.creditsRequested !== "number"
  ) {
    return undefined;
  }

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
