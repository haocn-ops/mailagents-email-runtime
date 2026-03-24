# March 24 2026 Production Black-Box Report

This note archives the authorized production black-box testing completed on
2026-03-24 against the public Mailagents endpoints:

- `https://mailagents.net`
- `https://api.mailagents.net`

Use the main guides for current behavior and integration guidance:

- [docs/testing.md](../testing.md)
- [docs/runtime-compatibility.md](../runtime-compatibility.md)
- [docs/ai-auth.md](../ai-auth.md)
- [docs/admin-mcp.md](../admin-mcp.md)

## Scope

The test pass was intentionally non-destructive at the start and then expanded
into authenticated MCP workflow verification with an existing test mailbox
token.

Covered areas:

- public site availability and route discovery
- public runtime metadata and compatibility metadata
- route status codes, method handling, and preflight behavior
- public security and CORS header spot checks
- MCP authentication boundaries
- mailbox-scoped MCP read access
- mailbox-scoped MCP draft lifecycle
- live self-send and self-reply verification against a test `@mailagents.net`
  mailbox

Not covered:

- brute-force, fuzzing at abusive volume, or load testing
- exploit development or vulnerability chaining
- arbitrary external-recipient delivery testing
- admin-secret flows

## Public Surface Results

The following public routes returned `200` during the test window:

- `/`
- `/privacy`
- `/contact`
- `/terms`
- `/robots.txt`
- `/sitemap.xml`
- `/CHANGELOG.md`
- `/v2/meta/runtime`
- `/v2/meta/compatibility`
- `/v2/meta/compatibility/schema`

Additional observations:

- random nonexistent site routes returned `404`
- `GET /admin/mcp` returned `404`
- `GET /v2/meta/runtime` remained stable across 10 low-volume serial requests
- TLS was valid on both `mailagents.net` and `api.mailagents.net`

Certificate snapshot:

- subject: `CN=mailagents.net`
- issuer: `CN=WE1, O=Google Trust Services, C=US`
- not before: `2026-03-06 13:10:22Z`
- not after: `2026-06-04 14:10:18Z`

## Public Metadata and Protocol Findings

Public runtime metadata exposed:

- `server.name = "mailagents-runtime"`
- `server.version = "0.1.0"`
- `api.metaRuntimePath = "/v2/meta/runtime"`
- `api.compatibilityPath = "/v2/meta/compatibility"`
- `api.compatibilitySchemaPath = "/v2/meta/compatibility/schema"`
- `api.mcpPath = "/mcp"`
- `api.adminMcpPath = "/admin/mcp"`
- `routes.adminEnabled = true`
- `routes.debugEnabled = false`

Unauthenticated MCP behavior:

- `POST /mcp` with `initialize` returned `200`
- unauthenticated `tools/list` did not enumerate tools successfully
- `POST /admin/mcp` without valid admin credentials returned `400`
- `OPTIONS /admin/mcp` returned `204`

## Findings Requiring Follow-up

1. `OPTIONS /v2/meta/runtime` advertised `GET, HEAD, POST, OPTIONS`, but actual
   `POST /v2/meta/runtime` returned `404`. Preflight declarations and actual
   method support were inconsistent.
2. `OPTIONS /admin/mcp` exposed permissive CORS data, including
   `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Headers:
   content-type, x-admin-secret`. The admin path was not callable without valid
   credentials, but the browser-visible preflight surface was broader than
   necessary.
3. Invalid bearer token handling on `/mcp` returned `400` with an empty body
   during this test pass, not a clearer `401`-style error shape.
4. Public `POST /mcp initialize` disclosed runtime metadata to anonymous
   callers. This may be intentional, but it should stay explicitly documented if
   kept.
5. `https://mailagents.net/limits` was unstable during this test window. It
   returned `200` once and later returned `522` repeatedly, including with a
   browser-style user agent. This looked more like edge or origin instability
   than an intentional access control response.

## Authenticated MCP Verification

An existing mailbox-scoped test bearer token was used for the authenticated
pass. The token was scoped to:

- `task:read`
- `mail:read`
- `draft:create`
- `draft:read`
- `draft:send`

Verified behavior:

- `POST /mcp initialize` returned `200`
- authenticated `tools/list` returned `13` visible tools
- provisioning tools requiring broader scopes were not exposed
- `tools/call list_messages` returned mailbox data successfully
- `tools/call create_agent` was rejected with structured MCP error
  `auth_missing_scope`

Visible authenticated MCP tools included:

- `reply_to_inbound_email`
- `operator_manual_send`
- `list_agent_tasks`
- `list_messages`
- `get_message`
- `get_message_content`
- `get_thread`
- `create_draft`
- `get_draft`
- `send_draft`
- `cancel_draft`
- `send_email`
- `reply_to_message`

## Draft Lifecycle Verification

The mailbox-scoped token completed a full draft lifecycle through MCP:

1. `create_draft` returned `200`
2. `get_draft` returned `200`
3. `cancel_draft` returned `200`
4. follow-up `get_draft` showed persisted status `cancelled`

Verified draft record:

- draft id: `drf_67de963f791c4d55822d60d3a213e03b`

## Live Send and Reply Verification

To avoid hitting external recipients, the live send test targeted the same
test mailbox address:

- mailbox address: `testu2026032010344201@mailagents.net`

### Self-send

High-level MCP `send_email` succeeded:

- subject: `BBX self-send 1774320863`
- status: `queued`
- draft id: `drf_42e99b8255cc4677bee0e37765c1b4f3`
- outbound job id: `obj_a8f95fae2b884bb7aaa6baa282dad2c8`

The same `idempotencyKey` returned the same draft and outbound job ids on
repeat submission.

The sent message was then observed as inbound mail in the same mailbox:

- inbound message id: `msg_da8846a603bc464fbf027d388b9ce972`
- inbound subject: `BBX self-send 1774320863`

### Self-reply

High-level MCP `reply_to_message` against that inbound message also succeeded:

- source message id: `msg_da8846a603bc464fbf027d388b9ce972`
- status: `queued`
- draft id: `drf_686a0956e24244e0a7102dcb4f0612a4`
- outbound job id: `obj_dd0856d62ddd438e99753d9e0bf7331f`

The same `idempotencyKey` returned the same draft and outbound job ids on
repeat submission.

The reply was then observed as a new inbound message in the same mailbox:

- reply message id: `msg_b5a5fe3f741846998dc42d66bdf3dc33`
- reply subject: `Re: BBX self-send 1774320863`

## Conclusion

As of 2026-03-24, the production Mailagents runtime passed the tested
mailbox-scoped MCP read and write flows, including:

- authenticated tool discovery
- mailbox-scoped message listing
- draft creation and cancellation
- high-level send through `send_email`
- high-level reply through `reply_to_message`
- idempotent replay for both send and reply
- actual self-delivery back into the test mailbox

The main follow-up items from this pass were not core send-path failures. They
were protocol-surface and hardening issues around:

- inconsistent `OPTIONS` versus actual method support
- overly broad admin-route CORS signaling
- unclear invalid-token error semantics
- intermittent `/limits` availability
