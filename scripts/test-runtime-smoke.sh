#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-3210}"
DB_PATH="${IDMMW_SMOKE_DB_PATH:-/tmp/idmmw-smoke-$$.db}"
DB_URL="file:${DB_PATH}"
LOG_PATH="${IDMMW_SMOKE_LOG_PATH:-/tmp/idmmw-smoke-$$.log}"
STDOUT_PATH="${IDMMW_SMOKE_STDOUT_PATH:-/tmp/idmmw-smoke-stdout-$$.log}"
RESPONSE_PATH="${IDMMW_SMOKE_RESPONSE_PATH:-/tmp/idmmw-smoke-response-$$.json}"
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
  rm -f "$DB_PATH" "${DB_PATH}-journal" "$LOG_PATH" "$STDOUT_PATH" "$RESPONSE_PATH"
  restore_prisma_client
}
trap cleanup EXIT INT TERM

echo "[1/6] Generating Prisma client for SQLite runtime smoke"
DATABASE_URL="$DB_URL" npx prisma generate --schema=prisma/schema.sqlite.prisma

echo "[2/6] Preparing SQLite smoke database at $DB_PATH"
DATABASE_URL="$DB_URL" npx prisma db push --schema=prisma/schema.sqlite.prisma --skip-generate

echo "[3/6] Building application"
npm run build

echo "[4/6] Starting runtime with Verbose diagnostics and file log sink on port $PORT"
DATABASE_PROVIDER=sqlite \
DATABASE_URL="$DB_URL" \
LIGHTWEIGHT_MODE=true \
NODE_ENV=development \
PORT="$PORT" \
REDIS_ENABLED=false \
KAFKA_ENABLED=false \
ADMIN_UI_ENABLED=false \
MOCK_IDM_ENABLED=false \
DebugLogging__Enabled=true \
DebugLogging__Level=Verbose \
LOG_SINK=file \
LOG_FILE_PATH="$LOG_PATH" \
node dist/main >"$STDOUT_PATH" 2>&1 &
APP_PID="$!"

echo "[5/6] Waiting for /health"
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

curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null
curl -fsS "http://127.0.0.1:${PORT}/about" | grep -q '"build"'
curl -fsS "http://127.0.0.1:${PORT}/metrics" | grep -q "idmmw_http_requests_total"

echo "[6/6] Checking IDM webhook, diagnostics, redaction, and second log sink"
curl -fsS \
  -H "Content-Type: application/json" \
  -d '{"eventId":"runtime-smoke-'$$'","operation":"user.create","targetSystem":"fake","payload":{"data":{"username":"runtime-smoke","password":"plain-credential","token":"plain-marker"}}}' \
  "http://127.0.0.1:${PORT}/webhooks/avanpost" >"$RESPONSE_PATH"

grep -q '"received":true' "$RESPONSE_PATH"
grep -q '"processed":true' "$RESPONSE_PATH"

sleep 0.5

grep -q '"event":"startup.runtime"' "$LOG_PATH"
grep -q '"event":"idm.webhook.received"' "$LOG_PATH"
grep -q '"event":"idm.webhook.payload"' "$LOG_PATH"
grep -q '\[REDACTED\]' "$LOG_PATH"

if grep -q 'plain-credential\|plain-marker' "$LOG_PATH"; then
  echo "Sensitive diagnostic payload leaked to $LOG_PATH"
  exit 1
fi

echo "Runtime smoke PASSED"
