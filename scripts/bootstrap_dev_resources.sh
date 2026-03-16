#!/usr/bin/env bash
set -euo pipefail

cat <<'EOF'
# Cloudflare dev resource bootstrap template
#
# Run these commands manually after logging into Wrangler:
#   wrangler login
#
# 1. Create D1
wrangler d1 create mailagents-dev
#
# 2. Create R2 bucket
wrangler r2 bucket create mailagents-dev-email
#
# 3. Create queues
wrangler queues create mailagents-dev-email-ingest
wrangler queues create mailagents-dev-agent-execute
wrangler queues create mailagents-dev-outbound-send
wrangler queues create mailagents-dev-dead-letter
#
# 4. Optional: inspect created resources
wrangler d1 list
wrangler r2 bucket list
wrangler queues list
#
# 5. After creation, update wrangler.toml:
#   - env.dev.d1_databases[].database_id
#   - env.dev.r2_buckets[].bucket_name if changed
#   - env.dev queue names if changed
#   - env.dev.vars.SES_FROM_DOMAIN
#   - env.dev.vars.SES_CONFIGURATION_SET
#
# 6. Validate config
# npm run config:check:dev
#
# 7. Apply schema and seed to remote dev
# npm run d1:migrate:remote:dev
# npm run d1:seed:remote:dev
#
# 8. Deploy dev
# npm run deploy:dev
EOF
