import type { Env } from "../types";

export const RUNTIME_SERVER_INFO = {
  name: "mailagents-runtime",
  version: "0.1.0",
} as const;

export const MCP_PROTOCOL_VERSION = "2025-03-26";
export const RUNTIME_COMPATIBILITY_VERSION = "2026-03-17";

export interface RuntimeToolMetadata {
  name: string;
  description: string;
  requiredScopes: string[];
  sendAdditionalScopes?: string[];
  composite?: boolean;
  supportsPartialAuthorization?: boolean;
  riskLevel: "read" | "write" | "high_risk" | "privileged";
  sideEffecting: boolean;
  humanReviewRequired: boolean;
}

export const RUNTIME_TOOL_CATALOG: RuntimeToolMetadata[] = [
  {
    name: "create_agent",
    description: "Provision a new agent for a tenant.",
    requiredScopes: ["agent:create"],
    riskLevel: "write",
    sideEffecting: true,
    humanReviewRequired: false,
  },
  {
    name: "bind_mailbox",
    description: "Attach a mailbox to an agent.",
    requiredScopes: ["agent:bind"],
    riskLevel: "write",
    sideEffecting: true,
    humanReviewRequired: false,
  },
  {
    name: "upsert_agent_policy",
    description: "Set reply and delivery policy controls for an agent.",
    requiredScopes: ["agent:update"],
    riskLevel: "privileged",
    sideEffecting: true,
    humanReviewRequired: true,
  },
  {
    name: "reply_to_inbound_email",
    description: "Read inbound message context, construct a reply draft with proper headers, and optionally send it.",
    requiredScopes: ["mail:read", "draft:create"],
    sendAdditionalScopes: ["draft:send"],
    composite: true,
    supportsPartialAuthorization: true,
    riskLevel: "high_risk",
    sideEffecting: true,
    humanReviewRequired: true,
  },
  {
    name: "operator_manual_send",
    description: "Create an operator-approved draft and optionally send it through the normal queue path.",
    requiredScopes: ["draft:create"],
    sendAdditionalScopes: ["draft:send"],
    composite: true,
    supportsPartialAuthorization: true,
    riskLevel: "high_risk",
    sideEffecting: true,
    humanReviewRequired: true,
  },
  {
    name: "list_agent_tasks",
    description: "Fetch current tasks for an agent.",
    requiredScopes: ["task:read"],
    riskLevel: "read",
    sideEffecting: false,
    humanReviewRequired: false,
  },
  {
    name: "get_message",
    description: "Fetch message metadata.",
    requiredScopes: ["mail:read"],
    riskLevel: "read",
    sideEffecting: false,
    humanReviewRequired: false,
  },
  {
    name: "get_message_content",
    description: "Fetch normalized message content and attachment metadata.",
    requiredScopes: ["mail:read"],
    riskLevel: "read",
    sideEffecting: false,
    humanReviewRequired: false,
  },
  {
    name: "get_thread",
    description: "Fetch thread context for reply generation.",
    requiredScopes: ["mail:read"],
    riskLevel: "read",
    sideEffecting: false,
    humanReviewRequired: false,
  },
  {
    name: "create_draft",
    description: "Create a proposed outbound email draft.",
    requiredScopes: ["draft:create"],
    riskLevel: "write",
    sideEffecting: true,
    humanReviewRequired: false,
  },
  {
    name: "get_draft",
    description: "Inspect draft metadata before send.",
    requiredScopes: ["draft:read"],
    riskLevel: "read",
    sideEffecting: false,
    humanReviewRequired: false,
  },
  {
    name: "send_draft",
    description: "Enqueue a draft for outbound delivery.",
    requiredScopes: ["draft:send"],
    riskLevel: "high_risk",
    sideEffecting: true,
    humanReviewRequired: true,
  },
  {
    name: "replay_message",
    description: "Replay message normalization or rerun agent execution.",
    requiredScopes: ["mail:replay"],
    riskLevel: "high_risk",
    sideEffecting: true,
    humanReviewRequired: true,
  },
];

export const WORKFLOW_PACKS = [
  {
    name: "reply_to_inbound_email",
    compositeTool: "reply_to_inbound_email",
    sideEffects: ["create_draft", "send_draft_when_send_true"],
  },
  {
    name: "operator_manual_send",
    compositeTool: "operator_manual_send",
    sideEffects: ["create_draft", "send_draft"],
  },
  {
    name: "replay_and_recover_message",
    compositeTool: null,
    sideEffects: ["replay_message"],
  },
];

export const MCP_ERROR_CODE_CATALOG = [
  {
    code: "auth_unauthorized",
    category: "auth",
    retryable: false,
    description: "The request is missing a valid bearer token or the token could not be verified.",
  },
  {
    code: "auth_missing_scope",
    category: "auth",
    retryable: false,
    description: "The bearer token is valid but lacks one or more required scopes.",
  },
  {
    code: "access_tenant_denied",
    category: "access",
    retryable: false,
    description: "The token is not allowed to act on the requested tenant.",
  },
  {
    code: "access_agent_denied",
    category: "access",
    retryable: false,
    description: "The token is not allowed to act on the requested agent.",
  },
  {
    code: "access_mailbox_denied",
    category: "access",
    retryable: false,
    description: "The token is not allowed to act on the requested mailbox.",
  },
  {
    code: "invalid_arguments",
    category: "input",
    retryable: false,
    description: "The tool call arguments failed validation or were malformed.",
  },
  {
    code: "resource_agent_not_found",
    category: "resource",
    retryable: false,
    description: "The requested agent does not exist.",
  },
  {
    code: "resource_mailbox_not_found",
    category: "resource",
    retryable: false,
    description: "The requested mailbox does not exist.",
  },
  {
    code: "resource_message_not_found",
    category: "resource",
    retryable: false,
    description: "The requested message does not exist.",
  },
  {
    code: "resource_thread_not_found",
    category: "resource",
    retryable: false,
    description: "The requested thread does not exist.",
  },
  {
    code: "resource_draft_not_found",
    category: "resource",
    retryable: false,
    description: "The requested draft does not exist.",
  },
  {
    code: "idempotency_conflict",
    category: "idempotency",
    retryable: false,
    description: "The provided idempotency key is already reserved for a different logical request.",
  },
  {
    code: "idempotency_in_progress",
    category: "idempotency",
    retryable: true,
    description: "The provided idempotency key is already in progress for the same logical request.",
  },
  {
    code: "tool_internal_error",
    category: "internal",
    retryable: true,
    description: "The runtime failed while processing the tool call.",
  },
] as const;

function serializeToolCatalog() {
  return RUNTIME_TOOL_CATALOG.map((tool) => ({
    name: tool.name,
    requiredScopes: tool.requiredScopes,
    sendAdditionalScopes: tool.sendAdditionalScopes ?? [],
    composite: Boolean(tool.composite),
    supportsPartialAuthorization: Boolean(tool.supportsPartialAuthorization),
    riskLevel: tool.riskLevel,
    sideEffecting: tool.sideEffecting,
    humanReviewRequired: tool.humanReviewRequired,
  }));
}

function isEnabled(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function buildRuntimeMetadata(env: Env) {
  return {
    server: RUNTIME_SERVER_INFO,
    api: {
      metaRuntimePath: "/v2/meta/runtime",
      compatibilityPath: "/v2/meta/compatibility",
      mcpPath: "/mcp",
      supportedHttpVersions: ["v1", "v2"],
    },
    mcp: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      methods: ["initialize", "tools/list", "tools/call"],
      toolCount: RUNTIME_TOOL_CATALOG.length,
      compositeTools: RUNTIME_TOOL_CATALOG.filter((tool) => tool.composite).map((tool) => tool.name),
      tools: serializeToolCatalog(),
    },
    workflows: WORKFLOW_PACKS,
    idempotency: {
      operations: [
        "draft_send",
        "message_replay",
        "reply_to_inbound_email(send=true)",
        "operator_manual_send(send=true)",
      ],
      completedRetentionHours: Number(env.IDEMPOTENCY_COMPLETED_RETENTION_HOURS ?? "168"),
      pendingRetentionHours: Number(env.IDEMPOTENCY_PENDING_RETENTION_HOURS ?? "1"),
    },
    routes: {
      adminEnabled: isEnabled(env.ADMIN_ROUTES_ENABLED),
      debugEnabled: isEnabled(env.DEBUG_ROUTES_ENABLED),
    },
  };
}

export function buildCompatibilityContract(env: Env) {
  const runtime = buildRuntimeMetadata(env);
  return {
    contract: {
      name: "mailagents-agent-compatibility",
      version: RUNTIME_COMPATIBILITY_VERSION,
      stability: "beta",
    },
    discovery: {
      runtimeMetadataPath: runtime.api.metaRuntimePath,
      compatibilityPath: runtime.api.compatibilityPath,
      mcpInitializeEmbedsRuntimeMetadata: true,
      toolsListScopeFiltered: true,
    },
    guarantees: {
      stableRuntimeFields: ["server", "api", "mcp", "workflows", "idempotency", "routes"],
      stableToolAnnotations: [
        "riskLevel",
        "sideEffecting",
        "humanReviewRequired",
        "composite",
        "supportsPartialAuthorization",
        "sendAdditionalScopes",
      ],
      stableErrorCodes: MCP_ERROR_CODE_CATALOG.map((item) => item.code),
      idempotentOperations: runtime.idempotency.operations,
    },
    mcp: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      methods: runtime.mcp.methods,
      tools: serializeToolCatalog(),
    },
    workflows: runtime.workflows,
    errors: MCP_ERROR_CODE_CATALOG,
    routes: runtime.routes,
  };
}
