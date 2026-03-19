# Local Development

## Prerequisites

- Node.js 20+
- npm
- Cloudflare account with:
  - one D1 database
  - one R2 bucket
  - four Queues
- AWS account with SES access keys

## 1. Install dependencies

```bash
npm install
```

## 2. Configure Wrangler

Update [wrangler.toml](../wrangler.toml):

- replace `database_id`
- replace `bucket_name` if needed
- make sure queue names exist
- adjust `SES_REGION`, `SES_FROM_DOMAIN`, and `SES_CONFIGURATION_SET`

## 3. Configure secrets for local development

Copy [.dev.vars.example](../.dev.vars.example) to `.dev.vars` and fill in:

- `SES_ACCESS_KEY_ID`
- `SES_SECRET_ACCESS_KEY`
- `WEBHOOK_SHARED_SECRET`
- `API_SIGNING_SECRET`
- `ADMIN_API_SECRET`
- `ADMIN_ROUTES_ENABLED`
- `DEBUG_ROUTES_ENABLED`
- `IDEMPOTENCY_COMPLETED_RETENTION_HOURS`
- `IDEMPOTENCY_PENDING_RETENTION_HOURS`

Wrangler automatically loads `.dev.vars` for local development.
Do not commit `.dev.vars`; it is intentionally gitignored.

## 4. Apply schema locally

```bash
npm run d1:migrate:local
```

This creates the initial schema in the local D1 instance persisted under `.wrangler/state`.
The entire `.wrangler/` directory is local-only and is intentionally gitignored.

If your local or remote database was created before the idempotency update, also
apply:

```bash
wrangler d1 execute mailagents-local --local --file=./migrations/0002_idempotency_keys.sql
```

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

## 8. Create a real agent config object in R2

The demo seed creates the D1 row only. To align R2 with the seeded `config_r2_key`, create a real agent through the API:

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

Then bind it to `mbx_demo`:

```bash
curl -X POST http://127.0.0.1:8787/v1/agents/REPLACE_WITH_AGENT_ID/mailboxes \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "tenantId": "t_demo",
    "mailboxId": "mbx_demo",
    "role": "primary"
  }'
```

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
- Outbound now chooses SES `Raw` content when reply headers or attachments are present.
- Idempotency cleanup can be triggered manually with `POST /admin/api/maintenance/idempotency-cleanup`.
- For remote D1, use `npm run d1:migrate:remote` and `npm run d1:seed:remote`.
