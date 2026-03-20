import { requireAdminRoutesEnabled, requireAdminSecret } from "../lib/auth";
import {
  CONTACT_ALIAS_LOCALPARTS,
  CONTACT_ALIAS_TENANT_ID,
  getContactAliasAddress,
} from "../lib/contact-aliases";
import {
  deleteEmailRoutingRule,
  listEmailRoutingRules,
  requireCloudflareEmailConfig,
  upsertWorkerRule,
} from "../lib/cloudflare-email";
import { badRequest, InvalidJsonBodyError, json, readJson } from "../lib/http";
import { Router } from "../lib/router";
import { buildRuntimeMetadata } from "../lib/runtime-metadata";
import { escapeHtml } from "../lib/self-serve";
import { runIdempotencyCleanupNow } from "../handlers/scheduled";
import {
  ensureMailbox,
  getMailboxById,
  MailboxConflictError,
  listMailboxes,
} from "../repositories/agents";
import {
  completeIdempotencyKey,
  createDraft,
  enqueueDraftSend,
  getDraft,
  getDraftByR2Key,
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
  updateMessageStatus,
  updateOutboundJobStatus,
} from "../repositories/mail";
import type { Env } from "../types";

const site = new Router<Env>();

class SiteRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SiteRequestError";
    this.status = status;
  }
}

async function restoreAdminSendReplay(env: Env, outboundJobId: string | undefined) {
  if (!outboundJobId) {
    throw new SiteRequestError("Stored idempotent admin send result is incomplete", 500);
  }

  const outboundJob = await getOutboundJob(env, outboundJobId);
  if (!outboundJob) {
    throw new SiteRequestError("Stored idempotent outbound job no longer exists", 409);
  }

  const draft = await getDraftByR2Key(env, outboundJob.draftR2Key);
  if (!draft) {
    throw new SiteRequestError("Stored idempotent draft no longer exists", 409);
  }

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

site.on("GET", "/", (_request, _env, _ctx, route) => html(layout("overview", "Mailagents", renderHome(route.url))));
site.on("HEAD", "/", (_request, _env, _ctx, route) => html(layout("overview", "Mailagents", renderHome(route.url))));
site.on("GET", "/privacy", () => html(layout("privacy", "Privacy Policy", renderPrivacy())));
site.on("HEAD", "/privacy", () => html(layout("privacy", "Privacy Policy", renderPrivacy())));
site.on("GET", "/terms", () => html(layout("terms", "Terms of Service", renderTerms())));
site.on("HEAD", "/terms", () => html(layout("terms", "Terms of Service", renderTerms())));
site.on("GET", "/contact", () => html(layout("contact", "Contact", renderContact())));
site.on("HEAD", "/contact", () => html(layout("contact", "Contact", renderContact())));
site.on("GET", "/signup", () => redirect("/"));
site.on("HEAD", "/signup", () => redirect("/"));
site.on("GET", "/admin", (_request, env, _ctx, route) => {
  const routeError = requireAdminRoutesEnabled(env);
  if (routeError) {
    return routeError;
  }

  return html(layout("admin", "Admin Dashboard", renderAdmin(route.url)));
});
site.on("HEAD", "/admin", (_request, env, _ctx, route) => {
  const routeError = requireAdminRoutesEnabled(env);
  if (routeError) {
    return routeError;
  }

  return html(layout("admin", "Admin Dashboard", renderAdmin(route.url)));
});
site.on("GET", "/admin/api/runtime-metadata", async (request, env) => {
  const accessError = requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  return json(buildRuntimeMetadata(env));
});

site.on("GET", "/admin/api/contact-aliases", async (request, env) => {
  const accessError = requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  const configError = requireCloudflareEmailConfig(env);
  if (configError) {
    return configError;
  }

  try {
    const rules = await listEmailRoutingRules(env);
    const aliases = CONTACT_ALIAS_LOCALPARTS.map((alias) => {
      const address = getContactAliasAddress(env, alias);
      const rule = rules.find((entry) =>
        entry.matchers.some((matcher) => matcher.type === "literal" && matcher.field === "to" && matcher.value === address)
      );
      const forwardAction = rule?.actions.find((action) => action.type === "forward");
      const workerAction = rule?.actions.find((action) => action.type === "worker");
      return {
        alias,
        address,
        configured: Boolean(rule),
        enabled: rule?.enabled ?? false,
        mode: workerAction ? "internal" : forwardAction ? "forward" : null,
        destination: forwardAction?.value?.[0] ?? null,
        worker: workerAction?.value?.[0] ?? null,
        ruleId: rule?.id ?? null,
      };
    });

    return json({
      domain: env.CLOUDFLARE_EMAIL_DOMAIN,
      aliases,
      rules,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load aliases" }, { status: 502 });
  }
});
site.on("POST", "/admin/api/contact-aliases", async (request, env) => {
  const accessError = requireSiteAdminAccess(request, env);
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

  if (!env.CLOUDFLARE_EMAIL_WORKER) {
    return json({ error: "CLOUDFLARE_EMAIL_WORKER is not configured" }, { status: 500 });
  }

  try {
    const rules = await listEmailRoutingRules(env);
    const address = `${alias}@${env.CLOUDFLARE_EMAIL_DOMAIN}`;
    const existing = rules.find((entry) =>
      entry.matchers.some((matcher) => matcher.type === "literal" && matcher.field === "to" && matcher.value === address)
    );
    const mailbox = await ensureMailbox(env, {
      tenantId: CONTACT_ALIAS_TENANT_ID,
      address,
    });
    const rule = await upsertWorkerRule(env, alias, env.CLOUDFLARE_EMAIL_WORKER, existing?.id);
    return json({ ok: true, rule, mailbox });
  } catch (error) {
    const status = error instanceof MailboxConflictError ? 409 : 502;
    return json({ error: error instanceof Error ? error.message : "Unable to save alias" }, { status });
  }
});
site.on("POST", "/admin/api/contact-aliases/bootstrap", async (request, env) => {
  const accessError = requireSiteAdminAccess(request, env);
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

      if (existing && !body.overwrite) {
        results.push({ alias, skipped: true, reason: "exists" });
        continue;
      }

      const mailbox = await ensureMailbox(env, {
        tenantId: CONTACT_ALIAS_TENANT_ID,
        address,
      });
      const rule = await upsertWorkerRule(env, alias, env.CLOUDFLARE_EMAIL_WORKER, existing?.id);
      results.push({ alias, skipped: false, ruleId: rule.id, mailboxId: mailbox.id });
    }

    return json({ ok: true, results });
  } catch (error) {
    const status = error instanceof MailboxConflictError ? 409 : 502;
    return json({ error: error instanceof Error ? error.message : "Unable to bootstrap aliases" }, { status });
  }
});
site.on("DELETE", "/admin/api/contact-aliases/:alias", async (request, env, _ctx, route) => {
  const accessError = requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  const configError = requireCloudflareEmailConfig(env);
  if (configError) {
    return configError;
  }

  try {
    const rules = await listEmailRoutingRules(env);
    const address = `${route.params.alias.toLowerCase()}@${env.CLOUDFLARE_EMAIL_DOMAIN}`;
    const existing = rules.find((entry) =>
      entry.matchers.some((matcher) => matcher.type === "literal" && matcher.field === "to" && matcher.value === address)
    );

    if (!existing) {
      return json({ ok: true, deleted: false });
    }

    await deleteEmailRoutingRule(env, existing.id);
    return json({ ok: true, deleted: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to delete alias" }, { status: 502 });
  }
});
site.on("GET", "/admin/api/mailboxes", async (request, env) => {
  const accessError = requireSiteAdminAccess(request, env);
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
  const accessError = requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  try {
    const url = new URL(request.url);
    const mailboxId = url.searchParams.get("mailboxId") ?? undefined;
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
    return json({ items: await listMessages(env, { mailboxId, limit, search, direction, status }) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load messages" }, { status: 502 });
  }
});
site.on("GET", "/admin/api/messages/:messageId", async (request, env, _ctx, route) => {
  const accessError = requireSiteAdminAccess(request, env);
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
  const accessError = requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  try {
    return json(await getMessageContent(env, route.params.messageId));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load message content" }, { status: 502 });
  }
});
site.on("GET", "/admin/api/threads/:threadId", async (request, env, _ctx, route) => {
  const accessError = requireSiteAdminAccess(request, env);
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
  const accessError = requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  try {
    return json({ items: await listDeliveryEventsByMessageId(env, route.params.messageId) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load delivery events" }, { status: 502 });
  }
});
site.on("GET", "/admin/api/outbound-jobs", async (request, env) => {
  const accessError = requireSiteAdminAccess(request, env);
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
    const limit = Number(url.searchParams.get("limit") ?? "50");
    return json({ items: await listOutboundJobs(env, { status, limit }) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load outbound jobs" }, { status: 502 });
  }
});
site.on("GET", "/admin/api/messages/:messageId/outbound-job", async (request, env, _ctx, route) => {
  const accessError = requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  try {
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
  const accessError = requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  try {
    const job = await getOutboundJob(env, route.params.outboundJobId);
    if (!job) {
      return json({ error: "Outbound job not found" }, { status: 404 });
    }
    const message = await getMessage(env, job.messageId);
    const previousMessageStatus = message?.status;
    if (message?.providerMessageId) {
      return json({ error: "Outbound jobs with provider delivery events cannot be retried from the queue state" }, { status: 409 });
    }
    if (job.status !== "failed") {
      return json({ error: `Outbound job status ${job.status} cannot be retried` }, { status: 409 });
    }

    await updateOutboundJobStatus(env, {
      outboundJobId: job.id,
      status: "queued",
      retryCount: 0,
      lastError: null,
      nextRetryAt: null,
    });
    await updateMessageStatus(env, job.messageId, "tasked");
    const draft = await getDraftByR2Key(env, job.draftR2Key);
    const previousDraftStatus = draft?.status;
    if (draft) {
      await markDraftStatus(env, draft.id, "queued");
    }
    try {
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
      throw error;
    }

    return json({ ok: true, outboundJobId: job.id, status: "queued" });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to retry outbound job" }, { status: 502 });
  }
});
site.on("GET", "/admin/api/drafts", async (request, env) => {
  const accessError = requireSiteAdminAccess(request, env);
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
    const limit = Number(url.searchParams.get("limit") ?? "50");
    return json({ items: await listDrafts(env, { mailboxId, status, limit }) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load drafts" }, { status: 502 });
  }
});
site.on("GET", "/admin/api/drafts/:draftId", async (request, env, _ctx, route) => {
  const accessError = requireSiteAdminAccess(request, env);
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
  const accessError = requireSiteAdminAccess(request, env);
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
        return json({ error: "An admin send request with this idempotency key is already in progress" }, { status: 409 });
      }
      if (reservation.status === "completed") {
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
    const result = await enqueueDraftSend(env, draft.id);
    const response = {
      ok: true,
      draftId: draft.id,
      outboundJobId: result.outboundJobId,
      status: result.status,
    };

    if (idempotencyKey) {
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
    if (idempotencyKey) {
      await releaseIdempotencyKey(env, "admin_send", tenantId, idempotencyKey).catch(() => undefined);
    }
    if (error instanceof SiteRequestError) {
      return json({ error: error.message }, { status: error.status });
    }
    return json({ error: error instanceof Error ? error.message : "Unable to send message" }, { status: 502 });
  }
});

site.on("POST", "/admin/api/maintenance/idempotency-cleanup", async (request, env) => {
  const accessError = requireSiteAdminAccess(request, env);
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
  const accessError = requireSiteAdminAccess(request, env);
  if (accessError) {
    return accessError;
  }

  try {
    const url = new URL(request.url);
    const operation = url.searchParams.get("operation")?.trim() || undefined;
    const statusParam = url.searchParams.get("status")?.trim();
    const status = statusParam === "pending" || statusParam === "completed" ? statusParam : undefined;
    const limit = Number(url.searchParams.get("limit") ?? "50");

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
    return await site.handle(request, env, ctx);
  } catch (error) {
    if (error instanceof InvalidJsonBodyError) {
      return badRequest(error.message);
    }
    if (error instanceof SiteRequestError) {
      return json({ error: error.message }, { status: error.status });
    }

    throw error;
  }
}

function requireSiteAdminAccess(request: Request, env: Env): Response | null {
  const routeError = requireAdminRoutesEnabled(env);
  if (routeError) {
    return routeError;
  }

  return requireAdminSecret(request, env);
}

function html(markup: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "public, max-age=300");

  return new Response(markup, {
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
    main {
      padding: 24px 0 56px;
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
    }
    @media (max-width: 680px) {
      .shell {
        width: min(calc(100% - 20px), var(--shell));
      }
      .nav { padding-top: 14px; }
      .markdown-doc { padding: 24px 20px; }
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

<p>AI-first email infrastructure for agent-native products.</p>

<p>This homepage is intentionally documentation-shaped. It is meant to be easy for an autonomous agent to parse and easy for a human operator to audit.</p>

<hr />

<h2>Summary</h2>

<ul>
  <li><strong>Service type:</strong> mailbox orchestration plus transactional email runtime</li>
  <li><strong>Registration mode:</strong> API only</li>
  <li><strong>Signup API:</strong> <a href="${signupApi}"><code>${signupApi}</code></a></li>
  <li><strong>Default signup access:</strong> mailbox-scoped bearer token with read, draft, and send scopes</li>
  <li><strong>Runtime metadata:</strong> <a href="${runtimeMetadata}"><code>${runtimeMetadata}</code></a></li>
  <li><strong>Compatibility contract:</strong> <a href="${compatibilityApi}"><code>${compatibilityApi}</code></a></li>
  <li><strong>GitHub repo:</strong> <a href="${githubRepo}"><code>${githubRepo}</code></a></li>
  <li><strong>Fallback contact:</strong> <a href="mailto:${accessEmail}">${accessEmail}</a></li>
</ul>

<h2>Current Delivery Notice</h2>

<p>External operator inbox delivery is currently constrained by AWS SES sandbox rules. The signup API still returns a mailbox-scoped bearer token inline, but welcome emails and public token reissue emails should be treated as verified-recipient-only until unrestricted SES production access is restored for the active account and region.</p>

<ul>
  <li><strong>Signup still works:</strong> save the inline <code>accessToken</code> from the signup response.</li>
  <li><strong>Welcome email is not guaranteed for arbitrary external inboxes:</strong> <code>operatorEmail</code> delivery may fail unless the recipient is verified in SES.</li>
  <li><strong>Public token reissue is acceptance-only:</strong> the API can accept the request even when external email delivery remains sandbox-limited.</li>
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
  <li><code>operatorEmail</code>: operator inbox for welcome and token-reissue email; external delivery may be sandbox-limited unless the recipient is verified in SES</li>
  <li><code>productName</code>: product context used in metadata</li>
  <li><code>useCase</code>: short description of the mailbox workflow</li>
</ul>

<h3>Signup Response</h3>

<p>A successful signup returns mailbox metadata plus a default mailbox-scoped bearer token that can immediately read inbound messages, create drafts, inspect drafts, and send drafts for the newly created mailbox.</p>

<pre><code>{
  "tenantId": "tnt_example",
  "mailboxAddress": "agent-demo@mailagents.net",
  "mailboxId": "mbx_example",
  "agentId": "agt_example",
  "agentVersionId": "agv_example",
  "deploymentId": "agd_example",
  "accessToken": "REDACTED",
  "accessTokenExpiresAt": "2026-04-17T05:24:03.000Z",
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
<p>While SES remains sandbox-limited for external recipients, treat the inline signup response as the primary onboarding path and do not assume the operator welcome email will arrive for an arbitrary external inbox.</p>

<ol>
  <li>Call the signup API at <code>${signupApi}</code> and save <code>accessToken</code>, <code>agentId</code>, <code>mailboxId</code>, and <code>mailboxAddress</code>.</li>
  <li>Use the returned bearer token with <code>Authorization: Bearer ...</code>.</li>
  <li>Discover runtime tools with <code>POST /mcp</code> and method <code>tools/list</code>.</li>
  <li>Read inbound mail with <code>list_messages</code> or the mailbox self routes.</li>
  <li>Send outbound mail with <code>send_email</code>.</li>
  <li>Reply on-thread with <code>reply_to_message</code>.</li>
</ol>

<p>If the signup token expires, call <code>POST /public/token/reissue</code> with <code>mailboxAlias</code> or <code>mailboxAddress</code>. The runtime will email a refreshed mailbox-scoped token only to the original <code>operatorEmail</code>; it never returns the new token to the caller.</p>
<p>If the current token is still valid and the agent wants to rotate proactively without emailing the operator, call <code>POST /v1/auth/token/rotate</code>. That authenticated route can return the new token inline and can optionally deliver it back to the mailbox itself.</p>

<h2>Token Lifecycle</h2>

<p>Every new signup returns a mailbox-scoped bearer token. That token lets the agent read inbound mail, create drafts, and send messages for the mailbox.</p>

<ul>
  <li><strong>Default lifetime:</strong> the signup token expires after 30 days unless the runtime is configured with a different <code>SELF_SERVE_ACCESS_TOKEN_TTL_SECONDS</code> value.</li>
  <li><strong>Expired token:</strong> call <code>POST /public/token/reissue</code>. The API always returns a generic acceptance response and, if the mailbox exists, attempts to email a refreshed token only to the original <code>operatorEmail</code>.</li>
  <li><strong>Still-valid token:</strong> call <code>POST /v1/auth/token/rotate</code>. That authenticated route can return the rotated token inline, deliver it back to the mailbox itself, or do both without emailing the operator.</li>
  <li><strong>Current SES constraint:</strong> public reissue email to arbitrary external operator inboxes is not guaranteed while SES remains sandbox-limited.</li>
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
  <li><code>tenantId</code></li>
  <li><code>agentId</code></li>
  <li><code>mailboxId</code></li>
  <li><code>mailboxAddress</code></li>
  <li><code>operatorEmail</code></li>
</ul>

<h3>2. Discover Available Tools</h3>

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

<h3>3. Read Mailbox Messages</h3>

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

<p>Mailbox-scoped tokens can also use the HTTP self routes directly, for example <code>GET /v1/mailboxes/self/messages</code>.</p>

<h3>4. Send a New Email</h3>

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

<h3>5. Reply to an Inbound Message</h3>

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

<p>Use <code>tools/list</code> to discover the full MCP surface. The default mailbox-scoped token is expected to use <code>list_messages</code>, <code>send_email</code>, and <code>reply_to_message</code> as the primary workflow path.</p>

<h3>6. Reissue an Expired Token</h3>

<pre><code>curl -sS -X POST https://api.mailagents.net/public/token/reissue \
  -H 'content-type: application/json' \
  -d '{
    "mailboxAlias": "agent-demo"
  }'</code></pre>

<p>This endpoint always returns a generic acceptance response. If the mailbox exists, a refreshed token is delivered only to the original <code>operatorEmail</code> from signup.</p>
<p>While SES remains sandbox-limited for external recipients, treat that delivery as best-effort unless the destination inbox is verified in SES.</p>
<p>Abuse controls apply: repeated requests are cooled down per mailbox and rate limited per source IP. The API never returns the token inline.</p>

<h3>7. Rotate a Still-Valid Token</h3>

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
  <li><a href="/privacy">Privacy Policy</a></li>
  <li><a href="/terms">Terms of Service</a></li>
  <li><a href="/contact">Contact</a></li>
</ul>
</article>`;
}

function renderPrivacy(): string {
  return `<section class="panel section legal">
    <section>
      <div class="eyebrow">Privacy Policy</div>
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
        <h2>Reach the team behind Mailagents.</h2>
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

function renderAdmin(url: URL): string {
  const domain = escapeHtml(url.host);
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
      grid-template-columns: repeat(4, minmax(0, 1fr));
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
      .admin-login-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>

  <section id="admin-login-view" class="admin-login-shell">
    <div class="admin-login-card">
      <div class="eyebrow">Admin Access</div>
      <h1 style="font-size:52px; margin: 10px 0 14px;">Mailagents Control Room</h1>
      <p class="lead" style="max-width: 52ch;">先登錄，再進入後台。這個入口只給運營和管理員使用，會連到你現在已經在跑的郵件資料與轉發規則。</p>
      <div class="admin-login-grid">
        <section class="card">
          <h3>Sign in</h3>
          <p>使用 Worker 上配置的管理密鑰。密鑰只會保存在你當前這台瀏覽器的 localStorage。</p>
          <form id="auth-form">
            <p><input id="admin-secret" class="admin-input" type="password" placeholder="Admin secret" /></p>
            <p><button class="button primary" type="submit">Enter Dashboard</button></p>
          </form>
          <p id="auth-status" class="admin-note">Dashboard is locked.</p>
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

  <section id="admin-app-shell" class="admin-app-shell">
    <aside class="admin-sidebar">
      <div>
        <div class="eyebrow">Mailagents Admin</div>
        <h2 style="margin:8px 0 10px;">Operations Dashboard</h2>
        <p class="admin-note">郵件管理、轉發別名、發件與隊列狀態都放到這個工作台裡。</p>
      </div>
      <nav aria-label="Admin sections">
        <button class="admin-nav-button active" data-view="overview" type="button">
          <strong>Overview</strong>
          <span>系統概況與快速入口</span>
        </button>
        <button class="admin-nav-button" data-view="messages" type="button">
          <strong>Messages</strong>
          <span>郵箱與消息明細</span>
        </button>
        <button class="admin-nav-button" data-view="contact" type="button">
          <strong>Contact Inboxes</strong>
          <span>hello / security / privacy / dmarc</span>
        </button>
        <button class="admin-nav-button" data-view="threads" type="button">
          <strong>Threads & Delivery</strong>
          <span>線程、投遞事件、Outbox</span>
        </button>
        <button class="admin-nav-button" data-view="aliases" type="button">
          <strong>Contact Aliases</strong>
          <span>公共郵箱轉發規則</span>
        </button>
        <button class="admin-nav-button" data-view="compose" type="button">
          <strong>Compose</strong>
          <span>後台發件與快速回覆</span>
        </button>
        <button class="admin-nav-button" data-view="idempotency" type="button">
          <strong>Idempotency</strong>
          <span>重試鍵、衝突與清理</span>
        </button>
      </nav>
    </aside>

    <div class="admin-main">
      <section class="admin-topbar">
        <div>
          <div class="eyebrow">Workspace</div>
          <h2 id="admin-view-title" style="margin: 6px 0 8px;">Overview</h2>
          <div id="admin-runtime-status" class="admin-status-pill">Connected to live runtime</div>
        </div>
        <div class="admin-topbar-actions">
          <button id="refresh-dashboard" class="button secondary" type="button">Refresh</button>
          <button id="logout-dashboard" class="button secondary" type="button">Log Out</button>
        </div>
      </section>

      <section id="admin-view-overview" class="admin-view active">
        <article class="admin-hero-card">
          <div class="eyebrow">Overview</div>
          <h2 style="margin:8px 0 10px;">分區式後台已就位</h2>
          <p>現在的後台先進入登錄頁，解鎖後再進入左側導航的管理界面。右側內容會跟隨模塊切換，不再把所有工具堆在一個長頁裡。</p>
        </article>
        <div class="admin-kpi-grid">
          <div class="admin-kpi">
            <span class="label">Mailboxes</span>
            <strong id="stat-mailboxes">0</strong>
          </div>
          <div class="admin-kpi">
            <span class="label">Visible Messages</span>
            <strong id="stat-messages">0</strong>
          </div>
          <div class="admin-kpi">
            <span class="label">Outbound Jobs</span>
            <strong id="stat-jobs">0</strong>
          </div>
          <div class="admin-kpi">
            <span class="label">Configured Aliases</span>
            <strong id="stat-aliases">0</strong>
          </div>
        </div>
        <div class="admin-two-column">
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>Mail runtime</h3>
                <p>讀取現有郵箱與消息，不改動你現有收發鏈路。</p>
              </div>
            </div>
            <div id="overview-mail-runtime" class="admin-list admin-muted">Unlock the dashboard to inspect runtime status.</div>
          </section>
          <section class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3>Contact aliases</h3>
                <p>面向官網展示的三個公共地址。</p>
              </div>
            </div>
            <div id="overview-alias-status" class="admin-list admin-muted">Unlock the dashboard to inspect alias status.</div>
          </section>
        </div>
        <section class="admin-card" style="margin-top:24px;">
          <div class="admin-card-header">
            <div>
              <h3>AI runtime policy</h3>
              <p>直接查看 MCP 工具的風險分級、是否有副作用，以及哪些動作應該先停下來等人確認。</p>
            </div>
          </div>
          <div id="overview-ai-policy" class="admin-list admin-muted">Unlock the dashboard to inspect MCP risk policy.</div>
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
            <p id="alias-status" class="admin-note">No changes submitted yet.</p>
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
          <div id="alias-list" class="admin-list">Unlock the dashboard to load aliases.</div>
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
    const secretKey = "mailagents_admin_secret";
    const authForm = document.getElementById("auth-form");
    const aliasForm = document.getElementById("alias-form");
    const secretInput = document.getElementById("admin-secret");
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
    const overviewMailRuntime = document.getElementById("overview-mail-runtime");
    const overviewAliasStatus = document.getElementById("overview-alias-status");
    const overviewAiPolicy = document.getElementById("overview-ai-policy");
    const statMailboxes = document.getElementById("stat-mailboxes");
    const statMessages = document.getElementById("stat-messages");
    const statJobs = document.getElementById("stat-jobs");
    const statAliases = document.getElementById("stat-aliases");
    const viewMeta = {
      overview: "Overview",
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
    let latestAliases = [];
    let latestMessages = [];
    let latestJobs = [];
    let latestRuntimeMetadata = null;

    secretInput.value = window.localStorage.getItem(secretKey) || "";

    async function api(path, init = {}) {
      const secret = window.localStorage.getItem(secretKey) || "";
      const headers = new Headers(init.headers || {});
      headers.set("x-admin-secret", secret);
      if (!headers.has("content-type") && init.body) {
        headers.set("content-type", "application/json");
      }

      const response = await fetch(path, { ...init, headers });
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

    function updateOverview() {
      statMailboxes.textContent = String(mailboxIndex.length);
      statMessages.textContent = String(latestMessages.length);
      statJobs.textContent = String(latestJobs.length);
      statAliases.textContent = String(latestAliases.filter((item) => item.configured).length);
      const runtimeDomain = latestAliases[0] ? latestAliases[0].address.split('@')[1] : 'mailagents.net';

      overviewMailRuntime.innerHTML = [
        '<div class="faq-item"><h3>Active domain</h3><p>' + esc(runtimeDomain) + '</p></div>',
        '<div class="faq-item"><h3>Mailbox source</h3><p>' + esc(mailboxIndex.length ? mailboxIndex.length + ' live mailboxes loaded.' : 'No mailbox loaded yet.') + '</p></div>',
        '<div class="faq-item"><h3>Reply workflow</h3><p>' + esc(currentReplyContext ? 'Reply draft prepared for ' + currentReplyContext.to : 'No quick reply prepared.') + '</p></div>',
      ].join("");

      overviewAliasStatus.innerHTML = latestAliases.length
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

    async function loadRuntimeMetadata() {
      try {
        latestRuntimeMetadata = await api('/admin/api/runtime-metadata');
        updateOverview();
      } catch (error) {
        latestRuntimeMetadata = null;
        overviewAiPolicy.textContent = error.message;
      }
    }

    function renderAliases(aliases) {
      latestAliases = aliases;
      aliasList.innerHTML = aliases.map((item) => {
        const target = item.mode === "internal"
          ? 'Internal inbox via worker <strong>' + esc(item.worker || 'n/a') + '</strong>'
          : esc(item.destination || 'Not configured');
        const action = item.configured
          ? '<button data-alias="' + esc(item.alias) + '" class="button secondary delete-alias" type="button">Delete</button>'
          : "";
        return '<div class="faq-item">' +
          '<h3>' + esc(item.address) + '</h3>' +
          '<p>Status: ' + esc(item.configured ? 'Configured' : 'Missing') + '</p>' +
          '<p>Route: ' + target + '</p>' +
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
        authStatus.textContent = 'Dashboard unlocked.';
        renderAliases(payload.aliases);
      } catch (error) {
        authStatus.textContent = error.message;
        aliasList.textContent = 'Unable to load aliases.';
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
              '<p style="margin-top:12px;">' + (job.status === 'failed'
                ? '<button data-job="' + esc(job.id) + '" class="button secondary retry-job" type="button">Retry Job</button>'
                : '') + '</p>' +
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
            outboxDetail.textContent = 'Retried outbound job ' + id + '.';
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
      runtimeStatus.textContent = 'Connecting to live runtime';
      await loadRuntimeMetadata();
      await loadAliases();
      await loadMailboxes();
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
      runtimeStatus.textContent = 'Connected to live runtime';
      updateOverview();
    }

    authForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      window.localStorage.setItem(secretKey, secretInput.value);
      try {
        await bootstrapDashboard();
        setAuthenticated(true);
        setView("overview");
      } catch (error) {
        authStatus.textContent = error.message;
        runtimeStatus.textContent = 'Authentication failed';
        setAuthenticated(false);
      }
    });

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
      } catch (error) {
        aliasBootstrapStatus.textContent = error.message;
      }
    });

    messageSearch.addEventListener('change', loadMessages);
    messageDirection.addEventListener('change', loadMessages);
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

    refreshDashboard.addEventListener("click", async () => {
      try {
        await bootstrapDashboard();
      } catch (error) {
        runtimeStatus.textContent = error.message;
      }
    });

    logoutDashboard.addEventListener("click", () => {
      window.localStorage.removeItem(secretKey);
      secretInput.value = "";
      authStatus.textContent = "Dashboard is locked.";
      runtimeStatus.textContent = "Disconnected";
      setAuthenticated(false);
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
      } catch (error) {
        sendStatus.textContent = error.message;
      }
    });

    if (secretInput.value) {
      bootstrapDashboard()
        .then(() => {
          setAuthenticated(true);
          setView("overview");
        })
        .catch((error) => {
          authStatus.textContent = error.message;
          runtimeStatus.textContent = "Authentication failed";
          setAuthenticated(false);
        });
    } else {
      setAuthenticated(false);
    }
  </script>`;
}
