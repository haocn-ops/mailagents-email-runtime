import { createId } from "../lib/ids";
import { allRows, execute, firstRow, requireRow } from "../lib/db";
import { nowIso } from "../lib/time";
import type { AgentMailboxBindingRecord, AgentPolicyRecord, AgentRecord, Env } from "../types";

interface MailboxRow {
  id: string;
  tenant_id: string;
  address: string;
  status: string;
  created_at: string;
}

interface AgentRow {
  id: string;
  tenant_id: string;
  name: string;
  status: AgentRecord["status"];
  mode: AgentRecord["mode"];
  config_r2_key: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentMailboxRow {
  id: string;
  agent_id: string;
  mailbox_id: string;
  role: AgentMailboxBindingRecord["role"];
  status: AgentMailboxBindingRecord["status"];
  created_at: string;
}

interface AgentPolicyRow {
  agent_id: string;
  auto_reply_enabled: number;
  human_review_required: number;
  confidence_threshold: number;
  max_auto_replies_per_thread: number;
  allowed_recipient_domains_json: string | null;
  blocked_sender_domains_json: string | null;
  allowed_tools_json: string | null;
  updated_at: string;
}

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function mapAgentRow(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    status: row.status,
    mode: row.mode,
    configR2Key: row.config_r2_key ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMailboxRow(row: AgentMailboxRow): AgentMailboxBindingRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    mailboxId: row.mailbox_id,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
  };
}

function mapPolicyRow(row: AgentPolicyRow): AgentPolicyRecord {
  return {
    agentId: row.agent_id,
    autoReplyEnabled: Boolean(row.auto_reply_enabled),
    humanReviewRequired: Boolean(row.human_review_required),
    confidenceThreshold: row.confidence_threshold,
    maxAutoRepliesPerThread: row.max_auto_replies_per_thread,
    allowedRecipientDomains: parseJsonArray(row.allowed_recipient_domains_json),
    blockedSenderDomains: parseJsonArray(row.blocked_sender_domains_json),
    allowedTools: parseJsonArray(row.allowed_tools_json),
    updatedAt: row.updated_at,
  };
}

export async function createAgent(env: Env, input: {
  tenantId: string;
  name: string;
  mode: AgentRecord["mode"];
  config: unknown;
}): Promise<AgentRecord> {
  const id = createId("agt");
  const timestamp = nowIso();
  const configR2Key = `agent-config/${id}.json`;

  await env.R2_EMAIL.put(configR2Key, JSON.stringify(input.config, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });

  await execute(env.D1_DB.prepare(
    `INSERT INTO agents (id, tenant_id, name, status, mode, config_r2_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    input.tenantId,
    input.name,
    "active",
    input.mode,
    configR2Key,
    timestamp,
    timestamp
  ));

  return requireRow(await getAgent(env, id), "Failed to load created agent");
}

export async function getAgent(env: Env, agentId: string): Promise<AgentRecord | null> {
  const row = await firstRow<AgentRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, name, status, mode, config_r2_key, created_at, updated_at
       FROM agents
       WHERE id = ?`
    ).bind(agentId)
  );

  return row ? mapAgentRow(row) : null;
}

export async function updateAgent(env: Env, agentId: string, patch: {
  name?: string;
  status?: AgentRecord["status"];
  mode?: AgentRecord["mode"];
  config?: unknown;
}): Promise<AgentRecord> {
  const current = requireRow(await getAgent(env, agentId), "Agent not found");
  const updatedAt = nowIso();
  let configR2Key = current.configR2Key;

  if (patch.config !== undefined) {
    configR2Key = `agent-config/${agentId}.json`;
    await env.R2_EMAIL.put(configR2Key, JSON.stringify(patch.config, null, 2), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  }

  await execute(env.D1_DB.prepare(
    `UPDATE agents
     SET name = ?, status = ?, mode = ?, config_r2_key = ?, updated_at = ?
     WHERE id = ?`
  ).bind(
    patch.name ?? current.name,
    patch.status ?? current.status,
    patch.mode ?? current.mode,
    configR2Key ?? null,
    updatedAt,
    agentId
  ));

  return requireRow(await getAgent(env, agentId), "Failed to load updated agent");
}

export async function bindMailbox(env: Env, input: {
  tenantId: string;
  agentId: string;
  mailboxId: string;
  role: AgentMailboxBindingRecord["role"];
}): Promise<AgentMailboxBindingRecord> {
  const id = createId("amb");
  const createdAt = nowIso();

  await execute(env.D1_DB.prepare(
    `INSERT INTO agent_mailboxes (id, tenant_id, agent_id, mailbox_id, role, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    input.tenantId,
    input.agentId,
    input.mailboxId,
    input.role,
    "active",
    createdAt
  ));

  return {
    id,
    agentId: input.agentId,
    mailboxId: input.mailboxId,
    role: input.role,
    status: "active",
    createdAt,
  };
}

export async function listAgentMailboxes(env: Env, agentId: string): Promise<AgentMailboxBindingRecord[]> {
  const rows = await allRows<AgentMailboxRow>(
    env.D1_DB.prepare(
      `SELECT id, agent_id, mailbox_id, role, status, created_at
       FROM agent_mailboxes
       WHERE agent_id = ?
       ORDER BY created_at DESC`
    ).bind(agentId)
  );

  return rows.map(mapMailboxRow);
}

export async function upsertAgentPolicy(env: Env, input: Omit<AgentPolicyRecord, "updatedAt">): Promise<AgentPolicyRecord> {
  const updatedAt = nowIso();

  await execute(env.D1_DB.prepare(
    `INSERT INTO agent_policies (
       agent_id, auto_reply_enabled, human_review_required, confidence_threshold,
       max_auto_replies_per_thread, allowed_recipient_domains_json,
       blocked_sender_domains_json, allowed_tools_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       auto_reply_enabled = excluded.auto_reply_enabled,
       human_review_required = excluded.human_review_required,
       confidence_threshold = excluded.confidence_threshold,
       max_auto_replies_per_thread = excluded.max_auto_replies_per_thread,
       allowed_recipient_domains_json = excluded.allowed_recipient_domains_json,
       blocked_sender_domains_json = excluded.blocked_sender_domains_json,
       allowed_tools_json = excluded.allowed_tools_json,
       updated_at = excluded.updated_at`
  ).bind(
    input.agentId,
    Number(input.autoReplyEnabled),
    Number(input.humanReviewRequired),
    input.confidenceThreshold,
    input.maxAutoRepliesPerThread,
    JSON.stringify(input.allowedRecipientDomains),
    JSON.stringify(input.blockedSenderDomains),
    JSON.stringify(input.allowedTools),
    updatedAt
  ));

  const row = await firstRow<AgentPolicyRow>(
    env.D1_DB.prepare(
      `SELECT agent_id, auto_reply_enabled, human_review_required, confidence_threshold,
              max_auto_replies_per_thread, allowed_recipient_domains_json,
              blocked_sender_domains_json, allowed_tools_json, updated_at
       FROM agent_policies
       WHERE agent_id = ?`
    ).bind(input.agentId)
  );

  return mapPolicyRow(requireRow(row, "Failed to load agent policy"));
}

export async function getMailboxByAddress(env: Env, address: string): Promise<MailboxRow | null> {
  return await firstRow<MailboxRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, address, status, created_at
       FROM mailboxes
       WHERE address = ?`
    ).bind(address.toLowerCase())
  );
}

export async function getMailboxById(env: Env, mailboxId: string): Promise<MailboxRow | null> {
  return await firstRow<MailboxRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, address, status, created_at
       FROM mailboxes
       WHERE id = ?`
    ).bind(mailboxId)
  );
}
