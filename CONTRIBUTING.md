# Contributing

Thanks for your interest in improving Mailagents Email Runtime.

## Before You Start

- read [`README.md`](README.md) for the project overview
- read [`SECURITY.md`](SECURITY.md) for secret-handling expectations
- read [`docs/local-dev.md`](docs/local-dev.md) if you need to run the project locally

## Development Principles

- keep tracked configuration files free of live secrets and environment-specific IDs
- prefer small, focused pull requests
- update docs when behavior, APIs, or setup steps change
- preserve the serverless and provider-agnostic design where possible

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

## Pull Requests

Please aim to include:

- a clear description of the problem and solution
- any schema, API, or deployment impact
- updated docs when user-facing or operator-facing behavior changes
- notes about test coverage or verification steps

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
