CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_credit_ledger_payment_receipt_unique
ON tenant_credit_ledger(payment_receipt_id)
WHERE payment_receipt_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_credit_ledger_reference_unique
ON tenant_credit_ledger(reference_id)
WHERE reference_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_payment_receipts_payment_reference_unique
ON tenant_payment_receipts(payment_reference)
WHERE payment_reference IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_payment_receipts_settlement_reference_unique
ON tenant_payment_receipts(settlement_reference)
WHERE settlement_reference IS NOT NULL;
