import { createId } from "../lib/ids";
import {
  enforceAgentAccess,
  enforceMailboxAccess,
  enforceTenantAccess,
  mintAccessToken,
  requireAdminRoutesEnabled,
  requireAdminSecret,
  requireAuth,
  requireDebugRoutesEnabled,
} from "../lib/auth";
import { accepted, badRequest, json, readJson, readOptionalJson } from "../lib/http";
import { Router } from "../lib/router";
import { buildCompatibilityContract, buildRuntimeMetadata, COMPATIBILITY_CONTRACT_SCHEMA } from "../lib/runtime-metadata";
import { normalizeSesEvent } from "../lib/ses-events";
import {
  buildTokenReissueHtml,
  buildTokenReissueText,
  escapeHtml,
  parseSelfServeSignup,
  performSelfServeSignup,
  type SignupPageState,
  type SignupSuccessResult,
} from "../lib/self-serve";
import { issueSelfServeAccessToken } from "../lib/provisioning/default-access";
import {
  bindMailbox,
  createAgent,
  createAgentDeployment,
  createAgentVersion,
  getAgent,
  getAgentDeployment,
  getAgentVersion,
  getMailboxByAddress,
  getMailboxById,
  listAgentDeployments,
  listAgentMailboxes,
  listAgents,
  listAgentVersions,
  resolveAgentExecutionTarget,
  rollbackAgentDeployment,
  rolloutAgentDeployment,
  updateAgent,
  updateAgentDeploymentStatus,
  upsertAgentPolicy,
} from "../repositories/agents";
import {
  createDraft,
  enqueueDraftSend,
  completeIdempotencyKey,
  getDraft,
  getMessage,
  getMessageByProviderMessageId,
  getMessageContent,
  getThread,
  getOutboundJobByMessageId,
  getOutboundJob,
  getSuppression,
  insertDeliveryEvent,
  listTasks,
  listDeliveryEventsByMessageId,
  releaseIdempotencyKey,
  reserveIdempotencyKey,
  addSuppression,
  updateOutboundJobStatus,
  updateMessageStatusByProviderMessageId,
} from "../repositories/mail";
import {
  countRecentIpTokenReissues,
  getIpMaxRequests,
  getIpWindowSeconds,
  getMailboxCooldownSeconds,
  hasRecentMailboxTokenReissue,
  logTokenReissueRequest,
} from "../repositories/token-reissue";
import type { AccessTokenClaims, Env } from "../types";

const router = new Router<Env>();

router.on("GET", "/public/signup", async () => {
  return new Response(null, {
    status: 302,
    headers: {
      location: "https://mailagents.net/signup",
    },
  });
});

router.on("HEAD", "/public/signup", async () => {
  return new Response(null, {
    status: 302,
    headers: {
      location: "https://mailagents.net/signup",
    },
  });
});

router.on("POST", "/public/signup", async (request, env) => {
  const parsed = await parseSelfServeSignup(request);
  const expectsHtml = wantsHtmlResponse(request);

  if (!parsed.ok) {
    return expectsHtml
      ? html(renderPublicSignupResult("Start Signup", renderPublicSignupError(parsed)))
      : json({ error: parsed.error, values: parsed.values }, { status: 400 });
  }

  try {
    const result = await performSelfServeSignup(env, parsed.values);
    return expectsHtml
      ? html(renderPublicSignupResult("Signup Complete", renderPublicSignupSuccess(result)), { status: 201 })
      : json(result, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to complete self-serve signup";
    return expectsHtml
      ? html(renderPublicSignupResult("Start Signup", renderPublicSignupError({ values: parsed.values, error: message })), { status: 502 })
      : json({ error: message, values: parsed.values }, { status: 502 });
  }
});

router.on("POST", "/public/token/reissue", async (request, env) => {
  const body = await readJson<{
    mailboxAlias?: string;
    mailboxAddress?: string;
  }>(request);

  const mailboxAddress = normalizeMailboxLookup(env, body);
  if (!mailboxAddress) {
    return badRequest("mailboxAlias or mailboxAddress is required");
  }

  const requesterIpHash = await hashRequesterIp(request.headers.get("cf-connecting-ip"));
  const mailboxCooldownSince = isoSecondsAgo(getMailboxCooldownSeconds(env));
  const ipWindowSince = isoSecondsAgo(getIpWindowSeconds(env));

  try {
    if (await hasRecentMailboxTokenReissue(env, mailboxAddress, mailboxCooldownSince)) {
      return accepted({
        accepted: true,
        message: "If the mailbox exists, a refreshed access token will be emailed to the original operator inbox.",
      });
    }

    if (requesterIpHash) {
      const recentIpRequests = await countRecentIpTokenReissues(env, requesterIpHash, ipWindowSince);
      if (recentIpRequests >= getIpMaxRequests(env)) {
        return accepted({
          accepted: true,
          message: "If the mailbox exists, a refreshed access token will be emailed to the original operator inbox.",
        });
      }
    }
  } catch {
    // If the rate-limit table is unavailable, fail open and continue with the generic flow.
  }

  if (env.API_SIGNING_SECRET) {
    try {
      await reissueMailboxAccessToken(env, mailboxAddress);
      await logTokenReissueRequest(env, {
        mailboxAddress,
        requesterIpHash: requesterIpHash ?? undefined,
      }).catch(() => undefined);
    } catch {
      // Intentionally swallow errors so the endpoint does not disclose mailbox existence or operator metadata.
    }
  }

  return accepted({
    accepted: true,
    message: "If the mailbox exists, a refreshed access token will be emailed to the original operator inbox.",
  });
});

router.on("POST", "/v1/auth/token/rotate", async (request, env) => {
  const auth = await requireAuth(request, env, []);
  if (auth instanceof Response) {
    return auth;
  }

  const body = await readOptionalJson<{
    delivery?: "inline" | "self_mailbox" | "both";
    mailboxId?: string;
  }>(request);
  const delivery = body?.delivery ?? "inline";
  if (!["inline", "self_mailbox", "both"].includes(delivery)) {
    return badRequest("delivery must be one of: inline, self_mailbox, both");
  }

  const rotated = await rotateAccessToken(env, auth);
  if (!rotated.accessToken) {
    return json({ error: "Unable to issue rotated token" }, { status: 500 });
  }

  let deliveryStatus: "skipped" | "queued" | "unavailable" = "skipped";
  let deliveryMailboxId: string | undefined;

  if (delivery === "self_mailbox" || delivery === "both") {
    const targetMailboxId = resolveRotateMailboxId(auth, body?.mailboxId);
    if (!targetMailboxId) {
      return badRequest("mailboxId is required for self_mailbox delivery when the token covers multiple or no mailboxes");
    }

    const mailboxError = enforceMailboxAccess(auth, targetMailboxId);
    if (mailboxError) {
      return mailboxError;
    }

    const delivered = await deliverRotatedTokenToSelfMailbox(env, auth, targetMailboxId, rotated.accessToken, rotated.accessTokenExpiresAt, rotated.accessTokenScopes);
    deliveryStatus = delivered ? "queued" : "unavailable";
    deliveryMailboxId = targetMailboxId;
  }

  return json({
    token: delivery === "self_mailbox" ? undefined : rotated.accessToken,
    expiresAt: rotated.accessTokenExpiresAt,
    scopes: rotated.accessTokenScopes,
    delivery,
    deliveryStatus,
    deliveryMailboxId,
    oldTokenRemainsValid: true,
  }, { status: 201 });
});

router.on("GET", "/v2/meta/runtime", async (_request, env) => {
  return json(buildRuntimeMetadata(env));
});
router.on("HEAD", "/v2/meta/runtime", async (_request, env) => {
  return json(buildRuntimeMetadata(env));
});

router.on("GET", "/v2/meta/compatibility", async (_request, env) => {
  return json(buildCompatibilityContract(env));
});
router.on("HEAD", "/v2/meta/compatibility", async (_request, env) => {
  return json(buildCompatibilityContract(env));
});

router.on("GET", "/v2/meta/compatibility/schema", async (_request, _env) => {
  return json(COMPATIBILITY_CONTRACT_SCHEMA);
});
router.on("HEAD", "/v2/meta/compatibility/schema", async (_request, _env) => {
  return json(COMPATIBILITY_CONTRACT_SCHEMA);
});

router.on("GET", "/v1/debug/agents/:agentId", async (request, env, _ctx, route) => {
  const routeError = requireDebugRoutesEnabled(env);
  if (routeError) {
    return routeError;
  }
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }

  return json(agent);
});

router.on("GET", "/v1/debug/mailboxes/:mailboxId", async (request, env, _ctx, route) => {
  const routeError = requireDebugRoutesEnabled(env);
  if (routeError) {
    return routeError;
  }
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  const mailbox = await getMailboxById(env, route.params.mailboxId);
  if (!mailbox) {
    return json({ error: "Mailbox not found" }, { status: 404 });
  }

  return json(mailbox);
});

router.on("GET", "/v1/debug/messages/:messageId", async (request, env, _ctx, route) => {
  const routeError = requireDebugRoutesEnabled(env);
  if (routeError) {
    return routeError;
  }
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  const message = await getMessage(env, route.params.messageId);
  if (!message) {
    return json({ error: "Message not found" }, { status: 404 });
  }

  const deliveryEvents = await listDeliveryEventsByMessageId(env, route.params.messageId);
  return json({
    message,
    deliveryEvents,
  });
});

router.on("GET", "/v1/debug/drafts/:draftId", async (request, env, _ctx, route) => {
  const routeError = requireDebugRoutesEnabled(env);
  if (routeError) {
    return routeError;
  }
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  const draft = await getDraft(env, route.params.draftId);
  if (!draft) {
    return json({ error: "Draft not found" }, { status: 404 });
  }

  const draftObject = await env.R2_EMAIL.get(draft.draftR2Key);
  return json({
    draft,
    payload: draftObject ? await draftObject.json<unknown>() : null,
  });
});

router.on("GET", "/v1/debug/outbound-jobs/:outboundJobId", async (request, env, _ctx, route) => {
  const routeError = requireDebugRoutesEnabled(env);
  if (routeError) {
    return routeError;
  }
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  const outboundJob = await getOutboundJob(env, route.params.outboundJobId);
  if (!outboundJob) {
    return json({ error: "Outbound job not found" }, { status: 404 });
  }

  return json(outboundJob);
});

router.on("GET", "/v1/debug/suppressions/:email", async (request, env, _ctx, route) => {
  const routeError = requireDebugRoutesEnabled(env);
  if (routeError) {
    return routeError;
  }
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  const suppression = await getSuppression(env, decodeURIComponent(route.params.email));
  if (!suppression) {
    return json({ error: "Suppression not found" }, { status: 404 });
  }

  return json(suppression);
});

router.on("POST", "/v1/auth/tokens", async (request, env) => {
  const routeError = requireAdminRoutesEnabled(env);
  if (routeError) {
    return routeError;
  }
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  if (!env.API_SIGNING_SECRET) {
    return json({ error: "API_SIGNING_SECRET is not configured" }, { status: 500 });
  }

  const body = await readJson<{
    sub?: string;
    tenantId?: string;
    agentId?: string;
    scopes?: string[];
    mailboxIds?: string[];
    expiresInSeconds?: number;
  }>(request);

  if (!body.sub || !body.tenantId || !body.scopes?.length) {
    return badRequest("sub, tenantId, and scopes are required");
  }

  const exp = Math.floor(Date.now() / 1000) + (body.expiresInSeconds ?? 3600);
  const token = await mintAccessToken(env.API_SIGNING_SECRET, {
    sub: body.sub,
    tenantId: body.tenantId,
    agentId: body.agentId,
    scopes: body.scopes,
    mailboxIds: body.mailboxIds,
    exp,
  });

  return json({
    token,
    expiresAt: new Date(exp * 1000).toISOString(),
  }, { status: 201 });
});

router.on("POST", "/v1/agents", async (request, env) => {
  const auth = await requireAuth(request, env, ["agent:create"]);
  if (auth instanceof Response) {
    return auth;
  }

  const body = await readJson<{
    tenantId?: string;
    slug?: string;
    name?: string;
    description?: string;
    mode?: "assistant" | "autonomous" | "review_only";
    config?: unknown;
  }>(request);
  if (!body.tenantId || !body.name || !body.mode) {
    return badRequest("tenantId, name, and mode are required");
  }
  const tenantError = enforceTenantAccess(auth, body.tenantId);
  if (tenantError) {
    return tenantError;
  }

  const agent = await createAgent(env, {
    tenantId: body.tenantId,
    slug: body.slug,
    name: body.name,
    description: body.description,
    mode: body.mode,
    config: body.config ?? {},
  });

  return json(agent, { status: 201 });
});

router.on("GET", "/v1/agents", async (request, env) => {
  const auth = await requireAuth(request, env, ["agent:read"]);
  if (auth instanceof Response) {
    return auth;
  }

  const url = new URL(request.url);
  const tenantId = url.searchParams.get("tenantId") ?? undefined;
  if (tenantId) {
    const tenantError = enforceTenantAccess(auth, tenantId);
    if (tenantError) {
      return tenantError;
    }
  }

  return json({ items: await listAgents(env, tenantId) });
});

router.on("GET", "/v1/agents/:agentId", async (_request, env, _ctx, route) => {
  const auth = await requireAuth(_request, env, ["agent:read"]);
  if (auth instanceof Response) {
    return auth;
  }

  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }

  const tenantError = enforceTenantAccess(auth, agent.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceAgentAccess(auth, agent.id);
  if (agentError) {
    return agentError;
  }

  return json(agent);
});

router.on("PATCH", "/v1/agents/:agentId", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:update"]);
  if (auth instanceof Response) {
    return auth;
  }

  const existing = await getAgent(env, route.params.agentId);
  if (!existing) {
    return json({ error: "Agent not found" }, { status: 404 });
  }

  const tenantError = enforceTenantAccess(auth, existing.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceAgentAccess(auth, existing.id);
  if (agentError) {
    return agentError;
  }

  const body = await readJson<{
    slug?: string;
    name?: string;
    description?: string;
    status?: "draft" | "active" | "disabled" | "archived";
    mode?: "assistant" | "autonomous" | "review_only";
    config?: unknown;
    defaultVersionId?: string;
  }>(request);
  return json(await updateAgent(env, route.params.agentId, body));
});

router.on("POST", "/v1/agents/:agentId/versions", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:update"]);
  if (auth instanceof Response) {
    return auth;
  }

  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }

  const tenantError = enforceTenantAccess(auth, agent.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceAgentAccess(auth, agent.id);
  if (agentError) {
    return agentError;
  }

  const body = await readJson<{
    version?: string;
    model?: string;
    config?: unknown;
    manifest?: unknown;
    status?: "draft" | "published" | "deprecated";
    capabilities?: Array<{ capability?: string; config?: Record<string, unknown> }>;
    tools?: Array<{ toolName?: string; enabled?: boolean; config?: Record<string, unknown> }>;
  }>(request);

  if (!body.version) {
    return badRequest("version is required");
  }

  return json(await createAgentVersion(env, {
    agentId: route.params.agentId,
    version: body.version,
    model: body.model,
    config: body.config,
    manifest: body.manifest,
    status: body.status,
    capabilities: (body.capabilities ?? [])
      .filter((item): item is { capability: string; config?: Record<string, unknown> } => Boolean(item.capability))
      .map((item) => ({ capability: item.capability, config: item.config })),
    tools: (body.tools ?? [])
      .filter((item): item is { toolName: string; enabled?: boolean; config?: Record<string, unknown> } => Boolean(item.toolName))
      .map((item) => ({ toolName: item.toolName, enabled: item.enabled, config: item.config })),
  }), { status: 201 });
});

router.on("GET", "/v1/agents/:agentId/versions", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:read"]);
  if (auth instanceof Response) {
    return auth;
  }

  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }

  const tenantError = enforceTenantAccess(auth, agent.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceAgentAccess(auth, agent.id);
  if (agentError) {
    return agentError;
  }

  return json({ items: await listAgentVersions(env, route.params.agentId) });
});

router.on("GET", "/v1/agents/:agentId/versions/:versionId", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:read"]);
  if (auth instanceof Response) {
    return auth;
  }

  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }

  const tenantError = enforceTenantAccess(auth, agent.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceAgentAccess(auth, agent.id);
  if (agentError) {
    return agentError;
  }

  const version = await getAgentVersion(env, route.params.agentId, route.params.versionId);
  if (!version) {
    return json({ error: "Agent version not found" }, { status: 404 });
  }

  return json(version);
});

router.on("POST", "/v1/agents/:agentId/deployments", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:update"]);
  if (auth instanceof Response) {
    return auth;
  }

  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }

  const tenantError = enforceTenantAccess(auth, agent.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceAgentAccess(auth, agent.id);
  if (agentError) {
    return agentError;
  }

  const body = await readJson<{
    tenantId?: string;
    agentVersionId?: string;
    targetType?: "mailbox" | "workflow" | "tenant_default";
    targetId?: string;
    status?: "active" | "paused" | "rolled_back";
  }>(request);

  if (!body.tenantId || !body.agentVersionId || !body.targetType || !body.targetId) {
    return badRequest("tenantId, agentVersionId, targetType, and targetId are required");
  }

  const deploymentTenantError = enforceTenantAccess(auth, body.tenantId);
  if (deploymentTenantError) {
    return deploymentTenantError;
  }

  if (body.targetType === "mailbox") {
    const mailboxError = enforceMailboxAccess(auth, body.targetId);
    if (mailboxError) {
      return mailboxError;
    }
  }

  const version = await getAgentVersion(env, route.params.agentId, body.agentVersionId);
  if (!version) {
    return json({ error: "Agent version not found" }, { status: 404 });
  }

  return json(await createAgentDeployment(env, {
    tenantId: body.tenantId,
    agentId: route.params.agentId,
    agentVersionId: body.agentVersionId,
    targetType: body.targetType,
    targetId: body.targetId,
    status: body.status,
  }), { status: 201 });
});

router.on("GET", "/v1/agents/:agentId/deployments", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:read"]);
  if (auth instanceof Response) {
    return auth;
  }

  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }

  const tenantError = enforceTenantAccess(auth, agent.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceAgentAccess(auth, agent.id);
  if (agentError) {
    return agentError;
  }

  return json({ items: await listAgentDeployments(env, route.params.agentId) });
});

router.on("PATCH", "/v1/agents/:agentId/deployments/:deploymentId", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:update"]);
  if (auth instanceof Response) {
    return auth;
  }

  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }

  const tenantError = enforceTenantAccess(auth, agent.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceAgentAccess(auth, agent.id);
  if (agentError) {
    return agentError;
  }

  const deployment = await getAgentDeployment(env, route.params.agentId, route.params.deploymentId);
  if (!deployment) {
    return json({ error: "Agent deployment not found" }, { status: 404 });
  }

  if (deployment.targetType === "mailbox") {
    const mailboxError = enforceMailboxAccess(auth, deployment.targetId);
    if (mailboxError) {
      return mailboxError;
    }
  }

  const body = await readJson<{ status?: "active" | "paused" | "rolled_back" }>(request);
  if (!body.status) {
    return badRequest("status is required");
  }

  const updated = await updateAgentDeploymentStatus(env, {
    agentId: route.params.agentId,
    deploymentId: route.params.deploymentId,
    status: body.status,
  });

  if (!updated) {
    return json({ error: "Agent deployment not found" }, { status: 404 });
  }

  return json(updated);
});

router.on("POST", "/v1/agents/:agentId/deployments/rollout", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:update"]);
  if (auth instanceof Response) {
    return auth;
  }

  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }

  const tenantError = enforceTenantAccess(auth, agent.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceAgentAccess(auth, agent.id);
  if (agentError) {
    return agentError;
  }

  const body = await readJson<{
    tenantId?: string;
    agentVersionId?: string;
    targetType?: "mailbox" | "workflow" | "tenant_default";
    targetId?: string;
  }>(request);

  if (!body.tenantId || !body.agentVersionId || !body.targetType || !body.targetId) {
    return badRequest("tenantId, agentVersionId, targetType, and targetId are required");
  }

  const deploymentTenantError = enforceTenantAccess(auth, body.tenantId);
  if (deploymentTenantError) {
    return deploymentTenantError;
  }

  if (body.targetType === "mailbox") {
    const mailboxError = enforceMailboxAccess(auth, body.targetId);
    if (mailboxError) {
      return mailboxError;
    }
  }

  const version = await getAgentVersion(env, route.params.agentId, body.agentVersionId);
  if (!version) {
    return json({ error: "Agent version not found" }, { status: 404 });
  }

  return json(await rolloutAgentDeployment(env, {
    tenantId: body.tenantId,
    agentId: route.params.agentId,
    agentVersionId: body.agentVersionId,
    targetType: body.targetType,
    targetId: body.targetId,
  }), { status: 201 });
});

router.on("POST", "/v1/agents/:agentId/deployments/:deploymentId/rollback", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:update"]);
  if (auth instanceof Response) {
    return auth;
  }

  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }

  const tenantError = enforceTenantAccess(auth, agent.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceAgentAccess(auth, agent.id);
  if (agentError) {
    return agentError;
  }

  const deployment = await getAgentDeployment(env, route.params.agentId, route.params.deploymentId);
  if (!deployment) {
    return json({ error: "Agent deployment not found" }, { status: 404 });
  }

  if (deployment.targetType === "mailbox") {
    const mailboxError = enforceMailboxAccess(auth, deployment.targetId);
    if (mailboxError) {
      return mailboxError;
    }
  }

  const rolledBack = await rollbackAgentDeployment(env, {
    agentId: route.params.agentId,
    deploymentId: route.params.deploymentId,
  });

  if (!rolledBack) {
    return json({ error: "Agent deployment not found" }, { status: 404 });
  }

  return json(rolledBack);
});

router.on("POST", "/v1/agents/:agentId/mailboxes", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:bind"]);
  if (auth instanceof Response) {
    return auth;
  }

  const body = await readJson<{ tenantId?: string; mailboxId?: string; role?: "primary" | "shared" | "send_only" | "receive_only" }>(request);
  if (!body.tenantId || !body.mailboxId || !body.role) {
    return badRequest("tenantId, mailboxId, and role are required");
  }
  const tenantError = enforceTenantAccess(auth, body.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceAgentAccess(auth, route.params.agentId);
  if (agentError) {
    return agentError;
  }
  const mailboxError = enforceMailboxAccess(auth, body.mailboxId);
  if (mailboxError) {
    return mailboxError;
  }
  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }
  if (agent.tenantId !== body.tenantId) {
    return json({ error: "Agent does not belong to tenant" }, { status: 409 });
  }
  const mailbox = await getMailboxById(env, body.mailboxId);
  if (!mailbox) {
    return json({ error: "Mailbox not found" }, { status: 404 });
  }
  if (mailbox.tenant_id !== body.tenantId) {
    return json({ error: "Mailbox does not belong to tenant" }, { status: 409 });
  }

  return json(await bindMailbox(env, {
    tenantId: body.tenantId,
    agentId: route.params.agentId,
    mailboxId: body.mailboxId,
    role: body.role,
  }), { status: 201 });
});

router.on("GET", "/v1/agents/:agentId/mailboxes", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:read"]);
  if (auth instanceof Response) {
    return auth;
  }
  const agentError = enforceAgentAccess(auth, route.params.agentId);
  if (agentError) {
    return agentError;
  }

  return json({ items: await listAgentMailboxes(env, route.params.agentId) });
});

router.on("PUT", "/v1/agents/:agentId/policy", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:update"]);
  if (auth instanceof Response) {
    return auth;
  }
  const agentError = enforceAgentAccess(auth, route.params.agentId);
  if (agentError) {
    return agentError;
  }

  const body = await readJson<{
    autoReplyEnabled?: boolean;
    humanReviewRequired?: boolean;
    confidenceThreshold?: number;
    maxAutoRepliesPerThread?: number;
    allowedRecipientDomains?: string[];
    blockedSenderDomains?: string[];
    allowedTools?: string[];
  }>(request);

  if (
    body.autoReplyEnabled === undefined ||
    body.humanReviewRequired === undefined ||
    body.confidenceThreshold === undefined ||
    body.maxAutoRepliesPerThread === undefined
  ) {
    return badRequest("policy fields are required");
  }

  return json(await upsertAgentPolicy(env, {
    agentId: route.params.agentId,
    autoReplyEnabled: body.autoReplyEnabled,
    humanReviewRequired: body.humanReviewRequired,
    confidenceThreshold: body.confidenceThreshold,
    maxAutoRepliesPerThread: body.maxAutoRepliesPerThread,
    allowedRecipientDomains: body.allowedRecipientDomains ?? [],
    blockedSenderDomains: body.blockedSenderDomains ?? [],
    allowedTools: body.allowedTools ?? [],
  }));
});

router.on("GET", "/v1/agents/:agentId/tasks", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["task:read"]);
  if (auth instanceof Response) {
    return auth;
  }
  const agentError = enforceAgentAccess(auth, route.params.agentId);
  if (agentError) {
    return agentError;
  }

  const url = new URL(request.url);
  const status = url.searchParams.get("status") as "queued" | "running" | "done" | "needs_review" | "failed" | null;
  return json({ items: await listTasks(env, route.params.agentId, status ?? undefined) });
});

router.on("GET", "/v1/messages/:messageId", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["mail:read"]);
  if (auth instanceof Response) {
    return auth;
  }
  const message = await getMessage(env, route.params.messageId);
  if (!message) {
    return json({ error: "Message not found" }, { status: 404 });
  }
  const tenantError = enforceTenantAccess(auth, message.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const mailboxError = enforceMailboxAccess(auth, message.mailboxId);
  if (mailboxError) {
    return mailboxError;
  }

  return json(message);
});

router.on("GET", "/v1/messages/:messageId/content", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["mail:read"]);
  if (auth instanceof Response) {
    return auth;
  }
  const message = await getMessage(env, route.params.messageId);
  if (!message) {
    return json({ error: "Message not found" }, { status: 404 });
  }
  const tenantError = enforceTenantAccess(auth, message.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const mailboxError = enforceMailboxAccess(auth, message.mailboxId);
  if (mailboxError) {
    return mailboxError;
  }

  return json(await getMessageContent(env, route.params.messageId));
});

router.on("POST", "/v1/messages/:messageId/replay", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["mail:replay"]);
  if (auth instanceof Response) {
    return auth;
  }

  const body = await readJson<{ mode?: "normalize" | "rerun_agent"; agentId?: string; idempotencyKey?: string }>(request);
  if (!body.mode) {
    return badRequest("mode is required");
  }
  if (body.mode !== "normalize" && body.mode !== "rerun_agent") {
    return badRequest("mode must be normalize or rerun_agent");
  }
  const existingMessage = await getMessage(env, route.params.messageId);
  if (!existingMessage) {
    return json({ error: "Message not found" }, { status: 404 });
  }
  const tenantError = enforceTenantAccess(auth, existingMessage.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const mailboxError = enforceMailboxAccess(auth, existingMessage.mailboxId);
  if (mailboxError) {
    return mailboxError;
  }
  if (body.mode === "normalize" && !existingMessage.rawR2Key) {
    return badRequest("normalize replay requires the message to have raw email content");
  }
  const replayRawR2Key = body.mode === "normalize" ? existingMessage.rawR2Key : undefined;

  const idempotencyKey = body.idempotencyKey?.trim();
  if (body.idempotencyKey !== undefined && !idempotencyKey) {
    return badRequest("idempotencyKey must be a non-empty string");
  }

  const replayTarget = body.mode === "rerun_agent"
    ? await resolveReplayAgentTarget(env, auth, existingMessage.mailboxId, body.agentId)
    : null;
  if (replayTarget instanceof Response) {
    return replayTarget;
  }
  const replayAgentTarget = replayTarget ?? undefined;

  const replayResponse = {
    messageId: route.params.messageId,
    mode: body.mode,
    status: "accepted" as const,
  };

  if (idempotencyKey) {
    const reservation = await reserveIdempotencyKey(env, {
      operation: "message_replay",
      tenantId: existingMessage.tenantId,
      idempotencyKey,
      requestFingerprint: JSON.stringify({
        messageId: route.params.messageId,
        mode: body.mode,
        agentId: body.agentId ?? null,
      }),
      resourceId: route.params.messageId,
    });

    if (reservation.status === "conflict") {
      return json({ error: "Idempotency key is already used for a different replay request" }, { status: 409 });
    }
    if (reservation.status === "pending") {
      return json({ error: "A replay request with this idempotency key is already in progress" }, { status: 409 });
    }
    if (reservation.status === "completed") {
      return accepted(reservation.record.response ?? replayResponse);
    }

    try {
      if (body.mode === "normalize") {
        if (!replayRawR2Key) {
          return badRequest("normalize replay requires the message to have raw email content");
        }
        await env.EMAIL_INGEST_QUEUE.send({
          messageId: route.params.messageId,
          tenantId: existingMessage.tenantId,
          mailboxId: existingMessage.mailboxId,
          rawR2Key: replayRawR2Key,
        });
      } else {
        if (!replayAgentTarget) {
          return badRequest("agentId is required for rerun_agent replay");
        }
        await env.AGENT_EXECUTE_QUEUE.send({
          taskId: createId("tsk"),
          agentId: replayAgentTarget.agentId,
          agentVersionId: replayAgentTarget.agentVersionId,
          deploymentId: replayAgentTarget.deploymentId,
        });
      }

      await completeIdempotencyKey(env, {
        operation: "message_replay",
        tenantId: existingMessage.tenantId,
        idempotencyKey,
        resourceId: route.params.messageId,
        response: replayResponse,
      });
      return accepted(replayResponse);
    } catch (error) {
      await releaseIdempotencyKey(env, "message_replay", existingMessage.tenantId, idempotencyKey);
      throw error;
    }
  }

  if (body.mode === "normalize") {
    if (!replayRawR2Key) {
      return badRequest("normalize replay requires the message to have raw email content");
    }
    await env.EMAIL_INGEST_QUEUE.send({
      messageId: route.params.messageId,
      tenantId: existingMessage.tenantId,
      mailboxId: existingMessage.mailboxId,
      rawR2Key: replayRawR2Key,
    });
  } else {
    if (!replayAgentTarget) {
      return badRequest("agentId is required for rerun_agent replay");
    }
    await env.AGENT_EXECUTE_QUEUE.send({
      taskId: createId("tsk"),
      agentId: replayAgentTarget.agentId,
      agentVersionId: replayAgentTarget.agentVersionId,
      deploymentId: replayAgentTarget.deploymentId,
    });
  }

  return accepted({
    messageId: route.params.messageId,
    mode: body.mode,
    status: "accepted",
  });
});

router.on("GET", "/v1/threads/:threadId", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["mail:read"]);
  if (auth instanceof Response) {
    return auth;
  }
  const thread = await getThread(env, route.params.threadId);
  if (!thread) {
    return json({ error: "Thread not found" }, { status: 404 });
  }
  const mailboxError = enforceMailboxAccess(auth, thread.mailboxId);
  if (mailboxError) {
    return mailboxError;
  }

  return json(thread);
});

router.on("POST", "/v1/agents/:agentId/drafts", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["draft:create"]);
  if (auth instanceof Response) {
    return auth;
  }
  const agentError = enforceAgentAccess(auth, route.params.agentId);
  if (agentError) {
    return agentError;
  }

  const body = await readJson<{
    tenantId?: string;
    mailboxId?: string;
    threadId?: string;
    sourceMessageId?: string;
    from?: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    text?: string;
    html?: string;
    inReplyTo?: string;
    references?: string[];
    attachments?: Array<{ filename: string; contentType: string; r2Key: string }>;
  }>(request);
  if (!body.tenantId || !body.mailboxId || !body.from || !body.to?.length || !body.subject) {
    return badRequest("tenantId, mailboxId, from, to, and subject are required");
  }
  const tenantError = enforceTenantAccess(auth, body.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const mailboxError = enforceMailboxAccess(auth, body.mailboxId);
  if (mailboxError) {
    return mailboxError;
  }

  return json(await createDraft(env, {
    tenantId: body.tenantId,
    agentId: route.params.agentId,
    mailboxId: body.mailboxId,
    threadId: body.threadId,
    sourceMessageId: body.sourceMessageId,
    payload: {
      from: body.from,
      to: body.to,
      cc: body.cc ?? [],
      bcc: body.bcc ?? [],
      subject: body.subject,
      text: body.text ?? "",
      html: body.html ?? "",
      inReplyTo: body.inReplyTo,
      references: body.references ?? [],
      attachments: body.attachments ?? [],
    },
  }), { status: 201 });
});

router.on("GET", "/v1/drafts/:draftId", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["draft:read"]);
  if (auth instanceof Response) {
    return auth;
  }
  const draft = await getDraft(env, route.params.draftId);
  if (!draft) {
    return json({ error: "Draft not found" }, { status: 404 });
  }
  const tenantError = enforceTenantAccess(auth, draft.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceAgentAccess(auth, draft.agentId);
  if (agentError) {
    return agentError;
  }
  const mailboxError = enforceMailboxAccess(auth, draft.mailboxId);
  if (mailboxError) {
    return mailboxError;
  }

  return json(draft);
});

router.on("POST", "/v1/drafts/:draftId/send", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["draft:send"]);
  if (auth instanceof Response) {
    return auth;
  }
  const draft = await getDraft(env, route.params.draftId);
  if (!draft) {
    return json({ error: "Draft not found" }, { status: 404 });
  }
  const tenantError = enforceTenantAccess(auth, draft.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceAgentAccess(auth, draft.agentId);
  if (agentError) {
    return agentError;
  }
  const mailboxError = enforceMailboxAccess(auth, draft.mailboxId);
  if (mailboxError) {
    return mailboxError;
  }
  if (draft.status !== "draft" && draft.status !== "approved") {
    return json({ error: `Draft status ${draft.status} cannot be sent again` }, { status: 409 });
  }

  const body = await readOptionalJson<{ idempotencyKey?: string }>(request);
  const idempotencyKey = body?.idempotencyKey?.trim();
  if (body?.idempotencyKey !== undefined && !idempotencyKey) {
    return badRequest("idempotencyKey must be a non-empty string");
  }

  if (idempotencyKey) {
    const reservation = await reserveIdempotencyKey(env, {
      operation: "draft_send",
      tenantId: draft.tenantId,
      idempotencyKey,
      requestFingerprint: JSON.stringify({ draftId: route.params.draftId }),
      resourceId: route.params.draftId,
    });

    if (reservation.status === "conflict") {
      return json({ error: "Idempotency key is already used for a different draft send request" }, { status: 409 });
    }
    if (reservation.status === "pending") {
      return json({ error: "A draft send request with this idempotency key is already in progress" }, { status: 409 });
    }
    if (reservation.status === "completed") {
      return accepted(reservation.record.response ?? {
        draftId: route.params.draftId,
        outboundJobId: reservation.record.resourceId,
        status: "queued",
      });
    }

    try {
      const result = await enqueueDraftSend(env, route.params.draftId);
      const response = {
        draftId: route.params.draftId,
        outboundJobId: result.outboundJobId,
        status: result.status,
      };

      await completeIdempotencyKey(env, {
        operation: "draft_send",
        tenantId: draft.tenantId,
        idempotencyKey,
        resourceId: result.outboundJobId,
        response,
      });
      return accepted(response);
    } catch (error) {
      await releaseIdempotencyKey(env, "draft_send", draft.tenantId, idempotencyKey);
      throw error;
    }
  }

  const result = await enqueueDraftSend(env, route.params.draftId);
  return accepted({
    draftId: route.params.draftId,
    outboundJobId: result.outboundJobId,
    status: result.status,
  });
});

router.on("POST", "/v1/webhooks/ses", async (request, env) => {
  if (env.WEBHOOK_SHARED_SECRET) {
    const provided = request.headers.get("x-webhook-shared-secret");
    if (provided !== env.WEBHOOK_SHARED_SECRET) {
      return json({ error: "Unauthorized webhook" }, { status: 401 });
    }
  }

  const body = await request.json<unknown>();
  const normalized = normalizeSesEvent(body);
  const payloadR2Key = `events/ses/${createId("evt")}.json`;
  await env.R2_EMAIL.put(payloadR2Key, JSON.stringify(body, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });

  const message = normalized.providerMessageId
    ? await getMessageByProviderMessageId(env, normalized.providerMessageId)
    : null;
  const taggedMessageId = normalized.mailTags.message_id;
  const taggedTenantId = normalized.mailTags.tenant_id;
  if (message && taggedMessageId && message.id !== taggedMessageId) {
    return json({ error: "Webhook message tag mismatch" }, { status: 409 });
  }
  if (message && taggedTenantId && message.tenantId !== taggedTenantId) {
    return json({ error: "Webhook tenant tag mismatch" }, { status: 409 });
  }

  await insertDeliveryEvent(env, {
    messageId: message?.id,
    providerMessageId: normalized.providerMessageId,
    eventType: normalized.eventType,
    payloadR2Key,
  });

  if (normalized.providerMessageId) {
    const status =
      normalized.eventType === "delivery" ? "replied" :
      normalized.eventType === "bounce" ? "failed" :
      normalized.eventType === "complaint" ? "failed" :
      "failed";
    await updateMessageStatusByProviderMessageId(env, normalized.providerMessageId, status);
  }

  if (message) {
    const outboundJob = await getOutboundJobByMessageId(env, message.id);
    if (outboundJob) {
      const deliveryError = normalized.reason ?? normalized.eventType;
      if (normalized.eventType === "delivery") {
        await updateOutboundJobStatus(env, {
          outboundJobId: outboundJob.id,
          status: "sent",
          lastError: null,
          nextRetryAt: null,
        });
      } else {
        await updateOutboundJobStatus(env, {
          outboundJobId: outboundJob.id,
          status: "failed",
          lastError: deliveryError,
          nextRetryAt: null,
        });
      }
    }
  }

  if ((normalized.eventType === "bounce" || normalized.eventType === "complaint") && normalized.recipient) {
    await addSuppression(env, normalized.recipient, normalized.reason ?? normalized.eventType, "ses");
  }

  return accepted({
    provider: "ses",
    received: true,
    eventType: normalized.eventType,
    providerMessageId: normalized.providerMessageId,
  });
});

export async function handleApiRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  return await router.handle(request, env, ctx);
}

function wantsHtmlResponse(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  const contentType = request.headers.get("content-type") ?? "";
  return accept.includes("text/html") || contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data");
}

function normalizeMailboxLookup(env: Env, input: { mailboxAlias?: string; mailboxAddress?: string }): string | null {
  const address = input.mailboxAddress?.trim().toLowerCase();
  if (address) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : null;
  }

  const alias = input.mailboxAlias?.trim().toLowerCase();
  if (!alias) {
    return null;
  }

  const domain = env.CLOUDFLARE_EMAIL_DOMAIN ?? "mailagents.net";
  return /^[a-z0-9][a-z0-9._+-]{2,31}$/.test(alias) ? `${alias}@${domain}` : null;
}

function isoSecondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

async function hashRequesterIp(ip: string | null): Promise<string | null> {
  const normalizedIp = ip?.trim();
  if (!normalizedIp) {
    return null;
  }

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizedIp));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function reissueMailboxAccessToken(env: Env, mailboxAddress: string): Promise<void> {
  const mailbox = await getMailboxByAddress(env, mailboxAddress);
  if (!mailbox || mailbox.status !== "active") {
    return;
  }

  const executionTarget = await resolveAgentExecutionTarget(env, mailbox.id);
  if (!executionTarget?.agentId) {
    return;
  }

  const agent = await getAgent(env, executionTarget.agentId);
  if (!agent?.configR2Key) {
    return;
  }

  const config = await readAgentConfig(env, agent.configR2Key);
  const operatorEmail = typeof config?.operatorEmail === "string" ? config.operatorEmail.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(operatorEmail)) {
    return;
  }

  const productName = typeof config?.productName === "string" && config.productName.trim()
    ? config.productName.trim()
    : "Mailagents";
  const access = await issueSelfServeAccessToken({
    env,
    tenantId: mailbox.tenant_id,
    agentId: executionTarget.agentId,
    mailboxId: mailbox.id,
  });

  const draft = await createDraft(env, {
    tenantId: mailbox.tenant_id,
    agentId: executionTarget.agentId,
    mailboxId: mailbox.id,
    payload: {
      from: mailbox.address,
      to: [operatorEmail],
      subject: `Your refreshed Mailagents access token for ${mailbox.address}`,
      text: buildTokenReissueText({
        mailboxAddress: mailbox.address,
        productName,
        agentName: agent.name,
        accessToken: access.accessToken,
        accessTokenExpiresAt: access.accessTokenExpiresAt,
        accessTokenScopes: access.accessTokenScopes,
      }),
      html: buildTokenReissueHtml({
        mailboxAddress: mailbox.address,
        productName,
        agentName: agent.name,
        accessToken: access.accessToken,
        accessTokenExpiresAt: access.accessTokenExpiresAt,
        accessTokenScopes: access.accessTokenScopes,
      }),
      attachments: [],
    },
  });

  await enqueueDraftSend(env, draft.id);
}

function resolveRotateMailboxId(claims: AccessTokenClaims, requestedMailboxId: string | undefined): string | null {
  return requestedMailboxId?.trim()
    || (claims.mailboxIds?.length === 1 ? claims.mailboxIds[0] : null)
    || null;
}

async function rotateAccessToken(env: Env, claims: AccessTokenClaims): Promise<{
  accessToken?: string;
  accessTokenExpiresAt?: string;
  accessTokenScopes: string[];
}> {
  if (!env.API_SIGNING_SECRET) {
    return { accessTokenScopes: claims.scopes };
  }

  const ttlSeconds = parseRotateTtlSeconds(env);
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const accessToken = await mintAccessToken(env.API_SIGNING_SECRET, {
    sub: claims.sub,
    tenantId: claims.tenantId,
    agentId: claims.agentId,
    scopes: claims.scopes,
    mailboxIds: claims.mailboxIds,
    exp,
  });

  return {
    accessToken,
    accessTokenExpiresAt: new Date(exp * 1000).toISOString(),
    accessTokenScopes: claims.scopes,
  };
}

function parseRotateTtlSeconds(env: Env): number {
  const value = env.SELF_SERVE_ACCESS_TOKEN_TTL_SECONDS;
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60 * 60 * 24 * 30;
}

async function deliverRotatedTokenToSelfMailbox(
  env: Env,
  claims: AccessTokenClaims,
  mailboxId: string,
  accessToken: string,
  accessTokenExpiresAt: string | undefined,
  accessTokenScopes: string[],
): Promise<boolean> {
  const mailbox = await getMailboxById(env, mailboxId);
  if (!mailbox || mailbox.status !== "active") {
    return false;
  }

  const executionTarget = claims.agentId
    ? { agentId: claims.agentId }
    : await resolveAgentExecutionTarget(env, mailboxId);
  if (!executionTarget?.agentId) {
    return false;
  }

  const agent = await getAgent(env, executionTarget.agentId);
  const config = agent?.configR2Key ? await readAgentConfig(env, agent.configR2Key) : null;
  const productName = typeof config?.productName === "string" && config.productName.trim()
    ? config.productName.trim()
    : "Mailagents";
  const agentName = agent?.name ?? "Mailagents Agent";

  const draft = await createDraft(env, {
    tenantId: mailbox.tenant_id,
    agentId: executionTarget.agentId,
    mailboxId: mailbox.id,
    payload: {
      from: mailbox.address,
      to: [mailbox.address],
      subject: `Your rotated Mailagents access token for ${mailbox.address}`,
      text: buildTokenReissueText({
        mailboxAddress: mailbox.address,
        productName,
        agentName,
        accessToken,
        accessTokenExpiresAt,
        accessTokenScopes,
      }),
      html: buildTokenReissueHtml({
        mailboxAddress: mailbox.address,
        productName,
        agentName,
        accessToken,
        accessTokenExpiresAt,
        accessTokenScopes,
      }),
      attachments: [],
    },
  });

  await enqueueDraftSend(env, draft.id);
  return true;
}

async function resolveReplayAgentTarget(
  env: Env,
  claims: AccessTokenClaims,
  mailboxId: string,
  requestedAgentId: string | undefined,
): Promise<
  | { agentId: string; agentVersionId?: string; deploymentId?: string }
  | Response
> {
  const agentId = requestedAgentId?.trim();
  if (agentId) {
    const agentError = enforceAgentAccess(claims, agentId);
    if (agentError) {
      return agentError;
    }
    const agent = await getAgent(env, agentId);
    if (!agent) {
      return json({ error: "Agent not found" }, { status: 404 });
    }
    const tenantError = enforceTenantAccess(claims, agent.tenantId);
    if (tenantError) {
      return tenantError;
    }

    return { agentId };
  }

  const target = await resolveAgentExecutionTarget(env, mailboxId);
  if (!target?.agentId) {
    return badRequest("agentId is required when the mailbox has no active agent deployment");
  }

  const agentError = enforceAgentAccess(claims, target.agentId);
  if (agentError) {
    return agentError;
  }
  const agent = await getAgent(env, target.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }
  const tenantError = enforceTenantAccess(claims, agent.tenantId);
  if (tenantError) {
    return tenantError;
  }

  return target;
}

async function readAgentConfig(env: Env, configR2Key: string): Promise<Record<string, unknown> | null> {
  const object = await env.R2_EMAIL.get(configR2Key);
  if (!object) {
    return null;
  }

  const payload = await object.json<unknown>();
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
}


function html(markup: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(markup, {
    ...init,
    headers,
  });
}

function renderPublicSignupResult(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} | Mailagents</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif;
        background: linear-gradient(180deg, #fff9f0 0%, #fffef8 100%);
        color: #261c12;
      }
      main {
        max-width: 880px;
        margin: 0 auto;
        padding: 48px 20px 72px;
      }
      .card {
        background: rgba(255, 252, 246, 0.96);
        border: 1px solid rgba(68, 49, 28, 0.12);
        border-radius: 28px;
        box-shadow: 0 20px 60px rgba(68, 49, 28, 0.08);
        padding: 28px;
      }
      .eyebrow {
        font-size: 12px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: #9d5a1f;
        margin-bottom: 10px;
      }
      h1 { margin: 0 0 12px; font-size: 34px; line-height: 1.1; }
      p, li { line-height: 1.6; }
      .banner {
        border-radius: 18px;
        padding: 14px 16px;
        margin: 18px 0;
      }
      .banner.error { background: #fff1ef; color: #8c2a1a; }
      .banner.success { background: #eefaf1; color: #185c2b; }
      .mono {
        display: inline-block;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        background: #f6eee1;
        padding: 4px 8px;
        border-radius: 10px;
      }
      .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 24px; }
      .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 12px 18px;
        border-radius: 999px;
        text-decoration: none;
        font-weight: 600;
      }
      .button.primary { background: #261c12; color: #fffdf8; }
      .button.secondary { background: transparent; color: #261c12; border: 1px solid rgba(38, 28, 18, 0.18); }
    </style>
  </head>
  <body>
    <main>
      ${body}
    </main>
  </body>
</html>`;
}

function renderPublicSignupError(state: SignupPageState): string {
  const values = state.values ?? {};
  return `<section class="card">
    <div class="eyebrow">Public Signup</div>
    <h1>We could not finish provisioning yet.</h1>
    <div class="banner error">${escapeHtml(state.error ?? "Unknown error")}</div>
    <p>Review the mailbox details and try again from the public signup page.</p>
    <ul>
      <li>Requested mailbox: <span class="mono">${escapeHtml(values.mailboxAlias ?? "")}@mailagents.net</span></li>
      <li>Operator inbox: <span class="mono">${escapeHtml(values.operatorEmail ?? "")}</span></li>
    </ul>
    <div class="actions">
      <a class="button primary" href="https://mailagents.net/signup">Back to signup</a>
      <a class="button secondary" href="mailto:hello@mailagents.net">Contact support</a>
    </div>
  </section>`;
}

function renderPublicSignupSuccess(result: SignupSuccessResult): string {
  const bannerClass = result.welcomeStatus === "queued" ? "success" : "error";
  const bannerText = result.welcomeStatus === "queued"
    ? "Mailbox created and welcome email queued successfully."
    : `Mailbox created, but the welcome email could not be queued automatically: ${result.welcomeError ?? "unknown error"}`;
  return `<section class="card">
    <div class="eyebrow">Public Signup</div>
    <h1>${escapeHtml(result.mailboxAddress)} is ready.</h1>
    <div class="banner ${bannerClass}">${escapeHtml(bannerText)}</div>
    <p>Your first mailbox, default agent, published version, and active deployment have been created inside Mailagents.</p>
    <ul>
      <li>Tenant ID: <span class="mono">${escapeHtml(result.tenantId)}</span></li>
      <li>Mailbox: <span class="mono">${escapeHtml(result.mailboxAddress)}</span></li>
      <li>Agent ID: <span class="mono">${escapeHtml(result.agentId)}</span></li>
      <li>Version ID: <span class="mono">${escapeHtml(result.agentVersionId)}</span></li>
      <li>Deployment ID: <span class="mono">${escapeHtml(result.deploymentId)}</span></li>
      <li>Default scopes: <span class="mono">${escapeHtml(result.accessTokenScopes.join(", "))}</span></li>
      ${result.accessTokenExpiresAt ? `<li>Access token expires at: <span class="mono">${escapeHtml(result.accessTokenExpiresAt)}</span></li>` : ""}
      ${result.outboundJobId ? `<li>Welcome outbound job: <span class="mono">${escapeHtml(result.outboundJobId)}</span></li>` : ""}
    </ul>
    ${result.accessToken ? `<p>Use this mailbox-scoped bearer token for inbound reads, draft creation, and send:</p>
    <pre class="banner success"><code>${escapeHtml(result.accessToken)}</code></pre>` : "<p>Mailbox resources are ready, but no default bearer token could be issued in this environment.</p>"}
    <p>Check <strong>${escapeHtml(result.operatorEmail)}</strong> for the welcome email sent from the new mailbox.</p>
    <div class="actions">
      <a class="button primary" href="https://mailagents.net/">Back to homepage</a>
      <a class="button secondary" href="https://mailagents.net/signup">Create another mailbox</a>
    </div>
  </section>`;
}
