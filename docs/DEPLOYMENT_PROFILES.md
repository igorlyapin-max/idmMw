# Deployment profiles

idmMw ships administrator-facing container profiles, one CI smoke profile and
two HA DB profiles:

- `dev-sqlite` - default small DEV contour; one worker, SQLite in a Docker
  volume, no Kafka/Redis.
- `dev-postgres` - DEV contour with APP + PostgreSQL in compose; local ports
  `3010` and `5433`.
- `sqlite-test` - one worker, SQLite, no Kafka/Redis; for CI smoke and
  disposable test stands only.
- `prod-ha-yugabyte` - production HA default; external Kafka and YugabyteDB
  YSQL with Prisma `provider = "postgresql"`.
- `prod-ha-cockroach` - production HA alternative; external Kafka and
  CockroachDB with Prisma `provider = "cockroachdb"`.

## DB choice

Use **YugabyteDB** as the first production HA target unless the platform team
already standardizes on CockroachDB.

Why:

- The main Prisma schema and migrations already use `provider = "postgresql"`.
- YugabyteDB YSQL is consumed through the normal PostgreSQL DSN and keeps the
  same migration flow as PostgreSQL.
- CockroachDB has a dedicated Prisma provider and the repository already keeps
  `prisma/schema.cockroach.prisma`, but rollout needs a separate generate/build
  path and separate schema validation.

CockroachDB remains supported as a compatibility profile, not the default.

Detailed administrator handoff for image build/push, `.env` preparation, PAM
secrets and runtime checks lives in
[CONTAINER_DEPLOYMENT_ADMIN_GUIDE.md](CONTAINER_DEPLOYMENT_ADMIN_GUIDE.md).

## dev-sqlite

Profile files:

- `deploy/profiles/dev-sqlite.env.example`
- `deploy/docker-compose.dev-sqlite.yml`

Runtime contract:

```env
DATABASE_PROVIDER=sqlite
DATABASE_URL=file:/app/data/idmmw.db
LIGHTWEIGHT_MODE=true
IDMMW_PROCESSING_MODE=sync
KAFKA_ENABLED=false
REDIS_ENABLED=false
ADMIN_UI_ENABLED=true
DebugLogging__Enabled=false
DebugLogging__Level=Basic
LOG_SINK=stdout
```

Build/push the image:

```bash
bash scripts/build-verified-image.sh \
  --profile dev-sqlite \
  --image REPLACE_REGISTRY/idmmw:dev-sqlite \
  --push
```

Run:

```bash
cp deploy/profiles/dev-sqlite.env.example deploy/profiles/dev-sqlite.env
# edit deploy/profiles/dev-sqlite.env and replace REPLACE_* values

docker compose --env-file deploy/profiles/dev-sqlite.env \
  -f deploy/docker-compose.dev-sqlite.yml \
  --profile init run --rm idmmw-db-init

docker compose --env-file deploy/profiles/dev-sqlite.env \
  -f deploy/docker-compose.dev-sqlite.yml up -d idmmw
```

## dev-postgres

Profile files:

- `deploy/profiles/dev-postgres.env.example`
- `deploy/docker-compose.dev-postgres.yml`

Runtime contract:

```env
DATABASE_PROVIDER=postgresql
DATABASE_FLAVOR=postgresql
DATABASE_URL=postgresql://idmmw:idmmw_dev@postgres:5432/idmmw
LIGHTWEIGHT_MODE=false
IDMMW_PROCESSING_MODE=sync
KAFKA_ENABLED=false
REDIS_ENABLED=false
ADMIN_UI_ENABLED=true
DebugLogging__Enabled=false
DebugLogging__Level=Basic
LOG_SINK=stdout
```

Run:

```bash
cp deploy/profiles/dev-postgres.env.example deploy/profiles/dev-postgres.env
# edit deploy/profiles/dev-postgres.env and replace REPLACE_* values

docker compose --env-file deploy/profiles/dev-postgres.env \
  -f deploy/docker-compose.dev-postgres.yml \
  --profile init run --rm idmmw-db-init

docker compose --env-file deploy/profiles/dev-postgres.env \
  -f deploy/docker-compose.dev-postgres.yml up -d
```

## sqlite-test

Profile files:

- `deploy/profiles/sqlite-test.env.example`
- `deploy/docker-compose.sqlite-test.yml`

Runtime contract:

```env
DATABASE_PROVIDER=sqlite
DATABASE_URL=file:/app/data/idmmw.db
LIGHTWEIGHT_MODE=true
IDMMW_PROCESSING_MODE=sync
KAFKA_ENABLED=false
REDIS_ENABLED=false
DebugLogging__Enabled=true
DebugLogging__Level=Verbose
LOG_SINK=file
```

Run locally for CI-style smoke:

```bash
docker compose -f deploy/docker-compose.sqlite-test.yml up --build
```

Validate without Docker:

```bash
npm run profile:validate -- sqlite-test
npm run profile:smoke:sqlite
```

This profile intentionally uses `ENCRYPTION_ENABLED=false` and local SQLite.
Do not use it for production connector credentials.

## prod-ha-yugabyte

Profile files:

- `deploy/profiles/prod-ha-yugabyte.env.example`
- `deploy/docker-compose.prod-ha.yml`

Runtime contract:

```env
DATABASE_PROVIDER=postgresql
DATABASE_FLAVOR=yugabytedb
DATABASE_URL=postgresql://...
LIGHTWEIGHT_MODE=false
IDMMW_PROCESSING_MODE=async
KAFKA_ENABLED=true
REDIS_ENABLED=false
ENCRYPTION_ENABLED=true
ADMIN_AUTH_ENABLED=true
HTTP_TLS_ENABLED=true
INTEGRATION_AUTH_ENABLED=true
METRICS_PUBLIC_ENABLED=false
STATIC_CONNECTOR_ALLOWLIST=
LOG_SINK=file
LOG_FILE_PATH=/app/logs/idmmw.log
```

Build image:

```bash
bash scripts/build-verified-image.sh \
  --profile ha-yugabyte \
  --image REPLACE_REGISTRY/idmmw:ha-yugabyte \
  --no-runtime \
  --push
```

Run one instance with compose template:

```bash
cp deploy/profiles/prod-ha-yugabyte.env.example deploy/profiles/prod-ha-yugabyte.env
# edit deploy/profiles/prod-ha-yugabyte.env and replace every REPLACE_* value

docker compose --env-file deploy/profiles/prod-ha-yugabyte.env \
  -f deploy/docker-compose.prod-ha.yml \
  --profile migrate run --rm idmmw-migrate

docker compose --env-file deploy/profiles/prod-ha-yugabyte.env \
  -f deploy/docker-compose.prod-ha.yml up -d idmmw

docker compose --env-file deploy/profiles/prod-ha-yugabyte.env \
  -f deploy/docker-compose.prod-ha.yml --profile logging up -d idmmw-log-forwarder
```

For multiple workers, run the same image and env behind an external reverse
proxy/orchestrator. The compose template only exposes port `3010` inside the
compose network to avoid host-port conflicts during scaling.

## prod-ha-cockroach

Profile files:

- `deploy/profiles/prod-ha-cockroach.env.example`
- `deploy/docker-compose.prod-ha.yml`

Build image with Cockroach Prisma schema:

```bash
bash scripts/build-verified-image.sh \
  --profile ha-cockroach \
  --image REPLACE_REGISTRY/idmmw:ha-cockroach \
  --no-runtime \
  --push
```

Validate without live CockroachDB:

```bash
npm run profile:validate -- prod-ha-cockroach
npm run profile:validate:prod-ha -- cockroach
```

Use this profile only when CockroachDB is the approved platform DB. Keep
Cockroach schema validation in CI before rollout.

## CI jobs

GitLab CI includes profile checks:

- `profile:sqlite-test:smoke`
- `profile:prod-ha:yugabyte:validate`
- `profile:prod-ha:cockroach:validate`

The live HA smoke job is manual and gated by `IDMMW_RUN_LIVE_HA_SMOKE=true`
because it requires reachable Kafka, Redis and container tooling on the runner.

## Security gates

Production profiles must keep:

- `ENCRYPTION_ENABLED=true` before connector tokens are stored in
  `TargetSystem.config`.
- `ADMIN_AUTH_ENABLED=true` for `/admin/*`.
- `HTTP_TLS_ENABLED=true` or equivalent TLS termination at a trusted gateway.
- `INTEGRATION_AUTH_ENABLED=true` for `/webhooks/*` and `/idm/*`.
- `METRICS_PUBLIC_ENABLED=false` unless the metrics route is already isolated
  by platform routing.
- `STATIC_CONNECTOR_ALLOWLIST=` empty; use DB-backed TargetSystem routes.
- `DebugLogging__Enabled=false` by default; use `Basic` or `Verbose` only for
  time-bound diagnostics.
- stdout logging always enabled; prod-ha examples use `LOG_SINK=file` and the
  compose `logging` profile sidecar as the second operational sink.
