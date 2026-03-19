export interface MailagentsClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
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

  async getRuntimeMetadata(): Promise<unknown> {
    return this.requestJson("/v2/meta/runtime");
  }

  async getCompatibilityContract(): Promise<unknown> {
    return this.requestJson("/v2/meta/compatibility");
  }

  async getCompatibilitySchema(): Promise<unknown> {
    return this.requestJson("/v2/meta/compatibility/schema");
  }

  async listTools(): Promise<{ tools: McpToolDefinition[] }> {
    const payload = await this.callMcp("tools/list", {});
    return payload.result;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const payload = await this.callMcp("tools/call", {
      name,
      arguments: args,
    });

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
  }): Promise<unknown> {
    return this.callTool("create_draft", args);
  }

  async sendDraft(draftId: string, idempotencyKey: string): Promise<unknown> {
    return this.callTool("send_draft", { draftId, idempotencyKey });
  }

  async listMessages(args: {
    mailboxId?: string;
    limit?: number;
    search?: string;
    direction?: "inbound" | "outbound";
    status?: "received" | "normalized" | "tasked" | "replied" | "ignored" | "failed";
  } = {}): Promise<unknown> {
    return this.callTool("list_messages", args);
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
  }): Promise<unknown> {
    return this.callTool("send_email", args);
  }

  async replyToMessage(args: {
    messageId: string;
    text?: string;
    html?: string;
    idempotencyKey?: string;
  }): Promise<unknown> {
    return this.callTool("reply_to_message", args);
  }

  async replyToInboundEmail(args: {
    agentId: string;
    messageId: string;
    replyText: string;
    send?: boolean;
    idempotencyKey?: string;
  }): Promise<unknown> {
    return this.callTool("reply_to_inbound_email", args);
  }

  async listRecommendedMailboxTools(): Promise<McpToolDefinition[]> {
    const result = await this.listTools();
    return result.tools.filter((tool) => tool.annotations.recommendedForMailboxAgents);
  }

  private async requestJson(path: string): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : undefined,
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new MailagentsClientError(`HTTP request failed: ${response.status}`, {
        status: response.status,
      });
    }
    return payload;
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

export async function exampleUsage() {
  const client = new MailagentsAgentClient({
    baseUrl: "https://mailagents-dev.izhenghaocn.workers.dev",
    token: "REPLACE_WITH_TOKEN",
  });

  await client.getCompatibilityContract();
  await client.listTools();
}
