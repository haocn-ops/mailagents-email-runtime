import { deleteEmailRoutingRule, listEmailRoutingRules, upsertWorkerRule } from "./cloudflare-email";
import { ensureMailbox, getMailboxByAddress, MailboxConflictError } from "../repositories/agents";
import type { Env } from "../types";

export const CONTACT_ALIAS_LOCALPARTS = ["hello", "security", "privacy", "dmarc"] as const;
export const CONTACT_ALIAS_TENANT_ID = "t_demo";
const PRESERVED_EXPLICIT_ALIAS_LOCALPARTS = new Set<string>([...CONTACT_ALIAS_LOCALPARTS, "support"]);

function parseEnabledFlag(value: string | undefined, fallback = false): boolean {
  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function shouldBootstrapContactAliasRouting(env: Env): boolean {
  return parseEnabledFlag(env.CONTACT_ALIAS_ROUTING_BOOTSTRAP_ENABLED, false);
}

export function getContactAliasAddress(env: Env, alias: string): string {
  return `${alias}@${env.CLOUDFLARE_EMAIL_DOMAIN}`.toLowerCase();
}

export function isManagedContactAliasAddress(env: Env, address: string): boolean {
  const normalizedAddress = address.trim().toLowerCase();
  return CONTACT_ALIAS_LOCALPARTS.some((alias) => normalizedAddress === getContactAliasAddress(env, alias));
}

export async function ensureManagedContactAliasMailbox(env: Env, address: string) {
  try {
    return await ensureMailbox(env, {
      tenantId: CONTACT_ALIAS_TENANT_ID,
      address,
    });
  } catch (error) {
    if (!(error instanceof MailboxConflictError)) {
      throw error;
    }

    const existing = await getMailboxByAddress(env, address);
    if (!existing) {
      throw error;
    }

    return {
      id: existing.id,
      tenantId: existing.tenant_id,
      address: existing.address,
      status: existing.status,
      createdAt: existing.created_at,
    };
  }
}

export async function ensureManagedContactAliasMailboxes(env: Env): Promise<void> {
  if (!env.CLOUDFLARE_EMAIL_DOMAIN) {
    return;
  }

  for (const alias of CONTACT_ALIAS_LOCALPARTS) {
    await ensureManagedContactAliasMailbox(env, getContactAliasAddress(env, alias));
  }
}

function isWorkerRuleForAlias(env: Env, alias: string, rule: Awaited<ReturnType<typeof listEmailRoutingRules>>[number]): boolean {
  const expectedAddress = getContactAliasAddress(env, alias);
  const workerAction = rule.actions.find((action) => action.type === "worker");
  return rule.matchers.some((matcher) => matcher.type === "literal" && matcher.field === "to" && matcher.value === expectedAddress)
    && Boolean(workerAction?.value?.includes(env.CLOUDFLARE_EMAIL_WORKER ?? ""));
}

export async function ensureManagedContactAliasRouting(env: Env): Promise<void> {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ZONE_ID || !env.CLOUDFLARE_EMAIL_DOMAIN || !env.CLOUDFLARE_EMAIL_WORKER) {
    return;
  }

  const rules = await listEmailRoutingRules(env);

  for (const alias of CONTACT_ALIAS_LOCALPARTS) {
    const existing = rules.find((rule) =>
      rule.matchers.some((matcher) =>
        matcher.type === "literal"
        && matcher.field === "to"
        && matcher.value === getContactAliasAddress(env, alias)
      )
    );

    if (!existing || !isWorkerRuleForAlias(env, alias, existing)) {
      await upsertWorkerRule(env, alias, env.CLOUDFLARE_EMAIL_WORKER, existing?.id);
    }
  }
}

export async function cleanupRedundantMailboxWorkerRules(env: Env): Promise<void> {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ZONE_ID || !env.CLOUDFLARE_EMAIL_DOMAIN || !env.CLOUDFLARE_EMAIL_WORKER) {
    return;
  }

  const rules = await listEmailRoutingRules(env);
  const domain = `@${env.CLOUDFLARE_EMAIL_DOMAIN}`.toLowerCase();

  for (const rule of rules) {
    const matcher = rule.matchers.find((entry) => entry.type === "literal" && entry.field === "to" && typeof entry.value === "string");
    const workerAction = rule.actions.find((action) => action.type === "worker");
    const address = matcher?.value?.toLowerCase();

    if (!address || !address.endsWith(domain)) {
      continue;
    }

    if (!(workerAction?.value?.includes(env.CLOUDFLARE_EMAIL_WORKER))) {
      continue;
    }

    const localpart = address.slice(0, -domain.length);
    if (PRESERVED_EXPLICIT_ALIAS_LOCALPARTS.has(localpart)) {
      continue;
    }

    await deleteEmailRoutingRule(env, rule.id);
  }
}
