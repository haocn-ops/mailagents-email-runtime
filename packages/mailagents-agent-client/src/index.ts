export interface MailagentsClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface MailagentsRequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
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

export interface PublicSignupRequest {
  productName: string;
  operatorEmail: string;
  mailboxAlias?: string;
  useCase?: string;
  requestedLocalPart?: string;
}

export interface PublicSignupResult {
  accepted?: boolean;
  mailbox: {
    id: string;
    address: string;
    localPart?: string;
  };
  agent: {
    id: string;
    name?: string;
  };
  version?: {
    id: string;
    version?: string;
  };
  deployment?: {
    id: string;
    targetId?: string;
  };
  accessToken?: string;
  expiresAt?: string;
  scopes?: string[];
}

export interface PublicTokenReissueRequest {
  mailboxAlias?: string;
  mailboxAddress?: string;
}

export interface PublicTokenReissueAccepted {
  accepted: true;
  message: string;
}

export interface RotateAccessTokenRequest {
  delivery?: "inline" | "self_mailbox" | "both";
  mailboxId?: string;
}

export interface RotateAccessTokenResult {
  token?: string;
  expiresAt: string;
  scopes: string[];
  delivery: "inline" | "self_mailbox" | "both";
  deliveryStatus: "skipped" | "queued" | "unavailable";
  deliveryMailboxId?: string;
  oldTokenRemainsValid: true;
}

export interface BootstrapMailboxAgentResult {
  signup: PublicSignupResult;
  client: MailagentsAgentClient;
}

export interface MailboxWorkflowSurface {
  recommended: McpToolDefinition[];
  reads: McpToolDefinition[];
  sends: McpToolDefinition[];
  replies: McpToolDefinition[];
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

export interface ListMessagesRequest {
  mailboxId?: string;
  limit?: number;
  search?: string;
  direction?: "inbound" | "outbound";
  status?: "received" | "normalized" | "tasked" | "replied" | "ignored" | "failed";
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
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs?: number;

  constructor(options: MailagentsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.defaultHeaders = { ...(options.headers ?? {}) };
    this.timeoutMs = options.timeoutMs;
  }

  withToken(token: string): MailagentsAgentClient {
    return new MailagentsAgentClient({
      baseUrl: this.baseUrl,
      token,
      fetchImpl: this.fetchImpl,
      headers: this.defaultHeaders,
      timeoutMs: this.timeoutMs,
    });
  }

  withoutToken(): MailagentsAgentClient {
    return new MailagentsAgentClient({
      baseUrl: this.baseUrl,
      fetchImpl: this.fetchImpl,
      headers: this.defaultHeaders,
      timeoutMs: this.timeoutMs,
    });
  }

  async getRuntimeMetadata(options?: MailagentsRequestOptions): Promise<RuntimeMetadata> {
    return this.requestJson("/v2/meta/runtime", undefined, options);
  }

  async getCompatibilityContract(options?: MailagentsRequestOptions): Promise<CompatibilityContract> {
    return this.requestJson("/v2/meta/compatibility", undefined, options);
  }

  async getCompatibilitySchema(options?: MailagentsRequestOptions): Promise<Record<string, unknown>> {
    return this.requestJson("/v2/meta/compatibility/schema", undefined, options);
  }

  async publicSignup(input: PublicSignupRequest, options?: MailagentsRequestOptions): Promise<PublicSignupResult> {
    return this.requestJson("/public/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }, options);
  }

  async reissueAccessToken(
    input: PublicTokenReissueRequest,
    options?: MailagentsRequestOptions
  ): Promise<PublicTokenReissueAccepted> {
    return this.requestJson("/public/token/reissue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }, options);
  }

  async rotateAccessToken(
    input: RotateAccessTokenRequest = {},
    options?: MailagentsRequestOptions
  ): Promise<RotateAccessTokenResult> {
    return this.requestJson("/v1/auth/token/rotate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(input),
    }, options);
  }

  async listTools(options?: MailagentsRequestOptions): Promise<ToolsListResult> {
    const payload = await this.callMcp("tools/list", {}, options);
    return payload.result;
  }

  async createAgent(args: {
    tenantId: string;
    name: string;
    mode: string;
    config?: Record<string, unknown>;
  }, options?: MailagentsRequestOptions): Promise<AgentRecord> {
    return this.callTool<AgentRecord>("create_agent", args, options);
  }

  async bindMailbox(args: {
    agentId: string;
    tenantId: string;
    mailboxId: string;
    role: string;
  }, options?: MailagentsRequestOptions): Promise<AgentMailboxBinding> {
    return this.callTool<AgentMailboxBinding>("bind_mailbox", args, options);
  }

  async listAgentTasks(args: {
    agentId: string;
    status?: string;
  }, options?: MailagentsRequestOptions): Promise<{ items: TaskRecord[] }> {
    return this.callTool<{ items: TaskRecord[] }>("list_agent_tasks", args, options);
  }

  async listMessages(args: ListMessagesRequest = {}, options?: MailagentsRequestOptions): Promise<ListMessagesResult> {
    return this.callTool<ListMessagesResult>("list_messages", args, options);
  }

  async getLatestInboundMessage(
    args: Omit<ListMessagesRequest, "direction" | "limit"> = {},
    options?: MailagentsRequestOptions
  ): Promise<MessageRecord | null> {
    const messages = await this.listMessages({
      ...args,
      limit: 1,
      direction: "inbound",
    }, options);
    return messages.items[0] ?? null;
  }

  async getMessage(messageId: string, options?: MailagentsRequestOptions): Promise<MessageRecord> {
    return this.callTool<MessageRecord>("get_message", { messageId }, options);
  }

  async getMessageContent(messageId: string, options?: MailagentsRequestOptions): Promise<MessageContentResult> {
    return this.callTool<MessageContentResult>("get_message_content", { messageId }, options);
  }

  async getThread(threadId: string, options?: MailagentsRequestOptions): Promise<ThreadResult> {
    return this.callTool<ThreadResult>("get_thread", { threadId }, options);
  }

  async callTool<T>(name: string, args: Record<string, unknown>, options?: MailagentsRequestOptions): Promise<T> {
    const payload = await this.callMcp("tools/call", {
      name,
      arguments: args,
    }, options);

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
  }, options?: MailagentsRequestOptions): Promise<CreateDraftResult> {
    return this.callTool<CreateDraftResult>("create_draft", args, options);
  }

  async sendDraft(
    draftId: string,
    idempotencyKey: string,
    options?: MailagentsRequestOptions
  ): Promise<SendDraftResult> {
    return this.callTool<SendDraftResult>("send_draft", { draftId, idempotencyKey }, options);
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
  }, options?: MailagentsRequestOptions): Promise<HighLevelSendResult> {
    return this.callTool<HighLevelSendResult>("send_email", args, options);
  }

  async replyToMessage(args: {
    messageId: string;
    text?: string;
    html?: string;
    idempotencyKey?: string;
  }, options?: MailagentsRequestOptions): Promise<HighLevelSendResult> {
    return this.callTool<HighLevelSendResult>("reply_to_message", args, options);
  }

  async replyToInboundEmail(args: {
    agentId: string;
    messageId: string;
    replyText: string;
    send?: boolean;
    idempotencyKey?: string;
  }, options?: MailagentsRequestOptions): Promise<ReplyWorkflowResult> {
    return this.callTool<ReplyWorkflowResult>("reply_to_inbound_email", args, options);
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
  }, options?: MailagentsRequestOptions): Promise<OperatorManualSendResult> {
    return this.callTool<OperatorManualSendResult>("operator_manual_send", args, options);
  }

  async listRecommendedMailboxTools(options?: MailagentsRequestOptions): Promise<McpToolDefinition[]> {
    const result = await this.listTools(options);
    return result.tools.filter((tool) => tool.annotations.recommendedForMailboxAgents);
  }

  async getMailboxWorkflowSurface(options?: MailagentsRequestOptions): Promise<MailboxWorkflowSurface> {
    const recommended = await this.listRecommendedMailboxTools(options);
    return {
      recommended,
      reads: recommended.filter((tool) => tool.annotations.category === "mail_read"),
      sends: recommended.filter((tool) => tool.annotations.category === "mail_send"),
      replies: recommended.filter((tool) => tool.annotations.category === "mail_reply"),
    };
  }

  async replyLatestInbound(args: {
    text?: string;
    html?: string;
    idempotencyKey?: string;
  }, options?: MailagentsRequestOptions): Promise<HighLevelSendResult> {
    const latest = await this.getLatestInboundMessage({}, options);
    if (!latest?.id) {
      throw new MailagentsClientError("No inbound messages available to reply to");
    }

    return this.replyToMessage({
      messageId: latest.id,
      text: args.text,
      html: args.html,
      idempotencyKey: args.idempotencyKey,
    }, options);
  }

  static async bootstrapMailboxAgent(
    options: MailagentsClientOptions,
    input: PublicSignupRequest
  ): Promise<BootstrapMailboxAgentResult> {
    const unauthenticated = new MailagentsAgentClient(options);
    const signup = await unauthenticated.publicSignup(input);
    if (!signup.accessToken) {
      throw new MailagentsClientError("Signup completed without returning an access token");
    }

    return {
      signup,
      client: unauthenticated.withToken(signup.accessToken),
    };
  }

  private async requestJson<T>(path: string, init?: RequestInit, options?: MailagentsRequestOptions): Promise<T> {
    const response = await this.fetchWithDefaults(path, init, options);
    const payload = await this.readResponseBody(response);
    if (!response.ok) {
      const details = this.extractErrorDetails(payload.json);
      throw new MailagentsClientError(
        details.message ?? payload.text ?? `HTTP request failed: ${response.status}`,
        {
          status: response.status,
          errorCode: details.errorCode,
        }
      );
    }
    if (payload.json === undefined) {
      throw new MailagentsClientError("HTTP request returned a non-JSON response", {
        status: response.status,
      });
    }
    return payload.json as T;
  }

  private async callMcp(
    method: string,
    params: Record<string, unknown>,
    options?: MailagentsRequestOptions
  ): Promise<JsonRpcSuccess<any> & JsonRpcFailure> {
    const response = await this.fetchWithDefaults("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
    }, options);

    const body = await this.readResponseBody(response);
    const payload = body.json as (JsonRpcSuccess<any> & JsonRpcFailure) | undefined;
    if (!response.ok) {
      const details = this.extractErrorDetails(payload);
      throw new MailagentsClientError(
        details.message ?? body.text ?? `MCP request failed: ${response.status}`,
        {
          status: response.status,
          errorCode: details.errorCode,
        }
      );
    }
    if (!payload) {
      throw new MailagentsClientError("MCP request returned a non-JSON response", {
        status: response.status,
      });
    }
    if (payload.error) {
      const details = this.extractErrorDetails(payload);
      throw new MailagentsClientError(payload.error.message, {
        errorCode: details.errorCode,
      });
    }
    return payload;
  }

  private async fetchWithDefaults(
    path: string,
    init?: RequestInit,
    options?: MailagentsRequestOptions
  ): Promise<Response> {
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const signal = options?.signal ?? init?.signal;
    const controller = timeoutMs && !signal ? new AbortController() : undefined;
    const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller?.signal ?? signal,
        headers: {
          ...this.defaultHeaders,
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...((init?.headers as Record<string, string> | undefined) ?? {}),
          ...(options?.headers ?? {}),
        },
      });
    } catch (error) {
      if (controller?.signal.aborted) {
        throw new MailagentsClientError(`Request timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  private async readResponseBody(response: Response): Promise<{ json?: unknown; text?: string }> {
    const text = await response.text().catch(() => "");
    if (!text) {
      return {};
    }

    try {
      return {
        json: JSON.parse(text),
        text,
      };
    } catch {
      return { text };
    }
  }

  private extractErrorDetails(payload: unknown): { message?: string; errorCode?: string } {
    if (!payload || typeof payload !== "object") {
      return {};
    }

    const error = "error" in payload && payload.error && typeof payload.error === "object"
      ? payload.error as {
        message?: unknown;
        code?: unknown;
        data?: unknown;
      }
      : undefined;

    const result = "result" in payload && payload.result && typeof payload.result === "object"
      ? payload.result as {
        structuredContent?: {
          error?: {
            code?: unknown;
            message?: unknown;
          };
        };
      }
      : undefined;

    const structuredError = result?.structuredContent?.error;
    const dataErrorCode = error?.data && typeof error.data === "object" && "errorCode" in error.data
      ? (error.data as { errorCode?: unknown }).errorCode
      : undefined;

    const message = typeof structuredError?.message === "string"
      ? structuredError.message
      : typeof error?.message === "string"
        ? error.message
        : "message" in payload && typeof (payload as { message?: unknown }).message === "string"
          ? (payload as { message: string }).message
          : undefined;

    const errorCode = typeof structuredError?.code === "string"
      ? structuredError.code
      : typeof dataErrorCode === "string"
        ? dataErrorCode
        : typeof error?.code === "string"
          ? error.code
          : undefined;

    return { message, errorCode };
  }
}
