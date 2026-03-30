# March 30 2026 Production Black-Box Report

This note archives the authorized production black-box testing completed on
2026-03-30 against the public Mailagents endpoints:

- `https://mailagents.net`
- `https://api.mailagents.net`

Use the main guides for current behavior and integration guidance:

- [docs/testing.md](../testing.md)
- [docs/runtime-compatibility.md](../runtime-compatibility.md)
- [docs/ai-auth.md](../ai-auth.md)
- [docs/admin-mcp.md](../admin-mcp.md)

## Scope

The test pass was intentionally read-only and low-volume. It focused on the
public site, public metadata, unauthenticated MCP behavior, and public route
hardening signals.

Covered areas:

- public site availability
- public runtime metadata and compatibility metadata
- route status codes for representative public and disabled admin/debug paths
- public MCP initialize and authentication boundary behavior
- selected security and caching headers on public HTML and metadata routes
- production drift checks against the current repo expectation

Not covered:

- authenticated mailbox-scoped MCP workflows
- live self-send or self-reply verification
- brute-force, fuzzing at abusive volume, or load testing
- exploit development or vulnerability chaining
- admin-secret flows beyond confirming that they are disabled

## Public Surface Results

The following public routes returned `200` during the test window:

- `/`
- `/limits`
- `/v2/meta/runtime`
- `/v2/meta/compatibility`

Additional observations:

- a random nonexistent site route returned `404`
- `GET /mcp` returned `405`
- `GET /admin/mcp` returned `405`
- `POST /v2/meta/runtime` returned `404`
- `OPTIONS /v2/meta/runtime` returned `204`
- `https://api.mailagents.net/v2/meta/runtime` returned `200`
- `https://api.mailagents.net/v1/auth/tokens` returned `404` with admin routes
  disabled

## Public Metadata Snapshot

Public runtime metadata exposed:

- `server.name = "mailagents-runtime"`
- `server.version = "0.1.0"`
- `api.metaRuntimePath = "/v2/meta/runtime"`
- `api.compatibilityPath = "/v2/meta/compatibility"`
- `api.compatibilitySchemaPath = "/v2/meta/compatibility/schema"`
- `api.mcpPath = "/mcp"`
- `routes.adminEnabled = false`
- `routes.debugEnabled = false`
- `delivery.outboundProvider = "resend"`

Public compatibility metadata exposed:

- `contract.name = "mailagents-agent-compatibility"`
- `contract.version = "2026-03-17"`
- `routes.adminEnabled = false`
- `routes.debugEnabled = false`
- `discovery.mcpInitializeEmbedsRuntimeMetadata = true`
- `discovery.toolsListScopeFiltered = true`

## Unauthenticated MCP Results

Verified behavior:

- unauthenticated `POST /mcp initialize` returned `200`
- unauthenticated `POST /mcp tools/list` returned structured `Unauthorized`
- invalid bearer token handling on `/mcp` returned structured `Unauthorized`
- `POST /admin/mcp` with an invalid admin secret returned `400`
- admin MCP error payload reported `Admin routes are disabled`
- `OPTIONS /admin/mcp` returned `204`

Observed unauthenticated MCP error semantics:

- missing bearer token:
  `error.data.errorCode = "auth_unauthorized"`
- invalid bearer token:
  `error.data.errorCode = "auth_unauthorized"`
- disabled admin route:
  `error.data.errorCode = "route_disabled"`

## Security Header Spot Checks

Observed on `GET /` and `GET /limits`:

- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `Content-Security-Policy` present with `default-src 'self'`
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), geolocation=(), microphone=()`

Observed on MCP and metadata routes:

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods` limited to declared protocol methods
- `Allow: GET, POST, OPTIONS` on MCP transport placeholders

## Drift Check Summary

`https://mailagents.net` matched the current repo expectation for production:

- admin routes disabled
- debug routes disabled
- no admin MCP path advertised in public metadata
- public runtime metadata and compatibility metadata reachable

`https://api.mailagents.net` passed the read-only smoke checks as well, but an
initial drift-check attempt was inconclusive because of a transient DNS
resolution failure during the test window. A direct retry succeeded:

- `GET /v2/meta/runtime` returned `200`
- `POST /v1/auth/tokens` returned `404`
- the body reported `Admin routes are disabled`

## Notable Changes Since March 24 2026

Compared with the archived 2026-03-24 production black-box report:

- public metadata no longer advertises `adminEnabled = true`; it now reports
  `false`
- `/limits` returned `200` in this test pass and did not reproduce the earlier
  `522` instability
- invalid-token behavior on `/mcp` now returns a clearer structured
  unauthorized error
- `OPTIONS /v2/meta/runtime` now advertises `GET, HEAD, OPTIONS`, which matches
  the observed `POST /v2/meta/runtime -> 404` behavior better than the earlier
  mismatch

## Follow-up Notes

This pass did not reveal a live send-path regression, but two public-surface
details are still worth watching:

1. `GET /admin/mcp` currently returns `405` with `Allow: GET, POST, OPTIONS`
   instead of disappearing as a plain `404`. The route is still disabled, but
   the protocol placeholder remains visible.
2. The initial `api.mailagents.net` drift-check run hit a transient DNS
   resolution failure before succeeding on direct retry. This looked like a
   network hiccup rather than a sustained production outage, but it is worth
   monitoring if repeated externally.

## Conclusion

As of 2026-03-30, the public Mailagents production surface passed the tested
read-only black-box checks for:

- site availability
- runtime and compatibility metadata
- admin and debug route disablement
- unauthenticated MCP initialize behavior
- MCP authentication boundary handling
- baseline public security headers

The current public production posture is more tightly aligned with the repo's
expected production configuration than the archived 2026-03-24 snapshot.
