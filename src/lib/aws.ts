function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toHex(digest);
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key instanceof Uint8Array ? key : new Uint8Array(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
}

async function getSigningKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(new TextEncoder().encode(`AWS4${secretKey}`), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return await hmacSha256(kService, "aws4_request");
}

function iso8601Basic(timestamp: Date): string {
  return timestamp.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function dateStamp(timestamp: Date): string {
  return iso8601Basic(timestamp).slice(0, 8);
}

export async function signAwsRequest(input: {
  method: string;
  url: string;
  service: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  body: string;
  headers?: HeadersInit;
}): Promise<Headers> {
  const timestamp = new Date();
  const amzDate = iso8601Basic(timestamp);
  const shortDate = dateStamp(timestamp);
  const url = new URL(input.url);
  const host = url.host;
  const payloadHash = await sha256Hex(input.body);

  const headers = new Headers(input.headers);
  headers.set("content-type", headers.get("content-type") ?? "application/json");
  headers.set("host", host);
  headers.set("x-amz-content-sha256", payloadHash);
  headers.set("x-amz-date", amzDate);

  const canonicalHeaders = Array.from(headers.entries())
    .map(([key, value]) => [key.toLowerCase().trim(), value.trim()] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${value}\n`)
    .join("");

  const signedHeaders = Array.from(headers.keys())
    .map((key) => key.toLowerCase().trim())
    .sort()
    .join(";");

  const canonicalRequest = [
    input.method.toUpperCase(),
    url.pathname,
    url.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${shortDate}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = await getSigningKey(input.secretAccessKey, shortDate, input.region, input.service);
  const signature = toHex(await hmacSha256(signingKey, stringToSign));

  headers.set(
    "authorization",
    [
      `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}`,
      `SignedHeaders=${signedHeaders}`,
      `Signature=${signature}`,
    ].join(", ")
  );

  return headers;
}
