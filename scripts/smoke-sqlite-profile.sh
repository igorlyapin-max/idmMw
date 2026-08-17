#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PROFILE_FILE="deploy/profiles/sqlite-test.env.example"
PORT="${PORT:-3211}"
RUNTIME_PORT="$PORT"
DB_PATH="${IDMMW_PROFILE_SQLITE_DB_PATH:-/tmp/idmmw-profile-sqlite-$$.db}"
DB_URL="file:${DB_PATH}"
LOG_PATH="${IDMMW_PROFILE_SQLITE_LOG_PATH:-/tmp/idmmw-profile-sqlite-$$.log}"
STDOUT_PATH="${IDMMW_PROFILE_SQLITE_STDOUT_PATH:-/tmp/idmmw-profile-sqlite-stdout-$$.log}"
RESPONSE_PATH="${IDMMW_PROFILE_SQLITE_RESPONSE_PATH:-/tmp/idmmw-profile-sqlite-response-$$.json}"
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
    cockroachdb)
      DATABASE_URL="postgresql://root@localhost:26257/defaultdb?sslmode=require" npx prisma generate --schema=prisma/schema.cockroach.prisma >/dev/null 2>&1 || true
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

echo "[1/7] Validating sqlite-test profile contract"
bash scripts/validate-deployment-profile.sh sqlite-test

echo "[2/7] Generating Prisma client for SQLite"
DATABASE_URL="$DB_URL" npx prisma generate --schema=prisma/schema.sqlite.prisma

echo "[3/7] Preparing SQLite database at $DB_PATH"
DATABASE_URL="$DB_URL" npx prisma db push --schema=prisma/schema.sqlite.prisma --skip-generate

echo "[4/7] Building application"
npm run build

echo "[5/7] Starting one-worker sqlite-test profile on port $PORT"
set -a
source "$PROFILE_FILE"
set +a
DATABASE_PROVIDER=sqlite \
DATABASE_URL="$DB_URL" \
LIGHTWEIGHT_MODE=true \
PORT="$RUNTIME_PORT" \
LOG_FILE_PATH="$LOG_PATH" \
node dist/main >"$STDOUT_PATH" 2>&1 &
APP_PID="$!"

echo "[6/7] Waiting for health and metrics"
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${RUNTIME_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$APP_PID" >/dev/null 2>&1; then
    echo "Runtime exited before health became available"
    cat "$STDOUT_PATH" || true
    exit 1
  fi
  sleep 0.5
done

curl -fsS "http://127.0.0.1:${RUNTIME_PORT}/health" | grep -q '"status":"ok"'
curl -fsS "http://127.0.0.1:${RUNTIME_PORT}/about" | grep -q '"build"'
curl -fsS "http://127.0.0.1:${RUNTIME_PORT}/metrics" | grep -q "idmmw_http_requests_total"

echo "[7/7] Checking webhook, diagnostics, redaction and file sink"
curl -fsS \
  -H "Content-Type: application/json" \
  -d '{"eventId":"profile-sqlite-smoke-'$$'","operation":"user.create","targetSystem":"fake","payload":{"data":{"username":"profile-sqlite","password":"plain-credential","token":"plain-marker"}}}' \
  "http://127.0.0.1:${RUNTIME_PORT}/webhooks/avanpost" >"$RESPONSE_PATH"

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

echo "sqlite-test deployment profile smoke PASSED"
