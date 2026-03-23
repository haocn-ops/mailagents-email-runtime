import { createId } from "./ids";

export interface ParsedAttachment {
  id: string;
  filename?: string;
  contentType?: string;
  content: Uint8Array;
  transferEncoding?: string;
}

export interface ParsedEmail {
  headers: Record<string, string>;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  from?: string;
  replyTo?: string;
  references: string[];
  text?: string;
  html?: string;
  attachments: ParsedAttachment[];
  snippet?: string;
  threadKey: string;
}

function decodeQuotedPrintableBytes(input: string): Uint8Array {
  const bytes: number[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === "=" && input[index + 1] === "\r" && input[index + 2] === "\n") {
      index += 2;
      continue;
    }

    if (char === "=" && input[index + 1] === "\n") {
      index += 1;
      continue;
    }

    if (char === "=" && /^[A-Fa-f0-9]{2}$/.test(input.slice(index + 1, index + 3))) {
      bytes.push(parseInt(input.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }

    bytes.push(char.charCodeAt(0));
  }

  return Uint8Array.from(bytes);
}

function decodeHeaderEncodedWord(input: string): string {
  const collapsed = input.replace(
    /(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?[^?]+\?[BbQq]\?[^?]*\?=)/g,
    "$1"
  );

  return collapsed.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (match, charset: string, encoding: string, value: string) => {
    try {
      const normalizedCharset = charset.trim().toLowerCase();
      const decoder = new TextDecoder(
        normalizedCharset === "utf8" ? "utf-8" : normalizedCharset,
        { fatal: false, ignoreBOM: false }
      );

      if (encoding.toLowerCase() === "b") {
        const binary = atob(value.replace(/\s+/g, ""));
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return decoder.decode(bytes);
      }

      const qValue = value.replace(/_/g, " ");
      return decoder.decode(decodeQuotedPrintableBytes(qValue));
    } catch {
      return match;
    }
  });
}

function extractCharset(contentType?: string): string | undefined {
  const match = contentType?.match(/charset\s*=\s*("?)([^";\s]+)\1/i);
  return match?.[2];
}

function normalizeCharsetLabel(charset?: string): string | undefined {
  const normalized = charset?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "utf8") {
    return "utf-8";
  }

  if (normalized === "us-ascii") {
    return "utf-8";
  }

  if (normalized === "unknown-8bit") {
    return "utf-8";
  }

  return normalized;
}

function decodeBody(content: string, encoding?: string): Uint8Array {
  const normalized = encoding?.toLowerCase();
  if (normalized === "base64") {
    const binary = atob(content.replace(/\s+/g, ""));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }

  if (normalized === "quoted-printable") {
    return decodeQuotedPrintableBytes(content);
  }

  return new TextEncoder().encode(content);
}

function decodeText(bytes: Uint8Array, contentType?: string): string {
  const charset = normalizeCharsetLabel(extractCharset(contentType));
  if (charset) {
    try {
      return new TextDecoder(charset, { fatal: false, ignoreBOM: false }).decode(bytes);
    } catch {
      // Fall back to UTF-8 if the advertised charset is unsupported.
    }
  }

  return new TextDecoder().decode(bytes);
}

function parseHeadersBlock(rawHeaders: string): Record<string, string> {
  const unfolded = rawHeaders.replace(/\r?\n[ \t]+/g, " ");
  const headers: Record<string, string> = {};

  for (const line of unfolded.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    headers[key] = value;
  }

  return headers;
}

function splitHeaderAndBody(raw: string): { headers: Record<string, string>; body: string } {
  const marker = raw.search(/\r?\n\r?\n/);
  if (marker === -1) {
    return {
      headers: parseHeadersBlock(raw),
      body: "",
    };
  }

  const rawHeaders = raw.slice(0, marker);
  const body = raw.slice(raw.indexOf("\n\n") >= 0 ? raw.indexOf("\n\n") + 2 : marker + 4);
  return {
    headers: parseHeadersBlock(rawHeaders),
    body,
  };
}

function extractBoundary(contentType?: string): string | null {
  const match = contentType?.match(/boundary="?([^";]+)"?/i);
  return match?.[1] ?? null;
}

function extractFilename(contentDisposition?: string, contentType?: string): string | undefined {
  const fromDisposition = contentDisposition?.match(/filename="?([^";]+)"?/i)?.[1];
  if (fromDisposition) {
    return fromDisposition;
  }

  return contentType?.match(/name="?([^";]+)"?/i)?.[1];
}

function normalizeSubject(subject?: string): string {
  return (subject ?? "")
    .replace(/^(re|fwd|fw):\s*/gi, "")
    .trim()
    .toLowerCase();
}

function createSnippet(text?: string, html?: string): string | undefined {
  const source = text ?? html?.replace(/<[^>]+>/g, " ");
  const snippet = source?.replace(/\s+/g, " ").trim();
  return snippet ? snippet.slice(0, 160) : undefined;
}

function extractPrimaryAddress(headerValue?: string): string | undefined {
  if (!headerValue) {
    return undefined;
  }

  const angleMatch = headerValue.match(/<([^<>@\s]+@[^<>@\s]+)>/);
  if (angleMatch) {
    return angleMatch[1].trim().toLowerCase();
  }

  const mailboxMatch = headerValue.match(/\b([^\s<>"(),;:@]+@[^\s<>"(),;:]+)\b/);
  return mailboxMatch?.[1]?.trim().toLowerCase();
}

function parseMultipart(body: string, boundary: string): Array<{ headers: Record<string, string>; body: string }> {
  const delimiter = `--${boundary}`;
  const parts = body
    .split(delimiter)
    .slice(1)
    .map((part) => part.replace(/^\r?\n/, ""))
    .filter((part) => part.length > 0 && !part.startsWith("--"))
    .map((part) => part.replace(/\r?\n$/, ""));

  return parts.map((part) => splitHeaderAndBody(part));
}

function collectContent(
  headers: Record<string, string>,
  body: string,
  output: { text?: string; html?: string; attachments: ParsedAttachment[] }
): void {
  const contentType = headers["content-type"] ?? "text/plain";
  const transferEncoding = headers["content-transfer-encoding"];
  const contentDisposition = headers["content-disposition"];

  if (contentType.toLowerCase().startsWith("multipart/")) {
    const boundary = extractBoundary(contentType);
    if (!boundary) {
      return;
    }

    for (const part of parseMultipart(body, boundary)) {
      collectContent(part.headers, part.body, output);
    }
    return;
  }

  const decoded = decodeBody(body, transferEncoding);
  const decodedText = decodeText(decoded, contentType);
  const filename = extractFilename(contentDisposition, contentType);
  const isAttachment = /attachment/i.test(contentDisposition ?? "") || Boolean(filename);

  if (isAttachment) {
    output.attachments.push({
      id: createId("att"),
      filename,
      contentType,
      content: decoded,
      transferEncoding,
    });
    return;
  }

  if (contentType.toLowerCase().includes("text/html")) {
    output.html = decodedText;
    return;
  }

  output.text = decodedText;
}

export function parseRawEmail(raw: string): ParsedEmail {
  const { headers, body } = splitHeaderAndBody(raw);
  if (headers["subject"]) {
    headers["subject"] = decodeHeaderEncodedWord(headers["subject"]);
  }
  const output: { text?: string; html?: string; attachments: ParsedAttachment[] } = {
    attachments: [],
  };

  collectContent(headers, body, output);

  const references = (headers["references"] ?? "")
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const subject = headers["subject"];
  const messageId = headers["message-id"];
  const inReplyTo = headers["in-reply-to"];
  const replyTo = extractPrimaryAddress(headers["reply-to"]);
  const from = extractPrimaryAddress(headers["from"]);
  const normalizedSubject = normalizeSubject(subject);
  const threadKey = inReplyTo
    ?? references[references.length - 1]
    ?? (normalizedSubject || messageId || createId("thread"));

  return {
    headers,
    subject,
    messageId,
    inReplyTo,
    from,
    replyTo,
    references,
    text: output.text,
    html: output.html,
    attachments: output.attachments,
    snippet: createSnippet(output.text, output.html),
    threadKey,
  };
}
