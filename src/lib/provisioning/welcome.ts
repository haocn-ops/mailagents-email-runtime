export function buildWelcomeText(input: {
  mailboxAddress: string;
  productName: string;
  agentName: string;
  accessToken?: string;
  accessTokenExpiresAt?: string;
  accessTokenScopes: string[];
}): string {
  const lines = [
    "Your Mailagents mailbox is ready.",
    "",
    `Product: ${input.productName}`,
    `Agent: ${input.agentName}`,
    `Mailbox: ${input.mailboxAddress}`,
    "",
    "You can now use this mailbox for inbound email, transactional replies, and managed agent workflows.",
  ];

  if (input.accessToken) {
    lines.push(
      "",
      "Default API access token",
      `Scopes: ${input.accessTokenScopes.join(", ")}`,
      `Expires at: ${input.accessTokenExpiresAt ?? "unknown"}`,
      "",
      input.accessToken,
      "",
      "Use this bearer token with the Mailagents API and MCP endpoints."
    );
  } else {
    lines.push(
      "",
      "Default API access token could not be issued because API signing is not configured in this environment yet."
    );
  }

  lines.push(
    "Runtime metadata: https://api.mailagents.net/v2/meta/runtime",
    "Agent guide: https://github.com/haocn-ops/mailagents-email-runtime/blob/main/docs/llms-agent-guide.md",
  );

  return lines.join("\n");
}

export function buildWelcomeHtml(input: {
  mailboxAddress: string;
  productName: string;
  agentName: string;
  accessToken?: string;
  accessTokenExpiresAt?: string;
  accessTokenScopes: string[];
}): string {
  const tokenSection = input.accessToken
    ? `<p><strong>Default API access token</strong><br />
  <strong>Scopes:</strong> ${escapeHtml(input.accessTokenScopes.join(", "))}<br />
  <strong>Expires at:</strong> ${escapeHtml(input.accessTokenExpiresAt ?? "unknown")}</p>
  <pre>${escapeHtml(input.accessToken)}</pre>
  <p>Use this bearer token with the Mailagents API and MCP endpoints.</p>`
    : `<p>Default API access token could not be issued because API signing is not configured in this environment yet.</p>`;

  return `<p>Your Mailagents mailbox is ready.</p>
  <p><strong>Product:</strong> ${escapeHtml(input.productName)}<br />
  <strong>Agent:</strong> ${escapeHtml(input.agentName)}<br />
  <strong>Mailbox:</strong> ${escapeHtml(input.mailboxAddress)}</p>
  <p>You can now use this mailbox for inbound email, transactional replies, and managed agent workflows.</p>
  ${tokenSection}
  <p><a href="https://api.mailagents.net/v2/meta/runtime">Runtime metadata</a><br />
  <a href="https://github.com/haocn-ops/mailagents-email-runtime/blob/main/docs/llms-agent-guide.md">AI agent guide</a></p>`;
}

export function buildTokenReissueText(input: {
  mailboxAddress: string;
  productName: string;
  agentName: string;
  accessToken?: string;
  accessTokenExpiresAt?: string;
  accessTokenScopes: string[];
}): string {
  const lines = [
    "Your Mailagents access token has been reissued.",
    "",
    `Product: ${input.productName}`,
    `Agent: ${input.agentName}`,
    `Mailbox: ${input.mailboxAddress}`,
  ];

  if (input.accessToken) {
    lines.push(
      "",
      "Refreshed API access token",
      `Scopes: ${input.accessTokenScopes.join(", ")}`,
      `Expires at: ${input.accessTokenExpiresAt ?? "unknown"}`,
      "",
      input.accessToken,
      "",
      "If you did not request this token, ignore this email and rotate credentials."
    );
  } else {
    lines.push(
      "",
      "A new access token could not be issued because API signing is not configured in this environment yet."
    );
  }

  lines.push(
    "Runtime metadata: https://api.mailagents.net/v2/meta/runtime",
    "Agent guide: https://github.com/haocn-ops/mailagents-email-runtime/blob/main/docs/llms-agent-guide.md",
  );

  return lines.join("\n");
}

export function buildTokenReissueHtml(input: {
  mailboxAddress: string;
  productName: string;
  agentName: string;
  accessToken?: string;
  accessTokenExpiresAt?: string;
  accessTokenScopes: string[];
}): string {
  const tokenSection = input.accessToken
    ? `<p><strong>Refreshed API access token</strong><br />
  <strong>Scopes:</strong> ${escapeHtml(input.accessTokenScopes.join(", "))}<br />
  <strong>Expires at:</strong> ${escapeHtml(input.accessTokenExpiresAt ?? "unknown")}</p>
  <pre>${escapeHtml(input.accessToken)}</pre>
  <p>If you did not request this token, ignore this email and rotate credentials.</p>`
    : `<p>A new access token could not be issued because API signing is not configured in this environment yet.</p>`;

  return `<p>Your Mailagents access token has been reissued.</p>
  <p><strong>Product:</strong> ${escapeHtml(input.productName)}<br />
  <strong>Agent:</strong> ${escapeHtml(input.agentName)}<br />
  <strong>Mailbox:</strong> ${escapeHtml(input.mailboxAddress)}</p>
  ${tokenSection}
  <p><a href="https://api.mailagents.net/v2/meta/runtime">Runtime metadata</a><br />
  <a href="https://github.com/haocn-ops/mailagents-email-runtime/blob/main/docs/llms-agent-guide.md">AI agent guide</a></p>`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
