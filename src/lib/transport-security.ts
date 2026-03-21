function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "0.0.0.0"
    || hostname === "::1"
    || hostname.endsWith(".localhost")
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function isHtmlResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.toLowerCase().includes("text/html");
}

function buildContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self' https:",
  ].join("; ");
}

export function redirectToHttps(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.protocol !== "http:" || isLocalHostname(url.hostname)) {
    return null;
  }

  url.protocol = "https:";
  const response = new Response(null, {
    status: 308,
    headers: {
      location: url.toString(),
    },
  });
  const headers = new Headers(response.headers);
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "camera=(), geolocation=(), microphone=()");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function withSecurityHeaders(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "camera=(), geolocation=(), microphone=()");
  if (isHtmlResponse(response)) {
    headers.set("content-security-policy", buildContentSecurityPolicy());
  }

  if (new URL(request.url).protocol === "https:") {
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
