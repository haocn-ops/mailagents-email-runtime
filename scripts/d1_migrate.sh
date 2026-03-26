#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="${1:-local}"

MIGRATIONS=(
  "0001_initial.sql"
  "0002_agent_registry.sql"
  "0002_idempotency_keys.sql"
  "0003_agent_deployment_history.sql"
  "0004_token_reissue_requests.sql"
  "0005_draft_origin_audit.sql"
  "0006_billing_base.sql"
  "0007_tenant_did_bindings.sql"
  "0008_tenant_send_policies.sql"
  "0009_billing_idempotency_guards.sql"
  "0010_payment_proof_fingerprint.sql"
  "0011_messages_internet_message_id_index.sql"
)

case "$TARGET" in
  local)
    DATABASE="mailagents-local"
    EXEC_ARGS=(--local)
    ;;
  dev)
    DATABASE="mailagents-dev"
    EXEC_ARGS=(--remote --env dev)
    ;;
  staging)
    DATABASE="mailagents-staging"
    EXEC_ARGS=(--remote --env staging)
    ;;
  production)
    DATABASE="mailagents-production"
    EXEC_ARGS=(--remote --env production)
    ;;
  *)
    echo "Usage: $0 <local|dev|staging|production>" >&2
    exit 1
    ;;
esac

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

exec_sql_json() {
  local sql="$1"
  wrangler d1 execute "$DATABASE" "${EXEC_ARGS[@]}" --json --command "$sql"
}

exec_sql() {
  local sql="$1"
  wrangler d1 execute "$DATABASE" "${EXEC_ARGS[@]}" --command "$sql"
}

exec_file() {
  local file="$1"
  wrangler d1 execute "$DATABASE" "${EXEC_ARGS[@]}" --file="$file"
}

has_results() {
  local sql="$1"
  local output
  output="$(exec_sql_json "$sql")"
  jq -e '.[0].success == true and ((.[0].results | length) > 0)' >/dev/null <<<"$output"
}

ensure_schema_migrations_table() {
  exec_sql "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
}

mark_migration_applied() {
  local migration_id="$1"
  exec_sql "INSERT OR REPLACE INTO schema_migrations (id, applied_at) VALUES ('$migration_id', CURRENT_TIMESTAMP)"
}

migration_already_marked() {
  local migration_id="$1"
  has_results "SELECT id FROM schema_migrations WHERE id = '$migration_id' LIMIT 1"
}

bootstrap_migration_if_needed() {
  local migration_id="$1"

  case "$migration_id" in
    0001_initial.sql)
      has_results "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agents'" && return 0
      ;;
    0002_agent_registry.sql)
      has_results "SELECT name FROM pragma_table_info('agents') WHERE name = 'slug'" &&
        has_results "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_versions'" &&
        return 0
      ;;
    0002_idempotency_keys.sql)
      has_results "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'idempotency_keys'" && return 0
      ;;
    0003_agent_deployment_history.sql)
      has_results "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_deployments_active_target'" && return 0
      ;;
    0004_token_reissue_requests.sql)
      has_results "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'token_reissue_requests'" && return 0
      ;;
    0005_draft_origin_audit.sql)
      has_results "SELECT name FROM pragma_table_info('drafts') WHERE name = 'created_via'" && return 0
      ;;
    0006_billing_base.sql)
      has_results "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tenant_billing_accounts'" && return 0
      ;;
    0007_tenant_did_bindings.sql)
      has_results "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tenant_did_bindings'" && return 0
      ;;
    0008_tenant_send_policies.sql)
      has_results "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tenant_send_policies'" && return 0
      ;;
    0009_billing_idempotency_guards.sql)
      has_results "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_tenant_credit_ledger_payment_receipt_unique'" &&
        has_results "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_tenant_credit_ledger_reference_unique'" &&
        return 0
      ;;
    0010_payment_proof_fingerprint.sql)
      has_results "SELECT name FROM pragma_table_info('tenant_payment_receipts') WHERE name = 'payment_proof_fingerprint'" &&
        has_results "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_tenant_payment_receipts_payment_proof_fingerprint_unique'" &&
        return 0
      ;;
    0011_messages_internet_message_id_index.sql)
      has_results "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_mailbox_internet_message_id'" &&
        return 0
      ;;
  esac

  return 1
}

require_cmd jq
require_cmd wrangler

cd "$REPO_ROOT"

echo "Preparing D1 migrations for target: $TARGET"
ensure_schema_migrations_table

for migration_id in "${MIGRATIONS[@]}"; do
  migration_path="./migrations/$migration_id"

  if migration_already_marked "$migration_id"; then
    echo "Skipping already recorded migration: $migration_id"
    continue
  fi

  if bootstrap_migration_if_needed "$migration_id"; then
    echo "Recording existing schema as already migrated: $migration_id"
    mark_migration_applied "$migration_id"
    continue
  fi

  echo "Applying migration: $migration_id"
  exec_file "$migration_path"
  mark_migration_applied "$migration_id"
done

echo "D1 migrations are up to date for target: $TARGET"
