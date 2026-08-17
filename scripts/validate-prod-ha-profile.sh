#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_FLAVOR="${1:-yugabyte}"
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
    cockroachdb)
      DATABASE_URL="postgresql://root@localhost:26257/defaultdb?sslmode=require" npx prisma generate --schema=prisma/schema.cockroach.prisma >/dev/null 2>&1 || true
      ;;
  esac
}
trap restore_prisma_client EXIT

case "$DB_FLAVOR" in
  yugabyte | yugabytedb)
    PROFILE="prod-ha-yugabyte"
    SCHEMA="prisma/schema.prisma"
    DEFAULT_DATABASE_URL="postgresql://idmmw:REPLACE_WITH_LOCAL_DB_CREDENTIAL@localhost:5432/idmmw"
    ;;
  cockroach | cockroachdb)
    PROFILE="prod-ha-cockroach"
    SCHEMA="prisma/schema.cockroach.prisma"
    DEFAULT_DATABASE_URL="postgresql://root@localhost:26257/defaultdb?sslmode=require"
    ;;
  *)
    echo "Usage: $0 yugabyte|cockroach"
    exit 2
    ;;
esac

echo "[1/4] Validating ${PROFILE} env contract"
bash scripts/validate-deployment-profile.sh "$PROFILE"

echo "[2/4] Validating Prisma schema ${SCHEMA}"
DATABASE_URL="${DATABASE_URL:-$DEFAULT_DATABASE_URL}" npx prisma validate --schema="$SCHEMA"

echo "[3/4] Generating Prisma client for ${DB_FLAVOR}"
DATABASE_URL="${DATABASE_URL:-$DEFAULT_DATABASE_URL}" npx prisma generate --schema="$SCHEMA"

echo "[4/4] Building application with generated client"
npm run build

echo "[5/5] Validating production logging profile"
COMPOSE_CONFIG_OUTPUT="$(docker compose -f deploy/docker-compose.prod-ha.yml --profile logging config)"
printf '%s\n' "$COMPOSE_CONFIG_OUTPUT" | grep -q 'idmmw-log-forwarder:'
printf '%s\n' "$COMPOSE_CONFIG_OUTPUT" | grep -q 'idmmw_logs:'

echo "Production HA profile ${DB_FLAVOR} validated"
