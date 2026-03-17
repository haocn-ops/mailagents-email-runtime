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
  bindMailbox,
  createAgent,
  getAgent,
  getMailboxById,
  listAgentMailboxes,
  updateAgent,
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
  getOutboundJob,
  getSuppression,
  insertDeliveryEvent,
  listTasks,
  listDeliveryEventsByMessageId,
  releaseIdempotencyKey,
  reserveIdempotencyKey,
  addSuppression,
  updateMessageStatusByProviderMessageId,
} from "../repositories/mail";
import type { Env } from "../types";

const router = new Router<Env>();

router.on("GET", "/v2/meta/runtime", async (_request, env) => {
  return json(buildRuntimeMetadata(env));
});

router.on("GET", "/v2/meta/compatibility", async (_request, env) => {
  return json(buildCompatibilityContract(env));
});

router.on("GET", "/v2/meta/compatibility/schema", async (_request, _env) => {
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

  const body = await readJson<{ tenantId?: string; name?: string; mode?: "assistant" | "autonomous" | "review_only"; config?: unknown }>(request);
  if (!body.tenantId || !body.name || !body.mode) {
    return badRequest("tenantId, name, and mode are required");
  }
  const tenantError = enforceTenantAccess(auth, body.tenantId);
  if (tenantError) {
    return tenantError;
  }

  const agent = await createAgent(env, {
    tenantId: body.tenantId,
    name: body.name,
    mode: body.mode,
    config: body.config ?? {},
  });

  return json(agent, { status: 201 });
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

  const body = await readJson<{ name?: string; status?: "active" | "disabled"; mode?: "assistant" | "autonomous" | "review_only"; config?: unknown }>(request);
  return json(await updateAgent(env, route.params.agentId, body));
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
        await env.EMAIL_INGEST_QUEUE.send({
          messageId: route.params.messageId,
          tenantId: existingMessage.tenantId,
          mailboxId: existingMessage.mailboxId,
          rawR2Key: existingMessage.rawR2Key ?? `raw/replay/${route.params.messageId}.eml`,
        });
      } else {
        await env.AGENT_EXECUTE_QUEUE.send({
          taskId: createId("tsk"),
          agentId: body.agentId ?? "agt_demo",
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
    await env.EMAIL_INGEST_QUEUE.send({
      messageId: route.params.messageId,
      tenantId: existingMessage.tenantId,
      mailboxId: existingMessage.mailboxId,
      rawR2Key: existingMessage.rawR2Key ?? `raw/replay/${route.params.messageId}.eml`,
    });
  } else {
    await env.AGENT_EXECUTE_QUEUE.send({
      taskId: createId("tsk"),
      agentId: body.agentId ?? "agt_demo",
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
