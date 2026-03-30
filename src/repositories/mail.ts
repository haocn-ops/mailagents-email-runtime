import { createId } from "../lib/ids";
import { allRows, execute, firstRow, requireRow } from "../lib/db";
import { normalizeSubject } from "../lib/email-parser";
import { getOutboundCreditRequirement } from "../lib/outbound-credits";
import { getOutboundProvider } from "../lib/outbound-provider";
import { releaseTenantReservedCredits, reserveTenantAvailableCredits } from "./billing";
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

interface ReplyFallbackCandidateRow {
  message_id: string;
  tenant_id: string | null;
  mailbox_id: string;
  thread_id: string | null;
  internet_message_id: string | null;
  provider_message_id: string | null;
  to_addr: string;
  draft_r2_key: string | null;
  subject: string | null;
  created_at: string;
  thread_row_id: string | null;
  thread_key: string | null;
  subject_norm: string | null;
  thread_status: string | null;
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

interface CleanupDraftRow {
  id: string;
  draft_r2_key: string;
  status: DraftRecord["status"];
}

interface AttachmentRow {
  id: string;
  filename: string | null;
  content_type: string | null;
  size_bytes: number;
  r2_key: string;
}

interface PersistedAttachmentRow extends AttachmentRow {
  message_id: string;
  sha256: string | null;
  created_at: string;
}

interface AttachmentOwnerRow {
  message_id: string;
  tenant_id: string;
  mailbox_id: string;
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

interface TenantOutboundUsageCountsRow {
  sent_last_hour: number | null;
  sent_last_day: number | null;
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

export function normalizeInternetMessageId(value?: string | null): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
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

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique constraint/i.test(error.message);
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

export async function listTasks(env: Env, agentId: string, status?: TaskRecord["status"], mailboxIds?: string[]): Promise<TaskRecord[]> {
  const query = status
    ? env.D1_DB.prepare(
        `SELECT id, tenant_id, mailbox_id, source_message_id, task_type, priority, status,
                assigned_agent, result_r2_key, created_at, updated_at
         FROM tasks
         WHERE assigned_agent = ? AND status = ?
           AND EXISTS (
             SELECT 1
             FROM mailboxes
             WHERE mailboxes.id = tasks.mailbox_id
               AND mailboxes.tenant_id = tasks.tenant_id
           )
           AND EXISTS (
             SELECT 1
             FROM messages
             WHERE messages.id = tasks.source_message_id
               AND messages.tenant_id = tasks.tenant_id
               AND messages.mailbox_id = tasks.mailbox_id
           )
           AND (
             tasks.assigned_agent IS NULL
             OR EXISTS (
               SELECT 1
               FROM agents
               WHERE agents.id = tasks.assigned_agent
                 AND agents.tenant_id = tasks.tenant_id
             )
           )
         ORDER BY priority DESC, created_at DESC`
      ).bind(agentId, status)
    : env.D1_DB.prepare(
        `SELECT id, tenant_id, mailbox_id, source_message_id, task_type, priority, status,
                assigned_agent, result_r2_key, created_at, updated_at
         FROM tasks
         WHERE assigned_agent = ?
           AND EXISTS (
             SELECT 1
             FROM mailboxes
             WHERE mailboxes.id = tasks.mailbox_id
               AND mailboxes.tenant_id = tasks.tenant_id
           )
           AND EXISTS (
             SELECT 1
             FROM messages
             WHERE messages.id = tasks.source_message_id
               AND messages.tenant_id = tasks.tenant_id
               AND messages.mailbox_id = tasks.mailbox_id
           )
           AND (
             tasks.assigned_agent IS NULL
             OR EXISTS (
               SELECT 1
               FROM agents
               WHERE agents.id = tasks.assigned_agent
                 AND agents.tenant_id = tasks.tenant_id
             )
           )
         ORDER BY priority DESC, created_at DESC`
      ).bind(agentId);

  const rows = await allRows<TaskRow>(query);
  const mailboxFilter = mailboxIds?.length ? new Set(mailboxIds) : null;
  return rows
    .map(mapTaskRow)
    .filter((row) => !mailboxFilter || mailboxFilter.has(row.mailboxId));
}

export async function getMessage(env: Env, messageId: string): Promise<MessageRecord | null> {
  const row = await firstRow<MessageRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, mailbox_id, thread_id, direction, provider, internet_message_id,
              provider_message_id, from_addr, to_addr, subject, snippet, status, raw_r2_key,
              normalized_r2_key, received_at, sent_at, created_at
       FROM messages
       WHERE id = ?
         AND EXISTS (
           SELECT 1
           FROM mailboxes
           WHERE mailboxes.id = messages.mailbox_id
             AND mailboxes.tenant_id = messages.tenant_id
         )`
    ).bind(messageId)
  );

  return row ? mapMessageRow(row) : null;
}

async function listVisibleMessagesByProviderMessageId(
  env: Env,
  providerMessageId: string,
  limit = 2,
): Promise<MessageRow[]> {
  return await allRows<MessageRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, mailbox_id, thread_id, direction, provider, internet_message_id,
              provider_message_id, from_addr, to_addr, subject, snippet, status, raw_r2_key,
              normalized_r2_key, received_at, sent_at, created_at
       FROM messages
       WHERE provider_message_id = ?
         AND EXISTS (
           SELECT 1
           FROM mailboxes
           WHERE mailboxes.id = messages.mailbox_id
             AND mailboxes.tenant_id = messages.tenant_id
         )
       ORDER BY created_at DESC
       LIMIT ?`
    ).bind(providerMessageId, limit)
  );
}

async function getVisibleProviderMessageIdConflict(
  env: Env,
  providerMessageId: string,
  messageId: string,
): Promise<{ id: string } | null> {
  return await firstRow<{ id: string }>(
    env.D1_DB.prepare(
      `SELECT id
       FROM messages
       WHERE provider_message_id = ?
         AND id <> ?
         AND EXISTS (
           SELECT 1
           FROM mailboxes
           WHERE mailboxes.id = messages.mailbox_id
             AND mailboxes.tenant_id = messages.tenant_id
         )
       LIMIT 1`
    ).bind(providerMessageId, messageId)
  );
}

export async function getInboundMessageByInternetMessageId(env: Env, mailboxId: string, internetMessageId: string): Promise<MessageRecord | null> {
  const normalizedMessageId = normalizeInternetMessageId(internetMessageId);
  if (!normalizedMessageId) {
    return null;
  }

  const rows = await allRows<MessageRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, mailbox_id, thread_id, direction, provider, internet_message_id,
              provider_message_id, from_addr, to_addr, subject, snippet, status, raw_r2_key,
              normalized_r2_key, received_at, sent_at, created_at
       FROM messages
       WHERE mailbox_id = ?
         AND direction = 'inbound'
         AND internet_message_id = ?
         AND EXISTS (
           SELECT 1
           FROM mailboxes
           WHERE mailboxes.id = messages.mailbox_id
             AND mailboxes.tenant_id = messages.tenant_id
         )
       ORDER BY created_at ASC
       LIMIT 2`
    ).bind(mailboxId, normalizedMessageId)
  );

  if (rows.length !== 1) {
    return null;
  }

  return mapMessageRow(rows[0]);
}

async function deleteInvalidInboundMessageDuplicates(env: Env, input: {
  tenantId: string;
  mailboxId: string;
  internetMessageId: string;
}): Promise<number> {
  const rows = await allRows<{ id: string }>(
    env.D1_DB.prepare(
      `SELECT id
       FROM messages
       WHERE mailbox_id = ?
         AND direction = 'inbound'
         AND internet_message_id = ?
         AND NOT (
           tenant_id = ?
           AND EXISTS (
             SELECT 1
             FROM mailboxes
             WHERE mailboxes.id = messages.mailbox_id
               AND mailboxes.tenant_id = messages.tenant_id
           )
         )`
    ).bind(input.mailboxId, input.internetMessageId, input.tenantId)
  );

  for (const row of rows) {
    await execute(env.D1_DB.prepare(
      `DELETE FROM messages WHERE id = ?`
    ).bind(row.id)).catch(() => undefined);
  }

  return rows.length;
}

export async function createInboundMessage(env: Env, input: {
  id: string;
  tenantId: string;
  mailboxId: string;
  provider: string;
  internetMessageId?: string | null;
  fromAddr: string;
  toAddr: string;
  status: MessageRecord["status"];
  rawR2Key: string;
  receivedAt: string;
  createdAt: string;
}): Promise<boolean> {
  const normalizedMessageId = normalizeInternetMessageId(input.internetMessageId);
  const finalizeCreatedInboundMessage = async (): Promise<void> => {
    const mailboxExists = await firstRow<{ id: string }>(
      env.D1_DB.prepare(
        `SELECT id
         FROM mailboxes
         WHERE id = ? AND tenant_id = ?
         LIMIT 1`
      ).bind(input.mailboxId, input.tenantId)
    );

    if (!mailboxExists) {
      await execute(env.D1_DB.prepare(
        `DELETE FROM messages WHERE id = ?`
      ).bind(input.id)).catch(() => undefined);
      throw new Error(`Inbound message ${input.id} could not be finalized because mailbox ${input.mailboxId} no longer exists`);
    }

    if (!(await getMessage(env, input.id))) {
      await execute(env.D1_DB.prepare(
        `DELETE FROM messages WHERE id = ?`
      ).bind(input.id)).catch(() => undefined);
      throw new Error(`Failed to load inbound message ${input.id}`);
    }
  };

  if (!normalizedMessageId) {
    await execute(env.D1_DB.prepare(
      `INSERT INTO messages (
         id, tenant_id, mailbox_id, direction, provider, internet_message_id,
         from_addr, to_addr, status, raw_r2_key, received_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      input.id,
      input.tenantId,
      input.mailboxId,
      "inbound",
      input.provider,
      null,
      input.fromAddr,
      input.toAddr,
      input.status,
      input.rawR2Key,
      input.receivedAt,
      input.createdAt
    ));
    await finalizeCreatedInboundMessage();
    return true;
  }

  const insertInboundMessage = async () => await execute(env.D1_DB.prepare(
    `INSERT INTO messages (
       id, tenant_id, mailbox_id, direction, provider, internet_message_id,
       from_addr, to_addr, status, raw_r2_key, received_at, created_at
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1
       FROM messages
       WHERE mailbox_id = ?
         AND direction = 'inbound'
         AND internet_message_id = ?
         AND tenant_id = ?
         AND EXISTS (
           SELECT 1
           FROM mailboxes
           WHERE mailboxes.id = messages.mailbox_id
             AND mailboxes.tenant_id = messages.tenant_id
         )
     )`
  ).bind(
    input.id,
    input.tenantId,
    input.mailboxId,
    "inbound",
    input.provider,
    normalizedMessageId,
    input.fromAddr,
    input.toAddr,
    input.status,
    input.rawR2Key,
    input.receivedAt,
    input.createdAt,
    input.mailboxId,
    normalizedMessageId,
    input.tenantId
  ));

  let result = await insertInboundMessage();

  if ((result.meta?.changes ?? 0) === 0) {
    const existing = await getInboundMessageByInternetMessageId(env, input.mailboxId, normalizedMessageId);
    if (existing) {
      return false;
    }

    const deleted = await deleteInvalidInboundMessageDuplicates(env, {
      tenantId: input.tenantId,
      mailboxId: input.mailboxId,
      internetMessageId: normalizedMessageId,
    });
    if (deleted > 0) {
      result = await insertInboundMessage();
      if ((result.meta?.changes ?? 0) > 0) {
        await finalizeCreatedInboundMessage();
        return true;
      }

      const concurrent = await getInboundMessageByInternetMessageId(env, input.mailboxId, normalizedMessageId);
      if (concurrent) {
        return false;
      }
    }

    throw new Error(
      `Inbound message ${input.id} could not be created because dedupe skipped insertion without any visible existing message for ${normalizedMessageId}`
    );
  }

  await finalizeCreatedInboundMessage();
  return true;
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

  conditions.push(`EXISTS (
    SELECT 1
    FROM mailboxes
    WHERE mailboxes.id = messages.mailbox_id
      AND mailboxes.tenant_id = messages.tenant_id
  )`);

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

  let text = typeof normalized.text === "string" ? normalized.text : undefined;
  let html = typeof normalized.html === "string" ? normalized.html : undefined;
  let attachments = rows.map((row) => ({
    id: row.id,
    filename: row.filename ?? undefined,
    contentType: row.content_type ?? undefined,
    sizeBytes: row.size_bytes,
    downloadUrl: row.r2_key,
  }));

  if (message.direction === "outbound" && (!text && !html || attachments.length === 0)) {
    const outboundJob = await getOutboundJobByMessageId(env, messageId);
    if (outboundJob) {
      const draftObject = await env.R2_EMAIL.get(outboundJob.draftR2Key);
      if (draftObject) {
        const draftPayload = await draftObject.json<Record<string, unknown>>();
        text = text ?? (typeof draftPayload.text === "string" ? draftPayload.text : undefined);
        html = html ?? (typeof draftPayload.html === "string" ? draftPayload.html : undefined);

        if (attachments.length === 0) {
          const attachmentRefs = Array.isArray(draftPayload.attachments)
            ? draftPayload.attachments.filter((item): item is { filename?: unknown; contentType?: unknown; r2Key?: unknown } => typeof item === "object" && item !== null)
            : [];

          attachments = [];
          for (let index = 0; index < attachmentRefs.length; index += 1) {
            const ref = attachmentRefs[index];
            const r2Key = typeof ref.r2Key === "string" ? ref.r2Key : "";
            if (!r2Key) {
              continue;
            }

            const object = await env.R2_EMAIL.get(r2Key);
            attachments.push({
              id: `draft_attachment_${index + 1}`,
              filename: typeof ref.filename === "string" ? ref.filename : r2Key.split("/").pop() ?? `attachment-${index + 1}`,
              contentType: typeof ref.contentType === "string" ? ref.contentType : object?.httpMetadata?.contentType ?? undefined,
              sizeBytes: typeof object?.size === "number" ? object.size : 0,
              downloadUrl: r2Key,
            });
          }
        }
      }
    }
  }

  return {
    text,
    html,
    attachments,
  };
}

export async function getAttachmentOwnerByR2Key(env: Env, r2Key: string): Promise<{
  messageId: string;
  tenantId: string;
  mailboxId: string;
} | null> {
  const rows = await allRows<AttachmentOwnerRow>(
    env.D1_DB.prepare(
      `SELECT DISTINCT a.message_id, m.tenant_id, m.mailbox_id
       FROM attachments a
       JOIN messages m ON m.id = a.message_id
       JOIN mailboxes mb ON mb.id = m.mailbox_id AND mb.tenant_id = m.tenant_id
       WHERE a.r2_key = ?
       LIMIT 2`
    ).bind(r2Key)
  );

  if (rows.length !== 1) {
    return null;
  }

  const row = rows[0]!;

  return {
    messageId: row.message_id,
    tenantId: row.tenant_id,
    mailboxId: row.mailbox_id,
  };
}

export async function getThread(env: Env, threadId: string): Promise<ThreadRecord | null> {
  const thread = await firstRow<ThreadRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, mailbox_id, thread_key, subject_norm, status
       FROM threads
       WHERE id = ?
         AND EXISTS (
           SELECT 1
           FROM mailboxes
           WHERE mailboxes.id = threads.mailbox_id
             AND mailboxes.tenant_id = threads.tenant_id
         )`
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
         AND mailbox_id = ?
         AND tenant_id = ?
         AND EXISTS (
           SELECT 1
           FROM mailboxes
           WHERE mailboxes.id = messages.mailbox_id
             AND mailboxes.tenant_id = messages.tenant_id
         )
       ORDER BY created_at ASC`
    ).bind(threadId, thread.mailbox_id, thread.tenant_id)
  );

  return {
    id: thread.id,
    tenantId: thread.tenant_id ?? messageRows[0]?.tenant_id ?? "",
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
           AND EXISTS (
             SELECT 1
             FROM messages
             WHERE messages.id = outbound_jobs.message_id
               AND EXISTS (
                 SELECT 1
                 FROM mailboxes
                 WHERE mailboxes.id = messages.mailbox_id
                   AND mailboxes.tenant_id = messages.tenant_id
               )
           )
         ORDER BY created_at DESC
         LIMIT ?`
      ).bind(input.status, limit)
    : env.D1_DB.prepare(
        `SELECT id, message_id, task_id, status, ses_region, retry_count, next_retry_at,
                last_error, draft_r2_key, created_at, updated_at
         FROM outbound_jobs
         WHERE EXISTS (
           SELECT 1
           FROM messages
           WHERE messages.id = outbound_jobs.message_id
             AND EXISTS (
               SELECT 1
               FROM mailboxes
               WHERE mailboxes.id = messages.mailbox_id
                 AND mailboxes.tenant_id = messages.tenant_id
             )
         )
         ORDER BY created_at DESC
         LIMIT ?`
      ).bind(limit);

  const rows = await allRows<OutboundJobRow>(query);
  return rows.map(mapOutboundJobRow);
}

async function listVisibleOutboundJobsByMessageId(
  env: Env,
  messageId: string,
  limit = 2,
): Promise<OutboundJobRow[]> {
  return await allRows<OutboundJobRow>(
    env.D1_DB.prepare(
      `SELECT id, message_id, task_id, status, ses_region, retry_count, next_retry_at,
              last_error, draft_r2_key, created_at, updated_at
       FROM outbound_jobs
       WHERE message_id = ?
         AND EXISTS (
           SELECT 1
           FROM messages
           WHERE messages.id = outbound_jobs.message_id
             AND EXISTS (
               SELECT 1
               FROM mailboxes
               WHERE mailboxes.id = messages.mailbox_id
                 AND mailboxes.tenant_id = messages.tenant_id
             )
         )
       ORDER BY created_at DESC
       LIMIT ?`
    ).bind(messageId, limit)
  );
}

async function listVisibleOutboundJobsByDraftR2Key(
  env: Env,
  draftR2Key: string,
  limit = 2,
): Promise<OutboundJobRow[]> {
  return await allRows<OutboundJobRow>(
    env.D1_DB.prepare(
      `SELECT id, message_id, task_id, status, ses_region, retry_count, next_retry_at,
              last_error, draft_r2_key, created_at, updated_at
       FROM outbound_jobs
       WHERE draft_r2_key = ?
         AND EXISTS (
           SELECT 1
           FROM messages
           WHERE messages.id = outbound_jobs.message_id
             AND EXISTS (
               SELECT 1
               FROM mailboxes
               WHERE mailboxes.id = messages.mailbox_id
                 AND mailboxes.tenant_id = messages.tenant_id
             )
         )
       ORDER BY created_at DESC
       LIMIT ?`
    ).bind(draftR2Key, limit)
  );
}

export async function getOrCreateThread(env: Env, input: {
  tenantId: string;
  mailboxId: string;
  threadKey: string;
  subjectNorm?: string;
}): Promise<ThreadRecord> {
  const loadVisibleThread = async () => await firstRow<ThreadRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, mailbox_id, thread_key, subject_norm, status
       FROM threads
       WHERE mailbox_id = ? AND thread_key = ?
         AND tenant_id = ?
         AND EXISTS (
           SELECT 1
           FROM mailboxes
           WHERE mailboxes.id = threads.mailbox_id
             AND mailboxes.tenant_id = threads.tenant_id
         )`
    ).bind(input.mailboxId, input.threadKey, input.tenantId)
  );
  const mapThread = (row: ThreadRow): ThreadRecord => ({
    id: row.id,
    tenantId: row.tenant_id ?? input.tenantId,
    mailboxId: row.mailbox_id,
    subjectNorm: row.subject_norm ?? undefined,
    status: row.status ?? undefined,
    messages: [],
  });
  const deleteInvalidThreadsForMailboxThreadKey = async (): Promise<number> => {
    const rows = await allRows<{ id: string }>(
      env.D1_DB.prepare(
        `SELECT id
         FROM threads
         WHERE mailbox_id = ? AND thread_key = ?
           AND NOT (
             tenant_id = ?
             AND EXISTS (
               SELECT 1
               FROM mailboxes
               WHERE mailboxes.id = threads.mailbox_id
                 AND mailboxes.tenant_id = threads.tenant_id
             )
           )`
      ).bind(input.mailboxId, input.threadKey, input.tenantId)
    );

    for (const row of rows) {
      await execute(env.D1_DB.prepare(
        `DELETE FROM threads WHERE id = ?`
      ).bind(row.id)).catch(() => undefined);
    }

    return rows.length;
  };

  const existing = await loadVisibleThread();

  if (existing) {
    return mapThread(existing);
  }

  const id = createId("thr");
  const insertThread = async () => await execute(env.D1_DB.prepare(
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

  try {
    await insertThread();
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    const concurrent = await loadVisibleThread();

    if (concurrent) {
      return mapThread(concurrent);
    }

    const deleted = await deleteInvalidThreadsForMailboxThreadKey();
    if (deleted === 0) {
      throw error;
    }

    try {
      await insertThread();
    } catch (retryError) {
      if (!isUniqueConstraintError(retryError)) {
        throw retryError;
      }

      const retriedConcurrent = await loadVisibleThread();
      if (retriedConcurrent) {
        return mapThread(retriedConcurrent);
      }

      throw retryError;
    }
  }

  const mailbox = await firstRow<{ id: string }>(
    env.D1_DB.prepare(
      `SELECT id
       FROM mailboxes
       WHERE id = ? AND tenant_id = ?`
    ).bind(input.mailboxId, input.tenantId)
  );
  if (!mailbox) {
    await execute(env.D1_DB.prepare(
      `DELETE FROM threads WHERE id = ?`
    ).bind(id)).catch(() => undefined);
    throw new Error(`Thread ${id} could not be finalized because mailbox ${input.mailboxId} no longer exists`);
  }

  const created = await firstRow<ThreadRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, mailbox_id, thread_key, subject_norm, status
       FROM threads
       WHERE id = ? AND tenant_id = ? AND mailbox_id = ?`
    ).bind(id, input.tenantId, input.mailboxId)
  );
  if (!created) {
    await execute(env.D1_DB.prepare(
      `DELETE FROM threads WHERE id = ?`
    ).bind(id)).catch(() => undefined);
    throw new Error(`Failed to load thread ${id}`);
  }

  return mapThread(created);
}

export async function findThreadByInternetMessageIds(env: Env, input: {
  tenantId: string;
  mailboxId: string;
  internetMessageIds: string[];
}): Promise<ThreadRecord | null> {
  const candidates = [...new Set(input.internetMessageIds.map((value) => normalizeInternetMessageId(value)).filter((value): value is string => Boolean(value)))];

  for (const internetMessageId of candidates) {
    const rows = await allRows<ThreadRow>(
      env.D1_DB.prepare(
        `SELECT t.id, t.tenant_id, t.mailbox_id, t.thread_key, t.subject_norm, t.status
         FROM messages m
         JOIN threads t
           ON t.id = m.thread_id
          AND t.mailbox_id = m.mailbox_id
          AND t.tenant_id = m.tenant_id
          AND EXISTS (
            SELECT 1
            FROM mailboxes
            WHERE mailboxes.id = t.mailbox_id
              AND mailboxes.tenant_id = t.tenant_id
          )
         WHERE m.mailbox_id = ? AND m.tenant_id = ? AND lower(m.internet_message_id) = ? AND m.thread_id IS NOT NULL
         ORDER BY m.created_at DESC
         LIMIT 2`
      ).bind(input.mailboxId, input.tenantId, internetMessageId)
    );

    if (rows.length === 0) {
      continue;
    }

    const uniqueThreadIds = new Set(rows.map((row) => row.id));
    if (uniqueThreadIds.size !== 1) {
      return null;
    }

    const row = rows[0]!;
    if (row) {
      return {
        id: row.id,
        tenantId: row.tenant_id ?? input.tenantId,
        mailboxId: row.mailbox_id,
        subjectNorm: row.subject_norm ?? undefined,
        status: row.status ?? undefined,
        messages: [],
      };
    }
  }

  return null;
}

function normalizeEmailAddress(value?: string | null): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function parseStoredRecipientList(value: string): string[] {
  return value
    .split(",")
    .map((item) => normalizeEmailAddress(item))
    .filter((item): item is string => Boolean(item));
}

async function loadReplyFallbackRecipients(env: Env, row: ReplyFallbackCandidateRow): Promise<string[]> {
  const recipients = new Set(parseStoredRecipientList(row.to_addr));
  const draftR2Key = row.draft_r2_key?.trim();
  if (!draftR2Key) {
    return [...recipients];
  }

  const draft = await getDraftByR2KeyForOutboundLifecycle(env, draftR2Key);
  if (!draft) {
    return [...recipients];
  }
  if (draft.tenantId !== (row.tenant_id ?? "") || draft.mailboxId !== row.mailbox_id) {
    return [...recipients];
  }

  const draftObject = await env.R2_EMAIL.get(draftR2Key);
  if (!draftObject) {
    return [...recipients];
  }

  const payload = await draftObject.json<Record<string, unknown>>();
  for (const field of ["to", "cc", "bcc"] as const) {
    const values = payload[field];
    if (!Array.isArray(values)) {
      continue;
    }

    for (const value of values) {
      const normalized = typeof value === "string" ? normalizeEmailAddress(value) : null;
      if (normalized) {
        recipients.add(normalized);
      }
    }
  }

  return [...recipients];
}

export async function assignDraftThreadId(env: Env, draftId: string, threadId: string): Promise<void> {
  const result = await execute(env.D1_DB.prepare(
    `UPDATE drafts
     SET thread_id = ?, updated_at = ?
     WHERE id = ?
       AND EXISTS (
         SELECT 1
         FROM threads
         JOIN mailboxes ON mailboxes.id = threads.mailbox_id
         WHERE threads.id = ?
           AND threads.mailbox_id = drafts.mailbox_id
           AND threads.tenant_id = drafts.tenant_id
           AND mailboxes.tenant_id = threads.tenant_id
       )`
  ).bind(
    threadId,
    nowIso(),
    draftId,
    threadId,
  ));

  requireStateUpdateApplied(result.meta?.changes, `Draft ${draftId}`);
}

async function restoreDraftSendState(env: Env, input: {
  draftId: string;
  status: DraftRecord["status"];
  threadId: string | null;
}): Promise<void> {
  const result = await execute(env.D1_DB.prepare(
    `UPDATE drafts
     SET status = ?, thread_id = ?, updated_at = ?
     WHERE id = ?
       AND EXISTS (
         SELECT 1
         FROM agents
         WHERE agents.id = drafts.agent_id
           AND agents.tenant_id = drafts.tenant_id
       )
       AND EXISTS (
         SELECT 1
         FROM mailboxes
         WHERE mailboxes.id = drafts.mailbox_id
           AND mailboxes.tenant_id = drafts.tenant_id
       )
       AND (
         ? IS NULL
         OR EXISTS (
           SELECT 1
           FROM threads
           JOIN mailboxes ON mailboxes.id = threads.mailbox_id
           WHERE threads.id = ?
             AND threads.mailbox_id = drafts.mailbox_id
             AND threads.tenant_id = drafts.tenant_id
             AND mailboxes.tenant_id = threads.tenant_id
         )
       )`
  ).bind(
    input.status,
    input.threadId,
    nowIso(),
    input.draftId,
    input.threadId,
    input.threadId,
  ));

  requireStateUpdateApplied(result.meta?.changes, `Draft ${input.draftId}`);
}

export async function deleteThreadIfUnreferenced(env: Env, threadId: string): Promise<void> {
  await execute(env.D1_DB.prepare(
    `DELETE FROM threads
     WHERE id = ?
       AND NOT EXISTS (
         SELECT 1
         FROM messages
         WHERE thread_id = ?
           AND EXISTS (
             SELECT 1
             FROM mailboxes
             WHERE mailboxes.id = messages.mailbox_id
               AND mailboxes.tenant_id = messages.tenant_id
           )
       )
       AND NOT EXISTS (
         SELECT 1
         FROM drafts
         WHERE thread_id = ?
           AND EXISTS (
             SELECT 1
             FROM agents
             WHERE agents.id = drafts.agent_id
               AND agents.tenant_id = drafts.tenant_id
           )
           AND EXISTS (
             SELECT 1
             FROM mailboxes
             WHERE mailboxes.id = drafts.mailbox_id
               AND mailboxes.tenant_id = drafts.tenant_id
           )
       )`
  ).bind(
    threadId,
    threadId,
    threadId,
  ));
}

export async function assignMessageThreadId(env: Env, messageId: string, threadId: string): Promise<void> {
  const result = await execute(env.D1_DB.prepare(
    `UPDATE messages
     SET thread_id = ?
     WHERE id = ?
       AND EXISTS (
         SELECT 1
         FROM threads
         JOIN mailboxes ON mailboxes.id = threads.mailbox_id
         WHERE threads.id = ?
           AND threads.mailbox_id = messages.mailbox_id
           AND threads.tenant_id = messages.tenant_id
           AND mailboxes.tenant_id = threads.tenant_id
       )`
  ).bind(
    threadId,
    messageId,
    threadId,
  ));

  requireStateUpdateApplied(result.meta?.changes, `Message ${messageId}`);
}

export async function findThreadByReplyContext(env: Env, input: {
  tenantId: string;
  mailboxId: string;
  internetMessageIds: string[];
  subject?: string;
  participantAddress?: string;
}): Promise<ThreadRecord | null> {
  const exactThread = await findThreadByInternetMessageIds(env, input);
  if (exactThread) {
    return exactThread;
  }

  const subjectNorm = normalizeSubject(input.subject);
  const participantAddress = normalizeEmailAddress(input.participantAddress);
  if (!subjectNorm || !participantAddress) {
    return null;
  }

  const rows = await allRows<ReplyFallbackCandidateRow>(
    env.D1_DB.prepare(
      `SELECT
         m.id AS message_id,
         m.tenant_id,
         m.mailbox_id,
         m.thread_id,
         m.internet_message_id,
         m.provider_message_id,
         m.to_addr,
         CASE
           WHEN (
             SELECT COUNT(*)
             FROM outbound_jobs visible_outbound_jobs
             WHERE visible_outbound_jobs.message_id = m.id
               AND EXISTS (
                 SELECT 1
                 FROM messages visible_messages
                 WHERE visible_messages.id = visible_outbound_jobs.message_id
                   AND EXISTS (
                     SELECT 1
                     FROM mailboxes
                     WHERE mailboxes.id = visible_messages.mailbox_id
                       AND mailboxes.tenant_id = visible_messages.tenant_id
                   )
               )
           ) = 1 THEN (
             SELECT visible_outbound_jobs.draft_r2_key
             FROM outbound_jobs visible_outbound_jobs
             WHERE visible_outbound_jobs.message_id = m.id
               AND EXISTS (
                 SELECT 1
                 FROM messages visible_messages
                 WHERE visible_messages.id = visible_outbound_jobs.message_id
                   AND EXISTS (
                     SELECT 1
                     FROM mailboxes
                     WHERE mailboxes.id = visible_messages.mailbox_id
                       AND mailboxes.tenant_id = visible_messages.tenant_id
                   )
               )
             ORDER BY visible_outbound_jobs.created_at DESC
             LIMIT 1
           )
           ELSE NULL
         END AS draft_r2_key,
         m.subject,
         m.created_at,
         t.id AS thread_row_id,
         t.thread_key,
         t.subject_norm,
         t.status AS thread_status
       FROM messages m
       LEFT JOIN threads t
         ON t.id = m.thread_id
        AND t.mailbox_id = m.mailbox_id
        AND t.tenant_id = m.tenant_id
        AND EXISTS (
          SELECT 1
          FROM mailboxes
          WHERE mailboxes.id = t.mailbox_id
            AND mailboxes.tenant_id = t.tenant_id
        )
       WHERE m.mailbox_id = ?
         AND m.tenant_id = ?
         AND m.direction = 'outbound'
         AND EXISTS (
           SELECT 1
           FROM mailboxes
           WHERE mailboxes.id = m.mailbox_id
             AND mailboxes.tenant_id = m.tenant_id
         )
         AND (
           SELECT COUNT(*)
           FROM outbound_jobs visible_outbound_jobs
           WHERE visible_outbound_jobs.message_id = m.id
             AND EXISTS (
               SELECT 1
               FROM messages visible_messages
               WHERE visible_messages.id = visible_outbound_jobs.message_id
                 AND EXISTS (
                   SELECT 1
                   FROM mailboxes
                   WHERE mailboxes.id = visible_messages.mailbox_id
                     AND mailboxes.tenant_id = visible_messages.tenant_id
                 )
             )
         ) <= 1
       ORDER BY m.created_at DESC
       LIMIT 50`
    ).bind(input.mailboxId, input.tenantId)
  );

  const referencedIds = new Set(
    input.internetMessageIds
      .map((value) => normalizeInternetMessageId(value))
      .filter((value): value is string => Boolean(value))
  );
  const candidates: ReplyFallbackCandidateRow[] = [];
  for (const row of rows) {
    const recipients = await loadReplyFallbackRecipients(env, row);
    if (recipients.includes(participantAddress) && normalizeSubject(row.subject ?? undefined) === subjectNorm) {
      candidates.push(row);
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  const exactProviderCandidateKeys = new Set(
    candidates
      .filter((row) => {
        const providerMessageId = normalizeEmailAddress(row.provider_message_id);
        const internetMessageId = normalizeEmailAddress(row.internet_message_id);
        return (providerMessageId && referencedIds.has(providerMessageId))
          || (internetMessageId && referencedIds.has(internetMessageId));
      })
      .map((row) => row.thread_id ?? row.message_id)
  );

  const effectiveCandidates = exactProviderCandidateKeys.size > 0
    ? candidates.filter((row) => exactProviderCandidateKeys.has(row.thread_id ?? row.message_id))
    : candidates;

  const uniqueCandidateKeys = new Set(effectiveCandidates.map((row) => row.thread_id ?? row.message_id));
  if (uniqueCandidateKeys.size !== 1) {
    return null;
  }

  const selected = effectiveCandidates[0]!;
  if (selected.thread_id && selected.thread_row_id) {
    return {
      id: selected.thread_row_id,
      tenantId: selected.tenant_id ?? input.tenantId,
      mailboxId: selected.mailbox_id,
      subjectNorm: selected.subject_norm ?? subjectNorm,
      status: selected.thread_status ?? "open",
      messages: [],
    };
  }

  const thread = await getOrCreateThread(env, {
    tenantId: selected.tenant_id ?? input.tenantId,
    mailboxId: selected.mailbox_id,
    threadKey: selected.internet_message_id ?? selected.provider_message_id ?? `outbound:${selected.message_id}`,
    subjectNorm,
  });
  try {
    await assignMessageThreadId(env, selected.message_id, thread.id);
  } catch (error) {
    await deleteThreadIfUnreferenced(env, thread.id).catch(() => undefined);
    throw error;
  }
  return thread;
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
  } catch (error) {
    await env.R2_EMAIL.delete(draftR2Key).catch(() => undefined);
    throw error;
  }

  const agentExists = await firstRow<{ id: string }>(
    env.D1_DB.prepare(
      `SELECT id
       FROM agents
       WHERE id = ? AND tenant_id = ?
       LIMIT 1`
    ).bind(input.agentId, input.tenantId)
  );
  const mailboxExists = await firstRow<{ id: string }>(
    env.D1_DB.prepare(
      `SELECT id
       FROM mailboxes
       WHERE id = ? AND tenant_id = ?
       LIMIT 1`
    ).bind(input.mailboxId, input.tenantId)
  );
  const threadExists = input.threadId
    ? await firstRow<{ id: string }>(
        env.D1_DB.prepare(
          `SELECT id
           FROM threads
           WHERE id = ? AND tenant_id = ? AND mailbox_id = ?
           LIMIT 1`
        ).bind(input.threadId, input.tenantId, input.mailboxId)
      )
    : { id: "" };
  const sourceMessageExists = input.sourceMessageId
    ? await firstRow<{ id: string }>(
        env.D1_DB.prepare(
          `SELECT id
           FROM messages
           WHERE id = ? AND tenant_id = ? AND mailbox_id = ?
           LIMIT 1`
        ).bind(input.sourceMessageId, input.tenantId, input.mailboxId)
      )
    : { id: "" };

  if (!agentExists || !mailboxExists || (input.threadId && !threadExists) || (input.sourceMessageId && !sourceMessageExists)) {
    await execute(env.D1_DB.prepare(
      `DELETE FROM drafts WHERE id = ?`
    ).bind(id)).catch(() => undefined);
    await env.R2_EMAIL.delete(draftR2Key).catch(() => undefined);
    throw new Error(`Draft ${id} could not be finalized because the agent, mailbox, or referenced message/thread no longer exists`);
  }

  const created = await getDraft(env, id);
  if (!created) {
    await execute(env.D1_DB.prepare(
      `DELETE FROM drafts WHERE id = ?`
    ).bind(id)).catch(() => undefined);
    await env.R2_EMAIL.delete(draftR2Key).catch(() => undefined);
    throw new Error("Failed to load created draft");
  }

  return created;
}

export async function getDraft(env: Env, draftId: string): Promise<DraftRecord | null> {
  let row: DraftRow | null = null;
  try {
    row = await firstRow<DraftRow>(
      env.D1_DB.prepare(
        `SELECT id, tenant_id, agent_id, mailbox_id, thread_id, source_message_id, created_via,
                status, draft_r2_key, created_at, updated_at
         FROM drafts
         WHERE id = ?
           AND EXISTS (
             SELECT 1
             FROM agents
             WHERE agents.id = drafts.agent_id
               AND agents.tenant_id = drafts.tenant_id
           )
           AND EXISTS (
             SELECT 1
             FROM mailboxes
             WHERE mailboxes.id = drafts.mailbox_id
               AND mailboxes.tenant_id = drafts.tenant_id
           )
           AND (
             drafts.thread_id IS NULL
             OR EXISTS (
               SELECT 1
               FROM threads
               JOIN mailboxes ON mailboxes.id = threads.mailbox_id
               WHERE threads.id = drafts.thread_id
                 AND threads.mailbox_id = drafts.mailbox_id
                 AND threads.tenant_id = drafts.tenant_id
                 AND mailboxes.tenant_id = threads.tenant_id
             )
           )
           AND (
             drafts.source_message_id IS NULL
             OR EXISTS (
               SELECT 1
               FROM messages
               WHERE messages.id = drafts.source_message_id
                 AND messages.mailbox_id = drafts.mailbox_id
                 AND messages.tenant_id = drafts.tenant_id
                 AND EXISTS (
                   SELECT 1
                   FROM mailboxes
                   WHERE mailboxes.id = messages.mailbox_id
                     AND mailboxes.tenant_id = messages.tenant_id
                 )
             )
           )`
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
         WHERE id = ?
           AND EXISTS (
             SELECT 1
             FROM agents
             WHERE agents.id = drafts.agent_id
               AND agents.tenant_id = drafts.tenant_id
           )
           AND EXISTS (
             SELECT 1
             FROM mailboxes
             WHERE mailboxes.id = drafts.mailbox_id
               AND mailboxes.tenant_id = drafts.tenant_id
           )
           AND (
             drafts.thread_id IS NULL
             OR EXISTS (
               SELECT 1
               FROM threads
               JOIN mailboxes ON mailboxes.id = threads.mailbox_id
               WHERE threads.id = drafts.thread_id
                 AND threads.mailbox_id = drafts.mailbox_id
                 AND threads.tenant_id = drafts.tenant_id
                 AND mailboxes.tenant_id = threads.tenant_id
             )
           )
           AND (
             drafts.source_message_id IS NULL
             OR EXISTS (
               SELECT 1
               FROM messages
               WHERE messages.id = drafts.source_message_id
                 AND messages.mailbox_id = drafts.mailbox_id
                 AND messages.tenant_id = drafts.tenant_id
                 AND EXISTS (
                   SELECT 1
                   FROM mailboxes
                   WHERE mailboxes.id = messages.mailbox_id
                     AND mailboxes.tenant_id = messages.tenant_id
                 )
             )
           )`
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

  conditions.push(`EXISTS (
    SELECT 1
    FROM agents
    WHERE agents.id = drafts.agent_id
      AND agents.tenant_id = drafts.tenant_id
  )`);
  conditions.push(`EXISTS (
    SELECT 1
    FROM mailboxes
    WHERE mailboxes.id = drafts.mailbox_id
      AND mailboxes.tenant_id = drafts.tenant_id
  )`);
  conditions.push(`(
    drafts.thread_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM threads
      JOIN mailboxes ON mailboxes.id = threads.mailbox_id
      WHERE threads.id = drafts.thread_id
        AND threads.mailbox_id = drafts.mailbox_id
        AND threads.tenant_id = drafts.tenant_id
        AND mailboxes.tenant_id = threads.tenant_id
    )
  )`);
  conditions.push(`(
    drafts.source_message_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM messages
      WHERE messages.id = drafts.source_message_id
        AND messages.mailbox_id = drafts.mailbox_id
        AND messages.tenant_id = drafts.tenant_id
        AND EXISTS (
          SELECT 1
          FROM mailboxes
          WHERE mailboxes.id = messages.mailbox_id
            AND mailboxes.tenant_id = messages.tenant_id
        )
    )
  )`);

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

async function listVisibleDraftRowsByR2Key(
  env: Env,
  draftR2Key: string,
  options?: { forOutboundLifecycle?: boolean; limit?: number },
): Promise<DraftRow[]> {
  const limit = options?.limit ?? 2;
  const referenceValidityClause = options?.forOutboundLifecycle
    ? ""
    : `
           AND (
             drafts.thread_id IS NULL
             OR EXISTS (
               SELECT 1
               FROM threads
               JOIN mailboxes ON mailboxes.id = threads.mailbox_id
               WHERE threads.id = drafts.thread_id
                 AND threads.mailbox_id = drafts.mailbox_id
                 AND threads.tenant_id = drafts.tenant_id
                 AND mailboxes.tenant_id = threads.tenant_id
             )
           )
           AND (
             drafts.source_message_id IS NULL
             OR EXISTS (
               SELECT 1
               FROM messages
               WHERE messages.id = drafts.source_message_id
                 AND messages.mailbox_id = drafts.mailbox_id
                 AND messages.tenant_id = drafts.tenant_id
                 AND EXISTS (
                   SELECT 1
                   FROM mailboxes
                   WHERE mailboxes.id = messages.mailbox_id
                     AND mailboxes.tenant_id = messages.tenant_id
                 )
             )
           )`;
  try {
    return await allRows<DraftRow>(
      env.D1_DB.prepare(
        `SELECT id, tenant_id, agent_id, mailbox_id, thread_id, source_message_id, created_via,
                status, draft_r2_key, created_at, updated_at
         FROM drafts
         WHERE draft_r2_key = ?
           AND EXISTS (
             SELECT 1
             FROM agents
             WHERE agents.id = drafts.agent_id
               AND agents.tenant_id = drafts.tenant_id
           )
           AND EXISTS (
             SELECT 1
             FROM mailboxes
             WHERE mailboxes.id = drafts.mailbox_id
               AND mailboxes.tenant_id = drafts.tenant_id
           )
           ${referenceValidityClause}
         ORDER BY created_at DESC
         LIMIT ?`
      ).bind(draftR2Key, limit)
    );
  } catch (error) {
    if (!isMissingCreatedViaColumn(error)) {
      throw error;
    }

    return await allRows<DraftRow>(
      env.D1_DB.prepare(
        `SELECT id, tenant_id, agent_id, mailbox_id, thread_id, source_message_id,
                status, draft_r2_key, created_at, updated_at
         FROM drafts
         WHERE draft_r2_key = ?
           AND EXISTS (
             SELECT 1
             FROM agents
             WHERE agents.id = drafts.agent_id
               AND agents.tenant_id = drafts.tenant_id
           )
           AND EXISTS (
             SELECT 1
             FROM mailboxes
             WHERE mailboxes.id = drafts.mailbox_id
               AND mailboxes.tenant_id = drafts.tenant_id
           )
           ${referenceValidityClause}
         ORDER BY created_at DESC
         LIMIT ?`
      ).bind(draftR2Key, limit)
    );
  }
}

export async function getDraftByR2Key(env: Env, draftR2Key: string): Promise<DraftRecord | null> {
  const rows = await listVisibleDraftRowsByR2Key(env, draftR2Key);
  if (rows.length !== 1) {
    return null;
  }

  return mapDraftRow(rows[0]);
}

export async function getDraftByR2KeyForOutboundLifecycle(env: Env, draftR2Key: string): Promise<DraftRecord | null> {
  const rows = await listVisibleDraftRowsByR2Key(env, draftR2Key, { forOutboundLifecycle: true });
  if (rows.length !== 1) {
    return null;
  }

  return mapDraftRow(rows[0]);
}

async function getDraftForCleanup(env: Env, draftId: string): Promise<CleanupDraftRow | null> {
  return await firstRow<CleanupDraftRow>(
    env.D1_DB.prepare(
      `SELECT id, draft_r2_key, status
       FROM drafts
       WHERE id = ?`
    ).bind(draftId)
  );
}

async function deleteInvalidOutboundJobsForDraftR2Key(env: Env, draftR2Key: string): Promise<number> {
  const rows = await allRows<{ id: string }>(
    env.D1_DB.prepare(
      `SELECT id
       FROM outbound_jobs
       WHERE draft_r2_key = ?
         AND NOT EXISTS (
           SELECT 1
           FROM messages
           WHERE messages.id = outbound_jobs.message_id
             AND EXISTS (
               SELECT 1
               FROM mailboxes
               WHERE mailboxes.id = messages.mailbox_id
                 AND mailboxes.tenant_id = messages.tenant_id
             )
         )`
    ).bind(draftR2Key)
  );

  for (const row of rows) {
    await execute(env.D1_DB.prepare(
      `DELETE FROM outbound_jobs WHERE id = ?`
    ).bind(row.id)).catch(() => undefined);
  }

  return rows.length;
}

export async function deleteDraftIfUnqueued(env: Env, draftId: string): Promise<boolean> {
  const visibleDraft = await getDraft(env, draftId);
  const fallbackDraft = visibleDraft ? null : await getDraftForCleanup(env, draftId);
  if (!visibleDraft && !fallbackDraft) {
    return false;
  }
  const cleanupDraftR2Key = visibleDraft
    ? visibleDraft.draftR2Key
    : fallbackDraft!.draft_r2_key;

  await deleteInvalidOutboundJobsForDraftR2Key(env, cleanupDraftR2Key).catch(() => undefined);

  const deleteDraft = async () => await execute(env.D1_DB.prepare(
    `DELETE FROM drafts
     WHERE id = ?
       AND status IN (?, ?)
       AND NOT EXISTS (
         SELECT 1
         FROM outbound_jobs
         WHERE draft_r2_key = drafts.draft_r2_key
           AND EXISTS (
             SELECT 1
             FROM messages
             WHERE messages.id = outbound_jobs.message_id
               AND EXISTS (
                 SELECT 1
                 FROM mailboxes
                 WHERE mailboxes.id = messages.mailbox_id
                   AND mailboxes.tenant_id = messages.tenant_id
               )
           )
       )`
  ).bind(
    draftId,
    "draft",
    "approved",
  ));
  let result = await deleteDraft();

  if ((result.meta?.changes ?? 0) === 0) {
    if (!(await getOutboundJobByDraftR2Key(env, cleanupDraftR2Key))) {
      const deleted = await deleteInvalidOutboundJobsForDraftR2Key(env, cleanupDraftR2Key);
      if (deleted > 0) {
        result = await deleteDraft();
      }
    }
  }

  if ((result.meta?.changes ?? 0) === 0) {
    return false;
  }

  await env.R2_EMAIL.delete(cleanupDraftR2Key).catch(() => undefined);
  return true;
}

async function claimDraftForSend(
  env: Env,
  draftId: string,
  updatedAt: string,
): Promise<boolean> {
  const result = await execute(env.D1_DB.prepare(
    `UPDATE drafts
     SET status = ?, updated_at = ?
     WHERE id = ? AND status IN (?, ?)
       AND EXISTS (
         SELECT 1
         FROM agents
         WHERE agents.id = drafts.agent_id
           AND agents.tenant_id = drafts.tenant_id
       )
       AND EXISTS (
         SELECT 1
         FROM mailboxes
         WHERE mailboxes.id = drafts.mailbox_id
           AND mailboxes.tenant_id = drafts.tenant_id
       )`
  ).bind(
    "queued",
    updatedAt,
    draftId,
    "draft",
    "approved",
  ));

  return (result.meta?.changes ?? 0) > 0;
}

export async function enqueueDraftSend(env: Env, draftId: string): Promise<{ outboundJobId: string; status: "queued" }> {
  const draft = requireRow(await getDraft(env, draftId), "Draft not found");
  if (draft.status !== "draft" && draft.status !== "approved") {
    throw new Error(`Draft status ${draft.status} cannot be enqueued for send`);
  }
  const priorDraftStatus = draft.status;
  const priorThreadId = draft.threadId ?? null;
  const outboundJobId = createId("obj");
  const timestamp = nowIso();
  const claimed = await claimDraftForSend(env, draftId, timestamp);
  if (!claimed) {
    const latestDraft = await getDraft(env, draftId);
    throw new Error(`Draft status ${latestDraft?.status ?? "unknown"} cannot be enqueued for send`);
  }
  if (!(await getDraft(env, draftId))) {
    await restoreDraftSendState(env, {
      draftId,
      status: priorDraftStatus,
      threadId: priorThreadId,
    }).catch(async () => {
      await execute(env.D1_DB.prepare(
        `DELETE FROM drafts WHERE id = ?`
      ).bind(draftId)).catch(() => undefined);
      await env.R2_EMAIL.delete(draft.draftR2Key).catch(() => undefined);
    });
    throw new Error(`Draft ${draftId} no longer exists`);
  }
  const outboundMessageId = createId("msg");
  let creditReservationAmount = 0;
  let createdThreadId: string | null = null;

  try {
    const draftObject = await env.R2_EMAIL.get(draft.draftR2Key);
    const draftPayload = draftObject ? await draftObject.json<Record<string, unknown>>() : {};
    const parseDraftRecipientList = (value: unknown, field: "to" | "cc" | "bcc"): string[] => {
      if (value === undefined || value === null) {
        if (field === "to") {
          throw new Error("Draft recipients must include a non-empty to array and optional cc/bcc string arrays");
        }
        return [];
      }

      if (!Array.isArray(value)) {
        throw new Error("Draft recipients must include a non-empty to array and optional cc/bcc string arrays");
      }

      const items = value.map((item) => typeof item === "string" ? item.trim() : "");
      if (items.some((item) => !item)) {
        throw new Error("Draft recipients must include a non-empty to array and optional cc/bcc string arrays");
      }
      if (field === "to" && items.length === 0) {
        throw new Error("Draft recipients must include a non-empty to array and optional cc/bcc string arrays");
      }

      return items;
    };
    let outboundThreadId = draft.threadId ?? null;
    const to = parseDraftRecipientList(draftPayload.to, "to");
    const cc = parseDraftRecipientList(draftPayload.cc, "cc");
    const bcc = parseDraftRecipientList(draftPayload.bcc, "bcc");
    const subject = typeof draftPayload.subject === "string" ? draftPayload.subject : "";
    const normalizedSubject = normalizeSubject(subject);
    const creditRequirement = await getOutboundCreditRequirement(env, {
      tenantId: draft.tenantId,
      to,
      cc,
      bcc,
      sourceMessageId: draft.sourceMessageId,
      createdVia: draft.createdVia,
    });
    const attachmentRefs = draftPayload.attachments === undefined || draftPayload.attachments === null
      ? []
      : Array.isArray(draftPayload.attachments)
        ? draftPayload.attachments.map((item) => {
            if (
              typeof item !== "object"
              || item === null
              || typeof (item as { filename?: unknown }).filename !== "string"
              || typeof (item as { contentType?: unknown }).contentType !== "string"
              || typeof (item as { r2Key?: unknown }).r2Key !== "string"
            ) {
              throw new Error("Draft attachments must be an array of objects with filename, contentType, and r2Key");
            }

            return item as { filename: string; contentType: string; r2Key: string };
          })
        : (() => {
            throw new Error("Draft attachments must be an array when provided");
          })();
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
    if (!outboundThreadId && normalizedSubject) {
      const outboundThread = await getOrCreateThread(env, {
        tenantId: draft.tenantId,
        mailboxId: draft.mailboxId,
        threadKey: `outbound:${outboundMessageId}`,
        subjectNorm: normalizedSubject,
      });
      outboundThreadId = outboundThread.id;
      createdThreadId = outboundThread.id;
      await assignDraftThreadId(env, draft.id, outboundThread.id);
    }
    for (const ref of attachmentRefs) {
      const r2Key = typeof ref.r2Key === "string" ? ref.r2Key.trim() : "";
      if (!r2Key) {
        throw new Error("Attachment r2Key is required");
      }

      const owner = await getAttachmentOwnerByR2Key(env, r2Key);
      if (!owner) {
        throw new Error(`Attachment not found: ${r2Key}`);
      }
      if (owner.tenantId !== draft.tenantId) {
        throw new Error("Attachment does not belong to tenant");
      }
      if (owner.mailboxId !== draft.mailboxId) {
        throw new Error("Attachment does not belong to mailbox");
      }
    }

    if (creditRequirement.requiresCredits) {
      const reserved = await reserveTenantAvailableCredits(env, draft.tenantId, creditRequirement.creditsRequired);
      if (!reserved) {
        throw new Error(`Insufficient credits for external sending. Required: ${creditRequirement.creditsRequired}`);
      }
      creditReservationAmount = creditRequirement.creditsRequired;
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
      outboundThreadId,
      "outbound",
      getOutboundProvider(env),
      fromAddress,
      Array.isArray(draftPayload.to) ? draftPayload.to.join(",") : "",
      subject,
      "tasked",
      timestamp
    ));

    const insertOutboundJob = async () => await execute(env.D1_DB.prepare(
      `INSERT INTO outbound_jobs (
         id, message_id, task_id, status, ses_region, retry_count, next_retry_at,
         last_error, draft_r2_key, created_at, updated_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1
         FROM outbound_jobs
         WHERE draft_r2_key = ?
           AND EXISTS (
             SELECT 1
             FROM messages
             WHERE messages.id = outbound_jobs.message_id
               AND EXISTS (
                 SELECT 1
                 FROM mailboxes
                 WHERE mailboxes.id = messages.mailbox_id
                   AND mailboxes.tenant_id = messages.tenant_id
               )
           )
       )`
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
      timestamp,
      draft.draftR2Key,
    ));

    let insertOutboundJobResult = await insertOutboundJob();
    if ((insertOutboundJobResult.meta?.changes ?? 0) === 0) {
      const existingJobs = await listVisibleOutboundJobsByDraftR2Key(env, draft.draftR2Key);
      if (existingJobs.length === 1) {
        throw new Error(`Draft ${draft.id} already has visible outbound job ${existingJobs[0].id}`);
      }
      if (existingJobs.length > 1) {
        throw new Error(`Draft ${draft.id} has multiple visible outbound jobs`);
      }

      const deleted = await deleteInvalidOutboundJobsForDraftR2Key(env, draft.draftR2Key);
      if (deleted > 0) {
        insertOutboundJobResult = await insertOutboundJob();
      }

      if ((insertOutboundJobResult.meta?.changes ?? 0) === 0) {
        const retriedExistingJobs = await listVisibleOutboundJobsByDraftR2Key(env, draft.draftR2Key);
        if (retriedExistingJobs.length === 1) {
          throw new Error(`Draft ${draft.id} already has visible outbound job ${retriedExistingJobs[0].id}`);
        }
        if (retriedExistingJobs.length > 1) {
          throw new Error(`Draft ${draft.id} has multiple visible outbound jobs`);
        }

        throw new Error(
          `Outbound job ${outboundJobId} could not be created because dedupe skipped insertion without any visible existing outbound job for ${draft.draftR2Key}`
        );
      }
    }

    requireRow(
      await getMessage(env, outboundMessageId),
      `Failed to load outbound message ${outboundMessageId}`
    );
    requireRow(
      await getOutboundJob(env, outboundJobId),
      `Failed to load outbound job ${outboundJobId}`
    );

    await env.OUTBOUND_SEND_QUEUE.send({ outboundJobId });
  } catch (error) {
    await execute(env.D1_DB.prepare(
      `DELETE FROM outbound_jobs WHERE id = ?`
      ).bind(outboundJobId)).catch(() => undefined);
    await execute(env.D1_DB.prepare(
      `DELETE FROM messages WHERE id = ?`
    ).bind(outboundMessageId)).catch(() => undefined);
    await restoreDraftSendState(env, {
      draftId,
      status: priorDraftStatus,
      threadId: priorThreadId,
    }).catch(() => undefined);
    if (createdThreadId && createdThreadId !== priorThreadId) {
      await deleteThreadIfUnreferenced(env, createdThreadId).catch(() => undefined);
    }
    if (creditReservationAmount > 0) {
      await releaseTenantReservedCredits(env, draft.tenantId, creditReservationAmount).catch(() => undefined);
    }
    throw error;
  }

  return {
    outboundJobId,
    status: "queued",
  };
}

export async function getTenantOutboundUsageWindowCounts(env: Env, input: {
  tenantId: string;
  sinceHour: string;
  sinceDay: string;
}): Promise<{
  sentLastHour: number;
  sentLastDay: number;
}> {
  const row = await firstRow<TenantOutboundUsageCountsRow>(
    env.D1_DB.prepare(
      `SELECT
         COALESCE(COUNT(DISTINCT CASE WHEN m.created_at >= ? THEN m.id END), 0) AS sent_last_hour,
         COALESCE(COUNT(DISTINCT CASE WHEN m.created_at >= ? THEN m.id END), 0) AS sent_last_day
       FROM messages m
       WHERE m.tenant_id = ?
         AND m.direction = 'outbound'
         AND m.created_at >= ?
         AND EXISTS (
           SELECT 1
           FROM mailboxes
           WHERE mailboxes.id = m.mailbox_id
             AND mailboxes.tenant_id = m.tenant_id
         )
         AND NOT (
           (
             SELECT COUNT(DISTINCT d.id)
             FROM outbound_jobs o
             JOIN drafts d
               ON d.draft_r2_key = o.draft_r2_key
             WHERE o.message_id = m.id
               AND EXISTS (
                 SELECT 1
                 FROM agents
                 WHERE agents.id = d.agent_id
                   AND agents.tenant_id = d.tenant_id
               )
               AND EXISTS (
                 SELECT 1
                 FROM mailboxes
                 WHERE mailboxes.id = d.mailbox_id
                   AND mailboxes.tenant_id = d.tenant_id
               )
           ) = 1
           AND EXISTS (
             SELECT 1
             FROM outbound_jobs o
             JOIN drafts d
               ON d.draft_r2_key = o.draft_r2_key
             WHERE o.message_id = m.id
               AND EXISTS (
                 SELECT 1
                 FROM agents
                 WHERE agents.id = d.agent_id
                   AND agents.tenant_id = d.tenant_id
               )
               AND EXISTS (
                 SELECT 1
                 FROM mailboxes
                 WHERE mailboxes.id = d.mailbox_id
                   AND mailboxes.tenant_id = d.tenant_id
               )
               AND COALESCE(d.created_via, '') LIKE 'system:%'
           )
         )`
    ).bind(
      input.sinceHour,
      input.sinceDay,
      input.tenantId,
      input.sinceDay,
    )
  );

  return {
    sentLastHour: Number(row?.sent_last_hour ?? 0),
    sentLastDay: Number(row?.sent_last_day ?? 0),
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
  const result = await execute(env.D1_DB.prepare(
    `UPDATE idempotency_keys
     SET status = ?, response_json = ?, resource_id = COALESCE(?, resource_id), updated_at = ?
     WHERE operation = ? AND tenant_id = ? AND idempotency_key = ? AND status = ?`
  ).bind(
    "completed",
    JSON.stringify(input.response),
    input.resourceId ?? null,
    nowIso(),
    input.operation,
    input.tenantId,
    input.idempotencyKey,
    "pending"
  ));

  if ((result.meta?.changes ?? 0) === 0) {
    throw new Error(`Idempotency key ${input.operation}/${input.tenantId}/${input.idempotencyKey} is no longer pending`);
  }
}

export async function updateIdempotencyKeyResource(env: Env, input: {
  operation: string;
  tenantId: string;
  idempotencyKey: string;
  resourceId: string;
}): Promise<void> {
  const result = await execute(env.D1_DB.prepare(
    `UPDATE idempotency_keys
     SET resource_id = ?, updated_at = ?
     WHERE operation = ? AND tenant_id = ? AND idempotency_key = ? AND status = ?`
  ).bind(
    input.resourceId,
    nowIso(),
    input.operation,
    input.tenantId,
    input.idempotencyKey,
    "pending"
  ));

  if ((result.meta?.changes ?? 0) === 0) {
    throw new Error(`Idempotency key ${input.operation}/${input.tenantId}/${input.idempotencyKey} is no longer pending`);
  }
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
       WHERE id = ?
         AND EXISTS (
           SELECT 1
           FROM messages
           WHERE messages.id = outbound_jobs.message_id
             AND EXISTS (
               SELECT 1
               FROM mailboxes
               WHERE mailboxes.id = messages.mailbox_id
                 AND mailboxes.tenant_id = messages.tenant_id
             )
         )`
    ).bind(outboundJobId)
  );

  return row ? mapOutboundJobRow(row) : null;
}

export async function getOutboundJobByMessageId(env: Env, messageId: string): Promise<OutboundJobRecord | null> {
  const rows = await listVisibleOutboundJobsByMessageId(env, messageId);
  if (rows.length !== 1) {
    return null;
  }

  return mapOutboundJobRow(rows[0]);
}

export async function getOutboundJobByDraftR2Key(env: Env, draftR2Key: string): Promise<OutboundJobRecord | null> {
  const rows = await listVisibleOutboundJobsByDraftR2Key(env, draftR2Key);
  if (rows.length !== 1) {
    return null;
  }

  return mapOutboundJobRow(rows[0]);
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
  const result = await execute(env.D1_DB.prepare(
    `UPDATE messages
     SET thread_id = ?, normalized_r2_key = ?, subject = ?, snippet = ?, internet_message_id = COALESCE(?, internet_message_id),
         from_addr = COALESCE(?, from_addr),
         status = ?
     WHERE id = ?
       AND EXISTS (
         SELECT 1
         FROM threads
         JOIN mailboxes ON mailboxes.id = threads.mailbox_id
         WHERE threads.id = ?
           AND threads.mailbox_id = messages.mailbox_id
           AND threads.tenant_id = messages.tenant_id
           AND mailboxes.tenant_id = threads.tenant_id
       )`
  ).bind(
    input.threadId,
    input.normalizedR2Key,
    input.subject ?? null,
    input.snippet ?? null,
    input.internetMessageId ?? null,
    input.fromAddr ?? null,
    input.status,
    input.messageId,
    input.threadId,
  ));

  requireStateUpdateApplied(result.meta?.changes, `Inbound message ${input.messageId}`);
}

export async function updateThreadTimestamp(env: Env, threadId: string): Promise<void> {
  const result = await execute(env.D1_DB.prepare(
    `UPDATE threads
     SET last_message_at = ?
     WHERE id = ?
       AND EXISTS (
         SELECT 1
         FROM mailboxes
         WHERE mailboxes.id = threads.mailbox_id
           AND mailboxes.tenant_id = threads.tenant_id
       )`
  ).bind(nowIso(), threadId));

  requireStateUpdateApplied(result.meta?.changes, `Thread ${threadId}`);
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
}): Promise<string[]> {
  if (!(await getMessage(env, input.messageId))) {
    throw new Error(`Message ${input.messageId} no longer exists`);
  }

  const existingRows = await allRows<PersistedAttachmentRow>(
    env.D1_DB.prepare(
      `SELECT id, message_id, filename, content_type, size_bytes, sha256, r2_key, created_at
       FROM attachments
       WHERE message_id = ?
       ORDER BY created_at ASC`
    ).bind(input.messageId)
  );

  await execute(env.D1_DB.prepare(
    `DELETE FROM attachments WHERE message_id = ?`
  ).bind(input.messageId));

  try {
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
  } catch (error) {
    await execute(env.D1_DB.prepare(
      `DELETE FROM attachments WHERE message_id = ?`
    ).bind(input.messageId));

    for (const row of existingRows) {
      await execute(env.D1_DB.prepare(
        `INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, sha256, r2_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        row.id,
        row.message_id,
        row.filename,
        row.content_type,
        row.size_bytes,
        row.sha256,
        row.r2_key,
        row.created_at
      ));
    }

    throw error;
  }

  if (!(await getMessage(env, input.messageId))) {
    await execute(env.D1_DB.prepare(
      `DELETE FROM attachments WHERE message_id = ?`
    ).bind(input.messageId)).catch(() => undefined);
    throw new Error(`Message ${input.messageId} no longer exists`);
  }

  const nextKeys = new Set(input.attachments.map((attachment) => attachment.r2Key));
  return existingRows
    .map((row) => row.r2_key)
    .filter((r2Key) => !nextKeys.has(r2Key));
}

export async function resolveAssignedAgent(env: Env, mailboxId: string): Promise<string | null> {
  const rows = await allRows<{ agent_id: string }>(
    env.D1_DB.prepare(
      `SELECT DISTINCT agent_id
       FROM agent_mailboxes
       WHERE mailbox_id = ? AND status = 'active'
         AND EXISTS (
           SELECT 1
           FROM mailboxes
           JOIN agents ON agents.id = agent_mailboxes.agent_id
           WHERE mailboxes.id = agent_mailboxes.mailbox_id
             AND mailboxes.tenant_id = agent_mailboxes.tenant_id
             AND agents.tenant_id = agent_mailboxes.tenant_id
         )
       ORDER BY created_at ASC
       LIMIT 2`
    ).bind(mailboxId)
  );

  if (rows.length !== 1) {
    return null;
  }

  return rows[0]!.agent_id;
}

async function cleanupTaskIfParentsMissing(env: Env, input: {
  taskId: string;
  tenantId: string;
  mailboxId: string;
  sourceMessageId: string;
  assignedAgent?: string | null;
}): Promise<void> {
  const mailboxExists = await firstRow<{ id: string }>(
    env.D1_DB.prepare(
      `SELECT id
       FROM mailboxes
       WHERE id = ? AND tenant_id = ?
       LIMIT 1`
    ).bind(input.mailboxId, input.tenantId)
  );
  const sourceMessageExists = await firstRow<{ id: string }>(
    env.D1_DB.prepare(
      `SELECT id
       FROM messages
       WHERE id = ? AND tenant_id = ? AND mailbox_id = ?
       LIMIT 1`
    ).bind(input.sourceMessageId, input.tenantId, input.mailboxId)
  );
  const assignedAgentExists = input.assignedAgent
    ? await firstRow<{ id: string }>(
        env.D1_DB.prepare(
          `SELECT id
           FROM agents
           WHERE id = ? AND tenant_id = ?
           LIMIT 1`
        ).bind(input.assignedAgent, input.tenantId)
      )
    : { id: "" };

  if (!mailboxExists || !sourceMessageExists || (input.assignedAgent && !assignedAgentExists)) {
    await deleteTask(env, input.taskId).catch(() => undefined);
    throw new Error(`Task ${input.taskId} could not be finalized because the mailbox, source message, or assigned agent no longer exists`);
  }
}

async function deleteInvalidTasksForSourceMessage(env: Env, input: {
  tenantId: string;
  mailboxId: string;
  sourceMessageId: string;
  taskType: string;
}): Promise<number> {
  const rows = await allRows<{ id: string }>(
    env.D1_DB.prepare(
      `SELECT id
       FROM tasks
       WHERE source_message_id = ? AND task_type = ?
         AND NOT (
           tenant_id = ?
           AND mailbox_id = ?
           AND EXISTS (
             SELECT 1
             FROM mailboxes
             WHERE mailboxes.id = tasks.mailbox_id
               AND mailboxes.tenant_id = tasks.tenant_id
           )
           AND EXISTS (
             SELECT 1
             FROM messages
             WHERE messages.id = tasks.source_message_id
               AND messages.tenant_id = tasks.tenant_id
               AND messages.mailbox_id = tasks.mailbox_id
           )
           AND (
             tasks.assigned_agent IS NULL
             OR EXISTS (
               SELECT 1
               FROM agents
               WHERE agents.id = tasks.assigned_agent
                 AND agents.tenant_id = tasks.tenant_id
             )
           )
         )`
    ).bind(input.sourceMessageId, input.taskType, input.tenantId, input.mailboxId)
  );

  for (const row of rows) {
    await deleteTask(env, row.id).catch(() => undefined);
  }

  return rows.length;
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

  await cleanupTaskIfParentsMissing(env, {
    taskId: id,
    tenantId: input.tenantId,
    mailboxId: input.mailboxId,
    sourceMessageId: input.sourceMessageId,
    assignedAgent: input.assignedAgent,
  });

  const created = await getTask(env, id);
  if (!created) {
    await deleteTask(env, id).catch(() => undefined);
    throw new Error(`Failed to load task ${id}`);
  }

  return created;
}

export async function getOrCreateTaskForSourceMessage(env: Env, input: {
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
  const insertTask = async () => await execute(env.D1_DB.prepare(
    `INSERT INTO tasks (
       id, tenant_id, mailbox_id, source_message_id, task_type, priority, status, assigned_agent, created_at, updated_at
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1
       FROM tasks
       WHERE source_message_id = ? AND task_type = ?
         AND tenant_id = ?
         AND mailbox_id = ?
         AND EXISTS (
           SELECT 1
           FROM mailboxes
           WHERE mailboxes.id = tasks.mailbox_id
             AND mailboxes.tenant_id = tasks.tenant_id
         )
         AND EXISTS (
           SELECT 1
           FROM messages
           WHERE messages.id = tasks.source_message_id
             AND messages.tenant_id = tasks.tenant_id
             AND messages.mailbox_id = tasks.mailbox_id
         )
         AND (
           tasks.assigned_agent IS NULL
           OR EXISTS (
             SELECT 1
             FROM agents
             WHERE agents.id = tasks.assigned_agent
               AND agents.tenant_id = tasks.tenant_id
           )
         )
     )`
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
    timestamp,
    input.sourceMessageId,
    input.taskType,
    input.tenantId,
    input.mailboxId,
  ));
  let result = await insertTask();

  if ((result.meta?.changes ?? 0) > 0) {
    await cleanupTaskIfParentsMissing(env, {
      taskId: id,
      tenantId: input.tenantId,
      mailboxId: input.mailboxId,
      sourceMessageId: input.sourceMessageId,
      assignedAgent: input.assignedAgent,
    });

    return requireRow(
      await getTask(env, id),
      `Failed to load task ${id}`
    );
  }

  let existing = await getTaskBySourceMessageId(env, input.sourceMessageId, input.taskType);
  if (!existing) {
    const deleted = await deleteInvalidTasksForSourceMessage(env, {
      tenantId: input.tenantId,
      mailboxId: input.mailboxId,
      sourceMessageId: input.sourceMessageId,
      taskType: input.taskType,
    });
    if (deleted > 0) {
      result = await insertTask();
      if ((result.meta?.changes ?? 0) > 0) {
        await cleanupTaskIfParentsMissing(env, {
          taskId: id,
          tenantId: input.tenantId,
          mailboxId: input.mailboxId,
          sourceMessageId: input.sourceMessageId,
          assignedAgent: input.assignedAgent,
        });

        const created = await getTask(env, id);
        if (!created) {
          await deleteTask(env, id).catch(() => undefined);
          throw new Error(`Failed to load task ${id}`);
        }

        return created;
      }

      existing = await getTaskBySourceMessageId(env, input.sourceMessageId, input.taskType);
    }
  }

  const existingTask = requireRow(
    existing,
    "Task lookup failed after duplicate source-message insert"
  );

  if (existingTask.status !== "failed") {
    return existingTask;
  }

  const resetResult = await execute(env.D1_DB.prepare(
    `UPDATE tasks
     SET priority = ?, status = ?, assigned_agent = ?, result_r2_key = NULL, updated_at = ?
     WHERE id = ?
       AND EXISTS (
         SELECT 1
         FROM mailboxes
         WHERE mailboxes.id = tasks.mailbox_id
           AND mailboxes.tenant_id = tasks.tenant_id
       )
       AND EXISTS (
         SELECT 1
         FROM messages
         WHERE messages.id = tasks.source_message_id
           AND messages.tenant_id = tasks.tenant_id
           AND messages.mailbox_id = tasks.mailbox_id
       )
       AND (
         tasks.assigned_agent IS NULL
         OR EXISTS (
           SELECT 1
           FROM agents
           WHERE agents.id = tasks.assigned_agent
             AND agents.tenant_id = tasks.tenant_id
         )
       )`
  ).bind(
    input.priority,
    input.status,
    input.assignedAgent ?? null,
    timestamp,
    existingTask.id
  ));

  requireStateUpdateApplied(resetResult.meta?.changes, `Task ${existingTask.id}`);

  return requireRow(
    await getTask(env, existingTask.id),
    `Failed to load task ${existingTask.id}`
  );
}

export async function getTaskBySourceMessageId(env: Env, sourceMessageId: string, taskType: string): Promise<TaskRecord | null> {
  const rows = await allRows<TaskRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, mailbox_id, source_message_id, task_type, priority, status,
              assigned_agent, result_r2_key, created_at, updated_at
       FROM tasks
       WHERE source_message_id = ? AND task_type = ?
         AND EXISTS (
           SELECT 1
           FROM mailboxes
           WHERE mailboxes.id = tasks.mailbox_id
             AND mailboxes.tenant_id = tasks.tenant_id
         )
         AND EXISTS (
           SELECT 1
           FROM messages
           WHERE messages.id = tasks.source_message_id
             AND messages.tenant_id = tasks.tenant_id
             AND messages.mailbox_id = tasks.mailbox_id
         )
         AND (
           tasks.assigned_agent IS NULL
           OR EXISTS (
             SELECT 1
             FROM agents
           WHERE agents.id = tasks.assigned_agent
               AND agents.tenant_id = tasks.tenant_id
           )
         )
       ORDER BY created_at DESC
       LIMIT 2`
    ).bind(sourceMessageId, taskType)
  );

  if (rows.length !== 1) {
    return null;
  }

  return mapTaskRow(rows[0]);
}

export async function getTask(env: Env, taskId: string): Promise<TaskRecord | null> {
  const row = await firstRow<TaskRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, mailbox_id, source_message_id, task_type, priority, status,
              assigned_agent, result_r2_key, created_at, updated_at
       FROM tasks
       WHERE id = ?
         AND EXISTS (
           SELECT 1
           FROM mailboxes
           WHERE mailboxes.id = tasks.mailbox_id
             AND mailboxes.tenant_id = tasks.tenant_id
         )
         AND EXISTS (
           SELECT 1
           FROM messages
           WHERE messages.id = tasks.source_message_id
             AND messages.tenant_id = tasks.tenant_id
             AND messages.mailbox_id = tasks.mailbox_id
         )
         AND (
           tasks.assigned_agent IS NULL
           OR EXISTS (
             SELECT 1
             FROM agents
             WHERE agents.id = tasks.assigned_agent
               AND agents.tenant_id = tasks.tenant_id
           )
         )
       LIMIT 1`
    ).bind(taskId)
  );

  return row ? mapTaskRow(row) : null;
}

export async function deleteTask(env: Env, taskId: string): Promise<void> {
  await execute(env.D1_DB.prepare(
    `DELETE FROM tasks WHERE id = ?`
  ).bind(taskId));
}

export async function claimTaskForExecution(env: Env, taskId: string): Promise<boolean> {
  const result = await execute(env.D1_DB.prepare(
    `UPDATE tasks
     SET status = ?, updated_at = ?
     WHERE id = ? AND status = ?
       AND EXISTS (
         SELECT 1
         FROM mailboxes
         WHERE mailboxes.id = tasks.mailbox_id
           AND mailboxes.tenant_id = tasks.tenant_id
       )
       AND EXISTS (
         SELECT 1
         FROM messages
         WHERE messages.id = tasks.source_message_id
           AND messages.tenant_id = tasks.tenant_id
           AND messages.mailbox_id = tasks.mailbox_id
       )
       AND (
         tasks.assigned_agent IS NULL
         OR EXISTS (
           SELECT 1
           FROM agents
           WHERE agents.id = tasks.assigned_agent
             AND agents.tenant_id = tasks.tenant_id
         )
       )`
  ).bind(
    "running",
    nowIso(),
    taskId,
    "queued"
  ));

  if ((result.meta?.changes ?? 0) === 0) {
    return false;
  }

  if (!(await getTask(env, taskId))) {
    await deleteTask(env, taskId).catch(() => undefined);
    return false;
  }

  return true;
}

export async function updateTaskAssignment(env: Env, input: {
  taskId: string;
  assignedAgent?: string | null;
}): Promise<void> {
  const result = await execute(env.D1_DB.prepare(
    `UPDATE tasks
     SET assigned_agent = ?, updated_at = ?
     WHERE id = ?
       AND EXISTS (
         SELECT 1
         FROM mailboxes
         WHERE mailboxes.id = tasks.mailbox_id
           AND mailboxes.tenant_id = tasks.tenant_id
       )
       AND EXISTS (
         SELECT 1
         FROM messages
         WHERE messages.id = tasks.source_message_id
           AND messages.tenant_id = tasks.tenant_id
           AND messages.mailbox_id = tasks.mailbox_id
       )
       AND (
         tasks.assigned_agent IS NULL
         OR EXISTS (
           SELECT 1
           FROM agents
           WHERE agents.id = tasks.assigned_agent
             AND agents.tenant_id = tasks.tenant_id
         )
       )`
  ).bind(
    input.assignedAgent ?? null,
    nowIso(),
    input.taskId,
  ));

  requireStateUpdateApplied(result.meta?.changes, `Task ${input.taskId}`);
}

export async function updateTaskStatus(env: Env, input: {
  taskId: string;
  status: TaskRecord["status"];
  resultR2Key?: string | null;
}): Promise<void> {
  const hasResultR2Key = input.resultR2Key !== undefined;
  const result = await execute(env.D1_DB.prepare(
    `UPDATE tasks
     SET status = ?,
         result_r2_key = CASE WHEN ? THEN ? ELSE result_r2_key END,
         updated_at = ?
     WHERE id = ?
       AND EXISTS (
         SELECT 1
         FROM mailboxes
         WHERE mailboxes.id = tasks.mailbox_id
           AND mailboxes.tenant_id = tasks.tenant_id
       )
       AND EXISTS (
         SELECT 1
         FROM messages
         WHERE messages.id = tasks.source_message_id
           AND messages.tenant_id = tasks.tenant_id
           AND messages.mailbox_id = tasks.mailbox_id
       )
       AND (
         tasks.assigned_agent IS NULL
         OR EXISTS (
           SELECT 1
           FROM agents
           WHERE agents.id = tasks.assigned_agent
             AND agents.tenant_id = tasks.tenant_id
         )
       )`
  ).bind(
    input.status,
    hasResultR2Key ? 1 : 0,
    input.resultR2Key ?? null,
    nowIso(),
    input.taskId
  ));

  requireStateUpdateApplied(result.meta?.changes, `Task ${input.taskId}`);
}

async function hasVisibleDeliveryEventForPayloadR2Key(env: Env, payloadR2Key: string): Promise<boolean> {
  const row = await firstRow<{ id: string }>(
    env.D1_DB.prepare(
      `SELECT id
       FROM delivery_events
       WHERE payload_r2_key = ?
         AND (
           message_id IS NULL
           OR EXISTS (
             SELECT 1
             FROM messages
             WHERE messages.id = delivery_events.message_id
               AND EXISTS (
                 SELECT 1
                 FROM mailboxes
                 WHERE mailboxes.id = messages.mailbox_id
                   AND mailboxes.tenant_id = messages.tenant_id
               )
           )
         )
       LIMIT 1`
    ).bind(payloadR2Key)
  );

  return Boolean(row);
}

async function deleteInvalidDeliveryEventsForPayloadR2Key(env: Env, payloadR2Key: string): Promise<number> {
  const rows = await allRows<{ id: string }>(
    env.D1_DB.prepare(
      `SELECT id
       FROM delivery_events
       WHERE payload_r2_key = ?
         AND message_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM messages
           WHERE messages.id = delivery_events.message_id
             AND EXISTS (
               SELECT 1
               FROM mailboxes
               WHERE mailboxes.id = messages.mailbox_id
                 AND mailboxes.tenant_id = messages.tenant_id
             )
         )`
    ).bind(payloadR2Key)
  );

  for (const row of rows) {
    await execute(env.D1_DB.prepare(
      `DELETE FROM delivery_events WHERE id = ?`
    ).bind(row.id)).catch(() => undefined);
  }

  return rows.length;
}

export async function insertDeliveryEvent(env: Env, input: {
  messageId?: string;
  providerMessageId?: string;
  eventType: DeliveryEventType;
  payloadR2Key: string;
}): Promise<boolean> {
  const insertEvent = async () => await execute(env.D1_DB.prepare(
    `INSERT INTO delivery_events (id, message_id, provider, provider_message_id, event_type, payload_r2_key, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1
       FROM delivery_events
       WHERE payload_r2_key = ?
         AND (
           message_id IS NULL
           OR EXISTS (
             SELECT 1
             FROM messages
             WHERE messages.id = delivery_events.message_id
               AND EXISTS (
                 SELECT 1
                 FROM mailboxes
                 WHERE mailboxes.id = messages.mailbox_id
                   AND mailboxes.tenant_id = messages.tenant_id
               )
           )
         )
     )`
  ).bind(
    createId("evt"),
    input.messageId ?? null,
    "ses",
    input.providerMessageId ?? null,
    input.eventType,
    input.payloadR2Key,
    nowIso(),
    input.payloadR2Key,
  ));
  let result = await insertEvent();

  if ((result.meta?.changes ?? 0) === 0) {
    if (await hasVisibleDeliveryEventForPayloadR2Key(env, input.payloadR2Key)) {
      return false;
    }

    const deleted = await deleteInvalidDeliveryEventsForPayloadR2Key(env, input.payloadR2Key);
    if (deleted > 0) {
      result = await insertEvent();
      if ((result.meta?.changes ?? 0) > 0) {
        return true;
      }

      if (await hasVisibleDeliveryEventForPayloadR2Key(env, input.payloadR2Key)) {
        return false;
      }
    }

    throw new Error(
      `Delivery event could not be inserted because payload dedupe skipped insertion without any visible existing event for ${input.payloadR2Key}`
    );
  }

  return true;
}

export async function getMessageByProviderMessageId(env: Env, providerMessageId: string): Promise<MessageRecord | null> {
  const rows = await listVisibleMessagesByProviderMessageId(env, providerMessageId);
  if (rows.length !== 1) {
    return null;
  }

  return mapMessageRow(rows[0]);
}

export async function listDeliveryEventsByMessageId(env: Env, messageId: string) {
  const rows = await allRows<DeliveryEventRow>(
    env.D1_DB.prepare(
      `SELECT id, message_id, provider, provider_message_id, event_type, payload_r2_key, created_at
       FROM delivery_events
       WHERE message_id = ?
         AND EXISTS (
           SELECT 1
           FROM messages
           WHERE messages.id = delivery_events.message_id
             AND EXISTS (
               SELECT 1
               FROM mailboxes
               WHERE mailboxes.id = messages.mailbox_id
                 AND mailboxes.tenant_id = messages.tenant_id
             )
         )
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
  const rows = await listVisibleMessagesByProviderMessageId(env, providerMessageId);
  if (rows.length !== 1) {
    return;
  }

  await execute(env.D1_DB.prepare(
    `UPDATE messages
     SET status = ?
     WHERE id = ?
       AND EXISTS (
         SELECT 1
         FROM mailboxes
         WHERE mailboxes.id = messages.mailbox_id
           AND mailboxes.tenant_id = messages.tenant_id
       )`
  ).bind(status, rows[0].id));
}

function requireStateUpdateApplied(changes: number | undefined, target: string): void {
  if ((changes ?? 0) === 0) {
    throw new Error(`${target} no longer exists`);
  }
}

export async function backfillMessageProviderAcceptance(env: Env, input: {
  messageId: string;
  providerMessageId: string;
}): Promise<void> {
  const timestamp = nowIso();
  const result = await execute(env.D1_DB.prepare(
    `UPDATE messages
     SET provider_message_id = COALESCE(provider_message_id, ?),
         sent_at = COALESCE(sent_at, ?)
     WHERE id = ?
       AND EXISTS (
         SELECT 1
         FROM mailboxes
         WHERE mailboxes.id = messages.mailbox_id
           AND mailboxes.tenant_id = messages.tenant_id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM messages conflict
         WHERE conflict.provider_message_id = ?
           AND conflict.id <> messages.id
           AND EXISTS (
             SELECT 1
             FROM mailboxes
             WHERE mailboxes.id = conflict.mailbox_id
               AND mailboxes.tenant_id = conflict.tenant_id
           )
       )`
  ).bind(
    input.providerMessageId,
    timestamp,
    input.messageId,
    input.providerMessageId,
  ));

  if ((result.meta?.changes ?? 0) === 0) {
    const conflict = await getVisibleProviderMessageIdConflict(env, input.providerMessageId, input.messageId);
    if (conflict) {
      throw new Error(
        `Provider message id ${input.providerMessageId} is already associated with visible message ${conflict.id}`
      );
    }

    requireStateUpdateApplied(result.meta?.changes, `Message ${input.messageId}`);
  }
}

export async function updateMessageStatus(env: Env, messageId: string, status: MessageRecord["status"]): Promise<void> {
  const result = await execute(env.D1_DB.prepare(
    `UPDATE messages
     SET status = ?
     WHERE id = ?
       AND EXISTS (
         SELECT 1
         FROM mailboxes
         WHERE mailboxes.id = messages.mailbox_id
           AND mailboxes.tenant_id = messages.tenant_id
       )`
  ).bind(status, messageId));

  requireStateUpdateApplied(result.meta?.changes, `Message ${messageId}`);
}

export async function addSuppression(env: Env, email: string, reason: string, source = "ses"): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();
  const timestamp = nowIso();
  const updateExisting = async () => {
    const existing = await firstRow<{ email: string }>(
      env.D1_DB.prepare(
        `SELECT email
         FROM suppressions
         WHERE lower(email) = ?
         LIMIT 1`
      ).bind(normalizedEmail)
    );

    if (!existing) {
      return false;
    }

    const result = await execute(env.D1_DB.prepare(
      `UPDATE suppressions
       SET reason = ?, source = ?, created_at = ?
       WHERE email = ?`
    ).bind(reason, source, timestamp, existing.email));
    return (result.meta?.changes ?? 0) > 0;
  };

  if (await updateExisting()) {
    return;
  }

  try {
    await execute(env.D1_DB.prepare(
      `INSERT INTO suppressions (email, reason, source, created_at)
       VALUES (?, ?, ?, ?)`
    ).bind(normalizedEmail, reason, source, timestamp));
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    if (!(await updateExisting())) {
      throw error;
    }
  }
}

export async function updateOutboundJobStatus(env: Env, input: {
  outboundJobId: string;
  status: OutboundJobRecord["status"];
  retryCount?: number;
  nextRetryAt?: string | null;
  lastError?: string | null;
}): Promise<void> {
  const result = await execute(env.D1_DB.prepare(
    `UPDATE outbound_jobs
     SET status = ?, retry_count = COALESCE(?, retry_count), next_retry_at = ?, last_error = ?, updated_at = ?
     WHERE id = ?
       AND EXISTS (
         SELECT 1
         FROM messages
         WHERE messages.id = outbound_jobs.message_id
           AND EXISTS (
             SELECT 1
             FROM mailboxes
             WHERE mailboxes.id = messages.mailbox_id
               AND mailboxes.tenant_id = messages.tenant_id
           )
       )`
  ).bind(
    input.status,
    input.retryCount ?? null,
    input.nextRetryAt ?? null,
    input.lastError ?? null,
    nowIso(),
    input.outboundJobId
  ));

  requireStateUpdateApplied(result.meta?.changes, `Outbound job ${input.outboundJobId}`);
}

export async function claimOutboundJobForSend(env: Env, outboundJobId: string): Promise<boolean> {
  const result = await execute(env.D1_DB.prepare(
    `UPDATE outbound_jobs
     SET status = ?, last_error = NULL, updated_at = ?
     WHERE id = ? AND status IN (?, ?)
       AND EXISTS (
         SELECT 1
         FROM messages
         WHERE messages.id = outbound_jobs.message_id
           AND EXISTS (
             SELECT 1
             FROM mailboxes
             WHERE mailboxes.id = messages.mailbox_id
               AND mailboxes.tenant_id = messages.tenant_id
           )
       )`
  ).bind(
    "sending",
    nowIso(),
    outboundJobId,
    "queued",
    "retry",
  ));

  if ((result.meta?.changes ?? 0) === 0) {
    return false;
  }

  if (!(await getOutboundJob(env, outboundJobId))) {
    await execute(env.D1_DB.prepare(
      `DELETE FROM outbound_jobs WHERE id = ?`
    ).bind(outboundJobId)).catch(() => undefined);
    return false;
  }

  return true;
}

export async function markDraftStatus(env: Env, draftId: string, status: DraftRecord["status"]): Promise<void> {
  const result = await execute(env.D1_DB.prepare(
    `UPDATE drafts
     SET status = ?, updated_at = ?
     WHERE id = ?
       AND EXISTS (
         SELECT 1
         FROM agents
         WHERE agents.id = drafts.agent_id
           AND agents.tenant_id = drafts.tenant_id
       )
       AND EXISTS (
         SELECT 1
         FROM mailboxes
         WHERE mailboxes.id = drafts.mailbox_id
           AND mailboxes.tenant_id = drafts.tenant_id
       )`
  ).bind(status, nowIso(), draftId));

  requireStateUpdateApplied(result.meta?.changes, `Draft ${draftId}`);
}

export async function markMessageSent(env: Env, input: {
  messageId: string;
  providerMessageId: string;
  status: MessageRecord["status"];
}): Promise<void> {
  const timestamp = nowIso();
  const result = await execute(env.D1_DB.prepare(
    `UPDATE messages
     SET provider_message_id = ?, status = ?, sent_at = ?, created_at = created_at
     WHERE id = ?
       AND EXISTS (
         SELECT 1
         FROM mailboxes
         WHERE mailboxes.id = messages.mailbox_id
           AND mailboxes.tenant_id = messages.tenant_id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM messages conflict
         WHERE conflict.provider_message_id = ?
           AND conflict.id <> messages.id
           AND EXISTS (
             SELECT 1
             FROM mailboxes
             WHERE mailboxes.id = conflict.mailbox_id
               AND mailboxes.tenant_id = conflict.tenant_id
           )
       )`
  ).bind(
    input.providerMessageId,
    input.status,
    timestamp,
    input.messageId,
    input.providerMessageId,
  ));

  if ((result.meta?.changes ?? 0) === 0) {
    const conflict = await getVisibleProviderMessageIdConflict(env, input.providerMessageId, input.messageId);
    if (conflict) {
      throw new Error(
        `Provider message id ${input.providerMessageId} is already associated with visible message ${conflict.id}`
      );
    }

    requireStateUpdateApplied(result.meta?.changes, `Message ${input.messageId}`);
  }
}
