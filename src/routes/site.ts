import { requireAdminSecret } from "../lib/auth";
import {
  deleteEmailRoutingRule,
  listEmailRoutingRules,
  requireCloudflareEmailConfig,
  upsertWorkerRule,
} from "../lib/cloudflare-email";
import { badRequest, json } from "../lib/http";
import { Router } from "../lib/router";
import { ensureMailbox, listMailboxes } from "../repositories/agents";
import {
  createDraft,
  enqueueDraftSend,
  getDraft,
  getMessage,
  getMessageContent,
  getOutboundJob,
  getOutboundJobByMessageId,
  getThread,
  listDeliveryEventsByMessageId,
  listDrafts,
  listMessages,
  listOutboundJobs,
  updateOutboundJobStatus,
} from "../repositories/mail";
import type { Env } from "../types";

const site = new Router<Env>();

site.on("GET", "/", (_request, _env, _ctx, route) => html(layout("overview", "Mailagents", renderHome(route.url))));
site.on("HEAD", "/", (_request, _env, _ctx, route) => html(layout("overview", "Mailagents", renderHome(route.url))));
site.on("GET", "/privacy", () => html(layout("privacy", "Privacy Policy", renderPrivacy())));
site.on("HEAD", "/privacy", () => html(layout("privacy", "Privacy Policy", renderPrivacy())));
site.on("GET", "/terms", () => html(layout("terms", "Terms of Service", renderTerms())));
site.on("HEAD", "/terms", () => html(layout("terms", "Terms of Service", renderTerms())));
site.on("GET", "/contact", () => html(layout("contact", "Contact", renderContact())));
site.on("HEAD", "/contact", () => html(layout("contact", "Contact", renderContact())));
site.on("GET", "/admin", (_request, _env, _ctx, route) => html(layout("admin", "Admin Dashboard", renderAdmin(route.url))));
site.on("HEAD", "/admin", (_request, _env, _ctx, route) => html(layout("admin", "Admin Dashboard", renderAdmin(route.url))));
site.on("GET", "/admin/api/contact-aliases", async (request, env) => {
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  const configError = requireCloudflareEmailConfig(env);
  if (configError) {
    return configError;
  }

  try {
    const rules = await listEmailRoutingRules(env);
    const aliases = ["hello", "security", "privacy", "dmarc"].map((alias) => {
      const address = `${alias}@${env.CLOUDFLARE_EMAIL_DOMAIN}`;
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
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  const configError = requireCloudflareEmailConfig(env);
  if (configError) {
    return configError;
  }

  const body = await request.json<{ alias?: string }>();
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
    const rule = await upsertWorkerRule(env, alias, env.CLOUDFLARE_EMAIL_WORKER, existing?.id);
    const mailbox = await ensureMailbox(env, {
      tenantId: "t_demo",
      address,
    });
    return json({ ok: true, rule, mailbox });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to save alias" }, { status: 502 });
  }
});
site.on("POST", "/admin/api/contact-aliases/bootstrap", async (request, env) => {
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  const configError = requireCloudflareEmailConfig(env);
  if (configError) {
    return configError;
  }

  const body = await request.json<{
    overwrite?: boolean;
  }>();
  if (!env.CLOUDFLARE_EMAIL_WORKER) {
    return json({ error: "CLOUDFLARE_EMAIL_WORKER is not configured" }, { status: 500 });
  }

  try {
    const rules = await listEmailRoutingRules(env);
    const aliases = ["hello", "security", "privacy", "dmarc"];
    const results = [];

    for (const alias of aliases) {
      const address = `${alias}@${env.CLOUDFLARE_EMAIL_DOMAIN}`;
      const existing = rules.find((entry) =>
        entry.matchers.some((matcher) => matcher.type === "literal" && matcher.field === "to" && matcher.value === address)
      );

      if (existing && !body.overwrite) {
        results.push({ alias, skipped: true, reason: "exists" });
        continue;
      }

      const rule = await upsertWorkerRule(env, alias, env.CLOUDFLARE_EMAIL_WORKER, existing?.id);
      const mailbox = await ensureMailbox(env, {
        tenantId: "t_demo",
        address,
      });
      results.push({ alias, skipped: false, ruleId: rule.id, mailboxId: mailbox.id });
    }

    return json({ ok: true, results });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to bootstrap aliases" }, { status: 502 });
  }
});
site.on("DELETE", "/admin/api/contact-aliases/:alias", async (request, env, _ctx, route) => {
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
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
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  try {
    return json({ items: await listMailboxes(env) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load mailboxes" }, { status: 502 });
  }
});
site.on("GET", "/admin/api/messages", async (request, env) => {
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
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
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
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
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  try {
    return json(await getMessageContent(env, route.params.messageId));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load message content" }, { status: 502 });
  }
});
site.on("GET", "/admin/api/threads/:threadId", async (request, env, _ctx, route) => {
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
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
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  try {
    return json({ items: await listDeliveryEventsByMessageId(env, route.params.messageId) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load delivery events" }, { status: 502 });
  }
});
site.on("GET", "/admin/api/outbound-jobs", async (request, env) => {
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
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
site.on("POST", "/admin/api/outbound-jobs/:outboundJobId/retry", async (request, env, _ctx, route) => {
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  try {
    const job = await getOutboundJob(env, route.params.outboundJobId);
    if (!job) {
      return json({ error: "Outbound job not found" }, { status: 404 });
    }

    await updateOutboundJobStatus(env, {
      outboundJobId: job.id,
      status: "queued",
      lastError: null,
      nextRetryAt: null,
    });
    await env.OUTBOUND_SEND_QUEUE.send({ outboundJobId: job.id });

    return json({ ok: true, outboundJobId: job.id, status: "queued" });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to retry outbound job" }, { status: 502 });
  }
});
site.on("GET", "/admin/api/drafts", async (request, env) => {
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
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
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
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
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  const body = await request.json<{
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
  }>();

  if (!body.mailboxId || !body.tenantId || !body.from || !body.to?.length || !body.subject) {
    return badRequest("mailboxId, tenantId, from, to, and subject are required");
  }

  try {
    const draft = await createDraft(env, {
      tenantId: body.tenantId,
      agentId: "admin_console",
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
        attachments: [],
      },
    });
    const result = await enqueueDraftSend(env, draft.id);
    return json({
      ok: true,
      draftId: draft.id,
      outboundJobId: result.outboundJobId,
      status: result.status,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to send message" }, { status: 502 });
  }
});

export async function handleSiteRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  return await site.handle(request, env, ctx);
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

function layout(active: string, title: string, content: string): string {
  const pageTitle = title === "Mailagents" ? "Mailagents" : `${title} · Mailagents`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="Mailagents is email infrastructure for agent-native products, with rentable inboxes, transactional delivery, and operator controls." />
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
      position: sticky;
      top: 0;
      z-index: 10;
      backdrop-filter: blur(14px);
      background: rgba(242, 237, 228, 0.72);
      border-bottom: 1px solid rgba(28, 25, 22, 0.06);
    }
    .nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding: 16px 0;
    }
    .wordmark {
      text-decoration: none;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
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
    .nav-links {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
    }
    .nav-links a {
      text-decoration: none;
      padding: 9px 12px;
      border-radius: 999px;
      font-size: 14px;
      color: var(--muted);
    }
    .nav-links a.active,
    .nav-links a:hover {
      background: rgba(28, 25, 22, 0.06);
      color: var(--ink);
    }
    main {
      padding: 34px 0 56px;
    }
    .hero {
      display: grid;
      grid-template-columns: 1.2fr 0.8fr;
      gap: 18px;
      align-items: stretch;
      margin-bottom: 18px;
    }
    .hero-card,
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius-xl);
      box-shadow: var(--shadow);
    }
    .hero-card {
      position: relative;
      overflow: hidden;
      padding: 34px;
    }
    .hero-card::after {
      content: "";
      position: absolute;
      right: -34px;
      top: -26px;
      width: 200px;
      height: 200px;
      border-radius: 40px;
      background: linear-gradient(135deg, rgba(181, 95, 51, 0.26), rgba(34, 73, 61, 0.18));
      transform: rotate(16deg);
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--brand-deep);
      text-transform: uppercase;
      letter-spacing: 0.14em;
      font-size: 12px;
      font-weight: 700;
    }
    h1 {
      margin: 14px 0 12px;
      font-family: 'Instrument Serif', serif;
      font-size: clamp(42px, 7vw, 74px);
      line-height: 0.92;
      font-weight: 400;
      max-width: 10ch;
    }
    .lead {
      max-width: 62ch;
      color: var(--muted);
      font-size: 16px;
      line-height: 1.8;
    }
    .hero-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 22px;
    }
    .button {
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      padding: 12px 16px;
      font-weight: 700;
      font-size: 14px;
      border: 1px solid transparent;
    }
    .button.primary {
      background: var(--ink);
      color: #fff8f0;
    }
    .button.secondary {
      background: rgba(255, 255, 255, 0.52);
      border-color: var(--line);
    }
    .hero-side {
      display: grid;
      gap: 18px;
    }
    .signal {
      padding: 24px;
    }
    .signal h2,
    .panel h2 {
      margin: 0 0 10px;
      font-size: 24px;
    }
    .signal p,
    .panel p,
    .panel li {
      color: var(--muted);
      font-size: 14px;
      line-height: 1.7;
    }
    .signal-grid,
    .stats,
    .cards,
    .policies {
      display: grid;
      gap: 18px;
    }
    .signal-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      margin-top: 14px;
    }
    .mini {
      padding: 16px;
      border-radius: var(--radius-md);
      background: rgba(255, 255, 255, 0.48);
      border: 1px solid rgba(28, 25, 22, 0.08);
    }
    .mini .label {
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-size: 11px;
      font-weight: 700;
    }
    .mini strong {
      display: block;
      margin-top: 8px;
      font-size: 20px;
    }
    .section {
      margin-top: 18px;
      padding: 28px;
    }
    .section-head {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }
    .section-head p {
      max-width: 60ch;
    }
    .stats {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
    .cards {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .card,
    .policy {
      padding: 20px;
      border-radius: var(--radius-lg);
      background: rgba(255, 255, 255, 0.46);
      border: 1px solid rgba(28, 25, 22, 0.08);
    }
    .card h3,
    .policy h3 {
      margin: 0 0 10px;
      font-size: 18px;
    }
    .policy-list {
      margin: 12px 0 0;
      padding-left: 18px;
    }
    .policies {
      grid-template-columns: 1fr 1fr;
    }
    .faq {
      display: grid;
      gap: 16px;
      grid-template-columns: 1fr 1fr;
    }
    .faq-item {
      min-width: 0;
      padding: 20px;
      border-radius: var(--radius-lg);
      background: rgba(255, 255, 255, 0.46);
      border: 1px solid rgba(28, 25, 22, 0.08);
      overflow: hidden;
    }
    .faq-item h3 {
      margin: 0 0 10px;
      font-size: 18px;
      overflow-wrap: anywhere;
      word-break: break-word;
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
    @media (max-width: 980px) {
      .hero,
      .stats,
      .cards,
      .policies,
      .faq,
      .contact-grid {
        grid-template-columns: 1fr;
      }
      .signal-grid {
        grid-template-columns: 1fr 1fr;
      }
      .hero-card,
      .section {
        padding: 24px;
      }
    }
    @media (max-width: 680px) {
      .shell {
        width: min(calc(100% - 20px), var(--shell));
      }
      .nav {
        align-items: start;
        flex-direction: column;
      }
      .signal-grid {
        grid-template-columns: 1fr;
      }
      h1 {
        font-size: 46px;
      }
    }
  </style>
</head>
<body>
  <header class="site-header">
    <div class="shell nav">
      <a class="wordmark" href="/"><span>MA</span>Mailagents</a>
      <nav class="nav-links" aria-label="Primary">
        <a class="${active === "overview" ? "active" : ""}" href="/">Overview</a>
        <a class="${active === "privacy" ? "active" : ""}" href="/privacy">Privacy</a>
        <a class="${active === "terms" ? "active" : ""}" href="/terms">Terms</a>
        <a class="${active === "contact" ? "active" : ""}" href="/contact">Contact</a>
      </nav>
    </div>
  </header>
  <main class="shell">
    ${content}
  </main>
  <footer class="shell footer">
    Mailagents provides transactional email infrastructure, mailbox orchestration, and operator controls for agent-native products.
  </footer>
</body>
</html>`;
}

function renderHome(url: URL): string {
  const site = `${url.protocol}//${url.host}`;
  return `<section class="hero">
    <article class="hero-card">
      <div class="eyebrow">Agent Mail Cloud</div>
      <h1>Email infrastructure for products that ship with agents.</h1>
      <p class="lead">Mailagents helps teams provision inboxes, route inbound mail, trigger workflow execution, and deliver transactional email with clear operator controls. The platform is built for application-driven messaging, not bulk campaigns or list blasting.</p>
      <div class="hero-actions">
        <a class="button primary" href="/contact">Talk to Mailagents</a>
        <a class="button secondary" href="/privacy">Read Privacy Policy</a>
        <a class="button secondary" href="/terms">Read Terms</a>
      </div>
    </article>
    <aside class="hero-side">
      <section class="panel signal">
        <h2>What the service sends</h2>
        <p>Mailagents is intended for transactional and operational messages initiated by product activity, user workflows, and managed mailbox actions.</p>
        <div class="signal-grid">
          <div class="mini">
            <div class="label">Message Types</div>
            <strong>Sign-in codes, alerts, workflow results</strong>
          </div>
          <div class="mini">
            <div class="label">Recipient Source</div>
            <strong>Registered users and user-configured recipients</strong>
          </div>
          <div class="mini">
            <div class="label">Delivery Policy</div>
            <strong>No purchased lists or unsolicited outreach</strong>
          </div>
          <div class="mini">
            <div class="label">Abuse Handling</div>
            <strong>Bounces and complaints are suppressed</strong>
          </div>
        </div>
      </section>
    </aside>
  </section>

  <section class="panel section">
    <div class="section-head">
      <div>
        <div class="eyebrow">Operating Model</div>
        <h2>Built for mailbox orchestration, not marketing blasts.</h2>
      </div>
      <p>Mailagents helps applications manage inboxes and send system email around those inboxes. Typical use cases include account authentication, provisioning confirmations, workflow notifications, bounced message handling, and user-requested outbound actions.</p>
    </div>
    <div class="stats">
      <div class="card">
        <h3>Inbox lifecycle</h3>
        <p>Provision inboxes, manage leases, and attach operator policies around how each mailbox is used.</p>
      </div>
      <div class="card">
        <h3>Inbound routing</h3>
        <p>Receive inbound messages, normalize the payload, and forward them into controlled job pipelines.</p>
      </div>
      <div class="card">
        <h3>Transactional delivery</h3>
        <p>Send product-generated email such as alerts, replies, account events, and workflow outputs.</p>
      </div>
      <div class="card">
        <h3>Operator review</h3>
        <p>Apply policy checks, manual review, and suppression handling before high-risk sends.</p>
      </div>
    </div>
  </section>

  <section class="panel section">
    <div class="section-head">
      <div>
        <div class="eyebrow">Who It Is For</div>
        <h2>Teams building product workflows around real inboxes.</h2>
      </div>
      <p>Mailagents is a fit for applications that need mailbox lifecycle control and reliable transactional delivery in the same system.</p>
    </div>
    <div class="cards">
      <div class="card">
        <h3>Agent products</h3>
        <p>Applications that need inboxes for inbound tasks, automated replies, or workflow execution triggered by email.</p>
      </div>
      <div class="card">
        <h3>Operations tooling</h3>
        <p>Internal tools that need controlled sending for alerts, approvals, queue outputs, and exception handling.</p>
      </div>
      <div class="card">
        <h3>Customer-facing SaaS</h3>
        <p>Products that send sign-in links, receipts, notifications, or account lifecycle messages tied to user activity.</p>
      </div>
    </div>
  </section>

  <section class="panel section">
    <div class="section-head">
      <div>
        <div class="eyebrow">Core Capabilities</div>
        <h2>Clear controls for a sensitive channel.</h2>
      </div>
      <p>Because email can affect trust quickly, the product emphasizes accountability, scoped access, and predictable transactional use.</p>
    </div>
    <div class="cards">
      <div class="card">
        <h3>Scoped sending</h3>
        <p>Sending is limited to product workflows and approved mailbox actions rather than open-ended campaign tools.</p>
      </div>
      <div class="card">
        <h3>Queue-based execution</h3>
        <p>Outbound jobs are staged through queues so retries, suppression checks, and delivery events can be handled cleanly.</p>
      </div>
      <div class="card">
        <h3>Audit-friendly policies</h3>
        <p>Tenant and mailbox controls can restrict who sends, which recipients are allowed, and when human review is required.</p>
      </div>
    </div>
  </section>

  <section class="panel section">
    <div class="section-head">
      <div>
        <div class="eyebrow">Trust & Compliance</div>
        <h2>How Mailagents handles transactional email responsibly.</h2>
      </div>
      <p>This site is the public product overview for the current Mailagents service. The pages linked here are intended to describe real usage, recipient sources, and contact paths for platform review and customer due diligence.</p>
    </div>
    <div class="policies">
      <div class="policy">
        <h3>Allowed use</h3>
        <ul class="policy-list">
          <li>Authentication emails such as sign-in codes or account verification.</li>
          <li>Workflow notifications triggered by user activity in the product.</li>
          <li>Mailbox lifecycle updates such as provisioning, lease, and routing events.</li>
          <li>Operational replies generated on behalf of an active user workflow.</li>
        </ul>
      </div>
      <div class="policy">
        <h3>Not supported</h3>
        <ul class="policy-list">
          <li>Purchased lists, list rentals, or recipient scraping.</li>
          <li>Cold outreach, affiliate blasts, or mass promotional newsletters.</li>
          <li>High-volume bulk marketing without direct user relationship.</li>
          <li>Attempts to bypass complaint, bounce, or suppression controls.</li>
        </ul>
      </div>
    </div>
    <div class="hero-actions">
      <a class="button primary" href="${site}/contact">Request contact details</a>
      <a class="button secondary" href="${site}/privacy">View data handling</a>
    </div>
  </section>

  <section class="panel section">
    <div class="section-head">
      <div>
        <div class="eyebrow">FAQ</div>
        <h2>Quick answers for reviewers and customers.</h2>
      </div>
      <p>These are the questions that usually matter when a new email platform is being evaluated.</p>
    </div>
    <div class="faq">
      <div class="faq-item">
        <h3>Does Mailagents send marketing campaigns?</h3>
        <p>No. The product is designed for transactional and operational email tied to active accounts, mailbox workflows, and user-triggered actions.</p>
      </div>
      <div class="faq-item">
        <h3>Who receives messages sent through the platform?</h3>
        <p>Recipients are registered users, operators, or addresses explicitly configured by users inside supported product workflows.</p>
      </div>
      <div class="faq-item">
        <h3>How are complaints and bounces handled?</h3>
        <p>Suppression controls, delivery event tracking, and account enforcement are used to reduce repeated sends to problematic recipients.</p>
      </div>
      <div class="faq-item">
        <h3>Can the product be used for cold outreach?</h3>
        <p>No. Purchased lists, scraped addresses, unsolicited blasts, and deliverability-abusive workflows are not supported.</p>
      </div>
    </div>
  </section>`;
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
    };
    let currentMailboxId = null;
    let currentContactMailboxId = null;
    let mailboxIndex = [];
    let currentReplyContext = null;
    let latestAliases = [];
    let latestMessages = [];
    let latestJobs = [];

    secretInput.value = window.localStorage.getItem(secretKey) || "";

    async function api(path, init = {}) {
      const secret = window.localStorage.getItem(secretKey) || "";
      const headers = new Headers(init.headers || {});
      headers.set("x-admin-secret", secret);
      if (!headers.has("content-type") && init.body) {
        headers.set("content-type", "application/json");
      }

      const response = await fetch(path, { ...init, headers });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Request failed");
      }
      return payload;
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

      overviewMailRuntime.innerHTML = [
        '<div class="faq-item"><h3>Active domain</h3><p>${domain}</p></div>',
        '<div class="faq-item"><h3>Mailbox source</h3><p>' + (mailboxIndex.length ? mailboxIndex.length + ' live mailboxes loaded.' : 'No mailbox loaded yet.') + '</p></div>',
        '<div class="faq-item"><h3>Reply workflow</h3><p>' + (currentReplyContext ? 'Reply draft prepared for ' + currentReplyContext.to : 'No quick reply prepared.') + '</p></div>',
      ].join("");

      overviewAliasStatus.innerHTML = latestAliases.length
        ? latestAliases.map((item) =>
            '<div class="faq-item">' +
              '<h3>' + item.address + '</h3>' +
              '<p>' + (item.configured ? 'Configured' : 'Missing') + '</p>' +
              '<p>' + (item.mode === 'internal'
                ? 'Internal inbox via worker ' + (item.worker || 'n/a')
                : item.destination || 'No inbox rule yet') + '</p>' +
            '</div>'
          ).join("")
        : 'Unlock the dashboard to inspect alias status.';
    }

    function renderAliases(aliases) {
      latestAliases = aliases;
      aliasList.innerHTML = aliases.map((item) => {
        const target = item.mode === "internal"
          ? 'Internal inbox via worker <strong>' + (item.worker || 'n/a') + '</strong>'
          : item.destination || "<em>Not configured</em>";
        const action = item.configured
          ? '<button data-alias="' + item.alias + '" class="button secondary delete-alias" type="button">Delete</button>'
          : "";
        return '<div class="faq-item">' +
          '<h3>' + item.address + '</h3>' +
          '<p>Status: ' + (item.configured ? 'Configured' : 'Missing') + '</p>' +
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
          '<h3>' + item.address + '</h3>' +
          '<p>Status: ' + item.status + '</p>' +
          '<p style="margin-top:12px;"><button data-mailbox="' + item.id + '" class="button secondary mailbox-button" type="button">Open Mailbox</button></p>' +
        '</div>'
      ).join("");

      sendMailbox.innerHTML = '<option value="">Choose mailbox</option>' + items.map((item) =>
        '<option value="' + item.id + '">' + item.address + '</option>'
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
              '<h3>' + item.address + '</h3>' +
              '<p>Status: ' + item.status + '</p>' +
              '<p style="margin-top:12px;">' +
                '<button data-contact-mailbox="' + item.id + '" class="button secondary contact-mailbox-button" type="button">Open Inbox</button> ' +
                '<button data-main-mailbox="' + item.id + '" class="button secondary jump-mailbox-button" type="button">Open In Messages</button>' +
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
              '<h3>' + (item.subject || '(No subject)') + '</h3>' +
              '<p>From: ' + item.fromAddr + '</p>' +
              '<p>To: ' + item.toAddr + '</p>' +
              '<p>Status: ' + item.status + ' · ' + item.direction + '</p>' +
              '<p style="margin-top:12px;"><button data-message="' + item.id + '" class="button secondary message-button" type="button">View Message</button></p>' +
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
              '<h3>' + (item.subject || '(No subject)') + '</h3>' +
              '<p>From: ' + item.fromAddr + '</p>' +
              '<p>Received: ' + (item.receivedAt || item.createdAt) + '</p>' +
              '<p style="margin-top:12px;">' +
                '<button data-contact-message="' + item.id + '" class="button secondary contact-message-button" type="button">Inspect</button>' +
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
            '<h3>' + (message.subject || '(No subject)') + '</h3>' +
            '<p><strong>From:</strong> ' + message.fromAddr + '</p>' +
            '<p><strong>To:</strong> ' + message.toAddr + '</p>' +
            '<p><strong>Status:</strong> ' + message.status + '</p>' +
            '<div class="code" style="margin-top:12px;">' + text + '</div>' +
            '<p style="margin-top:12px;"><button data-thread-message="' + message.id + '" class="button secondary contact-thread-button" type="button">Open Thread & Delivery</button></p>' +
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
              '<h3>' + job.id + '</h3>' +
              '<p>Status: ' + job.status + '</p>' +
              '<p>Message: ' + job.messageId + '</p>' +
              '<p>Updated: ' + job.updatedAt + '</p>' +
              '<p>' + (job.lastError || 'No error') + '</p>' +
              '<p style="margin-top:12px;">' + ((job.status === 'failed' || job.status === 'retry')
                ? '<button data-job="' + job.id + '" class="button secondary retry-job" type="button">Retry Job</button>'
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
              '<h3>' + draft.id + '</h3>' +
              '<p>Status: ' + draft.status + '</p>' +
              '<p>Mailbox: ' + draft.mailboxId + '</p>' +
              '<p>Updated: ' + draft.updatedAt + '</p>' +
              '<p style="margin-top:12px;"><button data-draft="' + draft.id + '" class="button secondary draft-button" type="button">Inspect Draft</button></p>' +
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
                '<h3>Draft ' + draft.id + '</h3>' +
                '<p>Status: ' + draft.status + '</p>' +
                '<p>Mailbox: ' + draft.mailboxId + '</p>' +
                '<p>Thread: ' + (draft.threadId || 'n/a') + '</p>' +
                '<p>Updated: ' + draft.updatedAt + '</p>' +
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
          '<li>' + (item.filename || item.id) + ' · ' + item.sizeBytes + ' bytes</li>'
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
        replyHint.innerHTML = 'Reply ready for <strong>' + message.fromAddr + '</strong>. <button id="use-reply" class="button secondary" type="button">Use Reply Draft</button>';

        messageDetail.innerHTML =
          '<div class="faq-item">' +
            '<h3>' + (message.subject || '(No subject)') + '</h3>' +
            '<p><strong>From:</strong> ' + message.fromAddr + '</p>' +
            '<p><strong>To:</strong> ' + message.toAddr + '</p>' +
            '<p><strong>Status:</strong> ' + message.status + '</p>' +
            '<p><strong>Received:</strong> ' + (message.receivedAt || message.createdAt) + '</p>' +
            '<div class="code" style="margin-top:12px;">' + (text || html || 'No content extracted.') + '</div>' +
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
                  '<h3>' + (item.subject || '(No subject)') + '</h3>' +
                  '<p>' + item.direction + ' · ' + item.status + '</p>' +
                  '<p>From: ' + item.fromAddr + '</p>' +
                  '<p>To: ' + item.toAddr + '</p>' +
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
                '<h3>' + event.eventType + '</h3>' +
                '<p>Provider message id: ' + (event.providerMessageId || 'n/a') + '</p>' +
                '<p>Created: ' + event.createdAt + '</p>' +
              '</div>'
            ).join('')
          : 'No delivery events recorded for this message yet.';

        if (message.direction === 'outbound') {
          const job = await api('/admin/api/outbound-jobs?limit=50');
          const match = (job.items || []).find((item) => item.messageId === message.id);
          outboxDetail.innerHTML = match
            ? '<div class="faq-item">' +
                '<h3>Outbound job ' + match.id + '</h3>' +
                '<p>Status: ' + match.status + '</p>' +
                '<p>Retry count: ' + match.retryCount + '</p>' +
                '<p>Next retry: ' + (match.nextRetryAt || 'n/a') + '</p>' +
                '<p>Last error: ' + (match.lastError || 'none') + '</p>' +
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
