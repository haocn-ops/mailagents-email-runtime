import { getOutboundProvider } from "./outbound-provider";
import {
  ADMIN_MCP_AUTH,
  ADMIN_MCP_METHODS,
  ADMIN_MCP_PATH,
  ADMIN_WORKFLOW_PACKS,
} from "./admin-mcp-contract";
import type { Env } from "../types";

export const RUNTIME_SERVER_INFO = {
  name: "mailagents-runtime",
  version: "0.1.0",
} as const;

export const MCP_PROTOCOL_VERSION = "2025-03-26";
export const RUNTIME_COMPATIBILITY_VERSION = "2026-03-17";
export const RUNTIME_COMPATIBILITY_SCHEMA_VERSION = "2026-03-17";

export interface RuntimeToolMetadata {
  name: string;
  description: string;
  requiredScopes: string[];
  sendAdditionalScopes?: string[];
  composite?: boolean;
  supportsPartialAuthorization?: boolean;
  category:
    | "provisioning"
    | "policy"
    | "task_read"
    | "mail_read"
    | "thread_read"
    | "draft_control"
    | "mail_send"
    | "mail_reply"
    | "recovery";
  recommendedForMailboxAgents?: boolean;
  riskLevel: "read" | "write" | "high_risk" | "privileged";
  sideEffecting: boolean;
  humanReviewRequired: boolean;
}

export const RUNTIME_TOOL_CATALOG: RuntimeToolMetadata[] = [
  {
    name: "create_agent",
    description: "Provision a new agent for a tenant.",
    requiredScopes: ["agent:create"],
    category: "provisioning",
    riskLevel: "write",
    sideEffecting: true,
    humanReviewRequired: false,
  },
  {
    name: "bind_mailbox",
    description: "Attach a mailbox to an agent.",
    requiredScopes: ["agent:bind"],
    category: "provisioning",
    riskLevel: "write",
    sideEffecting: true,
    humanReviewRequired: false,
  },
  {
    name: "upsert_agent_policy",
    description: "Set reply and delivery policy controls for an agent.",
    requiredScopes: ["agent:update"],
    category: "policy",
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
    category: "mail_reply",
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
    category: "mail_send",
    riskLevel: "high_risk",
    sideEffecting: true,
    humanReviewRequired: true,
  },
  {
    name: "list_agent_tasks",
    description: "Fetch current tasks for an agent.",
    requiredScopes: ["task:read"],
    category: "task_read",
    riskLevel: "read",
    sideEffecting: false,
    humanReviewRequired: false,
  },
  {
    name: "list_messages",
    description: "List messages for the mailbox bound to the current token or an explicitly authorized mailbox.",
    requiredScopes: ["mail:read"],
    category: "mail_read",
    recommendedForMailboxAgents: true,
    riskLevel: "read",
    sideEffecting: false,
    humanReviewRequired: false,
  },
  {
    name: "get_message",
    description: "Fetch message metadata.",
    requiredScopes: ["mail:read"],
    category: "mail_read",
    riskLevel: "read",
    sideEffecting: false,
    humanReviewRequired: false,
  },
  {
    name: "get_message_content",
    description: "Fetch normalized message content and attachment metadata.",
    requiredScopes: ["mail:read"],
    category: "mail_read",
    riskLevel: "read",
    sideEffecting: false,
    humanReviewRequired: false,
  },
  {
    name: "get_thread",
    description: "Fetch thread context for reply generation.",
    requiredScopes: ["mail:read"],
    category: "thread_read",
    riskLevel: "read",
    sideEffecting: false,
    humanReviewRequired: false,
  },
  {
    name: "create_draft",
    description: "Create a proposed outbound email draft.",
    requiredScopes: ["draft:create"],
    category: "draft_control",
    riskLevel: "write",
    sideEffecting: true,
    humanReviewRequired: false,
  },
  {
    name: "get_draft",
    description: "Inspect draft metadata before send.",
    requiredScopes: ["draft:read"],
    category: "draft_control",
    riskLevel: "read",
    sideEffecting: false,
    humanReviewRequired: false,
  },
  {
    name: "send_draft",
    description: "Enqueue a draft for outbound delivery.",
    requiredScopes: ["draft:send"],
    category: "draft_control",
    riskLevel: "high_risk",
    sideEffecting: true,
    humanReviewRequired: true,
  },
  {
    name: "cancel_draft",
    description: "Cancel a draft that has not been queued or sent yet.",
    requiredScopes: ["draft:create"],
    category: "draft_control",
    recommendedForMailboxAgents: true,
    riskLevel: "write",
    sideEffecting: true,
    humanReviewRequired: false,
  },
  {
    name: "send_email",
    description: "Create and send a mailbox-scoped outbound email in one MCP call.",
    requiredScopes: ["draft:create", "draft:send"],
    composite: true,
    category: "mail_send",
    recommendedForMailboxAgents: true,
    riskLevel: "high_risk",
    sideEffecting: true,
    humanReviewRequired: true,
  },
  {
    name: "reply_to_message",
    description: "Reply to an inbound message and send the reply in one MCP call.",
    requiredScopes: ["mail:read", "draft:create", "draft:send"],
    composite: true,
    category: "mail_reply",
    recommendedForMailboxAgents: true,
    riskLevel: "high_risk",
    sideEffecting: true,
    humanReviewRequired: true,
  },
  {
    name: "replay_message",
    description: "Replay message normalization or rerun agent execution.",
    requiredScopes: ["mail:replay"],
    category: "recovery",
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
    name: "send_email",
    compositeTool: "send_email",
    sideEffects: ["create_draft", "send_draft"],
  },
  {
    name: "reply_to_message",
    compositeTool: "reply_to_message",
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
    code: "route_disabled",
    category: "availability",
    retryable: false,
    description: "The requested MCP surface is disabled in the current environment.",
  },
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
    code: "insufficient_credits",
    category: "billing",
    retryable: false,
    description: "The tenant does not have enough credits to send to external recipients.",
  },
  {
    code: "daily_quota_exceeded",
    category: "policy",
    retryable: true,
    description: "The tenant has reached its rolling 24-hour outbound send limit.",
  },
  {
    code: "hourly_quota_exceeded",
    category: "policy",
    retryable: true,
    description: "The tenant has reached its rolling 1-hour outbound send limit.",
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
    code: "resource_outbound_job_not_found",
    category: "resource",
    retryable: false,
    description: "The requested outbound job does not exist.",
  },
  {
    code: "resource_suppression_not_found",
    category: "resource",
    retryable: false,
    description: "The requested suppression record does not exist.",
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

export const COMPATIBILITY_CONTRACT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Mailagents Agent Compatibility Contract",
  type: "object",
  required: ["contract", "discovery", "evolution", "guarantees", "mcp", "workflows", "errors", "routes"],
  properties: {
    contract: {
      type: "object",
      required: ["name", "version", "stability", "changelogPath"],
      properties: {
        name: { type: "string" },
        version: { type: "string" },
        stability: { type: "string" },
        changelogPath: { type: "string" },
      },
      additionalProperties: false,
    },
    discovery: {
      type: "object",
      required: ["runtimeMetadataPath", "compatibilityPath", "compatibilitySchemaPath", "mcpInitializeEmbedsRuntimeMetadata", "toolsListScopeFiltered"],
      properties: {
        runtimeMetadataPath: { type: "string" },
        compatibilityPath: { type: "string" },
        compatibilitySchemaPath: { type: "string" },
        adminMcpPath: { type: "string" },
        mcpInitializeEmbedsRuntimeMetadata: { type: "boolean" },
        toolsListScopeFiltered: { type: "boolean" },
      },
      additionalProperties: false,
    },
    evolution: {
      type: "object",
      required: ["versioningPolicy", "deprecationPolicy", "deprecatedFields"],
      properties: {
        versioningPolicy: {
          type: "object",
          required: ["patchSafeChanges", "compatibilityVersionBumpTriggers"],
          properties: {
            patchSafeChanges: { type: "array", items: { type: "string" } },
            compatibilityVersionBumpTriggers: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
        deprecationPolicy: {
          type: "object",
          required: ["announcedVia", "minimumNotice", "removalRule"],
          properties: {
            announcedVia: { type: "array", items: { type: "string" } },
            minimumNotice: { type: "string" },
            removalRule: { type: "string" },
          },
          additionalProperties: false,
        },
        deprecatedFields: {
          type: "array",
          items: {
            type: "object",
            required: ["path", "status"],
            properties: {
              path: { type: "string" },
              status: { type: "string", enum: ["deprecated"] },
              replacement: { type: "string" },
              removalVersion: { type: "string" },
              note: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    guarantees: {
      type: "object",
      required: ["stableRuntimeFields", "stableToolAnnotations", "stableErrorCodes", "idempotentOperations"],
      properties: {
        stableRuntimeFields: { type: "array", items: { type: "string" } },
        stableToolAnnotations: { type: "array", items: { type: "string" } },
        stableErrorCodes: { type: "array", items: { type: "string" } },
        idempotentOperations: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    mcp: {
      type: "object",
      required: ["protocolVersion", "methods", "tools"],
      properties: {
        protocolVersion: { type: "string" },
        methods: { type: "array", items: { type: "string" } },
        tools: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "requiredScopes", "sendAdditionalScopes", "composite", "supportsPartialAuthorization", "category", "recommendedForMailboxAgents", "riskLevel", "sideEffecting", "humanReviewRequired"],
            properties: {
              name: { type: "string" },
              requiredScopes: { type: "array", items: { type: "string" } },
              sendAdditionalScopes: { type: "array", items: { type: "string" } },
              composite: { type: "boolean" },
              supportsPartialAuthorization: { type: "boolean" },
              category: {
                type: "string",
                enum: ["provisioning", "policy", "task_read", "mail_read", "thread_read", "draft_control", "mail_send", "mail_reply", "recovery"],
              },
              recommendedForMailboxAgents: { type: "boolean" },
              riskLevel: { type: "string", enum: ["read", "write", "high_risk", "privileged"] },
              sideEffecting: { type: "boolean" },
              humanReviewRequired: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    workflows: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "compositeTool", "sideEffects"],
        properties: {
          name: { type: "string" },
          compositeTool: { type: ["string", "null"] },
          sideEffects: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    },
    admin: {
      type: "object",
      required: ["mcp"],
      properties: {
        mcp: {
          type: "object",
          required: ["path", "auth", "methods", "workflows"],
          properties: {
            path: { type: "string" },
            auth: {
              type: "object",
              required: ["type", "header"],
              properties: {
                type: { type: "string", enum: ["header"] },
                header: { type: "string" },
              },
              additionalProperties: false,
            },
            methods: { type: "array", items: { type: "string" } },
            workflows: {
              type: "array",
              items: {
                type: "object",
                required: [
                  "name",
                  "description",
                  "goal",
                  "compositeTool",
                  "categories",
                  "recommendedToolSequence",
                  "sideEffects",
                  "stopConditions",
                ],
                properties: {
                  name: { type: "string" },
                  description: { type: "string" },
                  goal: { type: "string" },
                  compositeTool: { type: "string" },
                  categories: {
                    type: "array",
                    items: {
                      type: "string",
                      enum: ["token_admin", "registry_admin", "policy_admin", "debug", "suppression"],
                    },
                  },
                  recommendedToolSequence: { type: "array", items: { type: "string" } },
                  sideEffects: { type: "array", items: { type: "string" } },
                  stopConditions: { type: "array", items: { type: "string" } },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    errors: {
      type: "array",
      items: {
        type: "object",
        required: ["code", "category", "retryable", "description"],
        properties: {
          code: { type: "string" },
          category: { type: "string" },
          retryable: { type: "boolean" },
          description: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    routes: {
      type: "object",
      required: ["adminEnabled", "debugEnabled"],
      properties: {
        adminEnabled: { type: "boolean" },
        debugEnabled: { type: "boolean" },
      },
      additionalProperties: false,
    },
    delivery: {
      type: "object",
      required: ["outboundProvider"],
      properties: {
        outboundProvider: { type: "string", enum: ["ses", "resend"] },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

function serializeToolCatalog() {
  return RUNTIME_TOOL_CATALOG.map((tool) => ({
    name: tool.name,
    requiredScopes: tool.requiredScopes,
    sendAdditionalScopes: tool.sendAdditionalScopes ?? [],
    composite: Boolean(tool.composite),
    supportsPartialAuthorization: Boolean(tool.supportsPartialAuthorization),
    category: tool.category,
    recommendedForMailboxAgents: Boolean(tool.recommendedForMailboxAgents),
    riskLevel: tool.riskLevel,
    sideEffecting: tool.sideEffecting,
    humanReviewRequired: tool.humanReviewRequired,
  }));
}

function isEnabled(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function buildRuntimeMetadata(env: Env) {
  const adminEnabled = isEnabled(env.ADMIN_ROUTES_ENABLED);
  return {
    server: RUNTIME_SERVER_INFO,
    api: {
      metaRuntimePath: "/v2/meta/runtime",
      compatibilityPath: "/v2/meta/compatibility",
      compatibilitySchemaPath: "/v2/meta/compatibility/schema",
      mcpPath: "/mcp",
      ...(adminEnabled ? { adminMcpPath: ADMIN_MCP_PATH } : {}),
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
      adminEnabled,
      debugEnabled: isEnabled(env.DEBUG_ROUTES_ENABLED),
    },
    delivery: {
      outboundProvider: getOutboundProvider(env),
    },
  };
}

export function buildCompatibilityContract(env: Env) {
  const runtime = buildRuntimeMetadata(env);
  const admin = runtime.routes.adminEnabled
    ? {
      mcp: {
        path: ADMIN_MCP_PATH,
        auth: ADMIN_MCP_AUTH,
        methods: [...ADMIN_MCP_METHODS],
        workflows: ADMIN_WORKFLOW_PACKS,
      },
    }
    : undefined;
  return {
    contract: {
      name: "mailagents-agent-compatibility",
      version: RUNTIME_COMPATIBILITY_VERSION,
      stability: "beta",
      changelogPath: "/CHANGELOG.md",
    },
    discovery: {
      runtimeMetadataPath: runtime.api.metaRuntimePath,
      compatibilityPath: runtime.api.compatibilityPath,
      compatibilitySchemaPath: runtime.api.compatibilitySchemaPath,
      ...(runtime.api.adminMcpPath ? { adminMcpPath: runtime.api.adminMcpPath } : {}),
      mcpInitializeEmbedsRuntimeMetadata: true,
      toolsListScopeFiltered: true,
    },
    evolution: {
      versioningPolicy: {
        patchSafeChanges: [
          "new optional metadata fields",
          "new non-breaking documentation fields",
          "new tool descriptions without schema changes",
        ],
        compatibilityVersionBumpTriggers: [
          "removing a stable top-level contract field",
          "renaming a stable MCP error code",
          "changing the meaning of a stable tool annotation field",
          "removing a listed idempotent operation name",
        ],
      },
      deprecationPolicy: {
        announcedVia: ["compatibility contract", "CHANGELOG.md"],
        minimumNotice: "one compatibility version",
        removalRule: "stable fields or stable error codes should not be removed without first appearing in deprecatedFields",
      },
      deprecatedFields: [] as Array<{
        path: string;
        status: "deprecated";
        replacement?: string;
        removalVersion?: string;
        note?: string;
      }>,
    },
    guarantees: {
      stableRuntimeFields: ["server", "api", "mcp", "workflows", "idempotency", "routes", "delivery"],
      stableToolAnnotations: [
        "riskLevel",
        "sideEffecting",
        "humanReviewRequired",
        "composite",
        "supportsPartialAuthorization",
        "sendAdditionalScopes",
        "category",
        "recommendedForMailboxAgents",
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
    ...(admin ? { admin } : {}),
    errors: MCP_ERROR_CODE_CATALOG,
    routes: runtime.routes,
    delivery: runtime.delivery,
  };
}
