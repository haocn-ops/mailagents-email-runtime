import { json } from "./http";

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponseEnvelope = JsonRpcSuccess | JsonRpcFailure;

export interface McpTransportConfig {
  allowMethods: string;
  allowHeaders: string;
}

function appendVary(headers: Headers, value: string): void {
  const current = headers.get("vary");
  if (!current) {
    headers.set("vary", value);
    return;
  }

  const values = current.split(",").map((item) => item.trim().toLowerCase());
  if (!values.includes(value.toLowerCase())) {
    headers.set("vary", `${current}, ${value}`);
  }
}

function resolveAllowedOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin) {
    return "*";
  }

  return origin === new URL(request.url).origin ? origin : null;
}

function extractJsonRpcId(value: unknown): JsonRpcId {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("id" in value)) {
    return null;
  }

  const id = (value as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" || id === null ? id : null;
}

async function routeJsonRpcMessage(
  message: unknown,
  handler: (rpc: JsonRpcRequest) => Promise<JsonRpcResponseEnvelope | null>,
): Promise<JsonRpcResponseEnvelope | null> {
  if (isJsonRpcResponse(message)) {
    return null;
  }

  if (!isJsonRpcRequest(message) || message.jsonrpc !== "2.0") {
    return jsonRpcError(extractJsonRpcId(message), -32600, "Invalid Request");
  }

  const response = await handler(message);
  return message.id === undefined ? null : response;
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as { method?: unknown }).method === "string";
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponseEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    jsonrpc?: unknown;
    method?: unknown;
    result?: unknown;
    error?: unknown;
  };

  if (candidate.jsonrpc !== "2.0" || typeof candidate.method === "string") {
    return false;
  }

  return "result" in candidate || "error" in candidate;
}

export function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

export function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data,
    },
  };
}

export function jsonRpcResponse(
  payload: JsonRpcResponseEnvelope | JsonRpcResponseEnvelope[],
  init: ResponseInit = {},
): Response {
  return json(payload, init);
}

export function toToolContent(payload: unknown) {
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

export function withMcpTransportHeaders(
  request: Request,
  response: Response,
  config: McpTransportConfig,
): Response {
  const headers = new Headers(response.headers);
  const allowedOrigin = resolveAllowedOrigin(request);
  if (allowedOrigin) {
    headers.set("access-control-allow-origin", allowedOrigin);
  }
  headers.set("access-control-allow-methods", config.allowMethods);
  headers.set("access-control-allow-headers", config.allowHeaders);
  headers.set("access-control-max-age", "86400");
  headers.set("allow", config.allowMethods);
  appendVary(headers, "Accept");
  appendVary(headers, "Origin");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function rejectMcpOrigin(
  request: Request,
  config: McpTransportConfig,
): Response | null {
  if (resolveAllowedOrigin(request) !== null) {
    return null;
  }

  return withMcpTransportHeaders(
    request,
    json({ error: "Origin not allowed" }, { status: 403 }),
    config,
  );
}

export function handleMcpTransportOptions(request: Request, config: McpTransportConfig): Response {
  const originError = rejectMcpOrigin(request, config);
  if (originError) {
    return originError;
  }

  return withMcpTransportHeaders(request, new Response(null, { status: 204 }), config);
}

export function handleMcpTransportGet(request: Request, config: McpTransportConfig): Response {
  const originError = rejectMcpOrigin(request, config);
  if (originError) {
    return originError;
  }

  return withMcpTransportHeaders(request, new Response(null, { status: 405 }), config);
}

export async function handleMcpTransportPost(
  request: Request,
  config: McpTransportConfig,
  handler: (rpc: JsonRpcRequest) => Promise<JsonRpcResponseEnvelope | null>,
): Promise<Response> {
  const originError = rejectMcpOrigin(request, config);
  if (originError) {
    return originError;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return withMcpTransportHeaders(
      request,
      jsonRpcResponse(jsonRpcError(null, -32700, "Parse error"), { status: 400 }),
      config,
    );
  }

  if (Array.isArray(body)) {
    if (!body.length) {
      return withMcpTransportHeaders(
        request,
        jsonRpcResponse(jsonRpcError(null, -32600, "Invalid Request"), { status: 400 }),
        config,
      );
    }

    const responses: JsonRpcResponseEnvelope[] = [];
    for (const message of body) {
      const response = await routeJsonRpcMessage(message, handler);
      if (response) {
        responses.push(response);
      }
    }

    if (!responses.length) {
      return withMcpTransportHeaders(request, new Response(null, { status: 202 }), config);
    }

    return withMcpTransportHeaders(request, jsonRpcResponse(responses), config);
  }

  const response = await routeJsonRpcMessage(body, handler);
  if (!response) {
    return withMcpTransportHeaders(request, new Response(null, { status: 202 }), config);
  }

  const status = "error" in response ? 400 : 200;
  return withMcpTransportHeaders(request, jsonRpcResponse(response, { status }), config);
}
