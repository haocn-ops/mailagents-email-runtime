import { mintAccessToken } from "../auth";
import {
  getAgent,
  getMailboxById,
  hasActiveMailboxBinding,
  hasActiveMailboxDeployment,
} from "../../repositories/agents";
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

  const agent = await getAgent(input.env, input.agentId);
  if (!agent) {
    throw new Error("Agent not found for self-serve access token");
  }
  if (agent.tenantId !== input.tenantId) {
    throw new Error("Agent does not belong to tenant for self-serve access token");
  }

  const mailbox = await getMailboxById(input.env, input.mailboxId);
  if (!mailbox) {
    throw new Error("Mailbox not found for self-serve access token");
  }
  if (mailbox.tenant_id !== input.tenantId) {
    throw new Error("Mailbox does not belong to tenant for self-serve access token");
  }

  const hasBinding = await hasActiveMailboxBinding(input.env, {
    agentId: input.agentId,
    mailboxId: input.mailboxId,
  });
  if (!hasBinding) {
    const hasDeployment = await hasActiveMailboxDeployment(input.env, {
      agentId: input.agentId,
      mailboxId: input.mailboxId,
    });
    if (!hasDeployment) {
      throw new Error("Agent is not active for mailbox for self-serve access token");
    }
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
