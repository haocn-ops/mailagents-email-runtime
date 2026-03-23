# March 23 2026 Black-Box Follow-up

This note archives a production-facing black-box report received at
`hello@mailagents.net` on 2026-03-23 and records the remediation pass taken in
response.

Use the main guides for current behavior and integration guidance:

- [docs/testing.md](../testing.md)
- [docs/deployment.md](../deployment.md)
- [docs/runtime-compatibility.md](../runtime-compatibility.md)

## Source Email

- mailbox: `hello@mailagents.net`
- received at: 2026-03-23 18:19:56 Asia/Shanghai
- subject: `Mailagents Black-Box Test Report (2026-03-23)`

The report targeted both:

- `https://mailagents.net`
- `https://api.mailagents.net`

and described itself as non-destructive functional black-box testing.

## Reported Findings

The email called out these findings:

1. High: `/v2/meta/compatibility` exposed `changelogPath="/CHANGELOG.md"`, but
   both public domains returned `404`.
2. Medium: `POST /public/token/reissue` returned an inaccurate generic error for
   invalid `mailboxAlias` boundaries.
3. Medium, conditional: authenticated API routes such as
   `/v1/mailboxes/self`, `/v1/messages/send`, and `/v1/auth/token/rotate`
   returned `404` to `OPTIONS` preflight requests.
4. Medium: `/limits`, `/privacy`, `/terms`, and `/contact` used shared CSS
   classes without matching style rules, creating a rendering regression risk.
5. Low: `tools/call` without `params.name` returned `Unknown tool` instead of a
   clearer missing-parameter error.
6. Low: `/robots.txt`, `/sitemap.xml`, and `/favicon.ico` returned `404`.
7. Low: `/limits`, `/privacy`, `/terms`, and `/contact` did not include an
   `h1`.

The email also noted one live observation that signup succeeded while
`welcomeStatus` reported a constrained-delivery failure. That behavior was not
treated as a defect in this follow-up because the product documentation already
describes external operator-email delivery as best-effort on constrained
tenants.

## Verification Snapshot

Before patching, the report was spot-checked against production behavior:

- `https://api.mailagents.net/CHANGELOG.md` returned `404`
- `https://mailagents.net/CHANGELOG.md` returned `404`
- `OPTIONS https://api.mailagents.net/v1/mailboxes/self` returned `404`
- `POST /public/token/reissue` with `{"mailboxAlias":"a"}` returned
  `mailboxAlias or mailboxAddress is required`
- `hello@mailagents.net` did not contain any `testu2026` messages; those
  messages belonged to separate test mailboxes and were unrelated to the
  contact inbox itself

## Remediation Applied

The remediation pass made the following changes in the codebase:

- added public routes for `/CHANGELOG.md`, `/robots.txt`, `/sitemap.xml`, and
  `/favicon.ico`
- preserved `changelogPath="/CHANGELOG.md"` while making the route resolve via
  a redirect to the repository changelog
- added the shared public-page style classes that the policy/contact pages were
  already using
- added visible `h1` headings to `/limits`, `/privacy`, `/terms`, and
  `/contact`
- added authenticated API CORS headers and generic `OPTIONS` preflight support
  for browser-facing `/v1/*` and `/v2/*` routes
- improved `POST /public/token/reissue` validation so malformed
  `mailboxAlias`/`mailboxAddress` inputs return specific client errors
- improved MCP `tools/call` validation so missing `params.name` produces a
  clearer `-32602` message

## Scope Notes

This follow-up intentionally focused on issues that were:

- directly reproducible from the report
- low-risk to remediate in a single patch
- part of the public integration or documentation surface

It did not change billing, welcome-email delivery policy, or credit
requirements for constrained tenants.
