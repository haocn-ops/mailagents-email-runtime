#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WRANGLER_TOML="$ROOT_DIR/wrangler.toml"
DEV_VARS="$ROOT_DIR/.dev.vars"
TARGET_ENV="${1:-production}"
SKIP_LOCAL_SECRET_CHECKS="${SKIP_LOCAL_SECRET_CHECKS:-false}"

fail() {
  echo "Config check failed: $1" >&2
  exit 1
}

require_file() {
  local file="$1"
  [[ -f "$file" ]] || fail "missing file: $file"
}

check_no_placeholder() {
  local file="$1"
  local pattern="$2"
  local label="$3"
  if rg -n "$pattern" "$file" >/dev/null 2>&1; then
    fail "$label still contains placeholder values"
  fi
}

check_has_value() {
  local file="$1"
  local key="$2"
  if ! rg -n "^${key}=.+$" "$file" >/dev/null 2>&1; then
    fail "missing value for $key in $(basename "$file")"
  fi
}

require_file "$WRANGLER_TOML"

case "$TARGET_ENV" in
  dev)
    check_no_placeholder "$WRANGLER_TOML" "REPLACE_WITH_DEV_D1_DATABASE_ID" "wrangler.toml dev environment"
    check_no_placeholder "$WRANGLER_TOML" '^SES_FROM_DOMAIN = "dev\.mail\.example\.com"$' "wrangler.toml dev SES_FROM_DOMAIN"
    ;;
  staging)
    check_no_placeholder "$WRANGLER_TOML" "REPLACE_WITH_STAGING_D1_DATABASE_ID" "wrangler.toml staging environment"
    check_no_placeholder "$WRANGLER_TOML" '^SES_FROM_DOMAIN = "staging\.mail\.example\.com"$' "wrangler.toml staging SES_FROM_DOMAIN"
    rg -n 'ADMIN_ROUTES_ENABLED = "false"' "$WRANGLER_TOML" >/dev/null 2>&1 || fail "staging ADMIN_ROUTES_ENABLED should be false"
    rg -n 'ADMIN_ROUTES_ALLOW_PUBLIC_HOSTS = "false"' "$WRANGLER_TOML" >/dev/null 2>&1 || fail "staging ADMIN_ROUTES_ALLOW_PUBLIC_HOSTS should be false"
    rg -n 'DEBUG_ROUTES_ENABLED = "false"' "$WRANGLER_TOML" >/dev/null 2>&1 || fail "staging DEBUG_ROUTES_ENABLED should be false"
    rg -n 'DEBUG_ROUTES_ALLOW_PUBLIC_HOSTS = "false"' "$WRANGLER_TOML" >/dev/null 2>&1 || fail "staging DEBUG_ROUTES_ALLOW_PUBLIC_HOSTS should be false"
    ;;
  production|prod)
    check_no_placeholder "$WRANGLER_TOML" "REPLACE_WITH_PRODUCTION_D1_DATABASE_ID" "wrangler.toml production environment"
    check_no_placeholder "$WRANGLER_TOML" '^SES_FROM_DOMAIN = "mail\.example\.com"$' "wrangler.toml production SES_FROM_DOMAIN"
    rg -n 'ADMIN_ROUTES_ENABLED = "false"' "$WRANGLER_TOML" >/dev/null 2>&1 || fail "production ADMIN_ROUTES_ENABLED should be false"
    rg -n 'ADMIN_ROUTES_ALLOW_PUBLIC_HOSTS = "false"' "$WRANGLER_TOML" >/dev/null 2>&1 || fail "production ADMIN_ROUTES_ALLOW_PUBLIC_HOSTS should be false"
    rg -n 'DEBUG_ROUTES_ENABLED = "false"' "$WRANGLER_TOML" >/dev/null 2>&1 || fail "production DEBUG_ROUTES_ENABLED should be false"
    rg -n 'DEBUG_ROUTES_ALLOW_PUBLIC_HOSTS = "false"' "$WRANGLER_TOML" >/dev/null 2>&1 || fail "production DEBUG_ROUTES_ALLOW_PUBLIC_HOSTS should be false"
    ;;
  *)
    fail "unknown environment: $TARGET_ENV"
    ;;
esac

if [[ "$SKIP_LOCAL_SECRET_CHECKS" != "true" ]]; then
  require_file "$DEV_VARS"

  check_has_value "$DEV_VARS" "SES_ACCESS_KEY_ID"
  check_has_value "$DEV_VARS" "SES_SECRET_ACCESS_KEY"
  check_has_value "$DEV_VARS" "WEBHOOK_SHARED_SECRET"
  check_has_value "$DEV_VARS" "API_SIGNING_SECRET"
  check_has_value "$DEV_VARS" "ADMIN_API_SECRET"
  check_has_value "$DEV_VARS" "ADMIN_ROUTES_ENABLED"
  check_has_value "$DEV_VARS" "DEBUG_ROUTES_ENABLED"

  check_no_placeholder "$DEV_VARS" "replace-with-" ".dev.vars"
  check_no_placeholder "$DEV_VARS" "local-dev-access-key|local-dev-secret-key|local-webhook-secret|local-api-signing-secret|local-admin-secret" ".dev.vars"
fi

echo "Config check passed for environment: $TARGET_ENV"
