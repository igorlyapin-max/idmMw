#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-3220}"
REDIS_CONTAINER="${IDMMW_TEST_REDIS_CONTAINER:-servicedesk-agents-redis}"
REDIS_HOST="${IDMMW_TEST_REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${IDMMW_TEST_REDIS_PORT:-16379}"
KAFKA_CONTAINER="${IDMMW_TEST_KAFKA_CONTAINER:-kafka}"
KAFKA_BROKERS="${IDMMW_TEST_KAFKA_BROKERS:-127.0.0.1:9092}"
KAFKA_INTERNAL_BROKERS="${IDMMW_TEST_KAFKA_INTERNAL_BROKERS:-kafka:29092}"
KAFKA_BIN="${IDMMW_TEST_KAFKA_BIN:-/opt/kafka/bin}"
TOPIC_IN="${IDMMW_TEST_TOPIC_IN:-idmmw.test.events.in}"
TOPIC_OUT="${IDMMW_TEST_TOPIC_OUT:-idmmw.test.events.out}"
TOPIC_RETRY="${IDMMW_TEST_TOPIC_RETRY:-idmmw.test.dlq.retry}"
RUN_ID="${IDMMW_TEST_RUN_ID:-$(date +%s)-$$}"
GROUP_ID="idmmw-test-worker-${RUN_ID}"
DB_PATH="${IDMMW_HA_DB_PATH:-/tmp/idmmw-ha-${RUN_ID}.db}"
DB_URL="file:${DB_PATH}"
LOG_PATH="${IDMMW_HA_LOG_PATH:-/tmp/idmmw-ha-${RUN_ID}.log}"
STDOUT_PATH="${IDMMW_HA_STDOUT_PATH:-/tmp/idmmw-ha-stdout-${RUN_ID}.log}"
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

stop_app() {
  if [ -n "$APP_PID" ] && kill -0 "$APP_PID" >/dev/null 2>&1; then
    kill "$APP_PID" >/dev/null 2>&1 || true
    wait "$APP_PID" >/dev/null 2>&1 || true
  fi
  APP_PID=""
}

cleanup() {
  stop_app
  docker exec "$REDIS_CONTAINER" redis-cli DEL "avanpost:fake:idmmw-ha-redis-${RUN_ID}" "avanpost:fake:idmmw-ha-async-${RUN_ID}" >/dev/null 2>&1 || true
  rm -f "$DB_PATH" "${DB_PATH}-journal" "$LOG_PATH" "$STDOUT_PATH"
  restore_prisma_client
}
trap cleanup EXIT INT TERM

wait_for_health() {
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$APP_PID" >/dev/null 2>&1; then
      echo "Runtime exited before health became available"
      cat "$STDOUT_PATH" || true
      exit 1
    fi
    sleep 0.5
  done
  echo "Health endpoint did not become available"
  cat "$STDOUT_PATH" || true
  exit 1
}

start_app() {
  local mode="$1"
  stop_app
  DATABASE_PROVIDER=sqlite \
  DATABASE_URL="$DB_URL" \
  LIGHTWEIGHT_MODE=true \
  NODE_ENV=development \
  PORT="$PORT" \
  REDIS_ENABLED=true \
  REDIS_HOST="$REDIS_HOST" \
  REDIS_PORT="$REDIS_PORT" \
  KAFKA_ENABLED=true \
  KAFKA_BROKERS="$KAFKA_BROKERS" \
  KAFKA_CONSUMER_GROUP_ID="$GROUP_ID" \
  KAFKA_TOPIC_EVENTS_IN="$TOPIC_IN" \
  KAFKA_TOPIC_EVENTS_OUT="$TOPIC_OUT" \
  KAFKA_TOPIC_DLQ_RETRY="$TOPIC_RETRY" \
  IDMMW_PROCESSING_MODE="$mode" \
  ADMIN_UI_ENABLED=false \
  MOCK_IDM_ENABLED=false \
  DebugLogging__Enabled=true \
  DebugLogging__Level=Basic \
  LOG_SINK=file \
  LOG_FILE_PATH="$LOG_PATH" \
  node dist/main >"$STDOUT_PATH" 2>&1 &
  APP_PID="$!"
  wait_for_health
}

post_webhook() {
  local event_id="$1"
  curl -fsS \
    -H "Content-Type: application/json" \
    -d "{\"eventId\":\"${event_id}\",\"operation\":\"user.create\",\"targetSystem\":\"fake\",\"payload\":{\"data\":{\"username\":\"${event_id}\"}}}" \
    "http://127.0.0.1:${PORT}/webhooks/avanpost"
}

wait_for_kafka_event() {
  local topic="$1"
  local event_id="$2"
  local output_path="/tmp/idmmw-kafka-${RUN_ID}-${topic}.log"
  timeout 20s docker exec "$KAFKA_CONTAINER" "${KAFKA_BIN}/kafka-console-consumer.sh" \
      --bootstrap-server "$KAFKA_INTERNAL_BROKERS" \
      --topic "$topic" \
      --from-beginning \
      --timeout-ms 20000 >"$output_path" 2>/dev/null || true
  if ! grep -q "$event_id" "$output_path"; then
    echo "Expected Kafka event $event_id was not found in topic $topic"
    echo "--- consumed Kafka messages from $topic ---"
    cat "$output_path" || true
    echo "--- app stdout ---"
    cat "$STDOUT_PATH" || true
    echo "--- app diagnostics ---"
    cat "$LOG_PATH" || true
    rm -f "$output_path"
    return 1
  fi
  rm -f "$output_path"
}

echo "[1/8] Checking live Redis container $REDIS_CONTAINER (run $RUN_ID)"
docker inspect -f '{{.State.Running}}' "$REDIS_CONTAINER" | grep -q true
docker exec "$REDIS_CONTAINER" redis-cli PING | grep -q PONG

echo "[2/8] Checking live Kafka container $KAFKA_CONTAINER"
docker inspect -f '{{.State.Running}}' "$KAFKA_CONTAINER" | grep -q true
docker exec "$KAFKA_CONTAINER" "${KAFKA_BIN}/kafka-topics.sh" --bootstrap-server "$KAFKA_INTERNAL_BROKERS" --list >/dev/null
for topic in "$TOPIC_IN" "$TOPIC_OUT" "$TOPIC_RETRY"; do
  docker exec "$KAFKA_CONTAINER" "${KAFKA_BIN}/kafka-topics.sh" \
    --bootstrap-server "$KAFKA_INTERNAL_BROKERS" \
    --create \
    --if-not-exists \
    --topic "$topic" >/dev/null
done

echo "[3/8] Preparing isolated SQLite database"
DATABASE_URL="$DB_URL" npx prisma generate --schema=prisma/schema.sqlite.prisma >/dev/null
DATABASE_URL="$DB_URL" npx prisma db push --schema=prisma/schema.sqlite.prisma --skip-generate >/dev/null

echo "[4/8] Building application"
npm run build >/dev/null

echo "[5/8] Starting sync mode with real Redis and Kafka"
start_app sync
curl -fsS "http://127.0.0.1:${PORT}/ready" | grep -q '"redis"'

echo "[6/8] Verifying Redis idempotency against live Redis"
REDIS_EVENT_ID="idmmw-ha-redis-${RUN_ID}"
post_webhook "$REDIS_EVENT_ID" | grep -q '"processed":true'
post_webhook "$REDIS_EVENT_ID" | grep -q '"processed":false'
docker exec "$REDIS_CONTAINER" redis-cli GET "avanpost:fake:${REDIS_EVENT_ID}" | grep -q '1'
TTL_VALUE="$(docker exec "$REDIS_CONTAINER" redis-cli TTL "avanpost:fake:${REDIS_EVENT_ID}")"
if [ "$TTL_VALUE" -le 0 ]; then
  echo "Expected Redis idempotency key TTL to be positive, got $TTL_VALUE"
  exit 1
fi
wait_for_kafka_event "$TOPIC_OUT" "$REDIS_EVENT_ID"

echo "[7/8] Starting async mode with real Kafka worker"
start_app async
ASYNC_EVENT_ID="idmmw-ha-async-${RUN_ID}"
post_webhook "$ASYNC_EVENT_ID" | grep -q '"processed":true'
wait_for_kafka_event "$TOPIC_IN" "$ASYNC_EVENT_ID"
wait_for_kafka_event "$TOPIC_OUT" "$ASYNC_EVENT_ID"

echo "[8/8] Checking diagnostics log sink"
grep -q '"event":"startup.runtime"' "$LOG_PATH"

echo "HA live smoke PASSED"
