function randomBoundary(label: string): string {
  return `mailagents-${label}-${crypto.randomUUID().replace(/-/g, "")}`;
}

function normalizeHeaderValue(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

function foldBase64(input: string): string {
  return input.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function textToBase64(value: string): string {
  return toBase64(new TextEncoder().encode(value));
}

export interface MimeAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

export interface BuildMimeInput {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: MimeAttachment[];
}

export function buildRawMimeMessage(input: BuildMimeInput): Uint8Array {
  const mixedBoundary = randomBoundary("mixed");
  const altBoundary = randomBoundary("alt");
  const headers: string[] = [
    `From: ${normalizeHeaderValue(input.from)}`,
    `To: ${input.to.map(normalizeHeaderValue).join(", ")}`,
    `Subject: ${normalizeHeaderValue(input.subject)}`,
    "MIME-Version: 1.0",
  ];

  if (input.cc?.length) {
    headers.push(`Cc: ${input.cc.map(normalizeHeaderValue).join(", ")}`);
  }

  if (input.bcc?.length) {
    headers.push(`Bcc: ${input.bcc.map(normalizeHeaderValue).join(", ")}`);
  }

  if (input.replyTo?.length) {
    headers.push(`Reply-To: ${input.replyTo.map(normalizeHeaderValue).join(", ")}`);
  }

  if (input.inReplyTo) {
    headers.push(`In-Reply-To: ${normalizeHeaderValue(input.inReplyTo)}`);
  }

  if (input.references?.length) {
    headers.push(`References: ${input.references.map(normalizeHeaderValue).join(" ")}`);
  }

  const hasAttachments = Boolean(input.attachments?.length);
  const hasHtml = Boolean(input.html);
  const hasText = Boolean(input.text);
  const lines: string[] = [...headers];

  if (!hasAttachments && hasHtml && !hasText) {
    lines.push('Content-Type: text/html; charset="UTF-8"');
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    lines.push(foldBase64(textToBase64(input.html ?? "")));
    return new TextEncoder().encode(lines.join("\r\n"));
  }

  if (!hasAttachments && hasText && !hasHtml) {
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    lines.push(foldBase64(textToBase64(input.text ?? "")));
    return new TextEncoder().encode(lines.join("\r\n"));
  }

  if (!hasAttachments) {
    lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    lines.push("");
    if (hasText) {
      lines.push(`--${altBoundary}`);
      lines.push('Content-Type: text/plain; charset="UTF-8"');
      lines.push("Content-Transfer-Encoding: base64");
      lines.push("");
      lines.push(foldBase64(textToBase64(input.text ?? "")));
    }
    if (hasHtml) {
      lines.push(`--${altBoundary}`);
      lines.push('Content-Type: text/html; charset="UTF-8"');
      lines.push("Content-Transfer-Encoding: base64");
      lines.push("");
      lines.push(foldBase64(textToBase64(input.html ?? "")));
    }
    lines.push(`--${altBoundary}--`);
    return new TextEncoder().encode(lines.join("\r\n"));
  }

  lines.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
  lines.push("");
  lines.push(`--${mixedBoundary}`);
  lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
  lines.push("");

  if (hasText) {
    lines.push(`--${altBoundary}`);
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    lines.push(foldBase64(textToBase64(input.text ?? "")));
  }

  if (hasHtml) {
    lines.push(`--${altBoundary}`);
    lines.push('Content-Type: text/html; charset="UTF-8"');
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    lines.push(foldBase64(textToBase64(input.html ?? "")));
  }

  lines.push(`--${altBoundary}--`);

  for (const attachment of input.attachments ?? []) {
    lines.push(`--${mixedBoundary}`);
    lines.push(`Content-Type: ${normalizeHeaderValue(attachment.contentType)}; name="${normalizeHeaderValue(attachment.filename)}"`);
    lines.push(`Content-Disposition: attachment; filename="${normalizeHeaderValue(attachment.filename)}"`);
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    lines.push(foldBase64(toBase64(attachment.content)));
  }

  lines.push(`--${mixedBoundary}--`);
  return new TextEncoder().encode(lines.join("\r\n"));
}
