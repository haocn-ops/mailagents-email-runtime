# Security Notes

This project is intended to be safe to publish as open source.

## What Must Never Be Committed

- Cloudflare API tokens
- AWS access keys or secret keys
- Worker secret values
- `.dev.vars`
- production or staging admin secrets
- live webhook shared secrets

## What Should Stay as Placeholders

- Cloudflare D1 `database_id`
- real deployment domains
- environment-specific account identifiers when not needed

The repository keeps these values as examples or placeholders in tracked files such as:

- `wrangler.toml`
- `.dev.vars.example`
- deployment documentation

## Recommended Secret Storage

- local development: `.dev.vars`
- deployed Workers: `wrangler secret put`
- CI/CD: GitHub Actions environment secrets only when strictly necessary

## Open Source Hygiene

Before publishing or sharing:

1. verify `wrangler.toml` contains placeholders, not live resource IDs
2. verify `.dev.vars` is not tracked
3. verify docs do not contain real domains, account IDs, or deployed URLs unless intentionally public
4. rotate any secret that may have been exposed during development

## Incident Response

If a secret is accidentally exposed:

1. revoke or rotate it immediately
2. remove it from the repository and history if needed
3. redeploy affected environments
4. review access logs and provider dashboards
