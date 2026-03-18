export class InvalidJsonBodyError extends Error {
  constructor(message = "Invalid JSON body") {
    super(message);
    this.name = "InvalidJsonBodyError";
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers,
  });
}

export function notFound(message = "Not found"): Response {
  return json({ error: message }, { status: 404 });
}

export function badRequest(message: string): Response {
  return json({ error: message }, { status: 400 });
}

export function accepted(data: unknown): Response {
  return json(data, { status: 202 });
}

export async function readJson<T>(request: Request): Promise<T> {
  let body: unknown;
  try {
    body = await request.json<T>();
  } catch {
    throw new InvalidJsonBodyError();
  }

  if (!isJsonObject(body)) {
    throw new InvalidJsonBodyError("JSON body must be an object");
  }

  return body as T;
}

export async function readOptionalJson<T>(request: Request): Promise<T | undefined> {
  const raw = await request.text();
  if (!raw.trim()) {
    return undefined;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    throw new InvalidJsonBodyError();
  }

  if (!isJsonObject(body)) {
    throw new InvalidJsonBodyError("JSON body must be an object");
  }

  return body as T;
}
