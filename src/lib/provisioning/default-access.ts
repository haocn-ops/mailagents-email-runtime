import { mintAccessToken } from "../auth";
import type { Env } from "../../types";

export const SELF_SERVE_DEFAULT_SCOPES = [
  "task:read",
  "mail:read",
  "draft:create",
  "draft:read",
  "draft:send",
] as const;

export async function issueSelfServeAccessToken(input: {
  env: Env;
  tenantId: string;
  agentId: string;
  mailboxId: string;
}): Promise<{
  accessToken?: string;
  accessTokenExpiresAt?: string;
  accessTokenScopes: string[];
}> {
  const accessTokenScopes = [...SELF_SERVE_DEFAULT_SCOPES];
  if (!input.env.API_SIGNING_SECRET) {
    return {
      accessTokenScopes,
    };
  }

  const ttlSeconds = parsePositiveInteger(input.env.SELF_SERVE_ACCESS_TOKEN_TTL_SECONDS) ?? 60 * 60 * 24 * 30;
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const accessToken = await mintAccessToken(input.env.API_SIGNING_SECRET, {
    sub: `self-serve:${input.mailboxId}`,
    tenantId: input.tenantId,
    agentId: input.agentId,
    scopes: accessTokenScopes,
    mailboxIds: [input.mailboxId],
    exp,
  });

  return {
    accessToken,
    accessTokenExpiresAt: new Date(exp * 1000).toISOString(),
    accessTokenScopes,
  };
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}
