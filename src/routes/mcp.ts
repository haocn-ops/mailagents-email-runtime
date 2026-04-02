import {
  enforceMailboxAccess,
  enforceScopedAgentAccess,
  enforceTenantAccess,
  requireAuth,
} from "../lib/auth";
import { badRequest } from "../lib/http";
import { createId } from "../lib/ids";
import {
  type JsonRpcRequest,
  jsonRpcError,
  jsonRpcResult,
  handleMcpTransportGet,
  handleMcpTransportOptions,
  handleMcpTransportPost,
  toToolContent,
} from "../lib/mcp-transport";
import { checkOutboundCreditRequirement } from "../lib/outbound-credits";
import { evaluateOutboundPolicy } from "../lib/outbound-policy";
import {
  buildRuntimeMetadata,
  MCP_PROTOCOL_VERSION,
  RUNTIME_SERVER_INFO,
  RUNTIME_TOOL_CATALOG,
} from "../lib/runtime-metadata";
import { Router } from "../lib/router";
import {
  bindMailbox,
  createAgent,
  getAgent,
  hasActiveMailboxBinding,
  hasActiveMailboxDeployment,
  getMailboxById,
  MailboxConflictError,
  resolveAgentExecutionTarget,
  upsertAgentPolicy,
} from "../repositories/agents";
import {
  completeIdempotencyKey,
  createDraft,
  createTask,
  deleteTask,
  enqueueDraftSend,
  getAttachmentOwnerByR2Key,
  getDraft,
  getDraftByR2KeyForOutboundLifecycle,
  getMessage,
  getMessageContent,
  getOutboundJob,
  getOutboundJobByMessageId,
  getOutboundJobByDraftR2Key,
  getThread,
  listMessages,
  listTasks,
  markDraftStatus,
  releaseIdempotencyKey,
  reserveIdempotencyKey,
  updateIdempotencyKeyResource,
} from "../repositories/mail";
import type { AccessTokenClaims, Env, TaskStatus } from "../types";

const RECEIVE_CAPABLE_MAILBOX_ROLES = ["primary", "shared", "receive_only"] as const;
const SEND_CAPABLE_MAILBOX_ROLES = ["primary", "shared", "send_only"] as const;
const MCP_ALLOW_METHODS = "GET, POST, OPTIONS";
const MCP_ALLOW_HEADERS = "accept, authorization, content-type, mcp-protocol-version, mcp-session-id";
const MAILBOX_SCOPED_HIDDEN_TOOLS = new Set(["create_agent", "bind_mailbox", "upsert_agent_policy"]);
const AGENT_BOUND_HIDDEN_TOOLS = new Set([
  "bind_mailbox",
  "upsert_agent_policy",
  "reply_to_inbound_email",
  "operator_manual_send",
  "list_agent_tasks",
  "create_draft",
  "get_draft",
  "send_draft",
  "cancel_draft",
  "send_email",
  "reply_to_message",
]);

interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiredScopes: string[];
}

class McpToolError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
  }
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

interface CreatedAndSentDraftResult {
  draft: Awaited<ReturnType<typeof createDraft>>;
  outboundJobId: string;
  status: "queued";
  acceptedForDelivery?: true;
  deliveryState?: "queued";
  finalDeliveryState?: "pending";
  statusCheck?: {
    outboundJobPath: string;
    draftPath: string;
  };
  message?: string;
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
    throw new McpToolError("internal_error", "Stored idempotent draft send result is incomplete");
  }

  let draft = await getDraft(env, draftId);
  if (!draft) {
    throw new McpToolError("conflict", "Stored idempotent draft no longer exists");
  }

  let outboundJob = await getOutboundJobByDraftR2Key(env, draft.draftR2Key);
  if (!outboundJob) {
    if (draft.status !== "draft" && draft.status !== "approved") {
      throw new McpToolError("conflict", "Stored idempotent outbound job no longer exists");
    }

    const resumed = await enqueueDraftSend(env, draft.id);
    const resumedDraft = await getDraft(env, draft.id);
    if (!resumedDraft) {
      throw new McpToolError("conflict", "Stored idempotent draft disappeared during replay recovery");
    }
    const resumedOutboundJob = await getOutboundJob(env, resumed.outboundJobId);
    if (!resumedOutboundJob) {
      throw new McpToolError("conflict", "Stored idempotent outbound job disappeared during replay recovery");
    }
    draft = resumedDraft;
    outboundJob = resumedOutboundJob;
  }
  if (!(await getMessage(env, outboundJob.messageId))) {
    throw new McpToolError("conflict", "Stored idempotent outbound message no longer exists");
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
    throw new McpToolError("internal_error", "Stored idempotent draft send result is incomplete");
  }

  const draft = await getDraft(env, input.draftId);
  if (!draft) {
    throw new McpToolError("conflict", "Stored idempotent draft no longer exists");
  }

  const outboundJob = await getOutboundJob(env, input.outboundJobId);
  if (!outboundJob) {
    throw new McpToolError("conflict", "Stored idempotent outbound job no longer exists");
  }
  if (!(await getMessage(env, outboundJob.messageId))) {
    throw new McpToolError("conflict", "Stored idempotent outbound message no longer exists");
  }
  if (outboundJob.draftR2Key !== draft.draftR2Key) {
    throw new McpToolError("conflict", "Stored idempotent outbound job does not belong to draft");
  }

  return {
    draftId: input.draftId,
    outboundJobId: outboundJob.id,
    status: "queued" as const,
  };
}

async function restoreOperatorManualSendReplay(env: Env, draftId: string | undefined) {
  const replay = await restoreDraftSendReplay(env, draftId);
  return {
    draft: replay.draft,
    sendRequested: true as const,
    sendResult: {
      draftId: replay.draft.id,
      outboundJobId: replay.outboundJobId,
      status: replay.status,
    },
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
      throw new McpToolError("resource_thread_not_found", "Thread not found");
    }
    if (thread.tenantId !== input.tenantId) {
      throw new McpToolError("invalid_arguments", "Thread does not belong to tenant");
    }
    if (thread.mailboxId !== input.mailboxId) {
      throw new McpToolError("invalid_arguments", "Thread does not belong to mailbox");
    }
  }

  if (input.sourceMessageId) {
    const sourceMessage = await getMessage(env, input.sourceMessageId);
    if (!sourceMessage) {
      throw new McpToolError("resource_message_not_found", "Source message not found");
    }
    if (sourceMessage.tenantId !== input.tenantId) {
      throw new McpToolError("invalid_arguments", "Source message does not belong to tenant");
    }
    if (sourceMessage.mailboxId !== input.mailboxId) {
      throw new McpToolError("invalid_arguments", "Source message does not belong to mailbox");
    }
    if (input.threadId && sourceMessage.threadId !== input.threadId) {
      throw new McpToolError("invalid_arguments", "Source message does not belong to thread");
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
      throw new McpToolError("invalid_arguments", "Attachment r2Key is required");
    }

    const owner = await getAttachmentOwnerByR2Key(env, r2Key);
    if (!owner) {
      throw new McpToolError("invalid_arguments", "Attachment not found");
    }
    if (owner.tenantId !== input.tenantId) {
      throw new McpToolError("invalid_arguments", "Attachment does not belong to tenant");
    }
    if (owner.mailboxId !== input.mailboxId) {
      throw new McpToolError("invalid_arguments", "Attachment does not belong to mailbox");
    }
  }
}

async function readDraftRecipients(env: Env, draftR2Key: string): Promise<{
  to: string[];
  cc: string[];
  bcc: string[];
}> {
  const draftObject = await env.R2_EMAIL.get(draftR2Key);
  if (!draftObject) {
    throw new McpToolError("resource_draft_not_found", "Draft payload not found");
  }

  const payload = await draftObject.json<Record<string, unknown>>();
  const parseRecipientList = (value: unknown, field: "to" | "cc" | "bcc"): string[] => {
    if (value === undefined || value === null) {
      if (field === "to") {
        throw new McpToolError(
          "invalid_arguments",
          "Draft recipients must include a non-empty to array and optional cc/bcc string arrays",
        );
      }
      return [];
    }

    if (!Array.isArray(value)) {
      throw new McpToolError(
        "invalid_arguments",
        "Draft recipients must include a non-empty to array and optional cc/bcc string arrays",
      );
    }

    const items = value.map((item) => typeof item === "string" ? item.trim() : "");
    if (items.some((item) => !item)) {
      throw new McpToolError(
        "invalid_arguments",
        "Draft recipients must include a non-empty to array and optional cc/bcc string arrays",
      );
    }
    if (field === "to" && items.length === 0) {
      throw new McpToolError(
        "invalid_arguments",
        "Draft recipients must include a non-empty to array and optional cc/bcc string arrays",
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
    throw new McpToolError("resource_draft_not_found", "Draft payload not found");
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
    throw new McpToolError("resource_draft_not_found", "Draft payload not found");
  }

  const payload = await draftObject.json<Record<string, unknown>>();
  const attachments = payload.attachments;
  if (attachments === undefined || attachments === null) {
    return;
  }
  if (!Array.isArray(attachments)) {
    throw new McpToolError("invalid_arguments", "Draft attachments must be an array when provided");
  }

  const normalizedAttachments = attachments.map((item) => {
    if (
      typeof item !== "object"
      || item === null
      || typeof (item as { filename?: unknown }).filename !== "string"
      || typeof (item as { contentType?: unknown }).contentType !== "string"
      || typeof (item as { r2Key?: unknown }).r2Key !== "string"
    ) {
      throw new McpToolError("invalid_arguments", "Draft attachments must include filename, contentType, and r2Key");
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
    throw createInsufficientCreditsToolError({
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
    throw new McpToolError(
      decision.code ?? "access_mailbox_denied",
      decision.message ?? "Outbound policy denied this send request",
    );
  }
}

async function validateActiveDraftMailbox(env: Env, input: {
  tenantId: string;
  mailboxId: string;
}) {
  const mailbox = await getMailboxById(env, input.mailboxId);
  if (!mailbox) {
    throw new McpToolError("resource_mailbox_not_found", "Mailbox not found");
  }
  if (mailbox.tenant_id !== input.tenantId) {
    throw new McpToolError("invalid_arguments", "Mailbox does not belong to tenant");
  }
  if (mailbox.status !== "active") {
    throw new McpToolError("access_mailbox_denied", "Mailbox is not active");
  }
}

async function validateDraftFromAddress(env: Env, input: {
  tenantId: string;
  mailboxId: string;
  from: string;
}) {
  const mailbox = await getMailboxById(env, input.mailboxId);
  if (!mailbox) {
    throw new McpToolError("resource_mailbox_not_found", "Mailbox not found");
  }
  if (mailbox.tenant_id !== input.tenantId) {
    throw new McpToolError("invalid_arguments", "Mailbox does not belong to tenant");
  }
  if (input.from.trim().toLowerCase() !== mailbox.address.trim().toLowerCase()) {
    throw new McpToolError("invalid_arguments", "from must match the mailbox address");
  }
}

const router = new Router<Env>();

const TOOL_DEFINITIONS: ToolDescriptor[] = [
  {
    ...RUNTIME_TOOL_CATALOG.find((tool) => tool.name === "create_agent")!,
    inputSchema: {
      type: "object",
      required: ["tenantId", "name", "mode"],
      properties: {
        tenantId: { type: "string" },
        name: { type: "string" },
        mode: { type: "string", enum: ["assistant", "autonomous", "review_only"] },
        config: { type: "object" },
      },
      additionalProperties: false,
    },
  },
  {
    ...RUNTIME_TOOL_CATALOG.find((tool) => tool.name === "bind_mailbox")!,
    inputSchema: {
      type: "object",
      required: ["agentId", "tenantId", "mailboxId", "role"],
      properties: {
        agentId: { type: "string" },
        tenantId: { type: "string" },
        mailboxId: { type: "string" },
        role: { type: "string", enum: ["primary", "shared", "send_only", "receive_only"] },
      },
      additionalProperties: false,
    },
  },
  {
    ...RUNTIME_TOOL_CATALOG.find((tool) => tool.name === "upsert_agent_policy")!,
    inputSchema: {
      type: "object",
      required: ["agentId", "autoReplyEnabled", "humanReviewRequired", "confidenceThreshold", "maxAutoRepliesPerThread"],
      properties: {
        agentId: { type: "string" },
        autoReplyEnabled: { type: "boolean" },
        humanReviewRequired: { type: "boolean" },
        confidenceThreshold: { type: "number" },
        maxAutoRepliesPerThread: { type: "number" },
        allowedRecipientDomains: { type: "array", items: { type: "string" } },
        blockedSenderDomains: { type: "array", items: { type: "string" } },
        allowedTools: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    ...RUNTIME_TOOL_CATALOG.find((tool) => tool.name === "reply_to_inbound_email")!,
    inputSchema: {
      type: "object",
      required: ["agentId", "messageId"],
      properties: {
        agentId: { type: "string" },
        messageId: { type: "string" },
        replyText: { type: "string" },
        replyHtml: { type: "string" },
        send: { type: "boolean" },
        idempotencyKey: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    ...RUNTIME_TOOL_CATALOG.find((tool) => tool.name === "operator_manual_send")!,
    inputSchema: {
      type: "object",
      required: ["agentId", "tenantId", "mailboxId", "from", "to", "subject"],
      properties: {
        agentId: { type: "string" },
        tenantId: { type: "string" },
        mailboxId: { type: "string" },
        threadId: { type: "string" },
        sourceMessageId: { type: "string" },
        from: { type: "string" },
        to: { type: "array", items: { type: "string" }, minItems: 1 },
        cc: { type: "array", items: { type: "string" } },
        bcc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        text: { type: "string" },
        html: { type: "string" },
        inReplyTo: { type: "string" },
        references: { type: "array", items: { type: "string" } },
        send: { type: "boolean" },
        idempotencyKey: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    ...RUNTIME_TOOL_CATALOG.find((tool) => tool.name === "list_agent_tasks")!,
    inputSchema: {
      type: "object",
      required: ["agentId"],
      properties: {
        agentId: { type: "string" },
        status: {
          type: "string",
          enum: ["queued", "running", "done", "needs_review", "failed"],
        },
      },
      additionalProperties: false,
    },
  },
  {
    ...RUNTIME_TOOL_CATALOG.find((tool) => tool.name === "list_messages")!,
    inputSchema: {
      type: "object",
      properties: {
        mailboxId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        search: { type: "string" },
        direction: { type: "string", enum: ["inbound", "outbound"] },
        status: {
          type: "string",
          enum: ["received", "normalized", "tasked", "replied", "ignored", "failed"],
        },
      },
      additionalProperties: false,
    },
  },
  {
    ...RUNTIME_TOOL_CATALOG.find((tool) => tool.name === "get_message")!,
    inputSchema: {
      type: "object",
      required: ["messageId"],
      properties: {
        messageId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    ...RUNTIME_TOOL_CATALOG.find((tool) => tool.name === "get_message_content")!,
    inputSchema: {
      type: "object",
      required: ["messageId"],
      properties: {
        messageId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    ...RUNTIME_TOOL_CATALOG.find((tool) => tool.name === "get_thread")!,
    inputSchema: {
      type: "object",
      required: ["threadId"],
      properties: {
        threadId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    ...RUNTIME_TOOL_CATALOG.find((tool) => tool.name === "create_draft")!,
    inputSchema: {
      type: "object",
      required: ["to", "subject"],
      properties: {
        agentId: { type: "string" },
        tenantId: { type: "string" },
        mailboxId: { type: "string" },
        threadId: { type: "string" },
        sourceMessageId: { type: "string" },
        from: { type: "string" },
        to: { type: "array", items: { type: "string" }, minItems: 1 },
        cc: { type: "array", items: { type: "string" } },
        bcc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        text: { type: "string" },
        html: { type: "string" },
        inReplyTo: { type: "string" },
        references: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    ...RUNTIME_TOOL_CATALOG.find((tool) => tool.name === "get_draft")!,
    inputSchema: {
      type: "object",
      required: ["draftId"],
      properties: {
        draftId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    ...RUNTIME_TOOL_CATALOG.find((tool) => tool.name === "send_draft")!,
    inputSchema: {
      type: "object",
      required: ["draftId"],
      properties: {
        draftId: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    ...RUNTIME_TOOL_CATALOG.find((tool) => tool.name === "cancel_draft")!,
    inputSchema: {
      type: "object",
      required: ["draftId"],
      properties: {
        draftId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    ...RUNTIME_TOOL_CATALOG.find((tool) => tool.name === "send_email")!,
    inputSchema: {
      type: "object",
      required: ["to", "subject"],
      properties: {
        mailboxId: { type: "string" },
        to: { type: "array", items: { type: "string" }, minItems: 1 },
        cc: { type: "array", items: { type: "string" } },
        bcc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        text: { type: "string" },
        html: { type: "string" },
        inReplyTo: { type: "string" },
        references: { type: "array", items: { type: "string" } },
        idempotencyKey: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    ...RUNTIME_TOOL_CATALOG.find((tool) => tool.name === "reply_to_message")!,
    inputSchema: {
      type: "object",
      required: ["messageId"],
      properties: {
        messageId: { type: "string" },
        text: { type: "string" },
        html: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    ...RUNTIME_TOOL_CATALOG.find((tool) => tool.name === "replay_message")!,
    inputSchema: {
      type: "object",
      required: ["messageId", "mode"],
      properties: {
        messageId: { type: "string" },
        mode: {
          type: "string",
          enum: ["normalize", "rerun_agent"],
        },
        agentId: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      additionalProperties: false,
    },
  },
];
function getToolByName(name: string): ToolDescriptor | undefined {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name);
}

function filterToolsForClaims(claims: AccessTokenClaims): ToolDescriptor[] {
  return TOOL_DEFINITIONS.filter((tool) => {
    if (!tool.requiredScopes.every((scope) => claims.scopes.includes(scope))) {
      return false;
    }

    if (claims.mailboxIds?.length && MAILBOX_SCOPED_HIDDEN_TOOLS.has(tool.name)) {
      return false;
    }

    if (!claims.agentId && AGENT_BOUND_HIDDEN_TOOLS.has(tool.name)) {
      return false;
    }

    return true;
  });
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpToolError("invalid_arguments", "params must be an object");
  }

  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new McpToolError("invalid_arguments", `${field} must be a non-empty string`);
  }

  return value.trim();
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new McpToolError("invalid_arguments", `${field} must be a non-empty string array`);
  }

  return value.map((item) => item.trim());
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new McpToolError("invalid_arguments", "array fields must contain strings");
  }

  return value.map((item) => item.trim()).filter(Boolean);
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new McpToolError("invalid_arguments", `${field} must be an integer`);
  }

  return value;
}

function optionalIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new McpToolError("invalid_arguments", "idempotencyKey must be a non-empty string");
  }

  return value.trim();
}

async function requireClaims(request: Request, env: Env, scopes: string[]): Promise<AccessTokenClaims | Response> {
  return await requireAuth(request, env, scopes);
}

async function requireClaimsStrict(request: Request, env: Env, scopes: string[]): Promise<AccessTokenClaims> {
  const auth = await requireClaims(request, env, scopes);
  if (auth instanceof Response) {
    await throwIfResponseError(auth);
  }

  return auth as AccessTokenClaims;
}

async function throwIfResponseError(response: Response): Promise<never> {
  let payload: { error?: string } | null = null;
  try {
    payload = await response.clone().json<{ error?: string }>();
  } catch {
    payload = null;
  }

  const message = payload?.error ?? `HTTP ${response.status}`;
  if (response.status === 401) {
    throw new McpToolError("auth_unauthorized", message);
  }
  if (response.status === 403 && message.startsWith("Missing scopes:")) {
    throw new McpToolError("auth_missing_scope", message);
  }
  if (response.status === 403 && message === "Tenant access denied") {
    throw new McpToolError("access_tenant_denied", message);
  }
  if (response.status === 403 && message === "Agent access denied") {
    throw new McpToolError("access_agent_denied", message);
  }
  if (response.status === 403 && message === "Mailbox access denied") {
    throw new McpToolError("access_mailbox_denied", message);
  }
  if (response.status === 409 && message.includes("Idempotency key")) {
    throw new McpToolError("idempotency_conflict", message);
  }
  if (response.status === 409 && message.includes("already in progress")) {
    throw new McpToolError("idempotency_in_progress", message);
  }

  throw new McpToolError("http_error", message, { status: response.status });
}

function toolErrorPayload(errorCode: string, message: string, details?: unknown) {
  return {
    error: {
      code: errorCode,
      message,
      details,
    },
  };
}

function buildInsufficientCreditsToolDetails(input: {
  availableCredits?: number;
  creditsRequired: number;
}) {
  const currentCredits = input.availableCredits ?? 0;
  return {
    currentCredits,
    requiredCredits: input.creditsRequired,
    suggestedAction: "Use POST /v1/billing/topup to add credits, then retry the send with the same idempotency key if applicable.",
    docUrl: "/limits",
  };
}

function createInsufficientCreditsToolError(input: {
  availableCredits?: number;
  creditsRequired: number;
}): McpToolError {
  const details = buildInsufficientCreditsToolDetails(input);
  return new McpToolError(
    "insufficient_credits",
    `Insufficient credits for external sending. Required: ${input.creditsRequired}, available: ${details.currentCredits}`,
    details,
  );
}

function buildQueuedCreateAndSendToolResult(input: {
  draft: Awaited<ReturnType<typeof createDraft>>;
  outboundJobId: string;
  status: "queued";
}): CreatedAndSentDraftResult {
  return {
    ...input,
    acceptedForDelivery: true,
    deliveryState: "queued",
    finalDeliveryState: "pending",
    statusCheck: {
      outboundJobPath: `/v1/outbound-jobs/${encodeURIComponent(input.outboundJobId)}`,
      draftPath: `/v1/drafts/${encodeURIComponent(input.draft.id)}`,
    },
    message: "Send queued for asynchronous delivery. Accepted means the runtime queued the send, not that the provider has delivered it yet.",
  };
}

function buildQueuedSendDraftToolResult(input: {
  draftId: string;
  outboundJobId: string;
  status: "queued";
}) {
  return {
    ...input,
    acceptedForDelivery: true,
    deliveryState: "queued" as const,
    finalDeliveryState: "pending" as const,
    statusCheck: {
      outboundJobPath: `/v1/outbound-jobs/${encodeURIComponent(input.outboundJobId)}`,
      draftPath: `/v1/drafts/${encodeURIComponent(input.draftId)}`,
    },
    message: "Send queued for asynchronous delivery. Accepted means the runtime queued the send, not that the provider has delivered it yet.",
  };
}

async function validateBindingResources(
  env: Env,
  tenantId: string,
  agentId: string,
  mailboxId: string,
  bindingRoles?: Array<"primary" | "shared" | "send_only" | "receive_only">
): Promise<void> {
  const agent = await getAgent(env, agentId);
  if (!agent) {
    throw new McpToolError("resource_agent_not_found", "Agent not found");
  }
  if (agent.tenantId !== tenantId) {
    throw new McpToolError("invalid_arguments", "Agent does not belong to tenant");
  }

  const mailbox = await getMailboxById(env, mailboxId);
  if (!mailbox) {
    throw new McpToolError("resource_mailbox_not_found", "Mailbox not found");
  }
  if (mailbox.tenant_id !== tenantId) {
    throw new McpToolError("invalid_arguments", "Mailbox does not belong to tenant");
  }

  if (bindingRoles?.length) {
    const hasBinding = await hasActiveMailboxBinding(env, {
      agentId,
      mailboxId,
      roles: bindingRoles,
    });
    const hasAnyBinding = await hasActiveMailboxBinding(env, {
      agentId,
      mailboxId,
    });
    const hasDeployment = await hasActiveMailboxDeployment(env, {
      agentId,
      mailboxId,
    });
    if (!hasBinding && (!hasDeployment || hasAnyBinding)) {
      throw new McpToolError("access_mailbox_denied", "Agent is not allowed to send for mailbox");
    }
  }
}

function requireSelfAgentId(claims: AccessTokenClaims): string {
  if (!claims.agentId) {
    throw new McpToolError("invalid_arguments", "This token is not bound to a single agent");
  }

  return claims.agentId;
}

async function requireSelfAgentForMailbox(env: Env, claims: AccessTokenClaims, mailboxId: string): Promise<string> {
  const agentId = requireSelfAgentId(claims);
  const agent = await getAgent(env, agentId);
  if (!agent) {
    throw new McpToolError("resource_agent_not_found", "Agent not found");
  }
  if (agent.tenantId !== claims.tenantId) {
    throw new McpToolError("access_mailbox_denied", "Tenant access denied");
  }

  const hasBinding = await hasActiveMailboxBinding(env, {
    agentId,
    mailboxId,
  });
  if (hasBinding) {
    return agentId;
  }

  const hasDeployment = await hasActiveMailboxDeployment(env, {
    agentId,
    mailboxId,
  });
  if (!hasDeployment) {
    throw new McpToolError("access_mailbox_denied", "Agent is not active for mailbox");
  }

  return agentId;
}

async function validateActiveAgentMailboxAccess(env: Env, input: {
  tenantId: string;
  agentId: string;
  mailboxId: string;
}): Promise<void> {
  const agent = await getAgent(env, input.agentId);
  if (!agent) {
    throw new McpToolError("resource_agent_not_found", "Agent not found");
  }
  if (agent.tenantId !== input.tenantId) {
    throw new McpToolError("invalid_arguments", "Agent does not belong to tenant");
  }

  const mailbox = await getMailboxById(env, input.mailboxId);
  if (!mailbox) {
    throw new McpToolError("resource_mailbox_not_found", "Mailbox not found");
  }
  if (mailbox.tenant_id !== input.tenantId) {
    throw new McpToolError("invalid_arguments", "Mailbox does not belong to tenant");
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
    throw new McpToolError("access_mailbox_denied", "Agent is not active for mailbox");
  }
}

async function validateCurrentMailboxAccessForClaims(env: Env, claims: AccessTokenClaims, mailboxId: string): Promise<void> {
  if (!claims.agentId || !claims.mailboxIds?.length) {
    return;
  }

  await validateActiveAgentMailboxAccess(env, {
    tenantId: claims.tenantId,
    agentId: claims.agentId,
    mailboxId,
  });
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

function requireAgentControlPlaneClaims(claims: AccessTokenClaims): void {
  if (claims.mailboxIds?.length) {
    throw new McpToolError("access_mailbox_denied", "Mailbox-scoped tokens cannot access agent control-plane resources");
  }
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
  claims: AccessTokenClaims,
  messageId: string,
): Promise<void> {
  if (!claims.mailboxIds?.length) {
    return;
  }

  if (await isMailboxScopedOperatorTokenDeliveryMessage(env, messageId)) {
    throw new McpToolError("resource_message_not_found", "Message not found");
  }
}

async function filterVisibleMessagesForClaims(
  env: Env,
  claims: AccessTokenClaims,
  messages: Awaited<ReturnType<typeof listMessages>>,
): Promise<Awaited<ReturnType<typeof listMessages>>> {
  if (!claims.mailboxIds?.length) {
    return messages;
  }

  const visibleMessages = [];
  for (const message of messages) {
    if (!(await isMailboxScopedOperatorTokenDeliveryMessage(env, message.id))) {
      visibleMessages.push(message);
    }
  }

  return visibleMessages;
}

async function filterVisibleThreadForClaims(
  env: Env,
  claims: AccessTokenClaims,
  thread: NonNullable<Awaited<ReturnType<typeof getThread>>>,
): Promise<NonNullable<Awaited<ReturnType<typeof getThread>>> | null> {
  if (!claims.mailboxIds?.length) {
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

async function enforceMailboxScopedDraftReferenceVisibility(env: Env, claims: AccessTokenClaims, input: {
  threadId?: string;
  sourceMessageId?: string;
}): Promise<void> {
  if (input.sourceMessageId) {
    await enforceMailboxScopedMessageVisibility(env, claims, input.sourceMessageId);
  }

  if (input.threadId) {
    const thread = await getThread(env, input.threadId);
    if (thread && !(await filterVisibleThreadForClaims(env, claims, thread))) {
      throw new McpToolError("resource_thread_not_found", "Thread not found");
    }
  }
}

async function sanitizeDraftReferencesForClaims(
  env: Env,
  claims: AccessTokenClaims,
  draft: NonNullable<Awaited<ReturnType<typeof getDraft>>>,
): Promise<NonNullable<Awaited<ReturnType<typeof getDraft>>>> {
  if (!claims.mailboxIds?.length) {
    return draft;
  }

  let sourceMessageId = draft.sourceMessageId;
  if (sourceMessageId) {
    try {
      await enforceMailboxScopedMessageVisibility(env, claims, sourceMessageId);
    } catch (error) {
      if (error instanceof McpToolError && error.errorCode === "resource_message_not_found") {
        sourceMessageId = undefined;
      } else {
        throw error;
      }
    }
  }

  let threadId = draft.threadId;
  if (threadId) {
    const thread = await getThread(env, threadId);
    if (thread && !(await filterVisibleThreadForClaims(env, claims, thread))) {
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

async function resolveMailboxForClaims(
  env: Env,
  claims: AccessTokenClaims,
  requestedMailboxId?: string,
  options?: { requireActive?: boolean },
) {
  const mailboxId = requestedMailboxId?.trim()
    || (claims.mailboxIds?.length === 1 ? claims.mailboxIds[0] : undefined);

  if (!mailboxId) {
    throw new McpToolError("invalid_arguments", "mailboxId is required unless the token is bound to a single mailbox");
  }

  const mailbox = await getMailboxById(env, mailboxId);
  if (!mailbox) {
    throw new McpToolError("resource_mailbox_not_found", "Mailbox not found");
  }

  const tenantError = enforceTenantAccess(claims, mailbox.tenant_id);
  if (tenantError) {
    await throwIfResponseError(tenantError);
  }
  const mailboxError = enforceMailboxAccess(claims, mailbox.id);
  if (mailboxError) {
    await throwIfResponseError(mailboxError);
  }
  if (options?.requireActive && mailbox.status !== "active") {
    throw new McpToolError("access_mailbox_denied", "Mailbox is not active");
  }

  return mailbox;
}

async function createAndSendDraftForMcp(env: Env, input: {
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
}): Promise<CreatedAndSentDraftResult> {
  const idempotencyKey = input.idempotencyKey?.trim();

  if (input.idempotencyKey !== undefined && !idempotencyKey) {
    throw new McpToolError("invalid_arguments", "idempotencyKey must be a non-empty string");
  }
  const validateCreateAndSendInput = async () => {
    if (!input.payload.text && !input.payload.html) {
      throw new McpToolError("invalid_arguments", "text or html is required");
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
    await validateBindingResources(env, input.tenantId, input.agentId, input.mailboxId, [...SEND_CAPABLE_MAILBOX_ROLES]);
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
      throw new McpToolError(decision.code ?? "access_mailbox_denied", decision.message ?? "Outbound policy denied this send request");
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
      throw createInsufficientCreditsToolError({
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
      return buildQueuedCreateAndSendToolResult({
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
    throw new McpToolError("idempotency_conflict", "Idempotency key is already used for a different send request");
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
    throw new McpToolError("idempotency_in_progress", "A send request with this idempotency key is already in progress");
  }
  if (reservation.status === "completed") {
    await validateCreateAndSendInput();
    if (reservation.record.response) {
      return reservation.record.response as CreatedAndSentDraftResult;
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
    const response = buildQueuedCreateAndSendToolResult({
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

async function callTool(request: Request, env: Env, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  if (toolName === "create_agent") {
    const auth = await requireClaimsStrict(request, env, ["agent:create"]);
    requireAgentControlPlaneClaims(auth);
    const tenantId = requireString(args.tenantId, "tenantId");
    const name = requireString(args.name, "name");
    const mode = requireString(args.mode, "mode");
    if (mode !== "assistant" && mode !== "autonomous" && mode !== "review_only") {
      throw new McpToolError("invalid_arguments", "mode must be assistant, autonomous, or review_only");
    }

    const tenantError = enforceTenantAccess(auth, tenantId);
    if (tenantError) {
      await throwIfResponseError(tenantError);
    }

    return await createAgent(env, {
      tenantId,
      name,
      mode,
      config: args.config ?? {},
    });
  }

  if (toolName === "bind_mailbox") {
    const auth = await requireClaimsStrict(request, env, ["agent:bind"]);
    requireAgentControlPlaneClaims(auth);
    const agentId = requireString(args.agentId, "agentId");
    const tenantId = requireString(args.tenantId, "tenantId");
    const mailboxId = requireString(args.mailboxId, "mailboxId");
    const role = requireString(args.role, "role");
    if (role !== "primary" && role !== "shared" && role !== "send_only" && role !== "receive_only") {
      throw new McpToolError("invalid_arguments", "role must be primary, shared, send_only, or receive_only");
    }

    const tenantError = enforceTenantAccess(auth, tenantId);
    if (tenantError) {
      await throwIfResponseError(tenantError);
    }
    const agentError = enforceScopedAgentAccess(auth, agentId);
    if (agentError) {
      await throwIfResponseError(agentError);
    }
    const mailboxError = enforceMailboxAccess(auth, mailboxId);
    if (mailboxError) {
      await throwIfResponseError(mailboxError);
    }
    await validateBindingResources(env, tenantId, agentId, mailboxId);

    try {
      return await bindMailbox(env, {
        tenantId,
        agentId,
        mailboxId,
        role,
      });
    } catch (error) {
      if (error instanceof MailboxConflictError) {
        throw new McpToolError("conflict", error.message);
      }
      throw error;
    }
  }

  if (toolName === "upsert_agent_policy") {
    const auth = await requireClaimsStrict(request, env, ["agent:update"]);
    requireAgentControlPlaneClaims(auth);
    const agentId = requireString(args.agentId, "agentId");
    const agent = await getAgent(env, agentId);
    if (!agent) {
      throw new McpToolError("resource_agent_not_found", "Agent not found");
    }
    const tenantError = enforceTenantAccess(auth, agent.tenantId);
    if (tenantError) {
      await throwIfResponseError(tenantError);
    }
    const agentError = enforceScopedAgentAccess(auth, agentId);
    if (agentError) {
      await throwIfResponseError(agentError);
    }

    if (typeof args.autoReplyEnabled !== "boolean") {
      throw new McpToolError("invalid_arguments", "autoReplyEnabled must be boolean");
    }
    if (typeof args.humanReviewRequired !== "boolean") {
      throw new McpToolError("invalid_arguments", "humanReviewRequired must be boolean");
    }
    if (typeof args.confidenceThreshold !== "number") {
      throw new McpToolError("invalid_arguments", "confidenceThreshold must be number");
    }
    if (typeof args.maxAutoRepliesPerThread !== "number") {
      throw new McpToolError("invalid_arguments", "maxAutoRepliesPerThread must be number");
    }

    return await upsertAgentPolicy(env, {
      agentId,
      autoReplyEnabled: args.autoReplyEnabled,
      humanReviewRequired: args.humanReviewRequired,
      confidenceThreshold: args.confidenceThreshold,
      maxAutoRepliesPerThread: args.maxAutoRepliesPerThread,
      allowedRecipientDomains: optionalStringArray(args.allowedRecipientDomains) ?? [],
      blockedSenderDomains: optionalStringArray(args.blockedSenderDomains) ?? [],
      allowedTools: optionalStringArray(args.allowedTools) ?? [],
    });
  }

  if (toolName === "reply_to_inbound_email") {
    const auth = await requireClaimsStrict(request, env, ["mail:read", "draft:create"]);
    const agentId = requireString(args.agentId, "agentId");
    const messageId = requireString(args.messageId, "messageId");
    const replyText = optionalString(args.replyText);
    const replyHtml = optionalString(args.replyHtml);
    if (!replyText && !replyHtml) {
      throw new McpToolError("invalid_arguments", "replyText or replyHtml is required");
    }

    const send = args.send === true;
    const idempotencyKey = optionalIdempotencyKey(args.idempotencyKey);
    if (send) {
      const sendAuth = await requireClaims(request, env, ["draft:send"]);
      if (sendAuth instanceof Response) {
        await throwIfResponseError(sendAuth);
      }
      if (!idempotencyKey) {
        throw new McpToolError("invalid_arguments", "idempotencyKey is required when send is true");
      }
    }

    const message = await getMessage(env, messageId);
    if (!message) {
      throw new McpToolError("resource_message_not_found", "Message not found");
    }
    if (message.direction !== "inbound") {
      throw new McpToolError("invalid_arguments", "reply_to_inbound_email only supports inbound messages");
    }

    const tenantError = enforceTenantAccess(auth, message.tenantId);
    if (tenantError) {
      await throwIfResponseError(tenantError);
    }
    const mailboxError = enforceMailboxAccess(auth, message.mailboxId);
    if (mailboxError) {
      await throwIfResponseError(mailboxError);
    }
    await enforceMailboxScopedMessageVisibility(env, auth, message.id);
    const agentError = enforceScopedAgentAccess(auth, agentId);
    if (agentError) {
      await throwIfResponseError(agentError);
    }
    const buildReplyDraftInput = async () => {
      await validateActiveAgentMailboxAccess(env, {
        tenantId: message.tenantId,
        agentId,
        mailboxId: message.mailboxId,
      });
      await validateBindingResources(env, message.tenantId, agentId, message.mailboxId);
      if (send) {
        await validateActiveDraftMailbox(env, {
          tenantId: message.tenantId,
          mailboxId: message.mailboxId,
        });
        await validateBindingResources(env, message.tenantId, agentId, message.mailboxId, [...SEND_CAPABLE_MAILBOX_ROLES]);
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
        throw new McpToolError("resource_mailbox_not_found", "Mailbox not found");
      }

      const replySubject = message.subject && message.subject.toLowerCase().startsWith("re:")
        ? message.subject
        : `Re: ${message.subject ?? ""}`.trim();

      return {
        thread,
        draftPayload: {
          from: replyMailbox.address,
          to: [message.fromAddr],
          cc: [],
          bcc: [],
          subject: replySubject || "Re:",
          text: replyText ?? "",
          html: replyHtml ?? "",
          inReplyTo: message.internetMessageId,
          references,
          attachments: [],
        },
      };
    };

    if (!send) {
      const { thread, draftPayload } = await buildReplyDraftInput();
      const draft = await createDraft(env, {
        tenantId: message.tenantId,
        agentId,
        mailboxId: message.mailboxId,
        threadId: message.threadId,
        sourceMessageId: message.id,
        createdVia: "mcp:reply_to_inbound_email",
        payload: draftPayload,
      });
      return {
        draft,
        sourceMessage: message,
        usedThreadContext: Boolean(thread),
      };
    }

    const reservation = await reserveIdempotencyKey(env, {
      operation: "draft_send",
      tenantId: message.tenantId,
      idempotencyKey: idempotencyKey!,
      requestFingerprint: JSON.stringify({
        tool: "reply_to_inbound_email",
        agentId,
        messageId,
        replyText: replyText ?? null,
        replyHtml: replyHtml ?? null,
        send: true,
      }),
    });

    if (reservation.status === "conflict") {
      throw new McpToolError("idempotency_conflict", "Idempotency key is already used for a different reply workflow request");
    }
    if (reservation.status === "pending") {
      if (reservation.record.resourceId) {
        const { thread } = await buildReplyDraftInput();
        const replay = await restoreDraftSendReplay(env, reservation.record.resourceId);
        const response = {
          draft: replay.draft,
          sendResult: {
            draftId: replay.draft.id,
            outboundJobId: replay.outboundJobId,
            status: replay.status,
          },
          sourceMessage: message,
          usedThreadContext: Boolean(thread),
        };
        await bestEffortCompleteRecoveredIdempotency(env, {
          operation: "draft_send",
          tenantId: message.tenantId,
          idempotencyKey: idempotencyKey!,
          resourceId: replay.draft.id,
          response,
        });
        return {
          ...response,
        };
      }
      throw new McpToolError("idempotency_in_progress", "A reply workflow request with this idempotency key is already in progress");
    }

    if (reservation.status === "completed") {
      const { thread } = await buildReplyDraftInput();
      if (reservation.record.response) {
        return reservation.record.response;
      }

      const replay = await restoreDraftSendReplay(env, reservation.record.resourceId);
      return {
        draft: replay.draft,
        sendResult: {
          draftId: replay.draft.id,
          outboundJobId: replay.outboundJobId,
          status: replay.status,
        },
        sourceMessage: message,
        usedThreadContext: Boolean(thread),
      };
    }

    let sideEffectCommitted = false;
    try {
      const { thread, draftPayload } = await buildReplyDraftInput();
      const sendResult = await createAndSendDraftForMcp(env, {
        tenantId: message.tenantId,
        agentId,
        mailboxId: message.mailboxId,
        threadId: message.threadId,
        sourceMessageId: message.id,
        payload: draftPayload,
        createdVia: "mcp:reply_to_inbound_email",
        requestFingerprint: JSON.stringify({
          tool: "reply_to_inbound_email",
          agentId,
          messageId,
          replyText: replyText ?? null,
          replyHtml: replyHtml ?? null,
          send: true,
        }),
      });
      sideEffectCommitted = true;
      const response = {
        draft: sendResult.draft,
        sendResult: {
          draftId: sendResult.draft.id,
          outboundJobId: sendResult.outboundJobId,
          status: sendResult.status,
        },
        sourceMessage: message,
        usedThreadContext: Boolean(thread),
      };
      await updateIdempotencyKeyResource(env, {
        operation: "draft_send",
        tenantId: message.tenantId,
        idempotencyKey: idempotencyKey!,
        resourceId: sendResult.draft.id,
      });
      await completeIdempotencyKey(env, {
        operation: "draft_send",
        tenantId: message.tenantId,
        idempotencyKey: idempotencyKey!,
        resourceId: sendResult.draft.id,
        response,
      });
      return response;
    } catch (error) {
      if (!sideEffectCommitted && !hasCommittedSideEffect(error)) {
        await releaseIdempotencyKey(env, "draft_send", message.tenantId, idempotencyKey!);
      }
      throw sideEffectCommitted ? markSideEffectCommitted(error) : error;
    }
  }

  if (toolName === "operator_manual_send") {
    const auth = await requireClaimsStrict(request, env, ["draft:create"]);
    const agentId = requireString(args.agentId, "agentId");
    const tenantId = requireString(args.tenantId, "tenantId");
    const mailboxId = requireString(args.mailboxId, "mailboxId");
    const from = requireString(args.from, "from");
    const to = requireStringArray(args.to, "to");
    const subject = requireString(args.subject, "subject");
    const cc = optionalStringArray(args.cc) ?? [];
    const bcc = optionalStringArray(args.bcc) ?? [];
    const text = optionalString(args.text) ?? "";
    const html = optionalString(args.html) ?? "";
    const send = args.send === true;
    const idempotencyKey = optionalIdempotencyKey(args.idempotencyKey);
    const threadId = optionalString(args.threadId);
    const sourceMessageId = optionalString(args.sourceMessageId);
    const inReplyTo = optionalString(args.inReplyTo);
    const references = optionalStringArray(args.references) ?? [];

    if (!text && !html) {
      throw new McpToolError("invalid_arguments", "text or html is required");
    }

    const tenantError = enforceTenantAccess(auth, tenantId);
    if (tenantError) {
      await throwIfResponseError(tenantError);
    }
    const agentError = enforceScopedAgentAccess(auth, agentId);
    if (agentError) {
      await throwIfResponseError(agentError);
    }
    const mailboxError = enforceMailboxAccess(auth, mailboxId);
    if (mailboxError) {
      await throwIfResponseError(mailboxError);
    }
    const validateOperatorManualSendInput = async () => {
      await validateActiveAgentMailboxAccess(env, {
        tenantId,
        agentId,
        mailboxId,
      });
      await validateBindingResources(env, tenantId, agentId, mailboxId);
      await validateDraftFromAddress(env, {
        tenantId,
        mailboxId,
        from,
      });
      await validateDraftReferences(env, {
        tenantId,
        mailboxId,
        threadId,
        sourceMessageId,
      });
      await enforceMailboxScopedDraftReferenceVisibility(env, auth, {
        threadId,
        sourceMessageId,
      });

      if (send) {
        await validateActiveDraftMailbox(env, {
          tenantId,
          mailboxId,
        });
        await validateBindingResources(env, tenantId, agentId, mailboxId, [...SEND_CAPABLE_MAILBOX_ROLES]);
      }
    };

    if (send) {
      const sendAuth = await requireClaims(request, env, ["draft:send"]);
      if (sendAuth instanceof Response) {
        await throwIfResponseError(sendAuth);
      }
      if (!idempotencyKey) {
        throw new McpToolError("invalid_arguments", "idempotencyKey is required when send is true");
      }
    } else {
      await validateOperatorManualSendInput();
    }

    const draftPayload = {
      from,
      to,
      cc,
      bcc,
      subject,
      text,
      html,
      inReplyTo,
      references,
      attachments: [],
    };

    if (!send) {
      const draft = await createDraft(env, {
        tenantId,
        agentId,
        mailboxId,
        threadId,
        sourceMessageId,
        createdVia: "mcp:operator_manual_send",
        payload: draftPayload,
      });
      return {
        draft,
        sendRequested: false,
      };
    }

    const reservation = await reserveIdempotencyKey(env, {
      operation: "draft_send",
      tenantId,
      idempotencyKey: idempotencyKey!,
      requestFingerprint: JSON.stringify({
        tool: "operator_manual_send",
        agentId,
        tenantId,
        mailboxId,
        from,
        to,
        cc,
        bcc,
        subject,
        text,
        html,
        inReplyTo: inReplyTo ?? null,
        references,
        threadId: threadId ?? null,
        sourceMessageId: sourceMessageId ?? null,
        send: true,
      }),
    });

    if (reservation.status === "conflict") {
      throw new McpToolError("idempotency_conflict", "Idempotency key is already used for a different operator send request");
    }
    if (reservation.status === "pending") {
      if (reservation.record.resourceId) {
        await validateOperatorManualSendInput();
        const response = await restoreOperatorManualSendReplay(env, reservation.record.resourceId);
        await bestEffortCompleteRecoveredIdempotency(env, {
          operation: "draft_send",
          tenantId,
          idempotencyKey: idempotencyKey!,
          resourceId: response.draft.id,
          response,
        });
        return response;
      }
      throw new McpToolError("idempotency_in_progress", "An operator send request with this idempotency key is already in progress");
    }
    if (reservation.status === "completed") {
      await validateOperatorManualSendInput();
      if (reservation.record.response) {
        return reservation.record.response;
      }

      return await restoreOperatorManualSendReplay(env, reservation.record.resourceId);
    }

    let sideEffectCommitted = false;
    try {
      await validateOperatorManualSendInput();
      const result = await createAndSendDraftForMcp(env, {
        tenantId,
        agentId,
        mailboxId,
        threadId,
        sourceMessageId,
        payload: draftPayload,
        createdVia: "mcp:operator_manual_send",
        requestFingerprint: JSON.stringify({
          tool: "operator_manual_send",
          agentId,
          tenantId,
          mailboxId,
          from,
          to,
          cc,
          bcc,
          subject,
          text,
          html,
          inReplyTo: inReplyTo ?? null,
          references,
          threadId: threadId ?? null,
          sourceMessageId: sourceMessageId ?? null,
          send: true,
        }),
      });
      sideEffectCommitted = true;
      const response = {
        draft: result.draft,
        sendRequested: true,
        sendResult: {
          draftId: result.draft.id,
          outboundJobId: result.outboundJobId,
          status: result.status,
        },
      };
      await updateIdempotencyKeyResource(env, {
        operation: "draft_send",
        tenantId,
        idempotencyKey: idempotencyKey!,
        resourceId: result.draft.id,
      });
      await completeIdempotencyKey(env, {
        operation: "draft_send",
        tenantId,
        idempotencyKey: idempotencyKey!,
        resourceId: result.draft.id,
        response,
      });
      return response;
    } catch (error) {
      if (!sideEffectCommitted && !hasCommittedSideEffect(error)) {
        await releaseIdempotencyKey(env, "draft_send", tenantId, idempotencyKey!);
      }
      throw sideEffectCommitted ? markSideEffectCommitted(error) : error;
    }
  }

  if (toolName === "list_agent_tasks") {
    const auth = await requireClaimsStrict(request, env, ["task:read"]);

    const agentId = requireString(args.agentId, "agentId");
    const agent = await getAgent(env, agentId);
    if (!agent) {
      throw new McpToolError("resource_agent_not_found", "Agent not found");
    }
    const tenantError = enforceTenantAccess(auth, agent.tenantId);
    if (tenantError) {
      await throwIfResponseError(tenantError);
    }
    const agentError = enforceScopedAgentAccess(auth, agentId);
    if (agentError) {
      await throwIfResponseError(agentError);
    }
    const authorizedMailboxIds = await resolveActiveClaimMailboxIdsForAgent(env, auth, agentId);
    if (auth.mailboxIds?.length && !authorizedMailboxIds?.length) {
      throw new McpToolError("access_mailbox_denied", "Agent is not active for any mailbox in this token");
    }
    const status = optionalString(args.status) as TaskStatus | undefined;
    return { items: await listTasks(env, agentId, status, authorizedMailboxIds ?? auth.mailboxIds) };
  }

  if (toolName === "list_messages") {
    const auth = await requireClaimsStrict(request, env, ["mail:read"]);
    const mailbox = await resolveMailboxForClaims(env, auth, optionalString(args.mailboxId));
    await validateCurrentMailboxAccessForClaims(env, auth, mailbox.id);
    const limit = optionalInteger(args.limit, "limit");
    const direction = optionalString(args.direction) as "inbound" | "outbound" | undefined;
    const status = optionalString(args.status) as
      | "received"
      | "normalized"
      | "tasked"
      | "replied"
      | "ignored"
      | "failed"
      | undefined;

    return {
      mailbox: {
        id: mailbox.id,
        address: mailbox.address,
      },
      items: await filterVisibleMessagesForClaims(env, auth, await listMessages(env, {
        mailboxId: mailbox.id,
        limit,
        search: optionalString(args.search),
        direction,
        status,
      })),
    };
  }

  if (toolName === "get_message") {
    const auth = await requireClaimsStrict(request, env, ["mail:read"]);

    const messageId = requireString(args.messageId, "messageId");
    const message = await getMessage(env, messageId);
    if (!message) {
      throw new McpToolError("resource_message_not_found", "Message not found");
    }
    const tenantError = enforceTenantAccess(auth, message.tenantId);
    if (tenantError) {
      await throwIfResponseError(tenantError);
    }
    const mailboxError = enforceMailboxAccess(auth, message.mailboxId);
    if (mailboxError) {
      await throwIfResponseError(mailboxError);
    }
    await validateCurrentMailboxAccessForClaims(env, auth, message.mailboxId);
    await enforceMailboxScopedMessageVisibility(env, auth, message.id);
    return message;
  }

  if (toolName === "get_message_content") {
    const auth = await requireClaimsStrict(request, env, ["mail:read"]);

    const messageId = requireString(args.messageId, "messageId");
    const message = await getMessage(env, messageId);
    if (!message) {
      throw new McpToolError("resource_message_not_found", "Message not found");
    }
    const tenantError = enforceTenantAccess(auth, message.tenantId);
    if (tenantError) {
      await throwIfResponseError(tenantError);
    }
    const mailboxError = enforceMailboxAccess(auth, message.mailboxId);
    if (mailboxError) {
      await throwIfResponseError(mailboxError);
    }
    await validateCurrentMailboxAccessForClaims(env, auth, message.mailboxId);
    await enforceMailboxScopedMessageVisibility(env, auth, message.id);
    return await getMessageContent(env, messageId);
  }

  if (toolName === "get_thread") {
    const auth = await requireClaimsStrict(request, env, ["mail:read"]);

    const threadId = requireString(args.threadId, "threadId");
    const thread = await getThread(env, threadId);
    if (!thread) {
      throw new McpToolError("resource_thread_not_found", "Thread not found");
    }
    const tenantError = enforceTenantAccess(auth, thread.tenantId);
    if (tenantError) {
      await throwIfResponseError(tenantError);
    }
    const mailboxError = enforceMailboxAccess(auth, thread.mailboxId);
    if (mailboxError) {
      await throwIfResponseError(mailboxError);
    }
    await validateCurrentMailboxAccessForClaims(env, auth, thread.mailboxId);
    const visibleThread = await filterVisibleThreadForClaims(env, auth, thread);
    if (!visibleThread) {
      throw new McpToolError("resource_thread_not_found", "Thread not found");
    }
    return visibleThread;
  }

  if (toolName === "send_email") {
    const auth = await requireClaimsStrict(request, env, ["draft:create", "draft:send"]);
    const mailbox = await resolveMailboxForClaims(env, auth, optionalString(args.mailboxId), { requireActive: true });
    const agentId = await requireSelfAgentForMailbox(env, auth, mailbox.id);
    const to = requireStringArray(args.to, "to");
    const subject = requireString(args.subject, "subject");
    const text = optionalString(args.text) ?? "";
    const html = optionalString(args.html) ?? "";

    if (!text && !html) {
      throw new McpToolError("invalid_arguments", "text or html is required");
    }

    return await createAndSendDraftForMcp(env, {
      tenantId: mailbox.tenant_id,
      agentId,
      mailboxId: mailbox.id,
      payload: {
        from: mailbox.address,
        to,
        cc: optionalStringArray(args.cc) ?? [],
        bcc: optionalStringArray(args.bcc) ?? [],
        subject,
        text,
        html,
        inReplyTo: optionalString(args.inReplyTo),
        references: optionalStringArray(args.references) ?? [],
        attachments: [],
      },
      createdVia: "mcp:send_email",
      idempotencyKey: optionalIdempotencyKey(args.idempotencyKey),
      requestFingerprint: JSON.stringify({
        tool: "send_email",
        mailboxId: mailbox.id,
        to,
        cc: optionalStringArray(args.cc) ?? [],
        bcc: optionalStringArray(args.bcc) ?? [],
        subject,
        text,
        html,
        inReplyTo: optionalString(args.inReplyTo) ?? null,
        references: optionalStringArray(args.references) ?? [],
      }),
    });
  }

  if (toolName === "reply_to_message") {
    const auth = await requireClaimsStrict(request, env, ["mail:read", "draft:create", "draft:send"]);
    const messageId = requireString(args.messageId, "messageId");
    const text = optionalString(args.text) ?? "";
    const html = optionalString(args.html) ?? "";

    if (!text && !html) {
      throw new McpToolError("invalid_arguments", "text or html is required");
    }

    const message = await getMessage(env, messageId);
    if (!message) {
      throw new McpToolError("resource_message_not_found", "Message not found");
    }
    if (message.direction !== "inbound") {
      throw new McpToolError("invalid_arguments", "reply_to_message only supports inbound messages");
    }

    const tenantError = enforceTenantAccess(auth, message.tenantId);
    if (tenantError) {
      await throwIfResponseError(tenantError);
    }
    const mailboxError = enforceMailboxAccess(auth, message.mailboxId);
    if (mailboxError) {
      await throwIfResponseError(mailboxError);
    }
    const agentId = await requireSelfAgentForMailbox(env, auth, message.mailboxId);
    await enforceMailboxScopedMessageVisibility(env, auth, message.id);

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
      throw new McpToolError("resource_mailbox_not_found", "Mailbox not found");
    }

    const replySubject = message.subject && message.subject.toLowerCase().startsWith("re:")
      ? message.subject
      : `Re: ${message.subject ?? ""}`.trim();
    const replyFrom = replyMailbox.address;

    const result = await createAndSendDraftForMcp(env, {
      tenantId: message.tenantId,
      agentId,
      mailboxId: message.mailboxId,
      threadId: message.threadId,
      sourceMessageId: message.id,
      payload: {
        from: replyFrom,
        to: [message.fromAddr],
        cc: [],
        bcc: [],
        subject: replySubject || "Re:",
        text,
        html,
        inReplyTo: message.internetMessageId,
        references,
        attachments: [],
      },
      createdVia: "mcp:reply_to_message",
      idempotencyKey: optionalIdempotencyKey(args.idempotencyKey),
      requestFingerprint: JSON.stringify({
        tool: "reply_to_message",
        messageId,
        text,
        html,
      }),
    });

    return {
      ...result,
      sourceMessageId: message.id,
      threadId: message.threadId,
    };
  }

  if (toolName === "create_draft") {
    const auth = await requireClaimsStrict(request, env, ["draft:create"]);

    const mailbox = await resolveMailboxForClaims(env, auth, optionalString(args.mailboxId), { requireActive: true });
    const requestedAgentId = optionalString(args.agentId);
    const agentId = requestedAgentId ?? await requireSelfAgentForMailbox(env, auth, mailbox.id);
    const tenantId = optionalString(args.tenantId) ?? mailbox.tenant_id;
    const mailboxId = mailbox.id;
    const from = optionalString(args.from) ?? mailbox.address;
    const to = requireStringArray(args.to, "to");
    const subject = requireString(args.subject, "subject");
    const tenantError = enforceTenantAccess(auth, tenantId);
    if (tenantError) {
      await throwIfResponseError(tenantError);
    }
    const agentError = enforceScopedAgentAccess(auth, agentId);
    if (agentError) {
      await throwIfResponseError(agentError);
    }
    const mailboxError = enforceMailboxAccess(auth, mailboxId);
    if (mailboxError) {
      await throwIfResponseError(mailboxError);
    }
    await validateActiveAgentMailboxAccess(env, {
      tenantId,
      agentId,
      mailboxId,
    });
    await validateBindingResources(env, tenantId, agentId, mailboxId);
    await validateDraftFromAddress(env, {
      tenantId,
      mailboxId,
      from,
    });
    await validateDraftReferences(env, {
      tenantId,
      mailboxId,
      threadId: optionalString(args.threadId),
      sourceMessageId: optionalString(args.sourceMessageId),
    });
    await enforceMailboxScopedDraftReferenceVisibility(env, auth, {
      threadId: optionalString(args.threadId),
      sourceMessageId: optionalString(args.sourceMessageId),
    });

    return await createDraft(env, {
      tenantId,
      agentId,
      mailboxId,
      threadId: optionalString(args.threadId),
      sourceMessageId: optionalString(args.sourceMessageId),
      createdVia: "mcp:create_draft",
      payload: {
        from,
        to,
        cc: optionalStringArray(args.cc) ?? [],
        bcc: optionalStringArray(args.bcc) ?? [],
        subject,
        text: optionalString(args.text) ?? "",
        html: optionalString(args.html) ?? "",
        inReplyTo: optionalString(args.inReplyTo),
        references: optionalStringArray(args.references) ?? [],
        attachments: [],
      },
    });
  }

  if (toolName === "get_draft") {
    const auth = await requireClaimsStrict(request, env, ["draft:read"]);

    const draftId = requireString(args.draftId, "draftId");
    const draft = await getDraft(env, draftId);
    if (!draft) {
      throw new McpToolError("resource_draft_not_found", "Draft not found");
    }
    const tenantError = enforceTenantAccess(auth, draft.tenantId);
    if (tenantError) {
      await throwIfResponseError(tenantError);
    }
    const agentError = enforceScopedAgentAccess(auth, draft.agentId);
    if (agentError) {
      await throwIfResponseError(agentError);
    }
    const mailboxError = enforceMailboxAccess(auth, draft.mailboxId);
    if (mailboxError) {
      await throwIfResponseError(mailboxError);
    }
    await validateActiveAgentMailboxAccess(env, {
      tenantId: draft.tenantId,
      agentId: draft.agentId,
      mailboxId: draft.mailboxId,
    });
    return await sanitizeDraftReferencesForClaims(env, auth, draft);
  }

  if (toolName === "send_draft") {
    const auth = await requireClaimsStrict(request, env, ["draft:send"]);

    const draftId = requireString(args.draftId, "draftId");
    const draft = await getDraft(env, draftId);
    if (!draft) {
      throw new McpToolError("resource_draft_not_found", "Draft not found");
    }
    const tenantError = enforceTenantAccess(auth, draft.tenantId);
    if (tenantError) {
      await throwIfResponseError(tenantError);
    }
    const agentError = enforceScopedAgentAccess(auth, draft.agentId);
    if (agentError) {
      await throwIfResponseError(agentError);
    }
    const mailboxError = enforceMailboxAccess(auth, draft.mailboxId);
    if (mailboxError) {
      await throwIfResponseError(mailboxError);
    }
    await validateActiveAgentMailboxAccess(env, {
      tenantId: draft.tenantId,
      agentId: draft.agentId,
      mailboxId: draft.mailboxId,
    });

    const idempotencyKey = optionalIdempotencyKey(args.idempotencyKey);
    const validateReplayableDraftSend = async () => {
      await validateDraftReferences(env, {
        tenantId: draft.tenantId,
        mailboxId: draft.mailboxId,
        threadId: draft.threadId ?? undefined,
        sourceMessageId: draft.sourceMessageId ?? undefined,
      });
      await validateStoredDraftFromAddress(env, draft);
      await validateStoredDraftAttachments(env, draft);
      await enforceMailboxScopedDraftReferenceVisibility(env, auth, {
        threadId: draft.threadId ?? undefined,
        sourceMessageId: draft.sourceMessageId ?? undefined,
      });
      await validateActiveDraftMailbox(env, {
        tenantId: draft.tenantId,
        mailboxId: draft.mailboxId,
      });
      await validateBindingResources(env, draft.tenantId, draft.agentId, draft.mailboxId, [...SEND_CAPABLE_MAILBOX_ROLES]);
      await validateDraftOutboundPolicy(env, draft);
      await validateDraftOutboundCredits(env, draft);
    };
    if (idempotencyKey) {
      const reservation = await reserveIdempotencyKey(env, {
        operation: "draft_send",
        tenantId: draft.tenantId,
        idempotencyKey,
        requestFingerprint: JSON.stringify({ draftId }),
      });

      if (reservation.status === "conflict") {
        throw new McpToolError("idempotency_conflict", "Idempotency key is already used for a different draft send request");
      }
      if (reservation.status === "pending") {
        if (reservation.record.resourceId) {
          await validateReplayableDraftSend();
          const response = await restoreEnqueuedDraftSend(env, {
            draftId,
            outboundJobId: reservation.record.resourceId,
          });
          await bestEffortCompleteRecoveredIdempotency(env, {
            operation: "draft_send",
            tenantId: draft.tenantId,
            idempotencyKey,
            resourceId: response.outboundJobId,
            response,
          });
          return buildQueuedSendDraftToolResult(response);
        }
        throw new McpToolError("idempotency_in_progress", "A draft send request with this idempotency key is already in progress");
      }
      if (reservation.status === "completed") {
        await validateReplayableDraftSend();
        return buildQueuedSendDraftToolResult(
          reservation.record.response as {
            draftId: string;
            outboundJobId: string;
            status: "queued";
          } ?? await restoreEnqueuedDraftSend(env, {
            draftId,
            outboundJobId: reservation.record.resourceId,
          })
        );
      }

      if (draft.status !== "draft" && draft.status !== "approved") {
        await releaseIdempotencyKey(env, "draft_send", draft.tenantId, idempotencyKey);
        throw new McpToolError("invalid_arguments", `Draft status ${draft.status} cannot be sent again`);
      }

      let sendEnqueued = false;
      try {
        await validateReplayableDraftSend();
        const result = await enqueueDraftSend(env, draftId);
        const response = {
          draftId,
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
        return buildQueuedSendDraftToolResult(response);
      } catch (error) {
        if (!sendEnqueued) {
          await releaseIdempotencyKey(env, "draft_send", draft.tenantId, idempotencyKey);
        }
        throw sendEnqueued ? markSideEffectCommitted(error) : error;
      }
    }

    if (draft.status !== "draft" && draft.status !== "approved") {
      throw new McpToolError("invalid_arguments", `Draft status ${draft.status} cannot be sent again`);
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
    await validateBindingResources(env, draft.tenantId, draft.agentId, draft.mailboxId, [...SEND_CAPABLE_MAILBOX_ROLES]);
    await validateDraftOutboundPolicy(env, draft);
    await validateDraftOutboundCredits(env, draft);

    const result = await enqueueDraftSend(env, draftId);
    return buildQueuedSendDraftToolResult({
      draftId,
      outboundJobId: result.outboundJobId,
      status: result.status,
    });
  }

  if (toolName === "cancel_draft") {
    const auth = await requireClaimsStrict(request, env, ["draft:create"]);

    const draftId = requireString(args.draftId, "draftId");
    const draft = await getDraft(env, draftId);
    if (!draft) {
      throw new McpToolError("resource_draft_not_found", "Draft not found");
    }
    const tenantError = enforceTenantAccess(auth, draft.tenantId);
    if (tenantError) {
      await throwIfResponseError(tenantError);
    }
    const agentError = enforceScopedAgentAccess(auth, draft.agentId);
    if (agentError) {
      await throwIfResponseError(agentError);
    }
    const mailboxError = enforceMailboxAccess(auth, draft.mailboxId);
    if (mailboxError) {
      await throwIfResponseError(mailboxError);
    }
    await validateActiveAgentMailboxAccess(env, {
      tenantId: draft.tenantId,
      agentId: draft.agentId,
      mailboxId: draft.mailboxId,
    });

    if (draft.status === "queued" || draft.status === "sent") {
      throw new McpToolError("invalid_arguments", `Draft status ${draft.status} cannot be cancelled`);
    }

    if (draft.status !== "cancelled") {
      await markDraftStatus(env, draft.id, "cancelled");
    }

    return {
      ok: true,
      id: draft.id,
      status: "cancelled",
    };
  }

  if (toolName === "replay_message") {
    const auth = await requireClaimsStrict(request, env, ["mail:replay"]);

    const messageId = requireString(args.messageId, "messageId");
    const mode = requireString(args.mode, "mode");
    if (mode !== "normalize" && mode !== "rerun_agent") {
      throw new McpToolError("invalid_arguments", "mode must be normalize or rerun_agent");
    }
    const message = await getMessage(env, messageId);
    if (!message) {
      throw new McpToolError("resource_message_not_found", "Message not found");
    }
    const tenantError = enforceTenantAccess(auth, message.tenantId);
    if (tenantError) {
      await throwIfResponseError(tenantError);
    }
    const mailboxError = enforceMailboxAccess(auth, message.mailboxId);
    if (mailboxError) {
      await throwIfResponseError(mailboxError);
    }
    await validateCurrentMailboxAccessForClaims(env, auth, message.mailboxId);
    await enforceMailboxScopedMessageVisibility(env, auth, message.id);

    const agentId = optionalString(args.agentId);
    const idempotencyKey = optionalIdempotencyKey(args.idempotencyKey);
    const resolveReplayExecution = async () => {
      if (mode === "normalize") {
        if (!message.rawR2Key) {
          throw new McpToolError("invalid_arguments", "normalize replay requires the message to have raw email content");
        }
        if (!(await env.R2_EMAIL.get(message.rawR2Key))) {
          throw new McpToolError("resource_not_found", "Raw email content not found");
        }

        return {
          replayRawR2Key: message.rawR2Key,
          replayAgentTarget: undefined,
        };
      }

      return {
        replayRawR2Key: undefined,
        replayAgentTarget: await resolveReplayAgentTarget(env, auth, message.mailboxId, agentId),
      };
    };
    const response = {
      messageId,
      mode,
      status: "accepted" as const,
    };

    if (idempotencyKey) {
      const reservation = await reserveIdempotencyKey(env, {
        operation: "message_replay",
        tenantId: message.tenantId,
        idempotencyKey,
        requestFingerprint: JSON.stringify({
          messageId,
          mode,
          agentId: agentId ?? null,
        }),
      });

      if (reservation.status === "conflict") {
        throw new McpToolError("idempotency_conflict", "Idempotency key is already used for a different replay request");
      }
      if (reservation.status === "pending") {
        if (reservation.record.resourceId) {
          await resolveReplayExecution();
          await bestEffortCompleteRecoveredIdempotency(env, {
            operation: "message_replay",
            tenantId: message.tenantId,
            idempotencyKey,
            resourceId: messageId,
            response,
          });
          return response;
        }
        throw new McpToolError("idempotency_in_progress", "A replay request with this idempotency key is already in progress");
      }
      if (reservation.status === "completed") {
        await resolveReplayExecution();
        return reservation.record.response ?? response;
      }

      let replayQueued = false;
      try {
        const { replayRawR2Key, replayAgentTarget } = await resolveReplayExecution();
        if (mode === "normalize") {
          if (!replayRawR2Key) {
            throw new McpToolError("invalid_arguments", "normalize replay requires the message to have raw email content");
          }
          await env.EMAIL_INGEST_QUEUE.send({
            messageId,
            tenantId: message.tenantId,
            mailboxId: message.mailboxId,
            rawR2Key: replayRawR2Key,
          });
          replayQueued = true;
        } else {
          if (!replayAgentTarget) {
            throw new McpToolError("invalid_arguments", "agentId is required for rerun_agent replay");
          }
          await enqueueReplayTask(env, {
            tenantId: message.tenantId,
            mailboxId: message.mailboxId,
            sourceMessageId: messageId,
            agentId: replayAgentTarget.agentId,
            agentVersionId: replayAgentTarget.agentVersionId,
            deploymentId: replayAgentTarget.deploymentId,
          });
          replayQueued = true;
        }
        await updateIdempotencyKeyResource(env, {
          operation: "message_replay",
          tenantId: message.tenantId,
          idempotencyKey,
          resourceId: messageId,
        });
        await completeIdempotencyKey(env, {
          operation: "message_replay",
          tenantId: message.tenantId,
          idempotencyKey,
          resourceId: messageId,
          response,
        });
        return response;
      } catch (error) {
        if (!replayQueued) {
          await releaseIdempotencyKey(env, "message_replay", message.tenantId, idempotencyKey);
        }
        throw replayQueued ? markSideEffectCommitted(error) : error;
      }
    }

    const { replayRawR2Key, replayAgentTarget } = await resolveReplayExecution();
    if (mode === "normalize") {
      if (!replayRawR2Key) {
        throw new McpToolError("invalid_arguments", "normalize replay requires the message to have raw email content");
      }
      await env.EMAIL_INGEST_QUEUE.send({
        messageId,
        tenantId: message.tenantId,
        mailboxId: message.mailboxId,
        rawR2Key: replayRawR2Key,
      });
    } else {
      if (!replayAgentTarget) {
        throw new McpToolError("invalid_arguments", "agentId is required for rerun_agent replay");
      }
      await enqueueReplayTask(env, {
        tenantId: message.tenantId,
        mailboxId: message.mailboxId,
        sourceMessageId: messageId,
        agentId: replayAgentTarget.agentId,
        agentVersionId: replayAgentTarget.agentVersionId,
        deploymentId: replayAgentTarget.deploymentId,
      });
    }

    return response;
  }

  throw new Error(`Unsupported tool: ${toolName}`);
}

async function resolveReplayAgentTarget(
  env: Env,
  claims: AccessTokenClaims,
  mailboxId: string,
  requestedAgentId: string | undefined,
): Promise<{ agentId: string; agentVersionId?: string; deploymentId?: string }> {
  const agentId = requestedAgentId?.trim();
  if (agentId) {
    const agentError = enforceScopedAgentAccess(claims, agentId);
    if (agentError) {
      await throwIfResponseError(agentError);
    }
    const agent = await getAgent(env, agentId);
    if (!agent) {
      throw new McpToolError("resource_agent_not_found", "Agent not found");
    }
    const tenantError = enforceTenantAccess(claims, agent.tenantId);
    if (tenantError) {
      await throwIfResponseError(tenantError);
    }

    const target = await resolveAgentExecutionTarget(env, mailboxId, agentId, [...RECEIVE_CAPABLE_MAILBOX_ROLES]);
    if (!target?.agentId) {
      throw new McpToolError("invalid_arguments", "agentId must be active for the mailbox");
    }

    return target;
  }

  const target = await resolveAgentExecutionTarget(env, mailboxId, undefined, [...RECEIVE_CAPABLE_MAILBOX_ROLES]);
  if (!target?.agentId) {
    throw new McpToolError("invalid_arguments", "agentId is required when the mailbox has no active agent deployment");
  }

  const agentError = enforceScopedAgentAccess(claims, target.agentId);
  if (agentError) {
    await throwIfResponseError(agentError);
  }
  const agent = await getAgent(env, target.agentId);
  if (!agent) {
    throw new McpToolError("resource_agent_not_found", "Agent not found");
  }
  const tenantError = enforceTenantAccess(claims, agent.tenantId);
  if (tenantError) {
    await throwIfResponseError(tenantError);
  }

  return target;
}

router.on("POST", "/mcp", async (request, env) => {
  return await handleMcpTransportPost(request, {
    allowMethods: MCP_ALLOW_METHODS,
    allowHeaders: MCP_ALLOW_HEADERS,
  }, async (rpc) => {
    if (rpc.method === "notifications/initialized") {
      return null;
    }
    if (rpc.method === "initialize") {
      const runtime = buildRuntimeMetadata(request, env);
      return jsonRpcResult(rpc.id ?? null, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: RUNTIME_SERVER_INFO,
        capabilities: {
          tools: {},
        },
        meta: runtime,
      });
    }

    if (rpc.method === "tools/list") {
      const auth = await requireAuth(request, env, []);
      if (auth instanceof Response) {
        const authPayload = await auth.clone().json().catch(() => ({ error: "Unauthorized" }));
        return jsonRpcError(rpc.id ?? null, -32001, "Unauthorized", {
          errorCode: "auth_unauthorized",
          details: authPayload,
        });
      }

      return jsonRpcResult(rpc.id ?? null, {
        tools: filterToolsForClaims(auth).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: {
            riskLevel: RUNTIME_TOOL_CATALOG.find((item) => item.name === tool.name)?.riskLevel ?? "read",
            sideEffecting: RUNTIME_TOOL_CATALOG.find((item) => item.name === tool.name)?.sideEffecting ?? false,
            humanReviewRequired: RUNTIME_TOOL_CATALOG.find((item) => item.name === tool.name)?.humanReviewRequired ?? false,
            composite: Boolean(RUNTIME_TOOL_CATALOG.find((item) => item.name === tool.name)?.composite),
            supportsPartialAuthorization: Boolean(RUNTIME_TOOL_CATALOG.find((item) => item.name === tool.name)?.supportsPartialAuthorization),
            sendAdditionalScopes: RUNTIME_TOOL_CATALOG.find((item) => item.name === tool.name)?.sendAdditionalScopes ?? [],
            category: RUNTIME_TOOL_CATALOG.find((item) => item.name === tool.name)?.category ?? "mail_read",
            recommendedForMailboxAgents: Boolean(
              RUNTIME_TOOL_CATALOG.find((item) => item.name === tool.name)?.recommendedForMailboxAgents
            ),
          },
        })),
      });
    }

    if (rpc.method === "tools/call") {
      const params: Record<string, unknown> | Error = (() => {
        try {
          return asObject(rpc.params);
        } catch (error) {
          return error instanceof Error ? error : new Error("Invalid params");
        }
      })();

      if (params instanceof Error) {
        return jsonRpcError(rpc.id ?? null, -32602, params.message);
      }

      const toolName = params.name;
      if (toolName === undefined) {
        return jsonRpcError(rpc.id ?? null, -32602, "Missing required parameter: name");
      }
      if (typeof toolName !== "string" || !toolName.trim()) {
        return jsonRpcError(rpc.id ?? null, -32602, "name must be a non-empty string");
      }
      if (!getToolByName(toolName)) {
        return jsonRpcError(rpc.id ?? null, -32602, "Unknown tool");
      }

      try {
        const result = await callTool(request, env, toolName, asObject(params.arguments ?? {}));
        return jsonRpcResult(rpc.id ?? null, toToolContent(result));
      } catch (error) {
        if (error instanceof McpToolError) {
          return jsonRpcResult(rpc.id ?? null, {
            isError: true,
            ...toToolContent(toolErrorPayload(error.errorCode, error.message, error.data)),
          });
        }
        if (hasCommittedSideEffect(error)) {
          return jsonRpcResult(rpc.id ?? null, {
            isError: true,
            ...toToolContent(toolErrorPayload(
              "conflict",
              "Request may have partially succeeded after creating server-side state. Retry only with the same idempotency key or inspect draft/outbound state before retrying."
            )),
          });
        }

        return jsonRpcResult(rpc.id ?? null, {
          isError: true,
          ...toToolContent(toolErrorPayload(
            "tool_internal_error",
            error instanceof Error ? error.message : "Tool call failed"
          )),
        });
      }
    }

    return jsonRpcError(rpc.id ?? null, -32601, "Method not found");
  });
});

router.on("GET", "/mcp", async (request) => handleMcpTransportGet(request, {
  allowMethods: MCP_ALLOW_METHODS,
  allowHeaders: MCP_ALLOW_HEADERS,
}));

router.on("OPTIONS", "/mcp", async (request) => handleMcpTransportOptions(request, {
  allowMethods: MCP_ALLOW_METHODS,
  allowHeaders: MCP_ALLOW_HEADERS,
}));

export async function handleMcpRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  return await router.handle(request, env, ctx);
}
