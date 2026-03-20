CREATE TABLE IF NOT EXISTS tenant_billing_accounts (
  tenant_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'trial',
  pricing_tier TEXT NOT NULL DEFAULT 'free',
  default_network TEXT,
  default_asset TEXT,
  available_credits INTEGER NOT NULL DEFAULT 0,
  reserved_credits INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_credit_ledger (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  credits_delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  payment_receipt_id TEXT,
  reference_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenant_credit_ledger_tenant_created_at
ON tenant_credit_ledger(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tenant_credit_ledger_payment_receipt
ON tenant_credit_ledger(payment_receipt_id);

CREATE TABLE IF NOT EXISTS tenant_payment_receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  receipt_type TEXT NOT NULL,
  payment_scheme TEXT NOT NULL,
  network TEXT,
  asset TEXT,
  amount_atomic TEXT NOT NULL,
  amount_display TEXT,
  payment_reference TEXT,
  settlement_reference TEXT,
  status TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenant_payment_receipts_tenant_created_at
ON tenant_payment_receipts(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tenant_payment_receipts_status
ON tenant_payment_receipts(status, updated_at DESC);
