#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PROFILE="${1:-}"

usage() {
  echo "Usage: $0 sqlite-test|dev-sqlite|dev-postgres|prod-ha-yugabyte|prod-ha-cockroach"
}

profile_file() {
  case "$PROFILE" in
    sqlite-test)
      echo "deploy/profiles/sqlite-test.env.example"
      ;;
    dev-sqlite)
      echo "deploy/profiles/dev-sqlite.env.example"
      ;;
    dev-postgres)
      echo "deploy/profiles/dev-postgres.env.example"
      ;;
    prod-ha-yugabyte)
      echo "deploy/profiles/prod-ha-yugabyte.env.example"
      ;;
    prod-ha-cockroach)
      echo "deploy/profiles/prod-ha-cockroach.env.example"
      ;;
    *)
      usage
      exit 2
      ;;
  esac
}

env_value() {
  local file="$1"
  local key="$2"
  awk -F= -v key="$key" '
    $0 !~ /^[[:space:]]*#/ && $1 == key {
      sub(/^[^=]*=/, "")
      print
      exit
    }
  ' "$file"
}

require_key() {
  local file="$1"
  local key="$2"
  if ! grep -Eq "^[[:space:]]*${key}=" "$file"; then
    echo "Missing required key ${key} in ${file}"
    exit 1
  fi
}

require_value() {
  local file="$1"
  local key="$2"
  local expected="$3"
  require_key "$file" "$key"
  local actual
  actual="$(env_value "$file" "$key")"
  if [ "$actual" != "$expected" ]; then
    echo "Expected ${key}=${expected} in ${file}, got '${actual}'"
    exit 1
  fi
}

validate_common_keys() {
  local file="$1"
  for key in NODE_ENV PORT DATABASE_PROVIDER DATABASE_URL LIGHTWEIGHT_MODE IDMMW_PROCESSING_MODE KAFKA_ENABLED REDIS_ENABLED ADMIN_UI_ENABLED ADMIN_UI_SERVE_STATIC ADMIN_AUTH_ENABLED HTTP_TLS_ENABLED MOCK_IDM_ENABLED DebugLogging__Enabled DebugLogging__Level LOG_SINK ENCRYPTION_ENABLED; do
    require_key "$file" "$key"
  done
}

FILE="$(profile_file)"
validate_common_keys "$FILE"

case "$PROFILE" in
  sqlite-test)
    require_value "$FILE" DATABASE_PROVIDER sqlite
    require_value "$FILE" LIGHTWEIGHT_MODE true
    require_value "$FILE" IDMMW_PROCESSING_MODE sync
    require_value "$FILE" KAFKA_ENABLED false
    require_value "$FILE" REDIS_ENABLED false
    require_value "$FILE" ENCRYPTION_ENABLED false
    DATABASE_URL="file:/tmp/idmmw-profile-validate.db" npx prisma validate --schema=prisma/schema.sqlite.prisma
    ;;
  dev-sqlite)
    require_value "$FILE" NODE_ENV production
    require_value "$FILE" DATABASE_PROVIDER sqlite
    require_value "$FILE" LIGHTWEIGHT_MODE true
    require_value "$FILE" IDMMW_PROCESSING_MODE sync
    require_value "$FILE" KAFKA_ENABLED false
    require_value "$FILE" REDIS_ENABLED false
    require_value "$FILE" ADMIN_UI_ENABLED true
    require_value "$FILE" ADMIN_UI_SERVE_STATIC true
    require_value "$FILE" ADMIN_AUTH_ENABLED false
    require_value "$FILE" HTTP_TLS_ENABLED false
    require_value "$FILE" DebugLogging__Enabled false
    require_value "$FILE" DebugLogging__Level Basic
    require_value "$FILE" LOG_SINK stdout
    require_value "$FILE" ENCRYPTION_ENABLED false
    DATABASE_URL="file:/tmp/idmmw-profile-validate.db" npx prisma validate --schema=prisma/schema.sqlite.prisma
    ;;
  dev-postgres)
    require_value "$FILE" NODE_ENV production
    require_value "$FILE" DATABASE_PROVIDER postgresql
    require_value "$FILE" DATABASE_FLAVOR postgresql
    require_value "$FILE" LIGHTWEIGHT_MODE false
    require_value "$FILE" IDMMW_PROCESSING_MODE sync
    require_value "$FILE" KAFKA_ENABLED false
    require_value "$FILE" REDIS_ENABLED false
    require_value "$FILE" ADMIN_UI_ENABLED true
    require_value "$FILE" ADMIN_UI_SERVE_STATIC true
    require_value "$FILE" ADMIN_AUTH_ENABLED false
    require_value "$FILE" HTTP_TLS_ENABLED false
    require_value "$FILE" DebugLogging__Enabled false
    require_value "$FILE" DebugLogging__Level Basic
    require_value "$FILE" LOG_SINK stdout
    require_value "$FILE" ENCRYPTION_ENABLED false
    DATABASE_URL="${DATABASE_URL:-postgresql://idmmw:REPLACE_WITH_LOCAL_DB_CREDENTIAL@localhost:5432/idmmw}" npx prisma validate --schema=prisma/schema.prisma
    ;;
  prod-ha-yugabyte)
    require_value "$FILE" DATABASE_PROVIDER postgresql
    require_value "$FILE" DATABASE_FLAVOR yugabytedb
    require_value "$FILE" LIGHTWEIGHT_MODE false
    require_value "$FILE" IDMMW_PROCESSING_MODE async
    require_value "$FILE" KAFKA_ENABLED true
    require_value "$FILE" ADMIN_AUTH_ENABLED true
    require_value "$FILE" ENCRYPTION_ENABLED true
    require_value "$FILE" HTTP_TLS_ENABLED true
    require_value "$FILE" INTEGRATION_AUTH_ENABLED true
    require_key "$FILE" INTEGRATION_AUTH_SECRET
    require_value "$FILE" METRICS_PUBLIC_ENABLED false
    require_value "$FILE" MOCK_IDM_ENABLED false
    require_value "$FILE" STATIC_CONNECTOR_ALLOWLIST ""
    require_value "$FILE" SECRETS_INDEEDPAMAAPM_TOKEN_TRANSPORT header
    require_value "$FILE" LOG_SINK file
    require_value "$FILE" LOG_FILE_PATH /app/logs/idmmw.log
    require_value "$FILE" LOG_EXTERNAL_SINK compose-logging-profile
    DATABASE_URL="${DATABASE_URL:-postgresql://idmmw:REPLACE_WITH_LOCAL_DB_CREDENTIAL@localhost:5432/idmmw}" npx prisma validate --schema=prisma/schema.prisma
    ;;
  prod-ha-cockroach)
    require_value "$FILE" DATABASE_PROVIDER postgresql
    require_value "$FILE" DATABASE_FLAVOR cockroachdb
    require_value "$FILE" LIGHTWEIGHT_MODE false
    require_value "$FILE" IDMMW_PROCESSING_MODE async
    require_value "$FILE" KAFKA_ENABLED true
    require_value "$FILE" ADMIN_AUTH_ENABLED true
    require_value "$FILE" ENCRYPTION_ENABLED true
    require_value "$FILE" HTTP_TLS_ENABLED true
    require_value "$FILE" INTEGRATION_AUTH_ENABLED true
    require_key "$FILE" INTEGRATION_AUTH_SECRET
    require_value "$FILE" METRICS_PUBLIC_ENABLED false
    require_value "$FILE" MOCK_IDM_ENABLED false
    require_value "$FILE" STATIC_CONNECTOR_ALLOWLIST ""
    require_value "$FILE" SECRETS_INDEEDPAMAAPM_TOKEN_TRANSPORT header
    require_value "$FILE" LOG_SINK file
    require_value "$FILE" LOG_FILE_PATH /app/logs/idmmw.log
    require_value "$FILE" LOG_EXTERNAL_SINK compose-logging-profile
    require_value "$FILE" PRISMA_SCHEMA prisma/schema.cockroach.prisma
    DATABASE_URL="${DATABASE_URL:-postgresql://root@localhost:26257/defaultdb?sslmode=require}" npx prisma validate --schema=prisma/schema.cockroach.prisma
    ;;
esac

echo "Deployment profile ${PROFILE} is valid"
