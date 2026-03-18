import { ensureMailbox } from "../repositories/agents";
import type { Env } from "../types";

export const CONTACT_ALIAS_LOCALPARTS = ["hello", "security", "privacy", "dmarc"] as const;
export const CONTACT_ALIAS_TENANT_ID = "t_demo";

export function getContactAliasAddress(env: Env, alias: string): string {
  return `${alias}@${env.CLOUDFLARE_EMAIL_DOMAIN}`.toLowerCase();
}

export function isManagedContactAliasAddress(env: Env, address: string): boolean {
  const normalizedAddress = address.trim().toLowerCase();
  return CONTACT_ALIAS_LOCALPARTS.some((alias) => normalizedAddress === getContactAliasAddress(env, alias));
}

export async function ensureManagedContactAliasMailbox(env: Env, address: string) {
  return await ensureMailbox(env, {
    tenantId: CONTACT_ALIAS_TENANT_ID,
    address,
  });
}

export async function ensureManagedContactAliasMailboxes(env: Env): Promise<void> {
  if (!env.CLOUDFLARE_EMAIL_DOMAIN) {
    return;
  }

  for (const alias of CONTACT_ALIAS_LOCALPARTS) {
    await ensureManagedContactAliasMailbox(env, getContactAliasAddress(env, alias));
  }
}
