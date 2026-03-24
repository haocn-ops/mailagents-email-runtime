import { badRequest, json } from "./http";
import type { AccessTokenClaims, Env } from "../types";

const PROTECTED_PUBLIC_HOSTS = new Set(["mailagents.net"]);

function parseEnabledFlag(value: string | undefined, fallback = false): boolean {
  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function isProtectedPublicHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return PROTECTED_PUBLIC_HOSTS.has(normalized) || normalized.endsWith(".mailagents.net");
}

function allowFlagOnRequest(request: Request, enabledFlag: string | undefined, publicHostOverrideFlag: string | undefined): boolean {
  if (!parseEnabledFlag(enabledFlag, false)) {
    return false;
  }

  const hostname = new URL(request.url).hostname;
  if (!isProtectedPublicHostname(hostname)) {
    return true;
  }

  return parseEnabledFlag(publicHostOverrideFlag, false);
}

function toBase64Url(input: Uint8Array): string {
  let binary = "";
  for (const byte of input) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signPayload(secret: string, payload: string): Promise<string> {
  const key = await importSigningKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return toBase64Url(new Uint8Array(signature));
}

async function verifySignature(secret: string, payload: string, signature: string): Promise<boolean> {
  const key = await importSigningKey(secret);
  return await crypto.subtle.verify(
    "HMAC",
    key,
    fromBase64Url(signature),
    new TextEncoder().encode(payload)
  );
}

export async function mintAccessToken(secret: string, claims: AccessTokenClaims): Promise<string> {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await signPayload(secret, payload);
  return `${payload}.${signature}`;
}

export async function verifyAccessToken(secret: string, token: string): Promise<AccessTokenClaims | null> {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    return null;
  }

  const valid = await verifySignature(secret, payload, signature);
  if (!valid) {
    return null;
  }

  try {
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as AccessTokenClaims;
    if (!claims.tenantId || !Array.isArray(claims.scopes) || typeof claims.exp !== "number") {
      return null;
    }

    if (claims.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return claims;
  } catch {
    return null;
  }
}

export async function requireAuth(request: Request, env: Env, requiredScopes: string[]): Promise<AccessTokenClaims | Response> {
  if (!env.API_SIGNING_SECRET) {
    return json({ error: "API_SIGNING_SECRET is not configured" }, { status: 500 });
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return json({ error: "Missing bearer token" }, { status: 401 });
  }

  const token = authorization.slice("Bearer ".length);
  const claims = await verifyAccessToken(env.API_SIGNING_SECRET, token);
  if (!claims) {
    return json({ error: "Invalid bearer token" }, { status: 401 });
  }

  const missing = requiredScopes.filter((scope) => !claims.scopes.includes(scope));
  if (missing.length > 0) {
    return json({ error: `Missing scopes: ${missing.join(", ")}` }, { status: 403 });
  }

  return claims;
}

export function enforceTenantAccess(claims: AccessTokenClaims, tenantId: string): Response | null {
  if (claims.tenantId !== tenantId) {
    return json({ error: "Tenant access denied" }, { status: 403 });
  }

  return null;
}

export function enforceAgentAccess(claims: AccessTokenClaims, agentId: string): Response | null {
  if (claims.agentId && claims.agentId !== agentId) {
    return json({ error: "Agent access denied" }, { status: 403 });
  }

  return null;
}

export function enforceMailboxAccess(claims: AccessTokenClaims, mailboxId: string): Response | null {
  if (claims.mailboxIds?.length && !claims.mailboxIds.includes(mailboxId)) {
    return json({ error: "Mailbox access denied" }, { status: 403 });
  }

  return null;
}

export function requireAdminSecret(request: Request, env: Env): Response | null {
  if (!env.ADMIN_API_SECRET) {
    return json({ error: "ADMIN_API_SECRET is not configured" }, { status: 500 });
  }

  const provided = request.headers.get("x-admin-secret");
  if (provided !== env.ADMIN_API_SECRET) {
    return json({ error: "Invalid admin secret" }, { status: 401 });
  }

  return null;
}

export function areAdminRoutesEnabled(request: Request, env: Env): boolean {
  return allowFlagOnRequest(request, env.ADMIN_ROUTES_ENABLED, env.ADMIN_ROUTES_ALLOW_PUBLIC_HOSTS);
}

export function areDebugRoutesEnabled(request: Request, env: Env): boolean {
  return allowFlagOnRequest(request, env.DEBUG_ROUTES_ENABLED, env.DEBUG_ROUTES_ALLOW_PUBLIC_HOSTS);
}

export function requireAdminRoutesEnabled(request: Request, env: Env): Response | null {
  if (!areAdminRoutesEnabled(request, env)) {
    return json({ error: "Admin routes are disabled" }, { status: 404 });
  }

  return null;
}

export function requireDebugRoutesEnabled(request: Request, env: Env): Response | null {
  if (!areDebugRoutesEnabled(request, env)) {
    return json({ error: "Debug routes are disabled" }, { status: 404 });
  }

  return null;
}
