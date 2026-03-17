CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  mode TEXT NOT NULL DEFAULT 'assistant',
  config_r2_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_agents_tenant_status ON agents(tenant_id, status);

CREATE TABLE mailboxes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE agent_mailboxes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'primary',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  UNIQUE(agent_id, mailbox_id)
);

CREATE INDEX idx_agent_mailboxes_agent_id ON agent_mailboxes(agent_id);
CREATE INDEX idx_agent_mailboxes_mailbox_id ON agent_mailboxes(mailbox_id);

CREATE TABLE agent_policies (
  agent_id TEXT PRIMARY KEY,
  auto_reply_enabled INTEGER NOT NULL DEFAULT 0,
  human_review_required INTEGER NOT NULL DEFAULT 1,
  confidence_threshold REAL NOT NULL DEFAULT 0.85,
  max_auto_replies_per_thread INTEGER NOT NULL DEFAULT 1,
  allowed_recipient_domains_json TEXT,
  blocked_sender_domains_json TEXT,
  allowed_tools_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  subject_norm TEXT,
  last_message_at TEXT,
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE UNIQUE INDEX idx_threads_mailbox_thread_key
ON threads(mailbox_id, thread_key);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  thread_id TEXT,
  direction TEXT NOT NULL,
  provider TEXT NOT NULL,
  internet_message_id TEXT,
  provider_message_id TEXT,
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT,
  snippet TEXT,
  status TEXT NOT NULL,
  raw_r2_key TEXT,
  normalized_r2_key TEXT,
  received_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_messages_thread_id ON messages(thread_id);
CREATE INDEX idx_messages_mailbox_created_at ON messages(mailbox_id, created_at);
CREATE INDEX idx_messages_provider_message_id ON messages(provider_message_id);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  filename TEXT,
  content_type TEXT,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_attachments_message_id ON attachments(message_id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL,
  assigned_agent TEXT,
  result_r2_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_tasks_status_priority ON tasks(status, priority);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL,
  prompt_r2_key TEXT,
  trace_r2_key TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_agent_runs_task_id ON agent_runs(task_id);

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  thread_id TEXT,
  source_message_id TEXT,
  status TEXT NOT NULL,
  draft_r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_drafts_agent_status ON drafts(agent_id, status);

CREATE TABLE outbound_jobs (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  task_id TEXT,
  status TEXT NOT NULL,
  ses_region TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error TEXT,
  draft_r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_outbound_jobs_status_next_retry_at
ON outbound_jobs(status, next_retry_at);

CREATE TABLE delivery_events (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  event_type TEXT NOT NULL,
  payload_r2_key TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_delivery_events_provider_message_id
ON delivery_events(provider_message_id);

CREATE TABLE suppressions (
  email TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE idempotency_keys (
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

CREATE INDEX idx_idempotency_keys_status_updated_at
ON idempotency_keys(status, updated_at);
