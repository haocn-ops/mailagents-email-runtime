#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.dev.vars"
KEY="CLOUDFLARE_API_TOKEN"

touch "$ENV_FILE"

printf "Enter %s: " "$KEY" >&2
read -r -s TOKEN
printf "\n" >&2

if [[ -z "$TOKEN" ]]; then
  echo "No token provided." >&2
  exit 1
fi

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

if [[ -f "$ENV_FILE" ]]; then
  grep -v "^${KEY}=" "$ENV_FILE" > "$TMP_FILE" || true
fi

printf "%s=%s\n" "$KEY" "$TOKEN" >> "$TMP_FILE"
mv "$TMP_FILE" "$ENV_FILE"

echo "Saved ${KEY} to ${ENV_FILE}."
echo "Verify with:"
echo "  grep '^${KEY}=' \"$ENV_FILE\""
