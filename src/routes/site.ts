import { Router } from "../lib/router";
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
      padding: 20px;
      border-radius: var(--radius-lg);
      background: rgba(255, 255, 255, 0.46);
      border: 1px solid rgba(28, 25, 22, 0.08);
    }
    .faq-item h3 {
      margin: 0 0 10px;
      font-size: 18px;
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
