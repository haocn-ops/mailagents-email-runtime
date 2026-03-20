#!/usr/bin/env bash
set -euo pipefail

ENVIRONMENT="${1:-dev}"

cat <<EOF
# x402 real payment bootstrap template for environment: ${ENVIRONMENT}
#
# Run these commands manually and paste the secret values when prompted.
#
# Required secrets for a real facilitator-backed payment flow:
wrangler secret put X402_FACILITATOR_AUTH_TOKEN --env ${ENVIRONMENT}
wrangler secret put X402_PAY_TO --env ${ENVIRONMENT}
#
# Non-secret vars to confirm in wrangler.toml env.${ENVIRONMENT}.vars:
# - X402_DEFAULT_SCHEME = "exact"
# - X402_DEFAULT_NETWORK_ID = "eip155:84532"
# - X402_DEFAULT_ASSET = "usdc"
# - X402_FACILITATOR_VERIFY_PATH = "/verify"
# - X402_FACILITATOR_SETTLE_PATH = "/settle"
# - X402_PRICE_PER_CREDIT_USD = "0.01"
# - X402_UPGRADE_PRICE_USD = "10"
#
# Required secrets and vars outside x402 itself:
# - CLOUDFLARE_API_TOKEN when signup and hosted Email Routing provisioning should work
# - SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY when real outbound validation is needed
#
# First real-payment validation steps:
# 1. Deploy the environment:
#    npm run deploy:${ENVIRONMENT}
# 2. Create a fresh mailbox via /public/signup
# 3. Create a hosted DID via /v1/tenants/{tenantId}/did/hosted
# 4. Request POST /v1/billing/topup without payment-signature
# 5. Confirm the quote shows:
#    - scheme exact
#    - network eip155:84532
#    - asset usdc
#    - expected payTo
# 6. Submit a real proof, then confirm settlement via /v1/billing/payment/confirm
#
# Reference docs:
# - docs/x402-real-payment-checklist.md
# - docs/deployment.md
EOF
