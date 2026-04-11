import { requireAdminRoutesEnabled } from "../lib/auth";
import {
  CONTACT_ALIAS_LOCALPARTS,
  CONTACT_ALIAS_TENANT_ID,
  getContactAliasAddress,
  shouldBootstrapContactAliasRouting,
} from "../lib/contact-aliases";
import {
  deleteEmailRoutingRule,
  listEmailRoutingRules,
  requireCloudflareEmailConfig,
  upsertWorkerRule,
} from "../lib/cloudflare-email";
import {
  DraftSendValidationError,
  ensureDraftSendAllowed,
  reserveDraftSendCredits,
} from "../lib/draft-send-guards";
import { checkOutboundCreditRequirement } from "../lib/outbound-credits";
import { evaluateOutboundPolicy } from "../lib/outbound-policy";
import { allRows, firstRow } from "../lib/db";
import { releaseOutboundUsageReservation, settleOutboundUsageDebit } from "../lib/outbound-billing";
import { badRequest, InvalidJsonBodyError, json, readJson } from "../lib/http";
import { Router } from "../lib/router";
import { buildRuntimeMetadata } from "../lib/runtime-metadata";
import { escapeHtml } from "../lib/self-serve";
import { runIdempotencyCleanupNow } from "../handlers/scheduled";
import {
  deleteMailboxIfUnreferenced,
  ensureMailboxWithStatus,
  getMailboxByAddress,
  getMailboxById,
  MailboxConflictError,
  listMailboxes,
  updateMailboxStatus,
} from "../repositories/agents";
import {
  completeIdempotencyKey,
  createDraft,
  enqueueDraftSend,
  getDraft,
  getDraftByR2KeyForOutboundLifecycle,
  getMessage,
  getMessageContent,
  getOutboundJob,
  getOutboundJobByMessageId,
  getThread,
  listIdempotencyRecords,
  listDeliveryEventsByMessageId,
  listDrafts,
  listMessages,
  listOutboundJobs,
  markDraftStatus,
  releaseIdempotencyKey,
  reserveIdempotencyKey,
  updateIdempotencyKeyResource,
  updateMessageStatus,
  updateOutboundJobStatus,
} from "../repositories/mail";
import type { Env } from "../types";

const site = new Router<Env>();
const CHANGELOG_REDIRECT_URL = "https://raw.githubusercontent.com/haocn-ops/mailagents-email-runtime/main/CHANGELOG.md";
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Mailagents">
  <rect width="64" height="64" rx="16" fill="#22493d" />
  <path d="M14 45V19h8l10 13 10-13h8v26h-7V29L32 41 21 29v16z" fill="#f6f0e7" />
</svg>`;
const SITE_ADMIN_SESSION_COOKIE = "mailagents_admin_session";
const SITE_ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const textEncoder = new TextEncoder();

class SiteRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SiteRequestError";
    this.status = status;
  }
}

interface AdminCountRow {
  count: number | string | null;
}

interface AdminTenantSummaryRow {
  registered_users: number | string | null;
  latest_registration_at: string | null;
}

interface AdminMailboxSummaryRow {
  user_mailboxes: number | string | null;
  active_mailboxes: number | string | null;
}

interface AdminMessageSummaryRow {
  inbound_messages: number | string | null;
  outbound_messages: number | string | null;
  latest_inbound_at: string | null;
  latest_outbound_at: string | null;
}

interface AdminOutboundSummaryRow {
  queued_jobs: number | string | null;
  sending_jobs: number | string | null;
  retry_jobs: number | string | null;
  sent_jobs: number | string | null;
  failed_jobs: number | string | null;
}

interface AdminDeliverySummaryRow {
  delivered_events: number | string | null;
  unsuccessful_events: number | string | null;
  bounce_events: number | string | null;
  complaint_events: number | string | null;
  reject_events: number | string | null;
  latest_delivery_at: string | null;
}

interface AdminDraftSummaryRow {
  pending_drafts: number | string | null;
}

interface AdminStatusCountRow {
  status: string | null;
  count: number | string | null;
}

interface AdminRegistrationTrendRow {
  day: string | null;
  count: number | string | null;
}

interface AdminMessageTrendRow {
  day: string | null;
  inbound_count: number | string | null;
  outbound_count: number | string | null;
}

interface AdminOutboundTrendRow {
  day: string | null;
  sent_count: number | string | null;
  failed_count: number | string | null;
}

interface AdminTopMailboxRow {
  address: string | null;
  total_messages: number | string | null;
  inbound_messages: number | string | null;
  outbound_messages: number | string | null;
}

interface AdminRecentFailureRow {
  id: string;
  message_id: string | null;
  last_error: string | null;
  updated_at: string | null;
}

interface AdminRecentActivityRow {
  id: string;
  mailbox_id: string | null;
  mailbox_address: string | null;
  direction: string | null;
  to_addr: string | null;
  from_addr: string | null;
  subject: string | null;
  message_status: string | null;
  outbound_status: string | null;
  delivery_event: string | null;
  occurred_at: string | null;
}

interface AdminOverviewSnapshot {
  generatedAt: string;
  domain: string | null;
  counts: {
    registeredUsers: number;
    newUsers7d: number;
    userMailboxes: number;
    activeMailboxes: number;
    contactMailboxes: number;
    inboundMessages: number;
    outboundMessages: number;
    sentJobs: number;
    failedJobs: number;
    queuedJobs: number;
    sendingJobs: number;
    retryJobs: number;
    pendingQueue: number;
    pendingDrafts: number;
    pendingIdempotency: number;
    deliveredEvents: number;
    unsuccessfulEvents: number;
    bounceEvents: number;
    complaintEvents: number;
    rejectEvents: number;
  };
  rates: {
    sendSuccessRate: number | null;
    deliverySuccessRate: number | null;
  };
  latest: {
    registrationAt: string | null;
    inboundAt: string | null;
    outboundAt: string | null;
    deliveryAt: string | null;
  };
  distributions: {
    messageStatuses: Array<{ key: string; label: string; count: number }>;
    outboundStatuses: Array<{ key: string; label: string; count: number }>;
    deliveryEvents: Array<{ key: string; label: string; count: number }>;
  };
  trend: Array<{
    date: string;
    registrations: number;
    inbound: number;
    outbound: number;
    sent: number;
    failed: number;
  }>;
  topMailboxes: Array<{
    address: string;
    totalMessages: number;
    inboundMessages: number;
    outboundMessages: number;
  }>;
  recentFailures: Array<{
    id: string;
    messageId: string | null;
    lastError: string | null;
    updatedAt: string | null;
  }>;
  recentActivity: Array<{
    id: string;
    mailboxId: string | null;
    mailboxAddress: string | null;
    direction: string | null;
    toAddr: string | null;
    fromAddr: string | null;
    subject: string | null;
    messageStatus: string | null;
    outboundStatus: string | null;
    deliveryEvent: string | null;
    occurredAt: string | null;
  }>;
}

type AdminRuntimeMetadata = ReturnType<typeof buildRuntimeMetadata>;

interface AdminAliasSummary {
  address: string;
  configured: boolean;
  mode: "internal" | "forward" | null;
  destination: string | null;
  worker: string | null;
}

interface AdminPageBootstrap {
  overviewSnapshot: AdminOverviewSnapshot | null;
  runtimeMetadata: AdminRuntimeMetadata | null;
  aliases: AdminAliasSummary[];
  aliasAdminAvailable: boolean;
  aliasAdminMessage: string | null;
}

function isManagedAliasMailboxHealthy(
  mailbox: Awaited<ReturnType<typeof getMailboxByAddress>>
): boolean {
  return mailbox?.tenant_id === CONTACT_ALIAS_TENANT_ID && mailbox.status === "active";
}

function isManagedAliasWorkerRuleHealthy(
  env: Env,
  alias: string,
  rule: Awaited<ReturnType<typeof listEmailRoutingRules>>[number] | undefined
): boolean {
  if (!rule?.enabled) {
    return false;
  }

  const workerAction = rule.actions.find((action) => action.type === "worker");
  return rule.matchers.some((matcher) =>
    matcher.type === "literal"
    && matcher.field === "to"
    && matcher.value === getContactAliasAddress(env, alias)
  ) && Boolean(workerAction?.value?.includes(env.CLOUDFLARE_EMAIL_WORKER ?? ""));
}

function isMissingTableError(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

function toCount(value: unknown): number {
  const numericValue = Number(value ?? 0);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

function toOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function bestEffortCompleteRecoveredIdempotency(env: Env, input: {
  operation: string;
  tenantId: string;
  idempotencyKey: string;
  resourceId?: string;
  response: unknown;
}): Promise<void> {
  try {
    await completeIdempotencyKey(env, input);
  } catch {
    // Recovery should still succeed even if the pending idempotency row cannot be repaired inline.
  }
}

async function optionalFirstRow<T>(statement: D1PreparedStatement): Promise<T | null> {
  try {
    return await firstRow<T>(statement);
  } catch (error) {
    if (isMissingTableError(error)) {
      return null;
    }
    throw error;
  }
}

async function optionalAllRows<T>(statement: D1PreparedStatement): Promise<T[]> {
  try {
    return await allRows<T>(statement);
  } catch (error) {
    if (isMissingTableError(error)) {
      return [];
    }
    throw error;
  }
}

function buildManagedAliasAddresses(env: Env): string[] {
  const domain = (env.CLOUDFLARE_EMAIL_DOMAIN ?? "mailagents.net").toLowerCase();
  return CONTACT_ALIAS_LOCALPARTS.map((alias) => `${alias}@${domain}`);
}

function buildMailboxAddressWhereClause(column: string, addresses: string[], negate = false): { clause: string; bindings: string[] } {
  if (!addresses.length) {
    return {
      clause: negate ? "" : "WHERE 1 = 0",
      bindings: [],
    };
  }

  return {
    clause: `WHERE LOWER(${column}) ${negate ? "NOT IN" : "IN"} (${addresses.map(() => "?").join(", ")})`,
    bindings: addresses.map((address) => address.toLowerCase()),
  };
}

function buildRecentUtcDays(totalDays: number): string[] {
  const days: string[] = [];
  const now = new Date();
  const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  for (let offset = totalDays - 1; offset >= 0; offset -= 1) {
    const day = new Date(anchor);
    day.setUTCDate(anchor.getUTCDate() - offset);
    days.push(day.toISOString().slice(0, 10));
  }

  return days;
}

function normalizeStatusCounts(rows: AdminStatusCountRow[], preferredOrder: readonly string[]): Array<{ key: string; label: string; count: number }> {
  const countsByKey = new Map<string, number>();
  for (const row of rows) {
    if (!row.status) {
      continue;
    }
    countsByKey.set(row.status, toCount(row.count));
  }

  const orderedKeys = [
    ...preferredOrder.filter((key) => countsByKey.has(key)),
    ...Array.from(countsByKey.keys()).filter((key) => !preferredOrder.includes(key)).sort(),
  ];

  return orderedKeys.map((key) => ({
    key,
    label: key,
    count: countsByKey.get(key) ?? 0,
  }));
}

async function getAdminOverviewSnapshot(env: Env): Promise<AdminOverviewSnapshot> {
  const managedAliasAddresses = buildManagedAliasAddresses(env);
  const userMailboxScope = buildMailboxAddressWhereClause("address", managedAliasAddresses, true);
  const aliasMailboxScope = buildMailboxAddressWhereClause("address", managedAliasAddresses, false);
  const recentDays = buildRecentUtcDays(7);
  const trendFloor = recentDays[0];

  const tenantSummaryRow = await optionalFirstRow<AdminTenantSummaryRow>(
    env.D1_DB.prepare(
      `SELECT COUNT(*) AS registered_users,
              MAX(first_created_at) AS latest_registration_at
       FROM (
         SELECT tenant_id, MIN(created_at) AS first_created_at
         FROM mailboxes
         ${userMailboxScope.clause}
         GROUP BY tenant_id
       )`
    ).bind(...userMailboxScope.bindings)
  );

  const newUsersRow = await optionalFirstRow<AdminCountRow>(
    env.D1_DB.prepare(
      `SELECT COUNT(*) AS count
       FROM (
         SELECT tenant_id, MIN(created_at) AS first_created_at
         FROM mailboxes
         ${userMailboxScope.clause}
         GROUP BY tenant_id
       )
       WHERE first_created_at >= ?`
    ).bind(...userMailboxScope.bindings, trendFloor)
  );

  const userMailboxRow = await optionalFirstRow<AdminMailboxSummaryRow>(
    env.D1_DB.prepare(
      `SELECT COUNT(*) AS user_mailboxes,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_mailboxes
       FROM mailboxes
       ${userMailboxScope.clause}`
    ).bind(...userMailboxScope.bindings)
  );

  const contactMailboxRow = await optionalFirstRow<AdminCountRow>(
    env.D1_DB.prepare(
      `SELECT COUNT(*) AS count
       FROM mailboxes
       ${aliasMailboxScope.clause}`
    ).bind(...aliasMailboxScope.bindings)
  );

  const messageSummaryRow = await optionalFirstRow<AdminMessageSummaryRow>(
    env.D1_DB.prepare(
      `SELECT SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) AS inbound_messages,
              SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS outbound_messages,
              MAX(CASE WHEN direction = 'inbound' THEN COALESCE(received_at, created_at) END) AS latest_inbound_at,
              MAX(CASE WHEN direction = 'outbound' THEN COALESCE(sent_at, created_at) END) AS latest_outbound_at
       FROM messages`
    )
  );

  const outboundSummaryRow = await optionalFirstRow<AdminOutboundSummaryRow>(
    env.D1_DB.prepare(
      `SELECT SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued_jobs,
              SUM(CASE WHEN status = 'sending' THEN 1 ELSE 0 END) AS sending_jobs,
              SUM(CASE WHEN status = 'retry' THEN 1 ELSE 0 END) AS retry_jobs,
              SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent_jobs,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_jobs
       FROM outbound_jobs`
    )
  );

  const deliverySummaryRow = await optionalFirstRow<AdminDeliverySummaryRow>(
    env.D1_DB.prepare(
      `SELECT SUM(CASE WHEN event_type = 'delivery' THEN 1 ELSE 0 END) AS delivered_events,
              SUM(CASE WHEN event_type IN ('bounce', 'complaint', 'reject') THEN 1 ELSE 0 END) AS unsuccessful_events,
              SUM(CASE WHEN event_type = 'bounce' THEN 1 ELSE 0 END) AS bounce_events,
              SUM(CASE WHEN event_type = 'complaint' THEN 1 ELSE 0 END) AS complaint_events,
              SUM(CASE WHEN event_type = 'reject' THEN 1 ELSE 0 END) AS reject_events,
              MAX(created_at) AS latest_delivery_at
       FROM delivery_events`
    )
  );

  const draftSummaryRow = await optionalFirstRow<AdminDraftSummaryRow>(
    env.D1_DB.prepare(
      `SELECT SUM(CASE WHEN status IN ('draft', 'approved', 'queued') THEN 1 ELSE 0 END) AS pending_drafts
       FROM drafts`
    )
  );

  const pendingIdempotencyRow = await optionalFirstRow<AdminCountRow>(
    env.D1_DB.prepare(
      `SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS count
       FROM idempotency_keys`
    )
  );

  const messageStatusRows = await optionalAllRows<AdminStatusCountRow>(
    env.D1_DB.prepare(
      `SELECT status, COUNT(*) AS count
       FROM messages
       GROUP BY status`
    )
  );

  const outboundStatusRows = await optionalAllRows<AdminStatusCountRow>(
    env.D1_DB.prepare(
      `SELECT status, COUNT(*) AS count
       FROM outbound_jobs
       GROUP BY status`
    )
  );

  const deliveryEventRows = await optionalAllRows<AdminStatusCountRow>(
    env.D1_DB.prepare(
      `SELECT event_type AS status, COUNT(*) AS count
       FROM delivery_events
       GROUP BY event_type`
    )
  );

  const registrationTrendRows = await optionalAllRows<AdminRegistrationTrendRow>(
    env.D1_DB.prepare(
      `SELECT day, COUNT(*) AS count
       FROM (
         SELECT tenant_id, SUBSTR(MIN(created_at), 1, 10) AS day
         FROM mailboxes
         ${userMailboxScope.clause}
         GROUP BY tenant_id
       )
       WHERE day >= ?
       GROUP BY day
       ORDER BY day ASC`
    ).bind(...userMailboxScope.bindings, trendFloor)
  );

  const messageTrendRows = await optionalAllRows<AdminMessageTrendRow>(
    env.D1_DB.prepare(
      `SELECT day,
              SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) AS inbound_count,
              SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS outbound_count
       FROM (
         SELECT direction, SUBSTR(COALESCE(received_at, sent_at, created_at), 1, 10) AS day
         FROM messages
       )
       WHERE day >= ?
       GROUP BY day
       ORDER BY day ASC`
    ).bind(trendFloor)
  );

  const outboundTrendRows = await optionalAllRows<AdminOutboundTrendRow>(
    env.D1_DB.prepare(
      `SELECT SUBSTR(updated_at, 1, 10) AS day,
              SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent_count,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
       FROM outbound_jobs
       WHERE SUBSTR(updated_at, 1, 10) >= ?
       GROUP BY SUBSTR(updated_at, 1, 10)
       ORDER BY day ASC`
    ).bind(trendFloor)
  );

  const topMailboxRows = await optionalAllRows<AdminTopMailboxRow>(
    env.D1_DB.prepare(
      `SELECT mailboxes.address AS address,
              COUNT(messages.id) AS total_messages,
              SUM(CASE WHEN messages.direction = 'inbound' THEN 1 ELSE 0 END) AS inbound_messages,
              SUM(CASE WHEN messages.direction = 'outbound' THEN 1 ELSE 0 END) AS outbound_messages
       FROM mailboxes
       LEFT JOIN messages ON messages.mailbox_id = mailboxes.id
       GROUP BY mailboxes.id, mailboxes.address
       HAVING COUNT(messages.id) > 0
       ORDER BY total_messages DESC, mailboxes.address ASC
       LIMIT 5`
    )
  );

  const recentFailureRows = await optionalAllRows<AdminRecentFailureRow>(
    env.D1_DB.prepare(
      `SELECT id, message_id, last_error, updated_at
       FROM outbound_jobs
       WHERE status = 'failed'
       ORDER BY updated_at DESC
       LIMIT 5`
    )
  );

  const recentActivityRows = await optionalAllRows<AdminRecentActivityRow>(
    env.D1_DB.prepare(
      `SELECT messages.id,
              messages.mailbox_id,
              mailboxes.address AS mailbox_address,
              messages.direction,
              messages.to_addr,
              messages.from_addr,
              messages.subject,
              messages.status AS message_status,
              (
                SELECT outbound_jobs.status
                FROM outbound_jobs
                WHERE outbound_jobs.message_id = messages.id
                ORDER BY outbound_jobs.updated_at DESC
                LIMIT 1
              ) AS outbound_status,
              (
                SELECT delivery_events.event_type
                FROM delivery_events
                WHERE delivery_events.message_id = messages.id
                ORDER BY delivery_events.created_at DESC
                LIMIT 1
              ) AS delivery_event,
              COALESCE(messages.sent_at, messages.received_at, messages.created_at) AS occurred_at
       FROM messages
       LEFT JOIN mailboxes ON mailboxes.id = messages.mailbox_id
       ORDER BY COALESCE(messages.sent_at, messages.received_at, messages.created_at) DESC
       LIMIT 18`
    )
  );

  const trend = recentDays.map((date) => ({
    date,
    registrations: 0,
    inbound: 0,
    outbound: 0,
    sent: 0,
    failed: 0,
  }));
  const trendByDate = new Map(trend.map((item) => [item.date, item]));

  for (const row of registrationTrendRows) {
    if (!row.day) {
      continue;
    }
    const bucket = trendByDate.get(row.day);
    if (bucket) {
      bucket.registrations = toCount(row.count);
    }
  }

  for (const row of messageTrendRows) {
    if (!row.day) {
      continue;
    }
    const bucket = trendByDate.get(row.day);
    if (bucket) {
      bucket.inbound = toCount(row.inbound_count);
      bucket.outbound = toCount(row.outbound_count);
    }
  }

  for (const row of outboundTrendRows) {
    if (!row.day) {
      continue;
    }
    const bucket = trendByDate.get(row.day);
    if (bucket) {
      bucket.sent = toCount(row.sent_count);
      bucket.failed = toCount(row.failed_count);
    }
  }

  const sentJobs = toCount(outboundSummaryRow?.sent_jobs);
  const failedJobs = toCount(outboundSummaryRow?.failed_jobs);
  const deliveredEvents = toCount(deliverySummaryRow?.delivered_events);
  const unsuccessfulEvents = toCount(deliverySummaryRow?.unsuccessful_events);
  const sendTerminalCount = sentJobs + failedJobs;
  const deliveryTerminalCount = deliveredEvents + unsuccessfulEvents;
  const pendingQueue = toCount(outboundSummaryRow?.queued_jobs) + toCount(outboundSummaryRow?.sending_jobs) + toCount(outboundSummaryRow?.retry_jobs);

  return {
    generatedAt: new Date().toISOString(),
    domain: env.CLOUDFLARE_EMAIL_DOMAIN ?? null,
    counts: {
      registeredUsers: toCount(tenantSummaryRow?.registered_users),
      newUsers7d: toCount(newUsersRow?.count),
      userMailboxes: toCount(userMailboxRow?.user_mailboxes),
      activeMailboxes: toCount(userMailboxRow?.active_mailboxes),
      contactMailboxes: toCount(contactMailboxRow?.count),
      inboundMessages: toCount(messageSummaryRow?.inbound_messages),
      outboundMessages: toCount(messageSummaryRow?.outbound_messages),
      sentJobs,
      failedJobs,
      queuedJobs: toCount(outboundSummaryRow?.queued_jobs),
      sendingJobs: toCount(outboundSummaryRow?.sending_jobs),
      retryJobs: toCount(outboundSummaryRow?.retry_jobs),
      pendingQueue,
      pendingDrafts: toCount(draftSummaryRow?.pending_drafts),
      pendingIdempotency: toCount(pendingIdempotencyRow?.count),
      deliveredEvents,
      unsuccessfulEvents,
      bounceEvents: toCount(deliverySummaryRow?.bounce_events),
      complaintEvents: toCount(deliverySummaryRow?.complaint_events),
      rejectEvents: toCount(deliverySummaryRow?.reject_events),
    },
    rates: {
      sendSuccessRate: sendTerminalCount > 0 ? sentJobs / sendTerminalCount : null,
      deliverySuccessRate: deliveryTerminalCount > 0 ? deliveredEvents / deliveryTerminalCount : null,
    },
    latest: {
      registrationAt: toOptionalString(tenantSummaryRow?.latest_registration_at),
      inboundAt: toOptionalString(messageSummaryRow?.latest_inbound_at),
      outboundAt: toOptionalString(messageSummaryRow?.latest_outbound_at),
      deliveryAt: toOptionalString(deliverySummaryRow?.latest_delivery_at),
    },
    distributions: {
      messageStatuses: normalizeStatusCounts(messageStatusRows, ["received", "normalized", "tasked", "replied", "ignored", "failed"]),
      outboundStatuses: normalizeStatusCounts(outboundStatusRows, ["queued", "sending", "retry", "sent", "failed"]),
      deliveryEvents: normalizeStatusCounts(deliveryEventRows, ["delivery", "bounce", "complaint", "reject", "unknown"]),
    },
    trend,
    topMailboxes: topMailboxRows.map((row) => ({
      address: row.address ?? "unknown",
      totalMessages: toCount(row.total_messages),
      inboundMessages: toCount(row.inbound_messages),
      outboundMessages: toCount(row.outbound_messages),
    })),
    recentFailures: recentFailureRows.map((row) => ({
      id: row.id,
      messageId: row.message_id,
      lastError: row.last_error,
      updatedAt: row.updated_at,
    })),
    recentActivity: recentActivityRows.map((row) => ({
      id: row.id,
      mailboxId: row.mailbox_id,
      mailboxAddress: row.mailbox_address,
      direction: row.direction,
      toAddr: row.to_addr,
      fromAddr: row.from_addr,
      subject: row.subject,
      messageStatus: row.message_status,
      outboundStatus: row.outbound_status,
      deliveryEvent: row.delivery_event,
      occurredAt: row.occurred_at,
    })),
  };
}

function formatAdminNumber(value: unknown): string {
  return new Intl.NumberFormat().format(Number(value ?? 0));
}

function formatAdminPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }

  const percentage = value * 100;
  const digits = percentage >= 10 || percentage === 0 ? 0 : 1;
  return `${percentage.toFixed(digits)}%`;
}

function formatAdminDateTime(value: string | null | undefined): string {
  if (!value) {
    return "n/a";
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
}

function formatAdminRelativeTime(value: string | null | undefined): string {
  if (!value) {
    return "n/a";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  const diffMs = parsed.getTime() - Date.now();
  const diffMinutes = Math.round(diffMs / 60000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  if (Math.abs(diffMinutes) < 60) {
    return formatter.format(diffMinutes, "minute");
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 48) {
    return formatter.format(diffHours, "hour");
  }

  const diffDays = Math.round(diffHours / 24);
  return formatter.format(diffDays, "day");
}

function formatAdminDayLabel(value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? value.slice(5)
    : parsed.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
}

function humanizeAdminLabel(value: string): string {
  const dictionary: Record<string, string> = {
    received: "Received",
    normalized: "Normalized",
    tasked: "Tasked",
    replied: "Replied",
    ignored: "Ignored",
    failed: "Failed",
    queued: "Queued",
    sending: "Sending",
    retry: "Retry",
    sent: "Sent",
    delivery: "Delivered",
    bounce: "Bounced",
    complaint: "Complaint",
    reject: "Rejected",
    unknown: "Unknown",
  };

  return dictionary[value] || value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function adminStatusTone(value: string): string {
  if (["inbound", "received"].includes(value)) {
    return "inbound";
  }
  if (["outbound"].includes(value)) {
    return "outbound";
  }
  if (["delivery", "replied", "sent"].includes(value)) {
    return "sent";
  }
  if (["failed", "bounce", "reject"].includes(value)) {
    return "failed";
  }
  if (["retry", "complaint"].includes(value)) {
    return "warning";
  }
  return value;
}

function getAdminOverviewActivityStatus(item: AdminOverviewSnapshot["recentActivity"][number]): { label: string; tone: string } {
  if (item.direction === "outbound") {
    if (item.deliveryEvent === "delivery") {
      return { label: "Delivered", tone: "delivered" };
    }
    if (item.deliveryEvent === "bounce") {
      return { label: "Bounced", tone: "bounced" };
    }
    if (item.deliveryEvent === "complaint") {
      return { label: "Complaint", tone: "complaint" };
    }
    if (item.deliveryEvent === "reject") {
      return { label: "Rejected", tone: "rejected" };
    }
    if (item.outboundStatus === "sent") {
      return { label: "Sent", tone: "sent" };
    }
    if (item.outboundStatus === "failed") {
      return { label: "Failed", tone: "failed" };
    }
    if (item.outboundStatus === "retry") {
      return { label: "Retry", tone: "retry" };
    }
    if (item.outboundStatus === "sending") {
      return { label: "Sending", tone: "sending" };
    }
    if (item.outboundStatus === "queued") {
      return { label: "Queued", tone: "queued" };
    }
  }

  if (item.messageStatus === "received") {
    return { label: "Received", tone: "received" };
  }
  if (item.messageStatus === "normalized") {
    return { label: "Normalized", tone: "normalized" };
  }
  if (item.messageStatus === "tasked") {
    return { label: "Tasked", tone: "tasked" };
  }
  if (item.messageStatus === "replied") {
    return { label: "Replied", tone: "replied" };
  }
  if (item.messageStatus === "ignored") {
    return { label: "Ignored", tone: "ignored" };
  }
  if (item.messageStatus === "failed") {
    return { label: "Failed", tone: "failed" };
  }

  return { label: "Processed", tone: "processed" };
}

function renderAdminBreakdown(
  items: Array<{ key: string; label: string; count: number }>,
  emptyText: string
): string {
  if (!items.length) {
    return `<div class="admin-empty-state">${escapeHtml(emptyText)}</div>`;
  }

  const max = Math.max(...items.map((item) => Number(item.count) || 0), 0);
  return `<div class="admin-breakdown-list">${items.map((item) => {
    const count = Number(item.count) || 0;
    const width = max > 0 ? Math.max(count > 0 ? 6 : 0, (count / max) * 100) : 0;
    const tone = adminStatusTone(String(item.key || item.label || "").toLowerCase());
    return `<div class="admin-breakdown-row">
      <div class="admin-breakdown-meta">
        <span>${escapeHtml(humanizeAdminLabel(item.label || item.key || ""))}</span>
        <span>${escapeHtml(formatAdminNumber(count))}</span>
      </div>
      <div class="admin-breakdown-track">
        <span class="admin-breakdown-fill ${escapeHtml(tone)}" style="width:${width}%;"></span>
      </div>
    </div>`;
  }).join("")}</div>`;
}

function renderAdminTrendChart(points: AdminOverviewSnapshot["trend"]): string {
  if (!points.length) {
    return `<div class="admin-empty-state">No recent trend data available.</div>`;
  }

  const max = Math.max(
    ...points.flatMap((point) => [
      point.registrations || 0,
      point.inbound || 0,
      point.outbound || 0,
      point.sent || 0,
      point.failed || 0,
    ]),
    0
  );

  const legend = [
    ["registrations", "新增"],
    ["inbound", "收信"],
    ["outbound", "發信"],
    ["sent", "成功"],
    ["failed", "失敗"],
  ].map(([key, label]) =>
    `<span class="admin-legend-item ${key}"><span class="admin-legend-dot"></span>${escapeHtml(label)}</span>`
  ).join("");

  const chart = points.map((point) => {
    const series: Array<[string, number, string]> = [
      ["registrations", point.registrations || 0, "新增"],
      ["inbound", point.inbound || 0, "收信"],
      ["outbound", point.outbound || 0, "發信"],
      ["sent", point.sent || 0, "成功"],
      ["failed", point.failed || 0, "失敗"],
    ];
    return `<div class="admin-trend-day">
      <div class="admin-trend-bars">
        ${series.map(([key, count, label]) => {
          const height = max > 0 ? Math.max(count > 0 ? 6 : 0, (count / max) * 100) : 0;
          return `<span class="admin-trend-bar ${escapeHtml(key)}" style="height:${height}%;" title="${escapeHtml(`${label}: ${formatAdminNumber(count)}`)}"></span>`;
        }).join("")}
      </div>
      <div class="admin-trend-label">${escapeHtml(formatAdminDayLabel(point.date))}</div>
      <div class="admin-trend-total">${escapeHtml(`收 ${formatAdminNumber(point.inbound || 0)} · 發 ${formatAdminNumber(point.outbound || 0)}`)}</div>
    </div>`;
  }).join("");

  return `<div class="admin-chart-legend">${legend}</div><div class="admin-trend-chart">${chart}</div>`;
}

function renderAdminTopMailboxes(items: AdminOverviewSnapshot["topMailboxes"]): string {
  if (!items.length) {
    return `<div class="admin-empty-state">No mailbox activity recorded yet.</div>`;
  }

  return items.map((item) =>
    `<div class="faq-item">
      <h3>${escapeHtml(item.address)}</h3>
      <p>Total: ${escapeHtml(formatAdminNumber(item.totalMessages))}</p>
      <p>Inbound: ${escapeHtml(formatAdminNumber(item.inboundMessages))} · Outbound: ${escapeHtml(formatAdminNumber(item.outboundMessages))}</p>
    </div>`
  ).join("");
}

function renderAdminRecentFailures(items: AdminOverviewSnapshot["recentFailures"]): string {
  if (!items.length) {
    return `<div class="faq-item"><h3>All clear</h3><p>No failed outbound jobs recorded.</p></div>`;
  }

  return items.map((item) =>
    `<div class="faq-item">
      <h3>${escapeHtml(item.id)}</h3>
      <p>Message: ${escapeHtml(item.messageId || "n/a")}</p>
      <p>Error: ${escapeHtml(item.lastError || "unknown")}</p>
      <p>Updated: ${escapeHtml(formatAdminDateTime(item.updatedAt))}</p>
    </div>`
  ).join("");
}

function getAdminOverviewHealth(
  stats: AdminOverviewSnapshot | null,
  aliases: AdminAliasSummary[],
  aliasAdminAvailable: boolean
): { tone: string; label: string } {
  if (!stats) {
    return { tone: "neutral", label: "Waiting for runtime metrics" };
  }

  const hasAliasGap = aliasAdminAvailable && aliases.some((item) => !item.configured);
  const hasQueuePressure = stats.counts.retryJobs > 0 || stats.counts.pendingQueue > 0;
  const hasFailures = stats.recentFailures.length > 0 || stats.counts.failedJobs > 0;

  if (hasAliasGap || hasQueuePressure || hasFailures) {
    return { tone: "warning", label: "Runtime needs attention" };
  }

  return { tone: "success", label: "Runtime healthy" };
}

function renderAdminActivityRows(items: AdminOverviewSnapshot["recentActivity"]): string {
  if (!items.length) {
    return `<div class="admin-table-row">
      <div class="admin-empty-state">No recent activity recorded.</div>
      <div></div><div></div><div></div><div></div>
    </div>`;
  }

  return items.map((item) => {
    const status = getAdminOverviewActivityStatus(item);
    const recipient = item.direction === "inbound" ? (item.fromAddr || "Unknown sender") : (item.toAddr || "Unknown recipient");
    const secondary = item.mailboxAddress || (item.direction === "inbound" ? item.toAddr : item.fromAddr) || "mail runtime";
    return `<div class="admin-table-row">
      <div class="admin-email-recipient">
        <div class="admin-email-avatar">M</div>
        <div class="admin-email-lines">
          <div class="admin-email-primary">${escapeHtml(recipient)}</div>
          <div class="admin-email-secondary">${escapeHtml(secondary)}</div>
        </div>
      </div>
      <div><span class="admin-status-badge ${escapeHtml(status.tone.toLowerCase())}">${escapeHtml(status.label)}</span></div>
      <div class="admin-email-subject"><div class="admin-email-subject-text">${escapeHtml(item.subject || "(No subject)")}</div></div>
      <div class="admin-time-label">${escapeHtml(formatAdminRelativeTime(item.occurredAt))}</div>
      <div><span class="admin-empty-state">View</span></div>
    </div>`;
  }).join("");
}

function serializeAdminScriptData(value: unknown): string {
  const serialized = JSON.stringify(value ?? null);
  if (typeof serialized !== "string") {
    return "null";
  }

  return serialized
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

async function loadAdminPageBootstrap(request: Request, env: Env): Promise<AdminPageBootstrap> {
  const runtimeMetadata = buildRuntimeMetadata(request, env);
  const overviewSnapshot = await getAdminOverviewSnapshot(env);

  const configError = requireCloudflareEmailConfig(env);
  if (configError) {
    const fallbackDomain = env.CLOUDFLARE_EMAIL_DOMAIN || "mailagents.net";
    return {
      overviewSnapshot,
      runtimeMetadata,
      aliasAdminAvailable: false,
      aliasAdminMessage: "Cloudflare email routing admin is not configured in this environment",
      aliases: CONTACT_ALIAS_LOCALPARTS.map((alias) => ({
        address: `${alias}@${fallbackDomain}`,
        configured: false,
        mode: env.CLOUDFLARE_EMAIL_WORKER ? "internal" : null,
        destination: null,
        worker: env.CLOUDFLARE_EMAIL_WORKER ?? null,
      })),
    };
  }

  try {
    const rules = await listEmailRoutingRules(env);
    const aliases = await Promise.all(CONTACT_ALIAS_LOCALPARTS.map(async (alias) => {
      const address = getContactAliasAddress(env, alias);
      const rule = rules.find((entry) =>
        entry.matchers.some((matcher) => matcher.type === "literal" && matcher.field === "to" && matcher.value === address)
      );
      const mailbox = await getMailboxByAddress(env, address);
      const forwardAction = rule?.actions.find((action) => action.type === "forward");
      const workerAction = rule?.actions.find((action) => action.type === "worker");

      return {
        address,
        configured: Boolean(rule?.enabled) && isManagedAliasMailboxHealthy(mailbox),
        mode: workerAction ? "internal" : forwardAction ? "forward" : null,
        destination: forwardAction?.value?.[0] ?? null,
        worker: workerAction?.value?.[0] ?? null,
      } satisfies AdminAliasSummary;
    }));

    return {
      overviewSnapshot,
      runtimeMetadata,
      aliasAdminAvailable: true,
      aliasAdminMessage: null,
      aliases,
    };
  } catch (error) {
    const fallbackDomain = env.CLOUDFLARE_EMAIL_DOMAIN || "mailagents.net";
    return {
      overviewSnapshot,
      runtimeMetadata,
      aliasAdminAvailable: false,
      aliasAdminMessage: error instanceof Error ? error.message : "Unable to load aliases",
      aliases: CONTACT_ALIAS_LOCALPARTS.map((alias) => ({
        address: `${alias}@${fallbackDomain}`,
        configured: false,
        mode: null,
        destination: null,
        worker: null,
      })),
    };
  }
}

async function restoreAdminSendReplay(env: Env, resourceId: string | undefined) {
  if (!resourceId) {
    throw new SiteRequestError("Stored idempotent admin send result is incomplete", 500);
  }

  let outboundJob = await getOutboundJob(env, resourceId);
  if (outboundJob) {
    const draft = await getDraftByR2KeyForOutboundLifecycle(env, outboundJob.draftR2Key);
    if (!draft) {
      throw new SiteRequestError("Stored idempotent draft no longer exists", 409);
    }
    if (!(await getMessage(env, outboundJob.messageId))) {
      throw new SiteRequestError("Stored idempotent outbound message no longer exists", 409);
    }

    return {
      ok: true,
      draftId: draft.id,
      outboundJobId: outboundJob.id,
      status: "queued" as const,
    };
  }

  let draft = await getDraft(env, resourceId);
  if (!draft) {
    throw new SiteRequestError("Stored idempotent outbound job no longer exists", 409);
  }
  if (draft.status !== "draft" && draft.status !== "approved") {
    throw new SiteRequestError("Stored idempotent outbound job no longer exists", 409);
  }

  const resumed = await enqueueDraftSend(env, draft.id);
  const resumedDraft = await getDraft(env, draft.id);
  if (!resumedDraft) {
    throw new SiteRequestError("Stored idempotent draft disappeared during replay recovery", 409);
  }
  const resumedOutboundJob = await getOutboundJob(env, resumed.outboundJobId);
  if (!resumedOutboundJob) {
    throw new SiteRequestError("Stored idempotent outbound job disappeared during replay recovery", 409);
  }
  if (!(await getMessage(env, resumedOutboundJob.messageId))) {
    throw new SiteRequestError("Stored idempotent outbound message disappeared during replay recovery", 409);
  }
  draft = resumedDraft;
  outboundJob = resumedOutboundJob;

  return {
    ok: true,
    draftId: draft.id,
    outboundJobId: outboundJob.id,
    status: "queued" as const,
  };
}

async function validateAdminSendReferences(env: Env, input: {
  tenantId: string;
  mailboxId: string;
  threadId?: string;
  sourceMessageId?: string;
}): Promise<void> {
  if (input.threadId) {
    const thread = await getThread(env, input.threadId);
    if (!thread) {
      throw new SiteRequestError("Thread not found", 404);
    }
    if (thread.tenantId !== input.tenantId) {
      throw new SiteRequestError("Thread does not belong to tenant", 409);
    }
    if (thread.mailboxId !== input.mailboxId) {
      throw new SiteRequestError("Thread does not belong to mailbox", 409);
    }
  }

  if (input.sourceMessageId) {
    const sourceMessage = await getMessage(env, input.sourceMessageId);
    if (!sourceMessage) {
      throw new SiteRequestError("Source message not found", 404);
    }
    if (sourceMessage.tenantId !== input.tenantId) {
      throw new SiteRequestError("Source message does not belong to tenant", 409);
    }
    if (sourceMessage.mailboxId !== input.mailboxId) {
      throw new SiteRequestError("Source message does not belong to mailbox", 409);
    }
    if (input.threadId && sourceMessage.threadId !== input.threadId) {
      throw new SiteRequestError("Source message does not belong to thread", 409);
    }
  }
}

async function readDraftRecipientsForAdmin(env: Env, draftR2Key: string): Promise<{
  to: string[];
  cc: string[];
  bcc: string[];
}> {
  const object = await env.R2_EMAIL.get(draftR2Key);
  if (!object) {
    throw new SiteRequestError("Draft payload not found", 409);
  }

  const payload = await object.json<Record<string, unknown>>();
  const parseRecipientList = (value: unknown, field: "to" | "cc" | "bcc"): string[] => {
    if (value === undefined || value === null) {
      if (field === "to") {
        throw new SiteRequestError(
          "Draft recipients must include a non-empty to array and optional cc/bcc string arrays",
          409,
        );
      }
      return [];
    }

    if (!Array.isArray(value)) {
      throw new SiteRequestError(
        "Draft recipients must include a non-empty to array and optional cc/bcc string arrays",
        409,
      );
    }

    const items = value.map((item) => typeof item === "string" ? item.trim() : "");
    if (items.some((item) => !item)) {
      throw new SiteRequestError(
        "Draft recipients must include a non-empty to array and optional cc/bcc string arrays",
        409,
      );
    }
    if (field === "to" && items.length === 0) {
      throw new SiteRequestError(
        "Draft recipients must include a non-empty to array and optional cc/bcc string arrays",
        409,
      );
    }

    return items;
  };
  return {
    to: parseRecipientList(payload.to, "to"),
    cc: parseRecipientList(payload.cc, "cc"),
    bcc: parseRecipientList(payload.bcc, "bcc"),
  };
}

site.on("GET", "/", (_request, _env, _ctx, route) => html(layout("overview", "Mailagents", renderHome(route.url))));
site.on("HEAD", "/", (_request, _env, _ctx, route) => html(layout("overview", "Mailagents", renderHome(route.url))));
site.on("GET", "/limits", () => html(layout("limits", "Limits And Access", renderLimits())));
site.on("HEAD", "/limits", () => html(layout("limits", "Limits And Access", renderLimits())));
site.on("GET", "/privacy", () => html(layout("privacy", "Privacy Policy", renderPrivacy())));
site.on("HEAD", "/privacy", () => html(layout("privacy", "Privacy Policy", renderPrivacy())));
site.on("GET", "/terms", () => html(layout("terms", "Terms of Service", renderTerms())));
site.on("HEAD", "/terms", () => html(layout("terms", "Terms of Service", renderTerms())));
site.on("GET", "/contact", () => html(layout("contact", "Contact", renderContact())));
site.on("HEAD", "/contact", () => html(layout("contact", "Contact", renderContact())));
site.on("GET", "/CHANGELOG.md", () => redirect(CHANGELOG_REDIRECT_URL, 302));
site.on("HEAD", "/CHANGELOG.md", () => redirect(CHANGELOG_REDIRECT_URL, 302));
site.on("GET", "/robots.txt", (_request, _env, _ctx, route) => text(renderRobots(route.url), "text/plain; charset=utf-8"));
site.on("HEAD", "/robots.txt", (_request, _env, _ctx, route) => text(renderRobots(route.url), "text/plain; charset=utf-8"));
site.on("GET", "/sitemap.xml", (_request, _env, _ctx, route) => text(renderSitemap(route.url), "application/xml; charset=utf-8"));
site.on("HEAD", "/sitemap.xml", (_request, _env, _ctx, route) => text(renderSitemap(route.url), "application/xml; charset=utf-8"));
site.on("GET", "/favicon.ico", () => text(FAVICON_SVG, "image/svg+xml"));
site.on("HEAD", "/favicon.ico", () => text(FAVICON_SVG, "image/svg+xml"));
site.on("GET", "/signup", () => redirect("/"));
site.on("HEAD", "/signup", () => redirect("/"));
site.on("GET", "/admin", async (_request, env, _ctx, route) => {
  const routeError = requireAdminRoutesEnabled(_request, env);
  if (routeError) {
    return routeError;
  }

  const requestUrl = new URL(_request.url);
  const initiallyAuthenticated = await hasValidSiteAdminSession(_request, env);
  const errorCode = requestUrl.searchParams.get("error");
  const authError = errorCode === "invalid_admin_secret"
    ? "Invalid admin secret."
    : errorCode === "session_required"
      ? "Enter the admin secret."
      : null;
  let bootstrap: AdminPageBootstrap | null = null;

  if (initiallyAuthenticated) {
    try {
      bootstrap = await loadAdminPageBootstrap(_request, env);
    } catch (error) {
      bootstrap = {
        overviewSnapshot: null,
        runtimeMetadata: buildRuntimeMetadata(_request, env),
        aliases: [],
        aliasAdminAvailable: false,
        aliasAdminMessage: error instanceof Error ? error.message : "Unable to load admin bootstrap data",
      };
    }
  }

  return html(layout("admin", "Admin Dashboard", renderAdmin(route.url, {
    initiallyAuthenticated,
    authError,
    bootstrap,
  })), {
    headers: {
      "cache-control": "private, no-store, max-age=0",
    },
  });
});
site.on("HEAD", "/admin", async (_request, env, _ctx, route) => {
  const routeError = requireAdminRoutesEnabled(_request, env);
  if (routeError) {
    return routeError;
  }

  return html(layout("admin", "Admin Dashboard", renderAdmin(route.url, {
    initiallyAuthenticated: await hasValidSiteAdminSession(_request, env),
  })), {
    headers: {
      "cache-control": "private, no-store, max-age=0",
    },
  });
});
site.on("POST", "/admin/login", async (request, env) => {
  const routeError = requireAdminRoutesEnabled(request, env);
  if (routeError) {
    return routeError;
  }

  if (!env.ADMIN_API_SECRET) {
    return html(layout("admin", "Admin Dashboard", renderAdmin(new URL(request.url), {
      authError: "ADMIN_API_SECRET is not configured.",
    })), {
      status: 500,
      headers: {
        "cache-control": "private, no-store, max-age=0",
      },
    });
  }

  const formData = await request.formData();
  const providedSecret = String(formData.get("secret") ?? "").trim();
  if (providedSecret !== env.ADMIN_API_SECRET) {
    return redirect("/admin?error=invalid_admin_secret", 303);
  }

  const response = redirect("/admin", 303);
  response.headers.append("set-cookie", await buildSiteAdminSessionCookie(new URL(request.url), env.ADMIN_API_SECRET));
  response.headers.set("cache-control", "private, no-store, max-age=0");
  return response;
});
site.on("POST", "/admin/logout", (request, env) => {
  const routeError = requireAdminRoutesEnabled(request, env);
  if (routeError) {
    return routeError;
  }

  const response = redirect("/admin", 303);
  response.headers.append("set-cookie", buildExpiredSiteAdminSessionCookie(new URL(request.url)));
  response.headers.set("cache-control", "private, no-store, max-age=0");
  return response;
});
site.on("GET", "/admin/api/runtime-metadata", async (request, env) => {
  const accessError = await requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  return json(buildRuntimeMetadata(request, env));
});
site.on("GET", "/admin/api/session/verify", async (request, env) => {
  const accessError = await requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  return json({
    ok: true,
    host: new URL(request.url).host,
  });
});
site.on("GET", "/admin/api/overview-stats", async (request, env) => {
  const accessError = await requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  try {
    return json(await getAdminOverviewSnapshot(env));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load overview stats" }, { status: 502 });
  }
});

site.on("GET", "/admin/api/contact-aliases", async (request, env) => {
  const accessError = await requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  const configError = requireCloudflareEmailConfig(env);
  if (configError) {
    const fallbackDomain = env.CLOUDFLARE_EMAIL_DOMAIN || "mailagents.net";
    return json({
      available: false,
      message: "Cloudflare email routing admin is not configured in this environment",
      domain: fallbackDomain,
      aliases: CONTACT_ALIAS_LOCALPARTS.map((alias) => ({
        alias,
        address: `${alias}@${fallbackDomain}`,
        configured: false,
        enabled: false,
        mode: env.CLOUDFLARE_EMAIL_WORKER ? "internal" : null,
        destination: null,
        worker: env.CLOUDFLARE_EMAIL_WORKER ?? null,
        ruleId: null,
      })),
      rules: [],
    });
  }

  try {
    const rules = await listEmailRoutingRules(env);
    const aliases = await Promise.all(CONTACT_ALIAS_LOCALPARTS.map(async (alias) => {
      const address = getContactAliasAddress(env, alias);
      const rule = rules.find((entry) =>
        entry.matchers.some((matcher) => matcher.type === "literal" && matcher.field === "to" && matcher.value === address)
      );
      const mailbox = await getMailboxByAddress(env, address);
      const forwardAction = rule?.actions.find((action) => action.type === "forward");
      const workerAction = rule?.actions.find((action) => action.type === "worker");
      return {
        alias,
        address,
        configured: Boolean(rule?.enabled) && isManagedAliasMailboxHealthy(mailbox),
        enabled: rule?.enabled ?? false,
        mode: workerAction ? "internal" : forwardAction ? "forward" : null,
        destination: forwardAction?.value?.[0] ?? null,
        worker: workerAction?.value?.[0] ?? null,
        ruleId: rule?.id ?? null,
        mailboxId: mailbox?.id ?? null,
        mailboxStatus: mailbox?.status ?? null,
      };
    }));

    return json({
      domain: env.CLOUDFLARE_EMAIL_DOMAIN,
      bootstrapManaged: shouldBootstrapContactAliasRouting(env),
      aliases,
      rules,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load aliases" }, { status: 502 });
  }
});
site.on("POST", "/admin/api/contact-aliases", async (request, env) => {
  const accessError = await requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  const configError = requireCloudflareEmailConfig(env);
  if (configError) {
    return configError;
  }

  const body = await readJson<{ alias?: string }>(request);
  const alias = body.alias?.trim().toLowerCase();

  if (!alias || !/^[a-z0-9._+-]+$/.test(alias)) {
    return badRequest("alias is required");
  }
  if (!CONTACT_ALIAS_LOCALPARTS.includes(alias as typeof CONTACT_ALIAS_LOCALPARTS[number])) {
    return badRequest(`alias must be one of: ${CONTACT_ALIAS_LOCALPARTS.join(", ")}`);
  }

  if (!env.CLOUDFLARE_EMAIL_WORKER) {
    return json({ error: "CLOUDFLARE_EMAIL_WORKER is not configured" }, { status: 500 });
  }

  try {
    const rules = await listEmailRoutingRules(env);
    const address = `${alias}@${env.CLOUDFLARE_EMAIL_DOMAIN}`;
    const existing = rules.find((entry) =>
      entry.matchers.some((matcher) => matcher.type === "literal" && matcher.field === "to" && matcher.value === address)
    );
    const mailboxResult = await ensureMailboxWithStatus(env, {
      tenantId: CONTACT_ALIAS_TENANT_ID,
      address,
    });
    const priorMailboxStatus = mailboxResult.mailbox.status;
    let mailbox = mailboxResult.mailbox;
    if (priorMailboxStatus !== "active") {
      mailbox = await updateMailboxStatus(env, mailbox.id, "active");
    }
    let rule;
    try {
      rule = await upsertWorkerRule(env, alias, env.CLOUDFLARE_EMAIL_WORKER, existing?.id);
    } catch (error) {
      if (mailboxResult.created) {
        await deleteMailboxIfUnreferenced(env, mailboxResult.mailbox.id).catch(() => undefined);
      } else if (priorMailboxStatus !== "active") {
        await updateMailboxStatus(env, mailboxResult.mailbox.id, priorMailboxStatus).catch(() => undefined);
      }
      throw error;
    }
    return json({ ok: true, rule, mailbox });
  } catch (error) {
    const status = error instanceof MailboxConflictError ? 409 : 502;
    return json({ error: error instanceof Error ? error.message : "Unable to save alias" }, { status });
  }
});
site.on("POST", "/admin/api/contact-aliases/bootstrap", async (request, env) => {
  const accessError = await requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  const configError = requireCloudflareEmailConfig(env);
  if (configError) {
    return configError;
  }

  const body = await readJson<{
    overwrite?: boolean;
  }>(request);
  if (!env.CLOUDFLARE_EMAIL_WORKER) {
    return json({ error: "CLOUDFLARE_EMAIL_WORKER is not configured" }, { status: 500 });
  }

  try {
    const rules = await listEmailRoutingRules(env);
    const results = [];

    for (const alias of CONTACT_ALIAS_LOCALPARTS) {
      const address = getContactAliasAddress(env, alias);
      const existing = rules.find((entry) =>
        entry.matchers.some((matcher) => matcher.type === "literal" && matcher.field === "to" && matcher.value === address)
      );

      const ensureActiveAliasMailbox = async () => {
        const mailboxResult = await ensureMailboxWithStatus(env, {
          tenantId: CONTACT_ALIAS_TENANT_ID,
          address,
        });
        if (mailboxResult.mailbox.status === "active") {
          return mailboxResult.mailbox;
        }

        return await updateMailboxStatus(env, mailboxResult.mailbox.id, "active");
      };

      if (existing && !body.overwrite && isManagedAliasWorkerRuleHealthy(env, alias, existing)) {
        const mailbox = await ensureActiveAliasMailbox();
        results.push({ alias, skipped: true, reason: "exists", mailboxId: mailbox.id });
        continue;
      }

      const mailboxResult = await ensureMailboxWithStatus(env, {
        tenantId: CONTACT_ALIAS_TENANT_ID,
        address,
      });
      const priorMailboxStatus = mailboxResult.mailbox.status;
      let mailbox = mailboxResult.mailbox;
      if (priorMailboxStatus !== "active") {
        mailbox = await updateMailboxStatus(env, mailbox.id, "active");
      }
      let rule;
      try {
        rule = await upsertWorkerRule(env, alias, env.CLOUDFLARE_EMAIL_WORKER, existing?.id);
      } catch (error) {
        if (mailboxResult.created) {
          await deleteMailboxIfUnreferenced(env, mailboxResult.mailbox.id).catch(() => undefined);
        } else if (priorMailboxStatus !== "active") {
          await updateMailboxStatus(env, mailboxResult.mailbox.id, priorMailboxStatus).catch(() => undefined);
        }
        throw error;
      }
      results.push({ alias, skipped: false, ruleId: rule.id, mailboxId: mailbox.id });
    }

    return json({ ok: true, results });
  } catch (error) {
    const status = error instanceof MailboxConflictError ? 409 : 502;
    return json({ error: error instanceof Error ? error.message : "Unable to bootstrap aliases" }, { status });
  }
});
site.on("DELETE", "/admin/api/contact-aliases/:alias", async (request, env, _ctx, route) => {
  const accessError = await requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }
  const alias = route.params.alias.toLowerCase();
  if (!CONTACT_ALIAS_LOCALPARTS.includes(alias as typeof CONTACT_ALIAS_LOCALPARTS[number])) {
    return badRequest(`alias must be one of: ${CONTACT_ALIAS_LOCALPARTS.join(", ")}`);
  }

  const configError = requireCloudflareEmailConfig(env);
  if (configError) {
    return configError;
  }
  if (shouldBootstrapContactAliasRouting(env)) {
    return json({
      error: "Managed contact aliases are automatically maintained in this environment; disable CONTACT_ALIAS_ROUTING_BOOTSTRAP_ENABLED before deleting them manually.",
    }, { status: 409 });
  }

  try {
    const rules = await listEmailRoutingRules(env);
    const address = `${alias}@${env.CLOUDFLARE_EMAIL_DOMAIN}`;
    const existing = rules.find((entry) =>
      entry.matchers.some((matcher) => matcher.type === "literal" && matcher.field === "to" && matcher.value === address)
    );
    const mailbox = await getMailboxByAddress(env, address);
    if (mailbox && mailbox.tenant_id !== CONTACT_ALIAS_TENANT_ID) {
      return json({
        error: `Managed contact alias ${address} is already owned by tenant ${mailbox.tenant_id}`,
      }, { status: 409 });
    }
    const previousStatus = mailbox?.status;

    if (mailbox && mailbox.tenant_id === CONTACT_ALIAS_TENANT_ID && mailbox.status !== "inactive") {
      await updateMailboxStatus(env, mailbox.id, "inactive");
    }

    if (!existing) {
      return json({ ok: true, deleted: Boolean(mailbox) });
    }

    try {
      await deleteEmailRoutingRule(env, existing.id);
    } catch (error) {
      if (mailbox && mailbox.tenant_id === CONTACT_ALIAS_TENANT_ID && previousStatus && previousStatus !== "inactive") {
        await updateMailboxStatus(env, mailbox.id, previousStatus).catch(() => undefined);
      }
      throw error;
    }
    return json({ ok: true, deleted: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to delete alias" }, { status: 502 });
  }
});
site.on("GET", "/admin/api/mailboxes", async (request, env) => {
  const accessError = await requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  try {
    return json({ items: await listMailboxes(env) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load mailboxes" }, { status: 502 });
  }
});
site.on("GET", "/admin/api/messages", async (request, env) => {
  const accessError = await requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  try {
    const url = new URL(request.url);
    const mailboxId = url.searchParams.get("mailboxId") ?? undefined;
    const limit = parseSiteListLimit(url.searchParams.get("limit"), 50, 200);
    const search = url.searchParams.get("search")?.trim() || undefined;
    const direction = (url.searchParams.get("direction")?.trim() as "inbound" | "outbound" | null) ?? undefined;
    const status = (url.searchParams.get("status")?.trim() as
      | "received"
      | "normalized"
      | "tasked"
      | "replied"
      | "ignored"
      | "failed"
      | null) ?? undefined;
    return json({ items: await listMessages(env, { mailboxId, limit, search, direction, status }) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load messages" }, { status: 502 });
  }
});
site.on("GET", "/admin/api/messages/:messageId", async (request, env, _ctx, route) => {
  const accessError = await requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  try {
    const message = await getMessage(env, route.params.messageId);
    if (!message) {
      return json({ error: "Message not found" }, { status: 404 });
    }
    return json(message);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load message" }, { status: 502 });
  }
});
site.on("GET", "/admin/api/messages/:messageId/content", async (request, env, _ctx, route) => {
  const accessError = await requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  try {
    const message = await getMessage(env, route.params.messageId);
    if (!message) {
      return json({ error: "Message not found" }, { status: 404 });
    }
    return json(await getMessageContent(env, route.params.messageId));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load message content" }, { status: 502 });
  }
});
site.on("GET", "/admin/api/threads/:threadId", async (request, env, _ctx, route) => {
  const accessError = await requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  try {
    const thread = await getThread(env, route.params.threadId);
    if (!thread) {
      return json({ error: "Thread not found" }, { status: 404 });
    }
    return json(thread);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load thread" }, { status: 502 });
  }
});
site.on("GET", "/admin/api/messages/:messageId/events", async (request, env, _ctx, route) => {
  const accessError = await requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  try {
    const message = await getMessage(env, route.params.messageId);
    if (!message) {
      return json({ error: "Message not found" }, { status: 404 });
    }
    return json({ items: await listDeliveryEventsByMessageId(env, route.params.messageId) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load delivery events" }, { status: 502 });
  }
});
site.on("GET", "/admin/api/outbound-jobs", async (request, env) => {
  const accessError = await requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  try {
    const url = new URL(request.url);
    const status = (url.searchParams.get("status")?.trim() as
      | "queued"
      | "sending"
      | "sent"
      | "retry"
      | "failed"
      | null) ?? undefined;
    const limit = parseSiteListLimit(url.searchParams.get("limit"), 50, 200);
    return json({ items: await listOutboundJobs(env, { status, limit }) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load outbound jobs" }, { status: 502 });
  }
});
site.on("GET", "/admin/api/messages/:messageId/outbound-job", async (request, env, _ctx, route) => {
  const accessError = await requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  try {
    const message = await getMessage(env, route.params.messageId);
    if (!message) {
      return json({ error: "Message not found" }, { status: 404 });
    }
    const job = await getOutboundJobByMessageId(env, route.params.messageId);
    if (!job) {
      return json({ error: "Outbound job not found" }, { status: 404 });
    }
    return json(job);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load outbound job" }, { status: 502 });
  }
});
site.on("POST", "/admin/api/outbound-jobs/:outboundJobId/retry", async (request, env, _ctx, route) => {
  const accessError = await requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  try {
    const job = await getOutboundJob(env, route.params.outboundJobId);
    if (!job) {
      return json({ error: "Outbound job not found" }, { status: 404 });
    }
    const draft = await getDraftByR2KeyForOutboundLifecycle(env, job.draftR2Key);
    if (!draft) {
      return json({ error: "Outbound draft not found" }, { status: 409 });
    }

    const message = await getMessage(env, job.messageId);
    if (!message) {
      return json({ error: "Outbound message not found" }, { status: 409 });
    }
    const previousMessageStatus = message?.status;
    const deliveryEvents = message ? await listDeliveryEventsByMessageId(env, message.id) : [];
    if (message?.providerMessageId || message?.sentAt || deliveryEvents.length > 0) {
      return json({ error: "Outbound jobs with provider delivery events cannot be retried from the queue state" }, { status: 409 });
    }
    if (job.lastError === "send_attempt_uncertain_manual_review_required") {
      return json({
        error: "Outbound jobs with uncertain prior send attempts require manual verification before any retry",
      }, { status: 409 });
    }
    if (job.status !== "failed") {
      return json({ error: `Outbound job status ${job.status} cannot be retried` }, { status: 409 });
    }
    await ensureDraftSendAllowed(env, {
      tenantId: draft.tenantId,
      agentId: draft.agentId,
      mailboxId: draft.mailboxId,
      draftR2Key: draft.draftR2Key,
      threadId: draft.threadId ?? undefined,
      sourceMessageId: draft.sourceMessageId ?? undefined,
    });
    const draftRecipients = await readDraftRecipientsForAdmin(env, job.draftR2Key);
    await reserveDraftSendCredits(env, {
      tenantId: draft.tenantId,
      draftR2Key: draft.draftR2Key,
      sourceMessageId: draft.sourceMessageId,
      createdVia: draft.createdVia,
    });

    const previousDraftStatus = draft?.status;
    try {
      await updateOutboundJobStatus(env, {
        outboundJobId: job.id,
        status: "queued",
        retryCount: 0,
        lastError: null,
        nextRetryAt: null,
      });
      await updateMessageStatus(env, job.messageId, "tasked");
      if (draft) {
        await markDraftStatus(env, draft.id, "queued");
      }
      await env.OUTBOUND_SEND_QUEUE.send({ outboundJobId: job.id });
    } catch (error) {
      await updateOutboundJobStatus(env, {
        outboundJobId: job.id,
        status: job.status,
        retryCount: job.retryCount,
        lastError: job.lastError ?? null,
        nextRetryAt: job.nextRetryAt ?? null,
      }).catch(() => undefined);
      if (previousMessageStatus) {
        await updateMessageStatus(env, job.messageId, previousMessageStatus).catch(() => undefined);
      }
      if (draft && previousDraftStatus) {
        await markDraftStatus(env, draft.id, previousDraftStatus).catch(() => undefined);
      }
      try {
        await releaseOutboundUsageReservation(env, {
          tenantId: draft.tenantId,
          outboundJobId: job.id,
          sourceMessageId: draft.sourceMessageId,
          draftCreatedVia: draft.createdVia,
          ...draftRecipients,
        });
      } catch {
        // Best-effort rollback for credit reservations after queue re-enqueue failure.
      }
      throw error;
    }

    return json({ ok: true, outboundJobId: job.id, status: "queued" });
  } catch (error) {
    if (error instanceof SiteRequestError) {
      return json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DraftSendValidationError) {
      return json({ error: error.message }, { status: error.status });
    }
    return json({ error: error instanceof Error ? error.message : "Unable to retry outbound job" }, { status: 502 });
  }
});
site.on("POST", "/admin/api/outbound-jobs/:outboundJobId/manual-resolution", async (request, env, _ctx, route) => {
  const accessError = await requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  const body = await readJson<{ resolution?: string }>(request);
  if (body.resolution !== "sent" && body.resolution !== "not_sent") {
    return badRequest("resolution must be sent or not_sent");
  }

  try {
    const job = await getOutboundJob(env, route.params.outboundJobId);
    if (!job) {
      return json({ error: "Outbound job not found" }, { status: 404 });
    }
    if (job.status !== "failed") {
      return json({ error: `Outbound job status ${job.status} does not support manual send resolution` }, { status: 409 });
    }
    if (job.lastError !== "send_attempt_uncertain_manual_review_required") {
      return json({ error: "Outbound job does not require manual send resolution" }, { status: 409 });
    }

    const message = await getMessage(env, job.messageId);
    if (!message) {
      return json({ error: "Outbound message not found" }, { status: 409 });
    }
    const draft = await getDraftByR2KeyForOutboundLifecycle(env, job.draftR2Key);
    if (!draft) {
      return json({ error: "Outbound draft not found" }, { status: 409 });
    }
    const recipients = await readDraftRecipientsForAdmin(env, job.draftR2Key);
    const deliveryEvents = await listDeliveryEventsByMessageId(env, message.id);

    if (body.resolution === "not_sent" && (message.providerMessageId || message.sentAt || deliveryEvents.length > 0)) {
      return json({ error: "Outbound job already has delivery evidence and cannot be resolved as not_sent" }, { status: 409 });
    }

    if (body.resolution === "sent") {
      await settleOutboundUsageDebit(env, {
        tenantId: draft.tenantId,
        messageId: job.messageId,
        outboundJobId: job.id,
        draftId: draft.id,
        draftCreatedVia: draft.createdVia,
        sourceMessageId: draft.sourceMessageId,
        ...recipients,
      });
      await updateMessageStatus(env, job.messageId, "replied");
      await markDraftStatus(env, draft.id, "sent");
      await updateOutboundJobStatus(env, {
        outboundJobId: job.id,
        status: "sent",
        lastError: null,
        nextRetryAt: null,
      });
      return json({ ok: true, outboundJobId: job.id, status: "sent", billingResolution: "settled" });
    }

    await releaseOutboundUsageReservation(env, {
      tenantId: draft.tenantId,
      outboundJobId: job.id,
      sourceMessageId: draft.sourceMessageId,
      draftCreatedVia: draft.createdVia,
      ...recipients,
    });
    await updateMessageStatus(env, job.messageId, "failed");
    await markDraftStatus(env, draft.id, "failed");
    await updateOutboundJobStatus(env, {
      outboundJobId: job.id,
      status: "failed",
      lastError: "manual_send_not_sent_confirmed",
      nextRetryAt: null,
    });
    return json({ ok: true, outboundJobId: job.id, status: "failed", billingResolution: "released" });
  } catch (error) {
    if (error instanceof SiteRequestError) {
      return json({ error: error.message }, { status: error.status });
    }
    return json({ error: error instanceof Error ? error.message : "Unable to resolve outbound job manually" }, { status: 502 });
  }
});
site.on("GET", "/admin/api/drafts", async (request, env) => {
  const accessError = await requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  try {
    const url = new URL(request.url);
    const mailboxId = url.searchParams.get("mailboxId") ?? undefined;
    const status = (url.searchParams.get("status")?.trim() as
      | "draft"
      | "approved"
      | "queued"
      | "sent"
      | "cancelled"
      | "failed"
      | null) ?? undefined;
    const limit = parseSiteListLimit(url.searchParams.get("limit"), 50, 200);
    return json({ items: await listDrafts(env, { mailboxId, status, limit }) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load drafts" }, { status: 502 });
  }
});
site.on("GET", "/admin/api/drafts/:draftId", async (request, env, _ctx, route) => {
  const accessError = await requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  try {
    const draft = await getDraft(env, route.params.draftId);
    if (!draft) {
      return json({ error: "Draft not found" }, { status: 404 });
    }
    return json(draft);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load draft" }, { status: 502 });
  }
});
site.on("POST", "/admin/api/send", async (request, env) => {
  const accessError = await requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  const body = await readJson<{
    mailboxId?: string;
    tenantId?: string;
    from?: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    text?: string;
    html?: string;
    threadId?: string;
    sourceMessageId?: string;
    inReplyTo?: string;
    references?: string[];
    idempotencyKey?: string;
  }>(request);

  if (!body.mailboxId || !body.tenantId || !body.from || !body.to?.length || !body.subject) {
    return badRequest("mailboxId, tenantId, from, to, and subject are required");
  }
  if (!body.text && !body.html) {
    return badRequest("text or html is required");
  }
  const normalizedFrom = body.from.trim().toLowerCase();
  if (!normalizedFrom) {
    return badRequest("from must be a non-empty string");
  }

  const idempotencyKey = body.idempotencyKey?.trim();
  if (body.idempotencyKey !== undefined && !idempotencyKey) {
    return badRequest("idempotencyKey must be a non-empty string");
  }
  const mailboxId = body.mailboxId;
  const tenantId = body.tenantId;
  let sideEffectCommitted = false;

  try {
    const validateAdminSendInput = async () => {
      const mailbox = await getMailboxById(env, mailboxId);
      if (!mailbox) {
        return json({ error: "Mailbox not found" }, { status: 404 });
      }
      if (mailbox.tenant_id !== tenantId) {
        return json({ error: "Mailbox does not belong to tenant" }, { status: 409 });
      }
      if (mailbox.status !== "active") {
        return json({ error: "Mailbox is not active" }, { status: 409 });
      }
      if (normalizedFrom !== mailbox.address.toLowerCase()) {
        return json({ error: "from must match the mailbox address" }, { status: 409 });
      }

      await validateAdminSendReferences(env, {
        tenantId,
        mailboxId,
        threadId: body.threadId,
        sourceMessageId: body.sourceMessageId,
      });

      const policyDecision = await evaluateOutboundPolicy(env, {
        tenantId,
        agentId: "admin_console",
        to: body.to ?? [],
        cc: body.cc ?? [],
        bcc: body.bcc ?? [],
      });
      if (!policyDecision.ok) {
        const status = policyDecision.code === "daily_quota_exceeded" || policyDecision.code === "hourly_quota_exceeded"
          ? 429
          : 403;
        return json({ error: policyDecision.message ?? "Outbound policy denied this send request" }, { status });
      }

      const creditCheck = await checkOutboundCreditRequirement(env, {
        tenantId,
        to: body.to ?? [],
        cc: body.cc ?? [],
        bcc: body.bcc ?? [],
        sourceMessageId: body.sourceMessageId,
        createdVia: "site:admin_send",
      });
      if (!creditCheck.hasSufficientCredits) {
        return json({
          error: `Insufficient credits for external sending. Required: ${creditCheck.creditsRequired}, available: ${creditCheck.availableCredits ?? 0}`,
        }, { status: 402 });
      }

      return null;
    };

    if (!idempotencyKey) {
      const validationError = await validateAdminSendInput();
      if (validationError) {
        return validationError;
      }
    }

    if (idempotencyKey) {
      const reservation = await reserveIdempotencyKey(env, {
        operation: "admin_send",
        tenantId,
        idempotencyKey,
        requestFingerprint: JSON.stringify({
          mailboxId,
          tenantId,
          from: body.from,
          to: body.to,
          cc: body.cc ?? [],
          bcc: body.bcc ?? [],
          subject: body.subject,
          text: body.text ?? "",
          html: body.html ?? "",
          threadId: body.threadId ?? null,
          sourceMessageId: body.sourceMessageId ?? null,
          inReplyTo: body.inReplyTo ?? null,
          references: body.references ?? [],
        }),
      });

      if (reservation.status === "conflict") {
        return json({ error: "Idempotency key is already used for a different admin send request" }, { status: 409 });
      }
      if (reservation.status === "pending") {
        if (reservation.record.resourceId) {
          const validationError = await validateAdminSendInput();
          if (validationError) {
            return validationError;
          }
          const response = await restoreAdminSendReplay(env, reservation.record.resourceId);
          await bestEffortCompleteRecoveredIdempotency(env, {
            operation: "admin_send",
            tenantId,
            idempotencyKey,
            resourceId: response.outboundJobId,
            response,
          });
          return json(response);
        }
        return json({ error: "An admin send request with this idempotency key is already in progress" }, { status: 409 });
      }
      if (reservation.status === "completed") {
        const validationError = await validateAdminSendInput();
        if (validationError) {
          return validationError;
        }
        if (reservation.record.response) {
          return json(reservation.record.response);
        }

        return json(await restoreAdminSendReplay(env, reservation.record.resourceId));
      }

      const validationError = await validateAdminSendInput();
      if (validationError) {
        await releaseIdempotencyKey(env, "admin_send", tenantId, idempotencyKey).catch(() => undefined);
        return validationError;
      }
    }

    const draft = await createDraft(env, {
      tenantId,
      agentId: "admin_console",
      mailboxId,
      threadId: body.threadId,
      sourceMessageId: body.sourceMessageId,
      createdVia: "site:admin_send",
      payload: {
        from: normalizedFrom,
        to: body.to,
        cc: body.cc ?? [],
        bcc: body.bcc ?? [],
        subject: body.subject,
        text: body.text ?? "",
        html: body.html ?? "",
        inReplyTo: body.inReplyTo,
        references: body.references ?? [],
        attachments: [],
      },
    });
    sideEffectCommitted = true;
    if (idempotencyKey) {
      await updateIdempotencyKeyResource(env, {
        operation: "admin_send",
        tenantId,
        idempotencyKey,
        resourceId: draft.id,
      });
    }
    const result = await enqueueDraftSend(env, draft.id);
    const response = {
      ok: true,
      draftId: draft.id,
      outboundJobId: result.outboundJobId,
      status: result.status,
    };

    if (idempotencyKey) {
      await updateIdempotencyKeyResource(env, {
        operation: "admin_send",
        tenantId,
        idempotencyKey,
        resourceId: result.outboundJobId,
      });
      await completeIdempotencyKey(env, {
        operation: "admin_send",
        tenantId,
        idempotencyKey,
        resourceId: result.outboundJobId,
        response,
      });
    }

    return json(response);
  } catch (error) {
    if (idempotencyKey && !sideEffectCommitted) {
      await releaseIdempotencyKey(env, "admin_send", tenantId, idempotencyKey).catch(() => undefined);
    }
    if (sideEffectCommitted) {
      return json({
        error: "Request may have partially succeeded after creating server-side state. Retry only with the same idempotency key or inspect draft/outbound state before retrying.",
      }, { status: 409 });
    }
    if (error instanceof SiteRequestError) {
      return json({ error: error.message }, { status: error.status });
    }
    return json({ error: error instanceof Error ? error.message : "Unable to send message" }, { status: 502 });
  }
});

site.on("POST", "/admin/api/maintenance/idempotency-cleanup", async (request, env) => {
  const accessError = await requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  try {
    const result = await runIdempotencyCleanupNow(env);
    return json({
      ok: true,
      deleted: result.deleted,
      completedRetentionHours: result.completedRetentionHours,
      pendingRetentionHours: result.pendingRetentionHours,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to clean idempotency keys" }, { status: 502 });
  }
});

site.on("GET", "/admin/api/maintenance/idempotency-keys", async (request, env) => {
  const accessError = await requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  try {
    const url = new URL(request.url);
    const operation = url.searchParams.get("operation")?.trim() || undefined;
    const statusParam = url.searchParams.get("status")?.trim();
    const status = statusParam === "pending" || statusParam === "completed" ? statusParam : undefined;
    const limit = parseSiteListLimit(url.searchParams.get("limit"), 50, 200);

    return json({
      items: await listIdempotencyRecords(env, {
        operation,
        status,
        limit,
      }),
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load idempotency keys" }, { status: 502 });
  }
});

export async function handleSiteRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  try {
    const response = await site.handle(request, env, ctx);
    return response ? applyAdminApiResponseHeaders(request, response) : null;
  } catch (error) {
    if (error instanceof InvalidJsonBodyError) {
      return applyAdminApiResponseHeaders(request, badRequest(error.message));
    }
    if (error instanceof SiteRequestError) {
      return applyAdminApiResponseHeaders(request, json({ error: error.message }, { status: error.status }));
    }

    throw error;
  }
}

function readCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return null;
  }

  for (const entry of cookieHeader.split(";")) {
    const [rawName, ...rawValueParts] = entry.trim().split("=");
    if (rawName !== name) {
      continue;
    }

    const rawValue = rawValueParts.join("=");
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue || null;
    }
  }

  return null;
}

interface SiteAdminSessionValidation {
  viaHeader: boolean;
}

function toBase64Url(input: Uint8Array): string {
  let binary = "";
  for (const byte of input) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function importSiteAdminSessionKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signSiteAdminSession(secret: string, payload: string): Promise<string> {
  const key = await importSiteAdminSessionKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload));
  return toBase64Url(new Uint8Array(signature));
}

async function verifySiteAdminSession(secret: string, payload: string, signature: string): Promise<boolean> {
  try {
    const key = await importSiteAdminSessionKey(secret);
    return await crypto.subtle.verify("HMAC", key, fromBase64Url(signature), textEncoder.encode(payload));
  } catch {
    return false;
  }
}

async function readValidSiteAdminSession(request: Request, env: Env): Promise<SiteAdminSessionValidation | null> {
  if (!env.ADMIN_API_SECRET) {
    return null;
  }

  const headerSecret = request.headers.get("x-admin-secret");
  if (headerSecret === env.ADMIN_API_SECRET) {
    return { viaHeader: true };
  }

  const token = readCookie(request, SITE_ADMIN_SESSION_COOKIE);
  if (!token) {
    return null;
  }

  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    return null;
  }

  const valid = await verifySiteAdminSession(env.ADMIN_API_SECRET, payload, signature);
  if (!valid) {
    return null;
  }

  try {
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as {
      scope?: string;
      exp?: number;
    };
    if (claims.scope !== "site-admin" || typeof claims.exp !== "number") {
      return null;
    }
    if (claims.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return { viaHeader: false };
  } catch {
    return null;
  }
}

async function hasValidSiteAdminSession(request: Request, env: Env): Promise<boolean> {
  return Boolean(await readValidSiteAdminSession(request, env));
}

async function buildSiteAdminSessionCookie(url: URL, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = toBase64Url(textEncoder.encode(JSON.stringify({
    scope: "site-admin",
    iat: now,
    exp: now + SITE_ADMIN_SESSION_TTL_SECONDS,
  })));
  const signature = await signSiteAdminSession(secret, payload);
  const token = `${payload}.${signature}`;
  const parts = [
    `${SITE_ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SITE_ADMIN_SESSION_TTL_SECONDS}`,
  ];

  if (url.protocol === "https:") {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function buildExpiredSiteAdminSessionCookie(url: URL): string {
  const parts = [
    `${SITE_ADMIN_SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];

  if (url.protocol === "https:") {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function isSafeRequestMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function parseSiteListLimit(raw: string | null, fallback: number, max: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.min(Math.trunc(parsed), max));
}

function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    return false;
  }

  return origin === new URL(request.url).origin;
}

async function requireSiteAdminAccess(request: Request, env: Env): Promise<Response | null> {
  const routeError = requireAdminRoutesEnabled(request, env);
  if (routeError) {
    return routeError;
  }

  if (!env.ADMIN_API_SECRET) {
    return json({ error: "ADMIN_API_SECRET is not configured" }, { status: 500 });
  }

  const session = await readValidSiteAdminSession(request, env);
  if (!session) {
    return json({ error: "Invalid admin secret" }, { status: 401 });
  }

  if (!session.viaHeader && !isSafeRequestMethod(request.method) && !hasSameOrigin(request)) {
    return json({ error: "Admin request origin denied" }, { status: 403 });
  }

  return null;
}

function applyAdminApiResponseHeaders(request: Request, response: Response): Response {
  if (!new URL(request.url).pathname.startsWith("/admin/api/")) {
    return response;
  }

  response.headers.set("cache-control", "private, no-store, max-age=0");
  return response;
}

function html(markup: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  if (!headers.has("cache-control")) {
    headers.set("cache-control", "public, max-age=300");
  }

  return new Response(markup, {
    ...init,
    headers,
  });
}

function text(body: string, contentType: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", contentType);
  if (!headers.has("cache-control")) {
    headers.set("cache-control", "public, max-age=300");
  }

  return new Response(body, {
    ...init,
    headers,
  });
}

function redirect(location: string, status = 302): Response {
  return new Response(null, {
    status,
    headers: {
      location,
    },
  });
}

function renderRobots(url: URL): string {
  if (url.host === "api.mailagents.net") {
    return "User-agent: *\nDisallow: /\n";
  }

  const sitemapOrigin = url.host === "www.mailagents.net" ? "https://mailagents.net" : url.origin;
  return `User-agent: *\nAllow: /\nSitemap: ${sitemapOrigin}/sitemap.xml\n`;
}

function renderSitemap(url: URL): string {
  const origin = url.host === "www.mailagents.net" ? "https://mailagents.net" : url.origin;
  const paths = url.host === "api.mailagents.net"
    ? ["/v2/meta/runtime", "/v2/meta/compatibility", "/v2/meta/compatibility/schema", "/CHANGELOG.md"]
    : ["/", "/limits", "/privacy", "/terms", "/contact", "/CHANGELOG.md"];
  const urls = paths.map((pathname) => `  <url><loc>${escapeHtml(origin)}${pathname}</loc></url>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

function layout(active: string, title: string, content: string): string {
  const pageTitle = title === "Mailagents" ? "Mailagents" : `${title} · Mailagents`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="Mailagents is AI-first email infrastructure for agent-native products, with mailbox orchestration, transactional delivery, and a clear request-access onboarding path." />
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=Instrument+Serif:ital@0;1&display=swap');
    :root {
      --bg: #f2ede4;
      --bg-deep: #e6ddd0;
      --panel: rgba(255, 250, 243, 0.82);
      --ink: #1c1916;
      --muted: #62584d;
      --line: rgba(28, 25, 22, 0.12);
      --brand: #b55f33;
      --brand-deep: #22493d;
      --brand-soft: #ead3c2;
      --ok: #1f6a45;
      --shadow: 0 24px 60px rgba(64, 45, 27, 0.14);
      --radius-xl: 28px;
      --radius-lg: 20px;
      --radius-md: 14px;
      --shell: 1180px;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      color: var(--ink);
      font-family: 'Space Grotesk', sans-serif;
      background:
        radial-gradient(circle at top left, rgba(181, 95, 51, 0.18), transparent 30%),
        radial-gradient(circle at right 15%, rgba(34, 73, 61, 0.18), transparent 24%),
        linear-gradient(180deg, #f6f0e7 0%, var(--bg) 58%, var(--bg-deep) 100%);
    }
    a { color: inherit; }
    .shell {
      width: min(calc(100% - 32px), var(--shell));
      margin: 0 auto;
    }
    .site-header {
      border-bottom: 1px solid rgba(28, 25, 22, 0.08);
      background: rgba(250, 246, 239, 0.78);
    }
    .nav {
      display: block;
      padding: 16px 0;
    }
    .wordmark {
      text-decoration: none;
      font-weight: 600;
      letter-spacing: 0.02em;
      font-size: 14px;
    }
    .wordmark span {
      display: inline-block;
      margin-right: 8px;
      padding: 5px 8px;
      border-radius: 999px;
      background: var(--brand);
      color: #fff8f0;
      font-size: 12px;
    }
    .footer-nav {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .footer-nav a {
      text-decoration: none;
      padding: 0;
      border-radius: 0;
      font-size: 13px;
      color: var(--muted);
    }
    .footer-nav a.active,
    .footer-nav a:hover {
      color: var(--ink);
    }
    .footer-nav a:not(:last-child)::after {
      content: "·";
      margin-left: 8px;
      color: rgba(28, 25, 22, 0.32);
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(181, 95, 51, 0.12);
      color: var(--brand-deep);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .lead {
      margin: 0;
      max-width: 58ch;
      color: var(--muted);
      font-size: 17px;
      line-height: 1.8;
    }
    .code {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 12px;
      background: rgba(28, 25, 22, 0.06);
      color: var(--ink);
      font-size: 13px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 11px 16px;
      border-radius: 14px;
      border: 1px solid rgba(28, 25, 22, 0.12);
      background: rgba(255, 255, 255, 0.86);
      color: var(--ink);
      font: inherit;
      text-decoration: none;
      cursor: pointer;
      transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;
    }
    .button:hover {
      transform: translateY(-1px);
      border-color: rgba(28, 25, 22, 0.18);
    }
    .button.primary {
      background: var(--brand-deep);
      border-color: var(--brand-deep);
      color: #f7f1e8;
    }
    .button.secondary {
      background: rgba(255, 255, 255, 0.9);
    }
    main {
      padding: 24px 0 56px;
    }
    .panel.section {
      max-width: 980px;
      margin: 0 auto;
      padding: 30px 34px;
      background: rgba(255, 252, 247, 0.88);
      border: 1px solid rgba(28, 25, 22, 0.08);
      border-radius: var(--radius-xl);
      box-shadow: var(--shadow);
    }
    .panel.section h1,
    .panel.section h2,
    .panel.section h3 {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      letter-spacing: -0.02em;
    }
    .panel.section h1 {
      margin: 14px 0 18px;
      font-size: clamp(32px, 5vw, 52px);
      line-height: 1.05;
    }
    .panel.section h2 {
      margin: 0 0 12px;
      font-size: 24px;
      line-height: 1.2;
    }
    .panel.section h3 {
      margin: 0 0 10px;
      font-size: 19px;
      line-height: 1.25;
    }
    .panel.section p,
    .panel.section li {
      color: var(--ink);
      font-size: 15px;
      line-height: 1.8;
    }
    .panel.section ul,
    .panel.section ol {
      margin: 12px 0;
      padding-left: 22px;
    }
    .panel.section code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      background: rgba(28, 25, 22, 0.06);
      padding: 2px 6px;
      border-radius: 8px;
    }
    .legal {
      display: grid;
      gap: 16px;
    }
    .legal section {
      padding: 24px;
      border-radius: var(--radius-lg);
      border: 1px solid rgba(28, 25, 22, 0.08);
      background: rgba(255, 255, 255, 0.44);
    }
    .legal h2 {
      margin: 0 0 12px;
      font-size: 22px;
    }
    .legal ul {
      margin: 12px 0 0;
      padding-left: 18px;
    }
    .contact-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 18px;
    }
    .section-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 18px;
      margin-bottom: 24px;
    }
    .section-head p {
      margin: 0;
      max-width: 48ch;
      color: var(--muted);
    }
    .card {
      padding: 22px;
      border-radius: var(--radius-lg);
      border: 1px solid rgba(28, 25, 22, 0.08);
      background: rgba(255, 255, 255, 0.5);
      box-shadow: 0 12px 34px rgba(58, 41, 26, 0.08);
    }
    .footer {
      padding: 24px 0 56px;
      color: var(--muted);
      font-size: 13px;
    }
    .footer-nav-wrap {
      margin-top: 10px;
    }
    .markdown-doc {
      max-width: 900px;
      margin: 0 auto;
      padding: 30px 34px;
      background: rgba(255, 252, 247, 0.88);
      border: 1px solid rgba(28, 25, 22, 0.08);
      border-radius: var(--radius-xl);
      box-shadow: var(--shadow);
    }
    .markdown-doc h1,
    .markdown-doc h2,
    .markdown-doc h3 {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      letter-spacing: -0.02em;
    }
    .markdown-doc h1 {
      margin: 0 0 22px;
      max-width: none;
      font-size: clamp(34px, 5vw, 56px);
      line-height: 1.05;
    }
    .markdown-doc h2 {
      margin: 34px 0 12px;
      font-size: 24px;
      line-height: 1.2;
    }
    .markdown-doc h3 {
      margin: 24px 0 10px;
      font-size: 18px;
      line-height: 1.3;
    }
    .markdown-doc p,
    .markdown-doc li {
      color: var(--ink);
      font-size: 15px;
      line-height: 1.8;
    }
    .markdown-doc ul,
    .markdown-doc ol {
      margin: 12px 0;
      padding-left: 22px;
    }
    .markdown-doc pre {
      margin: 16px 0;
      padding: 18px 20px;
      border-radius: 18px;
      background: #181512;
      color: #f8efe5;
      border: 1px solid rgba(28, 25, 22, 0.08);
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 13px;
      line-height: 1.7;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }
    .markdown-doc code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      background: rgba(28, 25, 22, 0.06);
      padding: 2px 6px;
      border-radius: 8px;
    }
    .markdown-doc hr {
      border: 0;
      border-top: 1px solid rgba(28, 25, 22, 0.1);
      margin: 28px 0;
    }
    @media (max-width: 980px) {
      .contact-grid { grid-template-columns: 1fr; }
      .section-head {
        flex-direction: column;
        align-items: flex-start;
      }
    }
    @media (max-width: 680px) {
      .shell {
        width: min(calc(100% - 20px), var(--shell));
      }
      .nav { padding-top: 14px; }
      .markdown-doc { padding: 24px 20px; }
      .panel.section { padding: 24px 20px; }
    }
  </style>
</head>
<body>
  <header class="site-header">
    <div class="shell nav">
      <a class="wordmark" href="/"><span>MA</span>Mailagents</a>
    </div>
  </header>
  <main class="shell">
    ${content}
  </main>
  <footer class="shell footer">
    Mailagents provides transactional email infrastructure, mailbox orchestration, and operator controls for agent-native products.
    <nav class="footer-nav footer-nav-wrap" aria-label="Primary">
      <a class="${active === "overview" ? "active" : ""}" href="/">Overview</a>
      <a class="${active === "limits" ? "active" : ""}" href="/limits">Limits</a>
      <a class="${active === "privacy" ? "active" : ""}" href="/privacy">Privacy</a>
      <a class="${active === "terms" ? "active" : ""}" href="/terms">Terms</a>
      <a class="${active === "contact" ? "active" : ""}" href="/contact">Contact</a>
    </nav>
  </footer>
</body>
</html>`;
}

function renderHome(url: URL): string {
  const isMarketingSite = url.host === "mailagents.net" || url.host === "www.mailagents.net";
  const githubRepo = "https://github.com/haocn-ops/mailagents-email-runtime";
  const agentDocs = "https://github.com/haocn-ops/mailagents-email-runtime/blob/main/docs/llms-agent-guide.md";
  const sdkExamples = "https://github.com/haocn-ops/mailagents-email-runtime/blob/main/docs/agent-sdk-examples.md";
  const compatibilityDoc = "https://github.com/haocn-ops/mailagents-email-runtime/blob/main/docs/runtime-compatibility.md";
  const runtimeMetadata = "https://api.mailagents.net/v2/meta/runtime";
  const compatibilityApi = "https://api.mailagents.net/v2/meta/compatibility";
  const signupApi = "https://api.mailagents.net/public/signup";
  const accessEmail = "hello@mailagents.net";
  return `<article class="markdown-doc">
<h1>Mailagents</h1>

<p>Agent-first email runtime for autonomous agents, tool-calling systems, and agent-native products.</p>

<p>This homepage is intentionally documentation-shaped. It is meant to be easy for an autonomous agent to parse, easy for an agent developer to integrate, and still easy for a human operator to audit.</p>

<hr />

<h2>For Agents First</h2>

<p>If you only read one thing: sign up at <code>${signupApi}</code>, read the inline <code>accessToken</code> from the response, then start with <code>POST /mcp</code> or the mailbox self routes.</p>

<h2>Summary</h2>

<ul>
  <li><strong>Primary audience:</strong> autonomous agents and agent developers</li>
  <li><strong>Service type:</strong> mailbox orchestration plus transactional email runtime</li>
  <li><strong>Recommended first surface:</strong> MCP plus mailbox-scoped self routes</li>
  <li><strong>Registration mode:</strong> API only</li>
  <li><strong>Signup API:</strong> <a href="${signupApi}"><code>${signupApi}</code></a></li>
  <li><strong>Default signup access:</strong> mailbox-scoped bearer token returned inline from signup; operator delivery remains a backup path</li>
  <li><strong>Runtime metadata:</strong> <a href="${runtimeMetadata}"><code>${runtimeMetadata}</code></a></li>
  <li><strong>Compatibility contract:</strong> <a href="${compatibilityApi}"><code>${compatibilityApi}</code></a></li>
  <li><strong>GitHub repo:</strong> <a href="${githubRepo}"><code>${githubRepo}</code></a></li>
  <li><strong>Fallback contact:</strong> <a href="mailto:${accessEmail}">${accessEmail}</a></li>
</ul>

<h2>Choose Your Entry Point</h2>

<p>If you are building for an agent first, start with MCP and mailbox-scoped self routes before reaching for lower-level control paths.</p>

<ul>
  <li><strong>MCP:</strong> best for tool-calling agents. Start with <code>POST /mcp</code>, then call <code>tools/list</code> and use high-level mailbox tools such as <code>list_messages</code>, <code>send_email</code>, <code>reply_to_message</code>, and <code>cancel_draft</code>.</li>
  <li><strong>Quick Start:</strong> best when you want the shortest signup-to-first-message path and want the runtime to stay mailbox-first.</li>
  <li><strong>HTTP API:</strong> best for product and backend integration. Start with <code>${signupApi}</code>, then use mailbox-scoped self routes such as <code>GET /v1/mailboxes/self</code>, <code>GET /v1/mailboxes/self/messages</code>, <code>POST /v1/messages/send</code>, and <code>POST /v1/messages/{messageId}/reply</code>.</li>
</ul>

<h2>HTTP API vs MCP vs SDK</h2>

<ul>
  <li><strong>MCP:</strong> easiest for agent runtimes that want tool discovery, structured tool calls, and a mailbox-first surface.</li>
  <li><strong>HTTP API:</strong> easiest for direct REST integration, backend jobs, and product workflows that already manage HTTP requests explicitly.</li>
  <li><strong>SDK:</strong> easiest when you want typed helpers over the same runtime surfaces. If you are unsure, start with HTTP or MCP first and add an SDK wrapper later.</li>
</ul>

<h2>Recommended By Persona</h2>

<ul>
  <li><strong>Agent developer:</strong> start with <code>POST /mcp</code>, then use <code>tools/list</code>, <code>list_messages</code>, <code>send_email</code>, <code>reply_to_message</code>, and <code>cancel_draft</code>.</li>
  <li><strong>Product integrator:</strong> start with <code>POST ${signupApi}</code>, <code>GET /v1/mailboxes/self</code>, <code>GET /v1/mailboxes/self/messages</code>, <code>POST /v1/messages/send</code>, and <code>POST /v1/messages/{messageId}/reply</code>.</li>
  <li><strong>Advanced operator:</strong> start with runtime metadata, compatibility, explicit draft lifecycle control, token rotation, billing, send policy, and x402 or DID setup only when you need those lower-level paths.</li>
</ul>

<h2>Availability And Constraints</h2>

<p>Mailagents is usable today, but not every operator-facing delivery path has the same reliability profile. Treat operator-channel token delivery and authenticated mailbox-scoped routes as the primary path. Treat external operator-email delivery as constrained until the configured outbound provider and credit-backed outbound policy are both available for the active tenant and region.</p>

<ul>
  <li><strong>Available now:</strong> signup API, mailbox self routes, MCP mailbox tools, authenticated token rotate, and the high-level send/reply routes.</li>
  <li><strong>Constrained:</strong> welcome email to arbitrary external operator inboxes and public token reissue email to arbitrary external inboxes.</li>
  <li><strong>Default free-tier send cap:</strong> ordinary users can send up to <code>10</code> emails per rolling 24 hours and <code>1</code> email per rolling hour until they move beyond the default free tier.</li>
  <li><strong>Recommended fallback:</strong> use <code>POST /v1/auth/token/rotate</code> while the current token is still valid, or <code>POST /public/token/reissue</code> if the token has already expired.</li>
  <li><strong>Unlock guide:</strong> read <a href="/limits">Limits And Access</a> for the current billing, policy, and external-delivery enablement flow.</li>
</ul>

<h2>Intended Use</h2>

<ul>
  <li>Agent inbox provisioning</li>
  <li>Inbound email workflows</li>
  <li>Transactional replies</li>
  <li>Operational notifications tied to active product workflows</li>
</ul>

<h2>Not Supported</h2>

<ul>
  <li>Cold outreach</li>
  <li>Purchased lists</li>
  <li>Bulk newsletters</li>
  <li>Attempts to bypass suppression, bounce, or complaint controls</li>
</ul>

<h2>Signup API</h2>

<p>Agents should provision a mailbox by sending a JSON request to the signup API endpoint at <code>${signupApi}</code>.</p>

<pre><code>POST ${signupApi}
content-type: application/json

{
  "mailboxAlias": "agent-demo",
  "agentName": "Agent Demo",
  "operatorEmail": "operator@example.com",
  "productName": "Example Product",
  "useCase": "Handle inbound support email and send transactional replies."
}</code></pre>

<h3>Signup Request Fields</h3>

<ul>
  <li><code>mailboxAlias</code>: desired local-part under <code>mailagents.net</code></li>
  <li><code>agentName</code>: default agent display name</li>
  <li><code>operatorEmail</code>: operator inbox for welcome and token-reissue email; external delivery may still require verified-recipient setup while the active outbound provider remains constrained</li>
  <li><code>productName</code>: product context used in metadata</li>
  <li><code>useCase</code>: short description of the mailbox workflow</li>
</ul>

<h3>Signup Response</h3>

<p>A successful signup returns mailbox metadata plus the default mailbox-scoped token inline by default. The configured operator channel remains available as a backup delivery path.</p>

<pre><code>{
  "tenantId": "tnt_example",
  "mailboxAddress": "agent-demo@mailagents.net",
  "mailboxId": "mbx_example",
  "agentId": "agt_example",
  "agentVersionId": "agv_example",
  "deploymentId": "agd_example",
  "accessToken": "eyJ...",
  "accessTokenExpiresAt": "2026-04-30T00:00:00.000Z",
  "accessTokenScopes": [
    "task:read",
    "mail:read",
    "draft:create",
    "draft:read",
    "draft:send"
  ],
  "welcomeStatus": "queued"
}</code></pre>

<h2>Quick Start</h2>

<p>If you want the shortest path from signup to a working agent mailbox, use this sequence.</p>
<p>This path intentionally prefers mailbox-scoped self routes and high-level send/reply routes first. Treat explicit draft lifecycle control as the advanced path.</p>

<ol>
  <li>Call the signup API at <code>${signupApi}</code> and save <code>mailboxAddress</code>.</li>
  <li>Read <code>accessToken</code> from the signup response and use it immediately.</li>
  <li>Confirm mailbox context with <code>GET /v1/mailboxes/self</code>.</li>
  <li>Read inbound mail with <code>GET /v1/mailboxes/self/messages</code>.</li>
  <li>If you plan to reach arbitrary external recipients, check <code>GET /v1/billing/account</code> and <a href="/limits">Limits And Access</a> before the first outbound send.</li>
  <li>Send outbound mail with <code>POST /v1/messages/send</code>.</li>
  <li>Keep the returned <code>outboundJobId</code> and poll <code>GET /v1/outbound-jobs/{outboundJobId}</code> until <code>finalDeliveryState</code> becomes <code>sent</code> or <code>failed</code>.</li>
  <li>Reply on-thread with <code>POST /v1/messages/{messageId}/reply</code>.</li>
  <li>Use <code>POST /mcp</code> and <code>tools/list</code> when you want the MCP tool surface instead of direct HTTP.</li>
</ol>

<p>If the signup token expires, call <code>POST /public/token/reissue</code> with <code>mailboxAlias</code> or <code>mailboxAddress</code>. The runtime will email a refreshed mailbox-scoped token only to the original <code>operatorEmail</code>; it never returns the new token to the caller.</p>
<p>If the current token is still valid and the agent wants to rotate proactively without emailing the operator, call <code>POST /v1/auth/token/rotate</code>. That authenticated route can return the new token inline and can optionally deliver it back to the mailbox itself.</p>
<p>The default single-mailbox self-serve token can also be used directly for billing self-service on the same tenant, including <code>POST /v1/billing/topup</code>, <code>POST /v1/billing/upgrade-intent</code>, <code>POST /v1/billing/payment/confirm</code>, and the matching billing read routes.</p>

<h2>Billing And Topup</h2>

<p>If an external send returns an error such as <code>External sending requires available credits</code>, the next step is usually to top up credits on the same tenant with the mailbox-scoped token you already have.</p>

<ul>
  <li><strong>Default free-tier posture:</strong> new tenants start constrained, including the rolling <code>10/day</code> and <code>1/hour</code> ordinary-user cap, until they have usable credits or an explicitly enabled outbound policy.</li>
  <li><strong>Fast unlock:</strong> call <code>POST /v1/billing/topup</code> with the same mailbox-scoped bearer token to request a quote, then submit the signed proof with the <code>payment-signature</code> header.</li>
  <li><strong>Facilitator path:</strong> for <code>exact/eip3009</code>, sign the authorization, submit it inside the x402 proof as <code>payload.authorization</code>, keep the quote <code>resource</code> object in the proof, and use a bytes32 hex nonce. Do not broadcast the same <code>transferWithAuthorization</code> yourself first.</li>
  <li><strong>Readiness check:</strong> after settlement, confirm <code>GET /v1/billing/account</code> shows usable credits before treating external delivery as unlocked.</li>
  <li><strong>Current operator guide:</strong> read <a href="/limits">Limits And Access</a> for the billing and delivery model, then use the detailed <a href="https://github.com/haocn-ops/mailagents-email-runtime/blob/main/docs/x402-real-payment-checklist.md">x402 real payment checklist</a> when you need the full proof format and retry guidance.</li>
</ul>

<h2>Token Lifecycle</h2>

<p>Every new signup issues a mailbox-scoped bearer token and returns it inline by default. The configured operator channel can still receive the welcome delivery, and runtimes can explicitly disable inline return if they need that posture.</p>

<ul>
  <li><strong>Default lifetime:</strong> the signup token expires after 30 days unless the runtime is configured with a different <code>SELF_SERVE_ACCESS_TOKEN_TTL_SECONDS</code> value.</li>
  <li><strong>Expired token:</strong> call <code>POST /public/token/reissue</code>. The API always returns a generic acceptance response and, if the mailbox exists, attempts to email a refreshed token only to the original <code>operatorEmail</code>.</li>
  <li><strong>Still-valid token:</strong> call <code>POST /v1/auth/token/rotate</code>. That authenticated route can return the rotated token inline, deliver it back to the mailbox itself, or do both without emailing the operator.</li>
  <li><strong>Current external delivery constraint:</strong> public reissue email to arbitrary external operator inboxes is not guaranteed until the active outbound provider is fully enabled for external delivery.</li>
  <li><strong>Current session safety:</strong> public reissue does not invalidate the token an agent is already using. Authenticated rotate also leaves the previous token valid for now.</li>
</ul>

<h3>1. Sign Up</h3>

<pre><code>curl -sS -X POST ${signupApi} \
  -H 'content-type: application/json' \
  -d '{
    "mailboxAlias": "agent-demo",
    "agentName": "Agent Demo",
    "operatorEmail": "operator@example.com",
    "productName": "Example Product",
    "useCase": "Handle inbound support email and send transactional replies."
  }'</code></pre>

<p>Save these values from the response:</p>

<ul>
  <li><code>accessToken</code></li>
  <li><code>mailboxAddress</code></li>
  <li><code>tenantId</code>, <code>agentId</code>, and <code>mailboxId</code> only if you plan to use lower-level control-plane routes later</li>
  <li><code>operatorEmail</code> if you want to keep the original recovery destination recorded explicitly</li>
</ul>

<h3>2. Confirm Mailbox Context</h3>

<pre><code>curl -sS https://api.mailagents.net/v1/mailboxes/self \
  -H "authorization: Bearer $TOKEN" | jq</code></pre>

<p>This is the fastest way to confirm which mailbox the current token is bound to before reading or sending mail.</p>

<h3>3. Read Mailbox Messages</h3>

<pre><code>curl -sS https://api.mailagents.net/v1/mailboxes/self/messages \
  -H "authorization: Bearer $TOKEN" | jq</code></pre>

<p>Mailbox-scoped tokens can use the self routes directly. This is the recommended first read path for product or backend integrations.</p>

<h3>4. Send a New Email With The HTTP API</h3>

<pre><code>curl -sS -X POST https://api.mailagents.net/v1/messages/send \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "to": ["recipient@example.com"],
    "subject": "Hello from Mailagents",
    "text": "Sent through the mailbox-scoped HTTP send route.",
    "idempotencyKey": "send-demo-001"
  }' | jq</code></pre>

<p>Keep the accepted response. It returns <code>outboundJobId</code> plus <code>statusCheck.outboundJobPath</code>. Poll <code>GET /v1/outbound-jobs/{outboundJobId}</code> until <code>finalDeliveryState</code> becomes <code>sent</code> or <code>failed</code>.</p>

<h3>5. Reply To An Inbound Message With The HTTP API</h3>

<pre><code>curl -sS -X POST https://api.mailagents.net/v1/messages/REPLACE_WITH_MESSAGE_ID/reply \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "text": "Thanks for your message.",
    "idempotencyKey": "reply-demo-001"
  }' | jq</code></pre>

<h3>6. Discover MCP Tools</h3>

<pre><code>curl -sS ${runtimeMetadata} | jq

curl -sS -X POST https://api.mailagents.net/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list",
    "params": {}
  }' | jq</code></pre>

<p>Use MCP when you want the runtime to show its mailbox-scoped tool surface directly, including <code>list_messages</code>, <code>send_email</code>, <code>reply_to_message</code>, and <code>cancel_draft</code>.</p>

<h3>7. Read Mailbox Messages With MCP</h3>

<pre><code>curl -sS -X POST https://api.mailagents.net/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "list_messages",
      "arguments": {
        "limit": 10,
        "direction": "inbound"
      }
    }
  }'</code></pre>

<h3>8. Send A New Email With MCP</h3>

<pre><code>curl -sS -X POST https://api.mailagents.net/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "send_email",
      "arguments": {
        "to": ["recipient@example.com"],
        "subject": "Hello from Mailagents",
        "text": "This message was sent with the mailbox-scoped MCP tool.",
        "idempotencyKey": "send-demo-001"
      }
    }
  }' | jq</code></pre>

<h3>9. Reply To An Inbound Message With MCP</h3>

<pre><code>curl -sS -X POST https://api.mailagents.net/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "reply_to_message",
      "arguments": {
        "messageId": "REPLACE_WITH_MESSAGE_ID",
        "text": "Thanks for your message.",
        "idempotencyKey": "reply-demo-001"
      }
    }
  }' | jq</code></pre>

<h3>10. Advanced Draft Control</h3>

<p>When you need explicit lifecycle control, use the draft path as the advanced workflow:</p>

<ul>
  <li><code>create_draft</code> or <code>POST /v1/agents/{agentId}/drafts</code></li>
  <li><code>get_draft</code> or <code>GET /v1/drafts/{draftId}</code></li>
  <li><code>send_draft</code> or <code>POST /v1/drafts/{draftId}/send</code></li>
  <li><code>cancel_draft</code> or <code>DELETE /v1/drafts/{draftId}</code></li>
</ul>

<h3>11. Reissue An Expired Token</h3>

<pre><code>curl -sS -X POST https://api.mailagents.net/public/token/reissue \
  -H 'content-type: application/json' \
  -d '{
    "mailboxAlias": "agent-demo"
  }'</code></pre>

<p>This endpoint always returns a generic acceptance response. If the mailbox exists, a refreshed token is delivered only to the original <code>operatorEmail</code> from signup.</p>
<p>While external outbound delivery remains limited for arbitrary external recipients, treat that path as best-effort unless the destination inbox is on a verified validation path for the active provider.</p>
<p>Abuse controls apply: repeated requests are cooled down per mailbox and rate limited per source IP. The API never returns the token inline.</p>

<h3>12. Rotate A Still-Valid Token</h3>

<pre><code>curl -sS -X POST https://api.mailagents.net/v1/auth/token/rotate \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "delivery": "self_mailbox",
    "mailboxId": "REPLACE_WITH_MAILBOX_ID"
  }'</code></pre>

<p>This route requires a still-valid bearer token. It does not email the operator. By default it returns the rotated token inline; with <code>delivery: "self_mailbox"</code> or <code>"both"</code> it can also send the refreshed token back to the mailbox itself.</p>

<h3>What Signup Creates</h3>

<ol>
  <li>One active mailbox</li>
  <li>One default agent</li>
  <li>One published default version</li>
  <li>One active mailbox deployment</li>
  <li>One default mailbox-scoped access token for read, draft, and send APIs</li>
  <li>Immediate access to MCP mailbox tools such as <code>list_messages</code>, <code>send_email</code>, and <code>reply_to_message</code></li>
  <li>One welcome email through the same outbound runtime used by the product</li>
  <li>One public token reissue path that only emails refreshed tokens to the original operator inbox</li>
  <li>One authenticated token rotate path for agents that already hold a valid token and want to rotate without operator email</li>
</ol>

<h2>Agent Discovery</h2>

<ul>
  <li><a href="${githubRepo}">GitHub repository</a></li>
  <li><a href="${agentDocs}">AI agent guide</a></li>
  ${isMarketingSite ? `<li><a href="${sdkExamples}">Agent SDK examples</a></li>` : ""}
  <li><a href="${compatibilityDoc}">Runtime compatibility docs</a></li>
  <li><a href="${runtimeMetadata}">Live runtime metadata</a></li>
  <li><a href="${compatibilityApi}">Live compatibility contract</a></li>
</ul>

<h2>Operational Guarantees</h2>

<ul>
  <li>Mailbox provisioning is backed by the production runtime, not a demo-only path.</li>
  <li>The signup API returns a mailbox-scoped token when API signing is configured for the environment.</li>
  <li>Expired signup API tokens can be reissued without the old token, but refreshed credentials are only sent to the original operator inbox.</li>
  <li>Still-valid signup API tokens can be rotated without contacting the operator by using the authenticated rotate route.</li>
  <li>Outbound welcome email uses the same queue-backed send flow as other transactional messages.</li>
  <li>Inbound and outbound behavior is constrained by abuse and suppression controls.</li>
  <li>Operator and compliance contacts are published on this site for review.</li>
</ul>

<h2>Machine-Readable Block</h2>

<pre><code>service: Mailagents
category: AI-first email infrastructure
signup_mode: api_only
signup_endpoint: ${signupApi}
signup_default_access:
  token_type: bearer
  scope_model: mailbox_scoped
  default_scopes:
    - task:read
    - mail:read
    - draft:create
    - draft:read
    - draft:send
runtime_metadata: ${runtimeMetadata}
compatibility_contract: ${compatibilityApi}
fallback_contact: ${accessEmail}
intended_use:
  - agent inbox provisioning
  - inbound email workflows
  - transactional delivery
unsupported_use:
  - cold outreach
  - purchased lists
  - bulk newsletters</code></pre>

<h2>Human Contacts</h2>

<ul>
  <li>General: <a href="mailto:hello@mailagents.net">hello@mailagents.net</a></li>
  <li>Security: <a href="mailto:security@mailagents.net">security@mailagents.net</a></li>
  <li>Privacy: <a href="mailto:privacy@mailagents.net">privacy@mailagents.net</a></li>
</ul>

<h2>Policy Pages</h2>

<ul>
  <li><a href="/limits">Limits And Access</a></li>
  <li><a href="/privacy">Privacy Policy</a></li>
  <li><a href="/terms">Terms of Service</a></li>
  <li><a href="/contact">Contact</a></li>
</ul>
</article>`;
}

function renderLimits(): string {
  return `<section class="panel section legal">
    <section>
      <div class="eyebrow">Limits And Access</div>
      <h1>Limits And Access</h1>
      <p class="lead">The current default access model, delivery guardrails, and the safest path to unlock external sending.</p>
      <h2>What Is Available By Default</h2>
      <p>Every signup returns a mailbox-scoped bearer token and an active mailbox. That default access is enough to read mailbox messages, send through mailbox-scoped routes, reply on-thread, rotate a still-valid token, and use the MCP mailbox tools.</p>
      <ul>
        <li>Signup API and inline <code>accessToken</code></li>
        <li>Mailbox self routes such as <code>GET /v1/mailboxes/self</code> and <code>GET /v1/mailboxes/self/messages</code></li>
        <li>High-level send and reply routes such as <code>POST /v1/messages/send</code> and <code>POST /v1/messages/{messageId}/reply</code></li>
        <li>Authenticated token rotation with <code>POST /v1/auth/token/rotate</code></li>
        <li>MCP mailbox tools such as <code>list_messages</code>, <code>send_email</code>, and <code>reply_to_message</code></li>
      </ul>
    </section>
    <section>
      <h2>What Is Limited By Default</h2>
      <p>Mailagents intentionally starts every tenant in a conservative posture. External delivery and some operator-email recovery paths stay limited until the tenant has usable credits or an explicitly enabled external send policy.</p>
      <ul>
        <li>Ordinary free-tier tenants can send up to <strong>10 outbound emails per rolling 24 hours</strong>.</li>
        <li>Ordinary free-tier tenants can send up to <strong>1 outbound email per rolling 1 hour</strong>.</li>
        <li>Welcome email to arbitrary external operator inboxes should be treated as best-effort, not the primary access path.</li>
        <li>Public token reissue email to arbitrary external operator inboxes is not guaranteed while the tenant is still on the default constrained path.</li>
        <li>External-recipient sending is still blocked while the tenant has no usable credits and the outbound policy has not been explicitly enabled.</li>
        <li>Bulk marketing, purchased lists, cold outreach, and suppression bypass are never supported, even after an upgrade.</li>
      </ul>
    </section>
    <section>
      <h2>How To Work Safely While Limited</h2>
      <ul>
        <li>Use the inline <code>accessToken</code> returned by <code>POST /public/signup</code> as the primary bootstrap credential.</li>
        <li>Prefer authenticated token rotation with <code>POST /v1/auth/token/rotate</code> before the current token expires.</li>
        <li>Use the mailbox itself as the system of record for operational messages instead of relying on external operator inbox delivery.</li>
        <li>For external recipients, check <code>GET /v1/billing/account</code> before the first send and treat <code>/limits</code> as the source of truth for credits-first unlock guidance.</li>
      </ul>
    </section>
    <section>
      <h2>How To Unlock External Delivery</h2>
      <p>External delivery follows a credits-first model. The normal unlock paths are adding credits or moving the tenant to an explicitly enabled outbound policy. A suspended outbound policy still hard-blocks delivery.</p>
      <ol>
        <li>Keep using the default mailbox-scoped flow until the mailbox is active and the token is stored safely.</li>
        <li>Use that default single-mailbox self-serve token directly with <code>POST /v1/billing/topup</code> if the tenant needs outbound capacity immediately.</li>
        <li>Or request <code>POST /v1/billing/upgrade-intent</code>; a settled upgrade also grants the configured upgrade credit bundle.</li>
        <li>If a receipt remains <code>pending</code> or <code>verified</code>, retry facilitator settlement with <code>POST /v1/billing/payment/confirm</code>.</li>
        <li>Check <code>GET /v1/billing/account</code> and <code>GET /v1/tenants/{tenantId}/send-policy</code> with the same token before treating arbitrary external delivery as ready.</li>
      </ol>
      <p>Mailagents uses facilitator-backed x402 settlement. In the normal path, proof submission settles immediately. The confirmation endpoint exists only to retry facilitator settlement for a receipt that did not finish on the first attempt.</p>
      <p>The initial quote-style <code>402</code> response does not include a receipt yet. After you resubmit the same billing route with <code>payment-signature</code>, any later facilitator failure <code>402</code> includes the created runtime <code>receiptId</code> so you can inspect it or continue troubleshooting with the matching receipt record.</p>
      <p>For the <code>exact/eip3009</code> path, submit the signed authorization inside the x402 proof and let the facilitator execute settlement. Do not broadcast the same <code>transferWithAuthorization</code> yourself first, or the later facilitator settle can fail because that authorization was already consumed.</p>
    </section>
    <section>
      <h2>States You Will See</h2>
      <ul>
        <li><strong>Default path:</strong> billing is typically <code>free</code>, outbound policy is <code>internal_only</code>, and the ordinary-user send cap is <code>10/day</code> plus <code>1/hour</code> on rolling windows.</li>
        <li><strong>Credits-backed external send:</strong> when <code>availableCredits &gt; 0</code>, external delivery is allowed even if the outbound policy still reports <code>internal_only</code>.</li>
        <li><strong>Upgrade requested:</strong> billing may move to <code>paid_review</code> and outbound policy may move to <code>external_review</code>.</li>
        <li><strong>External delivery enabled:</strong> billing becomes <code>paid_active</code> and outbound policy becomes <code>external_enabled</code>.</li>
        <li><strong>Restricted again:</strong> outbound policy can become <code>suspended</code> if abuse, payment, or deliverability controls require it.</li>
        <li><strong>Async delivery status:</strong> an accepted send is only queued. Use the returned <code>outboundJobId</code> with <code>GET /v1/outbound-jobs/{outboundJobId}</code> and wait for <code>finalDeliveryState</code> to reach <code>sent</code> or <code>failed</code>.</li>
      </ul>
    </section>
    <section>
      <h2>Important Boundaries</h2>
      <ul>
        <li>Credits unlock external delivery, but they do not guarantee unlimited sending to arbitrary recipients.</li>
        <li>External sending remains subject to abuse controls, suppression handling, bounce review, and provider constraints.</li>
        <li>Do not treat a successful send to an internal or previously validated address as proof that all external recipient delivery paths are healthy.</li>
      </ul>
    </section>
    <section>
      <h2>Where To Go Next</h2>
      <ul>
        <li><a href="https://api.mailagents.net/v2/meta/runtime"><code>/v2/meta/runtime</code></a> for live runtime discovery</li>
        <li><a href="https://github.com/haocn-ops/mailagents-email-runtime/blob/main/docs/limits-and-access.md">Limits And Access guide</a> for the longer technical walkthrough</li>
        <li><a href="https://github.com/haocn-ops/mailagents-email-runtime/blob/main/docs/x402-real-payment-checklist.md">x402 real payment checklist</a> for the exact proof shape, topup flow, and settlement troubleshooting</li>
        <li><a href="/contact">Contact</a> if you need help with a constrained tenant or a receipt that needs facilitator settlement retried</li>
      </ul>
    </section>
  </section>`;
}

function renderPrivacy(): string {
  return `<section class="panel section legal">
    <section>
      <div class="eyebrow">Privacy Policy</div>
      <h1>Privacy Policy</h1>
      <p class="lead">How Mailagents handles mailbox metadata, delivery records, support communications, and the operational data needed to run the service.</p>
      <h2>Overview</h2>
      <p>Mailagents processes information needed to operate inbox provisioning, inbound routing, transactional message delivery, account administration, and service security. This includes account information, mailbox metadata, message routing metadata, delivery events, and support communications.</p>
    </section>
    <section>
      <h2>Information We Process</h2>
      <ul>
        <li>Account and profile data such as email address, organization name, and authentication-related metadata.</li>
        <li>Mailbox and workflow configuration data needed to provision inboxes and route messages.</li>
        <li>Email delivery metadata such as sender, recipient, timestamps, provider identifiers, bounce events, and complaint events.</li>
        <li>Message content only when it is required for the service to receive, store, route, or deliver a message on behalf of a customer workflow.</li>
      </ul>
    </section>
    <section>
      <h2>How We Use Information</h2>
      <ul>
        <li>To authenticate users and secure access to inboxes and operator tools.</li>
        <li>To provision, route, send, retry, and audit transactional email workflows.</li>
        <li>To prevent abuse, enforce suppression lists, and investigate delivery incidents.</li>
        <li>To meet legal obligations and respond to valid support or security requests.</li>
      </ul>
    </section>
    <section>
      <h2>Transactional Delivery Boundaries</h2>
      <p>Mailagents is designed for transactional and operational messaging. Customers are expected to use the service for account authentication, workflow notifications, managed mailbox actions, and related system messages. The service is not intended for purchased lists, unsolicited bulk outreach, or general campaign blasting.</p>
    </section>
    <section>
      <h2>Disclosure and Retention</h2>
      <p>Mailagents uses infrastructure providers and subprocessors needed to run the service, including cloud hosting, storage, and email delivery vendors. Data is retained only as long as needed for service operation, security review, contractual commitments, and legal compliance.</p>
    </section>
    <section>
      <h2>Security and Abuse Handling</h2>
      <p>Mailagents maintains technical and operational controls intended to reduce abuse, including scoped access, logging, delivery-event review, and suppression of recipients associated with bounce or complaint signals when appropriate.</p>
    </section>
    <section>
      <h2>Contact</h2>
      <p>Privacy questions can be directed through the contact details listed on the <a href="/contact">contact page</a>.</p>
    </section>
  </section>`;
}

function renderTerms(): string {
  return `<section class="panel section legal">
    <section>
      <div class="eyebrow">Terms of Service</div>
      <h1>Terms of Service</h1>
      <p class="lead">The service boundaries, acceptable use requirements, and enforcement expectations for Mailagents customers and operators.</p>
      <h2>Service Scope</h2>
      <p>Mailagents provides infrastructure for mailbox orchestration, inbound message handling, and transactional email delivery. Use of the service must comply with applicable law, provider policies, and these terms.</p>
    </section>
    <section>
      <h2>Acceptable Use</h2>
      <ul>
        <li>You may only send email to recipients with a direct relationship to your product or workflow.</li>
        <li>You may not use Mailagents for purchased lists, spam, deceptive content, or unsolicited bulk promotions.</li>
        <li>You must honor bounce, complaint, unsubscribe, and suppression requirements where applicable.</li>
        <li>You are responsible for your mailbox content, recipient lists, and downstream workflow actions.</li>
      </ul>
    </section>
    <section>
      <h2>Customer Responsibilities</h2>
      <ul>
        <li>You must maintain a lawful basis and direct relationship for the recipients you message through the service.</li>
        <li>You must provide accurate sender identity information and avoid misleading headers or impersonation.</li>
        <li>You must suspend or correct workflows that create excessive complaints, bounces, or abuse reports.</li>
      </ul>
    </section>
    <section>
      <h2>Suspension and Enforcement</h2>
      <p>Mailagents may suspend or limit accounts that present security, fraud, abuse, or deliverability risk. This includes repeated complaints, invalid recipient collection practices, or attempts to bypass policy controls.</p>
    </section>
    <section>
      <h2>Availability and Changes</h2>
      <p>The service may evolve over time, including changes to features, limits, and integrations. Continued use of the service after updates constitutes acceptance of the updated terms.</p>
    </section>
    <section>
      <h2>Contact</h2>
      <p>Operational and legal questions can be directed through the <a href="/contact">contact page</a>.</p>
    </section>
  </section>`;
}

function renderContact(): string {
  return `<section class="panel section">
    <div class="section-head">
      <div>
        <div class="eyebrow">Contact</div>
        <h1>Reach the team behind Mailagents.</h1>
      </div>
      <p>If you need product information, support, or compliance context for the service, use the channels below.</p>
    </div>
    <div class="contact-grid">
      <section class="card">
        <h3>General inquiries</h3>
        <p>Email <a href="mailto:hello@mailagents.net">hello@mailagents.net</a> for product, onboarding, account, or partnership questions.</p>
      </section>
      <section class="card">
        <h3>Security and abuse</h3>
        <p>Email <a href="mailto:security@mailagents.net">security@mailagents.net</a> for security disclosures, abuse reports, or urgent trust issues.</p>
      </section>
      <section class="card">
        <h3>Privacy requests</h3>
        <p>Email <a href="mailto:privacy@mailagents.net">privacy@mailagents.net</a> for privacy, retention, or personal-data handling questions.</p>
      </section>
      <section class="card">
        <h3>Response expectations</h3>
        <p>Critical security and abuse reports are prioritized first. General support requests are typically handled during standard business hours.</p>
      </section>
      <section class="card">
        <h3>Service posture</h3>
        <p>Mailagents is designed for transactional email and managed mailbox workflows. We do not support unsolicited bulk marketing use cases.</p>
      </section>
      <section class="card">
        <h3>Review context</h3>
        <p>This website describes the live Mailagents product, its intended transactional use, and the public contact channels used for operational and compliance review.</p>
      </section>
    </div>
  </section>`;
}

function renderAdmin(
  url: URL,
  options: {
    initiallyAuthenticated?: boolean;
    authError?: string | null;
    bootstrap?: AdminPageBootstrap | null;
  } = {}
): string {
  const domain = escapeHtml(url.host);
  const hostname = escapeHtml(url.hostname);
  const initiallyAuthenticated = Boolean(options.initiallyAuthenticated);
  const bootstrap = initiallyAuthenticated ? options.bootstrap ?? null : null;
  const initialOverviewStats = bootstrap?.overviewSnapshot ?? null;
  const initialRuntimeMetadata = bootstrap?.runtimeMetadata ?? null;
  const initialAliases = bootstrap?.aliases ?? [];
  const initialAliasAdminAvailable = bootstrap?.aliasAdminAvailable ?? false;
  const initialAliasAdminMessage = bootstrap?.aliasAdminMessage ?? null;
  const authStatusCopy = escapeHtml(options.authError || (initiallyAuthenticated ? "Dashboard unlocked." : "Dashboard is locked."));
  const iconOverview = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M4 12h10"/><path d="M4 17h7"/><path d="M17 12h3"/><path d="M14 17h6"/></svg>`;
  const iconMessages = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="m6.5 8.5 5.5 4.5 5.5-4.5"/></svg>`;
  const iconContact = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="9" r="2.5"/><circle cx="16" cy="8" r="2"/><path d="M3.5 18c.9-2.7 3.1-4 6.5-4s5.6 1.3 6.5 4"/><path d="M14 17c.5-1.8 2-2.8 4.5-2.8 1 0 1.8.2 2.5.6"/></svg>`;
  const iconThreads = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8h8a4 4 0 1 1 0 8H8"/><path d="m8 12-4 4 4 4"/></svg>`;
  const iconAliases = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a4 4 0 0 1 0-6l1.5-1.5a4 4 0 0 1 5.7 5.6L16 12"/><path d="M14 11a4 4 0 0 1 0 6L12.5 18.5a4 4 0 0 1-5.7-5.6L8 12"/></svg>`;
  const iconCompose = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16v4Z"/><path d="m12.5 7.5 4 4"/></svg>`;
  const iconIdempotency = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M7.5 9A6 6 0 0 1 18 10"/><path d="M16.5 15A6 6 0 0 1 6 14"/></svg>`;
  const iconSearch = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;
  const initialRuntimeDomain = initialAliases[0]?.address.split("@")[1] || initialOverviewStats?.domain || hostname;
  const initialConfiguredAliasCount = initialAliases.filter((item) => item.configured).length;
  const initialOverviewHealth = getAdminOverviewHealth(initialOverviewStats, initialAliases, initialAliasAdminAvailable);
  const initialOverviewTab = initialOverviewStats?.recentActivity.some((item) => item.direction === "outbound")
    ? "sending"
    : initialOverviewStats?.recentActivity.some((item) => item.direction === "inbound")
      ? "receiving"
      : "overview";
  const initialOverviewRecipientLabel = initialOverviewTab === "receiving"
    ? "From"
    : initialOverviewTab === "overview"
      ? "Participant"
      : "To";
  const initialOverviewActivityItems = initialOverviewStats
    ? initialOverviewTab === "sending"
      ? initialOverviewStats.recentActivity.filter((item) => item.direction === "outbound")
      : initialOverviewTab === "receiving"
        ? initialOverviewStats.recentActivity.filter((item) => item.direction === "inbound")
        : initialOverviewStats.recentActivity
    : [];
  const initialRuntimeStatusTone = initiallyAuthenticated ? initialOverviewHealth.tone : "neutral";
  const initialRuntimeStatusCopy = initiallyAuthenticated
    ? `${initialOverviewHealth.label}${initialOverviewStats?.generatedAt ? ` · synced ${formatAdminDateTime(initialOverviewStats.generatedAt)}` : ""}`
    : "Waiting for authentication";
  const initialOverviewHeroCopy = initialOverviewStats
    ? `目前共有 ${formatAdminNumber(initialOverviewStats.counts.registeredUsers)} 位註冊用戶、${formatAdminNumber(initialOverviewStats.counts.activeMailboxes)} 個活躍郵箱，累計收信 ${formatAdminNumber(initialOverviewStats.counts.inboundMessages)} 封、發信 ${formatAdminNumber(initialOverviewStats.counts.outboundMessages)} 封。近 7 天新增 ${formatAdminNumber(initialOverviewStats.counts.newUsers7d)} 位用戶，當前仍有 ${formatAdminNumber(initialOverviewStats.counts.pendingQueue)} 個發信任務在隊列中。`
    : initiallyAuthenticated
      ? "正在載入完整運行統計。這個頁面會直接顯示活躍郵箱、收發信量、送達結果與隊列狀態。"
      : "解鎖後會顯示註冊用戶、收發信總量、成功率、近 7 天趨勢，以及需要關注的隊列與送達狀態。";
  const initialOverviewHealthPills = initialOverviewStats
    ? [
        `<span class="admin-chip ${escapeHtml(initialOverviewHealth.tone)}">${escapeHtml(initialOverviewHealth.label)}</span>`,
        `<span class="admin-chip neutral">發信成功率 ${escapeHtml(formatAdminPercent(initialOverviewStats.rates.sendSuccessRate))}</span>`,
        `<span class="admin-chip neutral">送達成功率 ${escapeHtml(formatAdminPercent(initialOverviewStats.rates.deliverySuccessRate))}</span>`,
        `<span class="admin-chip neutral">${escapeHtml(initialAliasAdminAvailable
          ? `已配置別名 ${formatAdminNumber(initialConfiguredAliasCount)}/${formatAdminNumber(initialAliases.length || 4)}`
          : "Alias admin unavailable in local mode")}</span>`,
      ].join("")
    : `<span class="admin-chip neutral">${escapeHtml(initiallyAuthenticated ? "Waiting for runtime metrics" : "Enter the admin secret to inspect runtime metrics")}</span>`;
  const initialOverviewActivityHtml = initialOverviewStats
    ? renderAdminActivityRows(initialOverviewActivityItems)
    : `<div class="admin-table-row">
      <div class="admin-empty-state">${escapeHtml(initiallyAuthenticated ? "Waiting for recent activity." : "Unlock the dashboard to inspect recent activity.")}</div>
      <div></div><div></div><div></div><div></div>
    </div>`;
  const initialOverviewMailRuntime = initialOverviewStats
    ? [
        `<div class="admin-mini-grid">
          <div class="admin-mini-card"><strong>${escapeHtml(formatAdminNumber(initialOverviewStats.counts.newUsers7d))}</strong><span>近 7 日新增</span></div>
          <div class="admin-mini-card"><strong>${escapeHtml(formatAdminNumber(initialOverviewStats.counts.pendingQueue))}</strong><span>發信隊列待處理</span></div>
          <div class="admin-mini-card"><strong>${escapeHtml(formatAdminNumber(initialOverviewStats.counts.pendingDrafts))}</strong><span>草稿待處理</span></div>
          <div class="admin-mini-card"><strong>${escapeHtml(formatAdminNumber(initialOverviewStats.counts.pendingIdempotency))}</strong><span>Pending idempotency</span></div>
        </div>`,
        `<div class="faq-item"><h3>Active domain</h3><p>${escapeHtml(initialRuntimeDomain)}</p></div>`,
        `<div class="faq-item"><h3>Latest registration</h3><p>${escapeHtml(formatAdminDateTime(initialOverviewStats.latest.registrationAt))}</p></div>`,
        `<div class="faq-item"><h3>Latest delivery event</h3><p>${escapeHtml(formatAdminDateTime(initialOverviewStats.latest.deliveryAt))}</p></div>`,
        `<div class="faq-item"><h3>Reply workflow</h3><p>No quick reply prepared.</p></div>`,
      ].join("")
    : initiallyAuthenticated
      ? [
          `<div class="faq-item"><h3>Active domain</h3><p>${escapeHtml(initialRuntimeDomain)}</p></div>`,
          `<div class="faq-item"><h3>Alias coverage</h3><p>${escapeHtml(initialAliasAdminAvailable ? `${formatAdminNumber(initialConfiguredAliasCount)} live public aliases loaded.` : initialAliasAdminMessage || "Alias admin unavailable.")}</p></div>`,
          `<div class="faq-item"><h3>Reply workflow</h3><p>No quick reply prepared.</p></div>`,
        ].join("")
      : "Unlock the dashboard to inspect runtime status.";
  const initialOverviewTrendHtml = initialOverviewStats
    ? renderAdminTrendChart(initialOverviewStats.trend)
    : `<div class="admin-empty-state">${escapeHtml(initiallyAuthenticated ? "Waiting for runtime trend metrics." : "Unlock the dashboard to inspect runtime trends.")}</div>`;
  const initialOverviewQueueHealth = initialOverviewStats
    ? renderAdminBreakdown(initialOverviewStats.distributions.outboundStatuses, "No outbound queue data yet.") +
      `<div class="admin-mini-grid" style="margin-top:16px;">
        <div class="admin-mini-card"><strong>${escapeHtml(formatAdminNumber(initialOverviewStats.counts.retryJobs))}</strong><span>Retry jobs</span></div>
        <div class="admin-mini-card"><strong>${escapeHtml(formatAdminNumber(initialOverviewStats.counts.queuedJobs + initialOverviewStats.counts.sendingJobs))}</strong><span>Queued + sending</span></div>
        <div class="admin-mini-card"><strong>${escapeHtml(formatAdminNumber(initialOverviewStats.counts.pendingDrafts))}</strong><span>Pending drafts</span></div>
        <div class="admin-mini-card"><strong>${escapeHtml(formatAdminNumber(initialOverviewStats.counts.pendingIdempotency))}</strong><span>Pending idempotency</span></div>
      </div>`
    : `<div class="admin-empty-state">${escapeHtml(initiallyAuthenticated ? "Waiting for queue metrics." : "Unlock the dashboard to inspect queue status.")}</div>`;
  const initialOverviewDeliveryHealth = initialOverviewStats
    ? renderAdminBreakdown(initialOverviewStats.distributions.deliveryEvents, "No delivery events yet.") +
      `<div class="admin-mini-grid" style="margin-top:16px;">
        <div class="admin-mini-card"><strong>${escapeHtml(formatAdminPercent(initialOverviewStats.rates.deliverySuccessRate))}</strong><span>Delivery success rate</span></div>
        <div class="admin-mini-card"><strong>${escapeHtml(formatAdminPercent(initialOverviewStats.rates.sendSuccessRate))}</strong><span>Send success rate</span></div>
        <div class="admin-mini-card"><strong>${escapeHtml(formatAdminNumber(initialOverviewStats.counts.bounceEvents))}</strong><span>Bounces</span></div>
        <div class="admin-mini-card"><strong>${escapeHtml(formatAdminNumber(initialOverviewStats.counts.complaintEvents + initialOverviewStats.counts.rejectEvents))}</strong><span>Complaints + rejects</span></div>
      </div>`
    : `<div class="admin-empty-state">${escapeHtml(initiallyAuthenticated ? "Waiting for delivery metrics." : "Unlock the dashboard to inspect delivery status.")}</div>`;
  const initialOverviewTopMailboxes = initialOverviewStats
    ? renderAdminTopMailboxes(initialOverviewStats.topMailboxes)
    : `<div class="admin-empty-state">${escapeHtml(initiallyAuthenticated ? "Waiting for mailbox activity metrics." : "Unlock the dashboard to inspect mailbox activity.")}</div>`;
  const initialOverviewRecentFailures = initialOverviewStats
    ? renderAdminRecentFailures(initialOverviewStats.recentFailures)
    : `<div class="admin-empty-state">${escapeHtml(initiallyAuthenticated ? "Waiting for failure metrics." : "Unlock the dashboard to inspect recent failures.")}</div>`;
  const initialAliasCards = !initialAliasAdminAvailable
    ? `<div class="admin-empty-state">${escapeHtml(initialAliasAdminMessage || "Cloudflare email routing admin is not configured in this environment.")}</div>`
    : initialAliases.length
      ? initialAliases.map((item) =>
          `<div class="faq-item">
            <h3>${escapeHtml(item.address)}</h3>
            <p>${escapeHtml(item.configured ? "Configured" : "Missing")}</p>
            <p>${escapeHtml(item.mode === "internal"
              ? `Internal inbox via worker ${item.worker || "n/a"}`
              : item.destination || "No inbox rule yet")}</p>
          </div>`
        ).join("")
      : `<div class="admin-empty-state">No public aliases configured yet.</div>`;
  const initialToolMeta = initialRuntimeMetadata?.mcp?.tools ?? [];
  const initialHighRiskTools = initialToolMeta.filter((tool) => tool.riskLevel === "high_risk");
  const initialReviewRequiredTools = initialToolMeta.filter((tool) => tool.humanReviewRequired);
  const initialCompositeTools = initialToolMeta.filter((tool) => tool.composite);
  const initialOverviewAiPolicy = initialToolMeta.length
    ? [
        `<div class="faq-item"><h3>High-risk tools</h3><p>${escapeHtml(initialHighRiskTools.length ? initialHighRiskTools.map((tool) => tool.name).join(", ") : "None exposed.")}</p></div>`,
        `<div class="faq-item"><h3>Human review expected</h3><p>${escapeHtml(initialReviewRequiredTools.length ? initialReviewRequiredTools.map((tool) => tool.name).join(", ") : "No tools currently flagged.")}</p></div>`,
        `<div class="faq-item"><h3>Composite workflows</h3><p>${escapeHtml(initialCompositeTools.length ? initialCompositeTools.map((tool) => tool.name).join(", ") : "No composite tools published.")}</p></div>`,
        `<div class="faq-item"><h3>Route gates</h3><p>${escapeHtml(`Admin routes: ${initialRuntimeMetadata?.routes?.adminEnabled ? "enabled" : "disabled"} · Debug routes: ${initialRuntimeMetadata?.routes?.debugEnabled ? "enabled" : "disabled"}`)}</p></div>`,
      ].join("")
    : initiallyAuthenticated
      ? `<div class="admin-empty-state">No MCP risk policy metadata published yet.</div>`
      : "Unlock the dashboard to inspect MCP risk policy.";
  const initialAliasFormStatus = initiallyAuthenticated
    ? initialAliasAdminAvailable
      ? "Loaded live alias routes."
      : initialAliasAdminMessage || "Alias admin unavailable in this environment."
    : "No changes submitted yet.";
  const initialStatUsers = initialOverviewStats ? formatAdminNumber(initialOverviewStats.counts.registeredUsers) : "0";
  const initialStatUsersMeta = initialOverviewStats ? `近 7 日新增 ${formatAdminNumber(initialOverviewStats.counts.newUsers7d)}` : "近 7 日新增 0";
  const initialStatMailboxes = initialOverviewStats ? formatAdminNumber(initialOverviewStats.counts.activeMailboxes) : "0";
  const initialStatMailboxesMeta = initialOverviewStats
    ? `用戶郵箱 ${formatAdminNumber(initialOverviewStats.counts.userMailboxes)} · 公共別名 ${formatAdminNumber(initialOverviewStats.counts.contactMailboxes)}`
    : "不含公共別名";
  const initialStatInbound = initialOverviewStats ? formatAdminNumber(initialOverviewStats.counts.inboundMessages) : "0";
  const initialStatInboundMeta = initialOverviewStats ? `最近收信 ${formatAdminDateTime(initialOverviewStats.latest.inboundAt)}` : "Inbound messages";
  const initialStatOutbound = initialOverviewStats ? formatAdminNumber(initialOverviewStats.counts.outboundMessages) : "0";
  const initialStatOutboundMeta = initialOverviewStats ? `最近發信 ${formatAdminDateTime(initialOverviewStats.latest.outboundAt)}` : "Outbound messages";
  const initialStatSent = initialOverviewStats ? formatAdminNumber(initialOverviewStats.counts.sentJobs) : "0";
  const initialStatSentMeta = initialOverviewStats ? `發信成功率 ${formatAdminPercent(initialOverviewStats.rates.sendSuccessRate)}` : "Queued and completed sends";
  const initialStatFailed = initialOverviewStats ? formatAdminNumber(initialOverviewStats.counts.failedJobs) : "0";
  const initialStatFailedMeta = initialOverviewStats
    ? initialOverviewStats.recentFailures.length
      ? `有 ${formatAdminNumber(initialOverviewStats.recentFailures.length)} 條最近異常`
      : "最近沒有新異常"
    : "Failed outbound jobs";
  const initialStatDelivered = initialOverviewStats ? formatAdminNumber(initialOverviewStats.counts.deliveredEvents) : "0";
  const initialStatDeliveredMeta = initialOverviewStats ? `送達成功率 ${formatAdminPercent(initialOverviewStats.rates.deliverySuccessRate)}` : "Delivery webhook events";
  const initialStatPending = initialOverviewStats ? formatAdminNumber(initialOverviewStats.counts.pendingQueue) : "0";
  const initialStatPendingMeta = initialOverviewStats
    ? `草稿待處理 ${formatAdminNumber(initialOverviewStats.counts.pendingDrafts)} · Idempotency ${formatAdminNumber(initialOverviewStats.counts.pendingIdempotency)}`
    : "Queued / sending / retry";
  return `<style>
    .admin-login-shell {
      min-height: calc(100vh - 220px);
      display: grid;
      place-items: center;
      padding: 32px 0 48px;
    }
    .admin-login-card {
      width: min(100%, 640px);
      padding: 36px;
      border-radius: 32px;
      border: 1px solid rgba(28, 25, 22, 0.08);
      background:
        radial-gradient(circle at top right, rgba(193, 120, 53, 0.16), transparent 32%),
        rgba(255, 251, 245, 0.88);
      box-shadow: 0 30px 80px rgba(58, 41, 26, 0.12);
    }
    .admin-login-grid {
      display: grid;
      gap: 18px;
      grid-template-columns: 1.2fr 0.8fr;
      margin-top: 24px;
    }
    .admin-input,
    .admin-select,
    .admin-textarea {
      width: 100%;
      padding: 12px 14px;
      border-radius: 14px;
      border: 1px solid rgba(28, 25, 22, 0.12);
      font: inherit;
      background: rgba(255, 255, 255, 0.95);
      color: inherit;
      box-sizing: border-box;
    }
    .admin-textarea {
      min-height: 220px;
      resize: vertical;
    }
    .admin-note {
      margin: 10px 0 0;
      color: var(--muted);
      font-size: 14px;
    }
    .admin-tip {
      margin-top: 12px;
      padding: 12px 14px;
      border-radius: 16px;
      border: 1px solid #ead8b5;
      background: #fff6e7;
      color: #86561c;
      font-size: 13px;
      line-height: 1.45;
    }
    .admin-app-shell {
      display: none;
      gap: 24px;
      grid-template-columns: 280px minmax(0, 1fr);
      align-items: start;
      padding: 28px 0 52px;
    }
    .admin-app-shell.ready {
      display: grid;
    }
    .admin-sidebar {
      position: sticky;
      top: 96px;
      display: grid;
      gap: 18px;
      padding: 24px;
      border-radius: 28px;
      border: 1px solid rgba(28, 25, 22, 0.08);
      background:
        linear-gradient(180deg, rgba(255, 247, 238, 0.96), rgba(255, 255, 255, 0.78));
      box-shadow: 0 18px 60px rgba(58, 41, 26, 0.1);
    }
    .admin-sidebar nav {
      display: grid;
      gap: 10px;
    }
    .admin-nav-button {
      width: 100%;
      text-align: left;
      padding: 12px 14px;
      border-radius: 16px;
      border: 1px solid transparent;
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
      transition: background 160ms ease, border-color 160ms ease, transform 160ms ease;
    }
    .admin-nav-button.active {
      background: rgba(193, 120, 53, 0.14);
      border-color: rgba(193, 120, 53, 0.24);
      transform: translateX(4px);
    }
    .admin-nav-button strong {
      display: block;
      font-size: 15px;
      margin-bottom: 4px;
    }
    .admin-nav-button span {
      display: block;
      font-size: 13px;
      color: var(--muted);
    }
    .admin-main {
      min-width: 0;
      display: grid;
      gap: 18px;
    }
    .admin-topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 22px 26px;
      border-radius: 28px;
      border: 1px solid rgba(28, 25, 22, 0.08);
      background: rgba(255, 255, 255, 0.7);
    }
    .admin-topbar-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .admin-status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(61, 130, 90, 0.12);
      color: #26573b;
      font-size: 13px;
      font-weight: 600;
    }
    .admin-status-pill::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: currentColor;
    }
    .admin-view {
      display: none;
      gap: 18px;
    }
    .admin-view.active {
      display: grid;
    }
    .admin-hero-card {
      padding: 28px;
      border-radius: 28px;
      border: 1px solid rgba(28, 25, 22, 0.08);
      background:
        radial-gradient(circle at top right, rgba(193, 120, 53, 0.12), transparent 28%),
        rgba(255, 255, 255, 0.74);
    }
    .admin-kpi-grid,
    .admin-two-column,
    .admin-three-column {
      display: grid;
      gap: 18px;
    }
    .admin-kpi-grid {
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    }
    .admin-two-column {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .admin-three-column {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .admin-three-column > *,
    .admin-two-column > *,
    .admin-kpi-grid > * {
      min-width: 0;
    }
    .admin-kpi {
      padding: 22px;
      border-radius: 22px;
      background: rgba(255, 255, 255, 0.68);
      border: 1px solid rgba(28, 25, 22, 0.08);
    }
    .admin-kpi .label {
      display: block;
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 10px;
    }
    .admin-kpi strong {
      font-size: 32px;
      line-height: 1;
    }
    .admin-kpi small {
      display: block;
      margin-top: 10px;
      color: var(--muted);
      font-size: 12px;
    }
    .admin-card {
      min-width: 0;
      padding: 24px;
      border-radius: 24px;
      border: 1px solid rgba(28, 25, 22, 0.08);
      background: rgba(255, 255, 255, 0.72);
    }
    .admin-card h3 {
      margin: 0 0 12px;
      font-size: 20px;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .admin-card-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 14px;
    }
    .admin-card-header p {
      margin: 0;
      color: var(--muted);
    }
    .admin-list {
      display: grid;
      gap: 12px;
    }
    .admin-muted {
      color: var(--muted);
    }
    .admin-stack {
      display: grid;
      gap: 12px;
    }
    .admin-inline {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }
    .admin-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 14px;
    }
    .admin-hidden {
      display: none;
    }
    .admin-hero-copy {
      max-width: 68ch;
      margin: 0;
    }
    .admin-hero-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 18px;
    }
    .admin-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 9px 14px;
      border-radius: 999px;
      background: rgba(28, 25, 22, 0.06);
      color: #3b352e;
      font-size: 13px;
      font-weight: 600;
    }
    .admin-chip::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: currentColor;
    }
    .admin-chip.success {
      background: rgba(61, 130, 90, 0.12);
      color: #26573b;
    }
    .admin-chip.warning {
      background: rgba(193, 120, 53, 0.16);
      color: #8c511f;
    }
    .admin-chip.neutral {
      background: rgba(28, 25, 22, 0.08);
      color: #635a4f;
    }
    .admin-status-pill.warning {
      background: rgba(193, 120, 53, 0.16);
      color: #8c511f;
    }
    .admin-status-pill.neutral {
      background: rgba(28, 25, 22, 0.08);
      color: #635a4f;
    }
    .admin-breakdown-list {
      display: grid;
      gap: 12px;
    }
    .admin-breakdown-row {
      display: grid;
      gap: 6px;
    }
    .admin-breakdown-meta {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      font-size: 14px;
    }
    .admin-breakdown-meta span:last-child {
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    .admin-breakdown-track {
      width: 100%;
      height: 9px;
      border-radius: 999px;
      background: rgba(28, 25, 22, 0.08);
      overflow: hidden;
    }
    .admin-breakdown-fill {
      display: block;
      height: 100%;
      min-width: 4px;
      border-radius: 999px;
      background: #8a7759;
    }
    .admin-breakdown-fill.inbound {
      background: #4f7a70;
    }
    .admin-breakdown-fill.outbound {
      background: #2d5c8f;
    }
    .admin-breakdown-fill.sent,
    .admin-breakdown-fill.delivery,
    .admin-breakdown-fill.replied,
    .admin-breakdown-fill.success {
      background: #2f7d57;
    }
    .admin-breakdown-fill.failed,
    .admin-breakdown-fill.bounce,
    .admin-breakdown-fill.reject {
      background: #b45c45;
    }
    .admin-breakdown-fill.retry,
    .admin-breakdown-fill.warning,
    .admin-breakdown-fill.complaint {
      background: #c17835;
    }
    .admin-breakdown-fill.queued,
    .admin-breakdown-fill.sending,
    .admin-breakdown-fill.pending,
    .admin-breakdown-fill.normalized,
    .admin-breakdown-fill.tasked,
    .admin-breakdown-fill.ignored,
    .admin-breakdown-fill.unknown {
      background: #7c6b55;
    }
    .admin-chart-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      margin-bottom: 14px;
    }
    .admin-legend-item {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 13px;
    }
    .admin-legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: currentColor;
    }
    .admin-legend-item.registrations {
      color: #8d6844;
    }
    .admin-legend-item.inbound {
      color: #4f7a70;
    }
    .admin-legend-item.outbound {
      color: #2d5c8f;
    }
    .admin-legend-item.sent {
      color: #2f7d57;
    }
    .admin-legend-item.failed {
      color: #b45c45;
    }
    .admin-trend-chart {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 12px;
      align-items: end;
      min-height: 180px;
    }
    .admin-trend-day {
      display: grid;
      gap: 8px;
      min-width: 0;
    }
    .admin-trend-bars {
      height: 132px;
      display: flex;
      align-items: end;
      gap: 4px;
      padding: 12px 8px 8px;
      border-radius: 18px;
      background: linear-gradient(180deg, rgba(255, 249, 242, 0.96), rgba(255, 255, 255, 0.7));
      border: 1px solid rgba(28, 25, 22, 0.06);
    }
    .admin-trend-bar {
      flex: 1 1 0;
      min-height: 4px;
      border-radius: 999px 999px 0 0;
      background: #8d6844;
      opacity: 0.92;
    }
    .admin-trend-bar.registrations {
      background: #8d6844;
    }
    .admin-trend-bar.inbound {
      background: #4f7a70;
    }
    .admin-trend-bar.outbound {
      background: #2d5c8f;
    }
    .admin-trend-bar.sent {
      background: #2f7d57;
    }
    .admin-trend-bar.failed {
      background: #b45c45;
    }
    .admin-trend-label {
      text-align: center;
      font-size: 12px;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    .admin-trend-total {
      text-align: center;
      font-size: 11px;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    .admin-mini-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .admin-mini-card {
      padding: 16px 18px;
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.74);
      border: 1px solid rgba(28, 25, 22, 0.08);
    }
    .admin-mini-card strong {
      display: block;
      font-size: 24px;
      line-height: 1;
      margin-bottom: 6px;
    }
    .admin-mini-card span {
      color: var(--muted);
      font-size: 13px;
    }
    .admin-empty-state {
      color: var(--muted);
      font-size: 14px;
    }
    .admin-login-card {
      border-radius: 30px;
      border-color: rgba(25, 25, 21, 0.1);
      background: #ffffff;
      box-shadow: 0 24px 80px rgba(17, 18, 19, 0.08);
    }
    .admin-app-shell {
      gap: 0;
      grid-template-columns: 316px minmax(0, 1fr);
      padding: 0;
      min-height: calc(100vh - 150px);
      border: 1px solid rgba(25, 25, 21, 0.12);
      border-radius: 34px;
      overflow: hidden;
      background: #fafaf8;
      box-shadow: 0 28px 90px rgba(17, 18, 19, 0.08);
    }
    .admin-sidebar {
      position: static;
      align-self: stretch;
      gap: 14px;
      padding: 18px 16px 16px;
      border: 0;
      border-right: 1px solid rgba(25, 25, 21, 0.1);
      border-radius: 0;
      background: #ffffff;
      box-shadow: none;
      grid-template-rows: auto 1fr auto;
    }
    .admin-sidebar-brand {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 6px 10px 12px;
    }
    .admin-sidebar-account {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .admin-brand-mark,
    .admin-footer-avatar {
      width: 36px;
      height: 36px;
      flex: none;
      display: grid;
      place-items: center;
      border-radius: 12px;
      background: linear-gradient(145deg, #141414, #6a4cff);
      color: #ffffff;
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    .admin-sidebar-copy,
    .admin-footer-copy {
      min-width: 0;
      display: grid;
      gap: 2px;
    }
    .admin-sidebar-copy strong,
    .admin-footer-copy strong {
      font-size: 15px;
    }
    .admin-sidebar-kicker,
    .admin-footer-copy span {
      color: #6a6a63;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .admin-sidebar nav {
      gap: 4px;
    }
    .admin-nav-button {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      border-radius: 18px;
      border: 1px solid transparent;
      font-size: 15px;
      transition: background 160ms ease, border-color 160ms ease;
    }
    .admin-nav-button:hover {
      background: #f5f5f2;
    }
    .admin-nav-button.active {
      background: #f0f0ed;
      border-color: #e2e2dc;
      transform: none;
    }
    .admin-nav-icon {
      width: 20px;
      height: 20px;
      flex: none;
      color: #5c5c55;
    }
    .admin-nav-copy {
      min-width: 0;
      display: grid;
      gap: 2px;
      text-align: left;
    }
    .admin-nav-button strong {
      margin: 0;
      font-size: 14px;
      color: #1f1f1d;
    }
    .admin-nav-button span {
      margin: 0;
      font-size: 12px;
      color: #74746c;
    }
    .admin-sidebar-footer {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 10px 8px;
      border-top: 1px solid rgba(25, 25, 21, 0.08);
    }
    .admin-footer-avatar {
      width: 34px;
      height: 34px;
      border-radius: 999px;
      background: #f1f1ec;
      color: #343430;
    }
    .admin-footer-menu {
      margin-left: auto;
      color: #76766d;
      font-size: 20px;
      line-height: 1;
    }
    .admin-main {
      gap: 0;
      background: #fafaf8;
    }
    .admin-topbar {
      padding: 20px 28px;
      border: 0;
      border-bottom: 1px solid rgba(25, 25, 21, 0.1);
      border-radius: 0;
      background: #ffffff;
    }
    .admin-topbar-copy {
      display: grid;
      gap: 6px;
    }
    .admin-topbar-copy .eyebrow {
      color: #75756d;
      letter-spacing: 0.08em;
    }
    .admin-topbar-copy h2 {
      margin: 0;
      font-size: 22px;
      line-height: 1.05;
    }
    .admin-topbar-actions {
      align-items: center;
      gap: 14px;
    }
    .admin-toolbar-pill {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      border-radius: 18px;
      background: #f3f3ef;
      border: 1px solid #d8d8d1;
      color: #2c2c29;
      font-size: 14px;
      font-weight: 600;
    }
    .admin-toolbar-keycap {
      display: inline-grid;
      place-items: center;
      width: 26px;
      height: 26px;
      border-radius: 10px;
      background: rgba(25, 25, 21, 0.08);
      color: #6a6a63;
      font-size: 13px;
      font-weight: 700;
    }
    .admin-toolbar-link {
      color: #2c2c29;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
    }
    .admin-topbar .button.secondary,
    .admin-view .button.secondary,
    .admin-view .button.primary {
      border-radius: 16px;
      box-shadow: none;
    }
    .admin-topbar .button.secondary {
      border: 1px solid #d8d8d1;
      background: #f3f3ef;
      color: #2c2c29;
    }
    .admin-view {
      gap: 18px;
      padding: 30px 34px 40px;
      background: #fafaf8;
    }
    .admin-page-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
    }
    .admin-page-title {
      margin: 6px 0 0;
      font-size: clamp(40px, 5vw, 58px);
      line-height: 0.95;
      letter-spacing: -0.04em;
    }
    .admin-summary-strip {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 18px;
      padding: 16px 20px;
      border-radius: 24px;
      border: 1px solid rgba(25, 25, 21, 0.1);
      background: #ffffff;
    }
    .admin-hero-copy {
      margin: 0;
      color: #57574f;
      font-size: 14px;
      line-height: 1.5;
    }
    .admin-hero-pills {
      margin-top: 0;
      justify-content: flex-end;
    }
    .admin-chip,
    .admin-status-pill {
      background: #f2f3ef;
      color: #292926;
      border: 1px solid #d9dad3;
      font-size: 13px;
    }
    .admin-chip.success,
    .admin-status-pill.success {
      background: #e8f6ee;
      color: #16754b;
      border-color: #cfe6d8;
    }
    .admin-chip.warning,
    .admin-status-pill.warning {
      background: #fff3df;
      color: #94601d;
      border-color: #efd9af;
    }
    .admin-chip.neutral,
    .admin-status-pill.neutral {
      background: #f3f3ef;
      color: #57574f;
      border-color: #dfdfd7;
    }
    .admin-tabs-row {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .admin-tab {
      padding: 11px 18px;
      border-radius: 18px;
      border: 1px solid transparent;
      background: transparent;
      color: #31312d;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      transition: background 160ms ease, border-color 160ms ease;
    }
    .admin-tab:hover {
      background: #f2f2ee;
    }
    .admin-tab.active {
      background: #ecece8;
      border-color: #ddddd6;
    }
    .admin-filter-row {
      display: grid;
      grid-template-columns: minmax(0, 2fr) repeat(3, minmax(150px, 0.7fr));
      gap: 12px;
      align-items: center;
    }
    .admin-search-field {
      position: relative;
      display: block;
    }
    .admin-search-icon {
      position: absolute;
      left: 18px;
      top: 50%;
      width: 18px;
      height: 18px;
      color: #6e6e66;
      transform: translateY(-50%);
      pointer-events: none;
    }
    .admin-search-field .admin-input {
      padding-left: 54px;
    }
    .admin-input,
    .admin-select,
    .admin-textarea {
      border-radius: 18px;
      border-color: #d8d8d1;
      background: #f4f4f1;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.75);
    }
    .admin-table-shell {
      border-radius: 24px;
      border: 1px solid #d9d9d3;
      background: #ffffff;
      overflow: hidden;
    }
    .admin-table-header,
    .admin-table-row {
      display: grid;
      grid-template-columns: minmax(240px, 1.7fr) minmax(120px, 0.7fr) minmax(240px, 1.8fr) minmax(130px, 0.8fr) 44px;
      gap: 16px;
      align-items: center;
      padding: 16px 18px;
    }
    .admin-table-header {
      background: #f4f4f1;
      color: #4d4d46;
      font-size: 13px;
      font-weight: 700;
    }
    .admin-table-body {
      display: grid;
    }
    .admin-table-row {
      border-top: 1px solid #efefe9;
      background: #ffffff;
    }
    .admin-table-row:hover {
      background: #fbfbf9;
    }
    .admin-email-recipient,
    .admin-email-subject {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .admin-email-avatar {
      width: 48px;
      height: 48px;
      flex: none;
      display: grid;
      place-items: center;
      border-radius: 16px;
      border: 1px solid #d5ddd6;
      background: linear-gradient(180deg, #ffffff, #f3f8f5);
      color: #4f8a6b;
    }
    .admin-email-avatar svg {
      width: 26px;
      height: 26px;
    }
    .admin-email-lines {
      min-width: 0;
      display: grid;
      gap: 4px;
    }
    .admin-email-primary,
    .admin-email-subject-text {
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 15px;
      font-weight: 600;
      color: #232320;
    }
    .admin-email-secondary {
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: #76766e;
      font-size: 12px;
    }
    .admin-status-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 8px 14px;
      border-radius: 999px;
      border: 1px solid transparent;
      font-size: 13px;
      font-weight: 700;
    }
    .admin-status-badge.delivered,
    .admin-status-badge.sent,
    .admin-status-badge.replied {
      background: #e7f7ec;
      color: #14734a;
      border-color: #cfe8d7;
    }
    .admin-status-badge.received,
    .admin-status-badge.processed,
    .admin-status-badge.normalized {
      background: #edf3ff;
      color: #295ea1;
      border-color: #d3e0fb;
    }
    .admin-status-badge.failed,
    .admin-status-badge.bounced,
    .admin-status-badge.rejected {
      background: #fdebea;
      color: #a14236;
      border-color: #f3cdc8;
    }
    .admin-status-badge.retry,
    .admin-status-badge.warning,
    .admin-status-badge.complaint,
    .admin-status-badge.queued,
    .admin-status-badge.sending {
      background: #fff4df;
      color: #9c651d;
      border-color: #efd8aa;
    }
    .admin-status-badge.ignored,
    .admin-status-badge.tasked {
      background: #f1f1ee;
      color: #66665f;
      border-color: #dfdfd8;
    }
    .admin-time-label {
      color: #4f4f49;
      font-size: 14px;
      white-space: nowrap;
    }
    .admin-icon-button {
      width: 36px;
      height: 36px;
      display: inline-grid;
      place-items: center;
      border-radius: 14px;
      border: 1px solid #d8d8d1;
      background: #f4f4f1;
      color: #51514b;
      cursor: pointer;
    }
    .admin-icon-button svg {
      width: 18px;
      height: 18px;
    }
    .admin-kpi-grid {
      margin-top: 6px;
    }
    .admin-kpi {
      padding: 20px 20px 18px;
      border-radius: 22px;
      background: #ffffff;
      border-color: rgba(25, 25, 21, 0.1);
    }
    .admin-kpi .label {
      color: #72726a;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-size: 11px;
    }
    .admin-kpi strong {
      font-size: 34px;
      letter-spacing: -0.04em;
    }
    .admin-card,
    .admin-hero-card,
    .admin-mini-card {
      background: #ffffff;
      border-color: rgba(25, 25, 21, 0.1);
      box-shadow: none;
    }
    .admin-hero-card {
      display: none;
    }
    .admin-card {
      border-radius: 24px;
    }
    .admin-card-header h3 {
      font-size: 18px;
      margin-bottom: 8px;
    }
    .admin-card-header p,
    .admin-note,
    .admin-muted {
      color: #72726a;
    }
    .admin-list {
      gap: 10px;
    }
    .admin-card .faq-item,
    .admin-list .faq-item {
      padding: 16px 18px;
      border-radius: 18px;
      border: 1px solid #ecece5;
      background: #fcfcfa;
    }
    .admin-card .faq-item h3,
    .admin-list .faq-item h3 {
      margin: 0 0 8px;
      font-size: 15px;
    }
    .admin-card .faq-item p,
    .admin-list .faq-item p {
      margin: 0;
      color: #696962;
      font-size: 13px;
      line-height: 1.45;
    }
    .admin-card .faq-item p + p,
    .admin-list .faq-item p + p {
      margin-top: 6px;
    }
    .admin-view .code {
      border-radius: 16px;
      border: 1px solid #ecece5;
      background: #f7f7f4;
      color: #40403b;
      white-space: pre-wrap;
    }
    .admin-login-card {
      border-color: rgba(110, 93, 255, 0.18);
      background:
        radial-gradient(circle at top right, rgba(107, 92, 255, 0.22), transparent 34%),
        linear-gradient(180deg, #ffffff 0%, #f7f7ff 100%);
      box-shadow: 0 28px 90px rgba(60, 48, 130, 0.12);
    }
    .admin-app-shell {
      background: #f5f6ff;
      border-color: #d8dcf8;
      box-shadow: 0 30px 100px rgba(55, 49, 120, 0.12);
    }
    .admin-sidebar {
      background:
        radial-gradient(circle at top, rgba(255, 255, 255, 0.12), transparent 22%),
        linear-gradient(180deg, #1b1d3f 0%, #382782 48%, #5d45d8 100%);
      border-right-color: rgba(255, 255, 255, 0.12);
    }
    .admin-brand-mark {
      background: linear-gradient(145deg, #ffffff, #d9d8ff);
      color: #4338ca;
      box-shadow: 0 12px 30px rgba(15, 23, 42, 0.22);
    }
    .admin-sidebar-copy strong,
    .admin-footer-copy strong,
    .admin-sidebar .admin-nav-button strong,
    .admin-sidebar .admin-nav-icon {
      color: #f8f8ff;
    }
    .admin-sidebar-kicker,
    .admin-footer-copy span,
    .admin-sidebar .admin-nav-button span,
    .admin-sidebar .admin-footer-menu {
      color: rgba(234, 237, 255, 0.7);
    }
    .admin-sidebar .admin-nav-button:hover {
      background: rgba(255, 255, 255, 0.08);
    }
    .admin-sidebar .admin-nav-button.active {
      background: rgba(255, 255, 255, 0.14);
      border-color: rgba(255, 255, 255, 0.16);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
    }
    .admin-sidebar-footer {
      border-top-color: rgba(255, 255, 255, 0.14);
    }
    .admin-footer-avatar {
      background: rgba(255, 255, 255, 0.14);
      color: #f8f8ff;
    }
    .admin-topbar {
      background: rgba(255, 255, 255, 0.94);
      border-bottom-color: #dde1f8;
      box-shadow: 0 10px 30px rgba(69, 64, 142, 0.05);
    }
    .admin-toolbar-pill {
      background: #eef0ff;
      border-color: #d9defb;
      color: #2f3472;
    }
    .admin-toolbar-keycap {
      background: rgba(72, 64, 168, 0.12);
      color: #5750b6;
    }
    .admin-toolbar-link {
      color: #353b83;
    }
    .admin-topbar .button.secondary,
    .admin-view .button.secondary {
      border-color: #d7ddfb;
      background: #eef1ff;
      color: #353b83;
    }
    .admin-view .button.primary {
      border-color: #5d45d8;
      background: linear-gradient(180deg, #6b5cff 0%, #5743da 100%);
      color: #ffffff;
    }
    .admin-summary-strip {
      border-color: #dce0fb;
      background:
        radial-gradient(circle at right top, rgba(108, 93, 255, 0.14), transparent 30%),
        linear-gradient(180deg, #ffffff 0%, #f7f8ff 100%);
    }
    .admin-chip,
    .admin-status-pill {
      background: #eef1ff;
      color: #353b83;
      border-color: #d7ddfb;
    }
    .admin-chip.success,
    .admin-status-pill.success {
      background: #e6fbf1;
      color: #0f7b4b;
      border-color: #c7efd9;
    }
    .admin-chip.warning,
    .admin-status-pill.warning {
      background: #fff3df;
      color: #9b6218;
      border-color: #f2dbb2;
    }
    .admin-chip.neutral,
    .admin-status-pill.neutral {
      background: #eef1ff;
      color: #5a61a6;
      border-color: #d7ddfb;
    }
    .admin-tab:hover {
      background: #f1f3ff;
    }
    .admin-tab.active {
      background: #edf0ff;
      border-color: #d6dbfb;
      color: #2f3472;
    }
    .admin-input,
    .admin-select,
    .admin-textarea {
      border-color: #d8def7;
      background: #ffffff;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.92),
        0 1px 2px rgba(37, 44, 97, 0.03);
    }
    .admin-input:focus,
    .admin-select:focus,
    .admin-textarea:focus {
      outline: 2px solid rgba(103, 80, 255, 0.16);
      outline-offset: 1px;
      border-color: #a4b0fb;
    }
    .admin-table-shell,
    .admin-card,
    .admin-kpi,
    .admin-mini-card {
      border-color: #dde1f8;
      box-shadow: 0 10px 28px rgba(64, 70, 134, 0.05);
    }
    .admin-table-header {
      background: #f3f5ff;
      color: #4d5698;
    }
    .admin-table-row {
      border-top-color: #eceefb;
    }
    .admin-table-row:hover {
      background: #f9faff;
    }
    .admin-email-avatar {
      border-color: #d8def7;
      background: linear-gradient(180deg, #ffffff, #f0f4ff);
      color: #5863c7;
    }
    .admin-icon-button {
      border-color: #d8def7;
      background: #f4f6ff;
      color: #515ab0;
    }
    .admin-card .faq-item,
    .admin-list .faq-item,
    .admin-view .code {
      border-color: #e5e8fb;
      background: #fafbff;
    }
    .admin-view .code {
      color: #394071;
    }
    @media (max-width: 1100px) {
      .admin-app-shell {
        grid-template-columns: 1fr;
      }
      .admin-sidebar {
        position: static;
      }
      .admin-kpi-grid,
      .admin-three-column,
      .admin-two-column,
      .admin-mini-grid,
      .admin-login-grid {
        grid-template-columns: 1fr;
      }
      .admin-summary-strip,
      .admin-page-header {
        grid-template-columns: 1fr;
        display: grid;
      }
      .admin-filter-row,
      .admin-table-header,
      .admin-table-row {
        grid-template-columns: 1fr;
      }
      .admin-table-header {
        display: none;
      }
      .admin-trend-chart {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
    }
    @media (max-width: 720px) {
      .admin-trend-chart {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
  </style>

  <section id="admin-login-view" class="admin-login-shell"${initiallyAuthenticated ? ' style="display:none;"' : ""}>
    <div class="admin-login-card">
      <div class="eyebrow">Admin Access</div>
      <h1 style="font-size:52px; margin: 10px 0 14px;">Mailagents Control Room</h1>
      <p class="lead" style="max-width: 52ch;">先登錄，再進入後台。這個入口只給運營和管理員使用，會連到你現在已經在跑的郵件資料與轉發規則。</p>
      <div class="admin-login-grid">
        <section class="card">
          <h3>Sign in</h3>
          <p>使用 Worker 上配置的管理密鑰。提交後會由服務端建立後台 session，不再依賴瀏覽器 localStorage。</p>
          <form id="auth-form" method="post" action="/admin/login" autocomplete="off">
            <p><input id="admin-secret" name="secret" class="admin-input" type="password" placeholder="Admin secret" /></p>
            <p><button id="auth-submit" class="button primary" type="submit">Enter Dashboard</button></p>
          </form>
          <p id="auth-status" class="admin-note">${authStatusCopy}</p>
        </section>
        <section class="card">
          <h3>Current scope</h3>
          <p>Domain: <strong>${domain}</strong></p>
          <p>The dashboard manages live mailbox data, outbound queue state, and the public contact aliases shown on the site.</p>
          <div class="code">hello · security · privacy · dmarc</div>
        </section>
      </div>
    </div>
  </section>

  <section id="admin-app-shell" class="admin-app-shell${initiallyAuthenticated ? " ready" : ""}">
    <aside class="admin-sidebar">
      <div class="admin-sidebar-brand">
        <div class="admin-sidebar-account">
          <div class="admin-brand-mark">M</div>
          <div class="admin-sidebar-copy">
            <strong>mailagents</strong>
            <span class="admin-sidebar-kicker">Operations workspace</span>
          </div>
        </div>
        <span class="admin-footer-menu">...</span>
      </div>
      <nav aria-label="Admin sections">
        <button class="admin-nav-button active" data-view="overview" type="button">
          <span class="admin-nav-icon">${iconOverview}</span>
          <span class="admin-nav-copy">
            <strong>Dashboard</strong>
            <span>運行指標與全局狀態</span>
          </span>
        </button>
        <button class="admin-nav-button" data-view="messages" type="button">
          <span class="admin-nav-icon">${iconMessages}</span>
          <span class="admin-nav-copy">
            <strong>Messages</strong>
            <span>郵箱與消息明細</span>
          </span>
        </button>
        <button class="admin-nav-button" data-view="contact" type="button">
          <span class="admin-nav-icon">${iconContact}</span>
          <span class="admin-nav-copy">
            <strong>Contact Inboxes</strong>
            <span>hello / security / privacy / dmarc</span>
          </span>
        </button>
        <button class="admin-nav-button" data-view="threads" type="button">
          <span class="admin-nav-icon">${iconThreads}</span>
          <span class="admin-nav-copy">
            <strong>Threads & Delivery</strong>
            <span>線程、投遞事件、Outbox</span>
          </span>
        </button>
        <button class="admin-nav-button" data-view="aliases" type="button">
          <span class="admin-nav-icon">${iconAliases}</span>
          <span class="admin-nav-copy">
            <strong>Contact Aliases</strong>
            <span>公共郵箱轉發規則</span>
          </span>
        </button>
        <button class="admin-nav-button" data-view="compose" type="button">
          <span class="admin-nav-icon">${iconCompose}</span>
          <span class="admin-nav-copy">
            <strong>Compose</strong>
            <span>後台發件與快速回覆</span>
          </span>
        </button>
        <button class="admin-nav-button" data-view="idempotency" type="button">
          <span class="admin-nav-icon">${iconIdempotency}</span>
          <span class="admin-nav-copy">
            <strong>Idempotency</strong>
            <span>重試鍵、衝突與清理</span>
          </span>
        </button>
      </nav>
      <div class="admin-sidebar-footer">
        <div class="admin-footer-avatar">A</div>
        <div class="admin-footer-copy">
          <strong>admin</strong>
          <span>ops@${hostname}</span>
        </div>
        <span class="admin-footer-menu">...</span>
      </div>
    </aside>

    <div class="admin-main">
      <section class="admin-topbar">
        <div class="admin-topbar-copy">
          <div class="eyebrow">Mailagents Control Room</div>
          <h2 id="admin-view-title">Dashboard</h2>
          <div id="admin-runtime-status" class="admin-status-pill ${escapeHtml(initialRuntimeStatusTone)}">${escapeHtml(initialRuntimeStatusCopy)}</div>
        </div>
        <div class="admin-topbar-actions">
          <span class="admin-toolbar-pill">Feedback <span class="admin-toolbar-keycap">F</span></span>
          <a class="admin-toolbar-link" href="/contact">Help</a>
          <a class="admin-toolbar-link" href="/CHANGELOG.md">Docs</a>
          <a id="refresh-dashboard" class="button secondary" href="/admin">Refresh</a>
          <form method="post" action="/admin/logout" style="margin:0;">
            <button id="logout-dashboard" class="button secondary" type="submit">Log Out</button>
          </form>
        </div>
      </section>

      <section id="admin-view-overview" class="admin-view active">
        <div class="admin-page-header">
          <div>
            <div class="eyebrow">Operations Overview</div>
            <h1 class="admin-page-title">Dashboard</h1>
          </div>
        </div>
        <section class="admin-summary-strip">
          <p id="overview-hero-copy" class="admin-hero-copy">${escapeHtml(initialOverviewHeroCopy)}</p>
          <div id="overview-health-pills" class="admin-hero-pills">${initialOverviewHealthPills}</div>
        </section>
        <div class="admin-tabs-row" role="tablist" aria-label="Overview tabs">
          <button class="admin-tab${initialOverviewTab === "sending" ? " active" : ""}" data-overview-tab="sending" type="button">Outbound</button>
          <button class="admin-tab${initialOverviewTab === "receiving" ? " active" : ""}" data-overview-tab="receiving" type="button">Inbound</button>
          <button class="admin-tab${initialOverviewTab === "overview" ? " active" : ""}" data-overview-tab="overview" type="button">System</button>
        </div>
        <div class="admin-filter-row">
          <label class="admin-search-field">
            <span class="admin-search-icon">${iconSearch}</span>
            <input id="overview-search" class="admin-input" type="text" placeholder="Search subject, mailbox, sender, recipient" />
          </label>
          <select id="overview-time-window" class="admin-select">
            <option value="15">Last 15 days</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </select>
          <select id="overview-status-filter" class="admin-select">
            <option value="">All statuses</option>
          </select>
          <select id="overview-mailbox-filter" class="admin-select">
            <option value="">All mailboxes</option>
          </select>
        </div>
        <section class="admin-table-shell">
          <div class="admin-table-header">
            <span id="overview-recipient-label">${escapeHtml(initialOverviewRecipientLabel)}</span>
            <span>Status</span>
            <span>Subject</span>
            <span>Sent</span>
            <span></span>
          </div>
          <div id="overview-activity-list" class="admin-table-body">${initialOverviewActivityHtml}</div>
        </section>
        <div class="admin-kpi-grid">
          <div class="admin-kpi">
            <span class="label">註冊用戶</span>
            <strong id="stat-users">${escapeHtml(initialStatUsers)}</strong>
            <small id="stat-users-meta">${escapeHtml(initialStatUsersMeta)}</small>
          </div>
          <div class="admin-kpi">
            <span class="label">活躍郵箱</span>
            <strong id="stat-mailboxes">${escapeHtml(initialStatMailboxes)}</strong>
            <small id="stat-mailboxes-meta">${escapeHtml(initialStatMailboxesMeta)}</small>
          </div>
          <div class="admin-kpi">
            <span class="label">收信總量</span>
            <strong id="stat-inbound">${escapeHtml(initialStatInbound)}</strong>
            <small id="stat-inbound-meta">${escapeHtml(initialStatInboundMeta)}</small>
          </div>
          <div class="admin-kpi">
            <span class="label">發信總量</span>
            <strong id="stat-outbound">${escapeHtml(initialStatOutbound)}</strong>
            <small id="stat-outbound-meta">${escapeHtml(initialStatOutboundMeta)}</small>
          </div>
          <div class="admin-kpi">
            <span class="label">成功發信</span>
            <strong id="stat-sent">${escapeHtml(initialStatSent)}</strong>
            <small id="stat-sent-meta">${escapeHtml(initialStatSentMeta)}</small>
          </div>
          <div class="admin-kpi">
            <span class="label">未成功發信</span>
            <strong id="stat-failed">${escapeHtml(initialStatFailed)}</strong>
            <small id="stat-failed-meta">${escapeHtml(initialStatFailedMeta)}</small>
          </div>
          <div class="admin-kpi">
            <span class="label">成功送達</span>
            <strong id="stat-delivered">${escapeHtml(initialStatDelivered)}</strong>
            <small id="stat-delivered-meta">${escapeHtml(initialStatDeliveredMeta)}</small>
          </div>
          <div class="admin-kpi">
            <span class="label">待處理隊列</span>
            <strong id="stat-pending">${escapeHtml(initialStatPending)}</strong>
            <small id="stat-pending-meta">${escapeHtml(initialStatPendingMeta)}</small>
          </div>
        </div>
        <div class="admin-two-column">
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>運行快照</h3>
                <p>帳號、流量、最近活動時間與快捷回覆上下文。</p>
              </div>
            </div>
            <div id="overview-mail-runtime" class="admin-list admin-muted">${initialOverviewMailRuntime}</div>
          </section>
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>近 7 天趨勢</h3>
                <p>註冊、收信、發信、成功與失敗都集中在這裡看。</p>
              </div>
            </div>
            <div id="overview-activity-trend" class="admin-list admin-muted">${initialOverviewTrendHtml}</div>
          </section>
        </div>
        <div class="admin-three-column">
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>發信隊列</h3>
                <p>排隊、重試、草稿與冪等鍵狀態。</p>
              </div>
            </div>
            <div id="overview-queue-health" class="admin-list admin-muted">${initialOverviewQueueHealth}</div>
          </section>
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>送達健康度</h3>
                <p>Delivery、bounce、complaint、reject 分佈。</p>
              </div>
            </div>
            <div id="overview-delivery-health" class="admin-list admin-muted">${initialOverviewDeliveryHealth}</div>
          </section>
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>高活躍郵箱</h3>
                <p>最近累積郵件量最高的前幾個郵箱。</p>
              </div>
            </div>
            <div id="overview-top-mailboxes" class="admin-list admin-muted">${initialOverviewTopMailboxes}</div>
          </section>
        </div>
        <div class="admin-two-column">
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>最近異常</h3>
                <p>優先查看最近失敗的發件任務與錯誤原因。</p>
              </div>
            </div>
            <div id="overview-recent-failures" class="admin-list admin-muted">${initialOverviewRecentFailures}</div>
          </section>
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>Contact aliases</h3>
                <p>面向官網展示的公共地址與實際路由狀態。</p>
              </div>
            </div>
            <div id="overview-alias-status" class="admin-list admin-muted">${initiallyAuthenticated ? initialAliasCards : "Unlock the dashboard to inspect alias status."}</div>
          </section>
        </div>
        <section class="admin-card">
          <div class="admin-card-header">
            <div>
              <h3>AI runtime policy</h3>
              <p>直接查看 MCP 工具的風險分級、是否有副作用，以及哪些動作應該先停下來等人確認。</p>
            </div>
          </div>
          <div id="overview-ai-policy" class="admin-list admin-muted">${initialOverviewAiPolicy}</div>
        </section>
      </section>

      <section id="admin-view-messages" class="admin-view">
        <div class="admin-three-column">
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>Mailboxes</h3>
                <p>選擇一個郵箱載入最近消息。</p>
              </div>
            </div>
            <div id="mailbox-list" class="admin-list">Unlock the dashboard to load mailboxes.</div>
          </section>
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>Recent messages</h3>
                <p>按關鍵詞或方向快速縮小範圍。</p>
              </div>
            </div>
            <div class="admin-stack">
              <input id="message-search" class="admin-input" type="text" placeholder="Search subject, sender, recipient" />
              <select id="message-direction" class="admin-select">
                <option value="">All directions</option>
                <option value="inbound">Inbound</option>
                <option value="outbound">Outbound</option>
              </select>
            </div>
            <div id="message-list" class="admin-list" style="margin-top:16px;">Select a mailbox to load messages.</div>
          </section>
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>Message detail</h3>
                <p>查看正文、附件與回覆上下文。</p>
              </div>
            </div>
            <div id="message-detail" class="admin-list">Choose a message to inspect headers and content.</div>
          </section>
        </div>
      </section>

      <section id="admin-view-contact" class="admin-view">
        <article class="admin-hero-card">
          <div class="eyebrow">Contact Inboxes</div>
          <h2 style="margin:8px 0 10px;">站点公共邮箱的专属工作台</h2>
          <p>这里单独展示 <code>hello@mailagents.net</code>、<code>security@mailagents.net</code>、<code>privacy@mailagents.net</code>、<code>dmarc@mailagents.net</code>，方便直接查看这些对外入口的来信，不用在普通邮箱列表里切换。</p>
        </article>
        <div class="admin-three-column">
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>Inbox shortcuts</h3>
                <p>快速打开三个公共收件箱。</p>
              </div>
            </div>
            <div id="contact-mailbox-list" class="admin-list">Unlock the dashboard to load contact inboxes.</div>
          </section>
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3 id="contact-messages-title">Recent contact messages</h3>
                <p>查看公共邮箱最近收到的邮件。</p>
              </div>
            </div>
            <div id="contact-message-list" class="admin-list">Select a contact inbox to load messages.</div>
          </section>
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>Quick inspection</h3>
                <p>先快速看内容，需要深挖再进 Thread & Delivery。</p>
              </div>
            </div>
            <div id="contact-message-detail" class="admin-list">Choose a contact inbox message to inspect it.</div>
          </section>
        </div>
      </section>

      <section id="admin-view-threads" class="admin-view">
        <div class="admin-two-column">
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>Thread view</h3>
                <p>沿著同一會話線程追蹤上下文。</p>
              </div>
            </div>
            <div id="thread-view" class="admin-list">Choose a message with a thread to inspect the conversation.</div>
          </section>
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>Delivery events</h3>
                <p>查看投遞事件與 provider message id。</p>
              </div>
            </div>
            <div id="delivery-events" class="admin-list">Select an outbound message to inspect delivery events.</div>
          </section>
        </div>
        <div class="admin-two-column">
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>Outbound jobs</h3>
                <p>觀察發件任務並重試失敗項。</p>
              </div>
            </div>
            <select id="job-status" class="admin-select">
              <option value="">All job statuses</option>
              <option value="queued">Queued</option>
              <option value="sending">Sending</option>
              <option value="sent">Sent</option>
              <option value="retry">Retry</option>
              <option value="failed">Failed</option>
            </select>
            <div id="outbound-jobs" class="admin-list" style="margin-top:16px;">Unlock the dashboard to load outbound jobs.</div>
          </section>
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>Drafts & outbox detail</h3>
                <p>草稿、發件箱與單條發件狀態。</p>
              </div>
            </div>
            <select id="draft-status" class="admin-select">
              <option value="">All draft statuses</option>
              <option value="draft">Draft</option>
              <option value="queued">Queued</option>
              <option value="sent">Sent</option>
              <option value="failed">Failed</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <div id="draft-list" class="admin-list" style="margin-top:16px;">Unlock the dashboard to load drafts.</div>
            <div id="outbox-detail" class="admin-list" style="margin-top:16px;">Select a message or draft to inspect its outbound state.</div>
          </section>
        </div>
      </section>

      <section id="admin-view-aliases" class="admin-view">
        <div class="admin-two-column">
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>Create inbox alias</h3>
                <p>把別名接到你自己的 Mailagents 收件箱，不做外部轉發。</p>
              </div>
            </div>
            <form id="alias-form" class="admin-stack">
              <input id="alias-name" class="admin-input" type="text" placeholder="Alias, for example hello" />
              <div class="admin-actions">
                <button class="button primary" type="submit">Create Inbox Alias</button>
              </div>
            </form>
            <p id="alias-status" class="admin-note">${escapeHtml(initialAliasFormStatus)}</p>
          </section>
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>Bootstrap standard aliases</h3>
                <p>一鍵初始化 hello / security / privacy / dmarc，全部直接進後台收件箱。</p>
              </div>
            </div>
            <form id="alias-bootstrap-form" class="admin-stack">
              <label class="admin-inline"><input id="alias-bootstrap-overwrite" type="checkbox" /> overwrite existing alias rules</label>
              <div class="admin-actions">
                <button class="button secondary" type="submit">Create Internal Inboxes</button>
              </div>
            </form>
            <p id="alias-bootstrap-status" class="admin-note">No bootstrap action run yet.</p>
          </section>
        </div>
        <section class="admin-card">
          <div class="admin-card-header">
            <div>
              <h3>Managed aliases</h3>
              <p>公共聯繫郵箱的實際轉發狀態。</p>
            </div>
          </div>
          <div id="alias-list" class="admin-list">${initiallyAuthenticated ? initialAliasCards : "Unlock the dashboard to load aliases."}</div>
        </section>
      </section>

      <section id="admin-view-compose" class="admin-view">
        <div class="admin-two-column">
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>Compose</h3>
                <p>沿用現有 draft 和 outbound queue 鏈路。</p>
              </div>
            </div>
            <form id="send-form" class="admin-stack">
              <select id="send-mailbox" class="admin-select">
                <option value="">Choose mailbox</option>
              </select>
              <input id="send-to" class="admin-input" type="text" placeholder="Recipient email, comma separated" />
              <input id="send-subject" class="admin-input" type="text" placeholder="Subject" />
              <textarea id="send-text" class="admin-textarea" rows="10" placeholder="Plain text body"></textarea>
              <div class="admin-actions">
                <button class="button primary" type="submit">Queue Send</button>
              </div>
            </form>
            <p id="send-status" class="admin-note">No outgoing message queued yet.</p>
          </section>
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>Quick reply</h3>
                <p>從消息詳情裡帶入回覆上下文。</p>
              </div>
            </div>
            <p id="reply-hint">No reply draft prepared.</p>
          </section>
        </div>
      </section>

      <section id="admin-view-idempotency" class="admin-view">
        <div class="admin-two-column">
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>Recent idempotency keys</h3>
                <p>查看最近的 send / replay / admin send 記錄，排查重複提交與衝突。</p>
              </div>
            </div>
            <div class="admin-inline">
              <select id="idempotency-operation" class="admin-select">
                <option value="">All operations</option>
                <option value="draft_send">draft_send</option>
                <option value="message_replay">message_replay</option>
                <option value="admin_send">admin_send</option>
              </select>
              <select id="idempotency-status" class="admin-select">
                <option value="">All statuses</option>
                <option value="pending">pending</option>
                <option value="completed">completed</option>
              </select>
              <button id="idempotency-refresh" class="button secondary" type="button">Refresh Keys</button>
            </div>
            <div id="idempotency-list" class="admin-list" style="margin-top:16px;">Unlock the dashboard to load idempotency records.</div>
          </section>
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>Maintenance</h3>
                <p>立即清掉過期記錄，確認 retention 設置是否符合預期。</p>
              </div>
            </div>
            <div class="admin-stack">
              <p class="admin-note">預設會每小時自動清理一次。這裡可以手動觸發，適合做變更後驗證。</p>
              <div class="admin-actions">
                <button id="idempotency-cleanup" class="button primary" type="button">Run Cleanup Now</button>
              </div>
            </div>
            <div id="idempotency-maintenance" class="admin-list" style="margin-top:16px;">No maintenance action run yet.</div>
          </section>
        </div>
      </section>
    </div>
  </section>

  <script>
    const initiallyAuthenticated = ${JSON.stringify(initiallyAuthenticated)};
    const initialOverviewTab = ${serializeAdminScriptData(initialOverviewTab)};
    const initialOverviewStats = ${serializeAdminScriptData(initialOverviewStats)};
    const initialRuntimeMetadata = ${serializeAdminScriptData(initialRuntimeMetadata)};
    const initialAliases = ${serializeAdminScriptData(initialAliases)};
    const initialAliasAdminAvailable = ${serializeAdminScriptData(initialAliasAdminAvailable)};
    const initialAliasAdminMessage = ${serializeAdminScriptData(initialAliasAdminMessage)};
    const overviewMessageIcon = ${JSON.stringify(iconMessages)};
    const authForm = document.getElementById("auth-form");
    const aliasForm = document.getElementById("alias-form");
    const authStatus = document.getElementById("auth-status");
    const aliasStatus = document.getElementById("alias-status");
    const aliasList = document.getElementById("alias-list");
    const aliasName = document.getElementById("alias-name");
    const aliasBootstrapForm = document.getElementById("alias-bootstrap-form");
    const aliasBootstrapOverwrite = document.getElementById("alias-bootstrap-overwrite");
    const aliasBootstrapStatus = document.getElementById("alias-bootstrap-status");
    const mailboxList = document.getElementById("mailbox-list");
    const messageList = document.getElementById("message-list");
    const messageDetail = document.getElementById("message-detail");
    const messageSearch = document.getElementById("message-search");
    const messageDirection = document.getElementById("message-direction");
    const contactMailboxList = document.getElementById("contact-mailbox-list");
    const contactMessageList = document.getElementById("contact-message-list");
    const contactMessageDetail = document.getElementById("contact-message-detail");
    const contactMessagesTitle = document.getElementById("contact-messages-title");
    const sendForm = document.getElementById("send-form");
    const sendMailbox = document.getElementById("send-mailbox");
    const sendTo = document.getElementById("send-to");
    const sendSubject = document.getElementById("send-subject");
    const sendText = document.getElementById("send-text");
    const sendStatus = document.getElementById("send-status");
    const replyHint = document.getElementById("reply-hint");
    const idempotencyOperation = document.getElementById("idempotency-operation");
    const idempotencyStatus = document.getElementById("idempotency-status");
    const idempotencyRefresh = document.getElementById("idempotency-refresh");
    const idempotencyCleanup = document.getElementById("idempotency-cleanup");
    const idempotencyList = document.getElementById("idempotency-list");
    const idempotencyMaintenance = document.getElementById("idempotency-maintenance");
    const threadView = document.getElementById("thread-view");
    const deliveryEvents = document.getElementById("delivery-events");
    const outboundJobs = document.getElementById("outbound-jobs");
    const jobStatus = document.getElementById("job-status");
    const draftStatus = document.getElementById("draft-status");
    const draftList = document.getElementById("draft-list");
    const outboxDetail = document.getElementById("outbox-detail");
    const loginView = document.getElementById("admin-login-view");
    const appShell = document.getElementById("admin-app-shell");
    const viewTitle = document.getElementById("admin-view-title");
    const refreshDashboard = document.getElementById("refresh-dashboard");
    const logoutDashboard = document.getElementById("logout-dashboard");
    const runtimeStatus = document.getElementById("admin-runtime-status");
    const overviewTabs = Array.from(document.querySelectorAll("[data-overview-tab]"));
    const overviewSearch = document.getElementById("overview-search");
    const overviewTimeWindow = document.getElementById("overview-time-window");
    const overviewStatusFilter = document.getElementById("overview-status-filter");
    const overviewMailboxFilter = document.getElementById("overview-mailbox-filter");
    const overviewRecipientLabel = document.getElementById("overview-recipient-label");
    const overviewActivityList = document.getElementById("overview-activity-list");
    const overviewHeroCopy = document.getElementById("overview-hero-copy");
    const overviewHealthPills = document.getElementById("overview-health-pills");
    const overviewMailRuntime = document.getElementById("overview-mail-runtime");
    const overviewActivityTrend = document.getElementById("overview-activity-trend");
    const overviewQueueHealth = document.getElementById("overview-queue-health");
    const overviewDeliveryHealth = document.getElementById("overview-delivery-health");
    const overviewTopMailboxes = document.getElementById("overview-top-mailboxes");
    const overviewRecentFailures = document.getElementById("overview-recent-failures");
    const overviewAliasStatus = document.getElementById("overview-alias-status");
    const overviewAiPolicy = document.getElementById("overview-ai-policy");
    const statUsers = document.getElementById("stat-users");
    const statUsersMeta = document.getElementById("stat-users-meta");
    const statMailboxes = document.getElementById("stat-mailboxes");
    const statMailboxesMeta = document.getElementById("stat-mailboxes-meta");
    const statInbound = document.getElementById("stat-inbound");
    const statInboundMeta = document.getElementById("stat-inbound-meta");
    const statOutbound = document.getElementById("stat-outbound");
    const statOutboundMeta = document.getElementById("stat-outbound-meta");
    const statSent = document.getElementById("stat-sent");
    const statSentMeta = document.getElementById("stat-sent-meta");
    const statFailed = document.getElementById("stat-failed");
    const statFailedMeta = document.getElementById("stat-failed-meta");
    const statDelivered = document.getElementById("stat-delivered");
    const statDeliveredMeta = document.getElementById("stat-delivered-meta");
    const statPending = document.getElementById("stat-pending");
    const statPendingMeta = document.getElementById("stat-pending-meta");
    const viewMeta = {
      overview: "Dashboard",
      messages: "Messages",
      contact: "Contact Inboxes",
      threads: "Threads & Delivery",
      aliases: "Contact Aliases",
      compose: "Compose",
      idempotency: "Idempotency",
    };
    let currentMailboxId = null;
    let currentContactMailboxId = null;
    let mailboxIndex = [];
    let currentReplyContext = null;
    let latestAliases = Array.isArray(initialAliases) ? initialAliases.slice() : [];
    let latestMessages = [];
    let latestJobs = [];
    let latestRuntimeMetadata = initialRuntimeMetadata;
    let latestOverviewStats = initialOverviewStats;
    let aliasAdminAvailable = initialAliasAdminAvailable;
    let aliasAdminMessage = initialAliasAdminMessage || "";
    let currentOverviewTab = initialOverviewTab;
    async function api(path, init = {}) {
      const headers = new Headers(init.headers || {});
      if (!headers.has("content-type") && init.body) {
        headers.set("content-type", "application/json");
      }

      const response = await fetch(path, {
        ...init,
        headers,
        credentials: "same-origin",
      });
      const raw = await response.text();
      let payload = null;
      if (raw) {
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = { error: raw.slice(0, 500) };
        }
      } else {
        payload = {};
      }
      if (!response.ok) {
        throw new Error(
          (payload && typeof payload.error === 'string' && payload.error) ||
          ('Request failed (' + response.status + ')')
        );
      }
      return payload;
    }

    function esc(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function setView(viewName) {
      document.querySelectorAll(".admin-nav-button").forEach((button) => {
        button.classList.toggle("active", button.getAttribute("data-view") === viewName);
      });
      document.querySelectorAll(".admin-view").forEach((panel) => {
        panel.classList.toggle("active", panel.id === "admin-view-" + viewName);
      });
      if (viewTitle && viewMeta[viewName]) {
        viewTitle.textContent = viewMeta[viewName];
      }
    }

    function setAuthenticated(isAuthenticated) {
      loginView.style.display = isAuthenticated ? "none" : "grid";
      appShell.classList.toggle("ready", isAuthenticated);
    }

    function formatNumber(value) {
      return new Intl.NumberFormat().format(Number(value || 0));
    }

    function formatPercent(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return "n/a";
      }

      const percentage = value * 100;
      const digits = percentage >= 10 || percentage === 0 ? 0 : 1;
      return percentage.toFixed(digits) + "%";
    }

    function formatDateTime(value) {
      if (!value) {
        return "n/a";
      }

      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
    }

    function formatRelativeTime(value) {
      if (!value) {
        return "n/a";
      }

      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        return String(value);
      }

      const diffMs = parsed.getTime() - Date.now();
      const diffMinutes = Math.round(diffMs / 60000);
      const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

      if (Math.abs(diffMinutes) < 60) {
        return formatter.format(diffMinutes, "minute");
      }

      const diffHours = Math.round(diffMinutes / 60);
      if (Math.abs(diffHours) < 48) {
        return formatter.format(diffHours, "hour");
      }

      const diffDays = Math.round(diffHours / 24);
      return formatter.format(diffDays, "day");
    }

    function formatDayLabel(value) {
      const parsed = new Date(value + "T00:00:00Z");
      return Number.isNaN(parsed.getTime())
        ? value.slice(5)
        : parsed.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
    }

    function humanizeLabel(value) {
      const dictionary = {
        received: "Received",
        normalized: "Normalized",
        tasked: "Tasked",
        replied: "Replied",
        ignored: "Ignored",
        failed: "Failed",
        queued: "Queued",
        sending: "Sending",
        retry: "Retry",
        sent: "Sent",
        delivery: "Delivered",
        bounce: "Bounced",
        complaint: "Complaint",
        reject: "Rejected",
        unknown: "Unknown",
      };
      return dictionary[value] || value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
    }

    function getOverviewActivityStatus(item) {
      if (item.direction === "outbound") {
        if (item.deliveryEvent === "delivery") {
          return { label: "Delivered", tone: "delivered" };
        }
        if (item.deliveryEvent === "bounce") {
          return { label: "Bounced", tone: "bounced" };
        }
        if (item.deliveryEvent === "complaint") {
          return { label: "Complaint", tone: "complaint" };
        }
        if (item.deliveryEvent === "reject") {
          return { label: "Rejected", tone: "rejected" };
        }
        if (item.outboundStatus === "sent") {
          return { label: "Sent", tone: "sent" };
        }
        if (item.outboundStatus === "failed") {
          return { label: "Failed", tone: "failed" };
        }
        if (item.outboundStatus === "retry") {
          return { label: "Retry", tone: "retry" };
        }
        if (item.outboundStatus === "sending") {
          return { label: "Sending", tone: "sending" };
        }
        if (item.outboundStatus === "queued") {
          return { label: "Queued", tone: "queued" };
        }
      }

      if (item.messageStatus === "received") {
        return { label: "Received", tone: "received" };
      }
      if (item.messageStatus === "normalized") {
        return { label: "Normalized", tone: "normalized" };
      }
      if (item.messageStatus === "tasked") {
        return { label: "Tasked", tone: "tasked" };
      }
      if (item.messageStatus === "replied") {
        return { label: "Replied", tone: "replied" };
      }
      if (item.messageStatus === "ignored") {
        return { label: "Ignored", tone: "ignored" };
      }
      if (item.messageStatus === "failed") {
        return { label: "Failed", tone: "failed" };
      }

      return { label: "Processed", tone: "processed" };
    }

    function statusTone(value) {
      if (["inbound", "received"].includes(value)) {
        return "inbound";
      }
      if (["outbound"].includes(value)) {
        return "outbound";
      }
      if (["delivery", "replied", "sent"].includes(value)) {
        return "sent";
      }
      if (["failed", "bounce", "reject"].includes(value)) {
        return "failed";
      }
      if (["retry", "complaint"].includes(value)) {
        return "warning";
      }
      return value;
    }

    function renderBreakdown(items, emptyText) {
      if (!items.length) {
        return '<div class="admin-empty-state">' + esc(emptyText) + '</div>';
      }

      const max = Math.max(...items.map((item) => Number(item.count) || 0), 0);
      return '<div class="admin-breakdown-list">' + items.map((item) => {
        const count = Number(item.count) || 0;
        const width = max > 0 ? Math.max(count > 0 ? 6 : 0, count / max * 100) : 0;
        const tone = statusTone(String(item.key || item.label || "").toLowerCase());
        return '<div class="admin-breakdown-row">' +
          '<div class="admin-breakdown-meta">' +
            '<span>' + esc(humanizeLabel(item.label || item.key || "")) + '</span>' +
            '<span>' + esc(formatNumber(count)) + '</span>' +
          '</div>' +
          '<div class="admin-breakdown-track">' +
            '<span class="admin-breakdown-fill ' + esc(tone) + '" style="width:' + width + '%;"></span>' +
          '</div>' +
        '</div>';
      }).join("") + '</div>';
    }

    function renderTrendChart(points) {
      if (!points.length) {
        return '<div class="admin-empty-state">No recent trend data available.</div>';
      }

      const max = Math.max(
        ...points.flatMap((point) => [
          point.registrations || 0,
          point.inbound || 0,
          point.outbound || 0,
          point.sent || 0,
          point.failed || 0,
        ]),
        0
      );

      const legend = [
        ['registrations', '新增'],
        ['inbound', '收信'],
        ['outbound', '發信'],
        ['sent', '成功'],
        ['failed', '失敗'],
      ].map(([key, label]) =>
        '<span class="admin-legend-item ' + key + '"><span class="admin-legend-dot"></span>' + esc(label) + '</span>'
      ).join("");

      const chart = points.map((point) => {
        const series = [
          ['registrations', point.registrations || 0, '新增'],
          ['inbound', point.inbound || 0, '收信'],
          ['outbound', point.outbound || 0, '發信'],
          ['sent', point.sent || 0, '成功'],
          ['failed', point.failed || 0, '失敗'],
        ];
        return '<div class="admin-trend-day">' +
          '<div class="admin-trend-bars">' +
            series.map(([key, count, label]) => {
              const height = max > 0 ? Math.max(count > 0 ? 6 : 0, count / max * 100) : 0;
              return '<span class="admin-trend-bar ' + key + '" style="height:' + height + '%;" title="' + esc(label + ': ' + formatNumber(count)) + '"></span>';
            }).join("") +
          '</div>' +
          '<div class="admin-trend-label">' + esc(formatDayLabel(point.date)) + '</div>' +
          '<div class="admin-trend-total">' + esc('收 ' + formatNumber(point.inbound || 0) + ' · 發 ' + formatNumber(point.outbound || 0)) + '</div>' +
        '</div>';
      }).join("");

      return '<div class="admin-chart-legend">' + legend + '</div><div class="admin-trend-chart">' + chart + '</div>';
    }

    function renderTopMailboxes(items) {
      if (!items.length) {
        return '<div class="admin-empty-state">No mailbox activity recorded yet.</div>';
      }

      return items.map((item) =>
        '<div class="faq-item">' +
          '<h3>' + esc(item.address) + '</h3>' +
          '<p>Total: ' + esc(formatNumber(item.totalMessages)) + '</p>' +
          '<p>Inbound: ' + esc(formatNumber(item.inboundMessages)) + ' · Outbound: ' + esc(formatNumber(item.outboundMessages)) + '</p>' +
        '</div>'
      ).join("");
    }

    function renderRecentFailures(items) {
      if (!items.length) {
        return '<div class="faq-item"><h3>All clear</h3><p>No failed outbound jobs recorded.</p></div>';
      }

      return items.map((item) =>
        '<div class="faq-item">' +
          '<h3>' + esc(item.id) + '</h3>' +
          '<p>Message: ' + esc(item.messageId || 'n/a') + '</p>' +
          '<p>Error: ' + esc(item.lastError || 'unknown') + '</p>' +
          '<p>Updated: ' + esc(formatDateTime(item.updatedAt)) + '</p>' +
        '</div>'
      ).join("");
    }

    function setOverviewTab(tabName) {
      currentOverviewTab = tabName;
      overviewTabs.forEach((button) => {
        button.classList.toggle("active", button.getAttribute("data-overview-tab") === tabName);
      });
      if (overviewRecipientLabel) {
        overviewRecipientLabel.textContent = tabName === "receiving" ? "From" : "To";
      }
      renderOverviewActivity();
    }

    function refreshOverviewFilters() {
      if (!latestOverviewStats || !Array.isArray(latestOverviewStats.recentActivity)) {
        return;
      }

      const items = latestOverviewStats.recentActivity;
      const statuses = Array.from(new Set(items.map((item) => getOverviewActivityStatus(item).label))).sort();
      const mailboxes = Array.from(new Set(items.map((item) => item.mailboxAddress).filter(Boolean))).sort();
      const previousStatus = overviewStatusFilter.value;
      const previousMailbox = overviewMailboxFilter.value;

      overviewStatusFilter.innerHTML = '<option value="">All statuses</option>' + statuses.map((status) =>
        '<option value="' + esc(status) + '">' + esc(status) + '</option>'
      ).join("");
      overviewMailboxFilter.innerHTML = '<option value="">All mailboxes</option>' + mailboxes.map((mailbox) =>
        '<option value="' + esc(mailbox) + '">' + esc(mailbox) + '</option>'
      ).join("");

      overviewStatusFilter.value = statuses.includes(previousStatus) ? previousStatus : "";
      overviewMailboxFilter.value = mailboxes.includes(previousMailbox) ? previousMailbox : "";
    }

    function renderOverviewActivity() {
      if (!overviewActivityList) {
        return;
      }

      if (!latestOverviewStats || !Array.isArray(latestOverviewStats.recentActivity)) {
        overviewActivityList.innerHTML =
          '<div class="admin-table-row">' +
            '<div class="admin-empty-state">Waiting for recent activity.</div>' +
            '<div></div><div></div><div></div><div></div>' +
          '</div>';
        return;
      }

      const searchTerm = overviewSearch.value.trim().toLowerCase();
      const statusValue = overviewStatusFilter.value;
      const mailboxValue = overviewMailboxFilter.value;
      const windowDays = Number(overviewTimeWindow.value || "15");
      const now = Date.now();

      const filteredItems = latestOverviewStats.recentActivity.filter((item) => {
        if (currentOverviewTab === "sending" && item.direction !== "outbound") {
          return false;
        }
        if (currentOverviewTab === "receiving" && item.direction !== "inbound") {
          return false;
        }

        const status = getOverviewActivityStatus(item);
        if (statusValue && status.label !== statusValue) {
          return false;
        }
        if (mailboxValue && item.mailboxAddress !== mailboxValue) {
          return false;
        }
        if (searchTerm) {
          const haystack = [
            item.toAddr,
            item.fromAddr,
            item.subject,
            item.mailboxAddress,
          ].map((value) => String(value || "").toLowerCase()).join("\\n");
          if (!haystack.includes(searchTerm)) {
            return false;
          }
        }
        if (Number.isFinite(windowDays) && item.occurredAt) {
          const occurredAt = new Date(item.occurredAt).getTime();
          if (!Number.isNaN(occurredAt) && now - occurredAt > windowDays * 24 * 60 * 60 * 1000) {
            return false;
          }
        }

        return true;
      });

      if (!filteredItems.length) {
        overviewActivityList.innerHTML =
          '<div class="admin-table-row">' +
            '<div class="admin-empty-state">No activity matches the current filters.</div>' +
            '<div></div><div></div><div></div><div></div>' +
          '</div>';
        return;
      }

      overviewActivityList.innerHTML = filteredItems.map((item) => {
        const status = getOverviewActivityStatus(item);
        const recipient = currentOverviewTab === "receiving" ? (item.fromAddr || "Unknown sender") : (item.toAddr || "Unknown recipient");
        const secondary = item.mailboxAddress || (currentOverviewTab === "receiving" ? item.toAddr : item.fromAddr) || "mail runtime";
        return '<div class="admin-table-row">' +
          '<div class="admin-email-recipient">' +
            '<div class="admin-email-avatar">' + overviewMessageIcon + '</div>' +
            '<div class="admin-email-lines">' +
              '<div class="admin-email-primary">' + esc(recipient) + '</div>' +
              '<div class="admin-email-secondary">' + esc(secondary || "") + '</div>' +
            '</div>' +
          '</div>' +
          '<div><span class="admin-status-badge ' + esc(status.tone.toLowerCase()) + '">' + esc(status.label) + '</span></div>' +
          '<div class="admin-email-subject"><div class="admin-email-subject-text">' + esc(item.subject || "(No subject)") + '</div></div>' +
          '<div class="admin-time-label">' + esc(formatRelativeTime(item.occurredAt)) + '</div>' +
          '<div>' +
            '<button class="admin-icon-button overview-open-message" data-overview-message="' + esc(item.id) + '" data-overview-mailbox="' + esc(item.mailboxId || "") + '" type="button" aria-label="Open message">...</button>' +
          '</div>' +
        '</div>';
      }).join("");

      document.querySelectorAll(".overview-open-message").forEach((button) => {
        button.addEventListener("click", async () => {
          const messageId = button.getAttribute("data-overview-message");
          const mailboxId = button.getAttribute("data-overview-mailbox");
          if (!messageId) {
            return;
          }
          if (mailboxId) {
            currentMailboxId = mailboxId;
          }
          await loadMessageDetail(messageId);
        });
      });
    }

    function getOverviewHealth(stats) {
      if (!stats) {
        return {
          tone: "neutral",
          label: "Waiting for runtime metrics",
        };
      }

      const hasAliasGap = aliasAdminAvailable && latestAliases.some((item) => !item.configured);
      const hasQueuePressure = stats.counts.retryJobs > 0 || stats.counts.pendingQueue > 0;
      const hasFailures = stats.recentFailures.length > 0 || stats.counts.failedJobs > 0;

      if (hasAliasGap || hasQueuePressure || hasFailures) {
        return {
          tone: "warning",
          label: "Runtime needs attention",
        };
      }

      return {
        tone: "success",
        label: "Runtime healthy",
      };
    }

    function setRuntimeStatusTone(health, updatedAt) {
      runtimeStatus.classList.remove("warning", "neutral");
      if (health.tone === "warning" || health.tone === "neutral") {
        runtimeStatus.classList.add(health.tone);
      }
      runtimeStatus.textContent = health.label + (updatedAt ? " · synced " + formatDateTime(updatedAt) : "");
    }

    function updateOverview() {
      const stats = latestOverviewStats;
      const runtimeDomain = latestAliases[0]
        ? latestAliases[0].address.split('@')[1]
        : (stats && stats.domain) || 'mailagents.net';
      const configuredAliasCount = latestAliases.filter((item) => item.configured).length;
      const health = getOverviewHealth(stats);

      if (stats) {
        statUsers.textContent = formatNumber(stats.counts.registeredUsers);
        statUsersMeta.textContent = '近 7 日新增 ' + formatNumber(stats.counts.newUsers7d);
        statMailboxes.textContent = formatNumber(stats.counts.activeMailboxes);
        statMailboxesMeta.textContent = '用戶郵箱 ' + formatNumber(stats.counts.userMailboxes) + ' · 公共別名 ' + formatNumber(stats.counts.contactMailboxes);
        statInbound.textContent = formatNumber(stats.counts.inboundMessages);
        statInboundMeta.textContent = '最近收信 ' + formatDateTime(stats.latest.inboundAt);
        statOutbound.textContent = formatNumber(stats.counts.outboundMessages);
        statOutboundMeta.textContent = '最近發信 ' + formatDateTime(stats.latest.outboundAt);
        statSent.textContent = formatNumber(stats.counts.sentJobs);
        statSentMeta.textContent = '發信成功率 ' + formatPercent(stats.rates.sendSuccessRate);
        statFailed.textContent = formatNumber(stats.counts.failedJobs);
        statFailedMeta.textContent = stats.recentFailures.length ? '有 ' + formatNumber(stats.recentFailures.length) + ' 條最近異常' : '最近沒有新異常';
        statDelivered.textContent = formatNumber(stats.counts.deliveredEvents);
        statDeliveredMeta.textContent = '送達成功率 ' + formatPercent(stats.rates.deliverySuccessRate);
        statPending.textContent = formatNumber(stats.counts.pendingQueue);
        statPendingMeta.textContent = '草稿待處理 ' + formatNumber(stats.counts.pendingDrafts) + ' · Idempotency ' + formatNumber(stats.counts.pendingIdempotency);

        overviewHeroCopy.textContent =
          '目前共有 ' + formatNumber(stats.counts.registeredUsers) + ' 位註冊用戶、' +
          formatNumber(stats.counts.activeMailboxes) + ' 個活躍郵箱，累計收信 ' +
          formatNumber(stats.counts.inboundMessages) + ' 封、發信 ' +
          formatNumber(stats.counts.outboundMessages) + ' 封。近 7 天新增 ' +
          formatNumber(stats.counts.newUsers7d) + ' 位用戶，當前仍有 ' +
          formatNumber(stats.counts.pendingQueue) + ' 個發信任務在隊列中。';
        overviewHealthPills.innerHTML = [
          '<span class="admin-chip ' + health.tone + '">' + esc(health.label) + '</span>',
          '<span class="admin-chip neutral">發信成功率 ' + esc(formatPercent(stats.rates.sendSuccessRate)) + '</span>',
          '<span class="admin-chip neutral">送達成功率 ' + esc(formatPercent(stats.rates.deliverySuccessRate)) + '</span>',
          '<span class="admin-chip neutral">' + esc(aliasAdminAvailable
            ? ('已配置別名 ' + formatNumber(configuredAliasCount) + '/' + formatNumber(latestAliases.length || 4))
            : 'Alias admin unavailable in local mode') + '</span>',
        ].join("");

        overviewMailRuntime.innerHTML = [
          '<div class="admin-mini-grid">' +
            '<div class="admin-mini-card"><strong>' + esc(formatNumber(stats.counts.newUsers7d)) + '</strong><span>近 7 日新增</span></div>' +
            '<div class="admin-mini-card"><strong>' + esc(formatNumber(stats.counts.pendingQueue)) + '</strong><span>發信隊列待處理</span></div>' +
            '<div class="admin-mini-card"><strong>' + esc(formatNumber(stats.counts.pendingDrafts)) + '</strong><span>草稿待處理</span></div>' +
            '<div class="admin-mini-card"><strong>' + esc(formatNumber(stats.counts.pendingIdempotency)) + '</strong><span>Pending idempotency</span></div>' +
          '</div>',
          '<div class="faq-item"><h3>Active domain</h3><p>' + esc(runtimeDomain) + '</p></div>',
          '<div class="faq-item"><h3>Latest registration</h3><p>' + esc(formatDateTime(stats.latest.registrationAt)) + '</p></div>',
          '<div class="faq-item"><h3>Latest delivery event</h3><p>' + esc(formatDateTime(stats.latest.deliveryAt)) + '</p></div>',
          '<div class="faq-item"><h3>Reply workflow</h3><p>' + esc(currentReplyContext ? 'Reply draft prepared for ' + currentReplyContext.to : 'No quick reply prepared.') + '</p></div>',
        ].join("");

        overviewActivityTrend.innerHTML = renderTrendChart(stats.trend);
        overviewQueueHealth.innerHTML = renderBreakdown(stats.distributions.outboundStatuses, 'No outbound queue data yet.') +
          '<div class="admin-mini-grid" style="margin-top:16px;">' +
            '<div class="admin-mini-card"><strong>' + esc(formatNumber(stats.counts.retryJobs)) + '</strong><span>Retry jobs</span></div>' +
            '<div class="admin-mini-card"><strong>' + esc(formatNumber(stats.counts.queuedJobs + stats.counts.sendingJobs)) + '</strong><span>Queued + sending</span></div>' +
            '<div class="admin-mini-card"><strong>' + esc(formatNumber(stats.counts.pendingDrafts)) + '</strong><span>Pending drafts</span></div>' +
            '<div class="admin-mini-card"><strong>' + esc(formatNumber(stats.counts.pendingIdempotency)) + '</strong><span>Pending idempotency</span></div>' +
          '</div>';
        overviewDeliveryHealth.innerHTML = renderBreakdown(stats.distributions.deliveryEvents, 'No delivery events yet.') +
          '<div class="admin-mini-grid" style="margin-top:16px;">' +
            '<div class="admin-mini-card"><strong>' + esc(formatPercent(stats.rates.deliverySuccessRate)) + '</strong><span>Delivery success rate</span></div>' +
            '<div class="admin-mini-card"><strong>' + esc(formatPercent(stats.rates.sendSuccessRate)) + '</strong><span>Send success rate</span></div>' +
            '<div class="admin-mini-card"><strong>' + esc(formatNumber(stats.counts.bounceEvents)) + '</strong><span>Bounces</span></div>' +
            '<div class="admin-mini-card"><strong>' + esc(formatNumber(stats.counts.complaintEvents + stats.counts.rejectEvents)) + '</strong><span>Complaints + rejects</span></div>' +
          '</div>';
        overviewTopMailboxes.innerHTML = renderTopMailboxes(stats.topMailboxes);
        overviewRecentFailures.innerHTML = renderRecentFailures(stats.recentFailures);
        refreshOverviewFilters();
        renderOverviewActivity();
        setRuntimeStatusTone(health, stats.generatedAt);
      } else {
        statUsers.textContent = formatNumber(mailboxIndex.length);
        statUsersMeta.textContent = 'Waiting for signup metrics';
        statMailboxes.textContent = formatNumber(mailboxIndex.length);
        statMailboxesMeta.textContent = 'Loaded live mailboxes';
        statInbound.textContent = formatNumber(latestMessages.filter((item) => item.direction === 'inbound').length);
        statInboundMeta.textContent = 'Current mailbox sample';
        statOutbound.textContent = formatNumber(latestMessages.filter((item) => item.direction === 'outbound').length);
        statOutboundMeta.textContent = 'Current mailbox sample';
        statSent.textContent = formatNumber(latestJobs.filter((item) => item.status === 'sent').length);
        statSentMeta.textContent = 'Fallback from loaded jobs';
        statFailed.textContent = formatNumber(latestJobs.filter((item) => item.status === 'failed').length);
        statFailedMeta.textContent = 'Fallback from loaded jobs';
        statDelivered.textContent = '0';
        statDeliveredMeta.textContent = 'Waiting for delivery metrics';
        statPending.textContent = formatNumber(latestJobs.filter((item) => item.status === 'queued' || item.status === 'sending' || item.status === 'retry').length);
        statPendingMeta.textContent = 'Fallback from loaded jobs';
        overviewHeroCopy.textContent = '正在載入完整運行統計。當前頁面已經接上實時後台資料，詳細指標會在統計接口返回後補齊。';
        overviewHealthPills.innerHTML = '<span class="admin-chip neutral">Waiting for runtime metrics</span>';
        overviewMailRuntime.innerHTML = [
          '<div class="faq-item"><h3>Active domain</h3><p>' + esc(runtimeDomain) + '</p></div>',
          '<div class="faq-item"><h3>Mailbox source</h3><p>' + esc(mailboxIndex.length ? mailboxIndex.length + ' live mailboxes loaded.' : 'No mailbox loaded yet.') + '</p></div>',
          '<div class="faq-item"><h3>Reply workflow</h3><p>' + esc(currentReplyContext ? 'Reply draft prepared for ' + currentReplyContext.to : 'No quick reply prepared.') + '</p></div>',
        ].join("");
        overviewActivityTrend.innerHTML = '<div class="admin-empty-state">Waiting for runtime trend metrics.</div>';
        overviewQueueHealth.innerHTML = '<div class="admin-empty-state">Waiting for queue metrics.</div>';
        overviewDeliveryHealth.innerHTML = '<div class="admin-empty-state">Waiting for delivery metrics.</div>';
        overviewTopMailboxes.innerHTML = '<div class="admin-empty-state">Waiting for mailbox activity metrics.</div>';
        overviewRecentFailures.innerHTML = '<div class="admin-empty-state">Waiting for failure metrics.</div>';
        renderOverviewActivity();
        setRuntimeStatusTone(health, null);
      }

      overviewAliasStatus.innerHTML = !aliasAdminAvailable
        ? '<div class="admin-empty-state">' + esc(aliasAdminMessage || 'Cloudflare email routing admin is not configured in this environment.') + '</div>'
        : latestAliases.length
        ? latestAliases.map((item) =>
            '<div class="faq-item">' +
              '<h3>' + esc(item.address) + '</h3>' +
              '<p>' + esc(item.configured ? 'Configured' : 'Missing') + '</p>' +
              '<p>' + esc(item.mode === 'internal'
                ? 'Internal inbox via worker ' + (item.worker || 'n/a')
                : item.destination || 'No inbox rule yet') + '</p>' +
            '</div>'
          ).join("")
        : 'Unlock the dashboard to inspect alias status.';

      const toolMeta = latestRuntimeMetadata && latestRuntimeMetadata.mcp && Array.isArray(latestRuntimeMetadata.mcp.tools)
        ? latestRuntimeMetadata.mcp.tools
        : [];
      const highRiskTools = toolMeta.filter((tool) => tool.riskLevel === 'high_risk');
      const reviewRequiredTools = toolMeta.filter((tool) => tool.humanReviewRequired);
      const compositeTools = toolMeta.filter((tool) => tool.composite);
      overviewAiPolicy.innerHTML = toolMeta.length
        ? [
            '<div class="faq-item"><h3>High-risk tools</h3><p>' + esc(highRiskTools.length ? highRiskTools.map((tool) => tool.name).join(', ') : 'None exposed.') + '</p></div>',
            '<div class="faq-item"><h3>Human review expected</h3><p>' + esc(reviewRequiredTools.length ? reviewRequiredTools.map((tool) => tool.name).join(', ') : 'No tools currently flagged.') + '</p></div>',
            '<div class="faq-item"><h3>Composite workflows</h3><p>' + esc(compositeTools.length ? compositeTools.map((tool) => tool.name).join(', ') : 'No composite tools published.') + '</p></div>',
            '<div class="faq-item"><h3>Route gates</h3><p>' + esc('Admin routes: ' + (latestRuntimeMetadata.routes && latestRuntimeMetadata.routes.adminEnabled ? 'enabled' : 'disabled') + ' · Debug routes: ' + (latestRuntimeMetadata.routes && latestRuntimeMetadata.routes.debugEnabled ? 'enabled' : 'disabled')) + '</p></div>',
          ].join('')
        : 'Unlock the dashboard to inspect MCP risk policy.';
    }

    async function loadOverviewStats() {
      try {
        latestOverviewStats = await api('/admin/api/overview-stats');
        updateOverview();
      } catch (error) {
        latestOverviewStats = null;
        overviewActivityTrend.textContent = error.message;
        overviewQueueHealth.textContent = error.message;
        overviewDeliveryHealth.textContent = error.message;
        overviewTopMailboxes.textContent = error.message;
        overviewRecentFailures.textContent = error.message;
        updateOverview();
      }
    }

    async function loadRuntimeMetadata() {
      try {
        latestRuntimeMetadata = await api('/admin/api/runtime-metadata');
        updateOverview();
      } catch (error) {
        latestRuntimeMetadata = null;
        overviewAiPolicy.textContent = error.message;
      }
    }

    function renderAliases(aliases, bootstrapManaged) {
      latestAliases = aliases;
      aliasList.innerHTML = aliases.map((item) => {
        const target = item.mode === "internal"
          ? 'Internal inbox via worker <strong>' + esc(item.worker || 'n/a') + '</strong>'
          : esc(item.destination || 'Not configured');
        const mailboxStatus = item.mailboxStatus || 'missing';
        const action = item.configured && !bootstrapManaged
          ? '<button data-alias="' + esc(item.alias) + '" class="button secondary delete-alias" type="button">Delete</button>'
          : "";
        const managedNote = bootstrapManaged
          ? '<p>Managed automatically by bootstrap maintenance.</p>'
          : '';
        return '<div class="faq-item">' +
          '<h3>' + esc(item.address) + '</h3>' +
          '<p>Status: ' + esc(item.configured ? 'Configured' : 'Missing') + '</p>' +
          '<p>Route: ' + target + '</p>' +
          '<p>Mailbox: ' + esc(mailboxStatus) + '</p>' +
          managedNote +
          '<p style="margin-top:12px;">' + action + '</p>' +
        '</div>';
      }).join("");

      document.querySelectorAll(".delete-alias").forEach((button) => {
        button.addEventListener("click", async () => {
          const alias = button.getAttribute("data-alias");
          if (!alias || !window.confirm('Delete forwarding rule for ' + alias + '?')) {
            return;
          }
          try {
            await api('/admin/api/contact-aliases/' + encodeURIComponent(alias), { method: 'DELETE' });
            aliasStatus.textContent = 'Deleted alias ' + alias + '.';
            await loadAliases();
            await loadOverviewStats();
          } catch (error) {
            aliasStatus.textContent = error.message;
          }
        });
      });

      updateOverview();
    }

    async function loadAliases() {
      try {
        const payload = await api('/admin/api/contact-aliases');
        aliasAdminAvailable = payload.available !== false;
        aliasAdminMessage = payload.available === false && typeof payload.message === 'string'
          ? payload.message
          : '';
        authStatus.textContent = 'Dashboard unlocked.';
        renderAliases(
          Array.isArray(payload.aliases) ? payload.aliases : [],
          payload.bootstrapManaged === true,
        );
      } catch (error) {
        aliasAdminAvailable = false;
        aliasAdminMessage = error.message;
        authStatus.textContent = 'Dashboard unlocked with alias admin unavailable.';
        renderAliases([], false);
      }
    }

    function renderMailboxes(items) {
      mailboxIndex = items;
      mailboxList.innerHTML = items.map((item) =>
        '<div class="faq-item">' +
          '<h3>' + esc(item.address) + '</h3>' +
          '<p>Status: ' + esc(item.status) + '</p>' +
          '<p style="margin-top:12px;"><button data-mailbox="' + esc(item.id) + '" class="button secondary mailbox-button" type="button">Open Mailbox</button></p>' +
        '</div>'
      ).join("");

      sendMailbox.innerHTML = '<option value="">Choose mailbox</option>' + items.map((item) =>
        '<option value="' + esc(item.id) + '">' + esc(item.address) + '</option>'
      ).join("");

      document.querySelectorAll(".mailbox-button").forEach((button) => {
        button.addEventListener("click", async () => {
          currentMailboxId = button.getAttribute("data-mailbox");
          setView("messages");
          await loadMessages();
        });
      });

      updateOverview();
      renderContactInboxes();
    }

    function getContactMailboxes() {
      return mailboxIndex.filter((item) =>
        item.address === "hello@mailagents.net" ||
        item.address === "security@mailagents.net" ||
        item.address === "privacy@mailagents.net" ||
        item.address === "dmarc@mailagents.net"
      );
    }

    function renderContactInboxes() {
      const items = getContactMailboxes();
      contactMailboxList.innerHTML = items.length
        ? items.map((item) =>
            '<div class="faq-item">' +
              '<h3>' + esc(item.address) + '</h3>' +
              '<p>Status: ' + esc(item.status) + '</p>' +
              '<p style="margin-top:12px;">' +
                '<button data-contact-mailbox="' + esc(item.id) + '" class="button secondary contact-mailbox-button" type="button">Open Inbox</button> ' +
                '<button data-main-mailbox="' + esc(item.id) + '" class="button secondary jump-mailbox-button" type="button">Open In Messages</button>' +
              '</p>' +
            '</div>'
          ).join("")
        : 'No contact inboxes are configured yet.';

      document.querySelectorAll(".contact-mailbox-button").forEach((button) => {
        button.addEventListener("click", async () => {
          const mailboxId = button.getAttribute("data-contact-mailbox");
          if (!mailboxId) {
            return;
          }
          currentContactMailboxId = mailboxId;
          await loadContactMessages();
        });
      });

      document.querySelectorAll(".jump-mailbox-button").forEach((button) => {
        button.addEventListener("click", async () => {
          const mailboxId = button.getAttribute("data-main-mailbox");
          if (!mailboxId) {
            return;
          }
          currentMailboxId = mailboxId;
          setView("messages");
          await loadMessages();
        });
      });
    }

    function renderMessages(items) {
      messageList.innerHTML = items.length
        ? items.map((item) =>
            '<div class="faq-item">' +
              '<h3>' + esc(item.subject || '(No subject)') + '</h3>' +
              '<p>From: ' + esc(item.fromAddr) + '</p>' +
              '<p>To: ' + esc(item.toAddr) + '</p>' +
              '<p>Status: ' + esc(item.status) + ' · ' + esc(item.direction) + '</p>' +
              '<p style="margin-top:12px;"><button data-message="' + esc(item.id) + '" class="button secondary message-button" type="button">View Message</button></p>' +
            '</div>'
          ).join("")
        : 'No messages found for this mailbox.';

      document.querySelectorAll(".message-button").forEach((button) => {
        button.addEventListener("click", async () => {
          const id = button.getAttribute("data-message");
          if (id) {
            await loadMessageDetail(id);
          }
        });
      });
    }

    async function loadMailboxes() {
      try {
        const payload = await api('/admin/api/mailboxes');
        renderMailboxes(payload.items);
      } catch (error) {
        mailboxList.textContent = error.message;
        contactMailboxList.textContent = error.message;
      }
    }

    function renderContactMessages(items) {
      contactMessageList.innerHTML = items.length
        ? items.map((item) =>
            '<div class="faq-item">' +
              '<h3>' + esc(item.subject || '(No subject)') + '</h3>' +
              '<p>From: ' + esc(item.fromAddr) + '</p>' +
              '<p>Received: ' + esc(item.receivedAt || item.createdAt) + '</p>' +
              '<p style="margin-top:12px;">' +
                '<button data-contact-message="' + esc(item.id) + '" class="button secondary contact-message-button" type="button">Inspect</button>' +
              '</p>' +
            '</div>'
          ).join("")
        : 'No messages found for this contact inbox yet.';

      document.querySelectorAll(".contact-message-button").forEach((button) => {
        button.addEventListener("click", async () => {
          const messageId = button.getAttribute("data-contact-message");
          if (!messageId) {
            return;
          }
          await loadContactMessageDetail(messageId);
        });
      });
    }

    async function loadContactMessages() {
      if (!currentContactMailboxId) {
        contactMessageList.textContent = 'Select a contact inbox to load messages.';
        return;
      }

      const mailbox = mailboxIndex.find((item) => item.id === currentContactMailboxId);
      if (mailbox) {
        contactMessagesTitle.textContent = 'Recent messages for ' + mailbox.address;
      }

      try {
        const params = new URLSearchParams({
          mailboxId: currentContactMailboxId,
          limit: '20',
        });
        const payload = await api('/admin/api/messages?' + params.toString());
        renderContactMessages(payload.items);
      } catch (error) {
        contactMessageList.textContent = error.message;
      }
    }

    async function loadContactMessageDetail(messageId) {
      try {
        const [message, content] = await Promise.all([
          api('/admin/api/messages/' + encodeURIComponent(messageId)),
          api('/admin/api/messages/' + encodeURIComponent(messageId) + '/content'),
        ]);
        const text = content.text || content.html || 'No content extracted.';
        contactMessageDetail.innerHTML =
          '<div class="faq-item">' +
            '<h3>' + esc(message.subject || '(No subject)') + '</h3>' +
            '<p><strong>From:</strong> ' + esc(message.fromAddr) + '</p>' +
            '<p><strong>To:</strong> ' + esc(message.toAddr) + '</p>' +
            '<p><strong>Status:</strong> ' + esc(message.status) + '</p>' +
            '<div class="code" style="margin-top:12px;">' + esc(text) + '</div>' +
            '<p style="margin-top:12px;"><button data-thread-message="' + esc(message.id) + '" class="button secondary contact-thread-button" type="button">Open Thread & Delivery</button></p>' +
          '</div>';

        const openThreadButton = document.querySelector(".contact-thread-button");
        if (openThreadButton) {
          openThreadButton.addEventListener("click", async () => {
            await loadMessageDetail(message.id);
          });
        }
      } catch (error) {
        contactMessageDetail.textContent = error.message;
      }
    }

    function renderOutboundJobs(items) {
      latestJobs = items;
      outboundJobs.innerHTML = items.length
        ? items.map((job) =>
            '<div class="faq-item">' +
              '<h3>' + esc(job.id) + '</h3>' +
              '<p>Status: ' + esc(job.status) + '</p>' +
              '<p>Message: ' + esc(job.messageId) + '</p>' +
              '<p>Updated: ' + esc(job.updatedAt) + '</p>' +
              '<p>' + esc(job.lastError || 'No error') + '</p>' +
              '<p style="margin-top:12px;">' +
                (job.status === 'failed' && job.lastError !== 'send_attempt_uncertain_manual_review_required'
                  ? '<button data-job="' + esc(job.id) + '" class="button secondary retry-job" type="button">Retry Job</button>'
                  : '') +
                (job.lastError === 'send_attempt_uncertain_manual_review_required'
                  ? '<button data-job="' + esc(job.id) + '" class="button secondary resolve-job-sent" type="button" style="margin-right:8px;">Confirm Sent</button>' +
                    '<button data-job="' + esc(job.id) + '" class="button secondary resolve-job-not-sent" type="button">Confirm Not Sent</button>'
                  : '') +
              '</p>' +
            '</div>'
          ).join('')
        : 'No outbound jobs found.';

      document.querySelectorAll('.retry-job').forEach((button) => {
        button.addEventListener('click', async () => {
          const id = button.getAttribute('data-job');
          if (!id) {
            return;
          }
          try {
            await api('/admin/api/outbound-jobs/' + encodeURIComponent(id) + '/retry', { method: 'POST' });
            await loadOutboundJobs();
            await loadOverviewStats();
            outboxDetail.textContent = 'Retried outbound job ' + id + '.';
          } catch (error) {
            outboxDetail.textContent = error.message;
          }
        });
      });

      document.querySelectorAll('.resolve-job-sent').forEach((button) => {
        button.addEventListener('click', async () => {
          const id = button.getAttribute('data-job');
          if (!id) {
            return;
          }
          try {
            await api('/admin/api/outbound-jobs/' + encodeURIComponent(id) + '/manual-resolution', {
              method: 'POST',
              body: JSON.stringify({ resolution: 'sent' }),
            });
            await loadOutboundJobs();
            await loadOverviewStats();
            outboxDetail.textContent = 'Marked uncertain outbound job ' + id + ' as sent.';
          } catch (error) {
            outboxDetail.textContent = error.message;
          }
        });
      });

      document.querySelectorAll('.resolve-job-not-sent').forEach((button) => {
        button.addEventListener('click', async () => {
          const id = button.getAttribute('data-job');
          if (!id) {
            return;
          }
          try {
            await api('/admin/api/outbound-jobs/' + encodeURIComponent(id) + '/manual-resolution', {
              method: 'POST',
              body: JSON.stringify({ resolution: 'not_sent' }),
            });
            await loadOutboundJobs();
            await loadOverviewStats();
            outboxDetail.textContent = 'Marked uncertain outbound job ' + id + ' as not sent.';
          } catch (error) {
            outboxDetail.textContent = error.message;
          }
        });
      });

      updateOverview();
    }

    function renderIdempotencyRecords(items) {
      idempotencyList.innerHTML = items.length
        ? items.map((item) =>
            '<div class="faq-item">' +
              '<h3>' + esc(item.operation) + '</h3>' +
              '<p>Status: ' + esc(item.status) + '</p>' +
              '<p>Tenant: ' + esc(item.tenantId) + '</p>' +
              '<p>Key: <code>' + esc(item.idempotencyKey) + '</code></p>' +
              '<p>Resource: ' + esc(item.resourceId || 'n/a') + '</p>' +
              '<p>Updated: ' + esc(item.updatedAt) + '</p>' +
            '</div>'
          ).join('')
        : 'No idempotency records found for the current filters.';
    }

    async function loadIdempotencyRecords() {
      try {
        const params = new URLSearchParams({ limit: '50' });
        if (idempotencyOperation.value) {
          params.set('operation', idempotencyOperation.value);
        }
        if (idempotencyStatus.value) {
          params.set('status', idempotencyStatus.value);
        }
        const payload = await api('/admin/api/maintenance/idempotency-keys?' + params.toString());
        renderIdempotencyRecords(payload.items);
      } catch (error) {
        idempotencyList.textContent = error.message;
      }
    }

    async function loadOutboundJobs() {
      try {
        const params = new URLSearchParams({ limit: '50' });
        if (jobStatus.value) {
          params.set('status', jobStatus.value);
        }
        const payload = await api('/admin/api/outbound-jobs?' + params.toString());
        renderOutboundJobs(payload.items);
      } catch (error) {
        outboundJobs.textContent = error.message;
      }
    }

    function renderDrafts(items) {
      draftList.innerHTML = items.length
        ? items.map((draft) =>
            '<div class="faq-item">' +
              '<h3>' + esc(draft.id) + '</h3>' +
              '<p>Status: ' + esc(draft.status) + '</p>' +
              '<p>Mailbox: ' + esc(draft.mailboxId) + '</p>' +
              '<p>Updated: ' + esc(draft.updatedAt) + '</p>' +
              '<p style="margin-top:12px;"><button data-draft="' + esc(draft.id) + '" class="button secondary draft-button" type="button">Inspect Draft</button></p>' +
            '</div>'
          ).join('')
        : 'No drafts found.';

      document.querySelectorAll('.draft-button').forEach((button) => {
        button.addEventListener('click', async () => {
          const draftId = button.getAttribute('data-draft');
          if (!draftId) {
            return;
          }
          try {
            const draft = await api('/admin/api/drafts/' + encodeURIComponent(draftId));
            outboxDetail.innerHTML =
              '<div class="faq-item">' +
                '<h3>Draft ' + esc(draft.id) + '</h3>' +
                '<p>Status: ' + esc(draft.status) + '</p>' +
                '<p>Mailbox: ' + esc(draft.mailboxId) + '</p>' +
                '<p>Thread: ' + esc(draft.threadId || 'n/a') + '</p>' +
                '<p>Updated: ' + esc(draft.updatedAt) + '</p>' +
              '</div>';
          } catch (error) {
            outboxDetail.textContent = error.message;
          }
        });
      });
    }

    async function loadDrafts() {
      try {
        const params = new URLSearchParams({ limit: '50' });
        if (currentMailboxId) {
          params.set('mailboxId', currentMailboxId);
        }
        if (draftStatus.value) {
          params.set('status', draftStatus.value);
        }
        const payload = await api('/admin/api/drafts?' + params.toString());
        renderDrafts(payload.items);
      } catch (error) {
        draftList.textContent = error.message;
      }
    }

    async function loadMessages() {
      if (!currentMailboxId) {
        messageList.textContent = 'Select a mailbox to load messages.';
        latestMessages = [];
        updateOverview();
        return;
      }

      try {
        const params = new URLSearchParams({
          mailboxId: currentMailboxId,
          limit: '50',
        });
        const search = messageSearch.value.trim();
        const direction = messageDirection.value;
        if (search) {
          params.set('search', search);
        }
        if (direction) {
          params.set('direction', direction);
        }
        const payload = await api('/admin/api/messages?' + params.toString());
        latestMessages = payload.items;
        renderMessages(payload.items);
        updateOverview();
      } catch (error) {
        messageList.textContent = error.message;
      }
    }

    async function loadMessageDetail(messageId) {
      try {
        const [message, content] = await Promise.all([
          api('/admin/api/messages/' + encodeURIComponent(messageId)),
          api('/admin/api/messages/' + encodeURIComponent(messageId) + '/content'),
        ]);

        const text = content.text || '';
        const html = content.html || '';
        const attachments = (content.attachments || []).map((item) =>
          '<li>' + esc(item.filename || item.id) + ' · ' + esc(item.sizeBytes) + ' bytes</li>'
        ).join('');
        currentReplyContext = {
          mailboxId: message.mailboxId,
          tenantId: message.tenantId,
          from: message.toAddr.split(',')[0] || '',
          to: message.fromAddr,
          subject: message.subject && message.subject.toLowerCase().startsWith('re:') ? message.subject : 'Re: ' + (message.subject || ''),
          threadId: message.threadId || '',
          sourceMessageId: message.id,
          inReplyTo: message.internetMessageId || '',
          references: message.internetMessageId ? [message.internetMessageId] : [],
        };
        replyHint.innerHTML = 'Reply ready for <strong>' + esc(message.fromAddr) + '</strong>. <button id="use-reply" class="button secondary" type="button">Use Reply Draft</button>';

        messageDetail.innerHTML =
          '<div class="faq-item">' +
            '<h3>' + esc(message.subject || '(No subject)') + '</h3>' +
            '<p><strong>From:</strong> ' + esc(message.fromAddr) + '</p>' +
            '<p><strong>To:</strong> ' + esc(message.toAddr) + '</p>' +
            '<p><strong>Status:</strong> ' + esc(message.status) + '</p>' +
            '<p><strong>Received:</strong> ' + esc(message.receivedAt || message.createdAt) + '</p>' +
            '<div class="code" style="margin-top:12px;">' + esc(text || html || 'No content extracted.') + '</div>' +
            '<div style="margin-top:12px;"><strong>Attachments</strong><ul>' + (attachments || '<li>None</li>') + '</ul></div>' +
          '</div>';

        const replyButton = document.getElementById('use-reply');
        if (replyButton) {
          replyButton.addEventListener('click', () => {
            sendMailbox.value = currentReplyContext.mailboxId;
            sendTo.value = currentReplyContext.to;
            sendSubject.value = currentReplyContext.subject;
            sendText.value = '';
            sendStatus.textContent = 'Reply draft loaded. Add your message and queue send.';
          });
        }

        if (message.threadId) {
          const thread = await api('/admin/api/threads/' + encodeURIComponent(message.threadId));
          threadView.innerHTML = thread.messages.length
            ? thread.messages.map((item) =>
                '<div class="faq-item">' +
                  '<h3>' + esc(item.subject || '(No subject)') + '</h3>' +
                  '<p>' + esc(item.direction) + ' · ' + esc(item.status) + '</p>' +
                  '<p>From: ' + esc(item.fromAddr) + '</p>' +
                  '<p>To: ' + esc(item.toAddr) + '</p>' +
                '</div>'
              ).join('')
            : 'Thread found but no messages were returned.';
        } else {
          threadView.textContent = 'This message is not attached to a thread yet.';
        }
        setView("threads");

        const events = await api('/admin/api/messages/' + encodeURIComponent(messageId) + '/events');
        deliveryEvents.innerHTML = events.items.length
          ? events.items.map((event) =>
              '<div class="faq-item">' +
                '<h3>' + esc(event.eventType) + '</h3>' +
                '<p>Provider message id: ' + esc(event.providerMessageId || 'n/a') + '</p>' +
                '<p>Created: ' + esc(event.createdAt) + '</p>' +
              '</div>'
            ).join('')
          : 'No delivery events recorded for this message yet.';

        if (message.direction === 'outbound') {
          let match = null;
          try {
            match = await api('/admin/api/messages/' + encodeURIComponent(message.id) + '/outbound-job');
          } catch (error) {
            if (!String(error && error.message || '').includes('Outbound job not found')) {
              throw error;
            }
          }
          outboxDetail.innerHTML = match
            ? '<div class="faq-item">' +
                '<h3>Outbound job ' + esc(match.id) + '</h3>' +
                '<p>Status: ' + esc(match.status) + '</p>' +
                '<p>Retry count: ' + esc(match.retryCount) + '</p>' +
                '<p>Next retry: ' + esc(match.nextRetryAt || 'n/a') + '</p>' +
                '<p>Last error: ' + esc(match.lastError || 'none') + '</p>' +
              '</div>'
            : 'No outbound job found for this message.';
        } else {
          outboxDetail.textContent = 'Select an outbound message or draft to inspect its delivery state.';
        }
      } catch (error) {
        messageDetail.textContent = error.message;
        threadView.textContent = 'Unable to load thread.';
        deliveryEvents.textContent = 'Unable to load delivery events.';
        outboxDetail.textContent = 'Unable to load outbound state.';
      }
    }

    async function bootstrapDashboard() {
      runtimeStatus.classList.remove('warning', 'neutral');
      runtimeStatus.textContent = 'Connecting to live runtime';
      await Promise.all([
        loadRuntimeMetadata(),
        loadAliases(),
        loadMailboxes(),
        loadOverviewStats(),
      ]);
      if (!currentMailboxId && mailboxIndex[0]) {
        currentMailboxId = mailboxIndex[0].id;
      }
      if (!currentContactMailboxId) {
        const firstContactMailbox = getContactMailboxes()[0];
        if (firstContactMailbox) {
          currentContactMailboxId = firstContactMailbox.id;
        }
      }
      if (currentMailboxId) {
        await loadMessages();
        sendMailbox.value = currentMailboxId;
      }
      if (currentContactMailboxId) {
        await loadContactMessages();
      }
      await loadOutboundJobs();
      await loadDrafts();
      await loadIdempotencyRecords();
      updateOverview();
    }

    aliasForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await api('/admin/api/contact-aliases', {
          method: 'POST',
          body: JSON.stringify({
            alias: aliasName.value,
          }),
        });
        aliasStatus.textContent = 'Internal inbox alias saved successfully.';
        aliasName.value = '';
        await loadAliases();
        await loadMailboxes();
        await loadOverviewStats();
      } catch (error) {
        aliasStatus.textContent = error.message;
      }
    });

    aliasBootstrapForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const result = await api('/admin/api/contact-aliases/bootstrap', {
          method: 'POST',
          body: JSON.stringify({
            overwrite: aliasBootstrapOverwrite.checked,
          }),
        });
        aliasBootstrapStatus.textContent = 'Internal inbox setup complete for ' + result.results.length + ' aliases.';
        await loadAliases();
        await loadMailboxes();
        await loadOverviewStats();
      } catch (error) {
        aliasBootstrapStatus.textContent = error.message;
      }
    });

    messageSearch.addEventListener('change', loadMessages);
    messageDirection.addEventListener('change', loadMessages);
    overviewTabs.forEach((button) => {
      button.addEventListener("click", () => {
        const tabName = button.getAttribute("data-overview-tab");
        if (tabName) {
          setOverviewTab(tabName);
        }
      });
    });
    overviewSearch.addEventListener('input', renderOverviewActivity);
    overviewTimeWindow.addEventListener('change', renderOverviewActivity);
    overviewStatusFilter.addEventListener('change', renderOverviewActivity);
    overviewMailboxFilter.addEventListener('change', renderOverviewActivity);
    jobStatus.addEventListener('change', loadOutboundJobs);
    draftStatus.addEventListener('change', loadDrafts);
    idempotencyOperation.addEventListener('change', loadIdempotencyRecords);
    idempotencyStatus.addEventListener('change', loadIdempotencyRecords);
    idempotencyRefresh.addEventListener('click', loadIdempotencyRecords);
    idempotencyCleanup.addEventListener('click', async () => {
      try {
        const result = await api('/admin/api/maintenance/idempotency-cleanup', { method: 'POST' });
        idempotencyMaintenance.innerHTML =
          '<div class="faq-item">' +
            '<h3>Cleanup complete</h3>' +
            '<p>Deleted: ' + result.deleted + '</p>' +
            '<p>Completed retention: ' + result.completedRetentionHours + ' hours</p>' +
            '<p>Pending retention: ' + result.pendingRetentionHours + ' hours</p>' +
          '</div>';
        await loadIdempotencyRecords();
        await loadOverviewStats();
      } catch (error) {
        idempotencyMaintenance.textContent = error.message;
      }
    });
    document.querySelectorAll(".admin-nav-button").forEach((button) => {
      button.addEventListener("click", () => {
        const viewName = button.getAttribute("data-view");
        if (viewName) {
          setView(viewName);
        }
      });
    });

    refreshDashboard.addEventListener("click", async (event) => {
      event.preventDefault();
      try {
        await bootstrapDashboard();
        authStatus.textContent = "Dashboard unlocked.";
      } catch (error) {
        runtimeStatus.textContent = error.message;
      }
    });

    sendForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const mailbox = mailboxIndex.find((item) => item.id === sendMailbox.value);
      if (!mailbox) {
        sendStatus.textContent = 'Choose a mailbox first.';
        return;
      }

      try {
        const adminSendIdempotencyKey = 'admin-send-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        const result = await api('/admin/api/send', {
          method: 'POST',
          body: JSON.stringify({
            mailboxId: mailbox.id,
            tenantId: mailbox.tenantId,
            from: mailbox.address,
            to: sendTo.value.split(',').map((item) => item.trim()).filter(Boolean),
            subject: sendSubject.value,
            text: sendText.value,
            threadId: currentReplyContext?.mailboxId === mailbox.id ? currentReplyContext.threadId || undefined : undefined,
            sourceMessageId: currentReplyContext?.mailboxId === mailbox.id ? currentReplyContext.sourceMessageId || undefined : undefined,
            inReplyTo: currentReplyContext?.mailboxId === mailbox.id ? currentReplyContext.inReplyTo || undefined : undefined,
            references: currentReplyContext?.mailboxId === mailbox.id ? currentReplyContext.references || [] : [],
            idempotencyKey: adminSendIdempotencyKey,
          }),
        });
        sendStatus.textContent = 'Queued outbound job ' + result.outboundJobId + '.';
        sendTo.value = '';
        sendSubject.value = '';
        sendText.value = '';
        currentReplyContext = null;
        replyHint.textContent = 'No reply draft prepared.';
        await loadMessages();
        await loadDrafts();
        await loadOutboundJobs();
        await loadOverviewStats();
      } catch (error) {
        sendStatus.textContent = error.message;
      }
    });

    if (initiallyAuthenticated) {
      setAuthenticated(true);
      setView("overview");
      setOverviewTab(currentOverviewTab);
      updateOverview();
      bootstrapDashboard()
        .then(() => {
          authStatus.textContent = "Dashboard unlocked.";
        })
        .catch((error) => {
          authStatus.textContent = "Dashboard unlocked with partial errors.";
          runtimeStatus.textContent = error.message;
        });
    } else {
      setAuthenticated(false);
      runtimeStatus.textContent = "Waiting for authentication";
    }
  </script>`;
}
