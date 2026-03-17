CREATE TABLE IF NOT EXISTS idempotency_keys (
  operation TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  resource_id TEXT,
  response_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (operation, tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_status_updated_at
ON idempotency_keys(status, updated_at);
