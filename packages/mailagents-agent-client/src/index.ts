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

export interface PublicSignupRequest {
  mailboxAlias: string;
  agentName: string;
  productName: string;
  operatorEmail: string;
  useCase: string;
}

export interface PublicSignupResult {
  tenantId: string;
  productName: string;
  operatorEmail: string;
  mailboxAddress: string;
  mailboxId: string;
  agentId: string;
  agentVersionId: string;
  deploymentId: string;
  accessToken?: string;
  accessTokenExpiresAt?: string;
  accessTokenScopes: string[];
  outboundJobId?: string;
  welcomeStatus: "queued" | "failed";
  welcomeError?: string;
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

export interface CreateAccessTokenRequest {
  sub: string;
  tenantId: string;
  agentId?: string;
  scopes: string[];
  mailboxIds?: string[];
  expiresInSeconds?: number;
}

export interface CreateAccessTokenResult {
  token: string;
  expiresAt: string;
}

export type AgentMode = "assistant" | "autonomous" | "review_only";
export type AgentStatus = "draft" | "active" | "disabled" | "archived";

export interface AgentRecord {
  id: string;
  tenantId: string;
  slug?: string;
  name: string;
  description?: string;
  status: AgentStatus;
  mode: AgentMode;
  configR2Key?: string;
  defaultVersionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMailboxBinding {
  id: string;
  agentId: string;
  mailboxId: string;
  role: "primary" | "shared" | "send_only" | "receive_only";
  status: "active" | "disabled";
  createdAt: string;
}

export type TaskStatus = "queued" | "running" | "done" | "needs_review" | "failed";
export type DraftStatus = "draft" | "approved" | "queued" | "sent" | "cancelled" | "failed";
export type MessageDirection = "inbound" | "outbound";
export type MessageStatus = "received" | "normalized" | "tasked" | "replied" | "ignored" | "failed";
export type OutboundJobStatus = "queued" | "sending" | "sent" | "retry" | "failed";

export interface SelfMailboxRecord {
  id: string;
  tenantId: string;
  address: string;
  status: string;
  createdAt: string;
  agentId?: string;
}

export interface TaskRecord {
  id: string;
  tenantId: string;
  mailboxId: string;
  sourceMessageId: string;
  taskType: string;
  priority: number;
  status: TaskStatus;
  assignedAgent?: string;
  resultR2Key?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  tenantId: string;
  mailboxId: string;
  threadId?: string;
  direction: MessageDirection;
  provider?: "cloudflare" | "ses";
  internetMessageId?: string;
  providerMessageId?: string;
  fromAddr?: string;
  toAddr?: string;
  subject?: string;
  snippet?: string;
  status?: MessageStatus;
  rawR2Key?: string;
  normalizedR2Key?: string;
  receivedAt?: string;
  sentAt?: string;
  createdAt?: string;
}

export interface MessageAttachment {
  id: string;
  filename?: string;
  contentType?: string;
  sizeBytes: number;
  downloadUrl?: string;
}

export interface MessageContentResult {
  text?: string;
  html?: string;
  attachments: MessageAttachment[];
}

export interface SelfMailboxMessageContent extends MessageContentResult {}

export interface ThreadResult {
  id: string;
  tenantId: string;
  mailboxId: string;
  subjectNorm?: string;
  status?: string;
  messages: MessageRecord[];
}

export interface ListMessagesResult {
  mailbox?: {
    id: string;
    address: string;
  };
  items: MessageRecord[];
}

export interface DraftRecord {
  id: string;
  tenantId: string;
  agentId: string;
  mailboxId: string;
  threadId?: string;
  sourceMessageId?: string;
  createdVia?: string;
  status: DraftStatus;
  draftR2Key?: string;
  subject?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateDraftResult extends DraftRecord {}

export interface SendDraftResult {
  draftId: string;
  outboundJobId: string;
  status: OutboundJobStatus;
}

export interface DraftAttachment {
  filename: string;
  contentType: string;
  r2Key: string;
}

export interface CreateDraftRequest {
  agentId: string;
  tenantId: string;
  mailboxId: string;
  threadId?: string;
  sourceMessageId?: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: DraftAttachment[];
}

export interface SendMessageRequest {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: DraftAttachment[];
  idempotencyKey?: string;
}

export interface CreateAndSendAccepted {
  draft: DraftRecord;
  outboundJobId: string;
  status: OutboundJobStatus;
}

export interface HighLevelSendResult extends CreateAndSendAccepted {}

export interface ReplyAccepted extends CreateAndSendAccepted {
  sourceMessageId?: string;
  threadId?: string;
}

export interface ReplayMessageRequest {
  mode: "normalize" | "rerun_agent";
  agentId?: string;
  idempotencyKey?: string;
}

export interface ReplayAccepted {
  messageId: string;
  mode: "normalize" | "rerun_agent";
  status: "accepted";
}

export interface ReplyWorkflowResult {
  sourceMessage: MessageRecord;
  draft: DraftRecord;
  sendRequested: boolean;
  sendResult?: SendDraftResult;
  usedThreadContext: boolean;
}

export interface OperatorManualSendResult {
  draft: DraftRecord;
  sendRequested: boolean;
  sendResult?: SendDraftResult;
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

function withQuery(
  path: string,
  query: Record<string, string | number | undefined>
): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }
    searchParams.set(key, String(value));
  }

  const search = searchParams.toString();
  return search ? `${path}?${search}` : path;
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

  async publicSignup(input: PublicSignupRequest): Promise<PublicSignupResult> {
    return this.requestJson("/public/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async reissueAccessToken(input: PublicTokenReissueRequest): Promise<PublicTokenReissueAccepted> {
    return this.requestJson("/public/token/reissue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async createAccessToken(
    input: CreateAccessTokenRequest,
    options: { adminSecret: string }
  ): Promise<CreateAccessTokenResult> {
    return this.requestJson("/v1/auth/tokens", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-secret": options.adminSecret,
      },
      body: JSON.stringify(input),
    });
  }

  async rotateAccessToken(input: RotateAccessTokenRequest = {}): Promise<RotateAccessTokenResult> {
    return this.requestJson("/v1/auth/token/rotate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(input),
    });
  }

  async rotateToken(input: RotateAccessTokenRequest = {}): Promise<RotateAccessTokenResult> {
    return this.rotateAccessToken(input);
  }

  async listTools(): Promise<ToolsListResult> {
    const payload = await this.callMcp("tools/list", {});
    return payload.result;
  }

  async getSelfMailbox(): Promise<SelfMailboxRecord> {
    return this.requestJson("/v1/mailboxes/self");
  }

  async createAgent(args: {
    tenantId: string;
    name: string;
    mode: AgentMode;
    slug?: string;
    description?: string;
    config?: Record<string, unknown>;
  }): Promise<AgentRecord> {
    return this.requestJson("/v1/agents", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
    });
  }

  async bindMailbox(args: {
    agentId: string;
    tenantId: string;
    mailboxId: string;
    role: "primary" | "shared" | "send_only" | "receive_only";
  }): Promise<AgentMailboxBinding> {
    return this.requestJson(`/v1/agents/${encodeURIComponent(args.agentId)}/mailboxes`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        tenantId: args.tenantId,
        mailboxId: args.mailboxId,
        role: args.role,
      }),
    });
  }

  async listAgentTasks(args: {
    agentId: string;
    status?: TaskStatus;
  }): Promise<{ items: TaskRecord[] }> {
    return this.requestJson(withQuery(`/v1/agents/${encodeURIComponent(args.agentId)}/tasks`, {
      status: args.status,
    }));
  }

  async listTasks(args: {
    status?: TaskStatus;
  } = {}): Promise<{ items: TaskRecord[] }> {
    return this.listSelfMailboxTasks(args);
  }

  async listSelfMailboxTasks(args: {
    status?: TaskStatus;
  } = {}): Promise<{ items: TaskRecord[] }> {
    return this.requestJson(withQuery("/v1/mailboxes/self/tasks", {
      status: args.status,
    }));
  }

  async listSelfMailboxMessages(args: {
    limit?: number;
    search?: string;
    direction?: MessageDirection;
    status?: MessageStatus;
  } = {}): Promise<ListMessagesResult> {
    return this.requestJson(withQuery("/v1/mailboxes/self/messages", {
      limit: args.limit,
      search: args.search,
      direction: args.direction,
      status: args.status,
    }));
  }

  async getSelfMailboxMessage(messageId: string): Promise<MessageRecord> {
    return this.requestJson(`/v1/mailboxes/self/messages/${encodeURIComponent(messageId)}`);
  }

  async getSelfMailboxMessageContent(messageId: string): Promise<SelfMailboxMessageContent> {
    return this.requestJson(`/v1/mailboxes/self/messages/${encodeURIComponent(messageId)}/content`);
  }

  async listMessages(args: {
    mailboxId?: string;
    limit?: number;
    search?: string;
    direction?: MessageDirection;
    status?: MessageStatus;
  } = {}): Promise<ListMessagesResult> {
    if (!args.mailboxId) {
      return this.listSelfMailboxMessages(args);
    }

    return this.callTool<ListMessagesResult>("list_messages", args);
  }

  async getMessage(messageId: string): Promise<MessageRecord> {
    return this.requestJson(`/v1/messages/${encodeURIComponent(messageId)}`);
  }

  async getMessageContent(messageId: string): Promise<MessageContentResult> {
    return this.requestJson(`/v1/messages/${encodeURIComponent(messageId)}/content`);
  }

  async getThread(threadId: string): Promise<ThreadResult> {
    return this.requestJson(`/v1/threads/${encodeURIComponent(threadId)}`);
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

  async createDraft(args: CreateDraftRequest): Promise<CreateDraftResult> {
    return this.requestJson(`/v1/agents/${encodeURIComponent(args.agentId)}/drafts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        tenantId: args.tenantId,
        mailboxId: args.mailboxId,
        threadId: args.threadId,
        sourceMessageId: args.sourceMessageId,
        from: args.from,
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        text: args.text,
        html: args.html,
        inReplyTo: args.inReplyTo,
        references: args.references,
        attachments: args.attachments,
      }),
    });
  }

  async getDraft(draftId: string): Promise<DraftRecord> {
    return this.requestJson(`/v1/drafts/${encodeURIComponent(draftId)}`);
  }

  async sendDraft(draftId: string, idempotencyKey?: string): Promise<SendDraftResult> {
    return this.requestJson(`/v1/drafts/${encodeURIComponent(draftId)}/send`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  async sendMessage(args: SendMessageRequest): Promise<CreateAndSendAccepted> {
    return this.requestJson("/v1/messages/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
    });
  }

  async sendSelfMailboxMessage(args: SendMessageRequest): Promise<CreateAndSendAccepted> {
    return this.requestJson("/v1/mailboxes/self/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
    });
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
    attachments?: DraftAttachment[];
    idempotencyKey?: string;
  }): Promise<HighLevelSendResult> {
    if (!args.mailboxId) {
      return this.sendMessage(args);
    }

    if (args.attachments?.length) {
      throw new MailagentsClientError(
        "attachments are only supported when using the mailbox-scoped HTTP send routes"
      );
    }

    return this.callTool<HighLevelSendResult>("send_email", args);
  }

  async replyToMessage(args: {
    messageId: string;
    text?: string;
    html?: string;
    idempotencyKey?: string;
  }): Promise<ReplyAccepted> {
    return this.requestJson(`/v1/messages/${encodeURIComponent(args.messageId)}/reply`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: args.text,
        html: args.html,
        idempotencyKey: args.idempotencyKey,
      }),
    });
  }

  async replayMessage(messageId: string, args: ReplayMessageRequest): Promise<ReplayAccepted> {
    return this.requestJson(`/v1/messages/${encodeURIComponent(messageId)}/replay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
    });
  }

  async replyToInboundEmail(args: {
    agentId: string;
    messageId: string;
    replyText?: string;
    replyHtml?: string;
    send?: boolean;
    idempotencyKey?: string;
  }): Promise<ReplyWorkflowResult> {
    if (!args.replyText && !args.replyHtml) {
      throw new MailagentsClientError("replyText or replyHtml is required");
    }

    const result = await this.callTool<Omit<ReplyWorkflowResult, "sendRequested">>("reply_to_inbound_email", args);
    return {
      ...result,
      sendRequested: Boolean(result.sendResult),
    };
  }

  async operatorManualSend(args: {
    agentId: string;
    tenantId: string;
    mailboxId: string;
    threadId?: string;
    sourceMessageId?: string;
    from: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    text?: string;
    html?: string;
    inReplyTo?: string;
    references?: string[];
    send?: boolean;
    idempotencyKey?: string;
  }): Promise<OperatorManualSendResult> {
    if (!args.text && !args.html) {
      throw new MailagentsClientError("text or html is required");
    }

    return this.callTool<OperatorManualSendResult>("operator_manual_send", args);
  }

  async listRecommendedMailboxTools(): Promise<McpToolDefinition[]> {
    const result = await this.listTools();
    return result.tools.filter((tool) => tool.annotations.recommendedForMailboxAgents);
  }

  async getMailboxWorkflowSurface(): Promise<MailboxWorkflowSurface> {
    const recommended = await this.listRecommendedMailboxTools();
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
  }): Promise<ReplyAccepted> {
    const messages = await this.listMessages({ limit: 1, direction: "inbound" });
    const latest = messages.items[0];
    if (!latest?.id) {
      throw new MailagentsClientError("No inbound messages available to reply to");
    }

    return this.replyToMessage({
      messageId: latest.id,
      text: args.text,
      html: args.html,
      idempotencyKey: args.idempotencyKey,
    });
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

  private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...((init?.headers as Record<string, string> | undefined) ?? {}),
      },
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
