import { execute, firstRow, requireRow } from "../lib/db";
import { nowIso } from "../lib/time";
import type { DidBindingRecord, DidBindingStatus, Env } from "../types";

interface DidBindingRow {
  tenant_id: string;
  did: string;
  method: string;
  document_url: string | null;
  status: DidBindingStatus;
  verification_method_id: string | null;
  service_json: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

function parseServiceJson(value: string | null): Array<Record<string, unknown>> {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)
    );
  } catch {
    return [];
  }
}

function mapDidBindingRow(row: DidBindingRow): DidBindingRecord {
  return {
    tenantId: row.tenant_id,
    did: row.did,
    method: row.method,
    documentUrl: row.document_url ?? undefined,
    status: row.status,
    verificationMethodId: row.verification_method_id ?? undefined,
    service: parseServiceJson(row.service_json),
    verifiedAt: row.verified_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getTenantDidBinding(env: Env, tenantId: string): Promise<DidBindingRecord | null> {
  const row = await firstRow<DidBindingRow>(
    env.D1_DB.prepare(
      `SELECT tenant_id, did, method, document_url, status, verification_method_id,
              service_json, verified_at, created_at, updated_at
       FROM tenant_did_bindings
       WHERE tenant_id = ?`
    ).bind(tenantId)
  );

  return row ? mapDidBindingRow(row) : null;
}

export async function upsertTenantDidBinding(env: Env, input: {
  tenantId: string;
  did: string;
  method: string;
  status: DidBindingStatus;
  documentUrl?: string;
  verificationMethodId?: string;
  service?: Array<Record<string, unknown>>;
  verifiedAt?: string;
}): Promise<DidBindingRecord> {
  const existing = await getTenantDidBinding(env, input.tenantId);
  const timestamp = nowIso();
  await execute(env.D1_DB.prepare(
    `INSERT INTO tenant_did_bindings (
       tenant_id, did, method, document_url, status, verification_method_id,
       service_json, verified_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       did = excluded.did,
       method = excluded.method,
       document_url = excluded.document_url,
       status = excluded.status,
       verification_method_id = excluded.verification_method_id,
       service_json = excluded.service_json,
       verified_at = excluded.verified_at,
       created_at = tenant_did_bindings.created_at,
       updated_at = excluded.updated_at`
  ).bind(
    input.tenantId,
    input.did,
    input.method,
    input.documentUrl ?? null,
    input.status,
    input.verificationMethodId ?? null,
    input.service?.length ? JSON.stringify(input.service) : null,
    input.verifiedAt ?? null,
    existing?.createdAt ?? timestamp,
    timestamp,
  ));

  const row = await firstRow<DidBindingRow>(
    env.D1_DB.prepare(
      `SELECT tenant_id, did, method, document_url, status, verification_method_id,
              service_json, verified_at, created_at, updated_at
       FROM tenant_did_bindings
       WHERE tenant_id = ?`
    ).bind(input.tenantId)
  );

  return mapDidBindingRow(requireRow(row, "Failed to load DID binding"));
}
