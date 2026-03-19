import {
  enforceAgentAccess,
  enforceMailboxAccess,
  enforceTenantAccess,
  requireAuth,
} from "../lib/auth";
import { accepted, badRequest, json } from "../lib/http";
import { createId } from "../lib/ids";
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
  getMailboxById,
  resolveAgentExecutionTarget,
  upsertAgentPolicy,
} from "../repositories/agents";
import {
  completeIdempotencyKey,
  createDraft,
  createTask,
  enqueueDraftSend,
  getDraft,
  getMessage,
  getMessageContent,
  getThread,
  listTasks,
  releaseIdempotencyKey,
  reserveIdempotencyKey,
  updateTaskStatus,
} from "../repositories/mail";
import type { AccessTokenClaims, Env, TaskStatus } from "../types";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

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

function jsonRpcResult(id: JsonRpcId, result: unknown): Response {
  return json({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Response {
  return json({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data,
    },
  }, { status: 400 });
}

function toToolContent(payload: unknown) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

function getToolByName(name: string): ToolDescriptor | undefined {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name);
}

function filterToolsForClaims(claims: AccessTokenClaims): ToolDescriptor[] {
  return TOOL_DEFINITIONS.filter((tool) => tool.requiredScopes.every((scope) => claims.scopes.includes(scope)));
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

async function validateBindingResources(
  env: Env,
  tenantId: string,
  agentId: string,
  mailboxId: string
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
}

async function callTool(request: Request, env: Env, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  if (toolName === "create_agent") {
    const auth = await requireClaimsStrict(request, env, ["agent:create"]);
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
    const agentError = enforceAgentAccess(auth, agentId);
    if (agentError) {
      await throwIfResponseError(agentError);
    }
    const mailboxError = enforceMailboxAccess(auth, mailboxId);
    if (mailboxError) {
      await throwIfResponseError(mailboxError);
    }
    await validateBindingResources(env, tenantId, agentId, mailboxId);

    return await bindMailbox(env, {
      tenantId,
      agentId,
      mailboxId,
      role,
    });
  }

  if (toolName === "upsert_agent_policy") {
    const auth = await requireClaimsStrict(request, env, ["agent:update"]);
    const agentId = requireString(args.agentId, "agentId");
    const agentError = enforceAgentAccess(auth, agentId);
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
    const idempotencyKey = optionalString(args.idempotencyKey);
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
    const agentError = enforceAgentAccess(auth, agentId);
    if (agentError) {
      await throwIfResponseError(agentError);
    }

    const thread = message.threadId ? await getThread(env, message.threadId) : null;
    const references = Array.from(new Set(
      (thread?.messages ?? [])
        .map((item) => item.internetMessageId)
        .filter((item): item is string => Boolean(item))
    ));
    if (message.internetMessageId && !references.includes(message.internetMessageId)) {
      references.push(message.internetMessageId);
    }

    const replySubject = message.subject && message.subject.toLowerCase().startsWith("re:")
      ? message.subject
      : `Re: ${message.subject ?? ""}`.trim();
    const replyFrom = message.toAddr.split(",")[0]?.trim() || "";

    const draftPayload = {
      from: replyFrom,
      to: [message.fromAddr],
      cc: [],
      bcc: [],
      subject: replySubject || "Re:",
      text: replyText ?? "",
      html: replyHtml ?? "",
      inReplyTo: message.internetMessageId,
      references,
      attachments: [],
    };

    if (!send) {
      const draft = await createDraft(env, {
        tenantId: message.tenantId,
        agentId,
        mailboxId: message.mailboxId,
        threadId: message.threadId,
        sourceMessageId: message.id,
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
      resourceId: message.id,
    });

    if (reservation.status === "conflict") {
      throw new McpToolError("idempotency_conflict", "Idempotency key is already used for a different reply workflow request");
    }
    if (reservation.status === "pending") {
      throw new McpToolError("idempotency_in_progress", "A reply workflow request with this idempotency key is already in progress");
    }

    if (reservation.status === "completed") {
      return reservation.record.response ?? {
        sendResult: {
          draftId: reservation.record.resourceId,
          outboundJobId: reservation.record.resourceId,
          status: "queued",
        },
        sourceMessage: message,
        usedThreadContext: Boolean(thread),
      };
    }

    try {
      const draft = await createDraft(env, {
        tenantId: message.tenantId,
        agentId,
        mailboxId: message.mailboxId,
        threadId: message.threadId,
        sourceMessageId: message.id,
        payload: draftPayload,
      });
      const result = await enqueueDraftSend(env, draft.id);
      const response = {
        draft,
        sendResult: {
          draftId: draft.id,
          outboundJobId: result.outboundJobId,
          status: result.status,
        },
        sourceMessage: message,
        usedThreadContext: Boolean(thread),
      };
      await completeIdempotencyKey(env, {
        operation: "draft_send",
        tenantId: message.tenantId,
        idempotencyKey: idempotencyKey!,
        resourceId: draft.id,
        response,
      });
      return response;
    } catch (error) {
      await releaseIdempotencyKey(env, "draft_send", message.tenantId, idempotencyKey!);
      throw error;
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
    const idempotencyKey = optionalString(args.idempotencyKey);

    if (!text && !html) {
      throw new McpToolError("invalid_arguments", "text or html is required");
    }

    const tenantError = enforceTenantAccess(auth, tenantId);
    if (tenantError) {
      await throwIfResponseError(tenantError);
    }
    const agentError = enforceAgentAccess(auth, agentId);
    if (agentError) {
      await throwIfResponseError(agentError);
    }
    const mailboxError = enforceMailboxAccess(auth, mailboxId);
    if (mailboxError) {
      await throwIfResponseError(mailboxError);
    }
    await validateBindingResources(env, tenantId, agentId, mailboxId);

    if (send) {
      const sendAuth = await requireClaims(request, env, ["draft:send"]);
      if (sendAuth instanceof Response) {
        await throwIfResponseError(sendAuth);
      }
      if (!idempotencyKey) {
        throw new McpToolError("invalid_arguments", "idempotencyKey is required when send is true");
      }
    }

    const draftPayload = {
      from,
      to,
      cc,
      bcc,
      subject,
      text,
      html,
      inReplyTo: optionalString(args.inReplyTo),
      references: optionalStringArray(args.references) ?? [],
      attachments: [],
    };

    if (!send) {
      const draft = await createDraft(env, {
        tenantId,
        agentId,
        mailboxId,
        threadId: optionalString(args.threadId),
        sourceMessageId: optionalString(args.sourceMessageId),
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
        inReplyTo: optionalString(args.inReplyTo) ?? null,
        references: optionalStringArray(args.references) ?? [],
        threadId: optionalString(args.threadId) ?? null,
        sourceMessageId: optionalString(args.sourceMessageId) ?? null,
        send: true,
      }),
      resourceId: mailboxId,
    });

    if (reservation.status === "conflict") {
      throw new McpToolError("idempotency_conflict", "Idempotency key is already used for a different operator send request");
    }
    if (reservation.status === "pending") {
      throw new McpToolError("idempotency_in_progress", "An operator send request with this idempotency key is already in progress");
    }
    if (reservation.status === "completed") {
      return reservation.record.response ?? {
        sendRequested: true,
      };
    }

    try {
      const draft = await createDraft(env, {
        tenantId,
        agentId,
        mailboxId,
        threadId: optionalString(args.threadId),
        sourceMessageId: optionalString(args.sourceMessageId),
        payload: draftPayload,
      });
      const result = await enqueueDraftSend(env, draft.id);
      const response = {
        draft,
        sendRequested: true,
        sendResult: {
          draftId: draft.id,
          outboundJobId: result.outboundJobId,
          status: result.status,
        },
      };
      await completeIdempotencyKey(env, {
        operation: "draft_send",
        tenantId,
        idempotencyKey: idempotencyKey!,
        resourceId: draft.id,
        response,
      });
      return response;
    } catch (error) {
      await releaseIdempotencyKey(env, "draft_send", tenantId, idempotencyKey!);
      throw error;
    }
  }

  if (toolName === "list_agent_tasks") {
    const auth = await requireClaimsStrict(request, env, ["task:read"]);

    const agentId = requireString(args.agentId, "agentId");
    const agentError = enforceAgentAccess(auth, agentId);
    if (agentError) {
      await throwIfResponseError(agentError);
    }
    const status = optionalString(args.status) as TaskStatus | undefined;
    return { items: await listTasks(env, agentId, status) };
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
    return await getMessageContent(env, messageId);
  }

  if (toolName === "get_thread") {
    const auth = await requireClaimsStrict(request, env, ["mail:read"]);

    const threadId = requireString(args.threadId, "threadId");
    const thread = await getThread(env, threadId);
    if (!thread) {
      throw new McpToolError("resource_thread_not_found", "Thread not found");
    }
    const mailboxError = enforceMailboxAccess(auth, thread.mailboxId);
    if (mailboxError) {
      await throwIfResponseError(mailboxError);
    }
    return thread;
  }

  if (toolName === "create_draft") {
    const auth = await requireClaimsStrict(request, env, ["draft:create"]);

    const agentId = requireString(args.agentId, "agentId");
    const tenantId = requireString(args.tenantId, "tenantId");
    const mailboxId = requireString(args.mailboxId, "mailboxId");
    const from = requireString(args.from, "from");
    const to = requireStringArray(args.to, "to");
    const subject = requireString(args.subject, "subject");
    const tenantError = enforceTenantAccess(auth, tenantId);
    if (tenantError) {
      await throwIfResponseError(tenantError);
    }
    const agentError = enforceAgentAccess(auth, agentId);
    if (agentError) {
      await throwIfResponseError(agentError);
    }
    const mailboxError = enforceMailboxAccess(auth, mailboxId);
    if (mailboxError) {
      await throwIfResponseError(mailboxError);
    }

    return await createDraft(env, {
      tenantId,
      agentId,
      mailboxId,
      threadId: optionalString(args.threadId),
      sourceMessageId: optionalString(args.sourceMessageId),
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
    const agentError = enforceAgentAccess(auth, draft.agentId);
    if (agentError) {
      await throwIfResponseError(agentError);
    }
    const mailboxError = enforceMailboxAccess(auth, draft.mailboxId);
    if (mailboxError) {
      await throwIfResponseError(mailboxError);
    }
    return draft;
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
    const agentError = enforceAgentAccess(auth, draft.agentId);
    if (agentError) {
      await throwIfResponseError(agentError);
    }
    const mailboxError = enforceMailboxAccess(auth, draft.mailboxId);
    if (mailboxError) {
      await throwIfResponseError(mailboxError);
    }

    const idempotencyKey = optionalString(args.idempotencyKey);
    if (idempotencyKey) {
      const reservation = await reserveIdempotencyKey(env, {
        operation: "draft_send",
        tenantId: draft.tenantId,
        idempotencyKey,
        requestFingerprint: JSON.stringify({ draftId }),
        resourceId: draftId,
      });

      if (reservation.status === "conflict") {
        throw new McpToolError("idempotency_conflict", "Idempotency key is already used for a different draft send request");
      }
      if (reservation.status === "pending") {
        throw new McpToolError("idempotency_in_progress", "A draft send request with this idempotency key is already in progress");
      }
      if (reservation.status === "completed") {
        return reservation.record.response ?? {
          draftId,
          outboundJobId: reservation.record.resourceId,
          status: "queued",
        };
      }

      if (draft.status !== "draft" && draft.status !== "approved") {
        await releaseIdempotencyKey(env, "draft_send", draft.tenantId, idempotencyKey);
        throw new McpToolError("invalid_arguments", `Draft status ${draft.status} cannot be sent again`);
      }

      try {
        const result = await enqueueDraftSend(env, draftId);
        const response = {
          draftId,
          outboundJobId: result.outboundJobId,
          status: result.status,
        };
        await completeIdempotencyKey(env, {
          operation: "draft_send",
          tenantId: draft.tenantId,
          idempotencyKey,
          resourceId: result.outboundJobId,
          response,
        });
        return response;
      } catch (error) {
        await releaseIdempotencyKey(env, "draft_send", draft.tenantId, idempotencyKey);
        throw error;
      }
    }

    if (draft.status !== "draft" && draft.status !== "approved") {
      throw new McpToolError("invalid_arguments", `Draft status ${draft.status} cannot be sent again`);
    }

    const result = await enqueueDraftSend(env, draftId);
    return {
      draftId,
      outboundJobId: result.outboundJobId,
      status: result.status,
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

    const agentId = optionalString(args.agentId);
    const idempotencyKey = optionalString(args.idempotencyKey);
    if (mode === "normalize" && !message.rawR2Key) {
      throw new McpToolError("invalid_arguments", "normalize replay requires the message to have raw email content");
    }
    const replayRawR2Key = mode === "normalize" ? message.rawR2Key : undefined;
    const replayTarget = mode === "rerun_agent"
      ? await resolveReplayAgentTarget(env, auth, message.mailboxId, agentId)
      : null;
    const replayAgentTarget = replayTarget ?? undefined;
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
        resourceId: messageId,
      });

      if (reservation.status === "conflict") {
        throw new McpToolError("idempotency_conflict", "Idempotency key is already used for a different replay request");
      }
      if (reservation.status === "pending") {
        throw new McpToolError("idempotency_in_progress", "A replay request with this idempotency key is already in progress");
      }
      if (reservation.status === "completed") {
        return reservation.record.response ?? response;
      }

      try {
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
        await completeIdempotencyKey(env, {
          operation: "message_replay",
          tenantId: message.tenantId,
          idempotencyKey,
          resourceId: messageId,
          response,
        });
        return response;
      } catch (error) {
        await releaseIdempotencyKey(env, "message_replay", message.tenantId, idempotencyKey);
        throw error;
      }
    }

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
    const agentError = enforceAgentAccess(claims, agentId);
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

    return await resolveAgentExecutionTarget(env, mailboxId, agentId) ?? { agentId };
  }

  const target = await resolveAgentExecutionTarget(env, mailboxId);
  if (!target?.agentId) {
    throw new McpToolError("invalid_arguments", "agentId is required when the mailbox has no active agent deployment");
  }

  const agentError = enforceAgentAccess(claims, target.agentId);
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

async function enqueueReplayTask(
  env: Env,
  input: {
    tenantId: string;
    mailboxId: string;
    sourceMessageId: string;
    agentId: string;
    agentVersionId?: string;
    deploymentId?: string;
  }
): Promise<void> {
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
    await updateTaskStatus(env, {
      taskId: replayTask.id,
      status: "failed",
    }).catch(() => undefined);
    throw error;
  }
}

router.on("POST", "/mcp", async (request, env) => {
  let rpc: JsonRpcRequest;
  try {
    rpc = await request.json<JsonRpcRequest>();
  } catch {
    return jsonRpcError(null, -32700, "Parse error");
  }

  if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
    return jsonRpcError(rpc.id ?? null, -32600, "Invalid Request");
  }

  if (rpc.method === "notifications/initialized") {
    return accepted({ ok: true });
  }

  if (rpc.method === "initialize") {
    const runtime = buildRuntimeMetadata(env);
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
    if (typeof toolName !== "string" || !getToolByName(toolName)) {
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

export async function handleMcpRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  return await router.handle(request, env, ctx);
}
