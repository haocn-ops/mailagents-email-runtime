import { createId } from "../lib/ids";
import {
  enforceMailboxAccess,
  enforceScopedAgentAccess,
  enforceTenantAccess,
  mintAccessToken,
  requireAdminRoutesEnabled,
  requireAdminSecret,
  requireAuth,
  requireDebugRoutesEnabled,
} from "../lib/auth";
import { accepted, badRequest, InvalidJsonBodyError, json, notFound, readJson, readOptionalJson } from "../lib/http";
import { Router } from "../lib/router";
import { buildCompatibilityContract, buildRuntimeMetadata, COMPATIBILITY_CONTRACT_SCHEMA } from "../lib/runtime-metadata";
import { normalizeSesEvent } from "../lib/ses-events";
import {
  buildTokenReissueHtml,
  buildTokenReissueText,
  parseSelfServeSignup,
  performSelfServeSignup,
  SignupError,
} from "../lib/self-serve";
import { issueSelfServeAccessToken, SELF_SERVE_DEFAULT_SCOPES } from "../lib/provisioning/default-access";
import { buildDidWebDocument, buildHostedDidWeb, defaultHostedDidServices, isPublishedHostedDidBinding } from "../lib/did-web";
import { releaseOutboundUsageReservation, settleOutboundUsageDebit } from "../lib/outbound-billing";
import { checkOutboundCreditRequirement } from "../lib/outbound-credits";
import { evaluateOutboundPolicy } from "../lib/outbound-policy";
import { relaxTenantDefaultAgentRecipientPoliciesForExternalSend } from "../lib/self-serve-agent-policy";
import { ensureSystemSendAllowed } from "../lib/system-sends";
import { syncTenantDefaultAgentRecipientPoliciesForInternalDomainChange } from "../lib/self-serve-agent-policy";
import {
  AgentRegistryConflictError,
  bindMailbox,
  createAgent,
  createAgentDeployment,
  createAgentVersion,
  DeploymentConflictError,
  getAgent,
  getAgentDeployment,
  getAgentVersion,
  hasActiveMailboxBinding,
  hasActiveMailboxDeployment,
  MailboxConflictError,
  getMailboxByAddress,
  getMailboxById,
  listAgentDeployments,
  listAgentMailboxes,
  listAgents,
  listAgentVersions,
  resolveAgentExecutionTarget,
  rollbackAgentDeployment,
  rolloutAgentDeployment,
  updateAgent,
  updateAgentDeploymentStatus,
  upsertAgentPolicy,
} from "../repositories/agents";
import {
  backfillMessageProviderAcceptance,
  createDraft,
  createTask,
  deleteDraftIfUnqueued,
  deleteTask,
  enqueueDraftSend,
  completeIdempotencyKey,
  getDraft,
  getDraftByR2KeyForOutboundLifecycle,
  getAttachmentOwnerByR2Key,
  getMessage,
  getMessageByProviderMessageId,
  getMessageContent,
  listMessages,
  getThread,
  getOutboundJobByDraftR2Key,
  getOutboundJobByMessageId,
  getOutboundJob,
  getSuppression,
  insertDeliveryEvent,
  listTasks,
  listDeliveryEventsByMessageId,
  markDraftStatus,
  releaseIdempotencyKey,
  reserveIdempotencyKey,
  updateIdempotencyKeyResource,
  addSuppression,
  updateOutboundJobStatus,
  updateMessageStatus,
  updateMessageStatusByProviderMessageId,
} from "../repositories/mail";
import {
  countRecentIpTokenReissues,
  getIpMaxRequests,
  getIpWindowSeconds,
  getMailboxCooldownSeconds,
  hasRecentMailboxTokenReissue,
  logTokenReissueRequest,
} from "../repositories/token-reissue";
import {
  appendUpgradeCreditGrantLedgerEntry,
  appendTopupSettlementLedgerEntry,
  BillingUniquenessError,
  createTypedTenantPaymentReceipt,
  ensureTenantBillingAccount,
  getTypedCreditLedgerEntryByPaymentReceiptId,
  getTypedPaymentReceiptByProofFingerprint,
  getTypedTenantPaymentReceiptById,
  listTypedTenantCreditLedger,
  listTypedTenantPaymentReceipts,
  reconcileTenantAvailableCredits,
  updateTenantBillingAccountProfile,
  updateTypedTenantPaymentReceiptStatus,
} from "../repositories/billing";
import {
  DidBindingConflictError,
  getTenantDidBinding,
  upsertTenantDidBinding,
} from "../repositories/did-bindings";
import {
  ensureTenantSendPolicy,
  upsertTenantSendPolicy,
} from "../repositories/tenant-policies";
import {
  getX402FacilitatorConfig,
  parseStoredX402SettlementResponse,
  parseStoredX402VerificationResponse,
  settleX402Payment,
  verifyX402Payment,
  type X402FacilitatorSettlementResponse,
  type X402FacilitatorVerificationResponse,
} from "../lib/payments/x402-facilitator";
import {
  buildUpgradeCreditGrantLedgerMetadata,
  buildTopupSettlementLedgerMetadata,
  isTopupSettlementLedgerEntry,
  isUpgradeCreditGrantLedgerEntry,
} from "../lib/payments/ledger-metadata";
import {
  buildTopupReceiptMetadata,
  buildUpgradeReceiptMetadata,
  fingerprintPaymentProof,
  getReceiptPaymentPayload,
  getReceiptPaymentRequirements,
  type TypedPaymentReceiptRecord,
  withReceiptConfirmation,
} from "../lib/payments/receipt-metadata";
import {
  buildX402UpgradeQuote,
  buildX402TopupQuote,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  getX402Defaults,
  parseX402PaymentProof,
  X402_PAYMENT_REQUIRED_HEADER,
  X402_PAYMENT_RESPONSE_HEADER,
  X402_PAYMENT_SIGNATURE_HEADER,
} from "../lib/payments/x402";
import type { AccessTokenClaims, Env } from "../types";

const router = new Router<Env>();
const RECEIVE_CAPABLE_MAILBOX_ROLES = ["primary", "shared", "receive_only"] as const;
const SEND_CAPABLE_MAILBOX_ROLES = ["primary", "shared", "send_only"] as const;
const AGENT_REQUIRED_MAILBOX_SCOPES = ["task:read", "draft:create", "draft:read", "draft:send", "mail:replay"] as const;

async function findPaymentReceiptReplay(
  env: Env,
  tenantId: string,
  paymentProofFingerprint: string,
): Promise<TypedPaymentReceiptRecord | Response | null> {
  const existingReceipt = await getTypedPaymentReceiptByProofFingerprint(env, paymentProofFingerprint);
  if (!existingReceipt) {
    return null;
  }

  if (existingReceipt.tenantId !== tenantId) {
    return badRequest("payment proof has already been submitted");
  }

  return existingReceipt;
}

function paymentReceiptReplayResponse(receipt: TypedPaymentReceiptRecord): Response {
  return accepted({
    receiptId: receipt.id,
    receipt,
    verificationStatus: receipt.status,
    message: "Payment proof already captured. Reusing the existing receipt.",
  });
}
const PUBLIC_SELF_SERVE_ALLOW_METHODS = "POST, OPTIONS";
const PUBLIC_SELF_SERVE_ALLOW_HEADERS = "content-type";
const AUTHENTICATED_API_DEFAULT_ALLOW_HEADERS = "authorization, content-type, x-admin-secret";
const AUTHENTICATED_API_METADATA_ALLOW_HEADERS = "content-type";

class RouteRequestError extends Error {
  readonly status: number;
  readonly body?: Record<string, unknown>;

  constructor(message: string, status: number, body?: Record<string, unknown>) {
    super(message);
    this.name = "RouteRequestError";
    this.status = status;
    this.body = body;
  }
}

function buildInsufficientCreditsErrorBody(input: {
  availableCredits?: number;
  creditsRequired: number;
}): Record<string, unknown> {
  const currentCredits = input.availableCredits ?? 0;
  return {
    error: `Insufficient credits for external sending. Required: ${input.creditsRequired}, available: ${currentCredits}`,
    code: "insufficient_credits",
    currentCredits,
    requiredCredits: input.creditsRequired,
    suggestedAction: "Use POST /v1/billing/topup to add credits, then retry the send with the same idempotency key if applicable.",
    docUrl: "/limits",
  };
}

function createInsufficientCreditsRouteError(input: {
  availableCredits?: number;
  creditsRequired: number;
}): RouteRequestError {
  const body = buildInsufficientCreditsErrorBody(input);
  return new RouteRequestError(String(body.error), 402, body);
}

function buildBillingAccountResponse(account: Awaited<ReturnType<typeof ensureTenantBillingAccount>>) {
  return {
    ...account,
    totalCredits: account.availableCredits + account.reservedCredits,
    spendableCredits: account.availableCredits,
    pendingReservedCredits: account.reservedCredits,
  };
}

function buildSendStatusCheck(outboundJobId: string, draftId: string) {
  return {
    outboundJobPath: `/v1/outbound-jobs/${encodeURIComponent(outboundJobId)}`,
    draftPath: `/v1/drafts/${encodeURIComponent(draftId)}`,
  };
}

function buildQueuedSendAcceptedResponse(input: {
  draftId: string;
  outboundJobId: string;
  status: "queued";
}) {
  return {
    ...input,
    acceptedForDelivery: true,
    deliveryState: "queued" as const,
    finalDeliveryState: "pending" as const,
    statusCheck: buildSendStatusCheck(input.outboundJobId, input.draftId),
    message: "Send queued for asynchronous delivery. Accepted means the runtime queued the send, not that the provider has delivered it yet. Poll statusCheck.outboundJobPath for the current pending, sent, or failed delivery state.",
  };
}

function buildQueuedCreateAndSendAcceptedResponse(input: {
  draft: Awaited<ReturnType<typeof createDraft>>;
  outboundJobId: string;
  status: "queued";
}) {
  return {
    ...input,
    acceptedForDelivery: true,
    deliveryState: "queued" as const,
    finalDeliveryState: "pending" as const,
    statusCheck: buildSendStatusCheck(input.outboundJobId, input.draft.id),
    message: "Send queued for asynchronous delivery. Accepted means the runtime queued the send, not that the provider has delivered it yet. Poll statusCheck.outboundJobPath for the current pending, sent, or failed delivery state.",
  };
}

function buildMissingReceiptIdResponse(): Response {
  return json({
    error: "receiptId is required",
    code: "missing_receipt_id",
    message: "Pass the receipt id returned as receipt.id or receiptId from POST /v1/billing/topup or POST /v1/billing/upgrade-intent. You can also look it up with GET /v1/billing/receipts.",
    suggestedAction: "Read the prior billing response, copy receipt.id, and retry POST /v1/billing/payment/confirm with {\"receiptId\":\"...\"}.",
    receiptSources: [
      "POST /v1/billing/topup",
      "POST /v1/billing/upgrade-intent",
      "GET /v1/billing/receipts",
    ],
  }, { status: 400 });
}

function buildReceiptNotFoundResponse(): Response {
  return json({
    error: "Payment receipt not found",
    code: "receipt_not_found",
    message: "POST /v1/billing/payment/confirm only accepts a Mailagents receipt id such as prc_... from POST /v1/billing/topup, POST /v1/billing/upgrade-intent, or GET /v1/billing/receipts.",
    suggestedAction: "Read the earlier billing response or call GET /v1/billing/receipts, then retry with the runtime receipt.id. Do not pass a blockchain transaction hash, chain receipt hash, or facilitator reference as receiptId.",
    receiptSources: [
      "POST /v1/billing/topup",
      "POST /v1/billing/upgrade-intent",
      "GET /v1/billing/receipts",
    ],
  }, { status: 404 });
}

function markSideEffectCommitted(error: unknown): unknown {
  if (error instanceof Error) {
    Object.assign(error, { sideEffectCommitted: true });
  }
  return error;
}

function hasCommittedSideEffect(error: unknown): boolean {
  return error instanceof Error && (error as Error & { sideEffectCommitted?: boolean }).sideEffectCommitted === true;
}

async function bestEffortCompleteRecoveredIdempotency(env: Env, input: {
  operation: string;
  tenantId: string;
  idempotencyKey: string;
  resourceId?: string;
  response: unknown;
}): Promise<void> {
  try {
    await completeIdempotencyKey(env, input);
  } catch {
    // Recovery should still succeed even if the pending idempotency row cannot be repaired inline.
  }
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function buildSesPayloadR2Key(body: unknown): Promise<string> {
  const digest = await sha256Hex(JSON.stringify(body));
  return `events/ses/${digest}.json`;
}

async function enqueueReplayTask(env: Env, input: {
  tenantId: string;
  mailboxId: string;
  sourceMessageId: string;
  agentId: string;
  agentVersionId?: string;
  deploymentId?: string;
}) {
  const replayTask = await createTask(env, {
    tenantId: input.tenantId,
    mailboxId: input.mailboxId,
    sourceMessageId: input.sourceMessageId,
    taskType: "replay",
    priority: 50,
    status: "queued",
    assignedAgent: input.agentId,
  });

  try {
    await env.AGENT_EXECUTE_QUEUE.send({
      taskId: replayTask.id,
      agentId: input.agentId,
      agentVersionId: input.agentVersionId,
      deploymentId: input.deploymentId,
    });
  } catch (error) {
    await deleteTask(env, replayTask.id).catch(() => undefined);
    throw error;
  }
}

async function restoreDraftSendReplay(env: Env, draftId: string | undefined) {
  if (!draftId) {
    throw new RouteRequestError("Stored idempotent draft send result is incomplete", 500);
  }

  let draft = await getDraft(env, draftId);
  if (!draft) {
    throw new RouteRequestError("Stored idempotent draft no longer exists", 409);
  }

  let outboundJob = await getOutboundJobByDraftR2Key(env, draft.draftR2Key);
  if (!outboundJob) {
    if (draft.status !== "draft" && draft.status !== "approved") {
      throw new RouteRequestError("Stored idempotent outbound job no longer exists", 409);
    }

    const resumed = await enqueueDraftSend(env, draft.id);
    const resumedDraft = await getDraft(env, draft.id);
    if (!resumedDraft) {
      throw new RouteRequestError("Stored idempotent draft disappeared during replay recovery", 409);
    }
    const resumedOutboundJob = await getOutboundJob(env, resumed.outboundJobId);
    if (!resumedOutboundJob) {
      throw new RouteRequestError("Stored idempotent outbound job disappeared during replay recovery", 409);
    }
    draft = resumedDraft;
    outboundJob = resumedOutboundJob;
  }
  if (!(await getMessage(env, outboundJob.messageId))) {
    throw new RouteRequestError("Stored idempotent outbound message no longer exists", 409);
  }

  return {
    draft,
    outboundJobId: outboundJob.id,
    status: "queued" as const,
  };
}

async function restoreEnqueuedDraftSend(env: Env, input: {
  draftId: string;
  outboundJobId: string | undefined;
}) {
  if (!input.outboundJobId) {
    throw new RouteRequestError("Stored idempotent draft send result is incomplete", 500);
  }

  const draft = await getDraft(env, input.draftId);
  if (!draft) {
    throw new RouteRequestError("Stored idempotent draft no longer exists", 409);
  }

  const outboundJob = await getOutboundJob(env, input.outboundJobId);
  if (!outboundJob) {
    throw new RouteRequestError("Stored idempotent outbound job no longer exists", 409);
  }
  if (!(await getMessage(env, outboundJob.messageId))) {
    throw new RouteRequestError("Stored idempotent outbound message no longer exists", 409);
  }
  if (outboundJob.draftR2Key !== draft.draftR2Key) {
    throw new RouteRequestError("Stored idempotent outbound job does not belong to draft", 409);
  }

  return {
    draftId: input.draftId,
    outboundJobId: outboundJob.id,
    status: "queued" as const,
  };
}

async function validateDraftReferences(env: Env, input: {
  tenantId: string;
  mailboxId: string;
  threadId?: string;
  sourceMessageId?: string;
}) {
  if (input.threadId) {
    const thread = await getThread(env, input.threadId);
    if (!thread) {
      throw new RouteRequestError("Thread not found", 404);
    }
    if (thread.tenantId !== input.tenantId) {
      throw new RouteRequestError("Thread does not belong to tenant", 409);
    }
    if (thread.mailboxId !== input.mailboxId) {
      throw new RouteRequestError("Thread does not belong to mailbox", 409);
    }
  }

  if (input.sourceMessageId) {
    const sourceMessage = await getMessage(env, input.sourceMessageId);
    if (!sourceMessage) {
      throw new RouteRequestError("Source message not found", 404);
    }
    if (sourceMessage.tenantId !== input.tenantId) {
      throw new RouteRequestError("Source message does not belong to tenant", 409);
    }
    if (sourceMessage.mailboxId !== input.mailboxId) {
      throw new RouteRequestError("Source message does not belong to mailbox", 409);
    }
    if (input.threadId && sourceMessage.threadId !== input.threadId) {
      throw new RouteRequestError("Source message does not belong to thread", 409);
    }
  }
}

async function validateDraftAttachments(env: Env, input: {
  tenantId: string;
  mailboxId: string;
  attachments: Array<{ filename: string; contentType: string; r2Key: string }>;
}) {
  for (const attachment of input.attachments) {
    const r2Key = typeof attachment.r2Key === "string" ? attachment.r2Key.trim() : "";
    if (!r2Key) {
      throw new RouteRequestError("Attachment r2Key is required", 400);
    }

    const owner = await getAttachmentOwnerByR2Key(env, r2Key);
    if (!owner) {
      throw new RouteRequestError("Attachment not found", 404);
    }
    if (owner.tenantId !== input.tenantId) {
      throw new RouteRequestError("Attachment does not belong to tenant", 409);
    }
    if (owner.mailboxId !== input.mailboxId) {
      throw new RouteRequestError("Attachment does not belong to mailbox", 409);
    }
  }
}

async function validateDraftFromAddress(env: Env, input: {
  tenantId: string;
  mailboxId: string;
  from: string;
}) {
  const mailbox = await getMailboxById(env, input.mailboxId);
  if (!mailbox) {
    throw new RouteRequestError("Mailbox not found", 404);
  }
  if (mailbox.tenant_id !== input.tenantId) {
    throw new RouteRequestError("Mailbox does not belong to tenant", 409);
  }

  const expected = mailbox.address.trim().toLowerCase();
  const provided = input.from.trim().toLowerCase();
  if (!provided) {
    throw new RouteRequestError("from must match the mailbox address", 400);
  }
  if (provided !== expected) {
    throw new RouteRequestError("from must match the mailbox address", 400);
  }
}

async function readDraftRecipients(env: Env, draftR2Key: string): Promise<{
  to: string[];
  cc: string[];
  bcc: string[];
}> {
  const draftObject = await env.R2_EMAIL.get(draftR2Key);
  if (!draftObject) {
    throw new RouteRequestError("Draft payload not found", 404);
  }

  const payload = await draftObject.json<Record<string, unknown>>();
  const parseRecipientList = (value: unknown, field: "to" | "cc" | "bcc"): string[] => {
    if (value === undefined || value === null) {
      if (field === "to") {
        throw new RouteRequestError(
          "Draft recipients must include a non-empty to array and optional cc/bcc string arrays",
          400,
        );
      }
      return [];
    }

    if (!Array.isArray(value)) {
      throw new RouteRequestError(
        "Draft recipients must include a non-empty to array and optional cc/bcc string arrays",
        400,
      );
    }

    const items = value.map((item) => typeof item === "string" ? item.trim() : "");
    if (items.some((item) => !item)) {
      throw new RouteRequestError(
        "Draft recipients must include a non-empty to array and optional cc/bcc string arrays",
        400,
      );
    }
    if (field === "to" && items.length === 0) {
      throw new RouteRequestError(
        "Draft recipients must include a non-empty to array and optional cc/bcc string arrays",
        400,
      );
    }

    return items;
  };
  return {
    to: parseRecipientList(payload.to, "to"),
    cc: parseRecipientList(payload.cc, "cc"),
    bcc: parseRecipientList(payload.bcc, "bcc"),
  };
}

async function validateStoredDraftFromAddress(env: Env, draft: {
  tenantId: string;
  mailboxId: string;
  draftR2Key: string;
}) {
  const draftObject = await env.R2_EMAIL.get(draft.draftR2Key);
  if (!draftObject) {
    throw new RouteRequestError("Draft payload not found", 404);
  }

  const payload = await draftObject.json<Record<string, unknown>>();
  await validateDraftFromAddress(env, {
    tenantId: draft.tenantId,
    mailboxId: draft.mailboxId,
    from: typeof payload.from === "string" ? payload.from : "",
  });
}

async function validateStoredDraftAttachments(env: Env, draft: {
  tenantId: string;
  mailboxId: string;
  draftR2Key: string;
}) {
  const draftObject = await env.R2_EMAIL.get(draft.draftR2Key);
  if (!draftObject) {
    throw new RouteRequestError("Draft payload not found", 404);
  }

  const payload = await draftObject.json<Record<string, unknown>>();
  const attachments = payload.attachments;
  if (attachments === undefined || attachments === null) {
    return;
  }
  if (!Array.isArray(attachments)) {
    throw new RouteRequestError("Draft attachments must be an array when provided", 400);
  }

  const normalizedAttachments = attachments.map((item) => {
    if (
      typeof item !== "object"
      || item === null
      || typeof (item as { filename?: unknown }).filename !== "string"
      || typeof (item as { contentType?: unknown }).contentType !== "string"
      || typeof (item as { r2Key?: unknown }).r2Key !== "string"
    ) {
      throw new RouteRequestError("Draft attachments must include filename, contentType, and r2Key", 400);
    }

    return {
      filename: (item as { filename: string }).filename,
      contentType: (item as { contentType: string }).contentType,
      r2Key: (item as { r2Key: string }).r2Key,
    };
  });

  await validateDraftAttachments(env, {
    tenantId: draft.tenantId,
    mailboxId: draft.mailboxId,
    attachments: normalizedAttachments,
  });
}

async function validateDraftOutboundCredits(env: Env, draft: {
  tenantId: string;
  draftR2Key: string;
  sourceMessageId?: string;
  createdVia?: string;
}): Promise<void> {
  const recipients = await readDraftRecipients(env, draft.draftR2Key);
  const creditCheck = await checkOutboundCreditRequirement(env, {
    tenantId: draft.tenantId,
    ...recipients,
    sourceMessageId: draft.sourceMessageId,
    createdVia: draft.createdVia,
  });

  if (!creditCheck.hasSufficientCredits) {
    throw createInsufficientCreditsRouteError({
      availableCredits: creditCheck.availableCredits,
      creditsRequired: creditCheck.creditsRequired,
    });
  }
}

async function validateDraftOutboundPolicy(env: Env, draft: {
  tenantId: string;
  agentId: string;
  draftR2Key: string;
}): Promise<void> {
  const recipients = await readDraftRecipients(env, draft.draftR2Key);
  const decision = await evaluateOutboundPolicy(env, {
    tenantId: draft.tenantId,
    agentId: draft.agentId,
    ...recipients,
  });

  if (!decision.ok) {
    const status = decision.code === "daily_quota_exceeded" || decision.code === "hourly_quota_exceeded" ? 429 : 403;
    throw new RouteRequestError(decision.message ?? "Outbound policy denied this send request", status);
  }
}

async function validateActiveDraftMailbox(env: Env, input: {
  tenantId: string;
  mailboxId: string;
}) {
  const mailbox = await getMailboxById(env, input.mailboxId);
  if (!mailbox) {
    throw new RouteRequestError("Mailbox not found", 404);
  }
  if (mailbox.tenant_id !== input.tenantId) {
    throw new RouteRequestError("Mailbox does not belong to tenant", 409);
  }
  if (mailbox.status !== "active") {
    throw new RouteRequestError("Mailbox is not active", 409);
  }
}

async function validateSendAgentBinding(env: Env, input: {
  tenantId: string;
  agentId: string;
  mailboxId: string;
}) {
  const agent = await getAgent(env, input.agentId);
  if (!agent) {
    throw new RouteRequestError("Agent not found", 404);
  }
  if (agent.tenantId !== input.tenantId) {
    throw new RouteRequestError("Agent does not belong to tenant", 409);
  }

  const hasBinding = await hasActiveMailboxBinding(env, {
    agentId: input.agentId,
    mailboxId: input.mailboxId,
    roles: [...SEND_CAPABLE_MAILBOX_ROLES],
  });
  const hasAnyBinding = await hasActiveMailboxBinding(env, {
    agentId: input.agentId,
    mailboxId: input.mailboxId,
  });
  const hasDeployment = await hasActiveMailboxDeployment(env, {
    agentId: input.agentId,
    mailboxId: input.mailboxId,
  });
  if (!hasBinding && (!hasDeployment || hasAnyBinding)) {
    throw new RouteRequestError("Agent is not allowed to send for mailbox", 403);
  }
}

async function validateDraftAgentBinding(env: Env, input: {
  tenantId: string;
  agentId: string;
  mailboxId: string;
}) {
  const agent = await getAgent(env, input.agentId);
  if (!agent) {
    throw new RouteRequestError("Agent not found", 404);
  }
  if (agent.tenantId !== input.tenantId) {
    throw new RouteRequestError("Agent does not belong to tenant", 409);
  }

  const mailbox = await getMailboxById(env, input.mailboxId);
  if (!mailbox) {
    throw new RouteRequestError("Mailbox not found", 404);
  }
  if (mailbox.tenant_id !== input.tenantId) {
    throw new RouteRequestError("Mailbox does not belong to tenant", 409);
  }

  const hasBinding = await hasActiveMailboxBinding(env, {
    agentId: input.agentId,
    mailboxId: input.mailboxId,
  });
  if (hasBinding) {
    return;
  }

  const hasDeployment = await hasActiveMailboxDeployment(env, {
    agentId: input.agentId,
    mailboxId: input.mailboxId,
  });
  if (!hasDeployment) {
    throw new RouteRequestError("Agent is not active for mailbox", 403);
  }
}

async function validateTokenAgentMailboxScopes(env: Env, input: {
  tenantId: string;
  agentId?: string;
  mailboxIds?: string[];
  scopes?: string[];
}) {
  if (!input.mailboxIds?.length) {
    return;
  }

  const requiresAgentForMailboxScopes = input.scopes?.some((scope) => (
    AGENT_REQUIRED_MAILBOX_SCOPES.includes(scope as typeof AGENT_REQUIRED_MAILBOX_SCOPES[number])
  )) ?? false;
  if (requiresAgentForMailboxScopes && !input.agentId) {
    throw new RouteRequestError(
      "agentId is required when mailboxIds are combined with task, draft, or replay scopes",
      409,
    );
  }
  if (!input.agentId) {
    return;
  }

  const requiresSendCapability = input.scopes?.includes("draft:send") ?? false;
  for (const mailboxId of input.mailboxIds) {
    const hasBinding = await hasActiveMailboxBinding(env, {
      agentId: input.agentId,
      mailboxId,
      roles: requiresSendCapability ? [...SEND_CAPABLE_MAILBOX_ROLES] : undefined,
    });
    if (hasBinding) {
      continue;
    }

    const hasAnyBinding = requiresSendCapability
      ? await hasActiveMailboxBinding(env, {
        agentId: input.agentId,
        mailboxId,
      })
      : false;
    const hasDeployment = await hasActiveMailboxDeployment(env, {
      agentId: input.agentId,
      mailboxId,
    });
    if (!requiresSendCapability && !hasDeployment) {
      throw new RouteRequestError("agentId must be active for every mailboxId", 409);
    }
    if (requiresSendCapability && (!hasDeployment || hasAnyBinding)) {
      throw new RouteRequestError("agentId must have send-capable access for every mailboxId", 409);
    }
  }
}

async function resolveActiveClaimMailboxIdsForAgent(env: Env, claims: AccessTokenClaims, agentId: string): Promise<string[] | null> {
  if (!claims.mailboxIds?.length) {
    return null;
  }

  const mailboxIds: string[] = [];
  for (const mailboxId of claims.mailboxIds) {
    const hasBinding = await hasActiveMailboxBinding(env, {
      agentId,
      mailboxId,
    });
    if (hasBinding) {
      mailboxIds.push(mailboxId);
      continue;
    }

    const hasDeployment = await hasActiveMailboxDeployment(env, {
      agentId,
      mailboxId,
    });
    if (hasDeployment) {
      mailboxIds.push(mailboxId);
    }
  }

  return mailboxIds;
}

async function canAgentSendForMailbox(env: Env, input: {
  agentId: string;
  mailboxId: string;
}): Promise<boolean> {
  const hasBinding = await hasActiveMailboxBinding(env, {
    agentId: input.agentId,
    mailboxId: input.mailboxId,
    roles: [...SEND_CAPABLE_MAILBOX_ROLES],
  });
  if (hasBinding) {
    return true;
  }

  const hasAnyBinding = await hasActiveMailboxBinding(env, {
    agentId: input.agentId,
    mailboxId: input.mailboxId,
  });
  if (hasAnyBinding) {
    return false;
  }

  return await hasActiveMailboxDeployment(env, {
    agentId: input.agentId,
    mailboxId: input.mailboxId,
  });
}

router.on("GET", "/public/signup", async () => {
  return withPublicSelfServeCors(methodNotAllowed(["POST"]));
});

router.on("HEAD", "/public/signup", async () => {
  return withPublicSelfServeCors(methodNotAllowed(["POST"]));
});

router.on("OPTIONS", "/public/signup", async () => {
  return publicSelfServePreflight();
});

router.on("POST", "/public/signup", async (request, env) => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return withPublicSelfServeCors(
      json({ error: "content-type must be application/json" }, { status: 415 })
    );
  }

  let parsed: Awaited<ReturnType<typeof parseSelfServeSignup>>;

  try {
    parsed = await parseSelfServeSignup(request);
  } catch (error) {
    if (error instanceof InvalidJsonBodyError) {
      return withPublicSelfServeCors(
        json({ error: error.message, values: {} }, { status: 400 })
      );
    }
    throw error;
  }

  if (!parsed.ok) {
    return withPublicSelfServeCors(
      json({ error: parsed.error, values: parsed.values }, { status: 400 })
    );
  }

  try {
    const result = await performSelfServeSignup(env, parsed.values);
    return withPublicSelfServeCors(json(result, { status: 201 }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to complete self-serve signup";
    const status = error instanceof SignupError ? error.status : 502;
    return withPublicSelfServeCors(json({ error: message, values: parsed.values }, { status }));
  }
});

router.on("OPTIONS", "/public/token/reissue", async () => {
  return publicSelfServePreflight();
});

router.on("GET", "/public/token/reissue", async () => {
  return withPublicSelfServeCors(methodNotAllowed(["POST"]));
});

router.on("HEAD", "/public/token/reissue", async () => {
  return withPublicSelfServeCors(methodNotAllowed(["POST"]));
});

router.on("POST", "/public/token/reissue", async (request, env) => {
  const body = await readJson<{
    mailboxAlias?: string;
    mailboxAddress?: string;
  }>(request);

  const mailboxLookup = normalizeMailboxLookup(env, body);
  if (mailboxLookup.error) {
    return withPublicSelfServeCors(badRequest(mailboxLookup.error));
  }

  const mailboxAddress = mailboxLookup.mailboxAddress;
  if (!mailboxAddress) {
    return withPublicSelfServeCors(badRequest("mailboxAlias or mailboxAddress is required"));
  }

  const requesterIpHash = await hashRequesterIp(request.headers.get("cf-connecting-ip"));
  const mailboxCooldownSince = isoSecondsAgo(getMailboxCooldownSeconds(env));
  const ipWindowSince = isoSecondsAgo(getIpWindowSeconds(env));

  try {
    if (await hasRecentMailboxTokenReissue(env, mailboxAddress, mailboxCooldownSince)) {
      return withPublicSelfServeCors(accepted({
        accepted: true,
        message: "If the mailbox exists, a refreshed access token will be emailed to the original operator inbox.",
      }));
    }

    if (requesterIpHash) {
      const recentIpRequests = await countRecentIpTokenReissues(env, requesterIpHash, ipWindowSince);
      if (recentIpRequests >= getIpMaxRequests(env)) {
        return withPublicSelfServeCors(accepted({
          accepted: true,
          message: "If the mailbox exists, a refreshed access token will be emailed to the original operator inbox.",
        }));
      }
    }
  } catch (error) {
    if (isMissingTableError(error)) {
      // If rate-limit tables are unavailable, continue with the generic flow without leaking mailbox existence.
    } else {
      throw error;
    }
  }

  if (env.API_SIGNING_SECRET) {
    let reissueQueued = false;
    try {
      reissueQueued = await reissueMailboxAccessToken(env, mailboxAddress);
    } catch {
      // Intentionally swallow errors so the endpoint does not disclose mailbox existence or operator metadata.
    }

    if (reissueQueued) {
      try {
        await logTokenReissueRequest(env, {
          mailboxAddress,
          requesterIpHash: requesterIpHash ?? undefined,
        });
      } catch (error) {
        if (!isMissingTableError(error)) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[token-reissue] cooldown log write failed after successful queue for ${mailboxAddress}: ${message}`);
        }
      }
    }
  }

  return withPublicSelfServeCors(accepted({
    accepted: true,
    message: "If the mailbox exists, a refreshed access token will be emailed to the original operator inbox.",
  }));
});

router.on("POST", "/v1/auth/token/rotate", async (request, env) => {
  const auth = await requireAuth(request, env, []);
  if (auth instanceof Response) {
    return auth;
  }

  const body = await readOptionalJson<{
    delivery?: "inline" | "self_mailbox" | "both";
    mailboxId?: string;
  }>(request);
  const delivery = body?.delivery ?? "inline";
  if (!["inline", "self_mailbox", "both"].includes(delivery)) {
    return badRequest("delivery must be one of: inline, self_mailbox, both");
  }

  const targetMailboxId = delivery === "self_mailbox" || delivery === "both"
    ? resolveRotateMailboxId(auth, body?.mailboxId) ?? undefined
    : undefined;

  if (delivery === "self_mailbox" || delivery === "both") {
    if (!auth.mailboxIds?.length) {
      return badRequest("self_mailbox delivery requires a mailbox-scoped token");
    }

    if (!targetMailboxId) {
      return badRequest("mailboxId is required for self_mailbox delivery when the token covers multiple or no mailboxes");
    }

    const mailboxError = enforceMailboxAccess(auth, targetMailboxId);
    if (mailboxError) {
      return mailboxError;
    }
    const currentAccessError = await requireCurrentMailboxAccessForClaims(env, auth, targetMailboxId);
    if (currentAccessError) {
      return currentAccessError;
    }
  }

  const rotated = await rotateAccessToken(env, auth);
  if (!rotated.accessToken) {
    return json({ error: "Unable to issue rotated token" }, { status: 500 });
  }

  let deliveryStatus: "skipped" | "queued" | "unavailable" = "skipped";
  let deliveryMailboxId: string | undefined;

  if (delivery === "self_mailbox" || delivery === "both") {
    const delivered = await deliverRotatedTokenToSelfMailbox(
      env,
      auth,
      targetMailboxId!,
      rotated.accessToken,
      rotated.accessTokenExpiresAt,
      rotated.accessTokenScopes,
    );
    deliveryStatus = delivered ? "queued" : "unavailable";
    deliveryMailboxId = targetMailboxId;
  }

  return json({
    token: delivery === "self_mailbox" && deliveryStatus === "queued" ? undefined : rotated.accessToken,
    expiresAt: rotated.accessTokenExpiresAt,
    scopes: rotated.accessTokenScopes,
    delivery,
    deliveryStatus,
    deliveryMailboxId,
    oldTokenRemainsValid: true,
  }, { status: 201 });
});

router.on("GET", "/v1/billing/account", async (request, env) => {
  const auth = await requireAuth(request, env, []);
  if (auth instanceof Response) {
    return auth;
  }
  const accessError = await requireSelfServiceTenantAccess(env, auth, auth.tenantId);
  if (accessError) {
    return accessError;
  }

  return json(buildBillingAccountResponse(await ensureTenantBillingAccount(env, auth.tenantId)));
});

router.on("GET", "/v1/billing/ledger", async (request, env) => {
  const auth = await requireAuth(request, env, []);
  if (auth instanceof Response) {
    return auth;
  }
  const accessError = await requireSelfServiceTenantAccess(env, auth, auth.tenantId);
  if (accessError) {
    return accessError;
  }

  const url = new URL(request.url);
  const limit = parseListLimit(url.searchParams.get("limit"), 50, 200);
  return json({ items: await listTypedTenantCreditLedger(env, auth.tenantId, limit) });
});

router.on("GET", "/v1/billing/receipts", async (request, env) => {
  const auth = await requireAuth(request, env, []);
  if (auth instanceof Response) {
    return auth;
  }
  const accessError = await requireSelfServiceTenantAccess(env, auth, auth.tenantId);
  if (accessError) {
    return accessError;
  }

  const url = new URL(request.url);
  const limit = parseListLimit(url.searchParams.get("limit"), 50, 200);
  return json({ items: await listTypedTenantPaymentReceipts(env, auth.tenantId, limit) });
});

router.on("POST", "/v1/billing/topup", async (request, env) => {
  const auth = await requireAuth(request, env, []);
  if (auth instanceof Response) {
    return auth;
  }
  const accessError = await requireSelfServiceTenantAccess(env, auth, auth.tenantId);
  if (accessError) {
    return accessError;
  }

  const body = await readJson<{
    credits?: number;
    paymentScheme?: string;
    network?: string;
    asset?: string;
  }>(request);

  const credits = parseTopupCredits(body.credits);
  if (!credits) {
    return badRequest("credits must be an integer between 1 and 100000");
  }

  const x402Defaults = getX402Defaults(env);
  if (!x402Defaults.payTo) {
    return x402UnavailableResponse();
  }

  await ensureTenantBillingAccount(env, auth.tenantId);
  const didBinding = await getTenantDidBinding(env, auth.tenantId);
  const apiBaseUrl = new URL(request.url).origin;
  const quote = buildX402TopupQuote(env, {
    credits,
    tenantId: auth.tenantId,
    tenantDid: didBinding?.did,
    apiBaseUrl,
  });

  const paymentProof = parseX402PaymentProof(request.headers.get(X402_PAYMENT_SIGNATURE_HEADER));
  if (!paymentProof) {
    return x402PaymentRequiredResponse({
      tenantId: auth.tenantId,
      tenantDid: didBinding?.did,
      quote,
    });
  }

  const paymentProofFingerprint = await fingerprintPaymentProof(paymentProof);
  const replayReceipt = await findPaymentReceiptReplay(env, auth.tenantId, paymentProofFingerprint);
  if (replayReceipt instanceof Response) {
    return replayReceipt;
  }
  if (replayReceipt) {
    if (getX402FacilitatorConfig(env) && (replayReceipt.status === "pending" || replayReceipt.status === "verified")) {
      const autoSettlementResponse = await withRefreshedPaymentReceipt(env, replayReceipt, async (currentReceipt) =>
        await attemptAutomaticPaymentSettlement(env, currentReceipt)
      );
      if (autoSettlementResponse) {
        return autoSettlementResponse;
      }
    }
    return paymentReceiptReplayResponse(replayReceipt);
  }

  let receipt: TypedPaymentReceiptRecord;
  try {
    receipt = await createTypedTenantPaymentReceipt(env, {
      tenantId: auth.tenantId,
      receiptType: "topup",
      paymentScheme: body.paymentScheme?.trim() || quote.scheme,
      network: body.network?.trim() || quote.network,
      asset: body.asset?.trim() || quote.asset,
      amountAtomic: quote.amountAtomic,
      amountDisplay: quote.amountUsd,
      paymentProofFingerprint,
      status: "pending",
      metadata: buildTopupReceiptMetadata({
        tenantDid: didBinding?.did,
        creditsRequested: credits,
        quote,
        paymentProof,
      }),
    });
  } catch (error) {
    const retryReplayReceipt = await findPaymentReceiptReplay(env, auth.tenantId, paymentProofFingerprint);
    if (retryReplayReceipt instanceof Response) {
      return retryReplayReceipt;
    }
    if (retryReplayReceipt) {
      if (getX402FacilitatorConfig(env) && (retryReplayReceipt.status === "pending" || retryReplayReceipt.status === "verified")) {
        const autoSettlementResponse = await withRefreshedPaymentReceipt(env, retryReplayReceipt, async (currentReceipt) =>
          await attemptAutomaticPaymentSettlement(env, currentReceipt)
        );
        if (autoSettlementResponse) {
          return autoSettlementResponse;
        }
      }
      return paymentReceiptReplayResponse(retryReplayReceipt);
    }
    throw error;
  }

  if (getX402FacilitatorConfig(env)) {
    const autoSettlementResponse = await withRefreshedPaymentReceipt(env, receipt, async (currentReceipt) =>
      await attemptAutomaticPaymentSettlement(env, currentReceipt)
    );
    if (autoSettlementResponse) {
      return autoSettlementResponse;
    }
  }

  return accepted({
    receiptId: receipt.id,
    receipt,
    creditsRequested: credits,
    verificationStatus: "pending",
    message: "Payment proof captured. Verification and credit settlement are not enabled yet on this endpoint.",
  });
});

router.on("POST", "/v1/billing/upgrade-intent", async (request, env) => {
  const auth = await requireAuth(request, env, []);
  if (auth instanceof Response) {
    return auth;
  }
  const accessError = await requireSelfServiceTenantAccess(env, auth, auth.tenantId);
  if (accessError) {
    return accessError;
  }

  const body = await readJson<{
    targetPricingTier?: "paid_review";
    paymentScheme?: string;
    network?: string;
    asset?: string;
  }>(request);

  const targetPricingTier = body.targetPricingTier ?? "paid_review";
  if (targetPricingTier !== "paid_review") {
    return badRequest("targetPricingTier must currently be paid_review");
  }

  const x402Defaults = getX402Defaults(env);
  if (!x402Defaults.payTo) {
    return x402UnavailableResponse();
  }

  await ensureTenantBillingAccount(env, auth.tenantId);
  const didBinding = await getTenantDidBinding(env, auth.tenantId);
  const apiBaseUrl = new URL(request.url).origin;
  const quote = buildX402UpgradeQuote(env, {
    targetPricingTier,
    tenantId: auth.tenantId,
    tenantDid: didBinding?.did,
    apiBaseUrl,
  });

  const paymentProof = parseX402PaymentProof(request.headers.get(X402_PAYMENT_SIGNATURE_HEADER));
  if (!paymentProof) {
    return x402PaymentRequiredResponse({
      tenantId: auth.tenantId,
      tenantDid: didBinding?.did,
      quote,
    });
  }

  const paymentProofFingerprint = await fingerprintPaymentProof(paymentProof);
  const replayReceipt = await findPaymentReceiptReplay(env, auth.tenantId, paymentProofFingerprint);
  if (replayReceipt instanceof Response) {
    return replayReceipt;
  }
  if (replayReceipt) {
    if (getX402FacilitatorConfig(env) && (replayReceipt.status === "pending" || replayReceipt.status === "verified")) {
      const autoSettlementResponse = await withRefreshedPaymentReceipt(env, replayReceipt, async (currentReceipt) =>
        await attemptAutomaticPaymentSettlement(env, currentReceipt)
      );
      if (autoSettlementResponse) {
        return autoSettlementResponse;
      }
    }
    return paymentReceiptReplayResponse(replayReceipt);
  }

  let receipt: TypedPaymentReceiptRecord;
  try {
    receipt = await createTypedTenantPaymentReceipt(env, {
      tenantId: auth.tenantId,
      receiptType: "upgrade",
      paymentScheme: body.paymentScheme?.trim() || quote.scheme,
      network: body.network?.trim() || quote.network,
      asset: body.asset?.trim() || quote.asset,
      amountAtomic: quote.amountAtomic,
      amountDisplay: quote.amountUsd,
      paymentProofFingerprint,
      status: "pending",
      metadata: buildUpgradeReceiptMetadata({
        tenantDid: didBinding?.did,
        targetPricingTier,
        includedCredits: quote.includedCredits,
        quote,
        paymentProof,
      }),
    });
  } catch (error) {
    const retryReplayReceipt = await findPaymentReceiptReplay(env, auth.tenantId, paymentProofFingerprint);
    if (retryReplayReceipt instanceof Response) {
      return retryReplayReceipt;
    }
    if (retryReplayReceipt) {
      if (getX402FacilitatorConfig(env) && (retryReplayReceipt.status === "pending" || retryReplayReceipt.status === "verified")) {
        const autoSettlementResponse = await withRefreshedPaymentReceipt(env, retryReplayReceipt, async (currentReceipt) =>
          await attemptAutomaticPaymentSettlement(env, currentReceipt)
        );
        if (autoSettlementResponse) {
          return autoSettlementResponse;
        }
      }
      return paymentReceiptReplayResponse(retryReplayReceipt);
    }
    throw error;
  }

  if (getX402FacilitatorConfig(env)) {
    const autoSettlementResponse = await withRefreshedPaymentReceipt(env, receipt, async (currentReceipt) =>
      await attemptAutomaticPaymentSettlement(env, currentReceipt)
    );
    if (autoSettlementResponse) {
      return autoSettlementResponse;
    }
  }

  return accepted({
    receiptId: receipt.id,
    receipt,
    targetPricingTier,
    includedCredits: quote.includedCredits,
    verificationStatus: "pending",
    message: "Upgrade payment proof captured. Verification and plan upgrade are not yet automatic on this endpoint.",
  });
});

router.on("GET", "/v1/tenants/:tenantId/send-policy", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, []);
  if (auth instanceof Response) {
    return auth;
  }
  const accessError = await requireSelfServiceTenantAccess(env, auth, route.params.tenantId);
  if (accessError) {
    return accessError;
  }

  return json(await ensureTenantSendPolicy(env, route.params.tenantId));
});

router.on("PUT", "/v1/tenants/:tenantId/send-policy", async (request, env, _ctx, route) => {
  const routeError = requireAdminRoutesEnabled(request, env);
  if (routeError) {
    return routeError;
  }
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  const previousSendPolicy = await ensureTenantSendPolicy(env, route.params.tenantId);

  const body = await readJson<{
    pricingTier?: "free" | "paid_review" | "paid_active" | "enterprise";
    outboundStatus?: "internal_only" | "external_review" | "external_enabled" | "suspended";
    internalDomainAllowlist?: string[];
    externalSendEnabled?: boolean;
    reviewRequired?: boolean;
  }>(request);

  if (
    !body.pricingTier ||
    !body.outboundStatus ||
    body.externalSendEnabled === undefined ||
    body.reviewRequired === undefined
  ) {
    return badRequest("pricingTier, outboundStatus, externalSendEnabled, and reviewRequired are required");
  }

  const sendPolicy = await upsertTenantSendPolicy(env, {
    tenantId: route.params.tenantId,
    pricingTier: body.pricingTier,
    outboundStatus: body.outboundStatus,
    internalDomainAllowlist: body.internalDomainAllowlist ?? ["mailagents.net"],
    externalSendEnabled: body.externalSendEnabled,
    reviewRequired: body.reviewRequired,
  });

  if (
    JSON.stringify(previousSendPolicy.internalDomainAllowlist) !== JSON.stringify(sendPolicy.internalDomainAllowlist)
  ) {
    await syncTenantDefaultAgentRecipientPoliciesForInternalDomainChange(env, {
      tenantId: route.params.tenantId,
      previousInternalDomainAllowlist: previousSendPolicy.internalDomainAllowlist,
      nextInternalDomainAllowlist: sendPolicy.internalDomainAllowlist,
    });
  }

  if (sendPolicy.outboundStatus === "external_enabled" && sendPolicy.externalSendEnabled) {
    await relaxTenantDefaultAgentRecipientPoliciesForExternalSend(env, {
      tenantId: route.params.tenantId,
      internalDomainAllowlist: sendPolicy.internalDomainAllowlist,
    });
  }

  return json(sendPolicy);
});

router.on("POST", "/v1/tenants/:tenantId/send-policy/review-decision", async (request, env, _ctx, route) => {
  const routeError = requireAdminRoutesEnabled(request, env);
  if (routeError) {
    return routeError;
  }
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  const body = await readJson<{
    decision?: "approve_external" | "reset_review" | "suspend_outbound";
  }>(request);

  if (!body.decision) {
    return badRequest("decision is required");
  }

  const sendPolicy = await ensureTenantSendPolicy(env, route.params.tenantId);
  const billingAccount = await ensureTenantBillingAccount(env, route.params.tenantId);

  if (body.decision === "approve_external") {
    const updatedSendPolicy = await upsertTenantSendPolicy(env, {
      tenantId: route.params.tenantId,
      pricingTier: "paid_active",
      outboundStatus: "external_enabled",
      internalDomainAllowlist: sendPolicy.internalDomainAllowlist,
      externalSendEnabled: true,
      reviewRequired: false,
    });
    const updatedBillingAccount = await updateTenantBillingAccountProfile(env, {
      tenantId: route.params.tenantId,
      status: billingAccount.status === "trial" ? "active" : undefined,
      pricingTier: "paid_active",
    });
    await relaxTenantDefaultAgentRecipientPoliciesForExternalSend(env, {
      tenantId: route.params.tenantId,
      internalDomainAllowlist: updatedSendPolicy.internalDomainAllowlist,
    });

    return json({
      sendPolicy: updatedSendPolicy,
      account: updatedBillingAccount,
      decision: body.decision,
      message: "External sending approved for tenant.",
    });
  }

  if (body.decision === "reset_review") {
    const updatedSendPolicy = await upsertTenantSendPolicy(env, {
      tenantId: route.params.tenantId,
      pricingTier: "paid_review",
      outboundStatus: "external_review",
      internalDomainAllowlist: sendPolicy.internalDomainAllowlist,
      externalSendEnabled: false,
      reviewRequired: true,
    });
    const updatedBillingAccount = await updateTenantBillingAccountProfile(env, {
      tenantId: route.params.tenantId,
      status: billingAccount.status === "suspended" ? "active" : undefined,
      pricingTier: "paid_review",
    });

    return json({
      sendPolicy: updatedSendPolicy,
      account: updatedBillingAccount,
      decision: body.decision,
      message: "Tenant returned to paid review.",
    });
  }

  if (body.decision === "suspend_outbound") {
    const updatedSendPolicy = await upsertTenantSendPolicy(env, {
      tenantId: route.params.tenantId,
      pricingTier: sendPolicy.pricingTier,
      outboundStatus: "suspended",
      internalDomainAllowlist: sendPolicy.internalDomainAllowlist,
      externalSendEnabled: false,
      reviewRequired: true,
    });
    const updatedBillingAccount = await updateTenantBillingAccountProfile(env, {
      tenantId: route.params.tenantId,
      status: "suspended",
    });

    return json({
      sendPolicy: updatedSendPolicy,
      account: updatedBillingAccount,
      decision: body.decision,
      message: "Outbound sending suspended for tenant.",
    });
  }

  return badRequest("Unsupported decision");
});

router.on("POST", "/v1/billing/payment/confirm", async (request, env) => {
  const auth = await requireAuth(request, env, []);
  if (auth instanceof Response) {
    return auth;
  }
  const accessError = await requireSelfServiceTenantAccess(env, auth, auth.tenantId);
  if (accessError) {
    return accessError;
  }

  const body = await readJson<{
    receiptId?: string;
    settlementReference?: string;
    markFailed?: boolean;
  }>(request);

  if (!body.receiptId) {
    return buildMissingReceiptIdResponse();
  }

  const facilitatorConfigured = Boolean(getX402FacilitatorConfig(env));
  if (!facilitatorConfigured) {
    return x402UnavailableResponse();
  }

  if (body.markFailed === true || typeof body.settlementReference === "string") {
    return json({
      error: "manual payment confirmation is no longer supported; submit a facilitator-compatible payment proof and use this endpoint only to retry facilitator settlement by receiptId",
      protocol: "x402",
    }, { status: 410 });
  }

  const receipt = await getTypedTenantPaymentReceiptById(env, auth.tenantId, body.receiptId);
  if (!receipt) {
    return buildReceiptNotFoundResponse();
  }

  if (receipt.status === "failed") {
    return json({ error: "Failed payment receipts cannot be confirmed" }, { status: 409 });
  }

  return await withRefreshedPaymentReceipt(env, receipt, async (currentReceipt) => {
    const facilitatorOutcome = currentReceipt.status === "settled"
      ? null
      : await confirmPaymentReceiptWithFacilitator(env, currentReceipt);

    if (facilitatorOutcome?.failureResponse) {
      return facilitatorOutcome.failureResponse;
    }

    return json(await finalizePaymentReceiptSettlement(env, currentReceipt, facilitatorOutcome));
  });
});

router.on("GET", "/v1/tenants/:tenantId/did", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, []);
  if (auth instanceof Response) {
    return auth;
  }
  const accessError = await requireSelfServiceTenantAccess(env, auth, route.params.tenantId);
  if (accessError) {
    return accessError;
  }

  const binding = await getTenantDidBinding(env, route.params.tenantId);
  if (!binding) {
    return json({ error: "DID binding not found" }, { status: 404 });
  }

  return json(binding);
});

router.on("POST", "/v1/tenants/:tenantId/did/hosted", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, []);
  if (auth instanceof Response) {
    return auth;
  }
  const accessError = await requireSelfServiceTenantAccess(env, auth, route.params.tenantId);
  if (accessError) {
    return accessError;
  }

  const origin = new URL(request.url).origin;
  const hosted = buildHostedDidWeb(origin, route.params.tenantId);
  const service = defaultHostedDidServices(origin, hosted.did, route.params.tenantId);

  return json(await upsertTenantDidBinding(env, {
    tenantId: route.params.tenantId,
    did: hosted.did,
    method: "did:web",
    documentUrl: hosted.documentUrl,
    status: "verified",
    service,
    verifiedAt: new Date().toISOString(),
  }));
});

router.on("PUT", "/v1/tenants/:tenantId/did", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, []);
  if (auth instanceof Response) {
    return auth;
  }
  const accessError = await requireSelfServiceTenantAccess(env, auth, route.params.tenantId);
  if (accessError) {
    return accessError;
  }

  const body = await readJson<{
    did?: string;
    method?: string;
    documentUrl?: string;
    status?: "pending" | "verified" | "revoked";
    verificationMethodId?: string;
    service?: Array<Record<string, unknown>>;
    verifiedAt?: string;
  }>(request);

  if (!body.did || !body.method || !body.status) {
    return badRequest("did, method, and status are required");
  }

  if (body.status === "verified") {
    return json({ error: "Tenants cannot self-mark DID bindings as verified" }, { status: 403 });
  }

  if (body.verificationMethodId || body.verifiedAt) {
    return json({ error: "verificationMethodId and verifiedAt are managed by the platform" }, { status: 403 });
  }

  return json(await upsertTenantDidBinding(env, {
    tenantId: route.params.tenantId,
    did: body.did,
    method: body.method,
    documentUrl: body.documentUrl,
    status: body.status,
    service: body.service ?? [],
  }));
});

router.on("GET", "/did/tenants/:tenantId/did.json", async (request, env, _ctx, route) => {
  const binding = await getTenantDidBinding(env, route.params.tenantId);
  if (!binding || !isPublishedHostedDidBinding(new URL(request.url).origin, binding)) {
    return json({ error: "DID document not found" }, { status: 404 });
  }

  return json(buildDidWebDocument(new URL(request.url).origin, binding));
});

router.on("GET", "/v2/meta/runtime", async (request, env) => {
  return json(buildRuntimeMetadata(request, env));
});
router.on("HEAD", "/v2/meta/runtime", async (request, env) => {
  return json(buildRuntimeMetadata(request, env));
});

router.on("GET", "/v2/meta/compatibility", async (request, env) => {
  return json(buildCompatibilityContract(request, env));
});
router.on("HEAD", "/v2/meta/compatibility", async (request, env) => {
  return json(buildCompatibilityContract(request, env));
});

router.on("GET", "/v2/meta/compatibility/schema", async (_request, _env) => {
  return json(COMPATIBILITY_CONTRACT_SCHEMA);
});
router.on("HEAD", "/v2/meta/compatibility/schema", async (_request, _env) => {
  return json(COMPATIBILITY_CONTRACT_SCHEMA);
});

router.on("GET", "/v1/mailboxes/self", async (request, env) => {
  const auth = await requireAuth(request, env, ["mail:read"]);
  if (auth instanceof Response) {
    return auth;
  }

  const mailbox = await resolveSelfMailbox(env, auth);
  if (mailbox instanceof Response) {
    return mailbox;
  }
  const selfAgent = auth.agentId ? await resolveSelfAgentForMailbox(env, auth, mailbox.id) : null;
  if (selfAgent instanceof Response) {
    return selfAgent;
  }

  return json({
    id: mailbox.id,
    tenantId: mailbox.tenant_id,
    address: mailbox.address,
    status: mailbox.status,
    createdAt: mailbox.created_at,
    agentId: selfAgent?.id,
  });
});

router.on("GET", "/v1/mailboxes/self/tasks", async (request, env) => {
  const auth = await requireAuth(request, env, ["task:read"]);
  if (auth instanceof Response) {
    return auth;
  }

  const mailbox = await resolveSelfMailbox(env, auth);
  if (mailbox instanceof Response) {
    return mailbox;
  }

  const selfAgent = await resolveSelfAgentForMailbox(env, auth, mailbox.id);
  if (selfAgent instanceof Response) {
    return selfAgent;
  }

  const url = new URL(request.url);
  const status = url.searchParams.get("status") as "queued" | "running" | "done" | "needs_review" | "failed" | null;
  const items = await listTasks(env, selfAgent.id, status ?? undefined, [mailbox.id]);
  return json({ items });
});

router.on("GET", "/v1/mailboxes/self/messages", async (request, env) => {
  const auth = await requireAuth(request, env, ["mail:read"]);
  if (auth instanceof Response) {
    return auth;
  }

  const mailbox = await resolveSelfMailbox(env, auth);
  if (mailbox instanceof Response) {
    return mailbox;
  }
  const currentAccessError = await requireCurrentMailboxAccessForClaims(env, auth, mailbox.id);
  if (currentAccessError) {
    return currentAccessError;
  }

  const url = new URL(request.url);
  const limit = parseListLimit(url.searchParams.get("limit"), 50, 200);
  const search = url.searchParams.get("search")?.trim() || undefined;
  const direction = (url.searchParams.get("direction")?.trim() as "inbound" | "outbound" | null) ?? undefined;
  const status = (url.searchParams.get("status")?.trim() as
    | "received"
    | "normalized"
    | "tasked"
    | "replied"
    | "ignored"
    | "failed"
    | null) ?? undefined;

  const items = await listMessages(env, {
      mailboxId: mailbox.id,
      limit,
      search,
      direction,
      status,
    });
  const visibleItems: typeof items = [];
  for (const item of items) {
    if (!auth.mailboxIds?.length || !(await isMailboxScopedOperatorTokenDeliveryMessage(env, item.id))) {
      visibleItems.push(item);
    }
  }

  return json({
    items: visibleItems,
  });
});

router.on("GET", "/v1/mailboxes/self/messages/:messageId", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["mail:read"]);
  if (auth instanceof Response) {
    return auth;
  }

  const mailbox = await resolveSelfMailbox(env, auth);
  if (mailbox instanceof Response) {
    return mailbox;
  }
  const currentAccessError = await requireCurrentMailboxAccessForClaims(env, auth, mailbox.id);
  if (currentAccessError) {
    return currentAccessError;
  }

  const message = await getMessage(env, route.params.messageId);
  if (!message) {
    return json({ error: "Message not found" }, { status: 404 });
  }
  if (message.mailboxId !== mailbox.id || message.tenantId !== mailbox.tenant_id) {
    return json({ error: "Mailbox access denied" }, { status: 403 });
  }
  const visibilityError = await enforceMailboxScopedMessageVisibility(env, auth, message.id);
  if (visibilityError) {
    return visibilityError;
  }

  return json(message);
});

router.on("GET", "/v1/mailboxes/self/messages/:messageId/content", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["mail:read"]);
  if (auth instanceof Response) {
    return auth;
  }

  const mailbox = await resolveSelfMailbox(env, auth);
  if (mailbox instanceof Response) {
    return mailbox;
  }
  const currentAccessError = await requireCurrentMailboxAccessForClaims(env, auth, mailbox.id);
  if (currentAccessError) {
    return currentAccessError;
  }

  const message = await getMessage(env, route.params.messageId);
  if (!message) {
    return json({ error: "Message not found" }, { status: 404 });
  }
  if (message.mailboxId !== mailbox.id || message.tenantId !== mailbox.tenant_id) {
    return json({ error: "Mailbox access denied" }, { status: 403 });
  }
  const visibilityError = await enforceMailboxScopedMessageVisibility(env, auth, message.id);
  if (visibilityError) {
    return visibilityError;
  }

  return json(await getMessageContent(env, route.params.messageId));
});

router.on("POST", "/v1/mailboxes/self/send", async (request, env) => {
  const auth = await requireAuth(request, env, ["draft:create", "draft:send"]);
  if (auth instanceof Response) {
    return auth;
  }

  const mailbox = await resolveSelfMailbox(env, auth);
  if (mailbox instanceof Response) {
    return mailbox;
  }

  const selfAgent = await resolveSelfAgentForMailbox(env, auth, mailbox.id);
  if (selfAgent instanceof Response) {
    return selfAgent;
  }

  const body = await readJson<{
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    text?: string;
    html?: string;
    inReplyTo?: string;
    references?: string[];
    attachments?: Array<{ filename: string; contentType: string; r2Key: string }>;
    idempotencyKey?: string;
  }>(request);

  if (!body.to?.length || !body.subject) {
    return badRequest("to and subject are required");
  }

  const result = await createAndSendDraft(env, {
    tenantId: mailbox.tenant_id,
    agentId: selfAgent.id,
    mailboxId: mailbox.id,
    payload: {
      from: mailbox.address,
      to: body.to,
      cc: body.cc ?? [],
      bcc: body.bcc ?? [],
      subject: body.subject,
      text: body.text ?? "",
      html: body.html ?? "",
      inReplyTo: body.inReplyTo,
      references: body.references ?? [],
      attachments: body.attachments ?? [],
    },
    createdVia: "api:v1/mailboxes/self/send",
    idempotencyKey: body.idempotencyKey?.trim(),
    requestFingerprint: JSON.stringify({
      route: "v1/mailboxes/self/send",
      mailboxId: mailbox.id,
      to: body.to,
      cc: body.cc ?? [],
      bcc: body.bcc ?? [],
      subject: body.subject,
      text: body.text ?? "",
      html: body.html ?? "",
      inReplyTo: body.inReplyTo ?? null,
      references: body.references ?? [],
      attachments: body.attachments ?? [],
    }),
  });

  return accepted(result);
});

router.on("POST", "/v1/messages/send", async (request, env) => {
  const auth = await requireAuth(request, env, ["draft:create", "draft:send"]);
  if (auth instanceof Response) {
    return auth;
  }

  const mailbox = await resolveSelfMailbox(env, auth);
  if (mailbox instanceof Response) {
    return mailbox;
  }

  const selfAgent = await resolveSelfAgentForMailbox(env, auth, mailbox.id);
  if (selfAgent instanceof Response) {
    return selfAgent;
  }

  const body = await readJson<{
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    text?: string;
    html?: string;
    inReplyTo?: string;
    references?: string[];
    attachments?: Array<{ filename: string; contentType: string; r2Key: string }>;
    idempotencyKey?: string;
  }>(request);

  if (!body.to?.length || !body.subject) {
    return badRequest("to and subject are required");
  }

  const result = await createAndSendDraft(env, {
    tenantId: mailbox.tenant_id,
    agentId: selfAgent.id,
    mailboxId: mailbox.id,
    payload: {
      from: mailbox.address,
      to: body.to,
      cc: body.cc ?? [],
      bcc: body.bcc ?? [],
      subject: body.subject,
      text: body.text ?? "",
      html: body.html ?? "",
      inReplyTo: body.inReplyTo,
      references: body.references ?? [],
      attachments: body.attachments ?? [],
    },
    createdVia: "api:v1/messages/send",
    idempotencyKey: body.idempotencyKey?.trim(),
    requestFingerprint: JSON.stringify({
      route: "v1/messages/send",
      mailboxId: mailbox.id,
      to: body.to,
      cc: body.cc ?? [],
      bcc: body.bcc ?? [],
      subject: body.subject,
      text: body.text ?? "",
      html: body.html ?? "",
      inReplyTo: body.inReplyTo ?? null,
      references: body.references ?? [],
      attachments: body.attachments ?? [],
    }),
  });

  return accepted(result);
});

router.on("GET", "/v1/debug/agents/:agentId", async (request, env, _ctx, route) => {
  const routeError = requireDebugRoutesEnabled(request, env);
  if (routeError) {
    return routeError;
  }
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }

  return json(agent);
});

router.on("GET", "/v1/debug/mailboxes/:mailboxId", async (request, env, _ctx, route) => {
  const routeError = requireDebugRoutesEnabled(request, env);
  if (routeError) {
    return routeError;
  }
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  const mailbox = await getMailboxById(env, route.params.mailboxId);
  if (!mailbox) {
    return json({ error: "Mailbox not found" }, { status: 404 });
  }

  return json(mailbox);
});

router.on("GET", "/v1/debug/messages/:messageId", async (request, env, _ctx, route) => {
  const routeError = requireDebugRoutesEnabled(request, env);
  if (routeError) {
    return routeError;
  }
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  const message = await getMessage(env, route.params.messageId);
  if (!message) {
    return json({ error: "Message not found" }, { status: 404 });
  }

  const deliveryEvents = await listDeliveryEventsByMessageId(env, route.params.messageId);
  return json({
    message,
    deliveryEvents,
  });
});

router.on("GET", "/v1/debug/drafts/:draftId", async (request, env, _ctx, route) => {
  const routeError = requireDebugRoutesEnabled(request, env);
  if (routeError) {
    return routeError;
  }
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  const draft = await getDraft(env, route.params.draftId);
  if (!draft) {
    return json({ error: "Draft not found" }, { status: 404 });
  }

  const draftObject = await env.R2_EMAIL.get(draft.draftR2Key);
  return json({
    draft,
    payload: draftObject ? await draftObject.json<unknown>() : null,
  });
});

router.on("GET", "/v1/debug/outbound-jobs/:outboundJobId", async (request, env, _ctx, route) => {
  const routeError = requireDebugRoutesEnabled(request, env);
  if (routeError) {
    return routeError;
  }
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  const outboundJob = await getOutboundJob(env, route.params.outboundJobId);
  if (!outboundJob) {
    return json({ error: "Outbound job not found" }, { status: 404 });
  }

  return json(outboundJob);
});

router.on("GET", "/v1/debug/suppressions/:email", async (request, env, _ctx, route) => {
  const routeError = requireDebugRoutesEnabled(request, env);
  if (routeError) {
    return routeError;
  }
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  const suppression = await getSuppression(env, decodeURIComponent(route.params.email));
  if (!suppression) {
    return json({ error: "Suppression not found" }, { status: 404 });
  }

  return json(suppression);
});

router.on("POST", "/v1/debug/suppressions", async (request, env) => {
  const routeError = requireDebugRoutesEnabled(request, env);
  if (routeError) {
    return routeError;
  }
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  const body = await readJson<{
    email?: string;
    reason?: string;
    source?: string;
  }>(request);

  if (!body.email?.trim()) {
    return badRequest("email is required");
  }

  await addSuppression(
    env,
    body.email.trim().toLowerCase(),
    body.reason?.trim() || "debug_suppression",
    body.source?.trim() || "debug",
  );

  return json({
    ok: true,
    email: body.email.trim().toLowerCase(),
    reason: body.reason?.trim() || "debug_suppression",
    source: body.source?.trim() || "debug",
  }, { status: 201 });
});

router.on("POST", "/v1/auth/tokens", async (request, env) => {
  const routeError = requireAdminRoutesEnabled(request, env);
  if (routeError) {
    return routeError;
  }
  const adminError = requireAdminSecret(request, env);
  if (adminError) {
    return adminError;
  }

  if (!env.API_SIGNING_SECRET) {
    return json({ error: "API_SIGNING_SECRET is not configured" }, { status: 500 });
  }

  const body = await readJson<{
    sub?: string;
    tenantId?: string;
    agentId?: string;
    scopes?: string[];
    mailboxIds?: string[];
    expiresInSeconds?: number;
  }>(request);

  if (!body.sub || !body.tenantId || !body.scopes?.length) {
    return badRequest("sub, tenantId, and scopes are required");
  }

  if (body.agentId) {
    const agent = await getAgent(env, body.agentId);
    if (!agent) {
      return json({ error: "Agent not found" }, { status: 404 });
    }
    if (agent.tenantId !== body.tenantId) {
      return badRequest("agentId must belong to tenantId");
    }
  }

  if (body.mailboxIds?.length) {
    for (const mailboxId of body.mailboxIds) {
      const mailbox = await getMailboxById(env, mailboxId);
      if (!mailbox) {
        return json({ error: `Mailbox not found: ${mailboxId}` }, { status: 404 });
      }
      if (mailbox.tenant_id !== body.tenantId) {
        return badRequest("mailboxIds must belong to tenantId");
      }
    }
  }
  try {
    await validateTokenAgentMailboxScopes(env, {
      tenantId: body.tenantId,
      agentId: body.agentId,
      mailboxIds: body.mailboxIds,
      scopes: body.scopes,
    });
  } catch (error) {
    if (error instanceof RouteRequestError) {
      return json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  const exp = Math.floor(Date.now() / 1000) + (body.expiresInSeconds ?? 3600);
  const token = await mintAccessToken(env.API_SIGNING_SECRET, {
    sub: body.sub,
    tenantId: body.tenantId,
    agentId: body.agentId,
    scopes: body.scopes,
    mailboxIds: body.mailboxIds,
    exp,
  });

  return json({
    token,
    expiresAt: new Date(exp * 1000).toISOString(),
  }, { status: 201 });
});

router.on("POST", "/v1/agents", async (request, env) => {
  const auth = await requireAuth(request, env, ["agent:create"]);
  if (auth instanceof Response) {
    return auth;
  }
  const controlPlaneError = requireAgentControlPlaneAccess(auth);
  if (controlPlaneError) {
    return controlPlaneError;
  }

  const body = await readJson<{
    tenantId?: string;
    slug?: string;
    name?: string;
    description?: string;
    mode?: "assistant" | "autonomous" | "review_only";
    config?: unknown;
  }>(request);
  if (!body.tenantId || !body.name || !body.mode) {
    return badRequest("tenantId, name, and mode are required");
  }
  const tenantError = enforceTenantAccess(auth, body.tenantId);
  if (tenantError) {
    return tenantError;
  }

  const agent = await createAgent(env, {
    tenantId: body.tenantId,
    slug: body.slug,
    name: body.name,
    description: body.description,
    mode: body.mode,
    config: body.config ?? {},
  });

  return json(agent, { status: 201 });
});

router.on("GET", "/v1/agents", async (request, env) => {
  const auth = await requireAuth(request, env, ["agent:read"]);
  if (auth instanceof Response) {
    return auth;
  }

  const url = new URL(request.url);
  const requestedTenantId = url.searchParams.get("tenantId") ?? undefined;
  if (requestedTenantId) {
    const tenantError = enforceTenantAccess(auth, requestedTenantId);
    if (tenantError) {
      return tenantError;
    }
  }

  if (auth.mailboxIds?.length) {
    return json({ error: "Mailbox-scoped tokens cannot list tenant agents" }, { status: 403 });
  }

  if (auth.agentId) {
    const agent = await getAgent(env, auth.agentId);
    return json({
      items: agent && agent.tenantId === auth.tenantId ? [agent] : [],
    });
  }

  return json({ items: await listAgents(env, requestedTenantId ?? auth.tenantId) });
});

router.on("GET", "/v1/agents/:agentId", async (_request, env, _ctx, route) => {
  const auth = await requireAuth(_request, env, ["agent:read"]);
  if (auth instanceof Response) {
    return auth;
  }
  const controlPlaneError = requireAgentControlPlaneAccess(auth);
  if (controlPlaneError) {
    return controlPlaneError;
  }

  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }

  const tenantError = enforceTenantAccess(auth, agent.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceScopedAgentAccess(auth, agent.id);
  if (agentError) {
    return agentError;
  }

  return json(agent);
});

router.on("PATCH", "/v1/agents/:agentId", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:update"]);
  if (auth instanceof Response) {
    return auth;
  }
  const controlPlaneError = requireAgentControlPlaneAccess(auth);
  if (controlPlaneError) {
    return controlPlaneError;
  }

  const existing = await getAgent(env, route.params.agentId);
  if (!existing) {
    return json({ error: "Agent not found" }, { status: 404 });
  }

  const tenantError = enforceTenantAccess(auth, existing.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceScopedAgentAccess(auth, existing.id);
  if (agentError) {
    return agentError;
  }

  const body = await readJson<{
    slug?: string;
    name?: string;
    description?: string;
    status?: "draft" | "active" | "disabled" | "archived";
    mode?: "assistant" | "autonomous" | "review_only";
    config?: unknown;
    defaultVersionId?: string;
  }>(request);

  if (body.defaultVersionId !== undefined) {
    const defaultVersion = body.defaultVersionId
      ? await getAgentVersion(env, route.params.agentId, body.defaultVersionId)
      : null;
    if (body.defaultVersionId && !defaultVersion) {
      return json({ error: "defaultVersionId must belong to agent" }, { status: 409 });
    }
  }

  return json(await updateAgent(env, route.params.agentId, body));
});

router.on("POST", "/v1/agents/:agentId/versions", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:update"]);
  if (auth instanceof Response) {
    return auth;
  }
  const controlPlaneError = requireAgentControlPlaneAccess(auth);
  if (controlPlaneError) {
    return controlPlaneError;
  }

  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }

  const tenantError = enforceTenantAccess(auth, agent.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceScopedAgentAccess(auth, agent.id);
  if (agentError) {
    return agentError;
  }

  const body = await readJson<{
    version?: string;
    model?: string;
    config?: unknown;
    manifest?: unknown;
    status?: "draft" | "published" | "deprecated";
    capabilities?: Array<{ capability?: string; config?: Record<string, unknown> }>;
    tools?: Array<{ toolName?: string; enabled?: boolean; config?: Record<string, unknown> }>;
  }>(request);

  if (!body.version) {
    return badRequest("version is required");
  }

  return json(await createAgentVersion(env, {
    agentId: route.params.agentId,
    version: body.version,
    model: body.model,
    config: body.config,
    manifest: body.manifest,
    status: body.status,
    capabilities: (body.capabilities ?? [])
      .filter((item): item is { capability: string; config?: Record<string, unknown> } => Boolean(item.capability))
      .map((item) => ({ capability: item.capability, config: item.config })),
    tools: (body.tools ?? [])
      .filter((item): item is { toolName: string; enabled?: boolean; config?: Record<string, unknown> } => Boolean(item.toolName))
      .map((item) => ({ toolName: item.toolName, enabled: item.enabled, config: item.config })),
  }), { status: 201 });
});

router.on("GET", "/v1/agents/:agentId/versions", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:read"]);
  if (auth instanceof Response) {
    return auth;
  }
  const controlPlaneError = requireAgentControlPlaneAccess(auth);
  if (controlPlaneError) {
    return controlPlaneError;
  }

  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }

  const tenantError = enforceTenantAccess(auth, agent.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceScopedAgentAccess(auth, agent.id);
  if (agentError) {
    return agentError;
  }

  return json({ items: await listAgentVersions(env, route.params.agentId) });
});

router.on("GET", "/v1/agents/:agentId/versions/:versionId", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:read"]);
  if (auth instanceof Response) {
    return auth;
  }
  const controlPlaneError = requireAgentControlPlaneAccess(auth);
  if (controlPlaneError) {
    return controlPlaneError;
  }

  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }

  const tenantError = enforceTenantAccess(auth, agent.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceScopedAgentAccess(auth, agent.id);
  if (agentError) {
    return agentError;
  }

  const version = await getAgentVersion(env, route.params.agentId, route.params.versionId);
  if (!version) {
    return json({ error: "Agent version not found" }, { status: 404 });
  }

  return json(version);
});

router.on("POST", "/v1/agents/:agentId/deployments", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:update"]);
  if (auth instanceof Response) {
    return auth;
  }
  const controlPlaneError = requireAgentControlPlaneAccess(auth);
  if (controlPlaneError) {
    return controlPlaneError;
  }

  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }

  const tenantError = enforceTenantAccess(auth, agent.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceScopedAgentAccess(auth, agent.id);
  if (agentError) {
    return agentError;
  }

  const body = await readJson<{
    tenantId?: string;
    agentVersionId?: string;
    targetType?: "mailbox" | "workflow" | "tenant_default";
    targetId?: string;
    status?: "active" | "paused" | "rolled_back";
  }>(request);

  if (!body.tenantId || !body.agentVersionId || !body.targetType || !body.targetId) {
    return badRequest("tenantId, agentVersionId, targetType, and targetId are required");
  }

  const deploymentTenantError = enforceTenantAccess(auth, body.tenantId);
  if (deploymentTenantError) {
    return deploymentTenantError;
  }

  if (body.targetType === "mailbox") {
    const mailboxError = enforceMailboxAccess(auth, body.targetId);
    if (mailboxError) {
      return mailboxError;
    }
    const mailbox = await getMailboxById(env, body.targetId);
    if (!mailbox) {
      return json({ error: "Mailbox not found" }, { status: 404 });
    }
    if (mailbox.tenant_id !== body.tenantId) {
      return json({ error: "Mailbox does not belong to tenant" }, { status: 409 });
    }
  }

  const version = await getAgentVersion(env, route.params.agentId, body.agentVersionId);
  if (!version) {
    return json({ error: "Agent version not found" }, { status: 404 });
  }

  try {
    return json(await createAgentDeployment(env, {
      tenantId: body.tenantId,
      agentId: route.params.agentId,
      agentVersionId: body.agentVersionId,
      targetType: body.targetType,
      targetId: body.targetId,
      status: body.status,
    }), { status: 201 });
  } catch (error) {
    if (error instanceof DeploymentConflictError) {
      return json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
});

router.on("GET", "/v1/agents/:agentId/deployments", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:read"]);
  if (auth instanceof Response) {
    return auth;
  }
  const controlPlaneError = requireAgentControlPlaneAccess(auth);
  if (controlPlaneError) {
    return controlPlaneError;
  }

  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }

  const tenantError = enforceTenantAccess(auth, agent.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceScopedAgentAccess(auth, agent.id);
  if (agentError) {
    return agentError;
  }

  const items = await listAgentDeployments(env, route.params.agentId);
  return json({
    items: auth.mailboxIds?.length
      ? items.filter((item) => item.targetType === "mailbox" && auth.mailboxIds!.includes(item.targetId))
      : items,
  });
});

router.on("PATCH", "/v1/agents/:agentId/deployments/:deploymentId", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:update"]);
  if (auth instanceof Response) {
    return auth;
  }
  const controlPlaneError = requireAgentControlPlaneAccess(auth);
  if (controlPlaneError) {
    return controlPlaneError;
  }

  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }

  const tenantError = enforceTenantAccess(auth, agent.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceScopedAgentAccess(auth, agent.id);
  if (agentError) {
    return agentError;
  }

  const deployment = await getAgentDeployment(env, route.params.agentId, route.params.deploymentId);
  if (!deployment) {
    return json({ error: "Agent deployment not found" }, { status: 404 });
  }

  if (deployment.targetType === "mailbox") {
    const mailboxError = enforceMailboxAccess(auth, deployment.targetId);
    if (mailboxError) {
      return mailboxError;
    }
  }

  const body = await readJson<{ status?: "active" | "paused" | "rolled_back" }>(request);
  if (!body.status) {
    return badRequest("status is required");
  }

  let updated;
  try {
    updated = await updateAgentDeploymentStatus(env, {
      agentId: route.params.agentId,
      deploymentId: route.params.deploymentId,
      status: body.status,
    });
  } catch (error) {
    if (error instanceof DeploymentConflictError) {
      return json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  if (!updated) {
    return json({ error: "Agent deployment not found" }, { status: 404 });
  }

  return json(updated);
});

router.on("POST", "/v1/agents/:agentId/deployments/rollout", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:update"]);
  if (auth instanceof Response) {
    return auth;
  }
  const controlPlaneError = requireAgentControlPlaneAccess(auth);
  if (controlPlaneError) {
    return controlPlaneError;
  }

  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }

  const tenantError = enforceTenantAccess(auth, agent.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceScopedAgentAccess(auth, agent.id);
  if (agentError) {
    return agentError;
  }

  const body = await readJson<{
    tenantId?: string;
    agentVersionId?: string;
    targetType?: "mailbox" | "workflow" | "tenant_default";
    targetId?: string;
  }>(request);

  if (!body.tenantId || !body.agentVersionId || !body.targetType || !body.targetId) {
    return badRequest("tenantId, agentVersionId, targetType, and targetId are required");
  }

  const deploymentTenantError = enforceTenantAccess(auth, body.tenantId);
  if (deploymentTenantError) {
    return deploymentTenantError;
  }

  if (body.targetType === "mailbox") {
    const mailboxError = enforceMailboxAccess(auth, body.targetId);
    if (mailboxError) {
      return mailboxError;
    }
    const mailbox = await getMailboxById(env, body.targetId);
    if (!mailbox) {
      return json({ error: "Mailbox not found" }, { status: 404 });
    }
    if (mailbox.tenant_id !== body.tenantId) {
      return json({ error: "Mailbox does not belong to tenant" }, { status: 409 });
    }
  }

  const version = await getAgentVersion(env, route.params.agentId, body.agentVersionId);
  if (!version) {
    return json({ error: "Agent version not found" }, { status: 404 });
  }

  try {
    return json(await rolloutAgentDeployment(env, {
      tenantId: body.tenantId,
      agentId: route.params.agentId,
      agentVersionId: body.agentVersionId,
      targetType: body.targetType,
      targetId: body.targetId,
    }), { status: 201 });
  } catch (error) {
    if (error instanceof DeploymentConflictError) {
      return json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
});

router.on("POST", "/v1/agents/:agentId/deployments/:deploymentId/rollback", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:update"]);
  if (auth instanceof Response) {
    return auth;
  }
  const controlPlaneError = requireAgentControlPlaneAccess(auth);
  if (controlPlaneError) {
    return controlPlaneError;
  }

  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }

  const tenantError = enforceTenantAccess(auth, agent.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceScopedAgentAccess(auth, agent.id);
  if (agentError) {
    return agentError;
  }

  const deployment = await getAgentDeployment(env, route.params.agentId, route.params.deploymentId);
  if (!deployment) {
    return json({ error: "Agent deployment not found" }, { status: 404 });
  }

  if (deployment.targetType === "mailbox") {
    const mailboxError = enforceMailboxAccess(auth, deployment.targetId);
    if (mailboxError) {
      return mailboxError;
    }
  }

  let rolledBack;
  try {
    rolledBack = await rollbackAgentDeployment(env, {
      agentId: route.params.agentId,
      deploymentId: route.params.deploymentId,
    });
  } catch (error) {
    if (error instanceof DeploymentConflictError) {
      return json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  if (!rolledBack) {
    return json({ error: "Agent deployment not found" }, { status: 404 });
  }

  return json(rolledBack);
});

router.on("POST", "/v1/agents/:agentId/mailboxes", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:bind"]);
  if (auth instanceof Response) {
    return auth;
  }
  const controlPlaneError = requireAgentControlPlaneAccess(auth);
  if (controlPlaneError) {
    return controlPlaneError;
  }

  const body = await readJson<{ tenantId?: string; mailboxId?: string; role?: "primary" | "shared" | "send_only" | "receive_only" }>(request);
  if (!body.tenantId || !body.mailboxId || !body.role) {
    return badRequest("tenantId, mailboxId, and role are required");
  }
  const tenantError = enforceTenantAccess(auth, body.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceScopedAgentAccess(auth, route.params.agentId);
  if (agentError) {
    return agentError;
  }
  const mailboxError = enforceMailboxAccess(auth, body.mailboxId);
  if (mailboxError) {
    return mailboxError;
  }
  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }
  if (agent.tenantId !== body.tenantId) {
    return json({ error: "Agent does not belong to tenant" }, { status: 409 });
  }
  const mailbox = await getMailboxById(env, body.mailboxId);
  if (!mailbox) {
    return json({ error: "Mailbox not found" }, { status: 404 });
  }
  if (mailbox.tenant_id !== body.tenantId) {
    return json({ error: "Mailbox does not belong to tenant" }, { status: 409 });
  }

  try {
    return json(await bindMailbox(env, {
      tenantId: body.tenantId,
      agentId: route.params.agentId,
      mailboxId: body.mailboxId,
      role: body.role,
    }), { status: 201 });
  } catch (error) {
    if (error instanceof MailboxConflictError) {
      return json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
});

router.on("GET", "/v1/agents/:agentId/mailboxes", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:read"]);
  if (auth instanceof Response) {
    return auth;
  }
  const controlPlaneError = requireAgentControlPlaneAccess(auth);
  if (controlPlaneError) {
    return controlPlaneError;
  }
  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }
  const tenantError = enforceTenantAccess(auth, agent.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceScopedAgentAccess(auth, route.params.agentId);
  if (agentError) {
    return agentError;
  }

  const items = await listAgentMailboxes(env, route.params.agentId);
  return json({
    items: auth.mailboxIds?.length
      ? items.filter((item) => auth.mailboxIds!.includes(item.mailboxId))
      : items,
  });
});

router.on("PUT", "/v1/agents/:agentId/policy", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["agent:update"]);
  if (auth instanceof Response) {
    return auth;
  }
  const controlPlaneError = requireAgentControlPlaneAccess(auth);
  if (controlPlaneError) {
    return controlPlaneError;
  }
  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }
  const tenantError = enforceTenantAccess(auth, agent.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceScopedAgentAccess(auth, route.params.agentId);
  if (agentError) {
    return agentError;
  }

  const body = await readJson<{
    autoReplyEnabled?: boolean;
    humanReviewRequired?: boolean;
    confidenceThreshold?: number;
    maxAutoRepliesPerThread?: number;
    allowedRecipientDomains?: string[];
    blockedSenderDomains?: string[];
    allowedTools?: string[];
  }>(request);

  if (
    body.autoReplyEnabled === undefined ||
    body.humanReviewRequired === undefined ||
    body.confidenceThreshold === undefined ||
    body.maxAutoRepliesPerThread === undefined
  ) {
    return badRequest("policy fields are required");
  }

  return json(await upsertAgentPolicy(env, {
    agentId: route.params.agentId,
    autoReplyEnabled: body.autoReplyEnabled,
    humanReviewRequired: body.humanReviewRequired,
    confidenceThreshold: body.confidenceThreshold,
    maxAutoRepliesPerThread: body.maxAutoRepliesPerThread,
    allowedRecipientDomains: body.allowedRecipientDomains ?? [],
    blockedSenderDomains: body.blockedSenderDomains ?? [],
    allowedTools: body.allowedTools ?? [],
  }));
});

router.on("GET", "/v1/agents/:agentId/tasks", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["task:read"]);
  if (auth instanceof Response) {
    return auth;
  }
  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }
  const tenantError = enforceTenantAccess(auth, agent.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceScopedAgentAccess(auth, route.params.agentId);
  if (agentError) {
    return agentError;
  }
  const authorizedMailboxIds = await resolveActiveClaimMailboxIdsForAgent(env, auth, route.params.agentId);
  if (auth.mailboxIds?.length && !authorizedMailboxIds?.length) {
    return json({ error: "Agent is not active for any mailbox in this token" }, { status: 403 });
  }

  const url = new URL(request.url);
  const status = url.searchParams.get("status") as "queued" | "running" | "done" | "needs_review" | "failed" | null;
  return json({ items: await listTasks(env, route.params.agentId, status ?? undefined, authorizedMailboxIds ?? auth.mailboxIds) });
});

router.on("GET", "/v1/messages/:messageId", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["mail:read"]);
  if (auth instanceof Response) {
    return auth;
  }
  const message = await getMessage(env, route.params.messageId);
  if (!message) {
    return json({ error: "Message not found" }, { status: 404 });
  }
  const tenantError = enforceTenantAccess(auth, message.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const mailboxError = enforceMailboxAccess(auth, message.mailboxId);
  if (mailboxError) {
    return mailboxError;
  }
  const currentAccessError = await requireCurrentMailboxAccessForClaims(env, auth, message.mailboxId);
  if (currentAccessError) {
    return currentAccessError;
  }
  const visibilityError = await enforceMailboxScopedMessageVisibility(env, auth, message.id);
  if (visibilityError) {
    return visibilityError;
  }

  return json(message);
});

router.on("GET", "/v1/messages/:messageId/content", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["mail:read"]);
  if (auth instanceof Response) {
    return auth;
  }
  const message = await getMessage(env, route.params.messageId);
  if (!message) {
    return json({ error: "Message not found" }, { status: 404 });
  }
  const tenantError = enforceTenantAccess(auth, message.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const mailboxError = enforceMailboxAccess(auth, message.mailboxId);
  if (mailboxError) {
    return mailboxError;
  }
  const currentAccessError = await requireCurrentMailboxAccessForClaims(env, auth, message.mailboxId);
  if (currentAccessError) {
    return currentAccessError;
  }
  const visibilityError = await enforceMailboxScopedMessageVisibility(env, auth, message.id);
  if (visibilityError) {
    return visibilityError;
  }

  return json(await getMessageContent(env, route.params.messageId));
});

router.on("POST", "/v1/messages/:messageId/reply", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["mail:read", "draft:create", "draft:send"]);
  if (auth instanceof Response) {
    return auth;
  }

  const message = await getMessage(env, route.params.messageId);
  if (!message) {
    return json({ error: "Message not found" }, { status: 404 });
  }
  if (message.direction !== "inbound") {
    return badRequest("Only inbound messages can be replied to");
  }

  const tenantError = enforceTenantAccess(auth, message.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const mailboxError = enforceMailboxAccess(auth, message.mailboxId);
  if (mailboxError) {
    return mailboxError;
  }
  const visibilityError = await enforceMailboxScopedMessageVisibility(env, auth, message.id);
  if (visibilityError) {
    return visibilityError;
  }

  const selfAgent = await resolveSelfAgentForMailbox(env, auth, message.mailboxId);
  if (selfAgent instanceof Response) {
    return selfAgent;
  }

  const body = await readJson<{
    text?: string;
    html?: string;
    idempotencyKey?: string;
  }>(request);

  if (!body.text && !body.html) {
    return badRequest("text or html is required");
  }

  const rawThread = message.threadId ? await getThread(env, message.threadId) : null;
  const thread = rawThread ? await filterVisibleThreadForClaims(env, auth, rawThread) : null;
  const references = Array.from(new Set(
    (thread?.messages ?? [])
      .map((item) => item.internetMessageId)
      .filter((item): item is string => Boolean(item))
  ));
  if (message.internetMessageId && !references.includes(message.internetMessageId)) {
    references.push(message.internetMessageId);
  }
  const replyMailbox = await getMailboxById(env, message.mailboxId);
  if (!replyMailbox) {
    return json({ error: "Mailbox not found" }, { status: 404 });
  }

  const replySubject = message.subject && message.subject.toLowerCase().startsWith("re:")
    ? message.subject
    : `Re: ${message.subject ?? ""}`.trim();
  const replyFrom = replyMailbox.address;

  const result = await createAndSendDraft(env, {
    tenantId: message.tenantId,
    agentId: selfAgent.id,
    mailboxId: message.mailboxId,
    threadId: message.threadId,
    sourceMessageId: message.id,
    payload: {
      from: replyFrom,
      to: [message.fromAddr],
      cc: [],
      bcc: [],
      subject: replySubject || "Re:",
      text: body.text ?? "",
      html: body.html ?? "",
      inReplyTo: message.internetMessageId,
      references,
      attachments: [],
    },
    createdVia: "api:v1/messages/:messageId/reply",
    idempotencyKey: body.idempotencyKey?.trim(),
    requestFingerprint: JSON.stringify({
      route: "v1/messages/:messageId/reply",
      messageId: route.params.messageId,
      text: body.text ?? "",
      html: body.html ?? "",
    }),
  });

  return accepted({
    ...result,
    sourceMessageId: message.id,
    threadId: message.threadId,
  });
});

router.on("POST", "/v1/messages/:messageId/replay", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["mail:replay"]);
  if (auth instanceof Response) {
    return auth;
  }

  const body = await readJson<{ mode?: "normalize" | "rerun_agent"; agentId?: string; idempotencyKey?: string }>(request);
  if (!body.mode) {
    return badRequest("mode is required");
  }
  if (body.mode !== "normalize" && body.mode !== "rerun_agent") {
    return badRequest("mode must be normalize or rerun_agent");
  }
  const existingMessage = await getMessage(env, route.params.messageId);
  if (!existingMessage) {
    return json({ error: "Message not found" }, { status: 404 });
  }
  const tenantError = enforceTenantAccess(auth, existingMessage.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const mailboxError = enforceMailboxAccess(auth, existingMessage.mailboxId);
  if (mailboxError) {
    return mailboxError;
  }
  const currentAccessError = await requireCurrentMailboxAccessForClaims(env, auth, existingMessage.mailboxId);
  if (currentAccessError) {
    return currentAccessError;
  }
  const visibilityError = await enforceMailboxScopedMessageVisibility(env, auth, existingMessage.id);
  if (visibilityError) {
    return visibilityError;
  }

  const idempotencyKey = body.idempotencyKey?.trim();
  if (body.idempotencyKey !== undefined && !idempotencyKey) {
    return badRequest("idempotencyKey must be a non-empty string");
  }

  const resolveReplayExecution = async () => {
    if (body.mode === "normalize") {
      if (!existingMessage.rawR2Key) {
        return badRequest("normalize replay requires the message to have raw email content");
      }
      if (!(await env.R2_EMAIL.get(existingMessage.rawR2Key))) {
        return json({ error: "Raw email content not found" }, { status: 404 });
      }

      return {
        replayRawR2Key: existingMessage.rawR2Key,
        replayAgentTarget: undefined,
      };
    }

    const replayTarget = await resolveReplayAgentTarget(env, auth, existingMessage.mailboxId, body.agentId);
    if (replayTarget instanceof Response) {
      return replayTarget;
    }

    return {
      replayRawR2Key: undefined,
      replayAgentTarget: replayTarget,
    };
  };

  const replayResponse = {
    messageId: route.params.messageId,
    mode: body.mode,
    status: "accepted" as const,
  };

  if (idempotencyKey) {
    const reservation = await reserveIdempotencyKey(env, {
      operation: "message_replay",
      tenantId: existingMessage.tenantId,
      idempotencyKey,
      requestFingerprint: JSON.stringify({
        messageId: route.params.messageId,
        mode: body.mode,
        agentId: body.agentId ?? null,
      }),
    });

    if (reservation.status === "conflict") {
      return json({ error: "Idempotency key is already used for a different replay request" }, { status: 409 });
    }
    if (reservation.status === "pending") {
      if (reservation.record.resourceId) {
        const replayExecution = await resolveReplayExecution();
        if (replayExecution instanceof Response) {
          return replayExecution;
        }
        await bestEffortCompleteRecoveredIdempotency(env, {
          operation: "message_replay",
          tenantId: existingMessage.tenantId,
          idempotencyKey,
          resourceId: route.params.messageId,
          response: replayResponse,
        });
        return accepted(replayResponse);
      }
      return json({ error: "A replay request with this idempotency key is already in progress" }, { status: 409 });
    }
    if (reservation.status === "completed") {
      const replayExecution = await resolveReplayExecution();
      if (replayExecution instanceof Response) {
        return replayExecution;
      }
      return accepted(reservation.record.response ?? replayResponse);
    }

    let replayQueued = false;
    try {
      const replayExecution = await resolveReplayExecution();
      if (replayExecution instanceof Response) {
        await releaseIdempotencyKey(env, "message_replay", existingMessage.tenantId, idempotencyKey);
        return replayExecution;
      }

      if (body.mode === "normalize") {
        if (!replayExecution.replayRawR2Key) {
          await releaseIdempotencyKey(env, "message_replay", existingMessage.tenantId, idempotencyKey);
          return badRequest("normalize replay requires the message to have raw email content");
        }
        await env.EMAIL_INGEST_QUEUE.send({
          messageId: route.params.messageId,
          tenantId: existingMessage.tenantId,
          mailboxId: existingMessage.mailboxId,
          rawR2Key: replayExecution.replayRawR2Key,
        });
        replayQueued = true;
      } else {
        await enqueueReplayTask(env, {
          tenantId: existingMessage.tenantId,
          mailboxId: existingMessage.mailboxId,
          sourceMessageId: route.params.messageId,
          agentId: replayExecution.replayAgentTarget!.agentId,
          agentVersionId: replayExecution.replayAgentTarget!.agentVersionId,
          deploymentId: replayExecution.replayAgentTarget!.deploymentId,
        });
        replayQueued = true;
      }

      await updateIdempotencyKeyResource(env, {
        operation: "message_replay",
        tenantId: existingMessage.tenantId,
        idempotencyKey,
        resourceId: route.params.messageId,
      });
      await completeIdempotencyKey(env, {
        operation: "message_replay",
        tenantId: existingMessage.tenantId,
        idempotencyKey,
        resourceId: route.params.messageId,
        response: replayResponse,
      });
      return accepted(replayResponse);
    } catch (error) {
      if (!replayQueued) {
        await releaseIdempotencyKey(env, "message_replay", existingMessage.tenantId, idempotencyKey);
      }
      throw replayQueued ? markSideEffectCommitted(error) : error;
    }
  }

  const replayExecution = await resolveReplayExecution();
  if (replayExecution instanceof Response) {
    return replayExecution;
  }

  if (body.mode === "normalize") {
    if (!replayExecution.replayRawR2Key) {
      return badRequest("normalize replay requires the message to have raw email content");
    }
    await env.EMAIL_INGEST_QUEUE.send({
      messageId: route.params.messageId,
      tenantId: existingMessage.tenantId,
      mailboxId: existingMessage.mailboxId,
      rawR2Key: replayExecution.replayRawR2Key,
    });
  } else {
    await enqueueReplayTask(env, {
      tenantId: existingMessage.tenantId,
      mailboxId: existingMessage.mailboxId,
      sourceMessageId: route.params.messageId,
      agentId: replayExecution.replayAgentTarget!.agentId,
      agentVersionId: replayExecution.replayAgentTarget!.agentVersionId,
      deploymentId: replayExecution.replayAgentTarget!.deploymentId,
    });
  }

  return accepted({
    messageId: route.params.messageId,
    mode: body.mode,
    status: "accepted",
  });
});

router.on("GET", "/v1/threads/:threadId", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["mail:read"]);
  if (auth instanceof Response) {
    return auth;
  }
  const thread = await getThread(env, route.params.threadId);
  if (!thread) {
    return json({ error: "Thread not found" }, { status: 404 });
  }
  const tenantError = enforceTenantAccess(auth, thread.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const mailboxError = enforceMailboxAccess(auth, thread.mailboxId);
  if (mailboxError) {
    return mailboxError;
  }
  const currentAccessError = await requireCurrentMailboxAccessForClaims(env, auth, thread.mailboxId);
  if (currentAccessError) {
    return currentAccessError;
  }

  const visibleThread = await filterVisibleThreadForClaims(env, auth, thread);
  if (!visibleThread) {
    return json({ error: "Thread not found" }, { status: 404 });
  }

  return json(visibleThread);
});

router.on("POST", "/v1/agents/:agentId/drafts", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["draft:create"]);
  if (auth instanceof Response) {
    return auth;
  }
  const agentError = enforceScopedAgentAccess(auth, route.params.agentId);
  if (agentError) {
    return agentError;
  }

  const body = await readJson<{
    tenantId?: string;
    mailboxId?: string;
    threadId?: string;
    sourceMessageId?: string;
    from?: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    text?: string;
    html?: string;
    inReplyTo?: string;
    references?: string[];
    attachments?: Array<{ filename: string; contentType: string; r2Key: string }>;
  }>(request);
  if (!body.tenantId || !body.mailboxId || !body.from || !body.to?.length || !body.subject) {
    return badRequest("tenantId, mailboxId, from, to, and subject are required");
  }
  const tenantError = enforceTenantAccess(auth, body.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const mailboxError = enforceMailboxAccess(auth, body.mailboxId);
  if (mailboxError) {
    return mailboxError;
  }
  const agent = await getAgent(env, route.params.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }
  if (agent.tenantId !== body.tenantId) {
    return json({ error: "Agent does not belong to tenant" }, { status: 409 });
  }
  const mailbox = await getMailboxById(env, body.mailboxId);
  if (!mailbox) {
    return json({ error: "Mailbox not found" }, { status: 404 });
  }
  if (mailbox.tenant_id !== body.tenantId) {
    return json({ error: "Mailbox does not belong to tenant" }, { status: 409 });
  }
  if (body.from.trim().toLowerCase() !== mailbox.address.trim().toLowerCase()) {
    return badRequest("from must match the mailbox address");
  }
  await validateDraftAgentBinding(env, {
    tenantId: body.tenantId,
    agentId: route.params.agentId,
    mailboxId: body.mailboxId,
  });
  await validateDraftReferences(env, {
    tenantId: body.tenantId,
    mailboxId: body.mailboxId,
    threadId: body.threadId,
    sourceMessageId: body.sourceMessageId,
  });
  const referenceVisibilityError = await enforceMailboxScopedDraftReferenceVisibility(env, auth, {
    threadId: body.threadId,
    sourceMessageId: body.sourceMessageId,
  });
  if (referenceVisibilityError) {
    return referenceVisibilityError;
  }
  await validateDraftAttachments(env, {
    tenantId: body.tenantId,
    mailboxId: body.mailboxId,
    attachments: body.attachments ?? [],
  });

  return json(await createDraft(env, {
    tenantId: body.tenantId,
    agentId: route.params.agentId,
    mailboxId: body.mailboxId,
    threadId: body.threadId,
    sourceMessageId: body.sourceMessageId,
    createdVia: "api:v1/agents/:agentId/drafts",
    payload: {
      from: body.from,
      to: body.to,
      cc: body.cc ?? [],
      bcc: body.bcc ?? [],
      subject: body.subject,
      text: body.text ?? "",
      html: body.html ?? "",
      inReplyTo: body.inReplyTo,
      references: body.references ?? [],
      attachments: body.attachments ?? [],
    },
  }), { status: 201 });
});

router.on("GET", "/v1/drafts/:draftId", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["draft:read"]);
  if (auth instanceof Response) {
    return auth;
  }
  const draft = await getDraft(env, route.params.draftId);
  if (!draft) {
    return json({ error: "Draft not found" }, { status: 404 });
  }
  const tenantError = enforceTenantAccess(auth, draft.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceScopedAgentAccess(auth, draft.agentId);
  if (agentError) {
    return agentError;
  }
  const mailboxError = enforceMailboxAccess(auth, draft.mailboxId);
  if (mailboxError) {
    return mailboxError;
  }
  await validateDraftAgentBinding(env, {
    tenantId: draft.tenantId,
    agentId: draft.agentId,
    mailboxId: draft.mailboxId,
  });

  return json(await sanitizeDraftReferencesForClaims(env, auth, draft));
});

router.on("DELETE", "/v1/drafts/:draftId", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["draft:create"]);
  if (auth instanceof Response) {
    return auth;
  }
  const draft = await getDraft(env, route.params.draftId);
  if (!draft) {
    return json({ error: "Draft not found" }, { status: 404 });
  }
  const tenantError = enforceTenantAccess(auth, draft.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceScopedAgentAccess(auth, draft.agentId);
  if (agentError) {
    return agentError;
  }
  const mailboxError = enforceMailboxAccess(auth, draft.mailboxId);
  if (mailboxError) {
    return mailboxError;
  }
  await validateDraftAgentBinding(env, {
    tenantId: draft.tenantId,
    agentId: draft.agentId,
    mailboxId: draft.mailboxId,
  });

  if (draft.status === "queued" || draft.status === "sent") {
    return json({ error: `Draft status ${draft.status} cannot be cancelled` }, { status: 409 });
  }

  if (draft.status !== "cancelled") {
    await markDraftStatus(env, draft.id, "cancelled");
  }

  return json({
    ok: true,
    id: draft.id,
    status: "cancelled",
  });
});

router.on("POST", "/v1/drafts/:draftId/send", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["draft:send"]);
  if (auth instanceof Response) {
    return auth;
  }
  const draft = await getDraft(env, route.params.draftId);
  if (!draft) {
    return json({ error: "Draft not found" }, { status: 404 });
  }
  const tenantError = enforceTenantAccess(auth, draft.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const agentError = enforceScopedAgentAccess(auth, draft.agentId);
  if (agentError) {
    return agentError;
  }
  const mailboxError = enforceMailboxAccess(auth, draft.mailboxId);
  if (mailboxError) {
    return mailboxError;
  }
  await validateDraftAgentBinding(env, {
    tenantId: draft.tenantId,
    agentId: draft.agentId,
    mailboxId: draft.mailboxId,
  });

  const body = await readOptionalJson<{ idempotencyKey?: string }>(request);
  const idempotencyKey = body?.idempotencyKey?.trim();
  if (body?.idempotencyKey !== undefined && !idempotencyKey) {
    return badRequest("idempotencyKey must be a non-empty string");
  }
  const validateReplayableDraftSend = async () => {
    await validateDraftReferences(env, {
      tenantId: draft.tenantId,
      mailboxId: draft.mailboxId,
      threadId: draft.threadId ?? undefined,
      sourceMessageId: draft.sourceMessageId ?? undefined,
    });
    await validateStoredDraftFromAddress(env, draft);
    await validateStoredDraftAttachments(env, draft);
    const referenceVisibilityError = await enforceMailboxScopedDraftReferenceVisibility(env, auth, {
      threadId: draft.threadId ?? undefined,
      sourceMessageId: draft.sourceMessageId ?? undefined,
    });
    if (referenceVisibilityError) {
      throw new RouteRequestError("Draft references are not visible for this token", 404);
    }
    await validateActiveDraftMailbox(env, {
      tenantId: draft.tenantId,
      mailboxId: draft.mailboxId,
    });
    await validateSendAgentBinding(env, {
      tenantId: draft.tenantId,
      agentId: draft.agentId,
      mailboxId: draft.mailboxId,
    });
    await validateDraftOutboundPolicy(env, draft);
    await validateDraftOutboundCredits(env, draft);
  };

  if (idempotencyKey) {
    const reservation = await reserveIdempotencyKey(env, {
      operation: "draft_send",
      tenantId: draft.tenantId,
      idempotencyKey,
      requestFingerprint: JSON.stringify({ draftId: route.params.draftId }),
    });

    if (reservation.status === "conflict") {
      return json({ error: "Idempotency key is already used for a different draft send request" }, { status: 409 });
    }
    if (reservation.status === "pending") {
      if (reservation.record.resourceId) {
        await validateReplayableDraftSend();
        const response = await restoreEnqueuedDraftSend(env, {
          draftId: route.params.draftId,
          outboundJobId: reservation.record.resourceId,
        });
        await bestEffortCompleteRecoveredIdempotency(env, {
          operation: "draft_send",
          tenantId: draft.tenantId,
          idempotencyKey,
          resourceId: response.outboundJobId,
          response,
        });
        return accepted(buildQueuedSendAcceptedResponse(response));
      }
      return json({ error: "A draft send request with this idempotency key is already in progress" }, { status: 409 });
    }
    if (reservation.status === "completed") {
      await validateReplayableDraftSend();
      return accepted(buildQueuedSendAcceptedResponse(
        reservation.record.response as {
          draftId: string;
          outboundJobId: string;
          status: "queued";
        } ?? await restoreEnqueuedDraftSend(env, {
          draftId: route.params.draftId,
          outboundJobId: reservation.record.resourceId,
        })
      ));
    }

    if (draft.status !== "draft" && draft.status !== "approved") {
      await releaseIdempotencyKey(env, "draft_send", draft.tenantId, idempotencyKey);
      return json({ error: `Draft status ${draft.status} cannot be sent again` }, { status: 409 });
    }

    let sendEnqueued = false;
    try {
      await validateReplayableDraftSend();
      const result = await enqueueDraftSend(env, route.params.draftId);
      const response = {
        draftId: route.params.draftId,
        outboundJobId: result.outboundJobId,
        status: result.status,
      };
      sendEnqueued = true;

      await updateIdempotencyKeyResource(env, {
        operation: "draft_send",
        tenantId: draft.tenantId,
        idempotencyKey,
        resourceId: result.outboundJobId,
      });
      await completeIdempotencyKey(env, {
        operation: "draft_send",
        tenantId: draft.tenantId,
        idempotencyKey,
        resourceId: result.outboundJobId,
        response,
      });
      return accepted(buildQueuedSendAcceptedResponse(response));
    } catch (error) {
      if (!sendEnqueued) {
        await releaseIdempotencyKey(env, "draft_send", draft.tenantId, idempotencyKey);
      }
      throw sendEnqueued ? markSideEffectCommitted(error) : error;
    }
  }

  if (draft.status !== "draft" && draft.status !== "approved") {
    return json({ error: `Draft status ${draft.status} cannot be sent again` }, { status: 409 });
  }
  await validateDraftReferences(env, {
    tenantId: draft.tenantId,
    mailboxId: draft.mailboxId,
    threadId: draft.threadId ?? undefined,
    sourceMessageId: draft.sourceMessageId ?? undefined,
  });
  await validateActiveDraftMailbox(env, {
    tenantId: draft.tenantId,
    mailboxId: draft.mailboxId,
  });
  await validateStoredDraftFromAddress(env, draft);
  await validateStoredDraftAttachments(env, draft);
  await validateSendAgentBinding(env, {
    tenantId: draft.tenantId,
    agentId: draft.agentId,
    mailboxId: draft.mailboxId,
  });
  await validateDraftOutboundPolicy(env, draft);
  await validateDraftOutboundCredits(env, draft);

  const result = await enqueueDraftSend(env, route.params.draftId);
  return accepted(buildQueuedSendAcceptedResponse({
    draftId: route.params.draftId,
    outboundJobId: result.outboundJobId,
    status: result.status,
  }));
});

router.on("GET", "/v1/outbound-jobs/:outboundJobId", async (request, env, _ctx, route) => {
  const auth = await requireAuth(request, env, ["draft:read"]);
  if (auth instanceof Response) {
    return auth;
  }

  const outboundJob = await getOutboundJob(env, route.params.outboundJobId);
  if (!outboundJob) {
    return json({ error: "Outbound job not found" }, { status: 404 });
  }

  const message = await getMessage(env, outboundJob.messageId);
  if (!message) {
    return json({ error: "Outbound job message not found" }, { status: 404 });
  }

  const tenantError = enforceTenantAccess(auth, message.tenantId);
  if (tenantError) {
    return tenantError;
  }
  const mailboxError = enforceMailboxAccess(auth, message.mailboxId);
  if (mailboxError) {
    return mailboxError;
  }
  const currentAccessError = await requireCurrentMailboxAccessForClaims(env, auth, message.mailboxId);
  if (currentAccessError) {
    return currentAccessError;
  }

  const draft = await getDraftByR2KeyForOutboundLifecycle(env, outboundJob.draftR2Key);
  const sanitizedDraft = draft ? await sanitizeDraftReferencesForClaims(env, auth, draft) : null;
  const deliveryEvents = await listDeliveryEventsByMessageId(env, message.id);
  const finalDeliveryState = outboundJob.status === "sent"
    ? "sent"
    : outboundJob.status === "failed"
      ? "failed"
      : "pending";

  return json({
    id: outboundJob.id,
    status: outboundJob.status,
    retryCount: outboundJob.retryCount,
    nextRetryAt: outboundJob.nextRetryAt,
    lastError: outboundJob.lastError,
    createdAt: outboundJob.createdAt,
    updatedAt: outboundJob.updatedAt,
    acceptedForDelivery: true,
    deliveryState: outboundJob.status,
    finalDeliveryState,
    message: {
      id: message.id,
      status: message.status,
      providerMessageId: message.providerMessageId,
      fromAddr: message.fromAddr,
      toAddr: message.toAddr,
      subject: message.subject,
      sentAt: message.sentAt,
      createdAt: message.createdAt,
    },
    draft: sanitizedDraft
      ? {
          id: sanitizedDraft.id,
          status: sanitizedDraft.status,
          threadId: sanitizedDraft.threadId,
          sourceMessageId: sanitizedDraft.sourceMessageId,
          createdVia: sanitizedDraft.createdVia,
          updatedAt: sanitizedDraft.updatedAt,
        }
      : null,
    deliveryEvents,
  });
});

router.on("POST", "/v1/webhooks/ses", async (request, env) => {
  if (!env.WEBHOOK_SHARED_SECRET) {
    return json({ error: "WEBHOOK_SHARED_SECRET is not configured" }, { status: 500 });
  }

  const provided = request.headers.get("x-webhook-shared-secret");
  if (provided !== env.WEBHOOK_SHARED_SECRET) {
    return json({ error: "Unauthorized webhook" }, { status: 401 });
  }

  const body = await readJson<unknown>(request);
  const normalized = normalizeSesEvent(body);
  const providerMessage = normalized.providerMessageId
    ? await getMessageByProviderMessageId(env, normalized.providerMessageId)
    : null;
  const taggedMessageId = normalized.mailTags.message_id;
  const taggedTenantId = normalized.mailTags.tenant_id;
  const taggedMessage = !providerMessage && taggedMessageId
    ? await getMessage(env, taggedMessageId)
    : null;
  const message = providerMessage ?? taggedMessage;

  if (providerMessage && taggedMessageId && providerMessage.id !== taggedMessageId) {
    return json({ error: "Webhook message tag mismatch" }, { status: 409 });
  }
  if (message && taggedTenantId && message.tenantId !== taggedTenantId) {
    return json({ error: "Webhook tenant tag mismatch" }, { status: 409 });
  }
  if (taggedMessage && normalized.providerMessageId && taggedMessage.providerMessageId && taggedMessage.providerMessageId !== normalized.providerMessageId) {
    return json({ error: "Webhook provider message mismatch" }, { status: 409 });
  }

  const payloadR2Key = await buildSesPayloadR2Key(body);
  await env.R2_EMAIL.put(payloadR2Key, JSON.stringify(body, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });

  try {
    await insertDeliveryEvent(env, {
      messageId: message?.id,
      providerMessageId: normalized.providerMessageId,
      eventType: normalized.eventType,
      payloadR2Key,
    });
  } catch (error) {
    await env.R2_EMAIL.delete(payloadR2Key).catch(() => undefined);
    throw error;
  }

  if (message && normalized.providerMessageId && (!message.providerMessageId || !message.sentAt)) {
    await backfillMessageProviderAcceptance(env, {
      messageId: message.id,
      providerMessageId: normalized.providerMessageId,
    });
  }

  const isTerminalSesEvent =
    normalized.eventType === "delivery"
    || normalized.eventType === "bounce"
    || normalized.eventType === "complaint"
    || normalized.eventType === "reject";

  if (isTerminalSesEvent && message) {
    const outboundJob = await getOutboundJobByMessageId(env, message.id);
    if (outboundJob) {
      const deliveryError = normalized.reason ?? normalized.eventType;
      const draft = await getDraftByR2KeyForOutboundLifecycle(env, outboundJob.draftR2Key);
      const deliveryEvents = await listDeliveryEventsByMessageId(env, message.id);
      const hasDeliveryEvidence = deliveryEvents.some((event) => event.eventType === "delivery");
      const treatAsDelivered = normalized.eventType === "delivery" || hasDeliveryEvidence;
      if (draft) {
        const recipients = await readDraftRecipients(env, outboundJob.draftR2Key);
        if (treatAsDelivered) {
          await settleOutboundUsageDebit(env, {
            tenantId: draft.tenantId,
            messageId: outboundJob.messageId,
            outboundJobId: outboundJob.id,
            draftId: draft.id,
            draftCreatedVia: draft.createdVia,
            sourceMessageId: draft.sourceMessageId,
            ...recipients,
          });
        } else if (outboundJob.status !== "failed") {
          await releaseOutboundUsageReservation(env, {
            tenantId: draft.tenantId,
            outboundJobId: outboundJob.id,
            sourceMessageId: draft.sourceMessageId,
            draftCreatedVia: draft.createdVia,
            ...recipients,
          });
        }
      }
      if (treatAsDelivered) {
        await updateMessageStatus(env, message.id, "replied");
        await updateOutboundJobStatus(env, {
          outboundJobId: outboundJob.id,
          status: "sent",
          lastError: null,
          nextRetryAt: null,
        });
        if (draft) {
          await markDraftStatus(env, draft.id, "sent");
        }
      } else {
        await updateMessageStatus(env, message.id, "failed");
        await updateOutboundJobStatus(env, {
          outboundJobId: outboundJob.id,
          status: "failed",
          lastError: deliveryError,
          nextRetryAt: null,
        });
        if (draft) {
          await markDraftStatus(env, draft.id, "failed");
        }
      }
    }
  } else if (isTerminalSesEvent && normalized.providerMessageId) {
    const status = normalized.eventType === "delivery" ? "replied" : "failed";
    await updateMessageStatusByProviderMessageId(env, normalized.providerMessageId, status);
  }

  if (normalized.eventType === "bounce" || normalized.eventType === "complaint") {
    for (const recipient of normalized.recipients) {
      await addSuppression(env, recipient, normalized.reason ?? normalized.eventType, "ses");
    }
  }

  return accepted({
    provider: "ses",
    received: true,
    eventType: normalized.eventType,
    providerMessageId: normalized.providerMessageId,
  });
});

export async function handleApiRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  if (request.method.toUpperCase() === "OPTIONS") {
    if (isPublicSelfServeRequest(request)) {
      return publicSelfServePreflight();
    }
    if (isAuthenticatedApiCorsRequest(request)) {
      return authenticatedApiPreflight(request) ?? withAuthenticatedApiCors(request, notFound());
    }
  }

  try {
    const response = await router.handle(request, env, ctx);
    if (!response) {
      return isAuthenticatedApiCorsRequest(request) ? withAuthenticatedApiCors(request, notFound()) : null;
    }
    if (isPublicSelfServeRequest(request)) {
      return withPublicSelfServeCors(response);
    }
    return isAuthenticatedApiCorsRequest(request) ? withAuthenticatedApiCors(request, response) : response;
  } catch (error) {
    if (error instanceof InvalidJsonBodyError) {
      const response = badRequest(error.message);
      if (isPublicSelfServeRequest(request)) {
        return withPublicSelfServeCors(response);
      }
      return isAuthenticatedApiCorsRequest(request) ? withAuthenticatedApiCors(request, response) : response;
    }
    if (error instanceof RouteRequestError) {
      const response = json(error.body ?? { error: error.message }, { status: error.status });
      if (isPublicSelfServeRequest(request)) {
        return withPublicSelfServeCors(response);
      }
      return isAuthenticatedApiCorsRequest(request) ? withAuthenticatedApiCors(request, response) : response;
    }
    if (error instanceof BillingUniquenessError) {
      const response = json({ error: error.message }, { status: 409 });
      if (isPublicSelfServeRequest(request)) {
        return withPublicSelfServeCors(response);
      }
      return isAuthenticatedApiCorsRequest(request) ? withAuthenticatedApiCors(request, response) : response;
    }
    if (error instanceof AgentRegistryConflictError) {
      const response = json({ error: error.message }, { status: 409 });
      if (isPublicSelfServeRequest(request)) {
        return withPublicSelfServeCors(response);
      }
      return isAuthenticatedApiCorsRequest(request) ? withAuthenticatedApiCors(request, response) : response;
    }
    if (error instanceof DidBindingConflictError) {
      const response = json({ error: error.message }, { status: 409 });
      if (isPublicSelfServeRequest(request)) {
        return withPublicSelfServeCors(response);
      }
      return isAuthenticatedApiCorsRequest(request) ? withAuthenticatedApiCors(request, response) : response;
    }
    if (hasCommittedSideEffect(error)) {
      const response = json({
        error: "Request may have partially succeeded after creating server-side state. Retry only with the same idempotency key or inspect draft/outbound state before retrying.",
      }, { status: 409 });
      if (isPublicSelfServeRequest(request)) {
        return withPublicSelfServeCors(response);
      }
      return isAuthenticatedApiCorsRequest(request) ? withAuthenticatedApiCors(request, response) : response;
    }

    throw error;
  }
}

function normalizeMailboxLookup(env: Env, input: { mailboxAlias?: string; mailboxAddress?: string }): {
  mailboxAddress: string | null;
  error?: string;
} {
  const address = input.mailboxAddress?.trim().toLowerCase();
  if (address) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)
      ? { mailboxAddress: address }
      : { mailboxAddress: null, error: "mailboxAddress must be a valid email address" };
  }

  const alias = input.mailboxAlias?.trim().toLowerCase();
  if (!alias) {
    return { mailboxAddress: null };
  }

  const domain = env.CLOUDFLARE_EMAIL_DOMAIN ?? "mailagents.net";
  return /^[a-z0-9][a-z0-9._+-]{2,31}$/.test(alias)
    ? { mailboxAddress: `${alias}@${domain}` }
    : {
      mailboxAddress: null,
      error: "mailboxAlias must be 3-32 characters, start with a letter or digit, and use only lowercase letters, digits, ., _, +, or -",
    };
}

function isoSecondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

async function hashRequesterIp(ip: string | null): Promise<string | null> {
  const normalizedIp = ip?.trim();
  if (!normalizedIp) {
    return null;
  }

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizedIp));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isMissingTableError(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

async function isMailboxScopedOperatorTokenDeliveryMessage(env: Env, messageId: string): Promise<boolean> {
  const outboundJob = await getOutboundJobByMessageId(env, messageId);
  if (!outboundJob) {
    return false;
  }

  const draft = await getDraftByR2KeyForOutboundLifecycle(env, outboundJob.draftR2Key);
  return draft?.createdVia === "system:token_reissue_operator_email";
}

async function enforceMailboxScopedMessageVisibility(
  env: Env,
  auth: AccessTokenClaims,
  messageId: string,
): Promise<Response | null> {
  if (!auth.mailboxIds?.length) {
    return null;
  }

  if (await isMailboxScopedOperatorTokenDeliveryMessage(env, messageId)) {
    return json({ error: "Message not found" }, { status: 404 });
  }

  return null;
}

async function filterVisibleThreadForClaims(
  env: Env,
  auth: AccessTokenClaims,
  thread: NonNullable<Awaited<ReturnType<typeof getThread>>>,
): Promise<NonNullable<Awaited<ReturnType<typeof getThread>>> | null> {
  if (!auth.mailboxIds?.length) {
    return thread;
  }

  const messages = [];
  for (const message of thread.messages) {
    if (!(await isMailboxScopedOperatorTokenDeliveryMessage(env, message.id))) {
      messages.push(message);
    }
  }

  if (messages.length === 0) {
    return null;
  }

  return {
    ...thread,
    messages,
  };
}

async function enforceMailboxScopedDraftReferenceVisibility(env: Env, auth: AccessTokenClaims, input: {
  threadId?: string;
  sourceMessageId?: string;
}): Promise<Response | null> {
  if (input.sourceMessageId) {
    const messageError = await enforceMailboxScopedMessageVisibility(env, auth, input.sourceMessageId);
    if (messageError) {
      return messageError;
    }
  }

  if (input.threadId) {
    const thread = await getThread(env, input.threadId);
    if (thread && !(await filterVisibleThreadForClaims(env, auth, thread))) {
      return json({ error: "Thread not found" }, { status: 404 });
    }
  }

  return null;
}

async function sanitizeDraftReferencesForClaims(
  env: Env,
  auth: AccessTokenClaims,
  draft: NonNullable<Awaited<ReturnType<typeof getDraft>>>,
): Promise<NonNullable<Awaited<ReturnType<typeof getDraft>>>> {
  if (!auth.mailboxIds?.length) {
    return draft;
  }

  let sourceMessageId = draft.sourceMessageId;
  if (sourceMessageId) {
    const messageError = await enforceMailboxScopedMessageVisibility(env, auth, sourceMessageId);
    if (messageError) {
      sourceMessageId = undefined;
    }
  }

  let threadId = draft.threadId;
  if (threadId) {
    const thread = await getThread(env, threadId);
    if (thread && !(await filterVisibleThreadForClaims(env, auth, thread))) {
      threadId = undefined;
    }
  }

  if (sourceMessageId === draft.sourceMessageId && threadId === draft.threadId) {
    return draft;
  }

  return {
    ...draft,
    sourceMessageId,
    threadId,
  };
}

async function reissueMailboxAccessToken(env: Env, mailboxAddress: string): Promise<boolean> {
  let draftId: string | undefined;

  try {
    const mailbox = await getMailboxByAddress(env, mailboxAddress);
    if (!mailbox || mailbox.status !== "active") {
      return false;
    }

    const executionTarget = await resolveAgentExecutionTarget(env, mailbox.id, undefined, [...SEND_CAPABLE_MAILBOX_ROLES]);
    if (!executionTarget?.agentId) {
      return false;
    }

    const agent = await getAgent(env, executionTarget.agentId);
    if (!agent?.configR2Key) {
      return false;
    }

    const config = await readAgentConfig(env, agent.configR2Key);
    const operatorEmail = typeof config?.operatorEmail === "string" ? config.operatorEmail.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(operatorEmail)) {
      return false;
    }

    const productName = typeof config?.productName === "string" && config.productName.trim()
      ? config.productName.trim()
      : "Mailagents";
    const access = await issueSelfServeAccessToken({
      env,
      tenantId: mailbox.tenant_id,
      agentId: executionTarget.agentId,
      mailboxId: mailbox.id,
    });

    await ensureSystemSendAllowed(env, {
      tenantId: mailbox.tenant_id,
      agentId: executionTarget.agentId,
      to: [operatorEmail],
      createdVia: "system:token_reissue_operator_email",
    });

    const draft = await createDraft(env, {
      tenantId: mailbox.tenant_id,
      agentId: executionTarget.agentId,
      mailboxId: mailbox.id,
      createdVia: "system:token_reissue_operator_email",
      payload: {
        from: mailbox.address,
        to: [operatorEmail],
        subject: `Your refreshed Mailagents access token for ${mailbox.address}`,
        text: buildTokenReissueText({
          mailboxAddress: mailbox.address,
          productName,
          agentName: agent.name,
          accessToken: access.accessToken,
          accessTokenExpiresAt: access.accessTokenExpiresAt,
          accessTokenScopes: access.accessTokenScopes,
        }),
        html: buildTokenReissueHtml({
          mailboxAddress: mailbox.address,
          productName,
          agentName: agent.name,
          accessToken: access.accessToken,
          accessTokenExpiresAt: access.accessTokenExpiresAt,
          accessTokenScopes: access.accessTokenScopes,
        }),
        attachments: [],
      },
    });
    draftId = draft.id;

    await enqueueDraftSend(env, draft.id);
    return true;
  } catch {
    if (draftId) {
      await deleteDraftIfUnqueued(env, draftId).catch(() => undefined);
    }
    return false;
  }
}

function resolveRotateMailboxId(claims: AccessTokenClaims, requestedMailboxId: string | undefined): string | null {
  return requestedMailboxId?.trim()
    || (claims.mailboxIds?.length === 1 ? claims.mailboxIds[0] : null)
    || null;
}

function requireSelfAgent(claims: AccessTokenClaims): string | Response {
  if (!claims.agentId) {
    return badRequest("This token is not bound to a single agent");
  }

  return claims.agentId;
}

async function resolveSelfAgent(env: Env, claims: AccessTokenClaims) {
  const agentId = requireSelfAgent(claims);
  if (agentId instanceof Response) {
    return agentId;
  }

  const agent = await getAgent(env, agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }
  if (agent.tenantId !== claims.tenantId) {
    return json({ error: "Tenant access denied" }, { status: 403 });
  }

  return agent;
}

async function resolveSelfAgentForMailbox(env: Env, claims: AccessTokenClaims, mailboxId: string) {
  const agent = await resolveSelfAgent(env, claims);
  if (agent instanceof Response) {
    return agent;
  }

  const hasBinding = await hasActiveMailboxBinding(env, {
    agentId: agent.id,
    mailboxId,
  });
  if (hasBinding) {
    return agent;
  }

  const hasDeployment = await hasActiveMailboxDeployment(env, {
    agentId: agent.id,
    mailboxId,
  });
  if (!hasDeployment) {
    return json({ error: "Agent is not active for mailbox" }, { status: 403 });
  }

  return agent;
}

async function requireCurrentMailboxAccessForClaims(env: Env, claims: AccessTokenClaims, mailboxId: string): Promise<Response | null> {
  if (!claims.agentId || !claims.mailboxIds?.length) {
    return null;
  }

  const selfAgent = await resolveSelfAgentForMailbox(env, claims, mailboxId);
  return selfAgent instanceof Response ? selfAgent : null;
}

async function requireSelfServiceTenantAccess(
  env: Env,
  claims: AccessTokenClaims,
  tenantId: string,
): Promise<Response | null> {
  const tenantError = enforceTenantAccess(claims, tenantId);
  if (tenantError) {
    return tenantError;
  }

  if (!claims.mailboxIds?.length) {
    if (claims.agentId) {
      return json(
        { error: "Only tenant-scoped or mailbox-scoped tokens can access self-service tenant resources" },
        { status: 403 },
      );
    }
    return null;
  }

  if (!claims.agentId || claims.mailboxIds.length !== 1) {
    return json(
      { error: "Only tenant-scoped or single-mailbox self-serve tokens can access self-service tenant resources" },
      { status: 403 },
    );
  }

  const missingScopes = SELF_SERVE_DEFAULT_SCOPES.filter((scope) => !claims.scopes.includes(scope));
  if (missingScopes.length > 0) {
    return json({
      error: "Mailbox-scoped self-serve access to tenant resources requires the default signup scopes",
      missingScopes,
    }, { status: 403 });
  }

  const mailbox = await resolveSelfMailbox(env, claims);
  if (mailbox instanceof Response) {
    return mailbox;
  }

  return await requireCurrentMailboxAccessForClaims(env, claims, mailbox.id);
}

function requireTenantScopedAccess(claims: AccessTokenClaims): Response | null {
  if (claims.agentId || claims.mailboxIds?.length) {
    return json({ error: "Only tenant-scoped tokens can access tenant-level resources" }, { status: 403 });
  }

  return null;
}

function requireAgentControlPlaneAccess(claims: AccessTokenClaims): Response | null {
  if (claims.mailboxIds?.length) {
    return json({ error: "Mailbox-scoped tokens cannot access agent control-plane resources" }, { status: 403 });
  }

  return null;
}

async function resolveSelfMailbox(env: Env, claims: AccessTokenClaims) {
  const mailboxId = claims.mailboxIds?.length === 1 ? claims.mailboxIds[0] : null;
  if (!mailboxId) {
    return badRequest("This token is not bound to a single mailbox");
  }

  const mailbox = await getMailboxById(env, mailboxId);
  if (!mailbox) {
    return json({ error: "Mailbox not found" }, { status: 404 });
  }
  if (mailbox.tenant_id !== claims.tenantId) {
    return json({ error: "Tenant access denied" }, { status: 403 });
  }

  return mailbox;
}

async function createAndSendDraft(env: Env, input: {
  tenantId: string;
  agentId: string;
  mailboxId: string;
  threadId?: string;
  sourceMessageId?: string;
  payload: {
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    text: string;
    html: string;
    inReplyTo?: string;
    references: string[];
    attachments: Array<{ filename: string; contentType: string; r2Key: string }>;
  };
  createdVia: string;
  idempotencyKey?: string;
  requestFingerprint: string;
}) {
  const idempotencyKey = input.idempotencyKey?.trim();
  if (input.idempotencyKey !== undefined && !idempotencyKey) {
    throw new RouteRequestError("idempotencyKey must be a non-empty string", 400);
  }
  const validateCreateAndSendInput = async () => {
    if (!input.payload.text && !input.payload.html) {
      throw new RouteRequestError("text or html is required", 400);
    }
    await validateDraftFromAddress(env, {
      tenantId: input.tenantId,
      mailboxId: input.mailboxId,
      from: input.payload.from,
    });
    await validateActiveDraftMailbox(env, {
      tenantId: input.tenantId,
      mailboxId: input.mailboxId,
    });
    await validateSendAgentBinding(env, {
      tenantId: input.tenantId,
      agentId: input.agentId,
      mailboxId: input.mailboxId,
    });
    await validateDraftReferences(env, {
      tenantId: input.tenantId,
      mailboxId: input.mailboxId,
      threadId: input.threadId,
      sourceMessageId: input.sourceMessageId,
    });
    await validateDraftAttachments(env, {
      tenantId: input.tenantId,
      mailboxId: input.mailboxId,
      attachments: input.payload.attachments,
    });
    const decision = await evaluateOutboundPolicy(env, {
      tenantId: input.tenantId,
      agentId: input.agentId,
      to: input.payload.to,
      cc: input.payload.cc,
      bcc: input.payload.bcc,
    });
    if (!decision.ok) {
      const status = decision.code === "daily_quota_exceeded" || decision.code === "hourly_quota_exceeded" ? 429 : 403;
      throw new RouteRequestError(decision.message ?? "Outbound policy denied this send request", status);
    }

    const creditCheck = await checkOutboundCreditRequirement(env, {
      tenantId: input.tenantId,
      to: input.payload.to,
      cc: input.payload.cc,
      bcc: input.payload.bcc,
      sourceMessageId: input.sourceMessageId,
      createdVia: input.createdVia,
    });
    if (!creditCheck.hasSufficientCredits) {
      throw createInsufficientCreditsRouteError({
        availableCredits: creditCheck.availableCredits,
        creditsRequired: creditCheck.creditsRequired,
      });
    }
  };

  if (!idempotencyKey) {
    let sideEffectCommitted = false;
    try {
      await validateCreateAndSendInput();
      const draft = await createDraft(env, {
        tenantId: input.tenantId,
        agentId: input.agentId,
        mailboxId: input.mailboxId,
        threadId: input.threadId,
        sourceMessageId: input.sourceMessageId,
        createdVia: input.createdVia,
        payload: input.payload,
      });
      sideEffectCommitted = true;
      const sendResult = await enqueueDraftSend(env, draft.id);
      return buildQueuedCreateAndSendAcceptedResponse({
        draft,
        outboundJobId: sendResult.outboundJobId,
        status: sendResult.status,
      });
    } catch (error) {
      throw sideEffectCommitted ? markSideEffectCommitted(error) : error;
    }
  }

  const reservation = await reserveIdempotencyKey(env, {
    operation: "draft_send",
    tenantId: input.tenantId,
    idempotencyKey,
    requestFingerprint: input.requestFingerprint,
  });

  if (reservation.status === "conflict") {
    throw new RouteRequestError("Idempotency key is already used for a different send request", 409);
  }
  if (reservation.status === "pending") {
    if (reservation.record.resourceId) {
      await validateCreateAndSendInput();
      const response = await restoreDraftSendReplay(env, reservation.record.resourceId);
      await bestEffortCompleteRecoveredIdempotency(env, {
        operation: "draft_send",
        tenantId: input.tenantId,
        idempotencyKey,
        resourceId: response.draft.id,
        response,
      });
      return response;
    }
    throw new RouteRequestError("A send request with this idempotency key is already in progress", 409);
  }
  if (reservation.status === "completed") {
    await validateCreateAndSendInput();
    if (reservation.record.response) {
      return reservation.record.response;
    }

    return await restoreDraftSendReplay(env, reservation.record.resourceId);
  }

  let sideEffectCommitted = false;
  try {
    await validateCreateAndSendInput();
    const draft = await createDraft(env, {
      tenantId: input.tenantId,
      agentId: input.agentId,
      mailboxId: input.mailboxId,
      threadId: input.threadId,
      sourceMessageId: input.sourceMessageId,
      createdVia: input.createdVia,
      payload: input.payload,
    });
    sideEffectCommitted = true;
    await updateIdempotencyKeyResource(env, {
      operation: "draft_send",
      tenantId: input.tenantId,
      idempotencyKey,
      resourceId: draft.id,
    });
      const sendResult = await enqueueDraftSend(env, draft.id);
    const response = buildQueuedCreateAndSendAcceptedResponse({
      draft,
      outboundJobId: sendResult.outboundJobId,
      status: sendResult.status,
    });
    await completeIdempotencyKey(env, {
      operation: "draft_send",
      tenantId: input.tenantId,
      idempotencyKey,
      resourceId: draft.id,
      response,
    });
    return response;
  } catch (error) {
    if (!sideEffectCommitted) {
      await releaseIdempotencyKey(env, "draft_send", input.tenantId, idempotencyKey);
    }
    throw sideEffectCommitted ? markSideEffectCommitted(error) : error;
  }
}

async function rotateAccessToken(env: Env, claims: AccessTokenClaims): Promise<{
  accessToken?: string;
  accessTokenExpiresAt?: string;
  accessTokenScopes: string[];
}> {
  if (!env.API_SIGNING_SECRET) {
    return { accessTokenScopes: claims.scopes };
  }

  const rotatedClaims = await validateRotatedAccessClaims(env, claims);
  const ttlSeconds = parseRotateTtlSeconds(env);
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const accessToken = await mintAccessToken(env.API_SIGNING_SECRET, {
    sub: claims.sub,
    tenantId: rotatedClaims.tenantId,
    agentId: rotatedClaims.agentId,
    scopes: claims.scopes,
    mailboxIds: rotatedClaims.mailboxIds,
    exp,
  });

  return {
    accessToken,
    accessTokenExpiresAt: new Date(exp * 1000).toISOString(),
    accessTokenScopes: claims.scopes,
  };
}

async function validateRotatedAccessClaims(env: Env, claims: AccessTokenClaims): Promise<Pick<AccessTokenClaims, "tenantId" | "agentId" | "mailboxIds">> {
  if (claims.agentId) {
    const agent = await getAgent(env, claims.agentId);
    if (!agent) {
      throw new RouteRequestError("Bound agent not found", 409);
    }
    if (agent.tenantId !== claims.tenantId) {
      throw new RouteRequestError("Bound agent does not belong to tenant", 409);
    }
  }

  if (claims.mailboxIds?.length) {
    for (const mailboxId of claims.mailboxIds) {
      const mailbox = await getMailboxById(env, mailboxId);
      if (!mailbox) {
        throw new RouteRequestError("Bound mailbox not found", 409);
      }
      if (mailbox.tenant_id !== claims.tenantId) {
        throw new RouteRequestError("Bound mailbox does not belong to tenant", 409);
      }
      if (mailbox.status !== "active") {
        throw new RouteRequestError("Bound mailbox is not active", 409);
      }
    }
  }
  await validateTokenAgentMailboxScopes(env, {
    tenantId: claims.tenantId,
    agentId: claims.agentId,
    mailboxIds: claims.mailboxIds,
    scopes: claims.scopes,
  });

  return {
    tenantId: claims.tenantId,
    agentId: claims.agentId,
    mailboxIds: claims.mailboxIds,
  };
}

function parseRotateTtlSeconds(env: Env): number {
  const value = env.SELF_SERVE_ACCESS_TOKEN_TTL_SECONDS;
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60 * 60 * 24 * 30;
}

async function deliverRotatedTokenToSelfMailbox(
  env: Env,
  claims: AccessTokenClaims,
  mailboxId: string,
  accessToken: string,
  accessTokenExpiresAt: string | undefined,
  accessTokenScopes: string[],
): Promise<boolean> {
  const mailbox = await getMailboxById(env, mailboxId);
  if (!mailbox || mailbox.status !== "active") {
    return false;
  }

  const executionTarget = claims.agentId && await canAgentSendForMailbox(env, {
    agentId: claims.agentId,
    mailboxId,
  })
    ? { agentId: claims.agentId }
    : await resolveAgentExecutionTarget(env, mailboxId, undefined, [...SEND_CAPABLE_MAILBOX_ROLES]);
  if (!executionTarget?.agentId) {
    return false;
  }

  const agent = await getAgent(env, executionTarget.agentId);
  const config = agent?.configR2Key ? await readAgentConfig(env, agent.configR2Key) : null;
  const productName = typeof config?.productName === "string" && config.productName.trim()
    ? config.productName.trim()
    : "Mailagents";
  const agentName = agent?.name ?? "Mailagents Agent";
  let draftId: string | undefined;

  try {
    await ensureSystemSendAllowed(env, {
      tenantId: mailbox.tenant_id,
      agentId: executionTarget.agentId,
      to: [mailbox.address],
      createdVia: "system:token_reissue_self_mailbox",
    });

    const draft = await createDraft(env, {
      tenantId: mailbox.tenant_id,
      agentId: executionTarget.agentId,
      mailboxId: mailbox.id,
      createdVia: "system:token_reissue_self_mailbox",
      payload: {
        from: mailbox.address,
        to: [mailbox.address],
        subject: `Your rotated Mailagents access token for ${mailbox.address}`,
        text: buildTokenReissueText({
          mailboxAddress: mailbox.address,
          productName,
          agentName,
          accessToken,
          accessTokenExpiresAt,
          accessTokenScopes,
        }),
        html: buildTokenReissueHtml({
          mailboxAddress: mailbox.address,
          productName,
          agentName,
          accessToken,
          accessTokenExpiresAt,
          accessTokenScopes,
        }),
        attachments: [],
      },
    });
    draftId = draft.id;

    await enqueueDraftSend(env, draft.id);
    return true;
  } catch {
    if (draftId) {
      await deleteDraftIfUnqueued(env, draftId).catch(() => undefined);
    }
    return false;
  }
}

async function resolveReplayAgentTarget(
  env: Env,
  claims: AccessTokenClaims,
  mailboxId: string,
  requestedAgentId: string | undefined,
): Promise<
  | { agentId: string; agentVersionId?: string; deploymentId?: string }
  | Response
> {
  const agentId = requestedAgentId?.trim();
  if (agentId) {
    const agentError = enforceScopedAgentAccess(claims, agentId);
    if (agentError) {
      return agentError;
    }
    const agent = await getAgent(env, agentId);
    if (!agent) {
      return json({ error: "Agent not found" }, { status: 404 });
    }
    const tenantError = enforceTenantAccess(claims, agent.tenantId);
    if (tenantError) {
      return tenantError;
    }

    const target = await resolveAgentExecutionTarget(env, mailboxId, agentId, [...RECEIVE_CAPABLE_MAILBOX_ROLES]);
    if (!target?.agentId) {
      return badRequest("agentId must be active for the mailbox");
    }

    return target;
  }

  const target = await resolveAgentExecutionTarget(env, mailboxId, undefined, [...RECEIVE_CAPABLE_MAILBOX_ROLES]);
  if (!target?.agentId) {
    return badRequest("agentId is required when the mailbox has no active agent deployment");
  }

  const agentError = enforceScopedAgentAccess(claims, target.agentId);
  if (agentError) {
    return agentError;
  }
  const agent = await getAgent(env, target.agentId);
  if (!agent) {
    return json({ error: "Agent not found" }, { status: 404 });
  }
  const tenantError = enforceTenantAccess(claims, agent.tenantId);
  if (tenantError) {
    return tenantError;
  }

  return target;
}

async function readAgentConfig(env: Env, configR2Key: string): Promise<Record<string, unknown> | null> {
  const object = await env.R2_EMAIL.get(configR2Key);
  if (!object) {
    return null;
  }

  const payload = await object.json<unknown>();
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
}


function methodNotAllowed(allowed: string[]): Response {
  return json(
    { error: `method not allowed; use ${allowed.join(", ")}` },
    { status: 405, headers: { allow: allowed.join(", ") } }
  );
}

function parseListLimit(raw: string | null, fallback: number, max: number): number {
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function parseTopupCredits(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }
  if (value < 1 || value > 100000) {
    return null;
  }
  return value;
}

function x402PaymentRequiredResponse(input: {
  tenantId: string;
  tenantDid?: string;
  quote: ReturnType<typeof buildX402TopupQuote> | ReturnType<typeof buildX402UpgradeQuote>;
}): Response {
  const headers = new Headers();
  headers.set(X402_PAYMENT_REQUIRED_HEADER, encodePaymentRequiredHeader(input.quote.paymentRequired));

  return json({
    error: "Payment required",
    protocol: "x402",
    tenantId: input.tenantId,
    tenantDid: input.tenantDid,
    quote: input.quote,
  }, {
    status: 402,
    headers,
  });
}

function x402UnavailableResponse(): Response {
  return json({
    error: "x402 billing is not configured for this environment",
    protocol: "x402",
  }, { status: 503 });
}

async function confirmPaymentReceiptWithFacilitator(
  env: Env,
  receipt: TypedPaymentReceiptRecord | null,
  requestedSettlementReference?: string,
): Promise<{
  receipt: TypedPaymentReceiptRecord;
  paymentReference?: string;
  settlementReference?: string;
  verifyResponse?: X402FacilitatorVerificationResponse;
  settleResponse?: X402FacilitatorSettlementResponse;
  failureResponse?: Response;
} | null> {
  if (!receipt) {
    return null;
  }

  const parsedMetadata = receipt.metadata;
  const paymentRequirements = getReceiptPaymentRequirements(parsedMetadata);
  const paymentPayload = getReceiptPaymentPayload(parsedMetadata);
  if (!paymentRequirements || !paymentPayload) {
    return {
      receipt,
      failureResponse: json({
        error: "Payment receipt is missing x402 payment proof or requirements",
      }, { status: 409 }),
    };
  }

  let workingReceipt = receipt;
  let verifyResponse: X402FacilitatorVerificationResponse | undefined;

  if (workingReceipt.status === "failed") {
    return {
      receipt: workingReceipt,
      failureResponse: json({
        error: "Failed payment receipts cannot be settled",
      }, { status: 409 }),
    };
  }

  if (workingReceipt.status === "pending") {
    const verifyResult = await verifyX402Payment(env, {
      paymentPayload,
      paymentRequirements,
      idempotencyKey: workingReceipt.id,
    });
    verifyResponse = verifyResult.response;
    if (!verifyResult.ok) {
      const failedReceipt = await updateTypedTenantPaymentReceiptStatus(env, {
        tenantId: workingReceipt.tenantId,
        receiptId: workingReceipt.id,
        status: "failed",
        paymentReference: verifyResult.paymentReference,
        metadata: parsedMetadata
          ? withReceiptConfirmation(parsedMetadata, {
            confirmationMode: "facilitator",
            facilitatorVerify: verifyResult.response,
            facilitatorStatusCode: verifyResult.status,
          })
          : receipt.metadata,
      });
      return {
        receipt: failedReceipt,
        paymentReference: verifyResult.paymentReference,
        verifyResponse,
        failureResponse: x402PaymentFailureResponse(
          "Payment verification failed",
          verifyResult.response,
          402,
        ),
      };
    }

    workingReceipt = await updateTypedTenantPaymentReceiptStatus(env, {
      tenantId: workingReceipt.tenantId,
      receiptId: workingReceipt.id,
      status: "verified",
      paymentReference: verifyResult.paymentReference,
      metadata: parsedMetadata
        ? withReceiptConfirmation(parsedMetadata, {
          confirmationMode: "facilitator",
          facilitatorVerify: verifyResult.response,
          facilitatorStatusCode: verifyResult.status,
        })
        : workingReceipt.metadata,
    });
  } else {
    verifyResponse = parseStoredX402VerificationResponse(parsedMetadata?.facilitatorVerify);
    const storedSettleResponse = parseStoredX402SettlementResponse(parsedMetadata?.facilitatorSettle);
    if (storedSettleResponse?.settled) {
      return {
        receipt: workingReceipt,
        paymentReference: workingReceipt.paymentReference,
        settlementReference: storedSettleResponse.settlementReference ?? workingReceipt.settlementReference ?? requestedSettlementReference,
        verifyResponse,
        settleResponse: storedSettleResponse,
      };
    }
  }

  const settleResult = await settleX402Payment(env, {
    paymentPayload,
    paymentRequirements,
    idempotencyKey: workingReceipt.id,
  });
  if (!settleResult.ok) {
    const verifiedReceipt = await updateTypedTenantPaymentReceiptStatus(env, {
      tenantId: workingReceipt.tenantId,
      receiptId: workingReceipt.id,
      status: "verified",
      paymentReference: workingReceipt.paymentReference,
      settlementReference: settleResult.settlementReference ?? requestedSettlementReference,
      metadata: parsedMetadata
        ? withReceiptConfirmation(parsedMetadata, {
          confirmationMode: "facilitator",
          facilitatorVerify: verifyResponse,
          facilitatorSettle: settleResult.response,
          facilitatorStatusCode: settleResult.status,
        })
        : workingReceipt.metadata,
    });
    return {
      receipt: verifiedReceipt,
      paymentReference: verifiedReceipt.paymentReference,
      settlementReference: settleResult.settlementReference ?? requestedSettlementReference,
      verifyResponse,
      settleResponse: settleResult.response,
      failureResponse: x402PaymentFailureResponse(
        "Payment settlement failed",
        settleResult.response,
        402,
      ),
    };
  }

  return {
    receipt: await updateTypedTenantPaymentReceiptStatus(env, {
      tenantId: workingReceipt.tenantId,
      receiptId: workingReceipt.id,
      status: "verified",
      paymentReference: workingReceipt.paymentReference,
      settlementReference: settleResult.settlementReference ?? requestedSettlementReference,
      metadata: parsedMetadata
        ? withReceiptConfirmation(parsedMetadata, {
          confirmationMode: "facilitator",
          facilitatorVerify: verifyResponse,
          facilitatorSettle: settleResult.response,
          facilitatorStatusCode: settleResult.status,
        })
        : workingReceipt.metadata,
    }),
    paymentReference: workingReceipt.paymentReference,
    settlementReference: settleResult.settlementReference ?? requestedSettlementReference,
    verifyResponse,
    settleResponse: settleResult.response,
  };
}

async function attemptAutomaticPaymentSettlement(
  env: Env,
  receipt: TypedPaymentReceiptRecord,
): Promise<Response | null> {
  const facilitatorOutcome = await confirmPaymentReceiptWithFacilitator(env, receipt);
  if (facilitatorOutcome?.failureResponse) {
    return facilitatorOutcome.failureResponse;
  }

  return json(await finalizePaymentReceiptSettlement(env, receipt, facilitatorOutcome));
}

async function withRefreshedPaymentReceipt<T>(
  env: Env,
  receipt: TypedPaymentReceiptRecord,
  action: (receipt: TypedPaymentReceiptRecord) => Promise<T>,
): Promise<T> {
  const initialLedgerEntry = await getTypedCreditLedgerEntryByPaymentReceiptId(
    env,
    receipt.tenantId,
    receipt.id,
  ).catch(() => null);

  try {
    return await action(receipt);
  } catch (error) {
    const [refreshed, refreshedLedgerEntry] = await Promise.all([
      getTypedTenantPaymentReceiptById(env, receipt.tenantId, receipt.id).catch(() => null),
      getTypedCreditLedgerEntryByPaymentReceiptId(env, receipt.tenantId, receipt.id).catch(() => null),
    ]);
    const receiptChanged = Boolean(
      refreshed
      && (
        refreshed.updatedAt !== receipt.updatedAt
        || refreshed.status !== receipt.status
        || refreshed.paymentReference !== receipt.paymentReference
        || refreshed.settlementReference !== receipt.settlementReference
      )
    );
    const ledgerChanged = !initialLedgerEntry && Boolean(refreshedLedgerEntry);

    if ((!receiptChanged && !ledgerChanged) || !refreshed) {
      throw error;
    }

    return await action(refreshed);
  }
}

async function finalizePaymentReceiptSettlement(
  env: Env,
  receipt: TypedPaymentReceiptRecord,
  facilitatorOutcome: Awaited<ReturnType<typeof confirmPaymentReceiptWithFacilitator>>,
  requestedSettlementReference?: string,
): Promise<Record<string, unknown>> {
  const finalizedReceipt = facilitatorOutcome?.receipt ?? receipt;
  const parsedMetadata = finalizedReceipt.metadata;
  const existingLedgerEntry = await getTypedCreditLedgerEntryByPaymentReceiptId(
    env,
    finalizedReceipt.tenantId,
    finalizedReceipt.id,
  );

  if (finalizedReceipt.status === "settled" && !existingLedgerEntry) {
    throw new RouteRequestError(
      "Payment receipt is already settled but local settlement records are incomplete; manual reconciliation is required",
      409,
    );
  }

  if (finalizedReceipt.receiptType === "upgrade") {
    if (!parsedMetadata || parsedMetadata.receiptType !== "upgrade") {
      throw new RouteRequestError("Payment receipt metadata is missing targetPricingTier", 409);
    }
    if (parsedMetadata.includedCredits <= 0) {
      throw new RouteRequestError(
        "Payment receipt metadata is missing includedCredits for upgrade settlement",
        409,
      );
    }
    const includedCredits = parsedMetadata.includedCredits;
    const normalizedUpgradeMetadata = {
      ...parsedMetadata,
      includedCredits,
      quote: {
        ...parsedMetadata.quote,
        includedCredits,
      },
    };
    const targetPricingTier = parsedMetadata.targetPricingTier;
    const approvedPricingTier = targetPricingTier === "paid_review" ? "paid_active" : targetPricingTier;

    if (existingLedgerEntry && !isUpgradeCreditGrantLedgerEntry(existingLedgerEntry)) {
      throw new RouteRequestError(
        "Payment receipt is linked to a non-upgrade ledger entry; manual reconciliation is required",
        409,
      );
    }

    if (finalizedReceipt.status === "settled" && existingLedgerEntry) {
      const account = await reconcileTenantAvailableCredits(env, finalizedReceipt.tenantId);
      const sendPolicy = await ensureTenantSendPolicy(env, finalizedReceipt.tenantId);
      return {
        receiptId: finalizedReceipt.id,
        receipt: finalizedReceipt,
        ledgerEntry: existingLedgerEntry,
        includedCredits,
        account: buildBillingAccountResponse(account),
        sendPolicy,
        verificationStatus: "settled",
        message: "Payment receipt was already settled.",
      };
    }

    const ledgerEntry = includedCredits > 0
      ? existingLedgerEntry ?? await appendUpgradeCreditGrantLedgerEntry(env, {
        tenantId: finalizedReceipt.tenantId,
        creditsDelta: includedCredits,
        reason: facilitatorOutcome ? "facilitator_upgrade_credit_grant" : "manual_upgrade_credit_grant",
        paymentReceiptId: finalizedReceipt.id,
        referenceId: requestedSettlementReference ?? finalizedReceipt.settlementReference,
        metadata: buildUpgradeCreditGrantLedgerMetadata({
          receiptMetadata: normalizedUpgradeMetadata,
          confirmationMode: facilitatorOutcome ? "facilitator" : "manual_admin",
          facilitatorVerify: facilitatorOutcome?.verifyResponse,
          facilitatorSettle: facilitatorOutcome?.settleResponse,
        }),
      })
      : undefined;

    const existingAccount = await ensureTenantBillingAccount(env, finalizedReceipt.tenantId);
    let account = await updateTenantBillingAccountProfile(env, {
      tenantId: finalizedReceipt.tenantId,
      status: existingAccount.status === "trial" ? "active" : undefined,
      pricingTier: approvedPricingTier,
      defaultNetwork: finalizedReceipt.network ?? undefined,
      defaultAsset: finalizedReceipt.asset ?? undefined,
    });

    const existingSendPolicy = await ensureTenantSendPolicy(env, finalizedReceipt.tenantId);
    const sendPolicy = await upsertTenantSendPolicy(env, {
      tenantId: finalizedReceipt.tenantId,
      pricingTier: approvedPricingTier,
      outboundStatus: "external_enabled",
      internalDomainAllowlist: existingSendPolicy.internalDomainAllowlist,
      externalSendEnabled: true,
      reviewRequired: false,
    });
    await relaxTenantDefaultAgentRecipientPoliciesForExternalSend(env, {
      tenantId: finalizedReceipt.tenantId,
      internalDomainAllowlist: sendPolicy.internalDomainAllowlist,
    });

    if (ledgerEntry) {
      account = await reconcileTenantAvailableCredits(env, finalizedReceipt.tenantId);
    }

    const metadataNeedsRefresh = finalizedReceipt.status !== "settled"
      || parsedMetadata.includedCredits !== includedCredits
      || parsedMetadata.creditLedgerEntryId !== ledgerEntry?.id
      || parsedMetadata.sendPolicyStatus !== sendPolicy.outboundStatus;

    const settledReceipt = metadataNeedsRefresh
      ? await updateTypedTenantPaymentReceiptStatus(env, {
        tenantId: finalizedReceipt.tenantId,
        receiptId: finalizedReceipt.id,
        status: "settled",
        paymentReference: facilitatorOutcome?.paymentReference,
        settlementReference: requestedSettlementReference,
        metadata: withReceiptConfirmation(normalizedUpgradeMetadata, {
          confirmationMode: facilitatorOutcome ? "facilitator" : "manual_admin",
          creditLedgerEntryId: ledgerEntry?.id,
          sendPolicyStatus: sendPolicy.outboundStatus,
          facilitatorVerify: facilitatorOutcome?.verifyResponse,
          facilitatorSettle: facilitatorOutcome?.settleResponse,
        }),
      })
      : finalizedReceipt;

    return {
      receiptId: settledReceipt.id,
      receipt: settledReceipt,
      ledgerEntry,
      includedCredits,
      account: buildBillingAccountResponse(account),
      sendPolicy,
      verificationStatus: "settled",
      message: `Upgrade payment settled, external sending approved automatically, and ${includedCredits} credits granted.`,
    };
  }

  if (existingLedgerEntry) {
    if (!isTopupSettlementLedgerEntry(existingLedgerEntry)) {
      throw new RouteRequestError(
        "Payment receipt is linked to a non-topup ledger entry; manual reconciliation is required",
        409,
      );
    }
    const account = await reconcileTenantAvailableCredits(env, finalizedReceipt.tenantId);
    const settledReceipt = finalizedReceipt.status === "settled"
      ? finalizedReceipt
      : await updateTypedTenantPaymentReceiptStatus(env, {
        tenantId: finalizedReceipt.tenantId,
        receiptId: finalizedReceipt.id,
        status: "settled",
        paymentReference: facilitatorOutcome?.paymentReference,
        settlementReference: requestedSettlementReference,
        metadata: parsedMetadata
          ? withReceiptConfirmation(parsedMetadata, {
            confirmationMode: facilitatorOutcome ? "facilitator" : "manual_admin",
            creditLedgerEntryId: existingLedgerEntry.id,
            facilitatorVerify: facilitatorOutcome?.verifyResponse,
            facilitatorSettle: facilitatorOutcome?.settleResponse,
          })
          : finalizedReceipt.metadata,
      });
    return {
      receiptId: settledReceipt.id,
      receipt: settledReceipt,
      ledgerEntry: existingLedgerEntry,
      account: buildBillingAccountResponse(account),
      verificationStatus: "settled",
      message: "Payment receipt was already settled.",
    };
  }

  if (!parsedMetadata || parsedMetadata.receiptType !== "topup") {
    throw new RouteRequestError("Payment receipt metadata is missing creditsRequested", 409);
  }
  const creditsRequested = parsedMetadata.creditsRequested;

  const ledgerEntry = await appendTopupSettlementLedgerEntry(env, {
    tenantId: finalizedReceipt.tenantId,
    creditsDelta: creditsRequested,
    reason: facilitatorOutcome ? "facilitator_payment_settlement" : "manual_payment_confirmation",
    paymentReceiptId: finalizedReceipt.id,
    referenceId: requestedSettlementReference ?? finalizedReceipt.settlementReference,
    metadata: buildTopupSettlementLedgerMetadata({
      receiptMetadata: parsedMetadata,
      confirmationMode: facilitatorOutcome ? "facilitator" : "manual_admin",
      facilitatorVerify: facilitatorOutcome?.verifyResponse,
      facilitatorSettle: facilitatorOutcome?.settleResponse,
    }),
  });

  const account = await reconcileTenantAvailableCredits(env, finalizedReceipt.tenantId);
  const settledReceipt = await updateTypedTenantPaymentReceiptStatus(env, {
    tenantId: finalizedReceipt.tenantId,
    receiptId: finalizedReceipt.id,
    status: "settled",
    paymentReference: facilitatorOutcome?.paymentReference,
    settlementReference: requestedSettlementReference,
    metadata: withReceiptConfirmation(parsedMetadata, {
      confirmationMode: facilitatorOutcome ? "facilitator" : "manual_admin",
      creditLedgerEntryId: ledgerEntry.id,
      facilitatorVerify: facilitatorOutcome?.verifyResponse,
      facilitatorSettle: facilitatorOutcome?.settleResponse,
    }),
  });

  return {
    receiptId: settledReceipt.id,
    receipt: settledReceipt,
    ledgerEntry,
    account: buildBillingAccountResponse(account),
    verificationStatus: "settled",
    message: "Payment receipt settled and credits applied.",
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function x402PaymentFailureResponse(
  message: string,
  settlement: X402FacilitatorVerificationResponse | X402FacilitatorSettlementResponse | undefined,
  status = 402,
): Response {
  const headers = new Headers();
  if (settlement) {
    headers.set(X402_PAYMENT_RESPONSE_HEADER, encodePaymentResponseHeader(settlement));
  }

  const body: Record<string, unknown> = {
    error: message,
    protocol: "x402",
    verificationStatus: "failed",
    settlement,
  };

  if (settlement?.type === "settle" && settlement.settled === false && settlement.error === "invalid_exact_evm_transaction_failed") {
    body.note = "settlementReference identifies the facilitator's own settle attempt. It can differ from a transaction you broadcast yourself before submitting the same authorization to Mailagents.";
    body.suggestedAction = "If you already broadcast transferWithAuthorization yourself, request a fresh quote, sign a fresh proof with a new authorization nonce, and submit it directly to POST /v1/billing/topup without pre-broadcasting the same authorization.";
    body.docUrl = "/limits";
  } else if (settlement?.type === "verify" && settlement.isValid === false && settlement.error === "invalid_exact_evm_nonce_already_used") {
    body.note = "The EIP-3009 authorization nonce in this proof has already been consumed on-chain, so the facilitator cannot reuse it for Mailagents settlement.";
    body.suggestedAction = "Request a fresh quote, sign a fresh proof with a new authorization nonce, and submit it directly to POST /v1/billing/topup without first broadcasting transferWithAuthorization yourself.";
    body.docUrl = "/limits";
  }

  return json(body, {
    status,
    headers,
  });
}

function publicSelfServeCorsHeaders(): Headers {
  return new Headers({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": PUBLIC_SELF_SERVE_ALLOW_METHODS,
    "access-control-allow-headers": PUBLIC_SELF_SERVE_ALLOW_HEADERS,
    "access-control-max-age": "86400",
  });
}

function withPublicSelfServeCors(response: Response): Response {
  const headers = publicSelfServeCorsHeaders();
  for (const [key, value] of response.headers.entries()) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function publicSelfServePreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: publicSelfServeCorsHeaders(),
  });
}

function authenticatedApiAllowHeadersForPath(pathname: string): string {
  return pathname.startsWith("/v2/meta/")
    ? AUTHENTICATED_API_METADATA_ALLOW_HEADERS
    : AUTHENTICATED_API_DEFAULT_ALLOW_HEADERS;
}

function authenticatedApiAllowMethodsForRequest(request: Request): string[] {
  const pathname = new URL(request.url).pathname;
  const allowedMethods = router.allowedMethodsForPath(pathname).filter((method) => method !== "OPTIONS");
  if (allowedMethods.length === 0) {
    return [];
  }

  return [...allowedMethods, "OPTIONS"];
}

function authenticatedApiCorsHeaders(request: Request): Headers | null {
  const pathname = new URL(request.url).pathname;
  const allowedMethods = authenticatedApiAllowMethodsForRequest(request);
  if (allowedMethods.length === 0) {
    return null;
  }

  return new Headers({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": allowedMethods.join(", "),
    "access-control-allow-headers": authenticatedApiAllowHeadersForPath(pathname),
    "access-control-max-age": "86400",
  });
}

function withAuthenticatedApiCors(request: Request, response: Response): Response {
  const headers = authenticatedApiCorsHeaders(request) ?? new Headers();
  for (const [key, value] of response.headers.entries()) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function authenticatedApiPreflight(request: Request): Response | null {
  const headers = authenticatedApiCorsHeaders(request);
  if (!headers) {
    return null;
  }

  return new Response(null, {
    status: 204,
    headers,
  });
}

function isPublicSelfServeRequest(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return pathname === "/public/signup" || pathname === "/public/token/reissue";
}

function isAuthenticatedApiCorsRequest(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  if (pathname.startsWith("/v1/webhooks/")) {
    return false;
  }

  return pathname.startsWith("/v1/") || pathname.startsWith("/v2/");
}
