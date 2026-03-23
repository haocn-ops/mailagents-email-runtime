export type AdminToolCategory =
  | "token_admin"
  | "registry_admin"
  | "policy_admin"
  | "debug"
  | "suppression";

export interface AdminWorkflowPack {
  name: string;
  description: string;
  goal: string;
  compositeTool: string;
  categories: AdminToolCategory[];
  recommendedToolSequence: string[];
  sideEffects: string[];
  stopConditions: string[];
}

export const ADMIN_MCP_PATH = "/admin/mcp";
export const ADMIN_MCP_AUTH = {
  type: "header",
  header: "x-admin-secret",
} as const;
export const ADMIN_MCP_METHODS = ["initialize", "tools/list", "tools/call"] as const;

export const ADMIN_WORKFLOW_PACKS = [
  {
    name: "bootstrap_mailbox_agent",
    description: "Mint a least-privilege mailbox bearer token, then hand the agent back to the normal mailbox workflow surface.",
    goal: "Bootstrap a mailbox-scoped agent with the narrowest viable token and a clear next-step tool surface.",
    compositeTool: "bootstrap_mailbox_agent_token",
    categories: ["token_admin", "registry_admin"],
    recommendedToolSequence: ["get_mailbox", "get_agent", "bootstrap_mailbox_agent_token"],
    sideEffects: ["create_access_token"],
    stopConditions: [
      "mailbox identity or tenant ownership is unclear",
      "the requested token scope exceeds the mailbox workflow need",
      "the intended agent binding is ambiguous",
    ],
  },
  {
    name: "review_tenant_outbound_access",
    description: "Gather tenant billing and policy context before deciding whether outbound delivery should be approved, reset, or suspended.",
    goal: "Support operator review of external-send eligibility with enough billing and policy context to make a safe decision.",
    compositeTool: "get_tenant_review_context",
    categories: ["policy_admin", "registry_admin"],
    recommendedToolSequence: [
      "get_tenant_send_policy",
      "list_mailboxes",
      "get_tenant_review_context",
      "apply_tenant_send_policy_review",
    ],
    sideEffects: ["apply_tenant_send_policy_review", "upsert_tenant_send_policy"],
    stopConditions: [
      "the tenant identity or mailbox inventory is incomplete",
      "payment state is still ambiguous or disputed",
      "the review outcome would broaden outbound access without operator approval",
    ],
  },
  {
    name: "forensic_delivery_inspection",
    description: "Correlate message, draft, queue, delivery-event, and suppression state for a suspected delivery issue.",
    goal: "Give an operator or forensic agent a single workflow for tracing delivery state before taking remediation steps.",
    compositeTool: "inspect_delivery_case",
    categories: ["debug", "suppression"],
    recommendedToolSequence: [
      "get_debug_message",
      "get_debug_draft",
      "get_debug_outbound_job",
      "get_suppression",
      "inspect_delivery_case",
    ],
    sideEffects: ["add_suppression"],
    stopConditions: [
      "the lookup target does not uniquely identify the delivery case",
      "delivery evidence is incomplete and requires provider-side logs",
      "adding a suppression would materially change customer delivery behavior without human review",
    ],
  },
] as const satisfies readonly AdminWorkflowPack[];
