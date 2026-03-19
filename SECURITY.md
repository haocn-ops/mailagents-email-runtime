# Security Notes

This project is intended to be safe to publish as open source.

## What Must Never Be Committed

- Cloudflare API tokens
- AWS access keys or secret keys
- Worker secret values
- `.dev.vars`
- production or staging admin secrets
- live webhook shared secrets

## What Should Usually Stay as Placeholders

- environment values that are not intentionally public yet
- deployment domains that are not intentionally live yet
- environment-specific account identifiers when not needed

The repository may intentionally keep some non-secret, operationally necessary
resource names, public routes, or public domains in tracked files when they are
required for deployment or integration docs. Secrets must still never be
committed.

Examples of tracked files that may contain either placeholders or intentionally
public non-secret config:

- `wrangler.toml`
- `.dev.vars.example`
- deployment documentation

## Recommended Secret Storage

- local development: `.dev.vars`
- deployed Workers: `wrangler secret put`
- CI/CD: GitHub Actions environment secrets only when strictly necessary

## Open Source Hygiene

Before publishing or sharing:

1. verify tracked config files contain no secrets
2. verify any tracked domains, route patterns, or resource identifiers are intentionally public or operationally necessary
3. verify `.dev.vars` is not tracked
4. verify docs do not contain non-public domains, account IDs, or deployed URLs unless intentionally public
5. rotate any secret that may have been exposed during development

## Incident Response

If a secret is accidentally exposed:

1. revoke or rotate it immediately
2. remove it from the repository and history if needed
3. redeploy affected environments
4. review access logs and provider dashboards
