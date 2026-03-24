#!/usr/bin/env bash

set -euo pipefail

BASE_URL="${BASE_URL:-https://api.mailagents.net}"

echo "Running live production drift diagnosis..."
BASE_URL="$BASE_URL" bash ./scripts/production_live_drift_check.sh

echo
echo "Running production read-only smoke..."
BASE_URL="$BASE_URL" bash ./scripts/production_readonly_smoke.sh

echo
echo "Production post-deploy verification passed for ${BASE_URL}"
