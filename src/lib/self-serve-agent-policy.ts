import {
  getAgentPolicy,
  listAgents,
  upsertAgentPolicy,
} from "../repositories/agents";
import type {
  AgentPolicyRecord,
  Env,
} from "../types";

export const DEFAULT_SELF_SERVE_AGENT_ALLOWED_TOOLS = [
  "reply_email",
  "mark_task_done",
] as const;

export const DEFAULT_SELF_SERVE_AGENT_CONFIDENCE_THRESHOLD = 0.85;
export const DEFAULT_SELF_SERVE_AGENT_MAX_AUTO_REPLIES_PER_THREAD = 1;

function normalizeDomainList(items: string[]): string[] {
  return Array.from(new Set(
    items
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  )).sort();
}

function normalizeStringList(items: string[]): string[] {
  return Array.from(new Set(
    items
      .map((item) => item.trim())
      .filter(Boolean),
  )).sort();
}

function equalStringLists(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((item, index) => item === right[index]);
}

export function buildDefaultSelfServeAgentPolicy(input: {
  agentId: string;
  internalDomainAllowlist: string[];
}): Omit<AgentPolicyRecord, "updatedAt"> {
  return {
    agentId: input.agentId,
    autoReplyEnabled: false,
    humanReviewRequired: true,
    confidenceThreshold: DEFAULT_SELF_SERVE_AGENT_CONFIDENCE_THRESHOLD,
    maxAutoRepliesPerThread: DEFAULT_SELF_SERVE_AGENT_MAX_AUTO_REPLIES_PER_THREAD,
    allowedRecipientDomains: normalizeDomainList(input.internalDomainAllowlist),
    blockedSenderDomains: [],
    allowedTools: [...DEFAULT_SELF_SERVE_AGENT_ALLOWED_TOOLS],
  };
}

export function isDefaultSelfServeInternalOnlyAgentPolicy(
  policy: AgentPolicyRecord,
  internalDomainAllowlist: string[],
): boolean {
  return (
    policy.autoReplyEnabled === false &&
    policy.humanReviewRequired === true &&
    policy.confidenceThreshold === DEFAULT_SELF_SERVE_AGENT_CONFIDENCE_THRESHOLD &&
    policy.maxAutoRepliesPerThread === DEFAULT_SELF_SERVE_AGENT_MAX_AUTO_REPLIES_PER_THREAD &&
    equalStringLists(
      normalizeDomainList(policy.allowedRecipientDomains),
      normalizeDomainList(internalDomainAllowlist),
    ) &&
    equalStringLists(normalizeStringList(policy.blockedSenderDomains), []) &&
    equalStringLists(
      normalizeStringList(policy.allowedTools),
      normalizeStringList([...DEFAULT_SELF_SERVE_AGENT_ALLOWED_TOOLS]),
    )
  );
}

export async function relaxTenantDefaultAgentRecipientPoliciesForExternalSend(
  env: Env,
  input: {
    tenantId: string;
    internalDomainAllowlist: string[];
  },
): Promise<{ updatedAgentIds: string[] }> {
  const agents = await listAgents(env, input.tenantId);
  const updatedAgentIds: string[] = [];

  for (const agent of agents) {
    const policy = await getAgentPolicy(env, agent.id);
    if (!policy) {
      continue;
    }

    if (!isDefaultSelfServeInternalOnlyAgentPolicy(policy, input.internalDomainAllowlist)) {
      continue;
    }

    await upsertAgentPolicy(env, {
      agentId: policy.agentId,
      autoReplyEnabled: policy.autoReplyEnabled,
      humanReviewRequired: policy.humanReviewRequired,
      confidenceThreshold: policy.confidenceThreshold,
      maxAutoRepliesPerThread: policy.maxAutoRepliesPerThread,
      allowedRecipientDomains: [],
      blockedSenderDomains: policy.blockedSenderDomains,
      allowedTools: policy.allowedTools,
    });
    updatedAgentIds.push(agent.id);
  }

  return { updatedAgentIds };
}
