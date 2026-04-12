export interface MailagentsClientOptions {
  baseUrl: string;
  token?: string;
  adminSecret?: string;
  fetchImpl?: typeof fetch;
}

export interface RuntimeApiMetadata {
  metaRuntimePath: string;
  compatibilityPath: string;
  compatibilitySchemaPath: string;
  mcpPath: string;
  adminMcpPath?: string;
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
  delivery: {
    outboundProvider: "ses" | "resend";
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
    adminMcpPath?: string;
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
  delivery: {
    outboundProvider: "ses" | "resend";
  };
  admin?: {
    mcp: AdminCompatibilityMcpSurface;
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

export interface AdminMcpToolDefinition {
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

export interface AdminToolsListResult {
  tools: AdminMcpToolDefinition[];
}

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

export interface AdminMcpMetadata {
  path: string;
  auth: {
    type: "header";
    header: "x-admin-secret";
  };
  methods: string[];
  workflows: AdminWorkflowPack[];
  toolCount: number;
  tools: Array<Pick<AdminMcpToolDefinition, "name" | "description" | "annotations">>;
}

export interface AdminCompatibilityMcpSurface {
  path: string;
  auth: {
    type: "header";
    header: "x-admin-secret";
  };
  methods: string[];
  workflows: AdminWorkflowPack[];
}

export interface AdminWorkflowSurface {
  metadata: AdminMcpMetadata;
  workflows: AdminWorkflowPack[];
  tools: AdminMcpToolDefinition[];
  compositeTools: AdminMcpToolDefinition[];
  privileged: AdminMcpToolDefinition[];
  tokenAdmin: AdminMcpToolDefinition[];
  registryAdmin: AdminMcpToolDefinition[];
  policyAdmin: AdminMcpToolDefinition[];
  debug: AdminMcpToolDefinition[];
  suppression: AdminMcpToolDefinition[];
}

export interface OperatorCapabilitySurface {
  runtime: RuntimeMetadata;
  compatibility: CompatibilityContract;
  admin: AdminWorkflowSurface;
}

export interface OperatorMailboxSessionInput {
  tenantId: string;
  mailboxId: string;
  agentId?: string;
  mode?: "read_only" | "draft_only" | "send";
  expiresInSeconds?: number;
  sub?: string;
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

export interface AdminCreateAccessTokenResult extends CreateAccessTokenResult {
  authHeader?: string;
}

export type AgentMode = "assistant" | "autonomous" | "review_only";
export type AgentStatus = "draft" | "active" | "disabled" | "archived";
export type TenantBillingStatus = "trial" | "active" | "delinquent" | "suspended";
export type PricingTier = "free" | "paid_review" | "paid_active" | "enterprise";
export type TenantOutboundStatus = "internal_only" | "external_review" | "external_enabled" | "suspended";

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

export interface MailboxRecord {
  id: string;
  tenantId: string;
  address: string;
  status: string;
  createdAt: string;
}

export interface BillingAccountRecord {
  tenantId: string;
  status: TenantBillingStatus;
  pricingTier: PricingTier;
  defaultNetwork?: string;
  defaultAsset?: string;
  availableCredits: number;
  reservedCredits: number;
  totalCredits?: number;
  spendableCredits?: number;
  pendingReservedCredits?: number;
  updatedAt: string;
}

export type PaymentReceiptStatus = "pending" | "verified" | "settled" | "failed" | "refunded";

export interface PaymentReceiptRecord {
  id: string;
  tenantId: string;
  receiptType: "topup" | "upgrade" | "refund" | "adjustment";
  paymentScheme: string;
  network?: string;
  asset?: string;
  amountAtomic: string;
  amountDisplay?: string;
  paymentReference?: string;
  settlementReference?: string;
  status: PaymentReceiptStatus;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TenantSendPolicyRecord {
  tenantId: string;
  pricingTier: PricingTier;
  outboundStatus: TenantOutboundStatus;
  internalDomainAllowlist: string[];
  externalSendEnabled: boolean;
  reviewRequired: boolean;
  effectiveDailySendLimit: number | null;
  effectiveHourlySendLimit: number | null;
  limitWindowModel: "rolling" | null;
  updatedAt: string;
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
  provider: "cloudflare" | "internal" | "ses" | "resend";
  internetMessageId?: string;
  providerMessageId?: string;
  fromAddr: string;
  toAddr: string;
  subject?: string;
  snippet?: string;
  status: MessageStatus;
  rawR2Key?: string;
  normalizedR2Key?: string;
  receivedAt?: string;
  sentAt?: string;
  createdAt: string;
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
  draftR2Key: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDraftResult extends DraftRecord {}

export interface SendDraftResult {
  draftId: string;
  outboundJobId: string;
  status: OutboundJobStatus;
  acceptedForDelivery?: true;
  deliveryState?: "queued";
  finalDeliveryState?: "pending";
  statusCheck?: {
    outboundJobPath: string;
    draftPath: string;
  };
  message?: string;
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
  acceptedForDelivery?: true;
  deliveryState?: "queued";
  finalDeliveryState?: "pending";
  statusCheck?: {
    outboundJobPath: string;
    draftPath: string;
  };
  message?: string;
}

export interface OutboundJobStatusResult {
  id: string;
  status: OutboundJobStatus;
  retryCount: number;
  nextRetryAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  acceptedForDelivery: true;
  deliveryState: OutboundJobStatus;
  finalDeliveryState: "pending" | "sent" | "failed";
  message: {
    id: string;
    status: MessageStatus;
    providerMessageId?: string;
    fromAddr: string;
    toAddr: string;
    subject?: string;
    sentAt?: string;
    createdAt: string;
  };
  draft?: {
    id: string;
    status: DraftStatus;
    threadId?: string;
    sourceMessageId?: string;
    createdVia?: string;
    updatedAt: string;
  } | null;
  deliveryEvents: DeliveryEventRecord[];
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

export interface DeliveryEventRecord {
  id: string;
  messageId?: string;
  provider: string;
  providerMessageId?: string;
  eventType: "delivery" | "bounce" | "complaint" | "reject" | "unknown";
  payloadR2Key: string;
  createdAt: string;
}

export interface DebugMessageResult {
  message: MessageRecord;
  deliveryEvents: DeliveryEventRecord[];
}

export interface DebugDraftResult {
  draft: DraftRecord;
  payload: unknown;
}

export interface SuppressionRecord {
  email: string;
  reason: string;
  source: string;
  createdAt: string;
}

export interface AdminReviewDecisionResult {
  sendPolicy: TenantSendPolicyRecord;
  account: BillingAccountRecord;
  decision: "approve_external" | "reset_review" | "suspend_outbound";
  message: string;
}

export interface AdminBootstrapMailboxAgentTokenResult extends AdminCreateAccessTokenResult {
  mailbox: {
    id: string;
    address: string;
  };
  agentId?: string;
  scopeProfile: "read_only" | "draft_only" | "send";
  scopes: string[];
  visibleTools: Array<{
    name: string;
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
    riskLevel: "read" | "write" | "high_risk" | "privileged";
    recommendedForMailboxAgents?: boolean;
  }>;
  nextSteps: string[];
}

export interface AdminBootstrapMailboxAgentWorkflowResult {
  bootstrap: AdminBootstrapMailboxAgentTokenResult;
  client: MailagentsAgentClient;
  workflow: MailboxWorkflowSurface;
}

export interface AdminTenantReviewContextResult {
  tenantId: string;
  sendPolicy: TenantSendPolicyRecord;
  billingAccount: BillingAccountRecord;
  recentReceipts: PaymentReceiptRecord[];
  summary: {
    pendingReceiptCount: number;
    settledReceiptCount: number;
    suggestedActions: Array<"approve_external" | "reset_review" | "suspend_outbound">;
  };
}

export interface AdminReviewTenantOutboundAccessWorkflowResult {
  context: AdminTenantReviewContextResult;
  decision?: "approve_external" | "reset_review" | "suspend_outbound";
  decisionResult?: AdminReviewDecisionResult;
  effectiveSendPolicy: TenantSendPolicyRecord;
  suggestedActions: Array<"approve_external" | "reset_review" | "suspend_outbound">;
}

export interface AdminInspectDeliveryCaseResult {
  lookup: {
    type: "message" | "draft" | "outbound_job" | "email";
    value: string;
  };
  message?: MessageRecord | null;
  draft?: DraftRecord | null;
  draftPayload?: unknown;
  outboundJob?: {
    id: string;
    messageId: string;
    taskId?: string;
    status: OutboundJobStatus;
    sesRegion: string;
    retryCount: number;
    nextRetryAt?: string;
    lastError?: string;
    draftR2Key: string;
    createdAt: string;
    updatedAt: string;
  } | null;
  deliveryEvents?: DeliveryEventRecord[];
  suppression?: SuppressionRecord | null;
}

export interface AdminInspectDeliveryCaseWorkflowSummary {
  lookupType: "message" | "draft" | "outbound_job" | "email";
  hasMessage: boolean;
  hasDraft: boolean;
  hasOutboundJob: boolean;
  deliveryEventCount: number;
  suppressed: boolean;
  outboundJobStatus?: OutboundJobStatus;
  recommendedActions: string[];
}

export interface AdminInspectDeliveryCaseWorkflowResult {
  inspection: AdminInspectDeliveryCaseResult;
  summary: AdminInspectDeliveryCaseWorkflowSummary;
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

export interface McpToolResultEnvelope<T> {
  isError?: boolean;
  structuredContent?: T;
}

export const STABLE_MAILAGENTS_ERROR_CODES = [
  "auth_unauthorized",
  "auth_missing_scope",
  "route_disabled",
  "access_tenant_denied",
  "access_agent_denied",
  "access_mailbox_denied",
  "invalid_arguments",
  "insufficient_credits",
  "daily_quota_exceeded",
  "hourly_quota_exceeded",
  "resource_message_not_found",
  "resource_thread_not_found",
  "resource_draft_not_found",
  "resource_outbound_job_not_found",
  "resource_suppression_not_found",
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

function unwrapMcpToolResult<T>(payload: JsonRpcSuccess<unknown> & JsonRpcFailure): T {
  const result = payload.result;
  if (result && typeof result === "object" && "structuredContent" in result) {
    return (result as McpToolResultEnvelope<T>).structuredContent as T;
  }

  return result as T;
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

function filterAdminToolsByCategory(
  tools: AdminMcpToolDefinition[],
  category: AdminToolCategory
): AdminMcpToolDefinition[] {
  return tools.filter((tool) => tool.annotations.category === category);
}

function summarizeAdminDeliveryInspection(
  inspection: AdminInspectDeliveryCaseResult
): AdminInspectDeliveryCaseWorkflowSummary {
  const recommendedActions: string[] = [];
  const deliveryEventCount = inspection.deliveryEvents?.length ?? 0;
  const outboundJobStatus = inspection.outboundJob?.status;

  if (inspection.suppression) {
    recommendedActions.push("review suppression state before retrying delivery");
  }
  if (inspection.outboundJob?.lastError) {
    recommendedActions.push("inspect outbound job error details before requeueing or retrying");
  }
  if (inspection.outboundJob && deliveryEventCount === 0) {
    recommendedActions.push("check provider-side delivery evidence if queue state exists without events");
  }
  if (!inspection.outboundJob && inspection.draft) {
    recommendedActions.push("inspect draft payload and send path because no outbound job was found");
  }
  if (!inspection.message && inspection.lookup.type !== "email") {
    recommendedActions.push("verify the case identifier because no message record was correlated");
  }
  if (recommendedActions.length === 0) {
    recommendedActions.push("no immediate remediation suggested; continue with operator review");
  }

  return {
    lookupType: inspection.lookup.type,
    hasMessage: Boolean(inspection.message),
    hasDraft: Boolean(inspection.draft),
    hasOutboundJob: Boolean(inspection.outboundJob),
    deliveryEventCount,
    suppressed: Boolean(inspection.suppression),
    outboundJobStatus,
    recommendedActions,
  };
}

export class MailagentsAgentClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly adminSecret?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MailagentsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.adminSecret = options.adminSecret;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  withToken(token: string): MailagentsAgentClient {
    return new MailagentsAgentClient({
      baseUrl: this.baseUrl,
      token,
      adminSecret: this.adminSecret,
      fetchImpl: this.fetchImpl,
    });
  }

  withAdminSecret(adminSecret: string): MailagentsAgentClient {
    return new MailagentsAgentClient({
      baseUrl: this.baseUrl,
      token: this.token,
      adminSecret,
      fetchImpl: this.fetchImpl,
    });
  }

  operator(adminSecret?: string): MailagentsOperatorClient {
    if (adminSecret) {
      return new MailagentsOperatorClient(this.withAdminSecret(adminSecret));
    }

    if (!this.adminSecret) {
      throw new MailagentsClientError("adminSecret is required for operator()");
    }

    return new MailagentsOperatorClient(this);
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
    options?: { adminSecret?: string }
  ): Promise<CreateAccessTokenResult> {
    const adminSecret = options?.adminSecret ?? this.adminSecret;
    if (!adminSecret) {
      throw new MailagentsClientError("adminSecret is required for createAccessToken()");
    }

    return this.requestJson("/v1/auth/tokens", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-secret": adminSecret,
      },
      body: JSON.stringify(input),
    });
  }

  async adminCreateAccessToken(input: CreateAccessTokenRequest): Promise<AdminCreateAccessTokenResult> {
    return this.callAdminTool<AdminCreateAccessTokenResult>("create_access_token", input);
  }

  async adminBootstrapMailboxAgentToken(input: {
    tenantId: string;
    mailboxId: string;
    agentId?: string;
    mode?: "read_only" | "draft_only" | "send";
    expiresInSeconds?: number;
    sub?: string;
  }): Promise<AdminBootstrapMailboxAgentTokenResult> {
    return this.callAdminTool<AdminBootstrapMailboxAgentTokenResult>("bootstrap_mailbox_agent_token", input);
  }

  async adminBootstrapMailboxAgentWorkflow(input: {
    tenantId: string;
    mailboxId: string;
    agentId?: string;
    mode?: "read_only" | "draft_only" | "send";
    expiresInSeconds?: number;
    sub?: string;
  }): Promise<AdminBootstrapMailboxAgentWorkflowResult> {
    const bootstrap = await this.adminBootstrapMailboxAgentToken(input);
    const client = this.withToken(bootstrap.token);
    const workflow = await client.getMailboxWorkflowSurface();
    return {
      bootstrap,
      client,
      workflow,
    };
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

  async listAdminTools(): Promise<AdminToolsListResult> {
    const payload = await this.callAdminMcp("tools/list", {});
    return payload.result;
  }

  async getAdminMcpMetadata(): Promise<AdminMcpMetadata> {
    const payload = await this.callAdminMcp("initialize", {});
    return payload.result.meta.adminMcp as AdminMcpMetadata;
  }

  async getAdminWorkflowSurface(): Promise<AdminWorkflowSurface> {
    const [metadata, toolsResult] = await Promise.all([
      this.getAdminMcpMetadata(),
      this.listAdminTools(),
    ]);
    const tools = toolsResult.tools;
    const compositeTools = metadata.workflows
      .map((workflow) => tools.find((tool) => tool.name === workflow.compositeTool))
      .filter((tool): tool is AdminMcpToolDefinition => Boolean(tool));

    return {
      metadata,
      workflows: metadata.workflows,
      tools,
      compositeTools,
      privileged: tools.filter((tool) => tool.annotations.riskLevel === "privileged"),
      tokenAdmin: filterAdminToolsByCategory(tools, "token_admin"),
      registryAdmin: filterAdminToolsByCategory(tools, "registry_admin"),
      policyAdmin: filterAdminToolsByCategory(tools, "policy_admin"),
      debug: filterAdminToolsByCategory(tools, "debug"),
      suppression: filterAdminToolsByCategory(tools, "suppression"),
    };
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

  async adminListAgents(tenantId?: string): Promise<{ items: AgentRecord[] }> {
    return this.callAdminTool<{ items: AgentRecord[] }>("list_agents", tenantId ? { tenantId } : {});
  }

  async adminGetAgent(agentId: string): Promise<AgentRecord> {
    return this.callAdminTool<AgentRecord>("get_agent", { agentId });
  }

  async adminListMailboxes(tenantId?: string): Promise<{ items: MailboxRecord[] }> {
    return this.callAdminTool<{ items: MailboxRecord[] }>("list_mailboxes", tenantId ? { tenantId } : {});
  }

  async adminGetMailbox(args: { mailboxId?: string; address?: string }): Promise<MailboxRecord> {
    return this.callAdminTool<MailboxRecord>("get_mailbox", args);
  }

  async adminGetTenantSendPolicy(tenantId: string): Promise<TenantSendPolicyRecord> {
    return this.callAdminTool<TenantSendPolicyRecord>("get_tenant_send_policy", { tenantId });
  }

  async adminUpsertTenantSendPolicy(input: {
    tenantId: string;
    pricingTier: PricingTier;
    outboundStatus: TenantOutboundStatus;
    internalDomainAllowlist?: string[];
    externalSendEnabled: boolean;
    reviewRequired: boolean;
  }): Promise<TenantSendPolicyRecord> {
    return this.callAdminTool<TenantSendPolicyRecord>("upsert_tenant_send_policy", input);
  }

  async adminApplyTenantSendPolicyReview(input: {
    tenantId: string;
    decision: "approve_external" | "reset_review" | "suspend_outbound";
  }): Promise<AdminReviewDecisionResult> {
    return this.callAdminTool<AdminReviewDecisionResult>("apply_tenant_send_policy_review", input);
  }

  async adminGetTenantReviewContext(input: {
    tenantId: string;
    receiptsLimit?: number;
  }): Promise<AdminTenantReviewContextResult> {
    return this.callAdminTool<AdminTenantReviewContextResult>("get_tenant_review_context", input);
  }

  async adminReviewTenantOutboundAccessWorkflow(input: {
    tenantId: string;
    receiptsLimit?: number;
    decision?: "approve_external" | "reset_review" | "suspend_outbound";
  }): Promise<AdminReviewTenantOutboundAccessWorkflowResult> {
    const context = await this.adminGetTenantReviewContext({
      tenantId: input.tenantId,
      receiptsLimit: input.receiptsLimit,
    });
    const decisionResult = input.decision
      ? await this.adminApplyTenantSendPolicyReview({
        tenantId: input.tenantId,
        decision: input.decision,
      })
      : undefined;

    return {
      context,
      decision: input.decision,
      decisionResult,
      effectiveSendPolicy: decisionResult?.sendPolicy ?? context.sendPolicy,
      suggestedActions: context.summary.suggestedActions,
    };
  }

  async adminGetDebugMessage(messageId: string): Promise<DebugMessageResult> {
    return this.callAdminTool<DebugMessageResult>("get_debug_message", { messageId });
  }

  async adminGetDebugDraft(draftId: string): Promise<DebugDraftResult> {
    return this.callAdminTool<DebugDraftResult>("get_debug_draft", { draftId });
  }

  async adminGetDebugOutboundJob(outboundJobId: string): Promise<{
    id: string;
    messageId: string;
    taskId?: string;
    status: OutboundJobStatus;
    sesRegion: string;
    retryCount: number;
    nextRetryAt?: string;
    lastError?: string;
    draftR2Key: string;
    createdAt: string;
    updatedAt: string;
  }> {
    return this.callAdminTool("get_debug_outbound_job", { outboundJobId });
  }

  async adminGetSuppression(email: string): Promise<SuppressionRecord> {
    return this.callAdminTool<SuppressionRecord>("get_suppression", { email });
  }

  async adminInspectDeliveryCase(input: {
    messageId?: string;
    draftId?: string;
    outboundJobId?: string;
    email?: string;
    includePayload?: boolean;
  }): Promise<AdminInspectDeliveryCaseResult> {
    return this.callAdminTool<AdminInspectDeliveryCaseResult>("inspect_delivery_case", input);
  }

  async adminInspectDeliveryCaseWorkflow(input: {
    messageId?: string;
    draftId?: string;
    outboundJobId?: string;
    email?: string;
    includePayload?: boolean;
  }): Promise<AdminInspectDeliveryCaseWorkflowResult> {
    const inspection = await this.adminInspectDeliveryCase(input);
    return {
      inspection,
      summary: summarizeAdminDeliveryInspection(inspection),
    };
  }

  async adminAddSuppression(input: {
    email: string;
    reason?: string;
    source?: string;
  }): Promise<{
    ok: true;
    email: string;
    reason: string;
    source: string;
  }> {
    return this.callAdminTool("add_suppression", input);
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

  async callTool<T>(name: string, args: object): Promise<T> {
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

    return unwrapMcpToolResult<T>(payload);
  }

  async callAdminTool<T>(name: string, args: object): Promise<T> {
    const payload = await this.callAdminMcp("tools/call", {
      name,
      arguments: args,
    });

    if (payload.result && typeof payload.result === "object" && "isError" in payload.result && payload.result.isError) {
      const toolError = payload.result as McpToolErrorResult;
      throw new MailagentsClientError(
        toolError.structuredContent?.error?.message ?? "Admin MCP tool call failed",
        { errorCode: getStructuredToolErrorCode(payload) }
      );
    }

    return unwrapMcpToolResult<T>(payload);
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

  async getOutboundJob(outboundJobId: string): Promise<OutboundJobStatusResult> {
    return this.requestJson(`/v1/outbound-jobs/${encodeURIComponent(outboundJobId)}`);
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
    if (args.attachments?.length) {
      if (args.mailboxId) {
        throw new MailagentsClientError(
          "attachments are only supported for self-mailbox HTTP sends; mailboxId cannot be honored"
        );
      }

      return this.sendMessage(args);
    }

    if (!args.mailboxId) {
      return this.sendMessage(args);
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
      const errorPayload = payload && typeof payload === "object" ? payload as {
        error?: unknown;
        message?: unknown;
        code?: unknown;
      } : undefined;
      throw new MailagentsClientError(
        typeof errorPayload?.message === "string"
          ? errorPayload.message
          : typeof errorPayload?.error === "string"
            ? errorPayload.error
            : `HTTP request failed: ${response.status}`,
        {
        status: response.status,
        errorCode: typeof errorPayload?.code === "string" ? errorPayload.code : undefined,
      });
    }
    return payload as T;
  }

  private async callMcp(method: string, params: Record<string, unknown>): Promise<JsonRpcSuccess<any> & JsonRpcFailure> {
    return this.callMcpAtPath("/mcp", method, params, this.token ? { authorization: `Bearer ${this.token}` } : {});
  }

  private async callAdminMcp(method: string, params: Record<string, unknown>): Promise<JsonRpcSuccess<any> & JsonRpcFailure> {
    if (!this.adminSecret) {
      throw new MailagentsClientError("adminSecret is required for admin MCP calls");
    }

    return this.callMcpAtPath("/admin/mcp", method, params, {
      "x-admin-secret": this.adminSecret,
    });
  }

  private async callMcpAtPath(
    path: string,
    method: string,
    params: Record<string, unknown>,
    extraHeaders: Record<string, string>
  ): Promise<JsonRpcSuccess<any> & JsonRpcFailure> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
    });

    const payload = (await response.json()) as JsonRpcSuccess<any> & JsonRpcFailure;
    if (payload.error) {
      throw new MailagentsClientError(payload.error.message, {
        status: response.status,
        errorCode: typeof payload.error.data === "object" && payload.error.data && "errorCode" in payload.error.data
          ? String((payload.error.data as { errorCode?: unknown }).errorCode ?? "")
          : undefined,
      });
    }
    if (!response.ok) {
      throw new MailagentsClientError(`MCP request failed: ${response.status}`, {
        status: response.status,
      });
    }
    return payload;
  }
}

export class MailagentsOperatorClient {
  constructor(private readonly client: MailagentsAgentClient) {}

  withAdminSecret(adminSecret: string): MailagentsOperatorClient {
    return new MailagentsOperatorClient(this.client.withAdminSecret(adminSecret));
  }

  asAgentClient(): MailagentsAgentClient {
    return this.client;
  }

  async getCapabilitySurface(): Promise<OperatorCapabilitySurface> {
    const [runtime, compatibility, admin] = await Promise.all([
      this.client.getRuntimeMetadata(),
      this.client.getCompatibilityContract(),
      this.client.getAdminWorkflowSurface(),
    ]);

    return {
      runtime,
      compatibility,
      admin,
    };
  }

  async getWorkflowSurface(): Promise<AdminWorkflowSurface> {
    return this.client.getAdminWorkflowSurface();
  }

  async mintAccessToken(input: CreateAccessTokenRequest): Promise<AdminCreateAccessTokenResult> {
    return this.client.adminCreateAccessToken(input);
  }

  async bootstrapMailboxAgent(input: {
    tenantId: string;
    mailboxId: string;
    agentId?: string;
    mode?: "read_only" | "draft_only" | "send";
    expiresInSeconds?: number;
    sub?: string;
  }): Promise<AdminBootstrapMailboxAgentWorkflowResult> {
    return this.client.adminBootstrapMailboxAgentWorkflow(input);
  }

  async openMailboxSession(input: OperatorMailboxSessionInput): Promise<MailagentsOperatorMailboxSession> {
    const result = await this.bootstrapMailboxAgent(input);
    return new MailagentsOperatorMailboxSession(result);
  }

  async listAgents(tenantId?: string): Promise<{ items: AgentRecord[] }> {
    return this.client.adminListAgents(tenantId);
  }

  async getAgent(agentId: string): Promise<AgentRecord> {
    return this.client.adminGetAgent(agentId);
  }

  async listMailboxes(tenantId?: string): Promise<{ items: MailboxRecord[] }> {
    return this.client.adminListMailboxes(tenantId);
  }

  async getMailbox(args: { mailboxId?: string; address?: string }): Promise<MailboxRecord> {
    return this.client.adminGetMailbox(args);
  }

  async getTenantSendPolicy(tenantId: string): Promise<TenantSendPolicyRecord> {
    return this.client.adminGetTenantSendPolicy(tenantId);
  }

  async reviewTenantOutboundAccess(input: {
    tenantId: string;
    receiptsLimit?: number;
    decision?: "approve_external" | "reset_review" | "suspend_outbound";
  }): Promise<AdminReviewTenantOutboundAccessWorkflowResult> {
    return this.client.adminReviewTenantOutboundAccessWorkflow(input);
  }

  async inspectDeliveryCase(input: {
    messageId?: string;
    draftId?: string;
    outboundJobId?: string;
    email?: string;
    includePayload?: boolean;
  }): Promise<AdminInspectDeliveryCaseWorkflowResult> {
    return this.client.adminInspectDeliveryCaseWorkflow(input);
  }

  async getSuppression(email: string): Promise<SuppressionRecord> {
    return this.client.adminGetSuppression(email);
  }

  async addSuppression(input: {
    email: string;
    reason?: string;
    source?: string;
  }): Promise<{
    ok: true;
    email: string;
    reason: string;
    source: string;
  }> {
    return this.client.adminAddSuppression(input);
  }
}

export class MailagentsOperatorMailboxSession {
  readonly bootstrap: AdminBootstrapMailboxAgentTokenResult;
  readonly workflow: MailboxWorkflowSurface;
  private readonly client: MailagentsAgentClient;

  constructor(result: AdminBootstrapMailboxAgentWorkflowResult) {
    this.bootstrap = result.bootstrap;
    this.workflow = result.workflow;
    this.client = result.client;
  }

  get mailbox(): { id: string; address: string } {
    return this.bootstrap.mailbox;
  }

  get agentId(): string | undefined {
    return this.bootstrap.agentId;
  }

  get scopeProfile(): "read_only" | "draft_only" | "send" {
    return this.bootstrap.scopeProfile;
  }

  get expiresAt(): string {
    return this.bootstrap.expiresAt;
  }

  get visibleTools(): AdminBootstrapMailboxAgentTokenResult["visibleTools"] {
    return this.bootstrap.visibleTools;
  }

  get nextSteps(): string[] {
    return this.bootstrap.nextSteps;
  }

  asAgentClient(): MailagentsAgentClient {
    return this.client;
  }

  async getSelfMailbox(): Promise<SelfMailboxRecord> {
    return this.client.getSelfMailbox();
  }

  async listTools(): Promise<ToolsListResult> {
    return this.client.listTools();
  }

  async listTasks(args: {
    status?: TaskStatus;
  } = {}): Promise<{ items: TaskRecord[] }> {
    return this.client.listTasks(args);
  }

  async listMessages(args: {
    limit?: number;
    search?: string;
    direction?: MessageDirection;
    status?: MessageStatus;
  } = {}): Promise<ListMessagesResult> {
    return this.client.listMessages(args);
  }

  async getWorkflowSurface(): Promise<MailboxWorkflowSurface> {
    return this.workflow;
  }

  async sendEmail(args: {
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
    return this.client.sendEmail(args);
  }

  async replyLatestInbound(args: {
    text?: string;
    html?: string;
    idempotencyKey?: string;
  }): Promise<ReplyAccepted> {
    return this.client.replyLatestInbound(args);
  }

  async replyToMessage(args: {
    messageId: string;
    text?: string;
    html?: string;
    idempotencyKey?: string;
  }): Promise<ReplyAccepted> {
    return this.client.replyToMessage(args);
  }
}
