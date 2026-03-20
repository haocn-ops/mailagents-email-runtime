import { execute, firstRow, requireRow } from "../lib/db";
import { nowIso } from "../lib/time";
import type { Env, PricingTier, TenantOutboundStatus, TenantSendPolicyRecord } from "../types";

interface TenantSendPolicyRow {
  tenant_id: string;
  pricing_tier: PricingTier;
  outbound_status: TenantOutboundStatus;
  internal_domain_allowlist_json: string;
  external_send_enabled: number;
  review_required: number;
  updated_at: string;
}

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function mapTenantSendPolicyRow(row: TenantSendPolicyRow): TenantSendPolicyRecord {
  return {
    tenantId: row.tenant_id,
    pricingTier: row.pricing_tier,
    outboundStatus: row.outbound_status,
    internalDomainAllowlist: parseJsonArray(row.internal_domain_allowlist_json),
    externalSendEnabled: Boolean(row.external_send_enabled),
    reviewRequired: Boolean(row.review_required),
    updatedAt: row.updated_at,
  };
}

export async function getTenantSendPolicy(env: Env, tenantId: string): Promise<TenantSendPolicyRecord | null> {
  const row = await firstRow<TenantSendPolicyRow>(
    env.D1_DB.prepare(
      `SELECT tenant_id, pricing_tier, outbound_status, internal_domain_allowlist_json,
              external_send_enabled, review_required, updated_at
       FROM tenant_send_policies
       WHERE tenant_id = ?`
    ).bind(tenantId)
  );

  return row ? mapTenantSendPolicyRow(row) : null;
}

export async function ensureTenantSendPolicy(env: Env, tenantId: string): Promise<TenantSendPolicyRecord> {
  const existing = await getTenantSendPolicy(env, tenantId);
  if (existing) {
    return existing;
  }

  const updatedAt = nowIso();
  await execute(env.D1_DB.prepare(
    `INSERT OR IGNORE INTO tenant_send_policies (
       tenant_id, pricing_tier, outbound_status, internal_domain_allowlist_json,
       external_send_enabled, review_required, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    tenantId,
    "free",
    "internal_only",
    JSON.stringify(["mailagents.net"]),
    0,
    1,
    updatedAt,
  ));

  return requireRow(await getTenantSendPolicy(env, tenantId), "Failed to create tenant send policy");
}

export async function upsertTenantSendPolicy(env: Env, input: {
  tenantId: string;
  pricingTier: PricingTier;
  outboundStatus: TenantOutboundStatus;
  internalDomainAllowlist: string[];
  externalSendEnabled: boolean;
  reviewRequired: boolean;
}): Promise<TenantSendPolicyRecord> {
  const updatedAt = nowIso();
  const internalDomainAllowlist = input.internalDomainAllowlist
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  await execute(env.D1_DB.prepare(
    `INSERT INTO tenant_send_policies (
       tenant_id, pricing_tier, outbound_status, internal_domain_allowlist_json,
       external_send_enabled, review_required, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       pricing_tier = excluded.pricing_tier,
       outbound_status = excluded.outbound_status,
       internal_domain_allowlist_json = excluded.internal_domain_allowlist_json,
       external_send_enabled = excluded.external_send_enabled,
       review_required = excluded.review_required,
       updated_at = excluded.updated_at`
  ).bind(
    input.tenantId,
    input.pricingTier,
    input.outboundStatus,
    JSON.stringify(internalDomainAllowlist),
    Number(input.externalSendEnabled),
    Number(input.reviewRequired),
    updatedAt,
  ));

  return requireRow(await getTenantSendPolicy(env, input.tenantId), "Failed to load tenant send policy");
}
