import {
  CONTACT_ALIAS_LOCALPARTS,
} from "../contact-aliases";
import {
  isCatchAllWorkerRule,
  listEmailRoutingRules,
  upsertCatchAllWorkerRule,
} from "../cloudflare-email";
import { allRows, execute } from "../db";
import { readJson } from "../http";
import { createId } from "../ids";
import {
  AgentRegistryConflictError,
  bindMailbox,
  createAgent,
  createAgentDeployment,
  createAgentVersion,
  DeploymentConflictError,
  ensureMailbox,
  getMailboxByAddress,
  listAgents,
  listAgentVersions,
  MailboxConflictError,
  updateAgent,
  upsertAgentPolicy,
} from "../../repositories/agents";
import { createDraft, deleteDraftIfUnqueued, enqueueDraftSend } from "../../repositories/mail";
import { upsertTenantSendPolicy } from "../../repositories/tenant-policies";
import type { Env } from "../../types";
import { OutboundSendValidationError, ensureSystemSendAllowed } from "../system-sends";
import { issueSelfServeAccessToken } from "./default-access";
import { buildDefaultSelfServeAgentPolicy } from "../self-serve-agent-policy";
import { buildWelcomeHtml, buildWelcomeText } from "./welcome";

export class SignupError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SignupError";
    this.status = status;
  }
}

export interface SignupFormValues {
  mailboxAlias: string;
  agentName: string;
  operatorEmail: string;
  productName: string;
  useCase: string;
}

export interface SignupPageState {
  values?: Partial<SignupFormValues>;
  error?: string;
  notice?: string;
}

export interface SignupSuccessResult {
  tenantId: string;
  productName: string;
  operatorEmail: string;
  mailboxAddress: string;
  mailboxId: string;
  agentId: string;
  agentVersionId: string;
  deploymentId: string;
  accessToken?: string;
  accessTokenExpiresAt?: string;
  accessTokenScopes: string[];
  outboundJobId?: string;
  routingStatus: "configured" | "skipped" | "failed";
  routingError?: string;
  welcomeStatus: "queued" | "failed";
  welcomeError?: string;
}

interface NullableR2KeyRow {
  r2_key: string | null;
}

export const RESERVED_SELF_SERVE_ALIASES = new Set([
  "admin",
  "api",
  ...CONTACT_ALIAS_LOCALPARTS,
  "support",
  "www",
]);

const MAILBOX_ALIAS_UNAVAILABLE_MESSAGE = "The requested mailbox alias is unavailable. Please choose a different alias.";
const SIGNUP_PROVISIONING_CONFLICT_MESSAGE =
  "Self-serve signup could not be completed because mailbox provisioning state already exists. Please choose a different alias and try again.";
const SIGNUP_INITIAL_ACCESS_UNAVAILABLE_MESSAGE =
  "Self-serve signup could not deliver an initial access token in this environment. Use an operator email on the hosted mailbox domain or enable legacy inline signup token return before retrying.";

export async function parseSelfServeSignup(request: Request): Promise<
  | { ok: true; values: SignupFormValues }
  | { ok: false; values: Partial<SignupFormValues>; error: string }
> {
  const body = await readJson<Record<string, unknown>>(request);
  const values: Partial<SignupFormValues> = {
    mailboxAlias: String(body.mailboxAlias ?? "").trim().toLowerCase(),
    agentName: String(body.agentName ?? "").trim(),
    operatorEmail: String(body.operatorEmail ?? "").trim().toLowerCase(),
    productName: String(body.productName ?? "").trim(),
    useCase: String(body.useCase ?? "").trim(),
  };

  if (!values.mailboxAlias || !values.agentName || !values.operatorEmail || !values.productName || !values.useCase) {
    return {
      ok: false,
      values,
      error: "Mailbox alias, agent name, operator email, product name, and use case are all required.",
    };
  }

  if (!/^[a-z0-9][a-z0-9._+-]{2,31}$/.test(values.mailboxAlias)) {
    return {
      ok: false,
      values,
      error: "Mailbox alias must be 3-32 characters and use lowercase letters, numbers, dot, dash, underscore, or plus.",
    };
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.operatorEmail)) {
    return {
      ok: false,
      values,
      error: "Operator email must be a valid email address.",
    };
  }

  return { ok: true, values: values as SignupFormValues };
}

export async function performSelfServeSignup(env: Env, values: SignupFormValues): Promise<SignupSuccessResult> {
  const domain = env.CLOUDFLARE_EMAIL_DOMAIN ?? "mailagents.net";
  const alias = normalizeAlias(values.mailboxAlias);

  if (RESERVED_SELF_SERVE_ALIASES.has(alias)) {
    throw new SignupError(MAILBOX_ALIAS_UNAVAILABLE_MESSAGE, 409);
  }

  const address = `${alias}@${domain}`;
  const existing = await getMailboxByAddress(env, address);
  if (existing) {
    throw new SignupError(MAILBOX_ALIAS_UNAVAILABLE_MESSAGE, 409);
  }

  const routing = await ensureSignupRouting(env);
  if (routing.status === "failed" && shouldRequireConfiguredSignupRouting(env)) {
    throw new SignupError(
      routing.error ?? "Self-serve signup is temporarily unavailable because inbound routing could not be configured.",
      503,
    );
  }
  if (routing.status === "skipped" && shouldRequireConfiguredSignupRouting(env)) {
    throw new SignupError(
      routing.error ?? "Self-serve signup is unavailable until inbound routing automation is configured for this environment.",
      503,
    );
  }

  const tenantId = createId("tnt");
  try {
    let mailbox;
    try {
      mailbox = await ensureMailbox(env, {
        tenantId,
        address,
        status: "active",
      });
    } catch (error) {
      if (error instanceof MailboxConflictError) {
        throw new SignupError(MAILBOX_ALIAS_UNAVAILABLE_MESSAGE, 409);
      }
      throw error;
    }

    const agent = await createAgent(env, {
      tenantId,
      slug: `${alias}-primary`,
      name: values.agentName,
      description: buildAgentDescription(values),
      mode: "assistant",
      config: {
        productName: values.productName,
        operatorEmail: values.operatorEmail,
        useCase: values.useCase,
        mailboxAddress: address,
      },
    });

    await bindMailbox(env, {
      tenantId,
      agentId: agent.id,
      mailboxId: mailbox.id,
      role: "primary",
    });

    const version = await createAgentVersion(env, {
      agentId: agent.id,
      version: "self-serve-v1",
      model: "gpt-5",
      status: "published",
      config: {
        mode: "assistant",
        onboarding: "self_serve",
        mailboxAddress: address,
      },
      manifest: {
        productName: values.productName,
        operatorEmail: values.operatorEmail,
        useCase: values.useCase,
      },
      capabilities: [
        { capability: "read_inbound_email" },
        { capability: "reply_email" },
        { capability: "transactional_send" },
      ],
      tools: [
        { toolName: "reply_email", enabled: true },
        { toolName: "mark_task_done", enabled: true },
      ],
    });

    await updateAgent(env, agent.id, { defaultVersionId: version.id });

    const deployment = await createAgentDeployment(env, {
      tenantId,
      agentId: agent.id,
      agentVersionId: version.id,
      targetType: "mailbox",
      targetId: mailbox.id,
      status: "active",
    });

    await upsertAgentPolicy(env, buildDefaultSelfServeAgentPolicy({
      agentId: agent.id,
      internalDomainAllowlist: [domain],
    }));

    await upsertTenantSendPolicy(env, {
      tenantId,
      pricingTier: "free",
      outboundStatus: "internal_only",
      internalDomainAllowlist: [domain],
      externalSendEnabled: false,
      reviewRequired: true,
    });

    const access = await issueSelfServeAccessToken({
      env,
      tenantId,
      agentId: agent.id,
      mailboxId: mailbox.id,
    });
    const inlineSignupTokenEnabled = shouldIssueInlineSignupToken(env);

    let outboundJobId: string | undefined;
    let welcomeStatus: SignupSuccessResult["welcomeStatus"] = "queued";
    let welcomeError: string | undefined;
    let welcomeDraftId: string | undefined;

    try {
      await ensureSystemSendAllowed(env, {
        tenantId,
        agentId: agent.id,
        to: [values.operatorEmail],
        createdVia: "system:signup_welcome",
      });

      const draft = await createDraft(env, {
        tenantId,
        agentId: agent.id,
        mailboxId: mailbox.id,
        createdVia: "system:signup_welcome",
        payload: {
          from: address,
          to: [values.operatorEmail],
          subject: `Your Mailagents mailbox ${address} is ready`,
          text: buildWelcomeText({
            mailboxAddress: address,
            productName: values.productName,
            agentName: values.agentName,
            accessToken: access.accessToken,
            accessTokenExpiresAt: access.accessTokenExpiresAt,
            accessTokenScopes: access.accessTokenScopes,
          }),
          html: buildWelcomeHtml({
            mailboxAddress: address,
            productName: values.productName,
            agentName: values.agentName,
            accessToken: access.accessToken,
            accessTokenExpiresAt: access.accessTokenExpiresAt,
            accessTokenScopes: access.accessTokenScopes,
          }),
          attachments: [],
        },
      });
      welcomeDraftId = draft.id;

      const sendResult = await enqueueDraftSend(env, draft.id);
      outboundJobId = sendResult.outboundJobId;
    } catch (error) {
      if (welcomeDraftId) {
        await deleteDraftIfUnqueued(env, welcomeDraftId).catch(() => undefined);
      }
      welcomeStatus = "failed";
      welcomeError = error instanceof OutboundSendValidationError
        ? error.message
        : error instanceof Error
        ? error.message
        : "Unable to queue onboarding email";
    }

    if (!inlineSignupTokenEnabled && welcomeStatus !== "queued") {
      throw new SignupError(SIGNUP_INITIAL_ACCESS_UNAVAILABLE_MESSAGE, 503);
    }

    return {
      tenantId,
      productName: values.productName,
      operatorEmail: values.operatorEmail,
      mailboxAddress: address,
      mailboxId: mailbox.id,
      agentId: agent.id,
      agentVersionId: version.id,
      deploymentId: deployment.id,
      accessToken: inlineSignupTokenEnabled ? access.accessToken : undefined,
      accessTokenExpiresAt: inlineSignupTokenEnabled ? access.accessTokenExpiresAt : undefined,
      accessTokenScopes: access.accessTokenScopes,
      outboundJobId,
      routingStatus: routing.status,
      routingError: routing.error,
      welcomeStatus,
      welcomeError,
    };
  } catch (error) {
    await cleanupPartialSelfServeSignup(env, tenantId).catch((cleanupError) => {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.error(`[signup] cleanup failed for tenant ${tenantId}: ${message}`);
    });
    if (
      error instanceof AgentRegistryConflictError
      || error instanceof DeploymentConflictError
      || error instanceof MailboxConflictError
    ) {
      throw new SignupError(SIGNUP_PROVISIONING_CONFLICT_MESSAGE, 409);
    }
    throw error;
  }
}

function shouldRequireConfiguredSignupRouting(env: Env): boolean {
  const explicit = env.SELF_SERVE_REQUIRE_CONFIGURED_ROUTING?.trim().toLowerCase();
  if (explicit) {
    return ["1", "true", "yes", "on"].includes(explicit);
  }

  const domain = (env.CLOUDFLARE_EMAIL_DOMAIN ?? "").trim().toLowerCase();
  if (!domain) {
    return false;
  }

  return !domain.endsWith(".test") && !domain.endsWith(".example") && !domain.endsWith(".example.com");
}

function shouldIssueInlineSignupToken(env: Env): boolean {
  const explicit = env.SELF_SERVE_PUBLIC_SIGNUP_INLINE_TOKEN_ENABLED?.trim().toLowerCase();
  return explicit ? ["1", "true", "yes", "on"].includes(explicit) : false;
}

function shouldAutoconfigureSignupRouting(env: Env): boolean {
  const explicit = env.SELF_SERVE_PUBLIC_SIGNUP_ROUTING_AUTOCONFIG_ENABLED?.trim().toLowerCase();
  return explicit ? ["1", "true", "yes", "on"].includes(explicit) : false;
}

async function cleanupPartialSelfServeSignup(env: Env, tenantId: string): Promise<void> {
  const agents = await listAgents(env, tenantId);
  const versionRecords = await Promise.all(agents.map((agent) => listAgentVersions(env, agent.id)));
  const r2Keys = new Set<string>();
  const [
    taskTraceRows,
    agentRunTraceRows,
    messageBlobRows,
    draftBlobRows,
    attachmentBlobRows,
    deliveryEventBlobRows,
  ] = await Promise.all([
    allRows<NullableR2KeyRow>(
      env.D1_DB.prepare(
        `SELECT result_r2_key AS r2_key
         FROM tasks
         WHERE tenant_id = ?`
      ).bind(tenantId)
    ),
    allRows<NullableR2KeyRow>(
      env.D1_DB.prepare(
        `SELECT ar.trace_r2_key AS r2_key
         FROM agent_runs ar
         INNER JOIN tasks t ON t.id = ar.task_id
         WHERE t.tenant_id = ?`
      ).bind(tenantId)
    ),
    allRows<NullableR2KeyRow>(
      env.D1_DB.prepare(
        `SELECT raw_r2_key AS r2_key
         FROM messages
         WHERE tenant_id = ?
         UNION ALL
         SELECT normalized_r2_key AS r2_key
         FROM messages
         WHERE tenant_id = ?`
      ).bind(tenantId, tenantId)
    ),
    allRows<NullableR2KeyRow>(
      env.D1_DB.prepare(
        `SELECT draft_r2_key AS r2_key
         FROM drafts
         WHERE tenant_id = ?`
      ).bind(tenantId)
    ),
    allRows<NullableR2KeyRow>(
      env.D1_DB.prepare(
        `SELECT a.r2_key AS r2_key
         FROM attachments a
         INNER JOIN messages m ON m.id = a.message_id
         WHERE m.tenant_id = ?`
      ).bind(tenantId)
    ),
    allRows<NullableR2KeyRow>(
      env.D1_DB.prepare(
        `SELECT de.payload_r2_key AS r2_key
         FROM delivery_events de
         INNER JOIN messages m ON m.id = de.message_id
         WHERE m.tenant_id = ?`
      ).bind(tenantId)
    ),
  ]);

  for (const agent of agents) {
    if (agent.configR2Key) {
      r2Keys.add(agent.configR2Key);
    }
  }
  for (const versions of versionRecords) {
    for (const version of versions) {
      if (version.configR2Key) {
        r2Keys.add(version.configR2Key);
      }
      if (version.manifestR2Key) {
        r2Keys.add(version.manifestR2Key);
      }
    }
  }
  for (const row of [
    ...taskTraceRows,
    ...agentRunTraceRows,
    ...messageBlobRows,
    ...draftBlobRows,
    ...attachmentBlobRows,
    ...deliveryEventBlobRows,
  ]) {
    if (row.r2_key) {
      r2Keys.add(row.r2_key);
    }
  }

  await Promise.all(Array.from(r2Keys).map((key) => env.R2_EMAIL.delete(key).catch(() => undefined)));

  await execute(env.D1_DB.prepare(
    `DELETE FROM agent_tool_bindings
     WHERE agent_version_id IN (
       SELECT av.id
       FROM agent_versions av
       INNER JOIN agents a ON a.id = av.agent_id
       WHERE a.tenant_id = ?
     )`
  ).bind(tenantId));
  await execute(env.D1_DB.prepare(
    `DELETE FROM agent_capabilities
     WHERE agent_version_id IN (
       SELECT av.id
       FROM agent_versions av
       INNER JOIN agents a ON a.id = av.agent_id
       WHERE a.tenant_id = ?
     )`
  ).bind(tenantId));
  await execute(env.D1_DB.prepare(
    `DELETE FROM agent_deployments WHERE tenant_id = ?`
  ).bind(tenantId));
  await execute(env.D1_DB.prepare(
    `DELETE FROM agent_mailboxes WHERE tenant_id = ?`
  ).bind(tenantId));
  await execute(env.D1_DB.prepare(
    `DELETE FROM agent_policies
     WHERE agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)`
  ).bind(tenantId));
  await execute(env.D1_DB.prepare(
    `DELETE FROM agent_versions
     WHERE agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)`
  ).bind(tenantId));
  await execute(env.D1_DB.prepare(
    `DELETE FROM tenant_send_policies WHERE tenant_id = ?`
  ).bind(tenantId));
  await execute(env.D1_DB.prepare(
    `DELETE FROM agent_runs
     WHERE task_id IN (SELECT id FROM tasks WHERE tenant_id = ?)`
  ).bind(tenantId));
  await execute(env.D1_DB.prepare(
    `DELETE FROM tasks WHERE tenant_id = ?`
  ).bind(tenantId));
  await execute(env.D1_DB.prepare(
    `DELETE FROM delivery_events
     WHERE message_id IN (SELECT id FROM messages WHERE tenant_id = ?)`
  ).bind(tenantId));
  await execute(env.D1_DB.prepare(
    `DELETE FROM attachments
     WHERE message_id IN (SELECT id FROM messages WHERE tenant_id = ?)`
  ).bind(tenantId));
  await execute(env.D1_DB.prepare(
    `DELETE FROM outbound_jobs
     WHERE message_id IN (SELECT id FROM messages WHERE tenant_id = ?)`
  ).bind(tenantId));
  await execute(env.D1_DB.prepare(
    `DELETE FROM drafts WHERE tenant_id = ?`
  ).bind(tenantId));
  await execute(env.D1_DB.prepare(
    `DELETE FROM messages WHERE tenant_id = ?`
  ).bind(tenantId));
  await execute(env.D1_DB.prepare(
    `DELETE FROM threads WHERE tenant_id = ?`
  ).bind(tenantId));
  await execute(env.D1_DB.prepare(
    `DELETE FROM tenant_credit_ledger WHERE tenant_id = ?`
  ).bind(tenantId));
  await execute(env.D1_DB.prepare(
    `DELETE FROM tenant_payment_receipts WHERE tenant_id = ?`
  ).bind(tenantId));
  await execute(env.D1_DB.prepare(
    `DELETE FROM tenant_billing_accounts WHERE tenant_id = ?`
  ).bind(tenantId));
  await execute(env.D1_DB.prepare(
    `DELETE FROM tenant_did_bindings WHERE tenant_id = ?`
  ).bind(tenantId));
  await execute(env.D1_DB.prepare(
    `DELETE FROM agents WHERE tenant_id = ?`
  ).bind(tenantId));
  await execute(env.D1_DB.prepare(
    `DELETE FROM mailboxes WHERE tenant_id = ?`
  ).bind(tenantId));
}

async function ensureSignupRouting(env: Env): Promise<{
  status: SignupSuccessResult["routingStatus"];
  error?: string;
}> {
  if (!shouldAutoconfigureSignupRouting(env)) {
    return {
      status: "skipped",
      error: "Self-serve signup routing autoconfiguration is disabled for public requests in this environment.",
    };
  }

  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ZONE_ID || !env.CLOUDFLARE_EMAIL_WORKER) {
    return {
      status: "skipped",
      error: "Cloudflare Email Routing automation is not configured in this environment.",
    };
  }

  try {
    const rules = await listEmailRoutingRules(env);
    const catchAllRule = rules.find((entry) => isCatchAllWorkerRule(entry, env.CLOUDFLARE_EMAIL_WORKER));
    if (!catchAllRule) {
      await upsertCatchAllWorkerRule(env, env.CLOUDFLARE_EMAIL_WORKER);
    }

    return { status: "configured" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cloudflare Email Routing automation failed";
    console.error(`[signup] email routing automation failed: ${message}`);
    return {
      status: "failed",
      error: message,
    };
  }
}

export function normalizeAlias(alias: string): string {
  return alias.trim().toLowerCase();
}

export function buildAgentDescription(values: SignupFormValues): string {
  return `${values.productName}: ${values.useCase}`;
}
