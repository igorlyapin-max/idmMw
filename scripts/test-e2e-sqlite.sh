#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_PATH="${IDMMW_E2E_DB_PATH:-/tmp/idmmw-e2e-$$.db}"
DB_URL="file:${DB_PATH}"
CURRENT_PROVIDER=""

if [ -f node_modules/.prisma/client/schema.prisma ]; then
  CURRENT_PROVIDER="$(awk -F'"' '
    /^[[:space:]]*datasource[[:space:]]+db[[:space:]]*\{/ { in_db = 1; next }
    in_db && /^[[:space:]]*provider[[:space:]]*=/ { print $2; exit }
  ' node_modules/.prisma/client/schema.prisma)"
fi

restore_prisma_client() {
  case "$CURRENT_PROVIDER" in
    postgresql)
      npx prisma generate --schema=prisma/schema.prisma >/dev/null 2>&1 || true
      ;;
    sqlite)
      DATABASE_URL="file:/tmp/idmmw-prisma-restore.db" npx prisma generate --schema=prisma/schema.sqlite.prisma >/dev/null 2>&1 || true
      ;;
  esac
}

cleanup() {
  rm -f "$DB_PATH" "${DB_PATH}-journal"
  restore_prisma_client
}
trap cleanup EXIT

echo "[1/3] Generating Prisma client for SQLite e2e"
DATABASE_URL="$DB_URL" npx prisma generate --schema=prisma/schema.sqlite.prisma

echo "[2/3] Preparing SQLite e2e database at $DB_PATH"
DATABASE_URL="$DB_URL" npx prisma db push --schema=prisma/schema.sqlite.prisma --skip-generate

echo "[3/3] Running e2e contract tests"
DATABASE_PROVIDER=sqlite \
DATABASE_URL="$DB_URL" \
LIGHTWEIGHT_MODE=true \
NODE_ENV=test \
npx jest --config ./test/jest-e2e.json --runInBand --detectOpenHandles "$@"
