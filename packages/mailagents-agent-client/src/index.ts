export interface MailagentsClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export interface RuntimeApiMetadata {
  metaRuntimePath: string;
  compatibilityPath: string;
  compatibilitySchemaPath: string;
  mcpPath: string;
  supportedHttpVersions: string[];
}

export interface RuntimeToolSummary {
  name: string;
  requiredScopes: string[];
  sendAdditionalScopes: string[];
  composite: boolean;
  supportsPartialAuthorization: boolean;
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
  recommendedForMailboxAgents: boolean;
  riskLevel: "read" | "write" | "high_risk" | "privileged";
  sideEffecting: boolean;
  humanReviewRequired: boolean;
}

export interface RuntimeMetadata {
  server: {
    name: string;
    version: string;
  };
  api: RuntimeApiMetadata;
  mcp: {
    protocolVersion: string;
    methods: string[];
    toolCount: number;
    compositeTools: string[];
    tools: RuntimeToolSummary[];
  };
  workflows: Array<{
    name: string;
    compositeTool: string | null;
    sideEffects: string[];
  }>;
  idempotency: {
    operations: string[];
    completedRetentionHours: number;
    pendingRetentionHours: number;
  };
  routes: {
    adminEnabled: boolean;
    debugEnabled: boolean;
  };
}

export interface CompatibilityContract {
  contract: {
    name: string;
    version: string;
    stability: string;
    changelogPath: string;
  };
  discovery: {
    runtimeMetadataPath: string;
    compatibilityPath: string;
    compatibilitySchemaPath: string;
    mcpInitializeEmbedsRuntimeMetadata: boolean;
    toolsListScopeFiltered: boolean;
  };
  evolution: {
    versioningPolicy: {
      patchSafeChanges: string[];
      compatibilityVersionBumpTriggers: string[];
    };
    deprecationPolicy: {
      announcedVia: string[];
      minimumNotice: string;
      removalRule: string;
    };
    deprecatedFields: Array<{
      path: string;
      status: "deprecated";
      replacement?: string;
      removalVersion?: string;
      note?: string;
    }>;
  };
  guarantees: {
    stableRuntimeFields: string[];
    stableToolAnnotations: string[];
    stableErrorCodes: string[];
    idempotentOperations: string[];
  };
  mcp: {
    protocolVersion: string;
    methods: string[];
    tools: RuntimeToolSummary[];
  };
  workflows: Array<{
    name: string;
    compositeTool: string | null;
    sideEffects: string[];
  }>;
  errors: Array<{
    code: string;
    category: string;
    retryable: boolean;
    description: string;
  }>;
  routes: {
    adminEnabled: boolean;
    debugEnabled: boolean;
  };
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    riskLevel: "read" | "write" | "high_risk" | "privileged";
    sideEffecting: boolean;
    humanReviewRequired: boolean;
    composite: boolean;
    supportsPartialAuthorization: boolean;
    sendAdditionalScopes: string[];
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
    recommendedForMailboxAgents: boolean;
  };
}

export interface ToolsListResult {
  tools: McpToolDefinition[];
}

export interface AgentRecord {
  id: string;
  tenantId: string;
  name: string;
  status?: string;
  mode: string;
}

export interface AgentMailboxBinding {
  agentId: string;
  tenantId: string;
  mailboxId: string;
  role: string;
}

export interface TaskRecord {
  id: string;
  agentId: string;
  tenantId: string;
  status: string;
  title?: string;
}

export interface MessageRecord {
  id: string;
  tenantId?: string;
  mailboxId?: string;
  threadId: string | null;
  direction?: string;
  subject?: string;
  status?: string;
}

export interface MessageContentResult {
  message: MessageRecord;
  normalized?: {
    text?: string;
    html?: string;
    subject?: string;
    from?: string;
    to?: string[];
    cc?: string[];
    attachments?: Array<{
      filename?: string;
      contentType?: string;
      size?: number;
    }>;
  } | null;
}

export interface ThreadResult {
  thread: {
    id: string;
    tenantId?: string;
    mailboxId?: string;
    subject?: string;
  };
  messages?: MessageRecord[];
}

export interface ListMessagesResult {
  items: MessageRecord[];
}

export interface DraftRecord {
  id: string;
  tenantId: string;
  agentId: string;
  mailboxId: string;
  status: string;
  subject?: string;
}

export interface CreateDraftResult extends DraftRecord {}

export interface SendDraftResult {
  draftId: string;
  outboundJobId: string;
  status: string;
}

export interface HighLevelSendResult {
  accepted: true;
  draftId: string;
  outboundJobId: string;
  status: string;
  createdVia?: string;
}

export interface ReplyWorkflowResult {
  sourceMessage: {
    id: string;
    threadId: string | null;
  };
  draft: DraftRecord;
  sendRequested: boolean;
  sendResult?: {
    draftId: string;
    outboundJobId: string;
    status: string;
  };
  usedThreadContext: boolean;
}

export interface OperatorManualSendResult {
  draft: DraftRecord;
  sendRequested: boolean;
  sendResult?: {
    draftId: string;
    outboundJobId: string;
    status: string;
  };
}

export interface JsonRpcSuccess<T> {
  jsonrpc: "2.0";
  id: string | number | null;
  result: T;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  result?: {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        message?: string;
      };
    };
  };
}

export interface McpToolErrorResult {
  isError: true;
  structuredContent?: {
    error?: {
      code?: string;
      message?: string;
    };
  };
}

export const STABLE_MAILAGENTS_ERROR_CODES = [
  "auth_unauthorized",
  "auth_missing_scope",
  "access_tenant_denied",
  "access_agent_denied",
  "access_mailbox_denied",
  "invalid_arguments",
  "resource_message_not_found",
  "resource_thread_not_found",
  "resource_draft_not_found",
  "resource_mailbox_not_found",
  "resource_agent_not_found",
  "idempotency_conflict",
  "idempotency_in_progress",
  "tool_internal_error",
] as const;

export type MailagentsStableErrorCode = typeof STABLE_MAILAGENTS_ERROR_CODES[number];

function getStructuredToolErrorCode(payload: JsonRpcFailure): string | undefined {
  return payload.result?.structuredContent?.error?.code;
}

export class MailagentsClientError extends Error {
  status?: number;
  errorCode?: string;

  constructor(message: string, options?: { status?: number; errorCode?: string }) {
    super(message);
    this.name = "MailagentsClientError";
    this.status = options?.status;
    this.errorCode = options?.errorCode;
  }
}

export function isMailagentsClientError(error: unknown): error is MailagentsClientError {
  return error instanceof MailagentsClientError;
}

export function hasMailagentsErrorCode(
  error: unknown,
  errorCode: MailagentsStableErrorCode
): error is MailagentsClientError & { errorCode: MailagentsStableErrorCode } {
  return isMailagentsClientError(error) && error.errorCode === errorCode;
}

export function isRetryableMailagentsError(error: unknown): boolean {
  return hasMailagentsErrorCode(error, "idempotency_in_progress") ||
    hasMailagentsErrorCode(error, "tool_internal_error");
}

export class MailagentsAgentClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MailagentsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  withToken(token: string): MailagentsAgentClient {
    return new MailagentsAgentClient({
      baseUrl: this.baseUrl,
      token,
      fetchImpl: this.fetchImpl,
    });
  }

  async getRuntimeMetadata(): Promise<RuntimeMetadata> {
    return this.requestJson("/v2/meta/runtime");
  }

  async getCompatibilityContract(): Promise<CompatibilityContract> {
    return this.requestJson("/v2/meta/compatibility");
  }

  async getCompatibilitySchema(): Promise<Record<string, unknown>> {
    return this.requestJson("/v2/meta/compatibility/schema");
  }

  async listTools(): Promise<ToolsListResult> {
    const payload = await this.callMcp("tools/list", {});
    return payload.result;
  }

  async createAgent(args: {
    tenantId: string;
    name: string;
    mode: string;
    config?: Record<string, unknown>;
  }): Promise<AgentRecord> {
    return this.callTool<AgentRecord>("create_agent", args);
  }

  async bindMailbox(args: {
    agentId: string;
    tenantId: string;
    mailboxId: string;
    role: string;
  }): Promise<AgentMailboxBinding> {
    return this.callTool<AgentMailboxBinding>("bind_mailbox", args);
  }

  async listAgentTasks(args: {
    agentId: string;
    status?: string;
  }): Promise<{ items: TaskRecord[] }> {
    return this.callTool<{ items: TaskRecord[] }>("list_agent_tasks", args);
  }

  async listMessages(args: {
    mailboxId?: string;
    limit?: number;
    search?: string;
    direction?: "inbound" | "outbound";
    status?: "received" | "normalized" | "tasked" | "replied" | "ignored" | "failed";
  } = {}): Promise<ListMessagesResult> {
    return this.callTool<ListMessagesResult>("list_messages", args);
  }

  async getMessage(messageId: string): Promise<MessageRecord> {
    return this.callTool<MessageRecord>("get_message", { messageId });
  }

  async getMessageContent(messageId: string): Promise<MessageContentResult> {
    return this.callTool<MessageContentResult>("get_message_content", { messageId });
  }

  async getThread(threadId: string): Promise<ThreadResult> {
    return this.callTool<ThreadResult>("get_thread", { threadId });
  }

  async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const payload = await this.callMcp("tools/call", {
      name,
      arguments: args,
    });

    if (payload.result && typeof payload.result === "object" && "isError" in payload.result && payload.result.isError) {
      const toolError = payload.result as McpToolErrorResult;
      throw new MailagentsClientError(
        toolError.structuredContent?.error?.message ?? "MCP tool call failed",
        { errorCode: getStructuredToolErrorCode(payload) }
      );
    }

    return payload.result as T;
  }

  async createDraft(args: {
    agentId: string;
    tenantId: string;
    mailboxId: string;
    from: string;
    to: string[];
    subject: string;
    text: string;
  }): Promise<CreateDraftResult> {
    return this.callTool<CreateDraftResult>("create_draft", args);
  }

  async sendDraft(draftId: string, idempotencyKey: string): Promise<SendDraftResult> {
    return this.callTool<SendDraftResult>("send_draft", { draftId, idempotencyKey });
  }

  async sendEmail(args: {
    mailboxId?: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    text?: string;
    html?: string;
    inReplyTo?: string;
    references?: string[];
    idempotencyKey?: string;
  }): Promise<HighLevelSendResult> {
    return this.callTool<HighLevelSendResult>("send_email", args);
  }

  async replyToMessage(args: {
    messageId: string;
    text?: string;
    html?: string;
    idempotencyKey?: string;
  }): Promise<HighLevelSendResult> {
    return this.callTool<HighLevelSendResult>("reply_to_message", args);
  }

  async replyToInboundEmail(args: {
    agentId: string;
    messageId: string;
    replyText: string;
    send?: boolean;
    idempotencyKey?: string;
  }): Promise<ReplyWorkflowResult> {
    return this.callTool<ReplyWorkflowResult>("reply_to_inbound_email", args);
  }

  async operatorManualSend(args: {
    agentId: string;
    tenantId: string;
    mailboxId: string;
    from: string;
    to: string[];
    subject: string;
    text: string;
    send?: boolean;
    idempotencyKey?: string;
  }): Promise<OperatorManualSendResult> {
    return this.callTool<OperatorManualSendResult>("operator_manual_send", args);
  }

  async listRecommendedMailboxTools(): Promise<McpToolDefinition[]> {
    const result = await this.listTools();
    return result.tools.filter((tool) => tool.annotations.recommendedForMailboxAgents);
  }

  private async requestJson<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : undefined,
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new MailagentsClientError(`HTTP request failed: ${response.status}`, {
        status: response.status,
      });
    }
    return payload as T;
  }

  private async callMcp(method: string, params: Record<string, unknown>): Promise<JsonRpcSuccess<any> & JsonRpcFailure> {
    const response = await this.fetchImpl(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
    });

    const payload = (await response.json()) as JsonRpcSuccess<any> & JsonRpcFailure;
    if (!response.ok) {
      throw new MailagentsClientError(`MCP request failed: ${response.status}`, {
        status: response.status,
      });
    }
    if (payload.error) {
      throw new MailagentsClientError(payload.error.message, {
        errorCode: typeof payload.error.data === "object" && payload.error.data && "errorCode" in payload.error.data
          ? String((payload.error.data as { errorCode?: unknown }).errorCode ?? "")
          : undefined,
      });
    }
    return payload;
  }
}
