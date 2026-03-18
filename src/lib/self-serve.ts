import {
  listEmailRoutingRules,
  requireCloudflareEmailConfig,
  upsertWorkerRule,
} from "./cloudflare-email";
import { createId } from "./ids";
import {
  bindMailbox,
  createAgent,
  createAgentDeployment,
  createAgentVersion,
  ensureMailbox,
  getMailboxByAddress,
  updateAgent,
  upsertAgentPolicy,
} from "../repositories/agents";
import { createDraft, enqueueDraftSend } from "../repositories/mail";
import type { Env } from "../types";

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
  productName: string;
  operatorEmail: string;
  mailboxAddress: string;
  mailboxId: string;
  agentId: string;
  agentVersionId: string;
  deploymentId: string;
  outboundJobId?: string;
  welcomeStatus: "queued" | "failed";
  welcomeError?: string;
}

export const RESERVED_SELF_SERVE_ALIASES = new Set([
  "admin",
  "api",
  "dmarc",
  "hello",
  "privacy",
  "security",
  "support",
  "www",
]);

export async function parseSelfServeSignup(request: Request): Promise<
  | { ok: true; values: SignupFormValues }
  | { ok: false; values: Partial<SignupFormValues>; error: string }
> {
  const contentType = request.headers.get("content-type") ?? "";
  let values: Partial<SignupFormValues>;

  if (contentType.includes("application/json")) {
    const body = await request.json<Record<string, unknown>>();
    values = {
      mailboxAlias: String(body.mailboxAlias ?? "").trim().toLowerCase(),
      agentName: String(body.agentName ?? "").trim(),
      operatorEmail: String(body.operatorEmail ?? "").trim().toLowerCase(),
      productName: String(body.productName ?? "").trim(),
      useCase: String(body.useCase ?? "").trim(),
    };
  } else {
    const formData = await request.formData();
    values = {
      mailboxAlias: String(formData.get("mailboxAlias") ?? "").trim().toLowerCase(),
      agentName: String(formData.get("agentName") ?? "").trim(),
      operatorEmail: String(formData.get("operatorEmail") ?? "").trim().toLowerCase(),
      productName: String(formData.get("productName") ?? "").trim(),
      useCase: String(formData.get("useCase") ?? "").trim(),
    };
  }

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
  const configError = requireCloudflareEmailConfig(env);
  if (configError) {
    throw new Error("Self-serve signup is not configured on this environment yet. Please use the contact address instead.");
  }

  if (!env.CLOUDFLARE_EMAIL_WORKER) {
    throw new Error("Mailbox provisioning is not configured yet. Please use the contact address instead.");
  }

  const domain = env.CLOUDFLARE_EMAIL_DOMAIN ?? "mailagents.net";
  const alias = normalizeAlias(values.mailboxAlias);

  if (RESERVED_SELF_SERVE_ALIASES.has(alias)) {
    throw new Error(`The mailbox alias "${alias}" is reserved. Please choose a different alias.`);
  }

  const address = `${alias}@${domain}`;
  const existing = await getMailboxByAddress(env, address);
  if (existing) {
    throw new Error(`The mailbox ${address} is already taken. Please choose a different alias.`);
  }

  const tenantId = createId("tnt");
  const mailbox = await ensureMailbox(env, {
    tenantId,
    address,
    status: "active",
  });

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

  await upsertAgentPolicy(env, {
    agentId: agent.id,
    autoReplyEnabled: false,
    humanReviewRequired: true,
    confidenceThreshold: 0.85,
    maxAutoRepliesPerThread: 1,
    allowedRecipientDomains: [],
    blockedSenderDomains: [],
    allowedTools: ["reply_email", "mark_task_done"],
  });

  const rules = await listEmailRoutingRules(env);
  const existingRule = rules.find((entry) =>
    entry.matchers.some((matcher) => matcher.type === "literal" && matcher.field === "to" && matcher.value === address)
  );
  await upsertWorkerRule(env, alias, env.CLOUDFLARE_EMAIL_WORKER, existingRule?.id);

  let outboundJobId: string | undefined;
  let welcomeStatus: SignupSuccessResult["welcomeStatus"] = "queued";
  let welcomeError: string | undefined;

  try {
    const draft = await createDraft(env, {
      tenantId,
      agentId: agent.id,
      mailboxId: mailbox.id,
      payload: {
        from: address,
        to: [values.operatorEmail],
        subject: `Your Mailagents mailbox ${address} is ready`,
        text: buildWelcomeText({
          mailboxAddress: address,
          productName: values.productName,
          agentName: values.agentName,
        }),
        html: buildWelcomeHtml({
          mailboxAddress: address,
          productName: values.productName,
          agentName: values.agentName,
        }),
        attachments: [],
      },
    });

    const sendResult = await enqueueDraftSend(env, draft.id);
    outboundJobId = sendResult.outboundJobId;
  } catch (error) {
    welcomeStatus = "failed";
    welcomeError = error instanceof Error ? error.message : "Unable to queue onboarding email";
  }

  return {
    productName: values.productName,
    operatorEmail: values.operatorEmail,
    mailboxAddress: address,
    mailboxId: mailbox.id,
    agentId: agent.id,
    agentVersionId: version.id,
    deploymentId: deployment.id,
    outboundJobId,
    welcomeStatus,
    welcomeError,
  };
}

export function normalizeAlias(alias: string): string {
  return alias.trim().toLowerCase();
}

export function buildAgentDescription(values: SignupFormValues): string {
  return `${values.productName}: ${values.useCase}`;
}

export function buildWelcomeText(input: {
  mailboxAddress: string;
  productName: string;
  agentName: string;
}): string {
  return [
    "Your Mailagents mailbox is ready.",
    "",
    `Product: ${input.productName}`,
    `Agent: ${input.agentName}`,
    `Mailbox: ${input.mailboxAddress}`,
    "",
    "You can now use this mailbox for inbound email, transactional replies, and managed agent workflows.",
    "Runtime metadata: https://api.mailagents.net/v2/meta/runtime",
    "Agent guide: https://github.com/haocn-ops/mailagents-email-runtime/blob/main/docs/llms-agent-guide.md",
  ].join("\n");
}

export function buildWelcomeHtml(input: {
  mailboxAddress: string;
  productName: string;
  agentName: string;
}): string {
  return `<p>Your Mailagents mailbox is ready.</p>
  <p><strong>Product:</strong> ${escapeHtml(input.productName)}<br />
  <strong>Agent:</strong> ${escapeHtml(input.agentName)}<br />
  <strong>Mailbox:</strong> ${escapeHtml(input.mailboxAddress)}</p>
  <p>You can now use this mailbox for inbound email, transactional replies, and managed agent workflows.</p>
  <p><a href="https://api.mailagents.net/v2/meta/runtime">Runtime metadata</a><br />
  <a href="https://github.com/haocn-ops/mailagents-email-runtime/blob/main/docs/llms-agent-guide.md">AI agent guide</a></p>`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
