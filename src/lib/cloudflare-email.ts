import { json } from "./http";
import type { Env } from "../types";

interface CloudflareEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result: T;
}

export interface EmailRoutingRule {
  id: string;
  name?: string;
  enabled: boolean;
  priority: number;
  matchers: Array<{
    type: "all" | "literal";
    field?: "to";
    value?: string;
  }>;
  actions: Array<{
    type: "drop" | "forward" | "worker";
    value?: string[];
  }>;
}

export function requireCloudflareEmailConfig(env: Env): Response | null {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ZONE_ID || !env.CLOUDFLARE_EMAIL_DOMAIN) {
    return json({ error: "Cloudflare email routing admin is not configured" }, { status: 500 });
  }

  return null;
}

export async function listEmailRoutingRules(env: Env): Promise<EmailRoutingRule[]> {
  return await callCloudflare<EmailRoutingRule[]>(env, `/zones/${env.CLOUDFLARE_ZONE_ID}/email/routing/rules`);
}

export async function upsertForwardingRule(
  env: Env,
  alias: string,
  destination: string,
  existingRuleId?: string
): Promise<EmailRoutingRule> {
  const body = {
    name: `${alias} forwarding`,
    enabled: true,
    priority: 0,
    matchers: [
      {
        type: "literal",
        field: "to",
        value: `${alias}@${env.CLOUDFLARE_EMAIL_DOMAIN}`,
      },
    ],
    actions: [
      {
        type: "forward",
        value: [destination],
      },
    ],
  };

  if (existingRuleId) {
    return await callCloudflare<EmailRoutingRule>(
      env,
      `/zones/${env.CLOUDFLARE_ZONE_ID}/email/routing/rules/${existingRuleId}`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      }
    );
  }

  return await callCloudflare<EmailRoutingRule>(
    env,
    `/zones/${env.CLOUDFLARE_ZONE_ID}/email/routing/rules`,
    {
      method: "POST",
      body: JSON.stringify(body),
    }
  );
}

export async function upsertWorkerRule(
  env: Env,
  alias: string,
  workerName: string,
  existingRuleId?: string
): Promise<EmailRoutingRule> {
  const body = {
    name: `${alias} inbox`,
    enabled: true,
    priority: 0,
    matchers: [
      {
        type: "literal",
        field: "to",
        value: `${alias}@${env.CLOUDFLARE_EMAIL_DOMAIN}`,
      },
    ],
    actions: [
      {
        type: "worker",
        value: [workerName],
      },
    ],
  };

  if (existingRuleId) {
    return await callCloudflare<EmailRoutingRule>(
      env,
      `/zones/${env.CLOUDFLARE_ZONE_ID}/email/routing/rules/${existingRuleId}`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      }
    );
  }

  return await callCloudflare<EmailRoutingRule>(
    env,
    `/zones/${env.CLOUDFLARE_ZONE_ID}/email/routing/rules`,
    {
      method: "POST",
      body: JSON.stringify(body),
    }
  );
}

export async function upsertCatchAllWorkerRule(
  env: Env,
  workerName: string
): Promise<EmailRoutingRule> {
  const body = {
    enabled: true,
    matchers: [
      {
        type: "all",
      },
    ],
    actions: [
      {
        type: "worker",
        value: [workerName],
      },
    ],
  };

  return await callCloudflare<EmailRoutingRule>(
    env,
    `/zones/${env.CLOUDFLARE_ZONE_ID}/email/routing/rules/catch_all`,
    {
      method: "PUT",
      body: JSON.stringify(body),
    }
  );
}

export function isCatchAllWorkerRule(rule: EmailRoutingRule, workerName?: string): boolean {
  const hasAllMatcher = rule.matchers.some((matcher) => matcher.type === "all");
  const workerAction = rule.actions.find((action) => action.type === "worker");
  if (!hasAllMatcher || !workerAction) {
    return false;
  }

  if (!workerName) {
    return true;
  }

  return workerAction.value?.includes(workerName) ?? false;
}

export async function deleteEmailRoutingRule(env: Env, ruleId: string): Promise<void> {
  await callCloudflare<EmailRoutingRule>(
    env,
    `/zones/${env.CLOUDFLARE_ZONE_ID}/email/routing/rules/${ruleId}`,
    {
      method: "DELETE",
    }
  );
}

async function callCloudflare<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const payload = await response.json<CloudflareEnvelope<T>>();
  if (!response.ok || !payload.success) {
    const message = payload.errors?.map((error) => error.message).join("; ") || "Cloudflare API request failed";
    throw new Error(message);
  }

  return payload.result;
}
