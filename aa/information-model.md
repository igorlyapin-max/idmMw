# Information Model

## Information Flow Diagram

```mermaid
flowchart LR
  IDM[Avanpost IDM 7.8]
  Admin[Admin browser / operator]
  MW[idmMw NestJS API :3010]
  DB[(PostgreSQL/YugabyteDB :5432/5433\nCockroachDB :26257\nSQLite file for dev/test)]
  Redis[(Redis optional :6379)]
  Kafka[(Kafka optional :9093)]
  Target[Target systems\nREST/Zabbix/CMDBuild/Passwork/DB/custom]
  PAM[Indeed PAM/AAPM optional :443]
  Prom[Prometheus :9090]
  Logs[Log collector / sidecar / platform]

  IDM -->|IF-001 webhook write HTTP :3010| MW
  IDM -->|IF-002 IDM catalog/read HTTP :3010| MW
  Admin -->|IF-003 Admin UI/API HTTP(S) :3010| MW
  MW -->|IF-004 async write/status topics :9093| Kafka
  Kafka -->|IF-005 worker input/retry topics :9093| MW
  MW -->|IF-006 connector calls target-specific port| Target
  MW -->|IF-007 optional Redis idempotency :6379| Redis
  MW -->|IF-008 DB persistence| DB
  Prom -->|IF-010 scrape HTTP(S) :3010| MW
  MW -->|IF-011 secret resolution HTTPS :443| PAM
  MW -->|IF-012 JSON logs stdout/stderr/file| Logs
  Ops[Platform/SRE] -->|IF-009 health/about/ready HTTP(S) :3010| MW
```

## Flow Catalog

| ID | Source | Target | Channel / endpoint / topic | Port | Data | Direction | Auth/secret | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| IF-001 | Avanpost IDM 7.8 | idmMw | `POST /webhooks/avanpost` | 3010 | `eventId`, `operation`, `targetSystem`, `payload.data`, `payload.params`, `payload.metadata` | IDM to idmMw | `INTEGRATION_AUTH_SECRET` when enabled; TLS/gateway policy | Write/read-compatible webhook. Write path may use retry/DLQ. |
| IF-002 | Avanpost IDM 7.8 | idmMw | `/idm/*` catalog/read facade | 3010 | target system catalog, schema, users, groups, test and sync results | idmMw to IDM as HTTP response | `INTEGRATION_AUTH_SECRET` when enabled; no connector config returned | Read operations are synchronous. |
| IF-003 | Admin browser / operator | idmMw | `/`, `/auth/*`, `/admin/*` | 3010 | session state, target system CRUD, DLQ, stats | Browser/API client to idmMw and response | admin session cookie, local password or SSO headers | Production requires admin auth or trusted gateway. |
| IF-004 | idmMw dispatcher/admin | Kafka | `idm.events.in`, `idm.events.out`, `idm.dlq.retry` | 9093 in prod examples | async write payloads, status messages, DLQ retry messages | idmMw to Kafka | `KAFKA_TLS_*`; message encryption via `ENCRYPTION_KAFKA_ENABLED` | Required only when `KAFKA_ENABLED=true`. |
| IF-005 | Kafka | idmMw worker | `idm.events.in`, `idm.dlq.retry` subscriptions | 9093 in prod examples | processing payload, optional `dlqItemId` | Kafka to idmMw | `KAFKA_TLS_*`; optional payload encryption | Worker group `KAFKA_CONSUMER_GROUP_ID`. |
| IF-006 | idmMw connector | Target systems | connector-specific HTTP/DB/API channel | target-specific | lifecycle operation payloads, read filters, schema/test requests | idmMw to target; target data in response | per-target config credentials and TLS | Includes REST, DB, Zabbix, CMDBuild, Passwork, ConsultantPlus and custom connectors. |
| IF-007 | idmMw | Redis | Redis idempotency store | 6379 default | idempotency keys, locks, TTLs | idmMw to Redis | `REDIS_PASSWORD`, `REDIS_TLS_*` | Optional. DB-backed idempotency is used when Redis is disabled. |
| IF-008 | idmMw | idmMw DB | Prisma connection | 5432/5433/26257 or SQLite file | `TargetSystem`, `AuditLog`, `DlqItem`, `IdempotencyKey`, `EncryptionState` | idmMw to DB; DB rows in response | `DATABASE_URL`; DB TLS via DSN/platform | Production uses PostgreSQL-compatible YugabyteDB or CockroachDB. |
| IF-009 | Platform/SRE | idmMw | `GET /health`, `GET /about`, `GET /ready` | 3010 | liveness, build identity, dependency readiness | idmMw to caller as HTTP response | `/ready` should be internal; TLS/gateway policy | Used by container healthchecks and operations. |
| IF-010 | Prometheus | idmMw | `GET /metrics` | 3010 | Prometheus metrics | idmMw to Prometheus scrape response | HMAC guard when `METRICS_PUBLIC_ENABLED=false` | No payloads or secrets. |
| IF-011 | idmMw | Indeed PAM/AAPM | HTTPS secret resolution | 443 | secret references and retrieved values | PAM response to idmMw | PAM application token | Optional; secret values are not documented here. |
| IF-012 | idmMw | Log collector / sidecar / platform | stdout/stderr and optional `LOG_SINK=file` | platform-specific | structured JSON events, diagnostics, errors | idmMw to logging pipeline | redaction; collector/platform trust | `Verbose` only temporarily and redacted. |

## Synchronous API Coverage

HTTP flows IF-001, IF-002, IF-003, IF-009 and IF-010 are covered by
[openapi.yaml](openapi.yaml). The in-app Swagger endpoint is served at `/api`
on port `3010`.

## Asynchronous API Coverage

Kafka flows IF-004 and IF-005 are covered by [asyncapi.yaml](asyncapi.yaml) and
[kafka-access-map.md](kafka-access-map.md).
