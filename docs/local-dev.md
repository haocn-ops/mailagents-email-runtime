# Local Development

## Prerequisites

- Node.js 20+
- npm
- optional for remote environment work: Cloudflare account with D1, R2, and Queues
- optional for real outbound validation: AWS account with SES API access keys or a Resend API key

## 1. Install dependencies

```bash
npm install
```

## 2. Configure Wrangler

For the default purely local workflow, you can usually keep the top-level local
bindings in [wrangler.toml](../wrangler.toml) as-is.

Only update `wrangler.toml` when you want to:

- point remote commands at real Cloudflare environments
- change local bucket or queue names
- adjust `OUTBOUND_PROVIDER`, `SES_REGION`, `SES_FROM_DOMAIN`, `SES_CONFIGURATION_SET`, or `RESEND_API_BASE_URL`

## 3. Configure secrets for local development

Copy [.dev.vars.example](../.dev.vars.example) to `.dev.vars` and fill in the
values you need for your local workflow:

Required for the default local API flow:

- `WEBHOOK_SHARED_SECRET`
- `API_SIGNING_SECRET`
- `ADMIN_API_SECRET`

Optional outbound-provider selection:

- `OUTBOUND_PROVIDER`

Optional for real outbound SES-backed validation:

- `SES_ACCESS_KEY_ID`
- `SES_SECRET_ACCESS_KEY`

Optional for real outbound Resend-backed validation:

- `RESEND_API_KEY`
- `RESEND_API_BASE_URL`

Optional for contact inbox, alias-management, or Email Routing admin flows:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ZONE_ID`
- `CLOUDFLARE_EMAIL_DOMAIN`
- `CLOUDFLARE_EMAIL_WORKER`
- `CONTACT_ALIAS_ROUTING_BOOTSTRAP_ENABLED`

Wrangler automatically loads `.dev.vars` for local development.
Do not commit `.dev.vars`; it is intentionally gitignored.

The default local values for `ADMIN_ROUTES_ENABLED`, `DEBUG_ROUTES_ENABLED`,
and idempotency retention windows already live in [wrangler.toml](../wrangler.toml).
You only need to override them in `.dev.vars` if you intentionally want different
local behavior.

## 4. Apply schema locally

```bash
npm run d1:migrate:local
```

This applies the full local schema in the local D1 instance persisted under
`.wrangler/state`, including:

- `migrations/0001_initial.sql`
- `migrations/0002_agent_registry.sql`
- `migrations/0002_idempotency_keys.sql`
- `migrations/0003_agent_deployment_history.sql`
- `migrations/0004_token_reissue_requests.sql`
- `migrations/0005_draft_origin_audit.sql`

The entire `.wrangler/` directory is local-only and is intentionally gitignored.

## 5. Seed demo data locally

```bash
npm run d1:seed:local
```

This inserts:

- demo tenant `t_demo`
- demo mailbox `mbx_demo`
- demo agent `agt_demo`
- seeded inbound thread `thr_demo_inbound`
- seeded inbound message `msg_demo_inbound`
- mailbox binding and basic policy

The SQL lives in [seeds/0001_demo.sql](../seeds/0001_demo.sql).

## 6. Start the local worker

```bash
npm run dev:local
```

Default local URL is typically `http://127.0.0.1:8787`.

## 7. Mint a bearer token

Create a token with the admin secret:

```bash
curl -X POST http://127.0.0.1:8787/v1/auth/tokens \
  -H 'content-type: application/json' \
  -H 'x-admin-secret: replace-with-admin-api-secret' \
  -d '{
    "sub": "local-dev",
    "tenantId": "t_demo",
    "scopes": [
      "agent:create",
      "agent:read",
      "agent:update",
      "agent:bind",
      "task:read",
      "mail:read",
      "mail:replay",
      "draft:create",
      "draft:read",
      "draft:send"
    ],
    "mailboxIds": ["mbx_demo"],
    "expiresInSeconds": 86400
  }'
```

Store the returned token and use it as:

```bash
export TOKEN="REPLACE_WITH_TOKEN"
```

## 8. Optional: create a real agent config object in R2

The seeded `agt_demo` row is enough for the mailbox read, send, and reply
examples below.

If you want a real R2-backed config object for direct agent or deployment
experiments, create another agent through the API:

```bash
curl -X POST http://127.0.0.1:8787/v1/agents \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "tenantId": "t_demo",
    "name": "Support Agent",
    "mode": "assistant",
    "config": {
      "systemPrompt": "You are a helpful support agent.",
      "defaultModel": "gpt-5",
      "tools": ["reply_email"]
    }
  }'
```

Store the returned agent id if you want to use direct agent routes such as
`POST /v1/agents/{agentId}/drafts`.

Do not bind that new agent to `mbx_demo` unless you also replace the seeded
`agt_demo` binding through the deployment flow; otherwise the older seeded
binding remains the mailbox fallback execution target.

## 9. Read mailbox messages through the mailbox-scoped routes

List messages:

```bash
curl -X GET "http://127.0.0.1:8787/v1/mailboxes/self/messages?limit=10" \
  -H "authorization: Bearer $TOKEN"
```

Read a single message body:

```bash
curl -X GET http://127.0.0.1:8787/v1/mailboxes/self/messages/msg_demo_inbound/content \
  -H "authorization: Bearer $TOKEN"
```

## 10. Send a message through the high-level route

```bash
curl -X POST http://127.0.0.1:8787/v1/messages/send \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "to": ["user@example.com"],
    "subject": "Hello from Mailagents",
    "text": "This is a local high-level send test.",
    "idempotencyKey": "send-message-001"
  }'
```

## 11. Reply to a seeded inbound message

```bash
curl -X POST http://127.0.0.1:8787/v1/messages/msg_demo_inbound/reply \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "text": "Thanks for your message. This is a local reply test.",
    "idempotencyKey": "reply-message-001"
  }'
```

## 12. Advanced: create and send a draft explicitly

Create:

```bash
curl -X POST http://127.0.0.1:8787/v1/agents/agt_demo/drafts \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "tenantId": "t_demo",
    "mailboxId": "mbx_demo",
    "from": "agent@mail.example.com",
    "to": ["user@example.com"],
    "subject": "Hello from Mailagents",
    "text": "This is a local test draft."
  }'
```

If you completed the optional R2-backed agent step above, you can substitute
that returned agent id for `agt_demo` here.

Send:

```bash
curl -X POST http://127.0.0.1:8787/v1/drafts/REPLACE_WITH_DRAFT_ID/send \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "idempotencyKey": "send-draft-001"
  }'
```

Use the explicit draft path only when you need a visible review step or direct
control over the draft lifecycle.

## 13. Replay a message normalize job

```bash
curl -X POST http://127.0.0.1:8787/v1/messages/REPLACE_WITH_MESSAGE_ID/replay \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "mode": "normalize",
    "idempotencyKey": "replay-normalize-001"
  }'
```

## 14. Common workflow

1. `npm run d1:migrate:local`
2. `npm run d1:seed:local`
3. `npm run dev:local`
4. mint a token
5. create agent via API
6. bind mailbox
7. read mailbox messages
8. send or reply through the high-level routes
9. use explicit drafts only when the workflow needs review
10. trigger replay/tests when debugging or recovering state

## Notes

- The current parser is MVP-grade, not a full RFC-complete MIME parser.
- Outbound now chooses provider-specific rich send behavior for reply headers or attachments. SES uses `Raw` MIME; Resend uses headers plus attachment upload in the API payload.
- Sends to active Mailagents mailboxes are routed internally through the local
  inbound ingest path and do not require SES or Resend credentials.
- Idempotency cleanup can be triggered manually with `POST /admin/api/maintenance/idempotency-cleanup`.
- For remote D1, use the environment-specific scripts such as `npm run d1:migrate:remote:dev` and `npm run d1:seed:remote:dev`.
- With fake or sandbox-limited provider credentials, local send tests can still exercise the accepted-to-retry path without proving external delivery.
