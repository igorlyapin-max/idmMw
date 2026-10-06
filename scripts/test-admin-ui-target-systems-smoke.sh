#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-3211}"
DB_PATH="${IDMMW_UI_SMOKE_DB_PATH:-/tmp/idmmw-ui-smoke-$$.db}"
DB_URL="file:${DB_PATH}"
STDOUT_PATH="${IDMMW_UI_SMOKE_STDOUT_PATH:-/tmp/idmmw-ui-smoke-stdout-$$.log}"
APP_PID=""
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
  if [ -n "$APP_PID" ] && kill -0 "$APP_PID" >/dev/null 2>&1; then
    kill "$APP_PID" >/dev/null 2>&1 || true
    wait "$APP_PID" >/dev/null 2>&1 || true
  fi
  rm -f "$DB_PATH" "${DB_PATH}-journal" "$STDOUT_PATH"
  restore_prisma_client
}
trap cleanup EXIT INT TERM

echo "[1/6] Generating Prisma client for SQLite UI smoke"
DATABASE_URL="$DB_URL" npx prisma generate --schema=prisma/schema.sqlite.prisma

GENERATED_PROVIDER="$(awk -F'"' '
  /^[[:space:]]*datasource[[:space:]]+db[[:space:]]*\{/ { in_db = 1; next }
  in_db && /^[[:space:]]*provider[[:space:]]*=/ { print $2; exit }
' node_modules/.prisma/client/schema.prisma)"
if [ "$GENERATED_PROVIDER" != "sqlite" ]; then
  echo "Expected generated Prisma client provider sqlite, got ${GENERATED_PROVIDER:-unknown}"
  exit 1
fi

echo "[2/6] Preparing SQLite UI smoke database at $DB_PATH"
DATABASE_URL="$DB_URL" npx prisma db push --schema=prisma/schema.sqlite.prisma --skip-generate

echo "[3/6] Building Admin UI"
npm --prefix ui run build

echo "[4/6] Building backend"
npm run build >/dev/null

echo "[5/6] Starting runtime with Admin UI on port $PORT"
DATABASE_PROVIDER=sqlite \
DATABASE_URL="$DB_URL" \
LIGHTWEIGHT_MODE=true \
NODE_ENV=development \
PORT="$PORT" \
REDIS_ENABLED=false \
KAFKA_ENABLED=false \
ADMIN_UI_ENABLED=true \
ADMIN_AUTH_ENABLED=false \
MOCK_IDM_ENABLED=false \
node dist/main >"$STDOUT_PATH" 2>&1 &
APP_PID="$!"

for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$APP_PID" >/dev/null 2>&1; then
    echo "Runtime exited before health became available"
    cat "$STDOUT_PATH" || true
    exit 1
  fi
  sleep 0.5
done
curl -fsS "http://127.0.0.1:${PORT}/target-systems" >/dev/null

echo "[6/6] Running browser smoke"
IDMMW_UI_SMOKE_BASE_URL="http://127.0.0.1:${PORT}" \
  node scripts/admin-ui-target-systems-smoke.mjs

echo "Admin UI target systems smoke PASSED"
