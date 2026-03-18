CREATE TABLE IF NOT EXISTS token_reissue_requests (
  id TEXT PRIMARY KEY,
  mailbox_address TEXT NOT NULL,
  requester_ip_hash TEXT,
  requested_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_token_reissue_requests_mailbox_requested_at
ON token_reissue_requests(mailbox_address, requested_at);

CREATE INDEX IF NOT EXISTS idx_token_reissue_requests_ip_requested_at
ON token_reissue_requests(requester_ip_hash, requested_at);
