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

export interface PublicSignupRequest {
  productName: string;
  operatorEmail: string;
  mailboxAlias?: string;
  useCase?: string;
  requestedLocalPart?: string;
}

export interface PublicTokenReissueRequest {
  mailboxAlias?: string;
  mailboxAddress?: string;
}

export interface RotateAccessTokenRequest {
  delivery?: "inline" | "self_mailbox" | "both";
  mailboxId?: string;
}

export interface BootstrapMailboxAgentResult {
  signup: unknown;
  client: MailagentsAgentClient;
}

export interface ListMessagesRequest {
  mailboxId?: string;
  limit?: number;
  search?: string;
  direction?: "inbound" | "outbound";
  status?: "received" | "normalized" | "tasked" | "replied" | "ignored" | "failed";
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

  async getRuntimeMetadata(options?: MailagentsRequestOptions): Promise<unknown> {
    return this.requestJson("/v2/meta/runtime", undefined, options);
  }

  async getCompatibilityContract(options?: MailagentsRequestOptions): Promise<unknown> {
    return this.requestJson("/v2/meta/compatibility", undefined, options);
  }

  async getCompatibilitySchema(options?: MailagentsRequestOptions): Promise<unknown> {
    return this.requestJson("/v2/meta/compatibility/schema", undefined, options);
  }

  async publicSignup(input: PublicSignupRequest, options?: MailagentsRequestOptions): Promise<unknown> {
    return this.requestJson("/public/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }, options);
  }

  async reissueAccessToken(input: PublicTokenReissueRequest, options?: MailagentsRequestOptions): Promise<unknown> {
    return this.requestJson("/public/token/reissue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }, options);
  }

  async rotateAccessToken(input: RotateAccessTokenRequest = {}, options?: MailagentsRequestOptions): Promise<unknown> {
    return this.requestJson("/v1/auth/token/rotate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(input),
    }, options);
  }

  async listTools(options?: MailagentsRequestOptions): Promise<{ tools: McpToolDefinition[] }> {
    const payload = await this.callMcp("tools/list", {}, options);
    return payload.result;
  }

  async callTool(name: string, args: Record<string, unknown>, options?: MailagentsRequestOptions): Promise<unknown> {
    const payload = await this.callMcp("tools/call", {
      name,
      arguments: args,
    }, options);

    if (payload.result && typeof payload.result === "object" && "isError" in payload.result && payload.result.isError) {
      throw new MailagentsClientError(
        payload.result.structuredContent?.error?.message ?? "MCP tool call failed",
        { errorCode: getStructuredToolErrorCode(payload) }
      );
    }

    return payload.result;
  }

  async createDraft(args: {
    agentId: string;
    tenantId: string;
    mailboxId: string;
    from: string;
    to: string[];
    subject: string;
    text: string;
  }, options?: MailagentsRequestOptions): Promise<unknown> {
    return this.callTool("create_draft", args, options);
  }

  async sendDraft(draftId: string, idempotencyKey: string, options?: MailagentsRequestOptions): Promise<unknown> {
    return this.callTool("send_draft", { draftId, idempotencyKey }, options);
  }

  async listMessages(args: ListMessagesRequest = {}, options?: MailagentsRequestOptions): Promise<unknown> {
    return this.callTool("list_messages", args, options);
  }

  async getLatestInboundMessage(
    args: Omit<ListMessagesRequest, "direction" | "limit"> = {},
    options?: MailagentsRequestOptions
  ): Promise<unknown> {
    const messages = await this.listMessages({
      ...args,
      limit: 1,
      direction: "inbound",
    }, options) as { items?: Array<unknown> };
    return messages.items?.[0] ?? null;
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
  }, options?: MailagentsRequestOptions): Promise<unknown> {
    return this.callTool("send_email", args, options);
  }

  async replyToMessage(args: {
    messageId: string;
    text?: string;
    html?: string;
    idempotencyKey?: string;
  }, options?: MailagentsRequestOptions): Promise<unknown> {
    return this.callTool("reply_to_message", args, options);
  }

  async replyToInboundEmail(args: {
    agentId: string;
    messageId: string;
    replyText: string;
    send?: boolean;
    idempotencyKey?: string;
  }, options?: MailagentsRequestOptions): Promise<unknown> {
    return this.callTool("reply_to_inbound_email", args, options);
  }

  async listRecommendedMailboxTools(options?: MailagentsRequestOptions): Promise<McpToolDefinition[]> {
    const result = await this.listTools(options);
    return result.tools.filter((tool) => tool.annotations.recommendedForMailboxAgents);
  }

  async getMailboxWorkflowSurface(options?: MailagentsRequestOptions): Promise<{
    recommended: McpToolDefinition[];
    reads: McpToolDefinition[];
    sends: McpToolDefinition[];
    replies: McpToolDefinition[];
  }> {
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
  }, options?: MailagentsRequestOptions): Promise<unknown> {
    const latest = await this.getLatestInboundMessage({}, options) as { id?: string } | null;
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
    const accessToken = (signup as { accessToken?: string }).accessToken;
    if (!accessToken) {
      throw new MailagentsClientError("Signup completed without returning an access token");
    }

    return {
      signup,
      client: unauthenticated.withToken(accessToken),
    };
  }

  private async requestJson(path: string, init?: RequestInit, options?: MailagentsRequestOptions): Promise<unknown> {
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
    return payload.json;
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

export async function exampleUsage() {
  const client = new MailagentsAgentClient({
    baseUrl: "https://mailagents-dev.izhenghaocn.workers.dev",
    token: "REPLACE_WITH_TOKEN",
  });

  await client.getCompatibilityContract();
  await client.listTools();
}
