#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

IMAGE="${POSTGRES_ROLE_TEST_IMAGE:-postgres:17-alpine}"
CONTAINER="idmmw-postgres-role-live-$$"
PASSWORD="PostgresRoleLive-$$-Password1!"
DB_NAME="idmmw_live"
HOST_PORT=""

cleanup() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

echo "[1/5] Starting disposable PostgreSQL container from $IMAGE"
docker run -d --rm \
  --name "$CONTAINER" \
  -e POSTGRES_USER=idm_admin \
  -e POSTGRES_PASSWORD="$PASSWORD" \
  -e POSTGRES_DB="$DB_NAME" \
  -p 127.0.0.1::5432 \
  "$IMAGE" >/dev/null

HOST_PORT="$(docker port "$CONTAINER" 5432/tcp | sed -E 's/.*:([0-9]+)$/\1/')"
if [ -z "$HOST_PORT" ]; then
  echo "Unable to resolve PostgreSQL host port"
  exit 1
fi

echo "[2/5] Waiting for PostgreSQL readiness on 127.0.0.1:$HOST_PORT"
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U idm_admin -d "$DB_NAME" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
docker exec "$CONTAINER" pg_isready -U idm_admin -d "$DB_NAME" >/dev/null

echo "[3/5] Building backend connector code"
npm run build >/dev/null

echo "[4/5] Running PostgreSQL role connector live acceptance"
CONNECTION_STRING="postgresql://idm_admin:${PASSWORD}@127.0.0.1:${HOST_PORT}/${DB_NAME}" \
node <<'NODE'
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const {
  PostgresRoleConnectorService,
} = require('./dist/connectors/implementations/postgres-role-connector/postgres-role-connector.service.js');

const connectionString = process.env.CONNECTION_STRING;
const service = new PostgresRoleConnectorService();
const pool = new Pool({ connectionString });
const config = {
  connectionString,
  managedRolePrefix: 'app_',
  rolePolicyMode: 'managed-namespace',
  permissionPolicyMode: 'managed-allowlist',
  defaultDatabase: 'idmmw_live',
  allowedPermissions: [
    { action: 'GRANT', permission: 'CONNECT', scope: 'DATABASE' },
    { action: 'GRANT', permission: 'USAGE', scope: 'SCHEMA::public' },
  ],
};

async function execute(operation, data = {}, params = {}) {
  return service.execute({
    operation,
    targetSystem: 'postgres-role-live',
    payload: { config, data, params },
  });
}

async function main() {
  try {
    let result = await execute('group.create', { role: 'app_writer' });
    assert.equal(result.success, true);

    result = await execute('user.create', {
      login: 'idm_live_user',
      password: 'PostgresRoleLive-Password1!',
      roles: ['app_writer'],
      permissions: [
        { action: 'GRANT', permission: 'CONNECT', scope: 'DATABASE' },
        { action: 'GRANT', permission: 'USAGE', scope: 'SCHEMA::public' },
      ],
    });
    assert.equal(result.success, true);

    const roleRows = await pool.query(
      "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname IN ('app_writer', 'idm_live_user') ORDER BY rolname",
    );
    assert.deepEqual(roleRows.rows, [
      { rolname: 'app_writer', rolcanlogin: false },
      { rolname: 'idm_live_user', rolcanlogin: true },
    ]);

    const membershipRows = await pool.query(
      `SELECT role.rolname AS role, member.rolname AS member
       FROM pg_auth_members m
       JOIN pg_roles role ON role.oid = m.roleid
       JOIN pg_roles member ON member.oid = m.member
       WHERE role.rolname = 'app_writer' AND member.rolname = 'idm_live_user'`,
    );
    assert.equal(membershipRows.rowCount, 1);

    result = await execute('user.update', {
      login: 'idm_live_user',
      roles: ['pg_read_all_data'],
    });
    assert.equal(result.success, false);
    assert.match(result.error, /outside managed namespace/);

    result = await execute('user.update', {
      login: 'idm_live_user',
      permissions: [
        { action: 'GRANT', permission: 'UPDATE', scope: 'SCHEMA::public' },
      ],
    });
    assert.equal(result.success, false);
    assert.match(result.error, /outside managed allowlist/);

    result = await execute('group.search');
    assert.equal(result.success, true);
    assert.ok(result.data.items.some((item) => item.role === 'app_writer'));

    result = await execute('user.delete', {}, { id: 'idm_live_user' });
    assert.equal(result.success, true);
    assert.equal(result.data.enabled, false);

    const disabledRows = await pool.query(
      "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'idm_live_user'",
    );
    assert.equal(disabledRows.rows[0].rolcanlogin, false);
  } finally {
    await pool.query('REVOKE "app_writer" FROM "idm_live_user"').catch(() => {});
    await pool.query('DROP ROLE IF EXISTS "idm_live_user"').catch(() => {});
    await pool.query('DROP ROLE IF EXISTS "app_writer"').catch(() => {});
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE

echo "[5/5] PostgreSQL role live acceptance PASSED"
