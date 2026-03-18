export class InvalidJsonBodyError extends Error {
  constructor(message = "Invalid JSON body") {
    super(message);
    this.name = "InvalidJsonBodyError";
  }
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
  try {
    return await request.json<T>();
  } catch {
    throw new InvalidJsonBodyError();
  }
}

export async function readOptionalJson<T>(request: Request): Promise<T | undefined> {
  const raw = await request.text();
  if (!raw.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new InvalidJsonBodyError();
  }
}
