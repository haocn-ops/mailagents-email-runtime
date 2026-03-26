import {
  mintAccessToken,
  requireAdminRoutesEnabled,
  requireAdminSecret,
} from "../lib/auth";
import {
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponseEnvelope,
  jsonRpcError,
  jsonRpcResult,
  handleMcpTransportGet,
  handleMcpTransportOptions,
  handleMcpTransportPost,
  toToolContent,
} from "../lib/mcp-transport";
import {
  MCP_PROTOCOL_VERSION,
  RUNTIME_SERVER_INFO,
  RUNTIME_TOOL_CATALOG,
  buildRuntimeMetadata,
} from "../lib/runtime-metadata";
import { relaxTenantDefaultAgentRecipientPoliciesForExternalSend } from "../lib/self-serve-agent-policy";
import {
  ADMIN_MCP_AUTH,
  ADMIN_MCP_METHODS,
  ADMIN_MCP_PATH,
  ADMIN_WORKFLOW_PACKS,
  type AdminToolCategory,
} from "../lib/admin-mcp-contract";
import { Router } from "../lib/router";
import {
  getAgent,
  getMailboxByAddress,
  getMailboxById,
  listAgents,
  listMailboxes,
} from "../repositories/agents";
import {
  ensureTenantBillingAccount,
  listTypedTenantPaymentReceipts,
  updateTenantBillingAccountProfile,
} from "../repositories/billing";
import {
  addSuppression,
  getDraft,
  getDraftByR2Key,
  getMessage,
  getOutboundJob,
  getOutboundJobByDraftR2Key,
  getOutboundJobByMessageId,
  getSuppression,
  listDeliveryEventsByMessageId,
} from "../repositories/mail";
import {
  ensureTenantSendPolicy,
  upsertTenantSendPolicy,
} from "../repositories/tenant-policies";
import type {
  Env,
  PricingTier,
  TenantOutboundStatus,
} from "../types";

const ADMIN_MCP_ALLOW_METHODS = "GET, POST, OPTIONS";
const ADMIN_MCP_ALLOW_HEADERS = "accept, content-type, mcp-protocol-version, mcp-session-id, x-admin-secret";
const DEFAULT_MAILBOX_AGENT_SCOPE_PROFILES = {
  read_only: ["mail:read", "task:read"],
  draft_only: ["mail:read", "task:read", "draft:create", "draft:read"],
  send: ["mail:read", "task:read", "draft:create", "draft:read", "draft:send"],
} as const;

interface AdminToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    riskLevel: "read" | "write" | "high_risk" | "privileged";
    sideEffecting: boolean;
    humanReviewRequired: boolean;
    adminOnly: true;
    category: AdminToolCategory;
  };
}

class AdminMcpToolError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const ADMIN_TOOL_DEFINITIONS: AdminToolDescriptor[] = [
  {
    name: "create_access_token",
    description: "Mint a signed bearer token for a tenant, agent, or mailbox-scoped workflow.",
    inputSchema: {
      type: "object",
      required: ["sub", "tenantId", "scopes"],
      properties: {
        sub: { type: "string" },
        tenantId: { type: "string" },
        agentId: { type: "string" },
        scopes: { type: "array", items: { type: "string" }, minItems: 1 },
        mailboxIds: { type: "array", items: { type: "string" } },
        expiresInSeconds: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
    annotations: {
      riskLevel: "privileged",
      sideEffecting: true,
      humanReviewRequired: true,
      adminOnly: true,
      category: "token_admin",
    },
  },
  {
    name: "bootstrap_mailbox_agent_token",
    description: "Mint a standard mailbox-agent bearer token and return the recommended mailbox workflow surface.",
    inputSchema: {
      type: "object",
      required: ["tenantId", "mailboxId"],
      properties: {
        tenantId: { type: "string" },
        mailboxId: { type: "string" },
        agentId: { type: "string" },
        mode: { type: "string", enum: ["read_only", "draft_only", "send"] },
        expiresInSeconds: { type: "integer", minimum: 1 },
        sub: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: {
      riskLevel: "privileged",
      sideEffecting: true,
      humanReviewRequired: true,
      adminOnly: true,
      category: "token_admin",
    },
  },
  {
    name: "list_agents",
    description: "List agents across the runtime, optionally filtered to a tenant.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: {
      riskLevel: "read",
      sideEffecting: false,
      humanReviewRequired: false,
      adminOnly: true,
      category: "registry_admin",
    },
  },
  {
    name: "get_agent",
    description: "Fetch an agent by id without tenant-scoped bearer restrictions.",
    inputSchema: {
      type: "object",
      required: ["agentId"],
      properties: {
        agentId: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: {
      riskLevel: "read",
      sideEffecting: false,
      humanReviewRequired: false,
      adminOnly: true,
      category: "registry_admin",
    },
  },
  {
    name: "list_mailboxes",
    description: "List mailboxes across the runtime, optionally filtered to a tenant.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: {
      riskLevel: "read",
      sideEffecting: false,
      humanReviewRequired: false,
      adminOnly: true,
      category: "registry_admin",
    },
  },
  {
    name: "get_mailbox",
    description: "Fetch a mailbox by id or email address.",
    inputSchema: {
      type: "object",
      properties: {
        mailboxId: { type: "string" },
        address: { type: "string" },
      },
      additionalProperties: false,
      anyOf: [
        { required: ["mailboxId"] },
        { required: ["address"] },
      ],
    },
    annotations: {
      riskLevel: "read",
      sideEffecting: false,
      humanReviewRequired: false,
      adminOnly: true,
      category: "registry_admin",
    },
  },
  {
    name: "get_tenant_send_policy",
    description: "Inspect the effective tenant send policy with admin visibility.",
    inputSchema: {
      type: "object",
      required: ["tenantId"],
      properties: {
        tenantId: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: {
      riskLevel: "read",
      sideEffecting: false,
      humanReviewRequired: false,
      adminOnly: true,
      category: "policy_admin",
    },
  },
  {
    name: "upsert_tenant_send_policy",
    description: "Directly set a tenant send policy, including outbound enablement and review mode.",
    inputSchema: {
      type: "object",
      required: ["tenantId", "pricingTier", "outboundStatus", "externalSendEnabled", "reviewRequired"],
      properties: {
        tenantId: { type: "string" },
        pricingTier: { type: "string", enum: ["free", "paid_review", "paid_active", "enterprise"] },
        outboundStatus: { type: "string", enum: ["internal_only", "external_review", "external_enabled", "suspended"] },
        internalDomainAllowlist: { type: "array", items: { type: "string" } },
        externalSendEnabled: { type: "boolean" },
        reviewRequired: { type: "boolean" },
      },
      additionalProperties: false,
    },
    annotations: {
      riskLevel: "privileged",
      sideEffecting: true,
      humanReviewRequired: true,
      adminOnly: true,
      category: "policy_admin",
    },
  },
  {
    name: "apply_tenant_send_policy_review",
    description: "Apply an operator review decision that updates both tenant send policy and billing profile.",
    inputSchema: {
      type: "object",
      required: ["tenantId", "decision"],
      properties: {
        tenantId: { type: "string" },
        decision: { type: "string", enum: ["approve_external", "reset_review", "suspend_outbound"] },
      },
      additionalProperties: false,
    },
    annotations: {
      riskLevel: "privileged",
      sideEffecting: true,
      humanReviewRequired: true,
      adminOnly: true,
      category: "policy_admin",
    },
  },
  {
    name: "get_tenant_review_context",
    description: "Fetch tenant send policy, billing account, and recent receipts for an operator review decision.",
    inputSchema: {
      type: "object",
      required: ["tenantId"],
      properties: {
        tenantId: { type: "string" },
        receiptsLimit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    annotations: {
      riskLevel: "read",
      sideEffecting: false,
      humanReviewRequired: false,
      adminOnly: true,
      category: "policy_admin",
    },
  },
  {
    name: "get_debug_message",
    description: "Inspect a message plus its outbound delivery events.",
    inputSchema: {
      type: "object",
      required: ["messageId"],
      properties: {
        messageId: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: {
      riskLevel: "read",
      sideEffecting: false,
      humanReviewRequired: false,
      adminOnly: true,
      category: "debug",
    },
  },
  {
    name: "inspect_delivery_case",
    description: "Inspect a correlated delivery case from a message id, draft id, outbound job id, or suppressed email.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string" },
        draftId: { type: "string" },
        outboundJobId: { type: "string" },
        email: { type: "string" },
        includePayload: { type: "boolean" },
      },
      additionalProperties: false,
      oneOf: [
        { required: ["messageId"] },
        { required: ["draftId"] },
        { required: ["outboundJobId"] },
        { required: ["email"] },
      ],
    },
    annotations: {
      riskLevel: "read",
      sideEffecting: false,
      humanReviewRequired: false,
      adminOnly: true,
      category: "debug",
    },
  },
  {
    name: "get_debug_draft",
    description: "Inspect a draft plus the stored R2 payload body.",
    inputSchema: {
      type: "object",
      required: ["draftId"],
      properties: {
        draftId: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: {
      riskLevel: "read",
      sideEffecting: false,
      humanReviewRequired: false,
      adminOnly: true,
      category: "debug",
    },
  },
  {
    name: "get_debug_outbound_job",
    description: "Inspect an outbound job by id.",
    inputSchema: {
      type: "object",
      required: ["outboundJobId"],
      properties: {
        outboundJobId: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: {
      riskLevel: "read",
      sideEffecting: false,
      humanReviewRequired: false,
      adminOnly: true,
      category: "debug",
    },
  },
  {
    name: "get_suppression",
    description: "Inspect whether an email address is suppressed.",
    inputSchema: {
      type: "object",
      required: ["email"],
      properties: {
        email: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: {
      riskLevel: "read",
      sideEffecting: false,
      humanReviewRequired: false,
      adminOnly: true,
      category: "suppression",
    },
  },
  {
    name: "add_suppression",
    description: "Add an email address to the suppression list.",
    inputSchema: {
      type: "object",
      required: ["email"],
      properties: {
        email: { type: "string" },
        reason: { type: "string" },
        source: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: {
      riskLevel: "high_risk",
      sideEffecting: true,
      humanReviewRequired: true,
      adminOnly: true,
      category: "suppression",
    },
  },
];

const router = new Router<Env>();

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdminMcpToolError("invalid_arguments", "params must be an object");
  }

  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AdminMcpToolError("invalid_arguments", `${field} must be a non-empty string`);
  }

  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new AdminMcpToolError("invalid_arguments", `${field} must be a non-empty string array`);
  }

  return value.map((item) => item.trim());
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new AdminMcpToolError("invalid_arguments", `${field} must contain non-empty strings`);
  }

  return value.map((item) => item.trim());
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new AdminMcpToolError("invalid_arguments", `${field} must be a boolean`);
  }

  return value;
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new AdminMcpToolError("invalid_arguments", `${field} must be an integer`);
  }

  return value;
}

function requireTool(name: string): AdminToolDescriptor {
  const tool = ADMIN_TOOL_DEFINITIONS.find((item) => item.name === name);
  if (!tool) {
    throw new AdminMcpToolError("invalid_arguments", "Unknown tool");
  }

  return tool;
}

async function adminJsonRpcError(
  id: JsonRpcId,
  response: Response,
  fallbackMessage: string,
): Promise<JsonRpcResponseEnvelope> {
  const payload = await response.clone().json<{ error?: string }>().catch(() => null);
  const errorCode = response.status === 404
    ? "route_disabled"
    : response.status === 401
      ? "auth_unauthorized"
      : "tool_internal_error";
  return jsonRpcError(id, -32001, fallbackMessage, {
    status: response.status,
    errorCode,
    error: payload?.error ?? fallbackMessage,
  });
}

function buildAdminMcpMetadata() {
  return {
    path: ADMIN_MCP_PATH,
    auth: ADMIN_MCP_AUTH,
    methods: [...ADMIN_MCP_METHODS],
    workflows: ADMIN_WORKFLOW_PACKS,
    toolCount: ADMIN_TOOL_DEFINITIONS.length,
    tools: ADMIN_TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      annotations: tool.annotations,
    })),
  };
}

async function readDraftPayload(env: Env, draftR2Key: string): Promise<unknown | null> {
  const draftObject = await env.R2_EMAIL.get(draftR2Key);
  return draftObject ? await draftObject.json<unknown>() : null;
}

function listMailboxToolsForScopes(scopes: string[]) {
  return RUNTIME_TOOL_CATALOG.filter((tool) => tool.requiredScopes.every((scope) => scopes.includes(scope)));
}

function summarizeTenantReviewActions(input: {
  outboundStatus: TenantOutboundStatus;
  reviewRequired: boolean;
  billingStatus: string;
  hasPendingReceipts: boolean;
}) {
  if (input.outboundStatus === "external_review" || input.reviewRequired) {
    return ["approve_external", "reset_review", "suspend_outbound"];
  }
  if (input.outboundStatus === "suspended" || input.billingStatus === "suspended") {
    return ["reset_review"];
  }
  if (input.hasPendingReceipts) {
    return ["approve_external", "reset_review"];
  }
  return ["reset_review", "suspend_outbound"];
}

async function inspectDeliveryCase(env: Env, input: {
  messageId?: string;
  draftId?: string;
  outboundJobId?: string;
  email?: string;
  includePayload?: boolean;
}) {
  const includePayload = input.includePayload !== false;

  if (input.email) {
    const suppression = await getSuppression(env, input.email.toLowerCase());
    if (!suppression) {
      throw new AdminMcpToolError("resource_suppression_not_found", "Suppression not found");
    }
    return {
      lookup: { type: "email", value: input.email.toLowerCase() },
      suppression,
    };
  }

  if (input.messageId) {
    const message = await getMessage(env, input.messageId);
    if (!message) {
      throw new AdminMcpToolError("resource_message_not_found", "Message not found");
    }
    const outboundJob = await getOutboundJobByMessageId(env, message.id);
    const draft = outboundJob ? await getDraftByR2Key(env, outboundJob.draftR2Key) : null;
    return {
      lookup: { type: "message", value: message.id },
      message,
      deliveryEvents: await listDeliveryEventsByMessageId(env, message.id),
      outboundJob,
      draft,
      draftPayload: includePayload && outboundJob ? await readDraftPayload(env, outboundJob.draftR2Key) : undefined,
      suppression: message.direction === "outbound" ? await getSuppression(env, message.toAddr).catch(() => null) : null,
    };
  }

  if (input.draftId) {
    const draft = await getDraft(env, input.draftId);
    if (!draft) {
      throw new AdminMcpToolError("resource_draft_not_found", "Draft not found");
    }
    const outboundJob = await getOutboundJobByDraftR2Key(env, draft.draftR2Key);
    const message = outboundJob ? await getMessage(env, outboundJob.messageId) : null;
    return {
      lookup: { type: "draft", value: draft.id },
      draft,
      draftPayload: includePayload ? await readDraftPayload(env, draft.draftR2Key) : undefined,
      outboundJob,
      message,
      deliveryEvents: message ? await listDeliveryEventsByMessageId(env, message.id) : [],
      suppression: message?.direction === "outbound" ? await getSuppression(env, message.toAddr).catch(() => null) : null,
    };
  }

  if (input.outboundJobId) {
    const outboundJob = await getOutboundJob(env, input.outboundJobId);
    if (!outboundJob) {
      throw new AdminMcpToolError("resource_outbound_job_not_found", "Outbound job not found");
    }
    const message = await getMessage(env, outboundJob.messageId);
    const draft = await getDraftByR2Key(env, outboundJob.draftR2Key);
    return {
      lookup: { type: "outbound_job", value: outboundJob.id },
      outboundJob,
      message,
      draft,
      draftPayload: includePayload ? await readDraftPayload(env, outboundJob.draftR2Key) : undefined,
      deliveryEvents: message ? await listDeliveryEventsByMessageId(env, message.id) : [],
      suppression: message?.direction === "outbound" ? await getSuppression(env, message.toAddr).catch(() => null) : null,
    };
  }

  throw new AdminMcpToolError("invalid_arguments", "One of messageId, draftId, outboundJobId, or email is required");
}

async function applyTenantSendPolicyReview(env: Env, input: {
  tenantId: string;
  decision: "approve_external" | "reset_review" | "suspend_outbound";
}) {
  const sendPolicy = await ensureTenantSendPolicy(env, input.tenantId);
  const billingAccount = await ensureTenantBillingAccount(env, input.tenantId);

  if (input.decision === "approve_external") {
    const updatedSendPolicy = await upsertTenantSendPolicy(env, {
      tenantId: input.tenantId,
      pricingTier: "paid_active",
      outboundStatus: "external_enabled",
      internalDomainAllowlist: sendPolicy.internalDomainAllowlist,
      externalSendEnabled: true,
      reviewRequired: false,
    });
    const updatedBillingAccount = await updateTenantBillingAccountProfile(env, {
      tenantId: input.tenantId,
      status: billingAccount.status === "trial" ? "active" : undefined,
      pricingTier: "paid_active",
    });
    await relaxTenantDefaultAgentRecipientPoliciesForExternalSend(env, {
      tenantId: input.tenantId,
      internalDomainAllowlist: updatedSendPolicy.internalDomainAllowlist,
    });

    return {
      sendPolicy: updatedSendPolicy,
      account: updatedBillingAccount,
      decision: input.decision,
      message: "External sending approved for tenant.",
    };
  }

  if (input.decision === "reset_review") {
    const updatedSendPolicy = await upsertTenantSendPolicy(env, {
      tenantId: input.tenantId,
      pricingTier: "paid_review",
      outboundStatus: "external_review",
      internalDomainAllowlist: sendPolicy.internalDomainAllowlist,
      externalSendEnabled: false,
      reviewRequired: true,
    });
    const updatedBillingAccount = await updateTenantBillingAccountProfile(env, {
      tenantId: input.tenantId,
      status: billingAccount.status === "suspended" ? "active" : undefined,
      pricingTier: "paid_review",
    });

    return {
      sendPolicy: updatedSendPolicy,
      account: updatedBillingAccount,
      decision: input.decision,
      message: "Tenant returned to paid review.",
    };
  }

  const updatedSendPolicy = await upsertTenantSendPolicy(env, {
    tenantId: input.tenantId,
    pricingTier: sendPolicy.pricingTier,
    outboundStatus: "suspended",
    internalDomainAllowlist: sendPolicy.internalDomainAllowlist,
    externalSendEnabled: false,
    reviewRequired: true,
  });
  const updatedBillingAccount = await updateTenantBillingAccountProfile(env, {
    tenantId: input.tenantId,
    status: "suspended",
  });

  return {
    sendPolicy: updatedSendPolicy,
    account: updatedBillingAccount,
    decision: input.decision,
    message: "Outbound sending suspended for tenant.",
  };
}

async function callAdminTool(env: Env, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  requireTool(toolName);

  if (toolName === "create_access_token") {
    if (!env.API_SIGNING_SECRET) {
      throw new AdminMcpToolError("tool_internal_error", "API_SIGNING_SECRET is not configured");
    }

    const sub = requireString(args.sub, "sub");
    const tenantId = requireString(args.tenantId, "tenantId");
    const scopes = requireStringArray(args.scopes, "scopes");
    const exp = Math.floor(Date.now() / 1000) + (optionalInteger(args.expiresInSeconds, "expiresInSeconds") ?? 3600);
    const token = await mintAccessToken(env.API_SIGNING_SECRET, {
      sub,
      tenantId,
      agentId: optionalString(args.agentId),
      scopes,
      mailboxIds: optionalStringArray(args.mailboxIds, "mailboxIds"),
      exp,
    });

    return {
      token,
      expiresAt: new Date(exp * 1000).toISOString(),
      authHeader: `Bearer ${token}`,
    };
  }

  if (toolName === "bootstrap_mailbox_agent_token") {
    if (!env.API_SIGNING_SECRET) {
      throw new AdminMcpToolError("tool_internal_error", "API_SIGNING_SECRET is not configured");
    }

    const tenantId = requireString(args.tenantId, "tenantId");
    const mailboxId = requireString(args.mailboxId, "mailboxId");
    const mailbox = await getMailboxById(env, mailboxId);
    if (!mailbox) {
      throw new AdminMcpToolError("resource_mailbox_not_found", "Mailbox not found");
    }
    if (mailbox.tenant_id !== tenantId) {
      throw new AdminMcpToolError("invalid_arguments", "Mailbox does not belong to tenant");
    }

    const agentId = optionalString(args.agentId);
    if (agentId) {
      const agent = await getAgent(env, agentId);
      if (!agent) {
        throw new AdminMcpToolError("resource_agent_not_found", "Agent not found");
      }
      if (agent.tenantId !== tenantId) {
        throw new AdminMcpToolError("invalid_arguments", "Agent does not belong to tenant");
      }
    }

    const mode = optionalString(args.mode) ?? "send";
    if (!(mode in DEFAULT_MAILBOX_AGENT_SCOPE_PROFILES)) {
      throw new AdminMcpToolError("invalid_arguments", "mode must be read_only, draft_only, or send");
    }
    const scopes = [...DEFAULT_MAILBOX_AGENT_SCOPE_PROFILES[mode as keyof typeof DEFAULT_MAILBOX_AGENT_SCOPE_PROFILES]];
    const exp = Math.floor(Date.now() / 1000) + (optionalInteger(args.expiresInSeconds, "expiresInSeconds") ?? 1800);
    const sub = optionalString(args.sub) ?? `admin-bootstrap:${tenantId}:${mailboxId}`;
    const token = await mintAccessToken(env.API_SIGNING_SECRET, {
      sub,
      tenantId,
      agentId,
      scopes,
      mailboxIds: [mailboxId],
      exp,
    });

    const visibleTools = listMailboxToolsForScopes(scopes);
    return {
      token,
      expiresAt: new Date(exp * 1000).toISOString(),
      authHeader: `Bearer ${token}`,
      mailbox: {
        id: mailbox.id,
        address: mailbox.address,
      },
      agentId,
      scopeProfile: mode,
      scopes,
      visibleTools: visibleTools.map((tool) => ({
        name: tool.name,
        category: tool.category,
        riskLevel: tool.riskLevel,
        recommendedForMailboxAgents: tool.recommendedForMailboxAgents,
      })),
      nextSteps: [
        "Call /mcp tools/list with the minted bearer token.",
        "Prefer list_messages before any side effect.",
        mode === "read_only"
          ? "Use read-only mailbox flows until broader authorization is needed."
          : "Prefer send_email and reply_to_message for mailbox-scoped send and reply flows.",
      ],
    };
  }

  if (toolName === "list_agents") {
    return {
      items: await listAgents(env, optionalString(args.tenantId)),
    };
  }

  if (toolName === "get_agent") {
    const agent = await getAgent(env, requireString(args.agentId, "agentId"));
    if (!agent) {
      throw new AdminMcpToolError("resource_agent_not_found", "Agent not found");
    }
    return agent;
  }

  if (toolName === "list_mailboxes") {
    const tenantId = optionalString(args.tenantId);
    const items = await listMailboxes(env);
    return {
      items: tenantId ? items.filter((item) => item.tenantId === tenantId) : items,
    };
  }

  if (toolName === "get_mailbox") {
    const mailboxId = optionalString(args.mailboxId);
    const address = optionalString(args.address);
    if (!mailboxId && !address) {
      throw new AdminMcpToolError("invalid_arguments", "mailboxId or address is required");
    }

    const mailbox = mailboxId
      ? await getMailboxById(env, mailboxId)
      : await getMailboxByAddress(env, requireString(address, "address").toLowerCase());

    if (!mailbox) {
      throw new AdminMcpToolError("resource_mailbox_not_found", "Mailbox not found");
    }

    return {
      id: mailbox.id,
      tenantId: mailbox.tenant_id,
      address: mailbox.address,
      status: mailbox.status,
      createdAt: mailbox.created_at,
    };
  }

  if (toolName === "get_tenant_send_policy") {
    return await ensureTenantSendPolicy(env, requireString(args.tenantId, "tenantId"));
  }

  if (toolName === "upsert_tenant_send_policy") {
    const pricingTier = requireString(args.pricingTier, "pricingTier") as PricingTier;
    const outboundStatus = requireString(args.outboundStatus, "outboundStatus") as TenantOutboundStatus;
    if (!["free", "paid_review", "paid_active", "enterprise"].includes(pricingTier)) {
      throw new AdminMcpToolError("invalid_arguments", "pricingTier is invalid");
    }
    if (!["internal_only", "external_review", "external_enabled", "suspended"].includes(outboundStatus)) {
      throw new AdminMcpToolError("invalid_arguments", "outboundStatus is invalid");
    }

    const sendPolicy = await upsertTenantSendPolicy(env, {
      tenantId: requireString(args.tenantId, "tenantId"),
      pricingTier,
      outboundStatus,
      internalDomainAllowlist: optionalStringArray(args.internalDomainAllowlist, "internalDomainAllowlist") ?? ["mailagents.net"],
      externalSendEnabled: requireBoolean(args.externalSendEnabled, "externalSendEnabled"),
      reviewRequired: requireBoolean(args.reviewRequired, "reviewRequired"),
    });

    if (sendPolicy.outboundStatus === "external_enabled" && sendPolicy.externalSendEnabled) {
      await relaxTenantDefaultAgentRecipientPoliciesForExternalSend(env, {
        tenantId: sendPolicy.tenantId,
        internalDomainAllowlist: sendPolicy.internalDomainAllowlist,
      });
    }

    return sendPolicy;
  }

  if (toolName === "apply_tenant_send_policy_review") {
    const decision = requireString(args.decision, "decision");
    if (!["approve_external", "reset_review", "suspend_outbound"].includes(decision)) {
      throw new AdminMcpToolError("invalid_arguments", "decision is invalid");
    }

    return await applyTenantSendPolicyReview(env, {
      tenantId: requireString(args.tenantId, "tenantId"),
      decision: decision as "approve_external" | "reset_review" | "suspend_outbound",
    });
  }

  if (toolName === "get_tenant_review_context") {
    const tenantId = requireString(args.tenantId, "tenantId");
    const receiptsLimit = optionalInteger(args.receiptsLimit, "receiptsLimit") ?? 10;
    const sendPolicy = await ensureTenantSendPolicy(env, tenantId);
    const billingAccount = await ensureTenantBillingAccount(env, tenantId);
    const recentReceipts = await listTypedTenantPaymentReceipts(env, tenantId, receiptsLimit);
    return {
      tenantId,
      sendPolicy,
      billingAccount,
      recentReceipts,
      summary: {
        pendingReceiptCount: recentReceipts.filter((receipt) => receipt.status === "pending" || receipt.status === "verified").length,
        settledReceiptCount: recentReceipts.filter((receipt) => receipt.status === "settled").length,
        suggestedActions: summarizeTenantReviewActions({
          outboundStatus: sendPolicy.outboundStatus,
          reviewRequired: sendPolicy.reviewRequired,
          billingStatus: billingAccount.status,
          hasPendingReceipts: recentReceipts.some((receipt) => receipt.status === "pending" || receipt.status === "verified"),
        }),
      },
    };
  }

  if (toolName === "get_debug_message") {
    const messageId = requireString(args.messageId, "messageId");
    const message = await getMessage(env, messageId);
    if (!message) {
      throw new AdminMcpToolError("resource_message_not_found", "Message not found");
    }

    return {
      message,
      deliveryEvents: await listDeliveryEventsByMessageId(env, messageId),
    };
  }

  if (toolName === "inspect_delivery_case") {
    return await inspectDeliveryCase(env, {
      messageId: optionalString(args.messageId),
      draftId: optionalString(args.draftId),
      outboundJobId: optionalString(args.outboundJobId),
      email: optionalString(args.email),
      includePayload: args.includePayload === false ? false : true,
    });
  }

  if (toolName === "get_debug_draft") {
    const draft = await getDraft(env, requireString(args.draftId, "draftId"));
    if (!draft) {
      throw new AdminMcpToolError("resource_draft_not_found", "Draft not found");
    }

    const draftObject = await env.R2_EMAIL.get(draft.draftR2Key);
    return {
      draft,
      payload: draftObject ? await draftObject.json<unknown>() : null,
    };
  }

  if (toolName === "get_debug_outbound_job") {
    const outboundJob = await getOutboundJob(env, requireString(args.outboundJobId, "outboundJobId"));
    if (!outboundJob) {
      throw new AdminMcpToolError("resource_outbound_job_not_found", "Outbound job not found");
    }
    return outboundJob;
  }

  if (toolName === "get_suppression") {
    const suppression = await getSuppression(env, requireString(args.email, "email").toLowerCase());
    if (!suppression) {
      throw new AdminMcpToolError("resource_suppression_not_found", "Suppression not found");
    }
    return suppression;
  }

  if (toolName === "add_suppression") {
    const email = requireString(args.email, "email").toLowerCase();
    const reason = optionalString(args.reason) ?? "admin_mcp_suppression";
    const source = optionalString(args.source) ?? "admin_mcp";

    await addSuppression(env, email, reason, source);
    return {
      ok: true,
      email,
      reason,
      source,
    };
  }

  throw new AdminMcpToolError("invalid_arguments", "Unknown tool");
}

router.on("POST", ADMIN_MCP_PATH, async (request, env) => {
  return await handleMcpTransportPost(request, {
    allowMethods: ADMIN_MCP_ALLOW_METHODS,
    allowHeaders: ADMIN_MCP_ALLOW_HEADERS,
  }, async (rpc) => {
    const routeError = requireAdminRoutesEnabled(request, env);
    if (routeError) {
      return await adminJsonRpcError(rpc.id ?? null, routeError, "Admin routes are disabled");
    }

    const adminError = requireAdminSecret(request, env);
    if (adminError) {
      return await adminJsonRpcError(rpc.id ?? null, adminError, "Admin secret required");
    }

    if (rpc.method === "notifications/initialized") {
      return null;
    }

    if (rpc.method === "initialize") {
      const runtime = buildRuntimeMetadata(request, env);
      return jsonRpcResult(rpc.id ?? null, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: RUNTIME_SERVER_INFO,
        capabilities: {
          tools: {},
        },
        meta: {
          ...runtime,
          adminMcp: buildAdminMcpMetadata(),
        },
      });
    }

    if (rpc.method === "tools/list") {
      return jsonRpcResult(rpc.id ?? null, {
        tools: ADMIN_TOOL_DEFINITIONS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        })),
      });
    }

    if (rpc.method === "tools/call") {
      const params: Record<string, unknown> | Error = (() => {
        try {
          return asObject(rpc.params);
        } catch (error) {
          return error instanceof Error ? error : new Error("Invalid params");
        }
      })();

      if (params instanceof Error) {
        return jsonRpcError(rpc.id ?? null, -32602, params.message);
      }

      const toolName = params.name;
      if (typeof toolName !== "string") {
        return jsonRpcError(rpc.id ?? null, -32602, "Unknown tool");
      }

      try {
        const result = await callAdminTool(env, toolName, asObject(params.arguments ?? {}));
        return jsonRpcResult(rpc.id ?? null, toToolContent(result));
      } catch (error) {
        if (error instanceof AdminMcpToolError) {
          return jsonRpcResult(rpc.id ?? null, {
            isError: true,
            ...toToolContent({
              error: {
                code: error.errorCode,
                message: error.message,
                details: error.data,
              },
            }),
          });
        }

        return jsonRpcResult(rpc.id ?? null, {
          isError: true,
          ...toToolContent({
            error: {
              code: "tool_internal_error",
              message: error instanceof Error ? error.message : "Tool call failed",
            },
          }),
        });
      }
    }

    return jsonRpcError(rpc.id ?? null, -32601, "Method not found");
  });
});

router.on("GET", ADMIN_MCP_PATH, async (request) => handleMcpTransportGet(request, {
  allowMethods: ADMIN_MCP_ALLOW_METHODS,
  allowHeaders: ADMIN_MCP_ALLOW_HEADERS,
}));

router.on("OPTIONS", ADMIN_MCP_PATH, async (request) => handleMcpTransportOptions(request, {
  allowMethods: ADMIN_MCP_ALLOW_METHODS,
  allowHeaders: ADMIN_MCP_ALLOW_HEADERS,
}));

export async function handleAdminMcpRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  return await router.handle(request, env, ctx);
}
