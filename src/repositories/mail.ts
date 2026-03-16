import { createId } from "../lib/ids";
import { allRows, execute, firstRow, requireRow } from "../lib/db";
import { nowIso } from "../lib/time";
import type { DeliveryEventType, DraftRecord, Env, MessageContentRecord, MessageRecord, OutboundJobRecord, TaskRecord, ThreadRecord } from "../types";

interface TaskRow {
  id: string;
  tenant_id: string;
  mailbox_id: string;
  source_message_id: string;
  task_type: string;
  priority: number;
  status: TaskRecord["status"];
  assigned_agent: string | null;
  result_r2_key: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  tenant_id: string;
  mailbox_id: string;
  thread_id: string | null;
  direction: MessageRecord["direction"];
  provider: MessageRecord["provider"];
  internet_message_id: string | null;
  provider_message_id: string | null;
  from_addr: string;
  to_addr: string;
  subject: string | null;
  snippet: string | null;
  status: MessageRecord["status"];
  raw_r2_key: string | null;
  normalized_r2_key: string | null;
  received_at: string | null;
  sent_at: string | null;
  created_at: string;
}

interface ThreadRow {
  id: string;
  tenant_id: string | null;
  mailbox_id: string;
  thread_key: string | null;
  subject_norm: string | null;
  status: string | null;
}

interface DraftRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  mailbox_id: string;
  thread_id: string | null;
  source_message_id: string | null;
  status: DraftRecord["status"];
  draft_r2_key: string;
  created_at: string;
  updated_at: string;
}

interface AttachmentRow {
  id: string;
  filename: string | null;
  content_type: string | null;
  size_bytes: number;
  r2_key: string;
}

interface OutboundJobRow {
  id: string;
  message_id: string;
  task_id: string | null;
  status: OutboundJobRecord["status"];
  ses_region: string;
  retry_count: number;
  next_retry_at: string | null;
  last_error: string | null;
  draft_r2_key: string;
  created_at: string;
  updated_at: string;
}

interface DeliveryEventRow {
  id: string;
  message_id: string | null;
  provider: string;
  provider_message_id: string | null;
  event_type: DeliveryEventType;
  payload_r2_key: string;
  created_at: string;
}

interface SuppressionRow {
  email: string;
  reason: string;
  source: string;
  created_at: string;
}

function mapTaskRow(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    mailboxId: row.mailbox_id,
    sourceMessageId: row.source_message_id,
    taskType: row.task_type,
    priority: row.priority,
    status: row.status,
    assignedAgent: row.assigned_agent ?? undefined,
    resultR2Key: row.result_r2_key ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessageRow(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    mailboxId: row.mailbox_id,
    threadId: row.thread_id ?? undefined,
    direction: row.direction,
    provider: row.provider,
    internetMessageId: row.internet_message_id ?? undefined,
    providerMessageId: row.provider_message_id ?? undefined,
    fromAddr: row.from_addr,
    toAddr: row.to_addr,
    subject: row.subject ?? undefined,
    snippet: row.snippet ?? undefined,
    status: row.status,
    rawR2Key: row.raw_r2_key ?? undefined,
    normalizedR2Key: row.normalized_r2_key ?? undefined,
    receivedAt: row.received_at ?? undefined,
    sentAt: row.sent_at ?? undefined,
    createdAt: row.created_at,
  };
}

function mapDraftRow(row: DraftRow): DraftRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    mailboxId: row.mailbox_id,
    threadId: row.thread_id ?? undefined,
    sourceMessageId: row.source_message_id ?? undefined,
    status: row.status,
    draftR2Key: row.draft_r2_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOutboundJobRow(row: OutboundJobRow): OutboundJobRecord {
  return {
    id: row.id,
    messageId: row.message_id,
    taskId: row.task_id ?? undefined,
    status: row.status,
    sesRegion: row.ses_region,
    retryCount: row.retry_count,
    nextRetryAt: row.next_retry_at ?? undefined,
    lastError: row.last_error ?? undefined,
    draftR2Key: row.draft_r2_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDeliveryEventRow(row: DeliveryEventRow) {
  return {
    id: row.id,
    messageId: row.message_id ?? undefined,
    provider: row.provider,
    providerMessageId: row.provider_message_id ?? undefined,
    eventType: row.event_type,
    payloadR2Key: row.payload_r2_key,
    createdAt: row.created_at,
  };
}

function mapSuppressionRow(row: SuppressionRow) {
  return {
    email: row.email,
    reason: row.reason,
    source: row.source,
    createdAt: row.created_at,
  };
}

export async function listTasks(env: Env, agentId: string, status?: TaskRecord["status"]): Promise<TaskRecord[]> {
  const query = status
    ? env.D1_DB.prepare(
        `SELECT id, tenant_id, mailbox_id, source_message_id, task_type, priority, status,
                assigned_agent, result_r2_key, created_at, updated_at
         FROM tasks
         WHERE assigned_agent = ? AND status = ?
         ORDER BY priority DESC, created_at DESC`
      ).bind(agentId, status)
    : env.D1_DB.prepare(
        `SELECT id, tenant_id, mailbox_id, source_message_id, task_type, priority, status,
                assigned_agent, result_r2_key, created_at, updated_at
         FROM tasks
         WHERE assigned_agent = ?
         ORDER BY priority DESC, created_at DESC`
      ).bind(agentId);

  const rows = await allRows<TaskRow>(query);
  return rows.map(mapTaskRow);
}

export async function getMessage(env: Env, messageId: string): Promise<MessageRecord | null> {
  const row = await firstRow<MessageRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, mailbox_id, thread_id, direction, provider, internet_message_id,
              provider_message_id, from_addr, to_addr, subject, snippet, status, raw_r2_key,
              normalized_r2_key, received_at, sent_at, created_at
       FROM messages
       WHERE id = ?`
    ).bind(messageId)
  );

  return row ? mapMessageRow(row) : null;
}

export async function getMessageContent(env: Env, messageId: string): Promise<MessageContentRecord> {
  const message = requireRow(await getMessage(env, messageId), "Message not found");
  const normalizedObject = message.normalizedR2Key ? await env.R2_EMAIL.get(message.normalizedR2Key) : null;
  const normalized = normalizedObject ? await normalizedObject.json<Record<string, unknown>>() : {};

  const rows = await allRows<AttachmentRow>(
    env.D1_DB.prepare(
      `SELECT id, filename, content_type, size_bytes, r2_key
       FROM attachments
       WHERE message_id = ?
       ORDER BY created_at ASC`
    ).bind(messageId)
  );

  return {
    text: typeof normalized.text === "string" ? normalized.text : undefined,
    html: typeof normalized.html === "string" ? normalized.html : undefined,
    attachments: rows.map((row) => ({
      id: row.id,
      filename: row.filename ?? undefined,
      contentType: row.content_type ?? undefined,
      sizeBytes: row.size_bytes,
      downloadUrl: row.r2_key,
    })),
  };
}

export async function getThread(env: Env, threadId: string): Promise<ThreadRecord | null> {
  const thread = await firstRow<ThreadRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, mailbox_id, thread_key, subject_norm, status
       FROM threads
       WHERE id = ?`
    ).bind(threadId)
  );

  if (!thread) {
    return null;
  }

  const messageRows = await allRows<MessageRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, mailbox_id, thread_id, direction, provider, internet_message_id,
              provider_message_id, from_addr, to_addr, subject, snippet, status, raw_r2_key,
              normalized_r2_key, received_at, sent_at, created_at
       FROM messages
       WHERE thread_id = ?
       ORDER BY created_at ASC`
    ).bind(threadId)
  );

  return {
    id: thread.id,
    mailboxId: thread.mailbox_id,
    subjectNorm: thread.subject_norm ?? undefined,
    status: thread.status ?? undefined,
    messages: messageRows.map(mapMessageRow),
  };
}

export async function getOrCreateThread(env: Env, input: {
  tenantId: string;
  mailboxId: string;
  threadKey: string;
  subjectNorm?: string;
}): Promise<ThreadRecord> {
  const existing = await firstRow<ThreadRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, mailbox_id, thread_key, subject_norm, status
       FROM threads
       WHERE mailbox_id = ? AND thread_key = ?`
    ).bind(input.mailboxId, input.threadKey)
  );

  if (existing) {
    return {
      id: existing.id,
      mailboxId: existing.mailbox_id,
      subjectNorm: existing.subject_norm ?? undefined,
      status: existing.status ?? undefined,
      messages: [],
    };
  }

  const id = createId("thr");
  await execute(env.D1_DB.prepare(
    `INSERT INTO threads (id, tenant_id, mailbox_id, thread_key, subject_norm, last_message_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    input.tenantId,
    input.mailboxId,
    input.threadKey,
    input.subjectNorm ?? null,
    nowIso(),
    "open"
  ));

  return {
    id,
    mailboxId: input.mailboxId,
    subjectNorm: input.subjectNorm,
    status: "open",
    messages: [],
  };
}

export async function createDraft(env: Env, input: {
  tenantId: string;
  agentId: string;
  mailboxId: string;
  threadId?: string;
  sourceMessageId?: string;
  payload: Record<string, unknown>;
}): Promise<DraftRecord> {
  const id = createId("drf");
  const timestamp = nowIso();
  const draftR2Key = `drafts/${id}.json`;

  await env.R2_EMAIL.put(draftR2Key, JSON.stringify(input.payload, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });

  await execute(env.D1_DB.prepare(
    `INSERT INTO drafts (
       id, tenant_id, agent_id, mailbox_id, thread_id, source_message_id,
       status, draft_r2_key, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    input.tenantId,
    input.agentId,
    input.mailboxId,
    input.threadId ?? null,
    input.sourceMessageId ?? null,
    "draft",
    draftR2Key,
    timestamp,
    timestamp
  ));

  return requireRow(await getDraft(env, id), "Failed to load created draft");
}

export async function getDraft(env: Env, draftId: string): Promise<DraftRecord | null> {
  const row = await firstRow<DraftRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, agent_id, mailbox_id, thread_id, source_message_id,
              status, draft_r2_key, created_at, updated_at
       FROM drafts
       WHERE id = ?`
    ).bind(draftId)
  );

  return row ? mapDraftRow(row) : null;
}

export async function getDraftByR2Key(env: Env, draftR2Key: string): Promise<DraftRecord | null> {
  const row = await firstRow<DraftRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, agent_id, mailbox_id, thread_id, source_message_id,
              status, draft_r2_key, created_at, updated_at
       FROM drafts
       WHERE draft_r2_key = ?`
    ).bind(draftR2Key)
  );

  return row ? mapDraftRow(row) : null;
}

export async function enqueueDraftSend(env: Env, draftId: string): Promise<{ outboundJobId: string; status: "queued" }> {
  const draft = requireRow(await getDraft(env, draftId), "Draft not found");
  const outboundJobId = createId("obj");
  const timestamp = nowIso();
  const outboundMessageId = createId("msg");
  const draftObject = await env.R2_EMAIL.get(draft.draftR2Key);
  const draftPayload = draftObject ? await draftObject.json<Record<string, unknown>>() : {};

  await execute(env.D1_DB.prepare(
    `INSERT INTO messages (
       id, tenant_id, mailbox_id, thread_id, direction, provider, from_addr, to_addr,
       subject, status, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    outboundMessageId,
    draft.tenantId,
    draft.mailboxId,
    draft.threadId ?? null,
    "outbound",
    "ses",
    typeof draftPayload.from === "string" ? draftPayload.from : "",
    Array.isArray(draftPayload.to) ? draftPayload.to.join(",") : "",
    typeof draftPayload.subject === "string" ? draftPayload.subject : "",
    "tasked",
    timestamp
  ));

  await execute(env.D1_DB.prepare(
    `INSERT INTO outbound_jobs (
       id, message_id, task_id, status, ses_region, retry_count, next_retry_at,
       last_error, draft_r2_key, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    outboundJobId,
    outboundMessageId,
    null,
    "queued",
    env.SES_REGION,
    0,
    null,
    null,
    draft.draftR2Key,
    timestamp,
    timestamp
  ));

  await execute(env.D1_DB.prepare(
    `UPDATE drafts SET status = ?, updated_at = ? WHERE id = ?`
  ).bind("queued", timestamp, draftId));

  await env.OUTBOUND_SEND_QUEUE.send({ outboundJobId });

  return {
    outboundJobId,
    status: "queued",
  };
}

export async function getOutboundJob(env: Env, outboundJobId: string): Promise<OutboundJobRecord | null> {
  const row = await firstRow<OutboundJobRow>(
    env.D1_DB.prepare(
      `SELECT id, message_id, task_id, status, ses_region, retry_count, next_retry_at,
              last_error, draft_r2_key, created_at, updated_at
       FROM outbound_jobs
       WHERE id = ?`
    ).bind(outboundJobId)
  );

  return row ? mapOutboundJobRow(row) : null;
}

export async function updateInboundMessageNormalized(env: Env, input: {
  messageId: string;
  threadId: string;
  normalizedR2Key: string;
  subject?: string;
  snippet?: string;
  internetMessageId?: string;
  status: MessageRecord["status"];
}): Promise<void> {
  await execute(env.D1_DB.prepare(
    `UPDATE messages
     SET thread_id = ?, normalized_r2_key = ?, subject = ?, snippet = ?, internet_message_id = COALESCE(?, internet_message_id),
         status = ?
     WHERE id = ?`
  ).bind(
    input.threadId,
    input.normalizedR2Key,
    input.subject ?? null,
    input.snippet ?? null,
    input.internetMessageId ?? null,
    input.status,
    input.messageId
  ));
}

export async function updateThreadTimestamp(env: Env, threadId: string): Promise<void> {
  await execute(env.D1_DB.prepare(
    `UPDATE threads SET last_message_at = ? WHERE id = ?`
  ).bind(nowIso(), threadId));
}

export async function insertAttachments(env: Env, input: {
  messageId: string;
  attachments: Array<{
    id: string;
    filename?: string;
    contentType?: string;
    sizeBytes: number;
    r2Key: string;
    sha256?: string;
  }>;
}): Promise<void> {
  for (const attachment of input.attachments) {
    await execute(env.D1_DB.prepare(
      `INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, sha256, r2_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      attachment.id,
      input.messageId,
      attachment.filename ?? null,
      attachment.contentType ?? null,
      attachment.sizeBytes,
      attachment.sha256 ?? null,
      attachment.r2Key,
      nowIso()
    ));
  }
}

export async function resolveAssignedAgent(env: Env, mailboxId: string): Promise<string | null> {
  const row = await firstRow<{ agent_id: string }>(
    env.D1_DB.prepare(
      `SELECT agent_id
       FROM agent_mailboxes
       WHERE mailbox_id = ? AND status = 'active'
       ORDER BY created_at ASC
       LIMIT 1`
    ).bind(mailboxId)
  );

  return row?.agent_id ?? null;
}

export async function createTask(env: Env, input: {
  tenantId: string;
  mailboxId: string;
  sourceMessageId: string;
  taskType: string;
  priority: number;
  status: TaskRecord["status"];
  assignedAgent?: string | null;
}): Promise<TaskRecord> {
  const id = createId("tsk");
  const timestamp = nowIso();
  await execute(env.D1_DB.prepare(
    `INSERT INTO tasks (
       id, tenant_id, mailbox_id, source_message_id, task_type, priority, status, assigned_agent, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    input.tenantId,
    input.mailboxId,
    input.sourceMessageId,
    input.taskType,
    input.priority,
    input.status,
    input.assignedAgent ?? null,
    timestamp,
    timestamp
  ));

  return {
    id,
    tenantId: input.tenantId,
    mailboxId: input.mailboxId,
    sourceMessageId: input.sourceMessageId,
    taskType: input.taskType,
    priority: input.priority,
    status: input.status,
    assignedAgent: input.assignedAgent ?? undefined,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function insertDeliveryEvent(env: Env, input: {
  messageId?: string;
  providerMessageId?: string;
  eventType: DeliveryEventType;
  payloadR2Key: string;
}): Promise<void> {
  await execute(env.D1_DB.prepare(
    `INSERT INTO delivery_events (id, message_id, provider, provider_message_id, event_type, payload_r2_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    createId("evt"),
    input.messageId ?? null,
    "ses",
    input.providerMessageId ?? null,
    input.eventType,
    input.payloadR2Key,
    nowIso()
  ));
}

export async function getMessageByProviderMessageId(env: Env, providerMessageId: string): Promise<MessageRecord | null> {
  const row = await firstRow<MessageRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, mailbox_id, thread_id, direction, provider, internet_message_id,
              provider_message_id, from_addr, to_addr, subject, snippet, status, raw_r2_key,
              normalized_r2_key, received_at, sent_at, created_at
       FROM messages
       WHERE provider_message_id = ?`
    ).bind(providerMessageId)
  );

  return row ? mapMessageRow(row) : null;
}

export async function listDeliveryEventsByMessageId(env: Env, messageId: string) {
  const rows = await allRows<DeliveryEventRow>(
    env.D1_DB.prepare(
      `SELECT id, message_id, provider, provider_message_id, event_type, payload_r2_key, created_at
       FROM delivery_events
       WHERE message_id = ?
       ORDER BY created_at DESC`
    ).bind(messageId)
  );

  return rows.map(mapDeliveryEventRow);
}

export async function getSuppression(env: Env, email: string) {
  const row = await firstRow<SuppressionRow>(
    env.D1_DB.prepare(
      `SELECT email, reason, source, created_at
       FROM suppressions
       WHERE email = ?`
    ).bind(email)
  );

  return row ? mapSuppressionRow(row) : null;
}

export async function updateMessageStatusByProviderMessageId(env: Env, providerMessageId: string, status: MessageRecord["status"]): Promise<void> {
  await execute(env.D1_DB.prepare(
    `UPDATE messages SET status = ? WHERE provider_message_id = ?`
  ).bind(status, providerMessageId));
}

export async function addSuppression(env: Env, email: string, reason: string, source = "ses"): Promise<void> {
  await execute(env.D1_DB.prepare(
    `INSERT INTO suppressions (email, reason, source, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET reason = excluded.reason, source = excluded.source, created_at = excluded.created_at`
  ).bind(email, reason, source, nowIso()));
}

export async function updateOutboundJobStatus(env: Env, input: {
  outboundJobId: string;
  status: OutboundJobRecord["status"];
  retryCount?: number;
  nextRetryAt?: string | null;
  lastError?: string | null;
}): Promise<void> {
  await execute(env.D1_DB.prepare(
    `UPDATE outbound_jobs
     SET status = ?, retry_count = COALESCE(?, retry_count), next_retry_at = ?, last_error = ?, updated_at = ?
     WHERE id = ?`
  ).bind(
    input.status,
    input.retryCount ?? null,
    input.nextRetryAt ?? null,
    input.lastError ?? null,
    nowIso(),
    input.outboundJobId
  ));
}

export async function markDraftStatus(env: Env, draftId: string, status: DraftRecord["status"]): Promise<void> {
  await execute(env.D1_DB.prepare(
    `UPDATE drafts SET status = ?, updated_at = ? WHERE id = ?`
  ).bind(status, nowIso(), draftId));
}

export async function markMessageSent(env: Env, input: {
  messageId: string;
  providerMessageId: string;
  status: MessageRecord["status"];
}): Promise<void> {
  const timestamp = nowIso();
  await execute(env.D1_DB.prepare(
    `UPDATE messages
     SET provider_message_id = ?, status = ?, sent_at = ?, created_at = created_at
     WHERE id = ?`
  ).bind(
    input.providerMessageId,
    input.status,
    timestamp,
    input.messageId
  ));
}
