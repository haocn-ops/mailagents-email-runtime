import type { Env } from "../types";

export const RUNTIME_SERVER_INFO = {
  name: "mailagents-runtime",
  version: "0.1.0",
} as const;

export const MCP_PROTOCOL_VERSION = "2025-03-26";

export interface RuntimeToolMetadata {
  name: string;
  description: string;
  requiredScopes: string[];
  composite?: boolean;
}

export const RUNTIME_TOOL_CATALOG: RuntimeToolMetadata[] = [
  {
    name: "create_agent",
    description: "Provision a new agent for a tenant.",
    requiredScopes: ["agent:create"],
  },
  {
    name: "bind_mailbox",
    description: "Attach a mailbox to an agent.",
    requiredScopes: ["agent:bind"],
  },
  {
    name: "upsert_agent_policy",
    description: "Set reply and delivery policy controls for an agent.",
    requiredScopes: ["agent:update"],
  },
  {
    name: "reply_to_inbound_email",
    description: "Read inbound message context, construct a reply draft with proper headers, and optionally send it.",
    requiredScopes: ["mail:read", "draft:create"],
    composite: true,
  },
  {
    name: "operator_manual_send",
    description: "Create an operator-approved draft and optionally send it through the normal queue path.",
    requiredScopes: ["draft:create"],
    composite: true,
  },
  {
    name: "list_agent_tasks",
    description: "Fetch current tasks for an agent.",
    requiredScopes: ["task:read"],
  },
  {
    name: "get_message",
    description: "Fetch message metadata.",
    requiredScopes: ["mail:read"],
  },
  {
    name: "get_message_content",
    description: "Fetch normalized message content and attachment metadata.",
    requiredScopes: ["mail:read"],
  },
  {
    name: "get_thread",
    description: "Fetch thread context for reply generation.",
    requiredScopes: ["mail:read"],
  },
  {
    name: "create_draft",
    description: "Create a proposed outbound email draft.",
    requiredScopes: ["draft:create"],
  },
  {
    name: "get_draft",
    description: "Inspect draft metadata before send.",
    requiredScopes: ["draft:read"],
  },
  {
    name: "send_draft",
    description: "Enqueue a draft for outbound delivery.",
    requiredScopes: ["draft:send"],
  },
  {
    name: "replay_message",
    description: "Replay message normalization or rerun agent execution.",
    requiredScopes: ["mail:replay"],
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

function isEnabled(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function buildRuntimeMetadata(env: Env) {
  return {
    server: RUNTIME_SERVER_INFO,
    api: {
      metaRuntimePath: "/v2/meta/runtime",
      mcpPath: "/mcp",
      supportedHttpVersions: ["v1", "v2"],
    },
    mcp: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      methods: ["initialize", "tools/list", "tools/call"],
      toolCount: RUNTIME_TOOL_CATALOG.length,
      compositeTools: RUNTIME_TOOL_CATALOG.filter((tool) => tool.composite).map((tool) => tool.name),
      tools: RUNTIME_TOOL_CATALOG.map((tool) => ({
        name: tool.name,
        requiredScopes: tool.requiredScopes,
        composite: Boolean(tool.composite),
      })),
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
