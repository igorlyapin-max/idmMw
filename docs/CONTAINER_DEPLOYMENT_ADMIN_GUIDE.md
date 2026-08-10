# Container deployment admin guide

This guide is the handoff document for unix administrators who deploy idmMw as
containers with prebuilt images, `.env` files and secrets resolved through PAM.

## Delivery artifacts

| Scenario             | Compose file                             | Env template                                    | Image tag                             |
| -------------------- | ---------------------------------------- | ----------------------------------------------- | ------------------------------------- |
| Default DEV, SQLite  | `deploy/docker-compose.dev-sqlite.yml`   | `deploy/profiles/dev-sqlite.env.example`        | `REPLACE_REGISTRY/idmmw:dev-sqlite`   |
| DEV APP + PostgreSQL | `deploy/docker-compose.dev-postgres.yml` | `deploy/profiles/dev-postgres.env.example`      | `REPLACE_REGISTRY/idmmw:dev-postgres` |
| HA, YugabyteDB YSQL  | `deploy/docker-compose.prod-ha.yml`      | `deploy/profiles/prod-ha-yugabyte.env.example`  | `REPLACE_REGISTRY/idmmw:ha-yugabyte`  |
| HA, CockroachDB      | `deploy/docker-compose.prod-ha.yml`      | `deploy/profiles/prod-ha-cockroach.env.example` | `REPLACE_REGISTRY/idmmw:ha-cockroach` |

`deploy/docker-compose.sqlite-test.yml` and
`deploy/profiles/sqlite-test.env.example` remain CI/disposable smoke artifacts,
not the administrator-facing default.

## Build and push images

Build images once in CI or on a controlled build host, then push them to the
corporate registry. Runtime hosts should use `image:`, not `build:`.
Use the verified helper for delivery images. It embeds root `VERSION`, full Git
revision, clean-source state, OCI labels and the Admin UI runtime artifact
checksum, then verifies those values against the built image. A raw local
`docker build` is allowed only for development and is treated as
`unverified-local`.

If the build host reaches the corporate registry, package mirrors, npm proxy or
other build-time endpoints through a private CA, place the CA files under
`certs/customer-ca/` before running the helper. Accepted suffixes are `.crt` and
`.pem`. The Dockerfile copies and activates that directory immediately after
the external base `FROM`, before `npm ci` or `apt-get update`. Real CA files are
ignored by Git but are included in the Docker build context.

The runtime image also copies `apt/debian.sources` to
`/etc/apt/sources.list.d/debian.sources` before the first `apt-get update`. The
committed file uses standard Debian Bookworm repositories. For customer source
builds that require an internal OS package mirror or proxy, replace
`apt/debian.sources` in the build context before `docker build`. Do not put
mirror credentials in this file; use build-host proxy settings, Docker daemon
configuration, or the approved CI secret mechanism. For canonical verified
builds, a customer-specific sources file must be part of the clean CI checkout,
otherwise the clean-source gate correctly rejects the build.

Set `CUSTOMER_CA_REQUIRED=true` when the release build must fail closed if no
customer CA is present:

```bash
CUSTOMER_CA_REQUIRED=true bash scripts/build-verified-image.sh \
  --profile dev-sqlite \
  --image REPLACE_REGISTRY/idmmw:dev-sqlite \
  --push
```

The verified helper is Docker-first. It does not build `ui/dist` on the host and
does not use host `npm` output as release evidence. The helper builds a
temporary Docker image, extracts `/app/build/runtime-artifact.sha256` from that
image, then builds the final `verified` image and checks the same digest through
image labels, embedded files, `/health` and `/about`. Build logs contain
timestamped phase markers for preflight, Docker build, digest extraction,
runtime smoke and push; use those markers to identify slow registry, mirror or
dependency phases.

```bash
bash scripts/build-verified-image.sh \
  --profile dev-sqlite \
  --image REPLACE_REGISTRY/idmmw:dev-sqlite \
  --push

bash scripts/build-verified-image.sh \
  --profile dev-postgres \
  --image REPLACE_REGISTRY/idmmw:dev-postgres \
  --no-runtime \
  --push

bash scripts/build-verified-image.sh \
  --profile ha-yugabyte \
  --image REPLACE_REGISTRY/idmmw:ha-yugabyte \
  --no-runtime \
  --push

bash scripts/build-verified-image.sh \
  --profile ha-cockroach \
  --image REPLACE_REGISTRY/idmmw:ha-cockroach \
  --no-runtime \
  --push
```

The Prisma schema is selected at image build time. Do not reuse a SQLite image
for PostgreSQL/Yugabyte/Cockroach runtime, and do not reuse a Cockroach image
for Yugabyte.

## Default DEV deployment: SQLite

Use this profile as the default small DEV contour when no external database is
allocated. It stores the SQLite database in a Docker volume.

```bash
cp deploy/profiles/dev-sqlite.env.example deploy/profiles/dev-sqlite.env
```

Edit `deploy/profiles/dev-sqlite.env`:

- replace `REPLACE_REGISTRY` in `IDMMW_IMAGE`;
- keep `IDMMW_HOST_PORT=3010` unless the DEV host already uses the port;
- keep `PORT=3010` inside the container because the image healthcheck uses it;
- keep `DebugLogging__Enabled=false` by default.

Initialize the SQLite schema once:

```bash
docker compose \
  --env-file deploy/profiles/dev-sqlite.env \
  -f deploy/docker-compose.dev-sqlite.yml \
  --profile init run --rm idmmw-db-init
```

Start the application:

```bash
docker compose \
  --env-file deploy/profiles/dev-sqlite.env \
  -f deploy/docker-compose.dev-sqlite.yml \
  up -d idmmw
```

Check the runtime:

```bash
curl -fsS http://127.0.0.1:3010/health
curl -fsS http://127.0.0.1:3010/about
curl -fsS http://127.0.0.1:3010/metrics
```

## DEV deployment: APP + PostgreSQL

Use this profile when the DEV contour must mirror a PostgreSQL-compatible DB
topology while still running the database in compose.

```bash
cp deploy/profiles/dev-postgres.env.example deploy/profiles/dev-postgres.env
```

Edit `deploy/profiles/dev-postgres.env`:

- replace `REPLACE_REGISTRY` in `IDMMW_IMAGE`;
- keep local defaults `IDMMW_HOST_PORT=3010` and `POSTGRES_HOST_PORT=5433`
  unless the DEV host already uses these ports;
- for a real shared DEV host, replace `POSTGRES_PASSWORD` and the password part
  of `DATABASE_URL` with the same generated value.

Apply migrations:

```bash
docker compose \
  --env-file deploy/profiles/dev-postgres.env \
  -f deploy/docker-compose.dev-postgres.yml \
  --profile init run --rm idmmw-db-init
```

Start APP + DB:

```bash
docker compose \
  --env-file deploy/profiles/dev-postgres.env \
  -f deploy/docker-compose.dev-postgres.yml \
  up -d
```

Check:

```bash
curl -fsS http://127.0.0.1:3010/health
curl -fsS http://127.0.0.1:3010/about
curl -fsS http://127.0.0.1:3010/metrics
```

## HA deployment

HA profiles expect external YugabyteDB or CockroachDB, external Kafka, and a
reverse proxy or orchestrator in front of application workers. The compose file
uses `expose: 3010`; publish host ports in the platform layer when needed.

For YugabyteDB:

```bash
cp deploy/profiles/prod-ha-yugabyte.env.example deploy/profiles/prod-ha-yugabyte.env
```

For CockroachDB:

```bash
cp deploy/profiles/prod-ha-cockroach.env.example deploy/profiles/prod-ha-cockroach.env
```

In the copied file:

- replace `REPLACE_REGISTRY`, DB hostnames and every `REPLACE_WITH_*` value;
- use `secret://...` or `aapm://...` values for secrets managed by PAM;
- keep `ENCRYPTION_ENABLED=true` before storing connector secrets;
- keep `ADMIN_AUTH_ENABLED=true` for `/admin/*`;
- keep `DebugLogging__Enabled=false` by default.

Run migrations before normal startup:

```bash
docker compose \
  --env-file deploy/profiles/prod-ha-yugabyte.env \
  -f deploy/docker-compose.prod-ha.yml \
  --profile migrate run --rm idmmw-migrate
```

Start a worker:

```bash
docker compose \
  --env-file deploy/profiles/prod-ha-yugabyte.env \
  -f deploy/docker-compose.prod-ha.yml \
  up -d idmmw
```

For CockroachDB, use `deploy/profiles/prod-ha-cockroach.env`; the profile sets
`PRISMA_SCHEMA=prisma/schema.cockroach.prisma`.

## Secrets and PAM

Production and shared DEV contours should use PAM instead of plaintext secrets.
The app resolves secret references during startup when these variables are set:

```env
SECRETS_PROVIDER=IndeedPamAapm
SECRETS_INDEEDPAMAAPM_BASEURL=https://pam.company.local
SECRETS_INDEEDPAMAAPM_APPLICATIONTOKEN=<platform-injected-pam-token>
SECRETS_INDEEDPAMAAPM_TOKEN_TRANSPORT=header
SECRETS_INDEEDPAMAAPM_DEFAULTACCOUNTPATH=default/path
```

Examples of secret-backed runtime values:

```env
ADMIN_AUTH_LOCAL_PASSWORD=secret://idmmw-admin-password
ADMIN_AUTH_SESSION_SECRET=secret://idmmw-admin-session-secret
ENCRYPTION_KEY_KEY_2026_06=secret://idmmw-encryption-key-2026-06
```

`secret://...` must be the whole env value. Do not embed a `secret://` fragment
inside `DATABASE_URL`. For the supplied `idmmw-migrate` one-shot service,
`DATABASE_URL` must already contain a resolved DSN because Prisma CLI does not
run the application PAM resolver. Let the platform inject the final DSN before
container startup, or render it from PAM outside the container. PAM bootstrap
credentials such as `SECRETS_INDEEDPAMAAPM_APPLICATIONTOKEN` must also be
injected by the platform and cannot be resolved through the same PAM resolver.

## Debug and logging contract

- `DebugLogging__Enabled=false` is the default for all administrator-facing
  profiles.
- `DebugLogging__Level=Basic` is safe for temporary routing diagnostics.
- `DebugLogging__Level=Verbose` is only for time-bound incident diagnostics;
  payloads are redacted through the structured logging pipeline.
- stdout/stderr are always active.
- `LOG_SINK=file` adds a second JSON sink at `LOG_FILE_PATH`; use it only when
  a collector, sidecar, syslog driver, ELK/OpenSearch route or equivalent
  platform log route picks up the file.
- Production HA examples use `LOG_SINK=file`, `/app/logs/idmmw.log` and the
  `logging` compose profile sidecar as the second operational delivery route.

## Verified image identity

Before replacing a deployed image, record the configured image reference and
the currently running container image id:

```bash
docker compose --env-file deploy/profiles/dev-sqlite.env \
  -f deploy/docker-compose.dev-sqlite.yml images idmmw
docker inspect --format '{{.Image}}' <running-idmmw-container>
```

After pulling a replacement image, recreate the container. `docker compose
restart` keeps the old image id and is not a source freshness proof.

```bash
docker compose --env-file deploy/profiles/dev-sqlite.env \
  -f deploy/docker-compose.dev-sqlite.yml pull idmmw
docker compose --env-file deploy/profiles/dev-sqlite.env \
  -f deploy/docker-compose.dev-sqlite.yml up -d --force-recreate idmmw
```

Confirm that `/about` and `/health` expose the same build identity as the image
labels:

```bash
curl -fsS http://127.0.0.1:3010/about
docker image inspect REPLACE_REGISTRY/idmmw:dev-sqlite \
  --format '{{json .Config.Labels}}'
```

The fields `version`, `gitRevision`, `sourceClean`, `provenance` and
`runtimeArtifactSha256` must match the release commit and image labels.
`provenance=unverified-local`, version `0.0.0.0`, missing revision, or a
different running image id blocks customer handoff. `docker compose --no-cache`
does not rebuild image-only services and is not release evidence.

## Acceptance checklist

- `docker compose config` succeeds for the selected compose/env pair.
- DB init or migration one-shot completes successfully.
- App container starts without restart loops.
- `/health` returns public liveness success.
- `/about` and `/health` expose verified build identity for the running image.
- `/ready` returns dependency readiness for DB, Redis and Kafka on the internal
  route.
- `/metrics` exposes Prometheus metrics on the internal route, or requires
  integration HMAC when `METRICS_PUBLIC_ENABLED=false`.
- Running container image id matches the freshly pulled verified image id.
- Admin UI is reachable when `ADMIN_UI_ENABLED=true`.
- `/webhooks/avanpost` and `/idm/*` reject unsigned requests when
  `INTEGRATION_AUTH_ENABLED=true`.
- No real secrets are stored in committed env templates.
