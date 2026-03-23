CREATE TABLE IF NOT EXISTS tenant_did_bindings (
  tenant_id TEXT PRIMARY KEY,
  did TEXT NOT NULL UNIQUE,
  method TEXT NOT NULL,
  document_url TEXT,
  status TEXT NOT NULL,
  verification_method_id TEXT,
  service_json TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenant_did_bindings_status
ON tenant_did_bindings(status, updated_at DESC);
