CREATE INDEX IF NOT EXISTS idx_messages_mailbox_internet_message_id
ON messages(mailbox_id, internet_message_id);
