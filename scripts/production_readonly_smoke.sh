#!/usr/bin/env bash

set -euo pipefail

BASE_URL="${BASE_URL:-https://api.mailagents.net}"

echo "Checking runtime metadata..."
curl -s "${BASE_URL}/v2/meta/runtime" \
  | jq -e '.server.name == "mailagents-runtime" and (.api.supportedHttpVersions | index("v2") != null)' >/dev/null

echo "Checking compatibility metadata..."
curl -s "${BASE_URL}/v2/meta/compatibility" \
  | jq -e '.contract.name == "mailagents-agent-compatibility" and .routes.adminEnabled == false and .routes.debugEnabled == false' >/dev/null

echo "Checking admin route is disabled..."
ADMIN_STATUS="$(curl -s -o /tmp/mailagents_prod_admin.json -w '%{http_code}' \
  -X POST "${BASE_URL}/v1/auth/tokens" \
  -H 'content-type: application/json' \
  --data '{"sub":"probe","tenantId":"t_probe","scopes":["agent:read"]}')"
[ "${ADMIN_STATUS}" = "404" ]
jq -e '.error == "Admin routes are disabled"' /tmp/mailagents_prod_admin.json >/dev/null

echo "Checking debug route is disabled..."
DEBUG_STATUS="$(curl -s -o /tmp/mailagents_prod_debug.json -w '%{http_code}' \
  "${BASE_URL}/v1/debug/agents/agt_demo")"
[ "${DEBUG_STATUS}" = "404" ]
jq -e '.error == "Debug routes are disabled"' /tmp/mailagents_prod_debug.json >/dev/null

echo "Production read-only smoke passed for ${BASE_URL}"
