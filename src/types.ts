export type AgentMode = "assistant" | "autonomous" | "review_only";
export type AgentStatus = "draft" | "active" | "disabled" | "archived";
export type AgentVersionStatus = "draft" | "published" | "deprecated";
export type AgentDeploymentStatus = "active" | "paused" | "rolled_back";
export type TaskStatus = "queued" | "running" | "done" | "needs_review" | "failed";
export type DraftStatus = "draft" | "approved" | "queued" | "sent" | "cancelled" | "failed";
export type MessageStatus = "received" | "normalized" | "tasked" | "replied" | "ignored" | "failed";
export type OutboundJobStatus = "queued" | "sending" | "sent" | "retry" | "failed";
export type DeliveryEventType = "delivery" | "bounce" | "complaint" | "reject" | "unknown";
export type TenantBillingStatus = "trial" | "active" | "delinquent" | "suspended";
export type PricingTier = "free" | "paid_review" | "paid_active" | "enterprise";
export type CreditLedgerEntryType = "topup" | "debit_send" | "debit_reply" | "refund" | "adjustment";
export type PaymentReceiptType = "topup" | "upgrade" | "refund" | "adjustment";
export type PaymentReceiptStatus = "pending" | "verified" | "settled" | "failed" | "refunded";
export type DidBindingStatus = "pending" | "verified" | "revoked";
export type TenantOutboundStatus = "internal_only" | "external_review" | "external_enabled" | "suspended";
export type OutboundProvider = "ses" | "resend";

export interface MailboxRecord {
  id: string;
  tenantId: string;
  address: string;
  status: string;
  createdAt: string;
}

export interface Env {
  D1_DB: D1Database;
  R2_EMAIL: R2Bucket;
  EMAIL_INGEST_QUEUE: Queue<EmailIngestJob>;
  AGENT_EXECUTE_QUEUE: Queue<AgentExecuteJob>;
  OUTBOUND_SEND_QUEUE: Queue<OutboundSendJob>;
  DEAD_LETTER_QUEUE: Queue<DeadLetterJob>;
  SES_REGION: string;
  SES_FROM_DOMAIN: string;
  SES_CONFIGURATION_SET: string;
  SES_ACCESS_KEY_ID?: string;
  SES_SECRET_ACCESS_KEY?: string;
  SES_ACCESS_KEY?: string;
  SES_SECRET_KEY?: string;
  SES_MOCK_SEND?: string;
  SES_MOCK_SEND_DELAY_MS?: string;
  OUTBOUND_PROVIDER?: string;
  RESEND_API_KEY?: string;
  RESEND_API_BASE_URL?: string;
  WEBHOOK_SHARED_SECRET?: string;
  API_SIGNING_SECRET?: string;
  SELF_SERVE_ACCESS_TOKEN_TTL_SECONDS?: string;
  ADMIN_API_SECRET?: string;
  ADMIN_ROUTES_ENABLED?: string;
  DEBUG_ROUTES_ENABLED?: string;
  IDEMPOTENCY_COMPLETED_RETENTION_HOURS?: string;
  IDEMPOTENCY_PENDING_RETENTION_HOURS?: string;
  CONTACT_ALIAS_ROUTING_BOOTSTRAP_ENABLED?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ZONE_ID?: string;
  CLOUDFLARE_EMAIL_DOMAIN?: string;
  CLOUDFLARE_EMAIL_WORKER?: string;
  PUBLIC_TOKEN_REISSUE_MAILBOX_COOLDOWN_SECONDS?: string;
  PUBLIC_TOKEN_REISSUE_IP_WINDOW_SECONDS?: string;
  PUBLIC_TOKEN_REISSUE_IP_MAX_REQUESTS?: string;
  OUTBOUND_SEND_MAX_RETRIES?: string;
  OUTBOUND_SEND_IN_DOUBT_GRACE_SECONDS?: string;
  X402_DEFAULT_SCHEME?: string;
  X402_DEFAULT_NETWORK_ID?: string;
  X402_DEFAULT_ASSET?: string;
  X402_PAY_TO?: string;
  X402_PRICE_PER_CREDIT_USD?: string;
  X402_UPGRADE_PRICE_USD?: string;
  X402_FACILITATOR_URL?: string;
  X402_FACILITATOR_VERIFY_PATH?: string;
  X402_FACILITATOR_SETTLE_PATH?: string;
  X402_FACILITATOR_AUTH_TOKEN?: string;
  X402_FACILITATOR_MOCK_VERIFY_RESULT?: string;
  X402_FACILITATOR_MOCK_SETTLE_RESULT?: string;
}

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

export interface AgentCapabilityRecord {
  id: string;
  capability: string;
  config?: Record<string, unknown>;
}

export interface AgentToolBindingSummary {
  id: string;
  toolName: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}

export interface AgentVersionRecord {
  id: string;
  agentId: string;
  version: string;
  model?: string;
  configR2Key?: string;
  manifestR2Key?: string;
  status: AgentVersionStatus;
  capabilities: AgentCapabilityRecord[];
  tools: AgentToolBindingSummary[];
  createdAt: string;
}

export interface AgentDeploymentRecord {
  id: string;
  tenantId: string;
  agentId: string;
  agentVersionId: string;
  targetType: "mailbox" | "workflow" | "tenant_default";
  targetId: string;
  status: AgentDeploymentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AgentExecutionTarget {
  agentId: string;
  agentVersionId?: string;
  deploymentId?: string;
}

export interface AgentMailboxBindingRecord {
  id: string;
  agentId: string;
  mailboxId: string;
  role: "primary" | "shared" | "send_only" | "receive_only";
  status: "active" | "disabled";
  createdAt: string;
}

export interface AgentPolicyRecord {
  agentId: string;
  autoReplyEnabled: boolean;
  humanReviewRequired: boolean;
  confidenceThreshold: number;
  maxAutoRepliesPerThread: number;
  allowedRecipientDomains: string[];
  blockedSenderDomains: string[];
  allowedTools: string[];
  updatedAt: string;
}

export interface BillingAccountRecord {
  tenantId: string;
  status: TenantBillingStatus;
  pricingTier: PricingTier;
  defaultNetwork?: string;
  defaultAsset?: string;
  availableCredits: number;
  reservedCredits: number;
  updatedAt: string;
}

export interface CreditLedgerEntryRecord<TMetadata extends object | undefined = Record<string, unknown> | undefined> {
  id: string;
  tenantId: string;
  entryType: CreditLedgerEntryType;
  creditsDelta: number;
  reason: string;
  paymentReceiptId?: string;
  referenceId?: string;
  metadata?: TMetadata;
  createdAt: string;
}

export interface PaymentReceiptRecord<TMetadata extends object | undefined = Record<string, unknown> | undefined> {
  id: string;
  tenantId: string;
  receiptType: PaymentReceiptType;
  paymentScheme: string;
  network?: string;
  asset?: string;
  amountAtomic: string;
  amountDisplay?: string;
  paymentReference?: string;
  settlementReference?: string;
  status: PaymentReceiptStatus;
  metadata?: TMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface DidBindingRecord {
  tenantId: string;
  did: string;
  method: string;
  documentUrl?: string;
  status: DidBindingStatus;
  verificationMethodId?: string;
  service: Array<Record<string, unknown>>;
  verifiedAt?: string;
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
  updatedAt: string;
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
  direction: "inbound" | "outbound";
  provider: "cloudflare" | OutboundProvider;
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

export interface AttachmentSummary {
  id: string;
  filename?: string;
  contentType?: string;
  sizeBytes: number;
  downloadUrl?: string;
}

export interface MessageContentRecord {
  text?: string;
  html?: string;
  attachments: AttachmentSummary[];
}

export interface ThreadRecord {
  id: string;
  tenantId: string;
  mailboxId: string;
  subjectNorm?: string;
  status?: string;
  messages: MessageRecord[];
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

export interface OutboundJobRecord {
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
}

export interface IdempotencyRecord<T = unknown> {
  operation: string;
  tenantId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  status: "pending" | "completed";
  resourceId?: string;
  response?: T;
  createdAt: string;
  updatedAt: string;
}

export interface EmailIngestJob {
  messageId: string;
  tenantId: string;
  mailboxId: string;
  rawR2Key: string;
}

export interface AgentExecuteJob {
  taskId: string;
  agentId: string;
  agentVersionId?: string;
  deploymentId?: string;
}

export interface OutboundSendJob {
  outboundJobId: string;
}

export interface DeadLetterJob {
  source: string;
  refId: string;
  reason: string;
}

export interface RouteContext {
  params: Record<string, string>;
  url: URL;
}

export interface AccessTokenClaims {
  sub: string;
  tenantId: string;
  agentId?: string;
  scopes: string[];
  mailboxIds?: string[];
  exp: number;
}
