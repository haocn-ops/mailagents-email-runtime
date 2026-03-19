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
import { accepted, badRequest, InvalidJsonBodyError, json, readJson, readOptionalJson } from "../lib/http";
import { Router } from "../lib/router";
import { buildCompatibilityContract, buildRuntimeMetadata, COMPATIBILITY_CONTRACT_SCHEMA } from "../lib/runtime-metadata";
import { normalizeSesEvent } from "../lib/ses-events";
import {
  buildTokenReissueHtml,
  buildTokenReissueText,
  parseSelfServeSignup,
  performSelfServeSignup,
  SignupError,
} from "../lib/self-serve";
import { issueSelfServeAccessToken } from "../lib/provisioning/default-access";
import {
  bindMailbox,
  createAgent,
  createAgentDeployment,
  createAgentVersion,
  DeploymentConflictError,
  getAgent,
  getAgentDeployment,
  getAgentVersion,
  hasActiveMailboxBinding,
  hasActiveMailboxDeployment,
  MailboxConflictError,
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
  createTask,
  deleteTask,
  enqueueDraftSend,
  completeIdempotencyKey,
  getDraft,
  getAttachmentOwnerByR2Key,
  getMessage,
  getMessageByProviderMessageId,
  getMessageContent,
  listMessages,
  getThread,
  getOutboundJobByDraftR2Key,
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
  updateMessageStatus,
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
const RECEIVE_CAPABLE_MAILBOX_ROLES = ["primary", "shared", "receive_only"] as const;
const SEND_CAPABLE_MAILBOX_ROLES = ["primary", "shared", "send_only"] as const;

class RouteRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RouteRequestError";
    this.status = status;
  }
}

async function enqueueReplayTask(env: Env, input: {
  tenantId: string;
  mailboxId: string;
  sourceMessageId: string;
  agentId: string;
  agentVersionId?: string;
  deploymentId?: string;
}) {
  const replayTask = await createTask(env, {
    tenantId: input.tenantId,
    mailboxId: input.mailboxId,
    sourceMessageId: input.sourceMessageId,
    taskType: "replay",
    priority: 50,
    status: "queued",
    assignedAgent: input.agentId,
  });

  try {
    await env.AGENT_EXECUTE_QUEUE.send({
      taskId: replayTask.id,
      agentId: input.agentId,
      agentVersionId: input.agentVersionId,
      deploymentId: input.deploymentId,
    });
  } catch (error) {
    await deleteTask(env, replayTask.id).catch(() => undefined);
    throw error;
  }
}

async function restoreDraftSendReplay(env: Env, draftId: string | undefined) {
  if (!draftId) {
    throw new RouteRequestError("Stored idempotent draft send result is incomplete", 500);
  }

  const draft = await getDraft(env, draftId);
  if (!draft) {
    throw new RouteRequestError("Stored idempotent draft no longer exists", 409);
  }

  const outboundJob = await getOutboundJobByDraftR2Key(env, draft.draftR2Key);
  if (!outboundJob) {
    throw new RouteRequestError("Stored idempotent outbound job no longer exists", 409);
  }

  return {
    draft,
    outboundJobId: outboundJob.id,
    status: "queued" as const,
  };
}

async function restoreEnqueuedDraftSend(env: Env, input: {
  draftId: string;
  outboundJobId: string | undefined;
}) {
  if (!input.outboundJobId) {
    throw new RouteRequestError("Stored idempotent draft send result is incomplete", 500);
  }

  const draft = await getDraft(env, input.draftId);
  if (!draft) {
    throw new RouteRequestError("Stored idempotent draft no longer exists", 409);
  }

  const outboundJob = await getOutboundJob(env, input.outboundJobId);
  if (!outboundJob) {
    throw new RouteRequestError("Stored idempotent outbound job no longer exists", 409);
  }
  if (outboundJob.draftR2Key !== draft.draftR2Key) {
    throw new RouteRequestError("Stored idempotent outbound job does not belong to draft", 409);
  }

  return {
    draftId: input.draftId,
    outboundJobId: outboundJob.id,
    status: "queued" as const,
  };
}

async function validateDraftReferences(env: Env, input: {
  tenantId: string;
  mailboxId: string;
  threadId?: string;
  sourceMessageId?: string;
}) {
  if (input.threadId) {
    const thread = await getThread(env, input.threadId);
    if (!thread) {
      throw new RouteRequestError("Thread not found", 404);
    }
    if (thread.tenantId !== input.tenantId) {
      throw new RouteRequestError("Thread does not belong to tenant", 409);
    }
    if (thread.mailboxId !== input.mailboxId) {
      throw new RouteRequestError("Thread does not belong to mailbox", 409);
    }
  }

  if (input.sourceMessageId) {
    const sourceMessage = await getMessage(env, input.sourceMessageId);
    if (!sourceMessage) {
      throw new RouteRequestError("Source message not found", 404);
    }
    if (sourceMessage.tenantId !== input.tenantId) {
      throw new RouteRequestError("Source message does not belong to tenant", 409);
    }
    if (sourceMessage.mailboxId !== input.mailboxId) {
      throw new RouteRequestError("Source message does not belong to mailbox", 409);
    }
    if (input.threadId && sourceMessage.threadId !== input.threadId) {
      throw new RouteRequestError("Source message does not belong to thread", 409);
    }
  }
}

async function validateDraftAttachments(env: Env, input: {
  tenantId: string;
  mailboxId: string;
  attachments: Array<{ filename: string; contentType: string; r2Key: string }>;
}) {
  for (const attachment of input.attachments) {
    const r2Key = typeof attachment.r2Key === "string" ? attachment.r2Key.trim() : "";
    if (!r2Key) {
      throw new RouteRequestError("Attachment r2Key is required", 400);
    }

    const owner = await getAttachmentOwnerByR2Key(env, r2Key);
    if (!owner) {
      throw new RouteRequestError("Attachment not found", 404);
    }
    if (owner.tenantId !== input.tenantId) {
      throw new RouteRequestError("Attachment does not belong to tenant", 409);
    }
    if (owner.mailboxId !== input.mailboxId) {
      throw new RouteRequestError("Attachment does not belong to mailbox", 409);
    }
  }
}

async function validateActiveDraftMailbox(env: Env, input: {
  tenantId: string;
  mailboxId: string;
}) {
  const mailbox = await getMailboxById(env, input.mailboxId);
  if (!mailbox) {
    throw new RouteRequestError("Mailbox not found", 404);
  }
  if (mailbox.tenant_id !== input.tenantId) {
    throw new RouteRequestError("Mailbox does not belong to tenant", 409);
  }
  if (mailbox.status !== "active") {
    throw new RouteRequestError("Mailbox is not active", 409);
  }
}

async function validateSendAgentBinding(env: Env, input: {
  tenantId: string;
  agentId: string;
  mailboxId: string;
}) {
  const agent = await getAgent(env, input.agentId);
  if (!agent) {
    throw new RouteRequestError("Agent not found", 404);
  }
  if (agent.tenantId !== input.tenantId) {
    throw new RouteRequestError("Agent does not belong to tenant", 409);
  }

  const hasBinding = await hasActiveMailboxBinding(env, {
    agentId: input.agentId,
    mailboxId: input.mailboxId,
    roles: [...SEND_CAPABLE_MAILBOX_ROLES],
  });
  const hasAnyBinding = await hasActiveMailboxBinding(env, {
    agentId: input.agentId,
    mailboxId: input.mailboxId,
  });
  const hasDeployment = await hasActiveMailboxDeployment(env, {
    agentId: input.agentId,
    mailboxId: input.mailboxId,
  });
  if (!hasBinding && (!hasDeployment || hasAnyBinding)) {
    throw new RouteRequestError("Agent is not allowed to send for mailbox", 403);
  }
}

async function canAgentSendForMailbox(env: Env, input: {
  agentId: string;
  mailboxId: string;
}): Promise<boolean> {
  const hasBinding = await hasActiveMailboxBinding(env, {
    agentId: input.agentId,
    mailboxId: input.mailboxId,
    roles: [...SEND_CAPABLE_MAILBOX_ROLES],
  });
  if (hasBinding) {
    return true;
  }

  const hasAnyBinding = await hasActiveMailboxBinding(env, {
    agentId: input.agentId,
    mailboxId: input.mailboxId,
  });
  if (hasAnyBinding) {
    return false;
  }

  return await hasActiveMailboxDeployment(env, {
    agentId: input.agentId,
    mailboxId: input.mailboxId,
  });
}

router.on("GET", "/public/signup", async () => {
  return methodNotAllowed(["POST"]);
});

router.on("HEAD", "/public/signup", async () => {
  return methodNotAllowed(["POST"]);
});

router.on("POST", "/public/signup", async (request, env) => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return json({ error: "content-type must be application/json" }, { status: 415 });
  }

  let parsed: Awaited<ReturnType<typeof parseSelfServeSignup>>;

  try {
    parsed = await parseSelfServeSignup(request);
  } catch (error) {
    if (error instanceof InvalidJsonBodyError) {
      return json({ error: error.message, values: {} }, { status: 400 });
    }
    throw error;
  }

  if (!parsed.ok) {
    return json({ error: parsed.error, values: parsed.values }, { status: 400 });
  }

  try {
    const result = await performSelfServeSignup(env, parsed.values);
    return json(result, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to complete self-serve signup";
    const status = error instanceof SignupError ? error.status : 502;
    return json({ error: message, values: parsed.values }, { status });
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
    } catch {
      // Intentionally swallow errors so the endpoint does not disclose mailbox existence or operator metadata.
    } finally {
      await logTokenReissueRequest(env, {
        mailboxAddress,
        requesterIpHash: requesterIpHash ?? undefined,
      }).catch(() => undefined);
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
    token: delivery === "self_mailbox" && deliveryStatus === "queued" ? undefined : rotated.accessToken,
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

router.on("GET", "/v1/mailboxes/self", async (request, env) => {
  const auth = await requireAuth(request, env, ["mail:read"]);
  if (auth instanceof Response) {
    return auth;
  }

  const mailbox = await resolveSelfMailbox(env, auth);
  if (mailbox instanceof Response) {
    return mailbox;
  }

  return json({
    id: mailbox.id,
    tenantId: mailbox.tenant_id,
    address: mailbox.address,
    status: mailbox.status,
    createdAt: mailbox.created_at,
    agentId: auth.agentId,
  });
});

router.on("GET", "/v1/mailboxes/self/tasks", async (request, env) => {
  const auth = await requireAuth(request, env, ["task:read"]);
  if (auth instanceof Response) {
    return auth;
  }

  const mailbox = await resolveSelfMailbox(env, auth);
  if (mailbox instanceof Response) {
    return mailbox;
  }

  const agentId = requireSelfAgent(auth);
  if (agentId instanceof Response) {
    return agentId;
  }

  const url = new URL(request.url);
  const status = url.searchParams.get("status") as "queued" | "running" | "done" | "needs_review" | "failed" | null;
  const items = await listTasks(env, agentId, status ?? undefined);
  return json({ items: items.filter((item) => item.mailboxId === mailbox.id) });
});

router.on("GET", "/v1/mailboxes/self/messages", async (request, env) => {
  const auth = await requireAuth(request, env, ["mail:read"]);
  if (auth instanceof Response) {
    return auth;
  }

  const mailbox = await resolveSelfMailbox(env, auth);
  if (mailbox instanceof Response) {
    return mailbox;
  }

  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? "50");
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

  return json({
    items: await listMessages(env, {
      mailboxId: mailbox.id,
      limit,
      search,
      direction,
      status,
    }),
  });
});

router.on("GET", "/v1/mailboxes/self/messages/:messageId", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["mail:read"]);
  if (auth instanceof Response) {
    return auth;
  }

  const mailbox = await resolveSelfMailbox(env, auth);
  if (mailbox instanceof Response) {
    return mailbox;
  }

  const message = await getMessage(env, route.params.messageId);
  if (!message) {
    return json({ error: "Message not found" }, { status: 404 });
  }
  if (message.mailboxId !== mailbox.id || message.tenantId !== mailbox.tenant_id) {
    return json({ error: "Mailbox access denied" }, { status: 403 });
  }

  return json(message);
});

router.on("GET", "/v1/mailboxes/self/messages/:messageId/content", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["mail:read"]);
  if (auth instanceof Response) {
    return auth;
  }

  const mailbox = await resolveSelfMailbox(env, auth);
  if (mailbox instanceof Response) {
    return mailbox;
  }

  const message = await getMessage(env, route.params.messageId);
  if (!message) {
    return json({ error: "Message not found" }, { status: 404 });
  }
  if (message.mailboxId !== mailbox.id || message.tenantId !== mailbox.tenant_id) {
    return json({ error: "Mailbox access denied" }, { status: 403 });
  }

  return json(await getMessageContent(env, route.params.messageId));
});

router.on("POST", "/v1/mailboxes/self/send", async (request, env) => {
  const auth = await requireAuth(request, env, ["draft:create", "draft:send"]);
  if (auth instanceof Response) {
    return auth;
  }

  const mailbox = await resolveSelfMailbox(env, auth);
  if (mailbox instanceof Response) {
    return mailbox;
  }

  const agentId = requireSelfAgent(auth);
  if (agentId instanceof Response) {
    return agentId;
  }

  const body = await readJson<{
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    text?: string;
    html?: string;
    inReplyTo?: string;
    references?: string[];
    attachments?: Array<{ filename: string; contentType: string; r2Key: string }>;
    idempotencyKey?: string;
  }>(request);

  if (!body.to?.length || !body.subject) {
    return badRequest("to and subject are required");
  }

  const result = await createAndSendDraft(env, {
    tenantId: mailbox.tenant_id,
    agentId,
    mailboxId: mailbox.id,
    payload: {
      from: mailbox.address,
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
    createdVia: "api:v1/mailboxes/self/send",
    idempotencyKey: body.idempotencyKey?.trim(),
    requestFingerprint: JSON.stringify({
      route: "v1/mailboxes/self/send",
      mailboxId: mailbox.id,
      to: body.to,
      cc: body.cc ?? [],
      bcc: body.bcc ?? [],
      subject: body.subject,
      text: body.text ?? "",
      html: body.html ?? "",
      inReplyTo: body.inReplyTo ?? null,
      references: body.references ?? [],
      attachments: body.attachments ?? [],
    }),
  });

  return accepted(result);
});

router.on("POST", "/v1/messages/send", async (request, env) => {
  const auth = await requireAuth(request, env, ["draft:create", "draft:send"]);
  if (auth instanceof Response) {
    return auth;
  }

  const mailbox = await resolveSelfMailbox(env, auth);
  if (mailbox instanceof Response) {
    return mailbox;
  }

  const agentId = requireSelfAgent(auth);
  if (agentId instanceof Response) {
    return agentId;
  }

  const body = await readJson<{
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    text?: string;
    html?: string;
    inReplyTo?: string;
    references?: string[];
    attachments?: Array<{ filename: string; contentType: string; r2Key: string }>;
    idempotencyKey?: string;
  }>(request);

  if (!body.to?.length || !body.subject) {
    return badRequest("to and subject are required");
  }

  const result = await createAndSendDraft(env, {
    tenantId: mailbox.tenant_id,
    agentId,
    mailboxId: mailbox.id,
    payload: {
      from: mailbox.address,
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
    createdVia: "api:v1/messages/send",
    idempotencyKey: body.idempotencyKey?.trim(),
    requestFingerprint: JSON.stringify({
      route: "v1/messages/send",
      mailboxId: mailbox.id,
      to: body.to,
      cc: body.cc ?? [],
      bcc: body.bcc ?? [],
      subject: body.subject,
      text: body.text ?? "",
      html: body.html ?? "",
      inReplyTo: body.inReplyTo ?? null,
      references: body.references ?? [],
      attachments: body.attachments ?? [],
    }),
  });

  return accepted(result);
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

  try {
    return json(await createAgentDeployment(env, {
      tenantId: body.tenantId,
      agentId: route.params.agentId,
      agentVersionId: body.agentVersionId,
      targetType: body.targetType,
      targetId: body.targetId,
      status: body.status,
    }), { status: 201 });
  } catch (error) {
    if (error instanceof DeploymentConflictError) {
      return json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
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

  try {
    return json(await rolloutAgentDeployment(env, {
      tenantId: body.tenantId,
      agentId: route.params.agentId,
      agentVersionId: body.agentVersionId,
      targetType: body.targetType,
      targetId: body.targetId,
    }), { status: 201 });
  } catch (error) {
    if (error instanceof DeploymentConflictError) {
      return json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
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

  try {
    return json(await bindMailbox(env, {
      tenantId: body.tenantId,
      agentId: route.params.agentId,
      mailboxId: body.mailboxId,
      role: body.role,
    }), { status: 201 });
  } catch (error) {
    if (error instanceof MailboxConflictError) {
      return json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
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

router.on("POST", "/v1/messages/:messageId/reply", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["mail:read", "draft:create", "draft:send"]);
  if (auth instanceof Response) {
    return auth;
  }

  const message = await getMessage(env, route.params.messageId);
  if (!message) {
    return json({ error: "Message not found" }, { status: 404 });
  }
  if (message.direction !== "inbound") {
    return badRequest("Only inbound messages can be replied to");
  }

  const tenantError = enforceTenantAccess(auth, message.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const mailboxError = enforceMailboxAccess(auth, message.mailboxId);
  if (mailboxError) {
    return mailboxError;
  }

  const agentId = requireSelfAgent(auth);
  if (agentId instanceof Response) {
    return agentId;
  }

  const body = await readJson<{
    text?: string;
    html?: string;
    idempotencyKey?: string;
  }>(request);

  if (!body.text && !body.html) {
    return badRequest("text or html is required");
  }

  const thread = message.threadId ? await getThread(env, message.threadId) : null;
  const references = Array.from(new Set(
    (thread?.messages ?? [])
      .map((item) => item.internetMessageId)
      .filter((item): item is string => Boolean(item))
  ));
  if (message.internetMessageId && !references.includes(message.internetMessageId)) {
    references.push(message.internetMessageId);
  }
  const replyMailbox = await getMailboxById(env, message.mailboxId);
  if (!replyMailbox) {
    return json({ error: "Mailbox not found" }, { status: 404 });
  }

  const replySubject = message.subject && message.subject.toLowerCase().startsWith("re:")
    ? message.subject
    : `Re: ${message.subject ?? ""}`.trim();
  const replyFrom = replyMailbox.address;

  const result = await createAndSendDraft(env, {
    tenantId: message.tenantId,
    agentId,
    mailboxId: message.mailboxId,
    threadId: message.threadId,
    sourceMessageId: message.id,
    payload: {
      from: replyFrom,
      to: [message.fromAddr],
      cc: [],
      bcc: [],
      subject: replySubject || "Re:",
      text: body.text ?? "",
      html: body.html ?? "",
      inReplyTo: message.internetMessageId,
      references,
      attachments: [],
    },
    createdVia: "api:v1/messages/:messageId/reply",
    idempotencyKey: body.idempotencyKey?.trim(),
    requestFingerprint: JSON.stringify({
      route: "v1/messages/:messageId/reply",
      messageId: route.params.messageId,
      text: body.text ?? "",
      html: body.html ?? "",
    }),
  });

  return accepted({
    ...result,
    sourceMessageId: message.id,
    threadId: message.threadId,
  });
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

  const idempotencyKey = body.idempotencyKey?.trim();
  if (body.idempotencyKey !== undefined && !idempotencyKey) {
    return badRequest("idempotencyKey must be a non-empty string");
  }

  const resolveReplayExecution = async () => {
    if (body.mode === "normalize") {
      if (!existingMessage.rawR2Key) {
        return badRequest("normalize replay requires the message to have raw email content");
      }

      return {
        replayRawR2Key: existingMessage.rawR2Key,
        replayAgentTarget: undefined,
      };
    }

    const replayTarget = await resolveReplayAgentTarget(env, auth, existingMessage.mailboxId, body.agentId);
    if (replayTarget instanceof Response) {
      return replayTarget;
    }

    return {
      replayRawR2Key: undefined,
      replayAgentTarget: replayTarget,
    };
  };

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
      const replayExecution = await resolveReplayExecution();
      if (replayExecution instanceof Response) {
        return replayExecution;
      }

      if (body.mode === "normalize") {
        if (!replayExecution.replayRawR2Key) {
          return badRequest("normalize replay requires the message to have raw email content");
        }
        await env.EMAIL_INGEST_QUEUE.send({
          messageId: route.params.messageId,
          tenantId: existingMessage.tenantId,
          mailboxId: existingMessage.mailboxId,
          rawR2Key: replayExecution.replayRawR2Key,
        });
      } else {
        await enqueueReplayTask(env, {
          tenantId: existingMessage.tenantId,
          mailboxId: existingMessage.mailboxId,
          sourceMessageId: route.params.messageId,
          agentId: replayExecution.replayAgentTarget!.agentId,
          agentVersionId: replayExecution.replayAgentTarget!.agentVersionId,
          deploymentId: replayExecution.replayAgentTarget!.deploymentId,
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

  const replayExecution = await resolveReplayExecution();
  if (replayExecution instanceof Response) {
    return replayExecution;
  }

  if (body.mode === "normalize") {
    if (!replayExecution.replayRawR2Key) {
      return badRequest("normalize replay requires the message to have raw email content");
    }
    await env.EMAIL_INGEST_QUEUE.send({
      messageId: route.params.messageId,
      tenantId: existingMessage.tenantId,
      mailboxId: existingMessage.mailboxId,
      rawR2Key: replayExecution.replayRawR2Key,
    });
  } else {
    await enqueueReplayTask(env, {
      tenantId: existingMessage.tenantId,
      mailboxId: existingMessage.mailboxId,
      sourceMessageId: route.params.messageId,
      agentId: replayExecution.replayAgentTarget!.agentId,
      agentVersionId: replayExecution.replayAgentTarget!.agentVersionId,
      deploymentId: replayExecution.replayAgentTarget!.deploymentId,
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
  const tenantError = enforceTenantAccess(auth, thread.tenantId);
  if (tenantError) {
    return tenantError;
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
  await validateDraftReferences(env, {
    tenantId: body.tenantId,
    mailboxId: body.mailboxId,
    threadId: body.threadId,
    sourceMessageId: body.sourceMessageId,
  });
  await validateDraftAttachments(env, {
    tenantId: body.tenantId,
    mailboxId: body.mailboxId,
    attachments: body.attachments ?? [],
  });

  return json(await createDraft(env, {
    tenantId: body.tenantId,
    agentId: route.params.agentId,
    mailboxId: body.mailboxId,
    threadId: body.threadId,
    sourceMessageId: body.sourceMessageId,
    createdVia: "api:v1/agents/:agentId/drafts",
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
      return accepted(reservation.record.response ?? await restoreEnqueuedDraftSend(env, {
        draftId: route.params.draftId,
        outboundJobId: reservation.record.resourceId,
      }));
    }

    if (draft.status !== "draft" && draft.status !== "approved") {
      await releaseIdempotencyKey(env, "draft_send", draft.tenantId, idempotencyKey);
      return json({ error: `Draft status ${draft.status} cannot be sent again` }, { status: 409 });
    }
    await validateActiveDraftMailbox(env, {
      tenantId: draft.tenantId,
      mailboxId: draft.mailboxId,
    });
    await validateSendAgentBinding(env, {
      tenantId: draft.tenantId,
      agentId: draft.agentId,
      mailboxId: draft.mailboxId,
    });

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

  if (draft.status !== "draft" && draft.status !== "approved") {
    return json({ error: `Draft status ${draft.status} cannot be sent again` }, { status: 409 });
  }
  await validateActiveDraftMailbox(env, {
    tenantId: draft.tenantId,
    mailboxId: draft.mailboxId,
  });
  await validateSendAgentBinding(env, {
    tenantId: draft.tenantId,
    agentId: draft.agentId,
    mailboxId: draft.mailboxId,
  });

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

  const body = await readJson<unknown>(request);
  const normalized = normalizeSesEvent(body);
  const payloadR2Key = `events/ses/${createId("evt")}.json`;
  await env.R2_EMAIL.put(payloadR2Key, JSON.stringify(body, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });

  const providerMessage = normalized.providerMessageId
    ? await getMessageByProviderMessageId(env, normalized.providerMessageId)
    : null;
  const taggedMessageId = normalized.mailTags.message_id;
  const taggedTenantId = normalized.mailTags.tenant_id;
  const taggedMessage = !providerMessage && taggedMessageId
    ? await getMessage(env, taggedMessageId)
    : null;
  const message = providerMessage ?? taggedMessage;

  if (providerMessage && taggedMessageId && providerMessage.id !== taggedMessageId) {
    return json({ error: "Webhook message tag mismatch" }, { status: 409 });
  }
  if (message && taggedTenantId && message.tenantId !== taggedTenantId) {
    return json({ error: "Webhook tenant tag mismatch" }, { status: 409 });
  }
  if (taggedMessage && normalized.providerMessageId && taggedMessage.providerMessageId && taggedMessage.providerMessageId !== normalized.providerMessageId) {
    return json({ error: "Webhook provider message mismatch" }, { status: 409 });
  }

  await insertDeliveryEvent(env, {
    messageId: message?.id,
    providerMessageId: normalized.providerMessageId,
    eventType: normalized.eventType,
    payloadR2Key,
  });

  const isTerminalSesEvent =
    normalized.eventType === "delivery"
    || normalized.eventType === "bounce"
    || normalized.eventType === "complaint"
    || normalized.eventType === "reject";

  if (isTerminalSesEvent && message) {
    const status =
      normalized.eventType === "delivery" ? "replied" :
      normalized.eventType === "bounce" ? "failed" :
      normalized.eventType === "complaint" ? "failed" :
      "failed";
    await updateMessageStatus(env, message.id, status);
  } else if (isTerminalSesEvent && normalized.providerMessageId) {
    const status =
      normalized.eventType === "delivery" ? "replied" :
      normalized.eventType === "bounce" ? "failed" :
      normalized.eventType === "complaint" ? "failed" :
      "failed";
    await updateMessageStatusByProviderMessageId(env, normalized.providerMessageId, status);
  }

  if (isTerminalSesEvent && message) {
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
  try {
    return await router.handle(request, env, ctx);
  } catch (error) {
    if (error instanceof InvalidJsonBodyError) {
      return badRequest(error.message);
    }
    if (error instanceof RouteRequestError) {
      return json({ error: error.message }, { status: error.status });
    }

    throw error;
  }
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

  const executionTarget = await resolveAgentExecutionTarget(env, mailbox.id, undefined, [...SEND_CAPABLE_MAILBOX_ROLES]);
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
    createdVia: "system:token_reissue_operator_email",
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

function requireSelfAgent(claims: AccessTokenClaims): string | Response {
  if (!claims.agentId) {
    return badRequest("This token is not bound to a single agent");
  }

  return claims.agentId;
}

async function resolveSelfMailbox(env: Env, claims: AccessTokenClaims) {
  const mailboxId = claims.mailboxIds?.length === 1 ? claims.mailboxIds[0] : null;
  if (!mailboxId) {
    return badRequest("This token is not bound to a single mailbox");
  }

  const mailbox = await getMailboxById(env, mailboxId);
  if (!mailbox) {
    return json({ error: "Mailbox not found" }, { status: 404 });
  }
  if (mailbox.tenant_id !== claims.tenantId) {
    return json({ error: "Tenant access denied" }, { status: 403 });
  }

  return mailbox;
}

async function createAndSendDraft(env: Env, input: {
  tenantId: string;
  agentId: string;
  mailboxId: string;
  threadId?: string;
  sourceMessageId?: string;
  payload: {
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    text: string;
    html: string;
    inReplyTo?: string;
    references: string[];
    attachments: Array<{ filename: string; contentType: string; r2Key: string }>;
  };
  createdVia: string;
  idempotencyKey?: string;
  requestFingerprint: string;
}) {
  const idempotencyKey = input.idempotencyKey?.trim();
  if (input.idempotencyKey !== undefined && !idempotencyKey) {
    throw new RouteRequestError("idempotencyKey must be a non-empty string", 400);
  }
  const validateCreateAndSendInput = async () => {
    await validateActiveDraftMailbox(env, {
      tenantId: input.tenantId,
      mailboxId: input.mailboxId,
    });
    await validateSendAgentBinding(env, {
      tenantId: input.tenantId,
      agentId: input.agentId,
      mailboxId: input.mailboxId,
    });
    await validateDraftReferences(env, {
      tenantId: input.tenantId,
      mailboxId: input.mailboxId,
      threadId: input.threadId,
      sourceMessageId: input.sourceMessageId,
    });
    await validateDraftAttachments(env, {
      tenantId: input.tenantId,
      mailboxId: input.mailboxId,
      attachments: input.payload.attachments,
    });
  };

  if (!idempotencyKey) {
    await validateCreateAndSendInput();
    const draft = await createDraft(env, {
      tenantId: input.tenantId,
      agentId: input.agentId,
      mailboxId: input.mailboxId,
      threadId: input.threadId,
      sourceMessageId: input.sourceMessageId,
      createdVia: input.createdVia,
      payload: input.payload,
    });
    const sendResult = await enqueueDraftSend(env, draft.id);
    return {
      draft,
      outboundJobId: sendResult.outboundJobId,
      status: sendResult.status,
    };
  }

  const reservation = await reserveIdempotencyKey(env, {
    operation: "draft_send",
    tenantId: input.tenantId,
    idempotencyKey,
    requestFingerprint: input.requestFingerprint,
    resourceId: input.mailboxId,
  });

  if (reservation.status === "conflict") {
    throw new RouteRequestError("Idempotency key is already used for a different send request", 409);
  }
  if (reservation.status === "pending") {
    throw new RouteRequestError("A send request with this idempotency key is already in progress", 409);
  }
  if (reservation.status === "completed") {
    if (reservation.record.response) {
      return reservation.record.response;
    }

    return await restoreDraftSendReplay(env, reservation.record.resourceId);
  }

  try {
    await validateCreateAndSendInput();
    const draft = await createDraft(env, {
      tenantId: input.tenantId,
      agentId: input.agentId,
      mailboxId: input.mailboxId,
      threadId: input.threadId,
      sourceMessageId: input.sourceMessageId,
      createdVia: input.createdVia,
      payload: input.payload,
    });
    const sendResult = await enqueueDraftSend(env, draft.id);
    const response = {
      draft,
      outboundJobId: sendResult.outboundJobId,
      status: sendResult.status,
    };
    await completeIdempotencyKey(env, {
      operation: "draft_send",
      tenantId: input.tenantId,
      idempotencyKey,
      resourceId: draft.id,
      response,
    });
    return response;
  } catch (error) {
    await releaseIdempotencyKey(env, "draft_send", input.tenantId, idempotencyKey);
    throw error;
  }
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

  const executionTarget = claims.agentId && await canAgentSendForMailbox(env, {
    agentId: claims.agentId,
    mailboxId,
  })
    ? { agentId: claims.agentId }
    : await resolveAgentExecutionTarget(env, mailboxId, undefined, [...SEND_CAPABLE_MAILBOX_ROLES]);
  if (!executionTarget?.agentId) {
    return false;
  }

  const agent = await getAgent(env, executionTarget.agentId);
  const config = agent?.configR2Key ? await readAgentConfig(env, agent.configR2Key) : null;
  const productName = typeof config?.productName === "string" && config.productName.trim()
    ? config.productName.trim()
    : "Mailagents";
  const agentName = agent?.name ?? "Mailagents Agent";

  try {
    const draft = await createDraft(env, {
      tenantId: mailbox.tenant_id,
      agentId: executionTarget.agentId,
      mailboxId: mailbox.id,
      createdVia: "system:token_reissue_self_mailbox",
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
  } catch {
    return false;
  }
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

    const target = await resolveAgentExecutionTarget(env, mailboxId, agentId, [...RECEIVE_CAPABLE_MAILBOX_ROLES]);
    if (!target?.agentId) {
      return badRequest("agentId must be active for the mailbox");
    }

    return target;
  }

  const target = await resolveAgentExecutionTarget(env, mailboxId, undefined, [...RECEIVE_CAPABLE_MAILBOX_ROLES]);
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


function methodNotAllowed(allowed: string[]): Response {
  return json(
    { error: `method not allowed; use ${allowed.join(", ")}` },
    { status: 405, headers: { allow: allowed.join(", ") } }
  );
}
