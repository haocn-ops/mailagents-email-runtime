import { createId } from "../lib/ids";
import { allRows, execute, firstRow, requireRow } from "../lib/db";
import { nowIso } from "../lib/time";
import type { DeliveryEventType, DraftRecord, Env, IdempotencyRecord, MessageContentRecord, MessageRecord, OutboundJobRecord, TaskRecord, ThreadRecord } from "../types";

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
  created_via?: string | null;
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

interface MailboxAddressRow {
  address: string;
  status: string;
}

interface IdempotencyRow {
  operation: string;
  tenant_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  status: "pending" | "completed";
  resource_id: string | null;
  response_json: string | null;
  created_at: string;
  updated_at: string;
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
    createdVia: row.created_via ?? undefined,
    status: row.status,
    draftR2Key: row.draft_r2_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isMissingCreatedViaColumn(error: unknown): boolean {
  return error instanceof Error && /created_via/i.test(error.message);
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

function parseOptionalJson<T>(value: string | null): T | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function mapIdempotencyRow<T>(row: IdempotencyRow): IdempotencyRecord<T> {
  return {
    operation: row.operation,
    tenantId: row.tenant_id,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    resourceId: row.resource_id ?? undefined,
    response: parseOptionalJson<T>(row.response_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeListLimit(limit?: number, fallback = 50, max = 200): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return fallback;
  }

  return Math.max(1, Math.min(Math.trunc(limit), max));
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

export async function listMessages(env: Env, input?: {
  mailboxId?: string;
  limit?: number;
  search?: string;
  direction?: MessageRecord["direction"];
  status?: MessageRecord["status"];
}): Promise<MessageRecord[]> {
  const limit = normalizeListLimit(input?.limit);
  const conditions: string[] = [];
  const values: Array<string | number> = [];

  if (input?.mailboxId) {
    conditions.push("mailbox_id = ?");
    values.push(input.mailboxId);
  }

  if (input?.direction) {
    conditions.push("direction = ?");
    values.push(input.direction);
  }

  if (input?.status) {
    conditions.push("status = ?");
    values.push(input.status);
  }

  if (input?.search) {
    conditions.push("(subject LIKE ? OR snippet LIKE ? OR from_addr LIKE ? OR to_addr LIKE ?)");
    const search = `%${input.search}%`;
    values.push(search, search, search, search);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = env.D1_DB.prepare(
    `SELECT id, tenant_id, mailbox_id, thread_id, direction, provider, internet_message_id,
            provider_message_id, from_addr, to_addr, subject, snippet, status, raw_r2_key,
            normalized_r2_key, received_at, sent_at, created_at
     FROM messages
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT ?`
  ).bind(...values, limit);

  const rows = await allRows<MessageRow>(query);
  return rows.map(mapMessageRow);
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

export async function listOutboundJobs(env: Env, input?: {
  limit?: number;
  status?: OutboundJobRecord["status"];
}): Promise<OutboundJobRecord[]> {
  const limit = normalizeListLimit(input?.limit);
  const query = input?.status
    ? env.D1_DB.prepare(
        `SELECT id, message_id, task_id, status, ses_region, retry_count, next_retry_at,
                last_error, draft_r2_key, created_at, updated_at
         FROM outbound_jobs
         WHERE status = ?
         ORDER BY created_at DESC
         LIMIT ?`
      ).bind(input.status, limit)
    : env.D1_DB.prepare(
        `SELECT id, message_id, task_id, status, ses_region, retry_count, next_retry_at,
                last_error, draft_r2_key, created_at, updated_at
         FROM outbound_jobs
         ORDER BY created_at DESC
         LIMIT ?`
      ).bind(limit);

  const rows = await allRows<OutboundJobRow>(query);
  return rows.map(mapOutboundJobRow);
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
  createdVia?: string;
  payload: Record<string, unknown>;
}): Promise<DraftRecord> {
  const id = createId("drf");
  const timestamp = nowIso();
  const draftR2Key = `drafts/${id}.json`;

  await env.R2_EMAIL.put(draftR2Key, JSON.stringify(input.payload, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });

  try {
    await execute(env.D1_DB.prepare(
      `INSERT INTO drafts (
         id, tenant_id, agent_id, mailbox_id, thread_id, source_message_id, created_via,
         status, draft_r2_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      input.tenantId,
      input.agentId,
      input.mailboxId,
      input.threadId ?? null,
      input.sourceMessageId ?? null,
      input.createdVia ?? null,
      "draft",
      draftR2Key,
      timestamp,
      timestamp
    ));
  } catch (error) {
    if (!isMissingCreatedViaColumn(error)) {
      throw error;
    }

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
  }

  return requireRow(await getDraft(env, id), "Failed to load created draft");
}

export async function getDraft(env: Env, draftId: string): Promise<DraftRecord | null> {
  let row: DraftRow | null = null;
  try {
    row = await firstRow<DraftRow>(
      env.D1_DB.prepare(
        `SELECT id, tenant_id, agent_id, mailbox_id, thread_id, source_message_id, created_via,
                status, draft_r2_key, created_at, updated_at
         FROM drafts
         WHERE id = ?`
      ).bind(draftId)
    );
  } catch (error) {
    if (!isMissingCreatedViaColumn(error)) {
      throw error;
    }

    row = await firstRow<DraftRow>(
      env.D1_DB.prepare(
        `SELECT id, tenant_id, agent_id, mailbox_id, thread_id, source_message_id,
                status, draft_r2_key, created_at, updated_at
         FROM drafts
         WHERE id = ?`
      ).bind(draftId)
    );
  }

  return row ? mapDraftRow(row) : null;
}

export async function listDrafts(env: Env, input?: {
  mailboxId?: string;
  status?: DraftRecord["status"];
  limit?: number;
}): Promise<DraftRecord[]> {
  const limit = normalizeListLimit(input?.limit);
  const conditions: string[] = [];
  const values: Array<string | number> = [];

  if (input?.mailboxId) {
    conditions.push("mailbox_id = ?");
    values.push(input.mailboxId);
  }

  if (input?.status) {
    conditions.push("status = ?");
    values.push(input.status);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  let rows: DraftRow[];
  try {
    rows = await allRows<DraftRow>(
      env.D1_DB.prepare(
        `SELECT id, tenant_id, agent_id, mailbox_id, thread_id, source_message_id, created_via,
                status, draft_r2_key, created_at, updated_at
         FROM drafts
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT ?`
      ).bind(...values, limit)
    );
  } catch (error) {
    if (!isMissingCreatedViaColumn(error)) {
      throw error;
    }

    rows = await allRows<DraftRow>(
      env.D1_DB.prepare(
        `SELECT id, tenant_id, agent_id, mailbox_id, thread_id, source_message_id,
                status, draft_r2_key, created_at, updated_at
         FROM drafts
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT ?`
      ).bind(...values, limit)
    );
  }

  return rows.map(mapDraftRow);
}

export async function getDraftByR2Key(env: Env, draftR2Key: string): Promise<DraftRecord | null> {
  let row: DraftRow | null = null;
  try {
    row = await firstRow<DraftRow>(
      env.D1_DB.prepare(
        `SELECT id, tenant_id, agent_id, mailbox_id, thread_id, source_message_id, created_via,
                status, draft_r2_key, created_at, updated_at
         FROM drafts
         WHERE draft_r2_key = ?`
      ).bind(draftR2Key)
    );
  } catch (error) {
    if (!isMissingCreatedViaColumn(error)) {
      throw error;
    }

    row = await firstRow<DraftRow>(
      env.D1_DB.prepare(
        `SELECT id, tenant_id, agent_id, mailbox_id, thread_id, source_message_id,
                status, draft_r2_key, created_at, updated_at
         FROM drafts
         WHERE draft_r2_key = ?`
      ).bind(draftR2Key)
    );
  }

  return row ? mapDraftRow(row) : null;
}

export async function enqueueDraftSend(env: Env, draftId: string): Promise<{ outboundJobId: string; status: "queued" }> {
  const draft = requireRow(await getDraft(env, draftId), "Draft not found");
  if (draft.status !== "draft" && draft.status !== "approved") {
    throw new Error(`Draft status ${draft.status} cannot be enqueued for send`);
  }
  const priorDraftStatus = draft.status;
  const outboundJobId = createId("obj");
  const timestamp = nowIso();
  const outboundMessageId = createId("msg");
  const draftObject = await env.R2_EMAIL.get(draft.draftR2Key);
  const draftPayload = draftObject ? await draftObject.json<Record<string, unknown>>() : {};
  const mailbox = await firstRow<MailboxAddressRow>(
    env.D1_DB.prepare(
      `SELECT address, status
       FROM mailboxes
       WHERE id = ?`
    ).bind(draft.mailboxId)
  );
  const fromAddress = typeof draftPayload.from === "string" ? draftPayload.from.trim().toLowerCase() : "";
  const mailboxAddress = mailbox?.address.trim().toLowerCase() ?? "";

  if (!mailboxAddress) {
    throw new Error("Mailbox not found");
  }
  if (mailbox?.status !== "active") {
    throw new Error("Mailbox is not active");
  }
  if (!fromAddress) {
    throw new Error("Draft from address is required");
  }
  if (fromAddress !== mailboxAddress) {
    throw new Error("Draft from address must match the mailbox address");
  }

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
    fromAddress,
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

  try {
    await env.OUTBOUND_SEND_QUEUE.send({ outboundJobId });
  } catch (error) {
    await execute(env.D1_DB.prepare(
      `DELETE FROM outbound_jobs WHERE id = ?`
    ).bind(outboundJobId)).catch(() => undefined);
    await execute(env.D1_DB.prepare(
      `DELETE FROM messages WHERE id = ?`
    ).bind(outboundMessageId)).catch(() => undefined);
    await execute(env.D1_DB.prepare(
      `UPDATE drafts SET status = ?, updated_at = ? WHERE id = ?`
    ).bind(priorDraftStatus, nowIso(), draftId)).catch(() => undefined);
    throw error;
  }

  return {
    outboundJobId,
    status: "queued",
  };
}

export async function getIdempotencyRecord<T>(env: Env, operation: string, tenantId: string, idempotencyKey: string): Promise<IdempotencyRecord<T> | null> {
  const row = await firstRow<IdempotencyRow>(
    env.D1_DB.prepare(
      `SELECT operation, tenant_id, idempotency_key, request_fingerprint, status, resource_id,
              response_json, created_at, updated_at
       FROM idempotency_keys
       WHERE operation = ? AND tenant_id = ? AND idempotency_key = ?`
    ).bind(operation, tenantId, idempotencyKey)
  );

  return row ? mapIdempotencyRow<T>(row) : null;
}

export async function reserveIdempotencyKey(env: Env, input: {
  operation: string;
  tenantId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  resourceId?: string;
}): Promise<
  | { status: "reserved" }
  | { status: "completed"; record: IdempotencyRecord }
  | { status: "pending"; record: IdempotencyRecord }
  | { status: "conflict"; record: IdempotencyRecord }
> {
  const existing = await getIdempotencyRecord(env, input.operation, input.tenantId, input.idempotencyKey);
  if (existing) {
    if (existing.requestFingerprint !== input.requestFingerprint) {
      return { status: "conflict", record: existing };
    }
    if (existing.status === "completed") {
      return { status: "completed", record: existing };
    }
    return { status: "pending", record: existing };
  }

  const timestamp = nowIso();
  const result = await env.D1_DB.prepare(
    `INSERT OR IGNORE INTO idempotency_keys (
       operation, tenant_id, idempotency_key, request_fingerprint, status, resource_id, response_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    input.operation,
    input.tenantId,
    input.idempotencyKey,
    input.requestFingerprint,
    "pending",
    input.resourceId ?? null,
    null,
    timestamp,
    timestamp
  ).run();

  if ((result.meta?.changes ?? 0) > 0) {
    return { status: "reserved" };
  }

  const current = requireRow(
    await getIdempotencyRecord(env, input.operation, input.tenantId, input.idempotencyKey),
    "Idempotency reservation lookup failed"
  );

  if (current.requestFingerprint !== input.requestFingerprint) {
    return { status: "conflict", record: current };
  }
  if (current.status === "completed") {
    return { status: "completed", record: current };
  }
  return { status: "pending", record: current };
}

export async function completeIdempotencyKey(env: Env, input: {
  operation: string;
  tenantId: string;
  idempotencyKey: string;
  response: unknown;
  resourceId?: string;
}): Promise<void> {
  await execute(env.D1_DB.prepare(
    `UPDATE idempotency_keys
     SET status = ?, response_json = ?, resource_id = COALESCE(?, resource_id), updated_at = ?
     WHERE operation = ? AND tenant_id = ? AND idempotency_key = ?`
  ).bind(
    "completed",
    JSON.stringify(input.response),
    input.resourceId ?? null,
    nowIso(),
    input.operation,
    input.tenantId,
    input.idempotencyKey
  ));
}

export async function releaseIdempotencyKey(env: Env, operation: string, tenantId: string, idempotencyKey: string): Promise<void> {
  await execute(env.D1_DB.prepare(
    `DELETE FROM idempotency_keys
     WHERE operation = ? AND tenant_id = ? AND idempotency_key = ? AND status = ?`
  ).bind(operation, tenantId, idempotencyKey, "pending"));
}

export async function pruneIdempotencyKeys(env: Env, input: {
  completedBefore: string;
  pendingBefore: string;
}): Promise<{ deleted: number }> {
  const result = await execute(env.D1_DB.prepare(
    `DELETE FROM idempotency_keys
     WHERE (status = ? AND updated_at < ?)
        OR (status = ? AND updated_at < ?)`
  ).bind(
    "completed",
    input.completedBefore,
    "pending",
    input.pendingBefore
  ));

  return {
    deleted: result.meta?.changes ?? 0,
  };
}

export async function listIdempotencyRecords(env: Env, input?: {
  operation?: string;
  status?: "pending" | "completed";
  limit?: number;
}): Promise<IdempotencyRecord[]> {
  const limit = normalizeListLimit(input?.limit);
  const conditions: string[] = [];
  const values: Array<string | number> = [];

  if (input?.operation) {
    conditions.push("operation = ?");
    values.push(input.operation);
  }

  if (input?.status) {
    conditions.push("status = ?");
    values.push(input.status);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await allRows<IdempotencyRow>(
    env.D1_DB.prepare(
      `SELECT operation, tenant_id, idempotency_key, request_fingerprint, status, resource_id,
              response_json, created_at, updated_at
       FROM idempotency_keys
       ${whereClause}
       ORDER BY updated_at DESC
       LIMIT ?`
    ).bind(...values, limit)
  );

  return rows.map((row) => mapIdempotencyRow(row));
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

export async function getOutboundJobByMessageId(env: Env, messageId: string): Promise<OutboundJobRecord | null> {
  const row = await firstRow<OutboundJobRow>(
    env.D1_DB.prepare(
      `SELECT id, message_id, task_id, status, ses_region, retry_count, next_retry_at,
              last_error, draft_r2_key, created_at, updated_at
       FROM outbound_jobs
       WHERE message_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
    ).bind(messageId)
  );

  return row ? mapOutboundJobRow(row) : null;
}

export async function getOutboundJobByDraftR2Key(env: Env, draftR2Key: string): Promise<OutboundJobRecord | null> {
  const row = await firstRow<OutboundJobRow>(
    env.D1_DB.prepare(
      `SELECT id, message_id, task_id, status, ses_region, retry_count, next_retry_at,
              last_error, draft_r2_key, created_at, updated_at
       FROM outbound_jobs
       WHERE draft_r2_key = ?
       ORDER BY created_at DESC
       LIMIT 1`
    ).bind(draftR2Key)
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
  fromAddr?: string;
  status: MessageRecord["status"];
}): Promise<void> {
  await execute(env.D1_DB.prepare(
    `UPDATE messages
     SET thread_id = ?, normalized_r2_key = ?, subject = ?, snippet = ?, internet_message_id = COALESCE(?, internet_message_id),
         from_addr = COALESCE(?, from_addr),
         status = ?
     WHERE id = ?`
  ).bind(
    input.threadId,
    input.normalizedR2Key,
    input.subject ?? null,
    input.snippet ?? null,
    input.internetMessageId ?? null,
    input.fromAddr ?? null,
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
      `INSERT OR IGNORE INTO attachments (id, message_id, filename, content_type, size_bytes, sha256, r2_key, created_at)
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

export async function getTaskBySourceMessageId(env: Env, sourceMessageId: string, taskType: string): Promise<TaskRecord | null> {
  const row = await firstRow<TaskRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, mailbox_id, source_message_id, task_type, priority, status,
              assigned_agent, result_r2_key, created_at, updated_at
       FROM tasks
       WHERE source_message_id = ? AND task_type = ?
       ORDER BY created_at DESC
       LIMIT 1`
    ).bind(sourceMessageId, taskType)
  );

  return row ? mapTaskRow(row) : null;
}

export async function deleteTask(env: Env, taskId: string): Promise<void> {
  await execute(env.D1_DB.prepare(
    `DELETE FROM tasks WHERE id = ?`
  ).bind(taskId));
}

export async function updateTaskStatus(env: Env, input: {
  taskId: string;
  status: TaskRecord["status"];
  resultR2Key?: string | null;
}): Promise<void> {
  await execute(env.D1_DB.prepare(
    `UPDATE tasks
     SET status = ?, result_r2_key = COALESCE(?, result_r2_key), updated_at = ?
     WHERE id = ?`
  ).bind(
    input.status,
    input.resultR2Key ?? null,
    nowIso(),
    input.taskId
  ));
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
  const normalizedEmail = email.trim().toLowerCase();
  const row = await firstRow<SuppressionRow>(
    env.D1_DB.prepare(
      `SELECT email, reason, source, created_at
       FROM suppressions
       WHERE lower(email) = ?`
    ).bind(normalizedEmail)
  );

  return row ? mapSuppressionRow(row) : null;
}

export async function updateMessageStatusByProviderMessageId(env: Env, providerMessageId: string, status: MessageRecord["status"]): Promise<void> {
  await execute(env.D1_DB.prepare(
    `UPDATE messages SET status = ? WHERE provider_message_id = ?`
  ).bind(status, providerMessageId));
}

export async function updateMessageStatus(env: Env, messageId: string, status: MessageRecord["status"]): Promise<void> {
  await execute(env.D1_DB.prepare(
    `UPDATE messages SET status = ? WHERE id = ?`
  ).bind(status, messageId));
}

export async function addSuppression(env: Env, email: string, reason: string, source = "ses"): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();
  const timestamp = nowIso();
  const existing = await firstRow<{ email: string }>(
    env.D1_DB.prepare(
      `SELECT email
       FROM suppressions
       WHERE lower(email) = ?
       LIMIT 1`
    ).bind(normalizedEmail)
  );

  if (existing) {
    await execute(env.D1_DB.prepare(
      `UPDATE suppressions
       SET reason = ?, source = ?, created_at = ?
       WHERE email = ?`
    ).bind(reason, source, timestamp, existing.email));
    return;
  }

  await execute(env.D1_DB.prepare(
    `INSERT INTO suppressions (email, reason, source, created_at)
     VALUES (?, ?, ?, ?)`
  ).bind(normalizedEmail, reason, source, timestamp));
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
