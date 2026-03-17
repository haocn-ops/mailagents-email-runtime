INSERT OR IGNORE INTO mailboxes (
  id,
  tenant_id,
  address,
  status,
  created_at
) VALUES (
  'mbx_demo',
  't_demo',
  'agent@mailagents.net',
  'active',
  '2026-03-16T00:00:00.000Z'
);

INSERT OR IGNORE INTO agents (
  id,
  tenant_id,
  name,
  status,
  mode,
  config_r2_key,
  created_at,
  updated_at
) VALUES (
  'agt_demo',
  't_demo',
  'Demo Agent',
  'active',
  'assistant',
  'agent-config/agt_demo.json',
  '2026-03-16T00:00:00.000Z',
  '2026-03-16T00:00:00.000Z'
);

INSERT OR IGNORE INTO agent_mailboxes (
  id,
  tenant_id,
  agent_id,
  mailbox_id,
  role,
  status,
  created_at
) VALUES (
  'amb_demo',
  't_demo',
  'agt_demo',
  'mbx_demo',
  'primary',
  'active',
  '2026-03-16T00:00:00.000Z'
);

INSERT OR IGNORE INTO agent_policies (
  agent_id,
  auto_reply_enabled,
  human_review_required,
  confidence_threshold,
  max_auto_replies_per_thread,
  allowed_recipient_domains_json,
  blocked_sender_domains_json,
  allowed_tools_json,
  updated_at
) VALUES (
  'agt_demo',
  0,
  1,
  0.85,
  1,
  '[]',
  '[]',
  '["reply_email"]',
  '2026-03-16T00:00:00.000Z'
);

INSERT OR IGNORE INTO threads (
  id,
  tenant_id,
  mailbox_id,
  thread_key,
  subject_norm,
  last_message_at,
  status
) VALUES (
  'thr_demo_inbound',
  't_demo',
  'mbx_demo',
  'demo-inbound-thread',
  'need help with setup',
  '2026-03-16T00:00:00.000Z',
  'open'
);

INSERT OR IGNORE INTO messages (
  id,
  tenant_id,
  mailbox_id,
  thread_id,
  direction,
  provider,
  internet_message_id,
  from_addr,
  to_addr,
  subject,
  snippet,
  status,
  received_at,
  created_at
) VALUES (
  'msg_demo_inbound',
  't_demo',
  'mbx_demo',
  'thr_demo_inbound',
  'inbound',
  'cloudflare',
  '<msg_demo_inbound@mailagents.net>',
  'customer@example.com',
  'agent@mailagents.net',
  'Need help with setup',
  'Can you help me finish setup?',
  'received',
  '2026-03-16T00:00:00.000Z',
  '2026-03-16T00:00:00.000Z'
);
