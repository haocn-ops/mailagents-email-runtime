import { createId } from "../lib/ids";
import { allRows, execute, firstRow, requireRow } from "../lib/db";
import {
  parseTypedCreditLedgerEntry,
  type OutboundUsageLedgerMetadata,
  type TopupSettlementLedgerMetadata,
  type TypedCreditLedgerEntryRecord,
  type UpgradeCreditGrantLedgerMetadata,
} from "../lib/payments/ledger-metadata";
import {
  parseTypedPaymentReceipt,
  type PaymentReceiptMetadata,
  type TopupPaymentReceiptRecord,
  type TypedPaymentReceiptRecord,
  type UpgradePaymentReceiptRecord,
} from "../lib/payments/receipt-metadata";
import { nowIso } from "../lib/time";
import type {
  BillingAccountRecord,
  CreditLedgerEntryRecord,
  CreditLedgerEntryType,
  Env,
  PaymentReceiptRecord,
  PaymentReceiptStatus,
  PaymentReceiptType,
  PricingTier,
  TenantBillingStatus,
} from "../types";

interface BillingAccountRow {
  tenant_id: string;
  status: TenantBillingStatus;
  pricing_tier: PricingTier;
  default_network: string | null;
  default_asset: string | null;
  available_credits: number;
  reserved_credits: number;
  updated_at: string;
}

interface CreditLedgerRow {
  id: string;
  tenant_id: string;
  entry_type: CreditLedgerEntryType;
  credits_delta: number;
  reason: string;
  payment_receipt_id: string | null;
  reference_id: string | null;
  metadata_json: string | null;
  created_at: string;
}

interface PaymentReceiptRow {
  id: string;
  tenant_id: string;
  receipt_type: PaymentReceiptType;
  payment_scheme: string;
  network: string | null;
  asset: string | null;
  amount_atomic: string;
  amount_display: string | null;
  payment_reference: string | null;
  settlement_reference: string | null;
  payment_proof_fingerprint: string | null;
  status: PaymentReceiptStatus;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

function parseJsonObject(value: string | null): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function mapBillingAccountRow(row: BillingAccountRow): BillingAccountRecord {
  return {
    tenantId: row.tenant_id,
    status: row.status,
    pricingTier: row.pricing_tier,
    defaultNetwork: row.default_network ?? undefined,
    defaultAsset: row.default_asset ?? undefined,
    availableCredits: Number(row.available_credits ?? 0),
    reservedCredits: Number(row.reserved_credits ?? 0),
    updatedAt: row.updated_at,
  };
}

function mapCreditLedgerRow(row: CreditLedgerRow): CreditLedgerEntryRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    entryType: row.entry_type,
    creditsDelta: Number(row.credits_delta ?? 0),
    reason: row.reason,
    paymentReceiptId: row.payment_receipt_id ?? undefined,
    referenceId: row.reference_id ?? undefined,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
  };
}

function mapPaymentReceiptRow(row: PaymentReceiptRow): PaymentReceiptRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    receiptType: row.receipt_type,
    paymentScheme: row.payment_scheme,
    network: row.network ?? undefined,
    asset: row.asset ?? undefined,
    amountAtomic: row.amount_atomic,
    amountDisplay: row.amount_display ?? undefined,
    paymentReference: row.payment_reference ?? undefined,
    settlementReference: row.settlement_reference ?? undefined,
    status: row.status,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getTenantBillingAccount(env: Env, tenantId: string): Promise<BillingAccountRecord | null> {
  const row = await firstRow<BillingAccountRow>(
    env.D1_DB.prepare(
      `SELECT tenant_id, status, pricing_tier, default_network, default_asset,
              available_credits, reserved_credits, updated_at
       FROM tenant_billing_accounts
       WHERE tenant_id = ?`
    ).bind(tenantId)
  );

  return row ? mapBillingAccountRow(row) : null;
}

export async function ensureTenantBillingAccount(env: Env, tenantId: string): Promise<BillingAccountRecord> {
  const existing = await getTenantBillingAccount(env, tenantId);
  if (existing) {
    return existing;
  }

  const updatedAt = nowIso();
  await execute(env.D1_DB.prepare(
    `INSERT OR IGNORE INTO tenant_billing_accounts (
       tenant_id, status, pricing_tier, default_network, default_asset,
       available_credits, reserved_credits, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    tenantId,
    "trial",
    "free",
    null,
    null,
    0,
    0,
    updatedAt,
  ));

  const created = await getTenantBillingAccount(env, tenantId);
  return requireRow(created, "Failed to create tenant billing account");
}

export async function updateTenantBillingAccountProfile(env: Env, input: {
  tenantId: string;
  status?: TenantBillingStatus;
  pricingTier?: PricingTier;
  defaultNetwork?: string;
  defaultAsset?: string;
}): Promise<BillingAccountRecord> {
  await ensureTenantBillingAccount(env, input.tenantId);

  const hasStatus = input.status !== undefined;
  const hasPricingTier = input.pricingTier !== undefined;
  const hasDefaultNetwork = input.defaultNetwork !== undefined;
  const hasDefaultAsset = input.defaultAsset !== undefined;

  await execute(env.D1_DB.prepare(
    `UPDATE tenant_billing_accounts
     SET status = CASE WHEN ? THEN ? ELSE status END,
         pricing_tier = CASE WHEN ? THEN ? ELSE pricing_tier END,
         default_network = CASE WHEN ? THEN ? ELSE default_network END,
         default_asset = CASE WHEN ? THEN ? ELSE default_asset END,
         updated_at = ?
     WHERE tenant_id = ?`
  ).bind(
    hasStatus ? 1 : 0,
    input.status ?? null,
    hasPricingTier ? 1 : 0,
    input.pricingTier ?? null,
    hasDefaultNetwork ? 1 : 0,
    input.defaultNetwork ?? null,
    hasDefaultAsset ? 1 : 0,
    input.defaultAsset ?? null,
    nowIso(),
    input.tenantId,
  ));

  return await ensureTenantBillingAccount(env, input.tenantId);
}

export async function listTenantCreditLedger(env: Env, tenantId: string, limit = 50): Promise<CreditLedgerEntryRecord[]> {
  const rows = await allRows<CreditLedgerRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, entry_type, credits_delta, reason, payment_receipt_id,
              reference_id, metadata_json, created_at
       FROM tenant_credit_ledger
       WHERE tenant_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    ).bind(tenantId, limit)
  );

  return rows.map(mapCreditLedgerRow);
}

export async function listTypedTenantCreditLedger(env: Env, tenantId: string, limit = 50): Promise<TypedCreditLedgerEntryRecord[]> {
  const entries = await listTenantCreditLedger(env, tenantId, limit);
  return entries
    .map((entry) => parseTypedCreditLedgerEntry(entry))
    .filter((entry): entry is TypedCreditLedgerEntryRecord => Boolean(entry));
}

export async function listTenantPaymentReceipts(env: Env, tenantId: string, limit = 50): Promise<PaymentReceiptRecord[]> {
  const rows = await allRows<PaymentReceiptRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, receipt_type, payment_scheme, network, asset, amount_atomic,
              amount_display, payment_reference, settlement_reference, payment_proof_fingerprint, status,
              metadata_json, created_at, updated_at
       FROM tenant_payment_receipts
       WHERE tenant_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    ).bind(tenantId, limit)
  );

  return rows.map(mapPaymentReceiptRow);
}

export async function listTypedTenantPaymentReceipts(env: Env, tenantId: string, limit = 50): Promise<TypedPaymentReceiptRecord[]> {
  const receipts = await listTenantPaymentReceipts(env, tenantId, limit);
  return receipts
    .map((receipt) => parseTypedPaymentReceipt(receipt))
    .filter((receipt): receipt is TypedPaymentReceiptRecord => Boolean(receipt));
}

export async function getTenantPaymentReceiptById(env: Env, tenantId: string, receiptId: string): Promise<PaymentReceiptRecord | null> {
  const row = await firstRow<PaymentReceiptRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, receipt_type, payment_scheme, network, asset, amount_atomic,
              amount_display, payment_reference, settlement_reference, payment_proof_fingerprint, status,
              metadata_json, created_at, updated_at
       FROM tenant_payment_receipts
       WHERE tenant_id = ? AND id = ?`
    ).bind(tenantId, receiptId)
  );

  return row ? mapPaymentReceiptRow(row) : null;
}

export async function getTypedTenantPaymentReceiptById(
  env: Env,
  tenantId: string,
  receiptId: string,
): Promise<TypedPaymentReceiptRecord | null> {
  const receipt = await getTenantPaymentReceiptById(env, tenantId, receiptId);
  return receipt ? parseTypedPaymentReceipt(receipt) ?? null : null;
}

export async function getTypedPaymentReceiptByProofFingerprint(
  env: Env,
  paymentProofFingerprint: string,
): Promise<TypedPaymentReceiptRecord | null> {
  const row = await firstRow<PaymentReceiptRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, receipt_type, payment_scheme, network, asset, amount_atomic,
              amount_display, payment_reference, settlement_reference, payment_proof_fingerprint, status,
              metadata_json, created_at, updated_at
       FROM tenant_payment_receipts
       WHERE payment_proof_fingerprint = ?
       ORDER BY created_at DESC
       LIMIT 1`
    ).bind(paymentProofFingerprint)
  );

  const receipt = row ? mapPaymentReceiptRow(row) : null;
  return receipt ? parseTypedPaymentReceipt(receipt) ?? null : null;
}

export async function getCreditLedgerEntryByPaymentReceiptId(env: Env, tenantId: string, paymentReceiptId: string): Promise<CreditLedgerEntryRecord | null> {
  const row = await firstRow<CreditLedgerRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, entry_type, credits_delta, reason, payment_receipt_id,
              reference_id, metadata_json, created_at
       FROM tenant_credit_ledger
       WHERE tenant_id = ? AND payment_receipt_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
    ).bind(tenantId, paymentReceiptId)
  );

  return row ? mapCreditLedgerRow(row) : null;
}

export async function getTypedCreditLedgerEntryByPaymentReceiptId(
  env: Env,
  tenantId: string,
  paymentReceiptId: string,
): Promise<TypedCreditLedgerEntryRecord | null> {
  const entry = await getCreditLedgerEntryByPaymentReceiptId(env, tenantId, paymentReceiptId);
  return entry ? parseTypedCreditLedgerEntry(entry) ?? null : null;
}

export async function getCreditLedgerEntryByReferenceId(env: Env, tenantId: string, referenceId: string): Promise<CreditLedgerEntryRecord | null> {
  const row = await firstRow<CreditLedgerRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, entry_type, credits_delta, reason, payment_receipt_id,
              reference_id, metadata_json, created_at
       FROM tenant_credit_ledger
       WHERE tenant_id = ? AND reference_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
    ).bind(tenantId, referenceId)
  );

  return row ? mapCreditLedgerRow(row) : null;
}

export async function getTypedCreditLedgerEntryByReferenceId(
  env: Env,
  tenantId: string,
  referenceId: string,
): Promise<TypedCreditLedgerEntryRecord | null> {
  const entry = await getCreditLedgerEntryByReferenceId(env, tenantId, referenceId);
  return entry ? parseTypedCreditLedgerEntry(entry) ?? null : null;
}

export async function createTenantPaymentReceipt(env: Env, input: {
  tenantId: string;
  receiptType: PaymentReceiptType;
  paymentScheme: string;
  amountAtomic: string;
  status: PaymentReceiptStatus;
  network?: string;
  asset?: string;
  amountDisplay?: string;
  paymentReference?: string;
  settlementReference?: string;
  paymentProofFingerprint?: string;
  metadata?: object;
}): Promise<PaymentReceiptRecord> {
  const id = createId("prc");
  const timestamp = nowIso();
  await execute(env.D1_DB.prepare(
    `INSERT INTO tenant_payment_receipts (
       id, tenant_id, receipt_type, payment_scheme, network, asset, amount_atomic,
       amount_display, payment_reference, settlement_reference, payment_proof_fingerprint, status,
       metadata_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    input.tenantId,
    input.receiptType,
    input.paymentScheme,
    input.network ?? null,
    input.asset ?? null,
    input.amountAtomic,
    input.amountDisplay ?? null,
    input.paymentReference ?? null,
    input.settlementReference ?? null,
    input.paymentProofFingerprint ?? null,
    input.status,
    input.metadata ? JSON.stringify(input.metadata) : null,
    timestamp,
    timestamp,
  ));

  const row = await firstRow<PaymentReceiptRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, receipt_type, payment_scheme, network, asset, amount_atomic,
              amount_display, payment_reference, settlement_reference, payment_proof_fingerprint, status,
              metadata_json, created_at, updated_at
       FROM tenant_payment_receipts
       WHERE id = ?`
    ).bind(id)
  );

  return mapPaymentReceiptRow(requireRow(row, "Failed to load payment receipt"));
}

export async function createTypedTenantPaymentReceipt(env: Env, input: {
  tenantId: string;
  receiptType: "topup";
  paymentScheme: string;
  amountAtomic: string;
  status: PaymentReceiptStatus;
  network?: string;
  asset?: string;
  amountDisplay?: string;
  paymentReference?: string;
  settlementReference?: string;
  paymentProofFingerprint?: string;
  metadata: Extract<PaymentReceiptMetadata, { receiptType: "topup" }>;
}): Promise<TopupPaymentReceiptRecord>;
export async function createTypedTenantPaymentReceipt(env: Env, input: {
  tenantId: string;
  receiptType: "upgrade";
  paymentScheme: string;
  amountAtomic: string;
  status: PaymentReceiptStatus;
  network?: string;
  asset?: string;
  amountDisplay?: string;
  paymentReference?: string;
  settlementReference?: string;
  paymentProofFingerprint?: string;
  metadata: Extract<PaymentReceiptMetadata, { receiptType: "upgrade" }>;
}): Promise<UpgradePaymentReceiptRecord>;
export async function createTypedTenantPaymentReceipt(env: Env, input: {
  tenantId: string;
  receiptType: "topup" | "upgrade";
  paymentScheme: string;
  amountAtomic: string;
  status: PaymentReceiptStatus;
  network?: string;
  asset?: string;
  amountDisplay?: string;
  paymentReference?: string;
  settlementReference?: string;
  paymentProofFingerprint?: string;
  metadata: PaymentReceiptMetadata;
}): Promise<TypedPaymentReceiptRecord> {
  const receipt = await createTenantPaymentReceipt(env, input);
  const typed = parseTypedPaymentReceipt(receipt);
  if (!typed || typed.receiptType !== input.receiptType) {
    throw new Error("Failed to create typed payment receipt");
  }
  return typed;
}

export async function updateTenantPaymentReceiptStatus(env: Env, input: {
  tenantId: string;
  receiptId: string;
  status: PaymentReceiptStatus;
  paymentReference?: string;
  settlementReference?: string;
  metadata?: object;
}): Promise<PaymentReceiptRecord> {
  const existing = await getTenantPaymentReceiptById(env, input.tenantId, input.receiptId);
  if (!existing) {
    throw new Error("Payment receipt not found");
  }

  const updatedAt = nowIso();
  const nextMetadata = input.metadata
    ? { ...(existing.metadata ?? {}), ...input.metadata }
    : existing.metadata;

  await execute(env.D1_DB.prepare(
    `UPDATE tenant_payment_receipts
     SET status = ?,
         payment_reference = ?,
         settlement_reference = ?,
         metadata_json = ?,
         updated_at = ?
     WHERE tenant_id = ? AND id = ?`
  ).bind(
    input.status,
    input.paymentReference ?? existing.paymentReference ?? null,
    input.settlementReference ?? existing.settlementReference ?? null,
    nextMetadata ? JSON.stringify(nextMetadata) : null,
    updatedAt,
    input.tenantId,
    input.receiptId,
  ));

  const row = await firstRow<PaymentReceiptRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, receipt_type, payment_scheme, network, asset, amount_atomic,
              amount_display, payment_reference, settlement_reference, payment_proof_fingerprint, status,
              metadata_json, created_at, updated_at
       FROM tenant_payment_receipts
       WHERE tenant_id = ? AND id = ?`
    ).bind(input.tenantId, input.receiptId)
  );

  return mapPaymentReceiptRow(requireRow(row, "Failed to load payment receipt"));
}

export async function updateTypedTenantPaymentReceiptStatus(env: Env, input: {
  tenantId: string;
  receiptId: string;
  status: PaymentReceiptStatus;
  paymentReference?: string;
  settlementReference?: string;
  metadata?: PaymentReceiptMetadata;
}): Promise<TypedPaymentReceiptRecord> {
  const receipt = await updateTenantPaymentReceiptStatus(env, input);
  const typed = parseTypedPaymentReceipt(receipt);
  if (!typed) {
    throw new Error("Failed to update typed payment receipt");
  }
  return typed;
}

export async function reconcileTenantAvailableCredits(env: Env, tenantId: string): Promise<BillingAccountRecord> {
  await ensureTenantBillingAccount(env, tenantId);
  const row = await firstRow<{ total_credits: number | null }>(
    env.D1_DB.prepare(
      `SELECT COALESCE(SUM(credits_delta), 0) AS total_credits
       FROM tenant_credit_ledger
       WHERE tenant_id = ?`
    ).bind(tenantId)
  );
  const totalCredits = Number(row?.total_credits ?? 0);
  await execute(env.D1_DB.prepare(
    `UPDATE tenant_billing_accounts
     SET available_credits = ? - reserved_credits,
         updated_at = ?
     WHERE tenant_id = ?`
  ).bind(
    totalCredits,
    nowIso(),
    tenantId,
  ));
  return await ensureTenantBillingAccount(env, tenantId);
}

export async function reserveTenantAvailableCredits(env: Env, tenantId: string, creditsDelta: number): Promise<BillingAccountRecord | null> {
  const updatedAt = nowIso();
  const result = await execute(env.D1_DB.prepare(
    `UPDATE tenant_billing_accounts
     SET available_credits = available_credits - ?,
         reserved_credits = reserved_credits + ?,
         updated_at = ?
     WHERE tenant_id = ?
       AND available_credits >= ?`
  ).bind(
    creditsDelta,
    creditsDelta,
    updatedAt,
    tenantId,
    creditsDelta,
  ));

  if ((result.meta?.changes ?? 0) === 0) {
    return null;
  }

  return await ensureTenantBillingAccount(env, tenantId);
}

export async function releaseTenantReservedCredits(env: Env, tenantId: string, creditsDelta: number): Promise<BillingAccountRecord | null> {
  const updatedAt = nowIso();
  const result = await execute(env.D1_DB.prepare(
    `UPDATE tenant_billing_accounts
     SET available_credits = available_credits + ?,
         reserved_credits = reserved_credits - ?,
         updated_at = ?
     WHERE tenant_id = ?
       AND reserved_credits >= ?`
  ).bind(
    creditsDelta,
    creditsDelta,
    updatedAt,
    tenantId,
    creditsDelta,
  ));

  if ((result.meta?.changes ?? 0) === 0) {
    return null;
  }

  return await ensureTenantBillingAccount(env, tenantId);
}

export async function captureTenantReservedCredits(env: Env, tenantId: string, creditsDelta: number): Promise<BillingAccountRecord | null> {
  const updatedAt = nowIso();
  const result = await execute(env.D1_DB.prepare(
    `UPDATE tenant_billing_accounts
     SET reserved_credits = reserved_credits - ?,
         updated_at = ?
     WHERE tenant_id = ?
       AND reserved_credits >= ?`
  ).bind(
    creditsDelta,
    updatedAt,
    tenantId,
    creditsDelta,
  ));

  if ((result.meta?.changes ?? 0) === 0) {
    return null;
  }

  return await ensureTenantBillingAccount(env, tenantId);
}

export async function decrementTenantAvailableCredits(env: Env, tenantId: string, creditsDelta: number): Promise<BillingAccountRecord | null> {
  const updatedAt = nowIso();
  const result = await execute(env.D1_DB.prepare(
    `UPDATE tenant_billing_accounts
     SET available_credits = available_credits - ?,
         updated_at = ?
     WHERE tenant_id = ?
       AND available_credits >= ?`
  ).bind(
    creditsDelta,
    updatedAt,
    tenantId,
    creditsDelta,
  ));

  if ((result.meta?.changes ?? 0) === 0) {
    return null;
  }

  return await ensureTenantBillingAccount(env, tenantId);
}

export async function appendTenantCreditLedgerEntry<TMetadata extends object | undefined = Record<string, unknown> | undefined>(env: Env, input: {
  tenantId: string;
  entryType: CreditLedgerEntryType;
  creditsDelta: number;
  reason: string;
  paymentReceiptId?: string;
  referenceId?: string;
  metadata?: TMetadata;
}): Promise<CreditLedgerEntryRecord<TMetadata>> {
  const id = createId("led");
  const createdAt = nowIso();
  await execute(env.D1_DB.prepare(
    `INSERT INTO tenant_credit_ledger (
       id, tenant_id, entry_type, credits_delta, reason, payment_receipt_id,
       reference_id, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    input.tenantId,
    input.entryType,
    input.creditsDelta,
    input.reason,
    input.paymentReceiptId ?? null,
    input.referenceId ?? null,
    input.metadata ? JSON.stringify(input.metadata) : null,
    createdAt,
  ));

  const row = await firstRow<CreditLedgerRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, entry_type, credits_delta, reason, payment_receipt_id,
              reference_id, metadata_json, created_at
       FROM tenant_credit_ledger
       WHERE id = ?`
    ).bind(id)
  );

  return mapCreditLedgerRow(requireRow(row, "Failed to load credit ledger entry")) as CreditLedgerEntryRecord<TMetadata>;
}

export async function appendTopupSettlementLedgerEntry(env: Env, input: {
  tenantId: string;
  creditsDelta: number;
  reason: string;
  paymentReceiptId?: string;
  referenceId?: string;
  metadata: TopupSettlementLedgerMetadata;
}): Promise<TypedCreditLedgerEntryRecord> {
  const id = createId("led");
  const createdAt = nowIso();
  await execute(env.D1_DB.prepare(
    `INSERT OR IGNORE INTO tenant_credit_ledger (
       id, tenant_id, entry_type, credits_delta, reason, payment_receipt_id,
       reference_id, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    input.tenantId,
    "topup",
    input.creditsDelta,
    input.reason,
    input.paymentReceiptId ?? null,
    input.referenceId ?? null,
    JSON.stringify(input.metadata),
    createdAt,
  ));
  const entry = input.paymentReceiptId
    ? await getTypedCreditLedgerEntryByPaymentReceiptId(env, input.tenantId, input.paymentReceiptId)
    : await getTypedCreditLedgerEntryByReferenceId(env, input.tenantId, input.referenceId ?? "");
  if (!entry) {
    throw new Error("Failed to append typed topup settlement ledger entry");
  }
  return entry;
}

export async function appendUpgradeCreditGrantLedgerEntry(env: Env, input: {
  tenantId: string;
  creditsDelta: number;
  reason: string;
  paymentReceiptId?: string;
  referenceId?: string;
  metadata: UpgradeCreditGrantLedgerMetadata;
}): Promise<TypedCreditLedgerEntryRecord> {
  const id = createId("led");
  const createdAt = nowIso();
  await execute(env.D1_DB.prepare(
    `INSERT OR IGNORE INTO tenant_credit_ledger (
       id, tenant_id, entry_type, credits_delta, reason, payment_receipt_id,
       reference_id, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    input.tenantId,
    "adjustment",
    input.creditsDelta,
    input.reason,
    input.paymentReceiptId ?? null,
    input.referenceId ?? null,
    JSON.stringify(input.metadata),
    createdAt,
  ));
  const entry = input.paymentReceiptId
    ? await getTypedCreditLedgerEntryByPaymentReceiptId(env, input.tenantId, input.paymentReceiptId)
    : await getTypedCreditLedgerEntryByReferenceId(env, input.tenantId, input.referenceId ?? "");
  if (!entry) {
    throw new Error("Failed to append typed upgrade credit grant ledger entry");
  }
  return entry;
}

export async function appendOutboundUsageLedgerEntry(env: Env, input: {
  tenantId: string;
  entryType: "debit_send" | "debit_reply";
  creditsDelta: number;
  reason: string;
  referenceId: string;
  metadata: OutboundUsageLedgerMetadata;
}): Promise<TypedCreditLedgerEntryRecord> {
  const id = createId("led");
  const createdAt = nowIso();
  await execute(env.D1_DB.prepare(
    `INSERT OR IGNORE INTO tenant_credit_ledger (
       id, tenant_id, entry_type, credits_delta, reason, payment_receipt_id,
       reference_id, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    input.tenantId,
    input.entryType,
    input.creditsDelta,
    input.reason,
    null,
    input.referenceId,
    JSON.stringify(input.metadata),
    createdAt,
  ));
  const entry = await getTypedCreditLedgerEntryByReferenceId(env, input.tenantId, input.referenceId);
  if (!entry) {
    throw new Error("Failed to append typed outbound usage ledger entry");
  }
  return entry;
}
