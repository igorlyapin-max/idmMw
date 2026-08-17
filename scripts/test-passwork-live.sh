#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PASSWORK_URL_FILE="${PASSWORK_URL_FILE:-../passwork/url.passwork}"
PASSWORK_API_FILE="${PASSWORK_API_FILE:-../passwork/api.passwork}"
PASSWORK_ADMIN_CREDENTIALS_FILE="${PASSWORK_ADMIN_CREDENTIALS_FILE:-../passwork/passwork-admin-credentials.txt}"
PORT="${PORT:-3213}"
TARGET_SYSTEM="${PASSWORK_TARGET_SYSTEM:-passwork-local}"
RUN_ID="${PASSWORK_LIVE_RUN_ID:-$(date +%Y%m%d%H%M%S)-$$}"
PASSWORK_LIVE_CLEANUP="${PASSWORK_LIVE_CLEANUP:-always}"
REPORT_PATH="${PASSWORK_LIVE_REPORT_PATH:-}"
DB_PATH="${IDMMW_PASSWORK_DB_PATH:-/tmp/idmmw-passwork-${RUN_ID}.db}"
DB_URL="file:${DB_PATH}"
LOG_PATH="${IDMMW_PASSWORK_LOG_PATH:-/tmp/idmmw-passwork-${RUN_ID}.log}"
STDOUT_PATH="${IDMMW_PASSWORK_STDOUT_PATH:-/tmp/idmmw-passwork-stdout-${RUN_ID}.log}"
TMP_DIR="${IDMMW_PASSWORK_TMP_DIR:-/tmp/idmmw-passwork-${RUN_ID}}"
APP_PID=""
CURRENT_PROVIDER=""
PASSWORK_BASE_URL=""
PASSWORK_TOKEN=""
PASSWORK_REFRESH_TOKEN=""
PASSWORK_ADMIN_PASSWORD=""
TARGET_SYSTEM_ID=""
TEST_USER_ID=""
TEST_GROUP_ID=""
TEST_LOGIN="idmmw-live-${RUN_ID}"
TEST_EMAIL="${TEST_LOGIN}@example.local"
TEST_PASSWORD="Passwork-${RUN_ID}-Password1!"
TEST_GROUP="idmmw-live-group-${RUN_ID}"
TEST_GROUP_UPDATED="${TEST_GROUP}-updated"

mkdir -p "$TMP_DIR"

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

redact() {
  local input="${1:-}"
  if [ -n "${PASSWORK_TOKEN:-}" ]; then
    input="${input//$PASSWORK_TOKEN/[REDACTED_TOKEN]}"
  fi
  if [ -n "${PASSWORK_REFRESH_TOKEN:-}" ]; then
    input="${input//$PASSWORK_REFRESH_TOKEN/[REDACTED_REFRESH_TOKEN]}"
  fi
  if [ -n "${PASSWORK_ADMIN_PASSWORD:-}" ]; then
    input="${input//$PASSWORK_ADMIN_PASSWORD/[REDACTED_ADMIN_PASSWORD]}"
  fi
  input="${input//$TEST_PASSWORD/[REDACTED_PASSWORD]}"
  printf '%s' "$input"
}

redact_file() {
  local file="$1"
  if [ -s "$file" ]; then
    redact "$(head -c 2000 "$file")"
  fi
}

keep_artifacts() {
  [ "${IDMMW_LIVE_KEEP_ARTIFACTS:-false}" = "true" ] || [ "$PASSWORK_LIVE_CLEANUP" = "never" ]
}

write_report() {
  if [ -z "$REPORT_PATH" ]; then
    return 0
  fi
  REPORT_PATH="$REPORT_PATH" \
    RUN_ID="$RUN_ID" \
    TARGET_SYSTEM="$TARGET_SYSTEM" \
    TEST_LOGIN="$TEST_LOGIN" \
    TEST_EMAIL="$TEST_EMAIL" \
    TEST_USER_ID="$TEST_USER_ID" \
    TEST_GROUP="$TEST_GROUP" \
    TEST_GROUP_UPDATED="$TEST_GROUP_UPDATED" \
    TEST_GROUP_ID="$TEST_GROUP_ID" \
    CLEANUP_MODE="$PASSWORK_LIVE_CLEANUP" \
    node -e '
const fs = require("fs");
const report = {
  runId: process.env.RUN_ID,
  targetSystem: process.env.TARGET_SYSTEM,
  type: "passwork",
  cleanupMode: process.env.CLEANUP_MODE,
  user: {
    login: process.env.TEST_LOGIN,
    email: process.env.TEST_EMAIL,
    id: process.env.TEST_USER_ID || null,
  },
  group: {
    name: process.env.TEST_GROUP,
    updatedName: process.env.TEST_GROUP_UPDATED,
    id: process.env.TEST_GROUP_ID || null,
  },
};
fs.writeFileSync(process.env.REPORT_PATH, JSON.stringify(report, null, 2));
'
}

cleanup_passwork_direct() {
  local method="$1"
  local path="$2"
  local out="$TMP_DIR/direct-cleanup.json"
  if [ -z "${PASSWORK_BASE_URL:-}" ] || [ -z "${PASSWORK_TOKEN:-}" ]; then
    return 0
  fi
  curl -k -sS -o "$out" \
    -X "$method" \
    -H "Authorization: Bearer ${PASSWORK_TOKEN}" \
    -H "X-Response-Format: raw" \
    "${PASSWORK_BASE_URL%/}/api/v1${path}" >/dev/null 2>&1 || true
}

cleanup() {
  if ! keep_artifacts && [ -n "${TEST_GROUP_ID:-}" ]; then
    cleanup_passwork_direct DELETE "/user-groups/${TEST_GROUP_ID}"
  fi
  if ! keep_artifacts && [ -n "${TEST_USER_ID:-}" ]; then
    cleanup_passwork_direct DELETE "/users/${TEST_USER_ID}"
  fi
  if [ -n "$APP_PID" ] && kill -0 "$APP_PID" >/dev/null 2>&1; then
    kill "$APP_PID" >/dev/null 2>&1 || true
    wait "$APP_PID" >/dev/null 2>&1 || true
  fi
  rm -f "$DB_PATH" "${DB_PATH}-journal" "$LOG_PATH" "$STDOUT_PATH"
  rm -rf "$TMP_DIR"
  restore_prisma_client
}
trap cleanup EXIT INT TERM

fail() {
  echo "Passwork live smoke FAILED: $1" >&2
  if [ -s "$STDOUT_PATH" ]; then
    echo "--- idmMw stdout tail ---" >&2
    redact "$(tail -n 80 "$STDOUT_PATH")" >&2
  fi
  exit 1
}

json_get() {
  local file="$1"
  local expr="$2"
  node -e '
const fs = require("fs");
const file = process.argv[1];
const expr = process.argv[2];
const value = JSON.parse(fs.readFileSync(file, "utf8"));
const fn = new Function("value", `return (${expr});`);
const out = fn(value);
if (out === undefined || out === null || out === false) process.exit(2);
if (typeof out === "object") process.stdout.write(JSON.stringify(out));
else process.stdout.write(String(out));
' "$file" "$expr"
}

extract_id_by_field() {
  local file="$1"
  local field="$2"
  local expected="$3"
  node -e '
const fs = require("fs");
const [file, field, expected] = process.argv.slice(1);
const root = JSON.parse(fs.readFileSync(file, "utf8"));
const seen = new Set();
function visit(value) {
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  if (!Array.isArray(value) && value.id && value[field] === expected) return value.id;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = visit(item);
      if (found) return found;
    }
  } else {
    for (const item of Object.values(value)) {
      const found = visit(item);
      if (found) return found;
    }
  }
}
const id = visit(root);
if (!id) process.exit(2);
process.stdout.write(String(id));
' "$file" "$field" "$expected"
}

curl_json() {
  local method="$1"
  local url="$2"
  local body_file="${3:-}"
  local out_file="$4"
  local status_file="${out_file}.status"
  local args=(-k -sS -o "$out_file" -w "%{http_code}" -X "$method" -H "Content-Type: application/json")
  if [ -n "$body_file" ]; then
    args+=(-d "@${body_file}")
  fi
  local status
  status="$(curl "${args[@]}" "$url" 2>"${out_file}.err" || true)"
  printf '%s' "$status" >"$status_file"
  if ! [[ "$status" =~ ^2[0-9][0-9]$ ]]; then
    echo "HTTP ${status} for ${method} ${url}" >&2
    if [ -s "${out_file}.err" ]; then
      redact_file "${out_file}.err" >&2
    fi
    if [ -s "$out_file" ]; then
      echo >&2
      redact_file "$out_file" >&2
      echo >&2
    fi
    return 1
  fi
}

idm_json() {
  local method="$1"
  local path="$2"
  local body_file="${3:-}"
  local out_file="$4"
  curl_json "$method" "http://127.0.0.1:${PORT}${path}" "$body_file" "$out_file"
}

passwork_json() {
  local method="$1"
  local path="$2"
  local body_file="${3:-}"
  local out_file="$4"
  local status_file="${out_file}.status"
  local args=(-k -sS -o "$out_file" -w "%{http_code}" -X "$method" -H "Authorization: Bearer ${PASSWORK_TOKEN}" -H "X-Response-Format: raw")
  if [ -n "$body_file" ]; then
    args+=(-H "Content-Type: application/json" -d "@${body_file}")
  fi
  local status
  status="$(curl "${args[@]}" "${PASSWORK_BASE_URL%/}/api/v1${path}" 2>"${out_file}.err" || true)"
  printf '%s' "$status" >"$status_file"
  if ! [[ "$status" =~ ^2[0-9][0-9]$ ]]; then
    echo "HTTP ${status} for Passwork ${method} ${path}" >&2
    if [ -s "${out_file}.err" ]; then
      redact_file "${out_file}.err" >&2
    fi
    if [ -s "$out_file" ]; then
      echo >&2
      redact_file "$out_file" >&2
      echo >&2
    fi
    return 1
  fi
}

try_passwork_access_token() {
  local token="$1"
  local out_file="$2"
  local status
  status="$(
    curl -k -sS -o "$out_file" -w "%{http_code}" \
      -X GET \
      -H "Authorization: Bearer ${token}" \
      -H "X-Response-Format: raw" \
      "${PASSWORK_BASE_URL%/}/api/v1/sessions/current/info" \
      2>"${out_file}.err" || true
  )"
  printf '%s' "$status" >"${out_file}.status"
  [[ "$status" =~ ^2[0-9][0-9]$ ]]
}

refresh_passwork_access_token() {
  local access_token="$1"
  local refresh_token="$2"
  local out_file="$3"
  local body_file="$TMP_DIR/passwork-refresh-body.json"
  local status
  REFRESH_TOKEN="$refresh_token" node -e '
process.stdout.write(JSON.stringify({ refreshToken: process.env.REFRESH_TOKEN }));
' >"$body_file"
  status="$(
    curl -k -sS -o "$out_file" -w "%{http_code}" \
      -X POST \
      -H "Authorization: Bearer ${access_token}" \
      -H "Content-Type: application/json" \
      -H "X-Response-Format: raw" \
      -d "@${body_file}" \
      "${PASSWORK_BASE_URL%/}/api/v1/sessions/refresh" \
      2>"${out_file}.err" || true
  )"
  printf '%s' "$status" >"${out_file}.status"
  if [[ "$status" =~ ^2[0-9][0-9]$ ]]; then
    PASSWORK_TOKEN="$(json_get "$out_file" "value.accessToken")" || return 1
    PASSWORK_REFRESH_TOKEN="$(json_get "$out_file" "value.refreshToken")" || true
    return 0
  fi
  return 1
}

login_passwork_admin() {
  local out_file="$1"
  if [ ! -s "$PASSWORK_ADMIN_CREDENTIALS_FILE" ]; then
    return 1
  fi

  local credentials_json
  credentials_json="$(
    PASSWORK_ADMIN_CREDENTIALS_FILE="$PASSWORK_ADMIN_CREDENTIALS_FILE" node -e '
const fs = require("fs");
const file = process.env.PASSWORK_ADMIN_CREDENTIALS_FILE;
const values = Object.fromEntries(
  fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf("=");
      return index === -1 ? [line, ""] : [line.slice(0, index), line.slice(index + 1)];
    }),
);
if (!values.LOGIN || !values.PASSWORD) process.exit(2);
process.stdout.write(JSON.stringify({ username: values.LOGIN, password: values.PASSWORD }));
'
  )" || return 1
  PASSWORK_ADMIN_PASSWORD="$(
    CREDENTIALS_JSON="$credentials_json" node -e '
const credentials = JSON.parse(process.env.CREDENTIALS_JSON);
process.stdout.write(credentials.password);
'
  )"
  printf '%s' "$credentials_json" >"$TMP_DIR/passwork-login-body.json"

  local status
  status="$(
    curl -k -sS -o "$out_file" -w "%{http_code}" \
      -X POST \
      -H "Content-Type: application/json" \
      -H "X-Response-Format: raw" \
      -d "@${TMP_DIR}/passwork-login-body.json" \
      "${PASSWORK_BASE_URL%/}/api/v1/users/login" \
      2>"${out_file}.err" || true
  )"
  printf '%s' "$status" >"${out_file}.status"
  if [[ "$status" =~ ^2[0-9][0-9]$ ]]; then
    PASSWORK_TOKEN="$(json_get "$out_file" "value.accessToken")" || return 1
    PASSWORK_REFRESH_TOKEN="$(json_get "$out_file" "value.refreshToken")" || true
    return 0
  fi
  return 1
}

print_passwork_auth_failure() {
  local file="$1"
  if [ -s "${file}.status" ]; then
    echo "HTTP $(cat "${file}.status") for Passwork auth preflight" >&2
  fi
  if [ -s "${file}.err" ]; then
    redact_file "${file}.err" >&2
  fi
  if [ -s "$file" ]; then
    echo >&2
    redact_file "$file" >&2
    echo >&2
  fi
}

write_empty_json() {
  local out_file="$1"
  printf '{}' >"$out_file"
}

webhook_json() {
  local operation="$1"
  local data_file="$2"
  local params_file="$3"
  local out_file="$4"
  local body_file="$TMP_DIR/webhook-${operation//./-}.json"
  node -e '
const fs = require("fs");
const [eventId, operation, targetSystem, dataFile, paramsFile] = process.argv.slice(1);
const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
const params = JSON.parse(fs.readFileSync(paramsFile, "utf8"));
process.stdout.write(JSON.stringify({
  eventId,
  operation,
  targetSystem,
  payload: {
    ...(Object.keys(data).length ? { data } : {}),
    ...(Object.keys(params).length ? { params } : {}),
  },
}));
' "passwork-${operation}-${RUN_ID}-$(date +%s%N)" "$operation" "$TARGET_SYSTEM" "$data_file" "$params_file" >"$body_file"
  idm_json POST "/webhooks/avanpost" "$body_file" "$out_file"
  json_get "$out_file" 'value.received === true && value.processed === true' >/dev/null
}

echo "[1/9] Reading local Passwork credentials without printing secrets"
if [ ! -s "$PASSWORK_URL_FILE" ]; then
  fail "missing ${PASSWORK_URL_FILE}"
fi
if [ ! -s "$PASSWORK_API_FILE" ]; then
  fail "missing ${PASSWORK_API_FILE}"
fi

PASSWORK_BASE_URL="$(
  PASSWORK_URL_FILE="$PASSWORK_URL_FILE" node -e '
const fs = require("fs");
const file = process.env.PASSWORK_URL_FILE;
const text = fs.readFileSync(file, "utf8");
const match = text.match(/https?:\/\/\S+/i);
if (!match) process.exit(2);
const raw = match[0].replace(/[),.;]+$/g, "");
const url = new URL(raw);
process.stdout.write(url.origin);
'
)"
PASSWORK_TOKEN="$(
  PASSWORK_API_FILE="$PASSWORK_API_FILE" node -e '
const fs = require("fs");
const file = process.env.PASSWORK_API_FILE;
const text = fs.readFileSync(file, "utf8").trim();
let accessToken = "";
let refreshToken = "";
try {
  const parsed = JSON.parse(text);
  if (parsed && typeof parsed === "object") {
    accessToken = String(parsed.accessToken ?? parsed.apiToken ?? parsed.token ?? "");
    refreshToken = String(parsed.refreshToken ?? "");
  }
} catch {
  accessToken = "";
}
if (!accessToken && !refreshToken) {
  accessToken = text.split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith("#")) ?? "";
}
if ((accessToken && /\s/.test(accessToken)) || (refreshToken && /\s/.test(refreshToken))) process.exit(2);
process.stdout.write(accessToken);
'
)"
PASSWORK_REFRESH_TOKEN="$(
  PASSWORK_API_FILE="$PASSWORK_API_FILE" node -e '
const fs = require("fs");
const text = fs.readFileSync(process.env.PASSWORK_API_FILE, "utf8").trim();
try {
  const parsed = JSON.parse(text);
  const refreshToken = parsed && typeof parsed === "object" ? String(parsed.refreshToken ?? "") : "";
  if (refreshToken && /\s/.test(refreshToken)) process.exit(2);
  process.stdout.write(refreshToken);
} catch {
  process.stdout.write("");
}
'
)"

echo "[2/9] Checking direct Passwork API reachability"
if ! try_passwork_access_token "$PASSWORK_TOKEN" "$TMP_DIR/passwork-session.json"; then
  if [ -n "$PASSWORK_REFRESH_TOKEN" ] &&
    refresh_passwork_access_token "$PASSWORK_TOKEN" "$PASSWORK_REFRESH_TOKEN" "$TMP_DIR/passwork-refresh.json" &&
    try_passwork_access_token "$PASSWORK_TOKEN" "$TMP_DIR/passwork-session.json"; then
    :
  elif login_passwork_admin "$TMP_DIR/passwork-login.json" &&
    try_passwork_access_token "$PASSWORK_TOKEN" "$TMP_DIR/passwork-session.json"; then
    echo "Using local Passwork admin login fallback for this smoke run"
  else
    print_passwork_auth_failure "$TMP_DIR/passwork-session.json"
    fail "Passwork session check failed"
  fi
fi
passwork_json GET "/user-roles" "" "$TMP_DIR/passwork-roles.json" || fail "Passwork user roles check failed"
USER_ROLE_ID="$(
  node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const items = Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : [];
const role = items.find((item) => item && item.isDefault && item.id) || items.find((item) => item && item.id);
if (role?.id) process.stdout.write(String(role.id));
' "$TMP_DIR/passwork-roles.json"
)"

echo "[3/9] Preparing temporary SQLite runtime"
DATABASE_URL="$DB_URL" npx prisma generate --schema=prisma/schema.sqlite.prisma >/dev/null
DATABASE_URL="$DB_URL" npx prisma db push --schema=prisma/schema.sqlite.prisma --skip-generate >/dev/null
npm run build >/dev/null

echo "[4/9] Starting idmMw runtime on port ${PORT}"
DATABASE_PROVIDER=sqlite \
DATABASE_URL="$DB_URL" \
LIGHTWEIGHT_MODE=true \
NODE_ENV=development \
PORT="$PORT" \
REDIS_ENABLED=false \
KAFKA_ENABLED=false \
ADMIN_UI_ENABLED=false \
ADMIN_AUTH_ENABLED=false \
MOCK_IDM_ENABLED=false \
DebugLogging__Enabled=false \
DebugLogging__Level=Basic \
LOG_SINK=file \
LOG_FILE_PATH="$LOG_PATH" \
node dist/main >"$STDOUT_PATH" 2>&1 &
APP_PID="$!"

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$APP_PID" >/dev/null 2>&1; then
    fail "idmMw exited before /health became available"
  fi
  sleep 0.5
done
curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null || fail "idmMw /health failed"
curl -fsS "http://127.0.0.1:${PORT}/metrics" | grep -q "idmmw_http_requests_total" || fail "idmMw /metrics missing idmmw_http_requests_total"

echo "[5/9] Creating Passwork TargetSystem"
TARGET_SYSTEM="$TARGET_SYSTEM" PASSWORK_BASE_URL="$PASSWORK_BASE_URL" PASSWORK_TOKEN="$PASSWORK_TOKEN" node -e '
const cfg = {
  name: process.env.TARGET_SYSTEM,
  type: "passwork",
  label: "Local Passwork Live",
  enabled: true,
  config: {
    baseUrl: process.env.PASSWORK_BASE_URL,
    accessToken: process.env.PASSWORK_TOKEN,
    responseFormat: "raw",
    timeout: 30000,
  },
};
process.stdout.write(JSON.stringify(cfg));
' >"$TMP_DIR/target-system.json"
idm_json POST "/admin/target-systems" "$TMP_DIR/target-system.json" "$TMP_DIR/target-system-response.json" || fail "TargetSystem create failed"
TARGET_SYSTEM_ID="$(json_get "$TMP_DIR/target-system-response.json" "value.id")" || fail "TargetSystem id missing"
idm_json POST "/admin/target-systems/${TARGET_SYSTEM_ID}/test" "" "$TMP_DIR/target-system-test.json" || fail "TargetSystem test failed"
json_get "$TMP_DIR/target-system-test.json" "value.success === true" >/dev/null || fail "TargetSystem test returned failure"

echo "[6/9] Checking schema and creating Passwork user"
idm_json GET "/idm/${TARGET_SYSTEM}/schema" "" "$TMP_DIR/schema.json" || fail "schema.get failed"
USER_ROLE_ID="$USER_ROLE_ID" TEST_LOGIN="$TEST_LOGIN" TEST_EMAIL="$TEST_EMAIL" TEST_PASSWORD="$TEST_PASSWORD" node -e '
const body = {
  login: process.env.TEST_LOGIN,
  email: process.env.TEST_EMAIL,
  fullName: `${process.env.TEST_LOGIN} Full Name`,
  password: process.env.TEST_PASSWORD,
};
if (process.env.USER_ROLE_ID) body.userRoleId = process.env.USER_ROLE_ID;
process.stdout.write(JSON.stringify(body));
' >"$TMP_DIR/user-create-data.json"
write_empty_json "$TMP_DIR/empty.json"
webhook_json user.create "$TMP_DIR/user-create-data.json" "$TMP_DIR/empty.json" "$TMP_DIR/user-create.json" || fail "user.create failed"
sleep 0.5
idm_json GET "/idm/${TARGET_SYSTEM}/users?filter=${TEST_LOGIN}&limit=10" "" "$TMP_DIR/user-search.json" || fail "user.search failed"
TEST_USER_ID="$(extract_id_by_field "$TMP_DIR/user-search.json" login "$TEST_LOGIN")" || fail "created user was not found by login"
idm_json GET "/idm/${TARGET_SYSTEM}/users/${TEST_USER_ID}" "" "$TMP_DIR/user-get.json" || fail "user.get failed"

echo "[7/9] Updating, blocking and unblocking Passwork user"
TEST_LOGIN="$TEST_LOGIN" node -e 'process.stdout.write(JSON.stringify({ fullName: `${process.env.TEST_LOGIN} Updated Name` }));' >"$TMP_DIR/user-update-data.json"
TEST_USER_ID="$TEST_USER_ID" node -e 'process.stdout.write(JSON.stringify({ id: process.env.TEST_USER_ID }));' >"$TMP_DIR/user-id-params.json"
webhook_json user.update "$TMP_DIR/user-update-data.json" "$TMP_DIR/user-id-params.json" "$TMP_DIR/user-update.json" || fail "user.update failed"
webhook_json user.disable "$TMP_DIR/empty.json" "$TMP_DIR/user-id-params.json" "$TMP_DIR/user-disable.json" || fail "user.disable failed"
webhook_json user.enable "$TMP_DIR/empty.json" "$TMP_DIR/user-id-params.json" "$TMP_DIR/user-enable.json" || fail "user.enable failed"

echo "[8/9] Creating Passwork group and testing membership"
TEST_GROUP="$TEST_GROUP" node -e 'process.stdout.write(JSON.stringify({ name: process.env.TEST_GROUP }));' >"$TMP_DIR/group-create-data.json"
webhook_json group.create "$TMP_DIR/group-create-data.json" "$TMP_DIR/empty.json" "$TMP_DIR/group-create.json" || fail "group.create failed"
sleep 0.5
idm_json GET "/idm/${TARGET_SYSTEM}/groups?filter=${TEST_GROUP}&limit=10" "" "$TMP_DIR/group-search.json" || fail "group.search failed"
TEST_GROUP_ID="$(extract_id_by_field "$TMP_DIR/group-search.json" name "$TEST_GROUP")" || fail "created group was not found by name"
idm_json GET "/idm/${TARGET_SYSTEM}/groups/${TEST_GROUP_ID}" "" "$TMP_DIR/group-get.json" || fail "group.get failed"
TEST_GROUP_UPDATED="$TEST_GROUP_UPDATED" node -e 'process.stdout.write(JSON.stringify({ name: process.env.TEST_GROUP_UPDATED }));' >"$TMP_DIR/group-update-data.json"
TEST_GROUP_ID="$TEST_GROUP_ID" node -e 'process.stdout.write(JSON.stringify({ id: process.env.TEST_GROUP_ID }));' >"$TMP_DIR/group-id-params.json"
TEST_GROUP_ID="$TEST_GROUP_ID" TEST_USER_ID="$TEST_USER_ID" node -e 'process.stdout.write(JSON.stringify({ groupId: process.env.TEST_GROUP_ID, userId: process.env.TEST_USER_ID }));' >"$TMP_DIR/group-member-params.json"
webhook_json group.update "$TMP_DIR/group-update-data.json" "$TMP_DIR/group-id-params.json" "$TMP_DIR/group-update.json" || fail "group.update failed"
webhook_json group.addMember "$TMP_DIR/empty.json" "$TMP_DIR/group-member-params.json" "$TMP_DIR/group-add-member.json" || fail "group.addMember failed"
webhook_json group.removeMember "$TMP_DIR/empty.json" "$TMP_DIR/group-member-params.json" "$TMP_DIR/group-remove-member.json" || fail "group.removeMember failed"

echo "[9/9] Syncing and deleting test Passwork data"
printf '{"mode":"full"}' >"$TMP_DIR/sync-body.json"
idm_json POST "/idm/${TARGET_SYSTEM}/sync" "$TMP_DIR/sync-body.json" "$TMP_DIR/sync.json" || fail "sync.full failed"
write_report
if keep_artifacts; then
  echo "Keeping Passwork test user/group artifacts for manual verification"
else
  webhook_json group.delete "$TMP_DIR/empty.json" "$TMP_DIR/group-id-params.json" "$TMP_DIR/group-delete.json" || fail "group.delete failed"
  TEST_GROUP_ID=""
  webhook_json user.delete "$TMP_DIR/empty.json" "$TMP_DIR/user-id-params.json" "$TMP_DIR/user-delete.json" || fail "user.delete failed"
  TEST_USER_ID=""
fi
idm_json DELETE "/admin/target-systems/${TARGET_SYSTEM_ID}" "" "$TMP_DIR/target-system-delete.json" || fail "TargetSystem delete failed"
TARGET_SYSTEM_ID=""

echo "Passwork live smoke PASSED"
