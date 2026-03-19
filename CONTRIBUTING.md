# Contributing

Thanks for your interest in improving Mailagents Email Runtime.

## Before You Start

- read [`README.md`](README.md) for the project overview
- read [`docs/README.md`](docs/README.md) for the documentation map
- read [`SECURITY.md`](SECURITY.md) for secret-handling expectations
- read [`docs/local-dev.md`](docs/local-dev.md) if you need to run the project locally

## Development Principles

- keep tracked configuration files free of live secrets and environment-specific IDs
- prefer small, focused pull requests
- update docs when behavior, APIs, or setup steps change
- preserve the serverless and provider-agnostic design where possible
- avoid unrelated cleanup in the same change unless it is required to make the main fix safe

## Choosing What To Change

Good contribution targets include:

- documentation improvements
- stronger input validation
- better MIME parsing coverage
- additional smoke or integration assertions
- tenant isolation hardening
- small usability fixes for setup, examples, or operator workflows

Before starting a larger change, make sure the intended scope is clear:

- bug fixes should explain the failing behavior or incorrect assumption
- API changes should note request, response, auth, or compatibility impact
- schema changes should call out migration order and rollout implications
- operational changes should explain dev, staging, and production consequences

## Local Workflow

```bash
npm install
npm run check
npm run d1:migrate:local
npm run d1:seed:local
npm run dev:local
```

Optional smoke test:

```bash
ADMIN_API_SECRET_FOR_SMOKE=your-admin-secret \
WEBHOOK_SHARED_SECRET_FOR_SMOKE=your-webhook-secret \
npm run smoke:local
```

Additional useful commands:

```bash
npm run smoke:mcp:local
npm run config:check:dev
```

See [`docs/testing.md`](docs/testing.md) for smoke coverage and
[`docs/deployment.md`](docs/deployment.md) for config and environment details.

## Documentation Expectations

If your change affects behavior, also update the most relevant docs in the same
pull request.

Common examples:

- API or auth changes
  - update [`docs/openapi.yaml`](docs/openapi.yaml)
  - update [`docs/ai-auth.md`](docs/ai-auth.md), [`docs/ai-mail-workflows.md`](docs/ai-mail-workflows.md), or related guides
- MCP or integration-surface changes
  - update [`docs/runtime-metadata.md`](docs/runtime-metadata.md)
  - update [`docs/runtime-compatibility.md`](docs/runtime-compatibility.md)
  - update [`docs/agent-sdk-examples.md`](docs/agent-sdk-examples.md) or [`docs/mcp-local.md`](docs/mcp-local.md)
- setup or deployment changes
  - update [`docs/local-dev.md`](docs/local-dev.md), [`docs/deployment.md`](docs/deployment.md), or [`docs/dev-bootstrap.md`](docs/dev-bootstrap.md)
- production or operator workflow changes
  - update [`docs/production-rollout-checklist.md`](docs/production-rollout-checklist.md)
  - update [`docs/production-operator-bootstrap.md`](docs/production-operator-bootstrap.md)

If you add a new important document, also add it to [`docs/README.md`](docs/README.md)
so new readers can find it quickly.

## Validation Expectations

Try to validate the narrowest relevant surface before opening a pull request.

Typical expectations:

- documentation-only changes
  - verify links, commands, and filenames still resolve
- code changes without deployment impact
  - run `npm run check`
  - run the smallest relevant local smoke flow when practical
- API, auth, queue, or email-flow changes
  - run `npm run check`
  - run `npm run smoke:local`
  - run `npm run smoke:mcp:local` when MCP behavior changed
- environment or rollout changes
  - describe what was validated locally versus remotely
  - call out any checks maintainers should run in `dev` or production

If you could not run a check, say so clearly in the pull request.

## Pull Requests

Please aim to include:

- a clear description of the problem and solution
- any schema, API, or deployment impact
- updated docs when user-facing or operator-facing behavior changes
- notes about test coverage or verification steps
- any follow-up work that is intentionally left out of the current change

Useful PR checklist:

- describe what changed and why
- list commands run locally
- mention any docs updated
- note whether auth, schema, or deployment behavior changed
- include screenshots only when UI or dashboard behavior changed

## Good First Contributions

- documentation improvements
- stronger input validation
- better MIME parsing coverage
- additional smoke or integration assertions
- tenant isolation hardening

## Security

Do not open public issues containing:

- tokens
- secret keys
- real webhook secrets
- live infrastructure identifiers that do not need to be public

If you find a security issue, follow the guidance in [`SECURITY.md`](SECURITY.md).
