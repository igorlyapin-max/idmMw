#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-3214}"
REST_PORT="${IDMMW_LIVE_REST_PORT:-3215}"
PASSWORK_PORT="${IDMMW_LIVE_PASSWORK_PORT:-3216}"
RUN_ID="${IDMMW_LIVE_RUN_ID:-$(date +%Y%m%d%H%M%S)-$$}"
TMP_DIR="${IDMMW_LIVE_TMP_DIR:-/tmp/idmmw-live-target-systems-${RUN_ID}}"
REPORT_PATH="${IDMMW_LIVE_REPORT_PATH:-${TMP_DIR}/report.json}"
DB_PATH="${IDMMW_LIVE_DB_PATH:-${TMP_DIR}/idmmw.db}"
DB_URL="file:${DB_PATH}"
LOG_PATH="${IDMMW_LIVE_LOG_PATH:-${TMP_DIR}/idmmw.log}"
STDOUT_PATH="${IDMMW_LIVE_STDOUT_PATH:-${TMP_DIR}/idmmw-stdout.log}"
REST_STATE_PATH="${IDMMW_LIVE_REST_STATE_PATH:-${TMP_DIR}/rest-target-state.json}"
TARGET_DB_PATH="${IDMMW_LIVE_TARGET_DB_PATH:-${TMP_DIR}/db-target.sqlite}"
CMDBUILD_USERNAME_MAX_LENGTH="${CMDBUILD_USERNAME_MAX_LENGTH:-40}"
APP_PID=""
REST_PID=""
CURRENT_PROVIDER=""

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
      DATABASE_URL="postgresql://root@localhost:26257/defaultdb?sslmode=disable" npx prisma generate --schema=prisma/schema.cockroach.prisma >/dev/null 2>&1 || true
      ;;
  esac
}

cleanup() {
  if [ -n "$APP_PID" ] && kill -0 "$APP_PID" >/dev/null 2>&1; then
    kill "$APP_PID" >/dev/null 2>&1 || true
    wait "$APP_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$REST_PID" ] && kill -0 "$REST_PID" >/dev/null 2>&1; then
    kill "$REST_PID" >/dev/null 2>&1 || true
    wait "$REST_PID" >/dev/null 2>&1 || true
  fi
  restore_prisma_client
}
trap cleanup EXIT INT TERM

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

report_init() {
  REPORT_PATH="$REPORT_PATH" RUN_ID="$RUN_ID" node -e '
const fs = require("fs");
const report = {
  runId: process.env.RUN_ID,
  startedAt: new Date().toISOString(),
  keepArtifacts: true,
  tempDir: process.env.REPORT_PATH.replace(/\/report\.json$/, ""),
  steps: [],
};
fs.writeFileSync(process.env.REPORT_PATH, JSON.stringify(report, null, 2));
'
}

report_step() {
  local target="$1"
  local type="$2"
  local status="$3"
  local message="$4"
  local details="${5:-}"
  if [ -z "$details" ]; then
    details="{}"
  fi
  REPORT_PATH="$REPORT_PATH" \
    TARGET="$target" \
    TYPE="$type" \
    STATUS="$status" \
    MESSAGE="$message" \
    DETAILS="$details" \
    node -e '
const fs = require("fs");
const path = process.env.REPORT_PATH;
const report = JSON.parse(fs.readFileSync(path, "utf8"));
let details = {};
try {
  details = JSON.parse(process.env.DETAILS || "{}");
} catch {
  details = { raw: process.env.DETAILS };
}
report.steps.push({
  at: new Date().toISOString(),
  targetSystem: process.env.TARGET,
  type: process.env.TYPE,
  status: process.env.STATUS,
  message: process.env.MESSAGE,
  details,
});
fs.writeFileSync(path, JSON.stringify(report, null, 2));
'
}

finalize_report() {
  REPORT_PATH="$REPORT_PATH" node -e '
const fs = require("fs");
const path = process.env.REPORT_PATH;
const report = JSON.parse(fs.readFileSync(path, "utf8"));
report.finishedAt = new Date().toISOString();
report.summary = report.steps.reduce((acc, item) => {
  acc[item.status] = (acc[item.status] || 0) + 1;
  return acc;
}, {});
fs.writeFileSync(path, JSON.stringify(report, null, 2));
'
}

curl_json() {
  local method="$1"
  local url="$2"
  local body_file="${3:-}"
  local out_file="$4"
  local status_file="${out_file}.status"
  local args=(-sS -o "$out_file" -w "%{http_code}" -X "$method" -H "Content-Type: application/json")
  if [ -n "$body_file" ]; then
    args+=(-d "@${body_file}")
  fi
  local status
  status="$(curl "${args[@]}" "$url" 2>"${out_file}.err" || true)"
  printf '%s' "$status" >"$status_file"
  if ! [[ "$status" =~ ^2[0-9][0-9]$ ]]; then
    echo "HTTP ${status} for ${method} ${url}" >&2
    if [ -s "$out_file" ]; then
      head -c 2000 "$out_file" >&2 || true
      echo >&2
    fi
    if [ -s "${out_file}.err" ]; then
      head -c 2000 "${out_file}.err" >&2 || true
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

webhook_json() {
  local target="$1"
  local operation="$2"
  local data_file="$3"
  local params_file="$4"
  local extra_file="$5"
  local out_file="$6"
  local body_file="$TMP_DIR/webhook-${target}-${operation//./-}-$(date +%s%N).json"
  node -e '
const fs = require("fs");
const [eventId, operation, targetSystem, dataFile, paramsFile, extraFile] = process.argv.slice(1);
const data = dataFile ? JSON.parse(fs.readFileSync(dataFile, "utf8")) : {};
const params = paramsFile ? JSON.parse(fs.readFileSync(paramsFile, "utf8")) : {};
const extra = extraFile ? JSON.parse(fs.readFileSync(extraFile, "utf8")) : {};
process.stdout.write(JSON.stringify({
  eventId,
  operation,
  targetSystem,
  payload: {
    ...extra,
    ...(Object.keys(data).length ? { data } : {}),
    ...(Object.keys(params).length ? { params } : {}),
  },
}));
' "all-live-${target}-${operation}-${RUN_ID}-$(date +%s%N)" "$operation" "$target" "$data_file" "$params_file" "$extra_file" >"$body_file"
  idm_json POST "/webhooks/avanpost" "$body_file" "$out_file"
  json_get "$out_file" 'value.received === true && value.processed === true' >/dev/null
}

write_json() {
  local out_file="$1"
  local json="$2"
  printf '%s' "$json" >"$out_file"
}

live_username() {
  local prefix="$1"
  local max_len="$2"
  LOGIN_PREFIX="$prefix" LOGIN_MAX_LENGTH="$max_len" RUN_ID="$RUN_ID" node -e '
const prefix = process.env.LOGIN_PREFIX || "";
const max = Number(process.env.LOGIN_MAX_LENGTH || "64");
const seed = (process.env.RUN_ID || "").replace(/[^A-Za-z0-9]/g, "") || String(Date.now());
const room = Math.max(0, max - prefix.length);
let suffix = seed;
if (suffix.length > room) {
  suffix = room <= 8 ? seed.slice(-room) : `${seed.slice(0, room - 8)}${seed.slice(-8)}`;
}
process.stdout.write(`${prefix}${suffix}`.slice(0, max));
'
}

create_target_system() {
  local name="$1"
  local type="$2"
  local label="$3"
  local config_file="$4"
  local out_file="$TMP_DIR/target-${name}.json"
  local body_file="$TMP_DIR/target-${name}-create.json"
  node -e '
const fs = require("fs");
const [name, type, label, configFile] = process.argv.slice(1);
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
process.stdout.write(JSON.stringify({ name, type, label, enabled: true, config }));
' "$name" "$type" "$label" "$config_file" >"$body_file"
  idm_json POST "/admin/target-systems" "$body_file" "$out_file"
  json_get "$out_file" "value.id"
}

wait_for_http() {
  local url="$1"
  local attempts="${2:-50}"
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

start_rest_target() {
  node - "$REST_PORT" "$REST_STATE_PATH" <<'NODE' &
const http = require("http");
const fs = require("fs");
const [portRaw, statePath] = process.argv.slice(2);
const port = Number(portRaw);

function state() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { restUsers: [], fakeUsers: [], fakeEvents: [] };
  }
}

function save(next) {
  fs.writeFileSync(statePath, JSON.stringify(next, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    send(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && url.pathname === "/users") {
    const body = await readBody(req);
    const next = state();
    const item = {
      id: `rest-${Date.now()}`,
      ...body,
      createdAt: new Date().toISOString(),
    };
    next.restUsers.push(item);
    save(next);
    send(res, 201, item);
    return;
  }
  if (req.method === "GET" && url.pathname === "/users") {
    const filter = url.searchParams.get("filter") || "";
    const items = state().restUsers.filter((item) => !filter || String(item.username || "").includes(filter));
    send(res, 200, { items, total: items.length });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/echo") {
    const body = await readBody(req);
    const next = state();
    next.fakeEvents.push({ ...body, at: new Date().toISOString() });
    if (body.operation === "user.create") {
      next.fakeUsers.push({
        id: `fake-${Date.now()}`,
        ...(body.data || {}),
        createdAt: new Date().toISOString(),
      });
    }
    save(next);
    send(res, 200, { ok: true, received: body });
    return;
  }
  send(res, 404, { error: "not_found" });
});

server.listen(port, "127.0.0.1");
NODE
  REST_PID="$!"
  wait_for_http "http://127.0.0.1:${REST_PORT}/health" 30
}

prepare_db_target() {
  TARGET_DB_PATH="$TARGET_DB_PATH" node -e '
const sqlite3 = require("sqlite3");
const db = new sqlite3.Database(process.env.TARGET_DB_PATH);
db.serialize(() => {
  db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, email TEXT, run_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)");
});
db.close((error) => {
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
});
'
}

assert_state_contains() {
  local expr="$1"
  node -e '
const fs = require("fs");
const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const fn = new Function("state", `return (${process.argv[2]});`);
if (!fn(state)) process.exit(2);
' "$REST_STATE_PATH" "$expr"
}

state_user_json() {
  local collection="$1"
  local username="$2"
  node -e '
const fs = require("fs");
const [statePath, collection, username] = process.argv.slice(1);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const item = (state[collection] || []).find((candidate) => candidate.username === username);
if (!item) process.exit(2);
process.stdout.write(JSON.stringify(item));
' "$REST_STATE_PATH" "$collection" "$username"
}

assert_db_user() {
  local username="$1"
  TARGET_DB_PATH="$TARGET_DB_PATH" USERNAME="$username" node -e '
const sqlite3 = require("sqlite3");
const db = new sqlite3.Database(process.env.TARGET_DB_PATH);
db.get("SELECT id, username, email FROM users WHERE username = ?", [process.env.USERNAME], (error, row) => {
  db.close();
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (!row) process.exit(2);
  process.stdout.write(JSON.stringify(row));
});
'
}

start_idmmw() {
  echo "[3/10] Preparing SQLite idmMw runtime"
  DATABASE_URL="$DB_URL" npx prisma generate --schema=prisma/schema.sqlite.prisma >/dev/null
  DATABASE_URL="$DB_URL" npx prisma db push --schema=prisma/schema.sqlite.prisma --skip-generate >/dev/null

  echo "[4/10] Building application"
  npm run build >/dev/null

  echo "[5/10] Starting idmMw runtime on port ${PORT}"
  DATABASE_PROVIDER=sqlite \
  DATABASE_URL="$DB_URL" \
  LIGHTWEIGHT_MODE=true \
  NODE_ENV=development \
  PORT="$PORT" \
  REDIS_ENABLED=false \
  KAFKA_ENABLED=false \
  IDMMW_PROCESSING_MODE=sync \
  ADMIN_UI_ENABLED=false \
  ADMIN_AUTH_ENABLED=false \
  MOCK_IDM_ENABLED=false \
  DebugLogging__Enabled=true \
  DebugLogging__Level=Basic \
  LOG_SINK=file \
  LOG_FILE_PATH="$LOG_PATH" \
  STATIC_CONNECTOR_ALLOWLIST= \
  node dist/main >"$STDOUT_PATH" 2>&1 &
  APP_PID="$!"

  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "$APP_PID" >/dev/null 2>&1; then
      echo "idmMw exited before health became available" >&2
      tail -n 120 "$STDOUT_PATH" >&2 || true
      exit 1
    fi
    sleep 0.5
  done
  curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null
  curl -fsS "http://127.0.0.1:${PORT}/metrics" | grep -q "idmmw_http_requests_total"
  report_step "idmmw" "runtime" "passed" "Runtime started with Basic diagnostics and metrics" "{\"port\":${PORT}}"
}

test_fake() {
  local target="fake-live-${RUN_ID}"
  local username
  username="$(live_username "idmfake-" 64)"
  write_json "$TMP_DIR/fake-config.json" "{\"baseUrl\":\"http://127.0.0.1:${REST_PORT}\",\"timeout\":10000}"
  local target_id
  target_id="$(create_target_system "$target" "fake" "Live Fake Target" "$TMP_DIR/fake-config.json")"
  idm_json POST "/admin/target-systems/${target_id}/test" "" "$TMP_DIR/fake-test.json"
  json_get "$TMP_DIR/fake-test.json" "value.success === true" >/dev/null
  write_json "$TMP_DIR/fake-user.json" "{\"username\":\"${username}\",\"email\":\"${username}@example.local\"}"
  write_json "$TMP_DIR/empty.json" "{}"
  webhook_json "$target" "user.create" "$TMP_DIR/fake-user.json" "$TMP_DIR/empty.json" "$TMP_DIR/empty.json" "$TMP_DIR/fake-create.json"
  assert_state_contains "state.fakeUsers.some((item) => item.username === '${username}')"
  local artifact
  artifact="$(state_user_json fakeUsers "$username")"
  report_step "$target" "fake" "passed" "Created fake remote user artifact" "{\"targetSystemId\":\"${target_id}\",\"username\":\"${username}\",\"stateFile\":\"${REST_STATE_PATH}\",\"artifact\":${artifact}}"
}

test_rest() {
  local target="rest-live-${RUN_ID}"
  local username
  username="$(live_username "idmrest-" 64)"
  write_json "$TMP_DIR/rest-config.json" "{\"baseUrl\":\"http://127.0.0.1:${REST_PORT}\",\"allowedPaths\":[\"/users\"],\"allowPrivateNetwork\":true,\"timeout\":10000}"
  local target_id
  target_id="$(create_target_system "$target" "rest" "Live REST Target" "$TMP_DIR/rest-config.json")"
  idm_json POST "/admin/target-systems/${target_id}/test" "" "$TMP_DIR/rest-test.json"
  json_get "$TMP_DIR/rest-test.json" "value.success === true" >/dev/null
  write_json "$TMP_DIR/rest-user.json" "{\"username\":\"${username}\",\"email\":\"${username}@example.local\"}"
  write_json "$TMP_DIR/rest-extra.json" "{\"method\":\"POST\",\"path\":\"/users\"}"
  write_json "$TMP_DIR/empty.json" "{}"
  webhook_json "$target" "user.create" "$TMP_DIR/rest-user.json" "$TMP_DIR/empty.json" "$TMP_DIR/rest-extra.json" "$TMP_DIR/rest-create.json"
  assert_state_contains "state.restUsers.some((item) => item.username === '${username}')"
  local artifact
  artifact="$(state_user_json restUsers "$username")"
  report_step "$target" "rest" "passed" "Created REST target user artifact" "{\"targetSystemId\":\"${target_id}\",\"username\":\"${username}\",\"stateFile\":\"${REST_STATE_PATH}\",\"artifact\":${artifact}}"
}

test_db() {
  local target="db-live-${RUN_ID}"
  local username
  username="$(live_username "idmdb-" 64)"
  write_json "$TMP_DIR/db-config.json" "{\"client\":\"sqlite3\",\"connection\":{\"filename\":\"${TARGET_DB_PATH}\"},\"pool\":{\"min\":1,\"max\":1}}"
  local target_id
  target_id="$(create_target_system "$target" "db" "Live DB Target" "$TMP_DIR/db-config.json")"
  idm_json POST "/admin/target-systems/${target_id}/test" "" "$TMP_DIR/db-test.json"
  json_get "$TMP_DIR/db-test.json" "value.success === true" >/dev/null
  write_json "$TMP_DIR/db-user.json" "{\"username\":\"${username}\",\"email\":\"${username}@example.local\",\"run_id\":\"${RUN_ID}\"}"
  write_json "$TMP_DIR/db-extra.json" "{\"sqlOperation\":\"insert\",\"table\":\"users\"}"
  write_json "$TMP_DIR/empty.json" "{}"
  webhook_json "$target" "user.create" "$TMP_DIR/db-user.json" "$TMP_DIR/empty.json" "$TMP_DIR/db-extra.json" "$TMP_DIR/db-create.json"
  local row
  row="$(assert_db_user "$username")"
  report_step "$target" "db" "passed" "Inserted DB target user row" "{\"targetSystemId\":\"${target_id}\",\"username\":\"${username}\",\"dbPath\":\"${TARGET_DB_PATH}\",\"row\":${row}}"
}

test_zabbix() {
  local base_url="${ZABBIX_BASE_URL:-http://127.0.0.1:8081}"
  local username="${ZABBIX_USERNAME:-Admin}"
  local password="${ZABBIX_PASSWORD:-zabbix}"
  local group_id="${ZABBIX_USER_GROUP_ID:-${ZABBIX_ENABLE_GROUP_ID:-7}}"
  local role_id="${ZABBIX_USER_ROLE_ID:-3}"
  local target="zabbix-live-${RUN_ID}"
  local login
  login="$(live_username "idmzbx-" 64)"

  if ! curl -fsS \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"apiinfo.version","params":{},"id":1}' \
    "${base_url%/}/api_jsonrpc.php" >/dev/null 2>&1; then
    report_step "$target" "zabbix" "blocked" "Zabbix API endpoint is not reachable" "{\"baseUrl\":\"${base_url}\"}"
    return 0
  fi

  write_json "$TMP_DIR/zabbix-config.json" "{\"baseUrl\":\"${base_url%/}\",\"username\":\"${username}\",\"password\":\"${password}\",\"enableGroupId\":\"${group_id}\",\"disableGroupId\":\"${group_id}\"}"
  local target_id
  target_id="$(create_target_system "$target" "zabbix" "Live Zabbix Target" "$TMP_DIR/zabbix-config.json")"
  if ! idm_json POST "/admin/target-systems/${target_id}/test" "" "$TMP_DIR/zabbix-test.json"; then
    report_step "$target" "zabbix" "blocked" "Zabbix TargetSystem test failed" "{\"targetSystemId\":\"${target_id}\",\"baseUrl\":\"${base_url}\"}"
    return 0
  fi
  if ! json_get "$TMP_DIR/zabbix-test.json" "value.success === true" >/dev/null; then
    report_step "$target" "zabbix" "blocked" "Zabbix TargetSystem test returned success=false" "{\"targetSystemId\":\"${target_id}\",\"baseUrl\":\"${base_url}\"}"
    return 0
  fi
  write_json "$TMP_DIR/zabbix-user.json" "{\"username\":\"${login}\",\"name\":\"idmMw\",\"surname\":\"Live\",\"passwd\":\"Zabbix-${RUN_ID}-Password1!\",\"usrgrps\":[{\"usrgrpid\":\"${group_id}\"}],\"roleid\":\"${role_id}\"}"
  write_json "$TMP_DIR/empty.json" "{}"
  if webhook_json "$target" "user.create" "$TMP_DIR/zabbix-user.json" "$TMP_DIR/empty.json" "$TMP_DIR/empty.json" "$TMP_DIR/zabbix-create.json"; then
    idm_json GET "/idm/${target}/users?filter=${login}&limit=10" "" "$TMP_DIR/zabbix-search.json"
    local user
    user="$(node -e '
const fs = require("fs");
const [file, login] = process.argv.slice(1);
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const item = (Array.isArray(data) ? data : data.items || []).find((candidate) => candidate.username === login);
if (!item) process.exit(2);
process.stdout.write(JSON.stringify(item));
' "$TMP_DIR/zabbix-search.json" "$login")"
    report_step "$target" "zabbix" "passed" "Created Zabbix user artifact" "{\"targetSystemId\":\"${target_id}\",\"username\":\"${login}\",\"baseUrl\":\"${base_url}\",\"user\":${user}}"
  else
    report_step "$target" "zabbix" "failed" "Zabbix user.create failed" "{\"targetSystemId\":\"${target_id}\",\"username\":\"${login}\",\"baseUrl\":\"${base_url}\"}"
  fi
}

test_cmdbuild() {
  local base_url="${CMDBUILD_BASE_URL:-http://127.0.0.1:8090}"
  local username="${CMDBUILD_USERNAME:-admin}"
  local password="${CMDBUILD_PASSWORD:-admin}"
  local api_path="${CMDBUILD_API_PATH:-/cmdbuild/services/rest/v3}"
  local group_id="${CMDBUILD_DEFAULT_USER_GROUP_ID:-}"
  local target="cmdbuild-live-${RUN_ID}"
  local login
  login="$(live_username "idmcmdb-" "$CMDBUILD_USERNAME_MAX_LENGTH")"

  if ! curl -fsS "${base_url%/}/cmdbuild/ui" >/dev/null 2>&1; then
    report_step "$target" "cmdbuild" "blocked" "CMDBuild UI endpoint is not reachable" "{\"baseUrl\":\"${base_url}\"}"
    return 0
  fi

  node -e '
const fs = require("fs");
const [out, baseUrl, username, password, apiPath, groupId] = process.argv.slice(1);
const config = { baseUrl: baseUrl.replace(/\/+$/, ""), username, password, apiPath };
if (groupId) config.defaultUserGroupId = groupId;
fs.writeFileSync(out, JSON.stringify(config));
' "$TMP_DIR/cmdbuild-config.json" "$base_url" "$username" "$password" "$api_path" "$group_id"
  local target_id
  target_id="$(create_target_system "$target" "cmdbuild" "Live CMDBuild Target" "$TMP_DIR/cmdbuild-config.json")"
  if ! idm_json POST "/admin/target-systems/${target_id}/test" "" "$TMP_DIR/cmdbuild-test.json"; then
    report_step "$target" "cmdbuild" "blocked" "CMDBuild TargetSystem test failed" "{\"targetSystemId\":\"${target_id}\",\"baseUrl\":\"${base_url}\"}"
    return 0
  fi
  if ! json_get "$TMP_DIR/cmdbuild-test.json" "value.success === true" >/dev/null; then
    report_step "$target" "cmdbuild" "blocked" "CMDBuild TargetSystem test returned success=false" "{\"targetSystemId\":\"${target_id}\",\"baseUrl\":\"${base_url}\"}"
    return 0
  fi
  write_json "$TMP_DIR/cmdbuild-user.json" "{\"username\":\"${login}\",\"description\":\"idmMw live test ${RUN_ID}\",\"email\":\"${login}@example.local\",\"password\":\"Cmdbuild-${RUN_ID}-Password1!\",\"active\":true}"
  write_json "$TMP_DIR/empty.json" "{}"
  if webhook_json "$target" "user.create" "$TMP_DIR/cmdbuild-user.json" "$TMP_DIR/empty.json" "$TMP_DIR/empty.json" "$TMP_DIR/cmdbuild-create.json"; then
    idm_json GET "/idm/${target}/users?filter=${login}&limit=10" "" "$TMP_DIR/cmdbuild-search.json" || true
    report_step "$target" "cmdbuild" "passed" "Created CMDBuild user artifact" "{\"targetSystemId\":\"${target_id}\",\"username\":\"${login}\",\"usernameLength\":${#login},\"usernameMaxLength\":${CMDBUILD_USERNAME_MAX_LENGTH},\"baseUrl\":\"${base_url}\"}"
  else
    report_step "$target" "cmdbuild" "blocked" "CMDBuild target rejected user.create; check CMDBuild application log for grants or model validation" "{\"targetSystemId\":\"${target_id}\",\"username\":\"${login}\",\"usernameLength\":${#login},\"usernameMaxLength\":${CMDBUILD_USERNAME_MAX_LENGTH},\"baseUrl\":\"${base_url}\"}"
  fi
}

test_passwork() {
  local target="passwork-local"
  local report_path="$TMP_DIR/passwork-report.json"
  if [ ! -s "${PASSWORK_URL_FILE:-../passwork/url.passwork}" ] || [ ! -s "${PASSWORK_API_FILE:-../passwork/api.passwork}" ]; then
    report_step "$target" "passwork" "blocked" "Passwork credential files are missing" "{\"urlFile\":\"${PASSWORK_URL_FILE:-../passwork/url.passwork}\",\"apiFile\":\"${PASSWORK_API_FILE:-../passwork/api.passwork}\"}"
    return 0
  fi
  if PORT="$PASSWORK_PORT" \
    PASSWORK_LIVE_RUN_ID="$RUN_ID" \
    PASSWORK_LIVE_CLEANUP=never \
    IDMMW_LIVE_KEEP_ARTIFACTS=true \
    IDMMW_PASSWORK_TMP_DIR="$TMP_DIR/passwork-work" \
    PASSWORK_LIVE_REPORT_PATH="$report_path" \
    bash scripts/test-passwork-live.sh >/dev/null; then
    local details
    details="$(node -e 'const fs = require("fs"); process.stdout.write(fs.readFileSync(process.argv[1], "utf8"));' "$report_path")"
    report_step "$target" "passwork" "passed" "Created Passwork user/group artifacts" "$details"
  else
    report_step "$target" "passwork" "failed" "Passwork live smoke failed" "{\"port\":${PASSWORK_PORT}}"
  fi
}

echo "[1/10] Initializing live target-system report at $REPORT_PATH"
report_init

echo "[2/10] Starting local REST/fake target and preparing DB target"
start_rest_target
prepare_db_target

start_idmmw

echo "[6/10] Testing fake target"
test_fake

echo "[7/10] Testing REST target"
test_rest

echo "[8/10] Testing DB target"
test_db

echo "[9/10] Testing external target systems when reachable"
test_zabbix
test_cmdbuild
test_passwork

echo "[10/10] Finalizing report"
grep -q '"event":"startup.runtime"' "$LOG_PATH"
finalize_report
echo "All target systems live run completed. Report: $REPORT_PATH"
