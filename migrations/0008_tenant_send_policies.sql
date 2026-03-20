CREATE TABLE IF NOT EXISTS tenant_send_policies (
  tenant_id TEXT PRIMARY KEY,
  pricing_tier TEXT NOT NULL DEFAULT 'free',
  outbound_status TEXT NOT NULL DEFAULT 'internal_only',
  internal_domain_allowlist_json TEXT NOT NULL,
  external_send_enabled INTEGER NOT NULL DEFAULT 0,
  review_required INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenant_send_policies_status
ON tenant_send_policies(outbound_status, updated_at DESC);
