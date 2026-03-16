#!/usr/bin/env bash
set -euo pipefail

ENVIRONMENT="${1:-dev}"

cat <<EOF
# Cloudflare Worker secret bootstrap template for environment: ${ENVIRONMENT}
#
# Run these commands manually and paste the secret values when prompted.
#
# Required secrets:
wrangler secret put SES_ACCESS_KEY_ID --env ${ENVIRONMENT}
wrangler secret put SES_SECRET_ACCESS_KEY --env ${ENVIRONMENT}
wrangler secret put WEBHOOK_SHARED_SECRET --env ${ENVIRONMENT}
wrangler secret put API_SIGNING_SECRET --env ${ENVIRONMENT}
wrangler secret put ADMIN_API_SECRET --env ${ENVIRONMENT}
#
# Recommended:
# - Use unique WEBHOOK_SHARED_SECRET per environment
# - Use unique API_SIGNING_SECRET per environment
# - Use unique ADMIN_API_SECRET per environment
#
# Suggested route exposure:
# - dev: ADMIN_ROUTES_ENABLED=true, DEBUG_ROUTES_ENABLED=true
# - staging: ADMIN_ROUTES_ENABLED=false, DEBUG_ROUTES_ENABLED=false
# - production: ADMIN_ROUTES_ENABLED=false, DEBUG_ROUTES_ENABLED=false
#
# After secrets are set:
# 1. Confirm wrangler.toml env.${ENVIRONMENT}.vars are correct
# 2. Run config validation where applicable
# 3. Deploy with:
#    npm run deploy:${ENVIRONMENT}
EOF
