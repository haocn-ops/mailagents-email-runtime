#!/usr/bin/env bash
set -euo pipefail

ENVIRONMENT="${1:-dev}"

cat <<EOF
# Cloudflare Worker secret bootstrap template for environment: ${ENVIRONMENT}
#
# Run these commands manually and paste the secret values when prompted.
#
# Required secrets:
wrangler secret put WEBHOOK_SHARED_SECRET --env ${ENVIRONMENT}
wrangler secret put API_SIGNING_SECRET --env ${ENVIRONMENT}
wrangler secret put ADMIN_API_SECRET --env ${ENVIRONMENT}
#
# Optional outbound provider secrets:
wrangler secret put RESEND_API_KEY --env ${ENVIRONMENT}
wrangler secret put SES_ACCESS_KEY_ID --env ${ENVIRONMENT}
wrangler secret put SES_SECRET_ACCESS_KEY --env ${ENVIRONMENT}
#
# Optional secret for contact-alias admin and Cloudflare Email Routing automation:
wrangler secret put CLOUDFLARE_API_TOKEN --env ${ENVIRONMENT}
# Optional secrets for x402 facilitator-backed verification and settlement:
wrangler secret put X402_FACILITATOR_AUTH_TOKEN --env ${ENVIRONMENT}
wrangler secret put X402_PAY_TO --env ${ENVIRONMENT}
#
# Recommended:
# - Use unique WEBHOOK_SHARED_SECRET per environment
# - Use unique API_SIGNING_SECRET per environment
# - Use unique ADMIN_API_SECRET per environment
# - Use RESEND_API_KEY when OUTBOUND_PROVIDER=resend
# - Use SES credentials when OUTBOUND_PROVIDER=ses
# - Only set CLOUDFLARE_API_TOKEN on environments that should manage Email Routing
# - Set X402_FACILITATOR_AUTH_TOKEN only when using a real facilitator
# - Set X402_PAY_TO to the settlement recipient expected by your facilitator
#
# Suggested route exposure:
# - dev: ADMIN_ROUTES_ENABLED=true, DEBUG_ROUTES_ENABLED=true
# - staging: ADMIN_ROUTES_ENABLED=false, DEBUG_ROUTES_ENABLED=false
# - production: ADMIN_ROUTES_ENABLED=false, DEBUG_ROUTES_ENABLED=false
# - keep ADMIN_ROUTES_ALLOW_PUBLIC_HOSTS=false and DEBUG_ROUTES_ALLOW_PUBLIC_HOSTS=false
#   unless a tightly controlled public-host bootstrap window explicitly needs them
#
# Runtime site/admin vars to confirm in wrangler.toml:
# - OUTBOUND_PROVIDER
# - RESEND_API_BASE_URL
# - CLOUDFLARE_ZONE_ID
# - CLOUDFLARE_EMAIL_DOMAIN
# - CLOUDFLARE_EMAIL_WORKER
# - ADMIN_ROUTES_ALLOW_PUBLIC_HOSTS
# - DEBUG_ROUTES_ALLOW_PUBLIC_HOSTS
# - X402_FACILITATOR_URL
# - X402_FACILITATOR_VERIFY_PATH
# - X402_FACILITATOR_SETTLE_PATH
# - X402_DEFAULT_NETWORK_ID
# - X402_DEFAULT_ASSET
# - X402_DEFAULT_SCHEME
# - X402_PRICE_PER_CREDIT_USD
# - X402_UPGRADE_PRICE_USD
# - CONTACT_ALIAS_ROUTING_BOOTSTRAP_ENABLED
# Keep CONTACT_ALIAS_ROUTING_BOOTSTRAP_ENABLED=false unless this runtime should
# become the active owner of managed contact inbox aliases.
#
# After secrets are set:
# 1. Confirm wrangler.toml env.${ENVIRONMENT}.vars are correct
# 2. Run config validation where applicable
# 3. Deploy with:
#    npm run deploy:${ENVIRONMENT}
EOF
