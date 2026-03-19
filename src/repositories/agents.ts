import { createId } from "../lib/ids";
import { allRows, execute, firstRow, requireRow } from "../lib/db";
import { nowIso } from "../lib/time";
import type {
  AgentCapabilityRecord,
  AgentExecutionTarget,
  AgentDeploymentRecord,
  AgentMailboxBindingRecord,
  AgentPolicyRecord,
  AgentRecord,
  AgentToolBindingSummary,
  AgentVersionRecord,
  Env,
  MailboxRecord,
} from "../types";

interface MailboxRow {
  id: string;
  tenant_id: string;
  address: string;
  status: string;
  created_at: string;
}

function mapMailboxRecord(row: MailboxRow): MailboxRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    address: row.address,
    status: row.status,
    createdAt: row.created_at,
  };
}

interface AgentRow {
  id: string;
  tenant_id: string;
  slug: string | null;
  name: string;
  description: string | null;
  status: AgentRecord["status"];
  mode: AgentRecord["mode"];
  config_r2_key: string | null;
  default_version_id: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentVersionRow {
  id: string;
  agent_id: string;
  version: string;
  model: string | null;
  config_r2_key: string | null;
  manifest_r2_key: string | null;
  status: AgentVersionRecord["status"];
  created_at: string;
}

interface AgentCapabilityRow {
  id: string;
  agent_version_id: string;
  capability: string;
  config_json: string | null;
}

interface AgentToolBindingRow {
  id: string;
  agent_version_id: string;
  tool_name: string;
  enabled: number;
  config_json: string | null;
}

interface AgentDeploymentRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  agent_version_id: string;
  target_type: AgentDeploymentRecord["targetType"];
  target_id: string;
  status: AgentDeploymentRecord["status"];
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

function isMissingTableError(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique constraint/i.test(error.message);
}

export class DeploymentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentConflictError";
  }
}

export class MailboxConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailboxConflictError";
  }
}

function mapAgentRow(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    slug: row.slug ?? undefined,
    name: row.name,
    description: row.description ?? undefined,
    status: row.status,
    mode: row.mode,
    configR2Key: row.config_r2_key ?? undefined,
    defaultVersionId: row.default_version_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJsonObject(value: string | null): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function mapCapabilityRow(row: AgentCapabilityRow): AgentCapabilityRecord {
  return {
    id: row.id,
    capability: row.capability,
    config: parseJsonObject(row.config_json),
  };
}

function mapToolBindingRow(row: AgentToolBindingRow): AgentToolBindingSummary {
  return {
    id: row.id,
    toolName: row.tool_name,
    enabled: Boolean(row.enabled),
    config: parseJsonObject(row.config_json),
  };
}

function mapDeploymentRow(row: AgentDeploymentRow): AgentDeploymentRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    agentVersionId: row.agent_version_id,
    targetType: row.target_type,
    targetId: row.target_id,
    status: row.status,
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
  slug?: string;
  name: string;
  description?: string;
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
    `INSERT INTO agents (
       id, tenant_id, slug, name, description, status, mode, config_r2_key, default_version_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    input.tenantId,
    input.slug ?? null,
    input.name,
    input.description ?? null,
    "active",
    input.mode,
    configR2Key,
    null,
    timestamp,
    timestamp
  ));

  return requireRow(await getAgent(env, id), "Failed to load created agent");
}

export async function getAgent(env: Env, agentId: string): Promise<AgentRecord | null> {
  const row = await firstRow<AgentRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, slug, name, description, status, mode, config_r2_key, default_version_id, created_at, updated_at
       FROM agents
       WHERE id = ?`
    ).bind(agentId)
  );

  return row ? mapAgentRow(row) : null;
}

export async function listAgents(env: Env, tenantId?: string): Promise<AgentRecord[]> {
  const rows = tenantId
    ? await allRows<AgentRow>(env.D1_DB.prepare(
        `SELECT id, tenant_id, slug, name, description, status, mode, config_r2_key, default_version_id, created_at, updated_at
         FROM agents
         WHERE tenant_id = ?
         ORDER BY created_at DESC`
      ).bind(tenantId))
    : await allRows<AgentRow>(env.D1_DB.prepare(
        `SELECT id, tenant_id, slug, name, description, status, mode, config_r2_key, default_version_id, created_at, updated_at
         FROM agents
         ORDER BY created_at DESC`
      ));

  return rows.map(mapAgentRow);
}

export async function updateAgent(env: Env, agentId: string, patch: {
  slug?: string;
  name?: string;
  description?: string;
  status?: AgentRecord["status"];
  mode?: AgentRecord["mode"];
  config?: unknown;
  defaultVersionId?: string;
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
     SET slug = ?, name = ?, description = ?, status = ?, mode = ?, config_r2_key = ?, default_version_id = ?, updated_at = ?
     WHERE id = ?`
  ).bind(
    patch.slug ?? current.slug ?? null,
    patch.name ?? current.name,
    patch.description ?? current.description ?? null,
    patch.status ?? current.status,
    patch.mode ?? current.mode,
    configR2Key ?? null,
    patch.defaultVersionId ?? current.defaultVersionId ?? null,
    updatedAt,
    agentId
  ));

  return requireRow(await getAgent(env, agentId), "Failed to load updated agent");
}

async function listVersionCapabilities(env: Env, agentVersionId: string): Promise<AgentCapabilityRecord[]> {
  const rows = await allRows<AgentCapabilityRow>(
    env.D1_DB.prepare(
      `SELECT id, agent_version_id, capability, config_json
       FROM agent_capabilities
       WHERE agent_version_id = ?
       ORDER BY capability ASC`
    ).bind(agentVersionId)
  );

  return rows.map(mapCapabilityRow);
}

async function listVersionTools(env: Env, agentVersionId: string): Promise<AgentToolBindingSummary[]> {
  const rows = await allRows<AgentToolBindingRow>(
    env.D1_DB.prepare(
      `SELECT id, agent_version_id, tool_name, enabled, config_json
       FROM agent_tool_bindings
       WHERE agent_version_id = ?
       ORDER BY tool_name ASC`
    ).bind(agentVersionId)
  );

  return rows.map(mapToolBindingRow);
}

async function mapAgentVersion(env: Env, row: AgentVersionRow): Promise<AgentVersionRecord> {
  const [capabilities, tools] = await Promise.all([
    listVersionCapabilities(env, row.id),
    listVersionTools(env, row.id),
  ]);

  return {
    id: row.id,
    agentId: row.agent_id,
    version: row.version,
    model: row.model ?? undefined,
    configR2Key: row.config_r2_key ?? undefined,
    manifestR2Key: row.manifest_r2_key ?? undefined,
    status: row.status,
    capabilities,
    tools,
    createdAt: row.created_at,
  };
}

export async function createAgentVersion(env: Env, input: {
  agentId: string;
  version: string;
  model?: string;
  config?: unknown;
  manifest?: unknown;
  status?: AgentVersionRecord["status"];
  capabilities?: Array<{ capability: string; config?: Record<string, unknown> }>;
  tools?: Array<{ toolName: string; enabled?: boolean; config?: Record<string, unknown> }>;
}): Promise<AgentVersionRecord> {
  const id = createId("agv");
  const timestamp = nowIso();
  const configR2Key = input.config !== undefined ? `agent-config/${input.agentId}/${id}.json` : null;
  const manifestR2Key = input.manifest !== undefined ? `agent-manifest/${input.agentId}/${id}.json` : null;

  if (configR2Key) {
    await env.R2_EMAIL.put(configR2Key, JSON.stringify(input.config, null, 2), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  }

  if (manifestR2Key) {
    await env.R2_EMAIL.put(manifestR2Key, JSON.stringify(input.manifest, null, 2), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  }

  await execute(env.D1_DB.prepare(
    `INSERT INTO agent_versions (
       id, agent_id, version, model, config_r2_key, manifest_r2_key, status, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    input.agentId,
    input.version,
    input.model ?? null,
    configR2Key,
    manifestR2Key,
    input.status ?? "draft",
    timestamp
  ));

  for (const capability of input.capabilities ?? []) {
    await execute(env.D1_DB.prepare(
      `INSERT INTO agent_capabilities (id, agent_version_id, capability, config_json, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      createId("agc"),
      id,
      capability.capability,
      capability.config ? JSON.stringify(capability.config) : null,
      timestamp
    ));
  }

  for (const tool of input.tools ?? []) {
    await execute(env.D1_DB.prepare(
      `INSERT INTO agent_tool_bindings (id, agent_version_id, tool_name, enabled, config_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      createId("agtb"),
      id,
      tool.toolName,
      Number(tool.enabled ?? true),
      tool.config ? JSON.stringify(tool.config) : null,
      timestamp
    ));
  }

  return requireRow(await getAgentVersion(env, input.agentId, id), "Failed to load created agent version");
}

export async function getAgentVersion(env: Env, agentId: string, versionId: string): Promise<AgentVersionRecord | null> {
  const row = await firstRow<AgentVersionRow>(
    env.D1_DB.prepare(
      `SELECT id, agent_id, version, model, config_r2_key, manifest_r2_key, status, created_at
       FROM agent_versions
       WHERE id = ? AND agent_id = ?`
    ).bind(versionId, agentId)
  );

  return row ? await mapAgentVersion(env, row) : null;
}

export async function listAgentVersions(env: Env, agentId: string): Promise<AgentVersionRecord[]> {
  const rows = await allRows<AgentVersionRow>(
    env.D1_DB.prepare(
      `SELECT id, agent_id, version, model, config_r2_key, manifest_r2_key, status, created_at
       FROM agent_versions
       WHERE agent_id = ?
       ORDER BY created_at DESC`
    ).bind(agentId)
  );

  return await Promise.all(rows.map((row) => mapAgentVersion(env, row)));
}

export async function createAgentDeployment(env: Env, input: {
  tenantId: string;
  agentId: string;
  agentVersionId: string;
  targetType: AgentDeploymentRecord["targetType"];
  targetId: string;
  status?: AgentDeploymentRecord["status"];
}): Promise<AgentDeploymentRecord> {
  const id = createId("agd");
  const timestamp = nowIso();

  const status = input.status ?? "active";
  try {
    await execute(env.D1_DB.prepare(
      `INSERT INTO agent_deployments (
         id, tenant_id, agent_id, agent_version_id, target_type, target_id, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      input.tenantId,
      input.agentId,
      input.agentVersionId,
      input.targetType,
      input.targetId,
      status,
      timestamp,
      timestamp
    ));
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    throw new DeploymentConflictError(
      `A ${status} deployment already exists for ${input.targetType} ${input.targetId}`
    );
  }

  return requireRow(await getAgentDeployment(env, input.agentId, id), "Failed to load created agent deployment");
}

export async function updateAgentDeploymentStatus(env: Env, input: {
  agentId: string;
  deploymentId: string;
  status: AgentDeploymentRecord["status"];
}): Promise<AgentDeploymentRecord | null> {
  const timestamp = nowIso();

  await execute(env.D1_DB.prepare(
    `UPDATE agent_deployments
     SET status = ?, updated_at = ?
     WHERE id = ? AND agent_id = ?`
  ).bind(
    input.status,
    timestamp,
    input.deploymentId,
    input.agentId
  ));

  return await getAgentDeployment(env, input.agentId, input.deploymentId);
}

export async function rolloutAgentDeployment(env: Env, input: {
  tenantId: string;
  agentId: string;
  agentVersionId: string;
  targetType: AgentDeploymentRecord["targetType"];
  targetId: string;
}): Promise<AgentDeploymentRecord> {
  const timestamp = nowIso();

  await execute(env.D1_DB.prepare(
    `UPDATE agent_deployments
     SET status = 'rolled_back', updated_at = ?
     WHERE tenant_id = ?
       AND target_type = ?
       AND target_id = ?
       AND status = 'active'`
  ).bind(
    timestamp,
    input.tenantId,
    input.targetType,
    input.targetId
  ));

  return await createAgentDeployment(env, {
    tenantId: input.tenantId,
    agentId: input.agentId,
    agentVersionId: input.agentVersionId,
    targetType: input.targetType,
    targetId: input.targetId,
    status: "active",
  });
}

export async function rollbackAgentDeployment(env: Env, input: {
  agentId: string;
  deploymentId: string;
}): Promise<AgentDeploymentRecord | null> {
  const deployment = await getAgentDeployment(env, input.agentId, input.deploymentId);
  if (!deployment) {
    return null;
  }

  const timestamp = nowIso();

  await execute(env.D1_DB.prepare(
    `UPDATE agent_deployments
     SET status = 'rolled_back', updated_at = ?
     WHERE tenant_id = ?
       AND target_type = ?
       AND target_id = ?
       AND status = 'active'
       AND id != ?`
  ).bind(
    timestamp,
    deployment.tenantId,
    deployment.targetType,
    deployment.targetId,
    deployment.id
  ));

  await execute(env.D1_DB.prepare(
    `UPDATE agent_deployments
     SET status = 'active', updated_at = ?
     WHERE id = ? AND agent_id = ?`
  ).bind(
    timestamp,
    deployment.id,
    input.agentId
  ));

  return await getAgentDeployment(env, input.agentId, input.deploymentId);
}

export async function getAgentDeployment(env: Env, agentId: string, deploymentId: string): Promise<AgentDeploymentRecord | null> {
  const row = await firstRow<AgentDeploymentRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, agent_id, agent_version_id, target_type, target_id, status, created_at, updated_at
       FROM agent_deployments
       WHERE id = ? AND agent_id = ?`
    ).bind(deploymentId, agentId)
  );

  return row ? mapDeploymentRow(row) : null;
}

export async function listAgentDeployments(env: Env, agentId: string): Promise<AgentDeploymentRecord[]> {
  const rows = await allRows<AgentDeploymentRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, agent_id, agent_version_id, target_type, target_id, status, created_at, updated_at
       FROM agent_deployments
       WHERE agent_id = ?
       ORDER BY created_at DESC`
    ).bind(agentId)
  );

  return rows.map(mapDeploymentRow);
}

export async function resolveAgentExecutionTarget(
  env: Env,
  mailboxId: string,
  requestedAgentId?: string,
  bindingRoles?: AgentMailboxBindingRecord["role"][],
): Promise<AgentExecutionTarget | null> {
  let requestedAgentHasRoleBinding = false;

  if (bindingRoles?.length && requestedAgentId) {
    requestedAgentHasRoleBinding = await hasActiveMailboxBinding(env, {
      agentId: requestedAgentId,
      mailboxId,
      roles: bindingRoles,
    });
    if (!requestedAgentHasRoleBinding) {
      const hasAnyBinding = await hasActiveMailboxBinding(env, {
        agentId: requestedAgentId,
        mailboxId,
      });
      if (hasAnyBinding) {
        return null;
      }
    }
  }

  try {
    if (bindingRoles?.length) {
      const deploymentRows = requestedAgentId
        ? await allRows<{
            id: string;
            agent_id: string;
            agent_version_id: string;
          }>(
            env.D1_DB.prepare(
              `SELECT id, agent_id, agent_version_id
               FROM agent_deployments
               WHERE target_type = 'mailbox' AND target_id = ? AND status = 'active' AND agent_id = ?
               ORDER BY created_at DESC`
            ).bind(mailboxId, requestedAgentId)
          )
        : await allRows<{
            id: string;
            agent_id: string;
            agent_version_id: string;
          }>(
            env.D1_DB.prepare(
              `SELECT id, agent_id, agent_version_id
               FROM agent_deployments
               WHERE target_type = 'mailbox' AND target_id = ? AND status = 'active'
               ORDER BY created_at DESC`
            ).bind(mailboxId)
          );

      let fallbackDeployment:
        | { id: string; agent_id: string; agent_version_id: string }
        | undefined;

      for (const deployment of deploymentRows) {
        const hasMatchingBinding = await hasActiveMailboxBinding(env, {
          agentId: deployment.agent_id,
          mailboxId,
          roles: bindingRoles,
        });
        if (hasMatchingBinding) {
          return {
            agentId: deployment.agent_id,
            agentVersionId: deployment.agent_version_id,
            deploymentId: deployment.id,
          };
        }

        const hasAnyBinding = await hasActiveMailboxBinding(env, {
          agentId: deployment.agent_id,
          mailboxId,
        });
        if (!hasAnyBinding && !fallbackDeployment) {
          fallbackDeployment = deployment;
        }
      }

      if (fallbackDeployment) {
        return {
          agentId: fallbackDeployment.agent_id,
          agentVersionId: fallbackDeployment.agent_version_id,
          deploymentId: fallbackDeployment.id,
        };
      }
    } else {
      const deploymentQuery = requestedAgentId
        ? env.D1_DB.prepare(
            `SELECT id, agent_id, agent_version_id
             FROM agent_deployments
             WHERE target_type = 'mailbox' AND target_id = ? AND status = 'active' AND agent_id = ?
             ORDER BY created_at DESC
             LIMIT 1`
          ).bind(mailboxId, requestedAgentId)
        : env.D1_DB.prepare(
            `SELECT id, agent_id, agent_version_id
             FROM agent_deployments
             WHERE target_type = 'mailbox' AND target_id = ? AND status = 'active'
             ORDER BY created_at DESC
             LIMIT 1`
          ).bind(mailboxId);
      const deployment = await firstRow<{
        id: string;
        agent_id: string;
        agent_version_id: string;
      }>(deploymentQuery);

      if (deployment) {
        return {
          agentId: deployment.agent_id,
          agentVersionId: deployment.agent_version_id,
          deploymentId: deployment.id,
        };
      }
    }
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error;
    }
  }

  if (requestedAgentId) {
    if (bindingRoles?.length && !requestedAgentHasRoleBinding) {
      return null;
    }

    const agent = await getAgent(env, requestedAgentId);
    if (!agent) {
      return null;
    }

    return {
      agentId: requestedAgentId,
      agentVersionId: agent.defaultVersionId ?? undefined,
    };
  }

  const fallback = bindingRoles?.length
    ? await firstRow<{ agent_id: string }>(
        env.D1_DB.prepare(
          `SELECT agent_id
           FROM agent_mailboxes
           WHERE mailbox_id = ? AND status = 'active' AND role IN (${bindingRoles.map(() => "?").join(", ")})
           ORDER BY created_at ASC
           LIMIT 1`
        ).bind(mailboxId, ...bindingRoles)
      )
    : await firstRow<{ agent_id: string }>(
        env.D1_DB.prepare(
          `SELECT agent_id
           FROM agent_mailboxes
           WHERE mailbox_id = ? AND status = 'active'
           ORDER BY created_at ASC
           LIMIT 1`
        ).bind(mailboxId)
      );

  return fallback ? { agentId: fallback.agent_id } : null;
}

export async function hasActiveMailboxBinding(env: Env, input: {
  agentId: string;
  mailboxId: string;
  roles?: AgentMailboxBindingRecord["role"][];
}): Promise<boolean> {
  const row = input.roles?.length
    ? await firstRow<{ agent_id: string }>(
        env.D1_DB.prepare(
          `SELECT agent_id
           FROM agent_mailboxes
           WHERE mailbox_id = ? AND agent_id = ? AND status = 'active' AND role IN (${input.roles.map(() => "?").join(", ")})
           ORDER BY created_at ASC
           LIMIT 1`
        ).bind(input.mailboxId, input.agentId, ...input.roles)
      )
    : await firstRow<{ agent_id: string }>(
        env.D1_DB.prepare(
          `SELECT agent_id
           FROM agent_mailboxes
           WHERE mailbox_id = ? AND agent_id = ? AND status = 'active'
           ORDER BY created_at ASC
           LIMIT 1`
        ).bind(input.mailboxId, input.agentId)
      );

  return Boolean(row);
}

export async function hasActiveMailboxDeployment(env: Env, input: {
  agentId: string;
  mailboxId: string;
}): Promise<boolean> {
  const row = await firstRow<{ id: string }>(
    env.D1_DB.prepare(
      `SELECT id
       FROM agent_deployments
       WHERE target_type = 'mailbox' AND target_id = ? AND status = 'active' AND agent_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
    ).bind(input.mailboxId, input.agentId)
  );

  return Boolean(row);
}

async function getAgentMailboxBinding(env: Env, input: {
  agentId: string;
  mailboxId: string;
}): Promise<AgentMailboxBindingRecord | null> {
  const row = await firstRow<AgentMailboxRow>(
    env.D1_DB.prepare(
      `SELECT id, agent_id, mailbox_id, role, status, created_at
       FROM agent_mailboxes
       WHERE agent_id = ? AND mailbox_id = ?
       LIMIT 1`
    ).bind(input.agentId, input.mailboxId)
  );

  return row ? mapMailboxRow(row) : null;
}

export async function bindMailbox(env: Env, input: {
  tenantId: string;
  agentId: string;
  mailboxId: string;
  role: AgentMailboxBindingRecord["role"];
}): Promise<AgentMailboxBindingRecord> {
  const id = createId("amb");
  const createdAt = nowIso();

  try {
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
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    const existing = await getAgentMailboxBinding(env, {
      agentId: input.agentId,
      mailboxId: input.mailboxId,
    });
    if (existing) {
      if (existing.role !== input.role) {
        throw new MailboxConflictError(`Mailbox ${input.mailboxId} is already bound to agent ${input.agentId} with role ${existing.role}`);
      }
      if (existing.status !== "active") {
        throw new MailboxConflictError(`Mailbox ${input.mailboxId} is already bound to agent ${input.agentId} with status ${existing.status}`);
      }
      return existing;
    }

    throw error;
  }

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

export async function listMailboxes(env: Env): Promise<MailboxRecord[]> {
  const rows = await allRows<MailboxRow>(
    env.D1_DB.prepare(
      `SELECT id, tenant_id, address, status, created_at
       FROM mailboxes
       ORDER BY created_at DESC`
    )
  );

  return rows.map(mapMailboxRecord);
}

export async function ensureMailbox(env: Env, input: {
  tenantId: string;
  address: string;
  status?: string;
}): Promise<MailboxRecord> {
  const normalizedAddress = input.address.trim().toLowerCase();
  const existing = await getMailboxByAddress(env, normalizedAddress);
  if (existing) {
    if (existing.tenant_id !== input.tenantId) {
      throw new MailboxConflictError(`Mailbox ${normalizedAddress} already belongs to a different tenant`);
    }
    return mapMailboxRecord(existing);
  }

  const id = createId("mbx");
  const createdAt = nowIso();
  try {
    await execute(env.D1_DB.prepare(
      `INSERT INTO mailboxes (id, tenant_id, address, status, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      id,
      input.tenantId,
      normalizedAddress,
      input.status ?? "active",
      createdAt
    ));
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    const concurrent = await getMailboxByAddress(env, normalizedAddress);
    if (concurrent) {
      if (concurrent.tenant_id !== input.tenantId) {
        throw new MailboxConflictError(`Mailbox ${normalizedAddress} already belongs to a different tenant`);
      }
      return mapMailboxRecord(concurrent);
    }

    throw error;
  }

  return {
    id,
    tenantId: input.tenantId,
    address: normalizedAddress,
    status: input.status ?? "active",
    createdAt,
  };
}
