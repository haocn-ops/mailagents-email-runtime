function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "0.0.0.0"
    || hostname === "::1"
    || hostname.endsWith(".localhost")
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
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

  if (new URL(request.url).protocol === "https:") {
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
