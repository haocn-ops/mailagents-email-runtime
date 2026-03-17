import {
  enforceAgentAccess,
  enforceMailboxAccess,
  enforceTenantAccess,
  requireAuth,
} from "../lib/auth";
import { accepted, badRequest, json } from "../lib/http";
import { createId } from "../lib/ids";
import { Router } from "../lib/router";
import {
  completeIdempotencyKey,
  createDraft,
  enqueueDraftSend,
  getDraft,
  getMessage,
  getMessageContent,
  getThread,
  listTasks,
  releaseIdempotencyKey,
  reserveIdempotencyKey,
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
    name: "list_agent_tasks",
    description: "Fetch current tasks for an agent.",
    requiredScopes: ["task:read"],
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
    name: "get_message",
    description: "Fetch message metadata.",
    requiredScopes: ["mail:read"],
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
    name: "get_message_content",
    description: "Fetch normalized message content and attachment metadata.",
    requiredScopes: ["mail:read"],
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
    name: "get_thread",
    description: "Fetch thread context for reply generation.",
    requiredScopes: ["mail:read"],
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
    name: "create_draft",
    description: "Create a proposed outbound email draft.",
    requiredScopes: ["draft:create"],
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
    name: "get_draft",
    description: "Inspect draft metadata before send.",
    requiredScopes: ["draft:read"],
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
    name: "send_draft",
    description: "Enqueue a draft for outbound delivery.",
    requiredScopes: ["draft:send"],
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
    name: "replay_message",
    description: "Replay message normalization or rerun agent execution.",
    requiredScopes: ["mail:replay"],
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

async function callTool(request: Request, env: Env, toolName: string, args: Record<string, unknown>): Promise<unknown> {
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
          await env.EMAIL_INGEST_QUEUE.send({
            messageId,
            tenantId: message.tenantId,
            mailboxId: message.mailboxId,
            rawR2Key: message.rawR2Key ?? `raw/replay/${messageId}.eml`,
          });
        } else {
          await env.AGENT_EXECUTE_QUEUE.send({
            taskId: createId("tsk"),
            agentId: agentId ?? "agt_demo",
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
      await env.EMAIL_INGEST_QUEUE.send({
        messageId,
        tenantId: message.tenantId,
        mailboxId: message.mailboxId,
        rawR2Key: message.rawR2Key ?? `raw/replay/${messageId}.eml`,
      });
    } else {
      await env.AGENT_EXECUTE_QUEUE.send({
        taskId: createId("tsk"),
        agentId: agentId ?? "agt_demo",
      });
    }

    return response;
  }

  throw new Error(`Unsupported tool: ${toolName}`);
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
    return jsonRpcResult(rpc.id ?? null, {
      protocolVersion: "2025-03-26",
      serverInfo: {
        name: "mailagents-runtime",
        version: "0.1.0",
      },
      capabilities: {
        tools: {},
      },
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
