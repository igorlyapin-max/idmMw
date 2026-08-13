# Информационная модель

## Диаграмма информационных потоков

```mermaid
flowchart LR
  IDM[Avanpost IDM 7.8]
  Admin[Браузер администратора / оператор]
  MW[idmMw NestJS API :3010]
  DB[(PostgreSQL/YugabyteDB :5432/5433\nCockroachDB :26257\nSQLite file для dev/test)]
  Redis[(Redis optional :6379)]
  Kafka[(Kafka optional :9093)]
  Target[Целевые системы\nREST/Zabbix/CMDBuild/Passwork/DB/custom]
  PAM[Indeed PAM/AAPM optional :443]
  Prom[Prometheus :9090]
  Logs[Log collector / sidecar / платформа]

  IDM -->|IF-001 webhook write HTTP :3010| MW
  IDM -->|IF-002 каталог/чтение IDM HTTP :3010| MW
  Admin -->|IF-003 Admin UI/API HTTP(S) :3010| MW
  MW -->|IF-004 topics асинхронной записи/статуса :9093| Kafka
  Kafka -->|IF-005 topics входа worker/retry :9093| MW
  MW -->|IF-006 вызовы connector на порт целевой системы| Target
  MW -->|IF-007 опциональная idempotency в Redis :6379| Redis
  MW -->|IF-008 DB persistence| DB
  Prom -->|IF-010 сбор HTTP(S) :3010| MW
  MW -->|IF-011 получение secret HTTPS :443| PAM
  MW -->|IF-012 JSON logs stdout/stderr/file| Logs
  Ops[Платформа/SRE] -->|IF-009 health/about/ready HTTP(S) :3010| MW
```

## Каталог потоков

| ID | Источник | Получатель | Канал / endpoint / topic | Порт | Данные | Направление | Auth/secret | Примечания |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| IF-001 | Avanpost IDM 7.8 | idmMw | `POST /webhooks/avanpost` | 3010 | `eventId`, `operation`, `targetSystem`, `payload.data`, `payload.params`, `payload.metadata` | IDM -> idmMw | `INTEGRATION_AUTH_SECRET` при включении; TLS/gateway policy | Webhook для write/read-compatible операций. Write path может использовать retry/DLQ. |
| IF-002 | Avanpost IDM 7.8 | idmMw | `/idm/*` catalog/read facade | 3010 | target system catalog, schema, users, groups, test и sync results | idmMw -> IDM как HTTP response | `INTEGRATION_AUTH_SECRET` при включении; connector config не возвращается | Операции чтения выполняются синхронно. |
| IF-003 | Браузер администратора / оператор | idmMw | `/`, `/auth/*`, `/admin/*` | 3010 | session state, target system CRUD, DLQ, stats | Browser/API client -> idmMw и ответ | admin session cookie, local password или SSO headers | Production требует admin auth или trusted gateway. |
| IF-004 | idmMw dispatcher/admin | Kafka | `idm.events.in`, `idm.events.out`, `idm.dlq.retry` | 9093 в prod examples | async write payloads, status messages, DLQ retry messages | idmMw -> Kafka | `KAFKA_TLS_*`; message encryption через `ENCRYPTION_KAFKA_ENABLED` | Требуется только при `KAFKA_ENABLED=true`. |
| IF-005 | Kafka | idmMw worker | `idm.events.in`, `idm.dlq.retry` subscriptions | 9093 в prod examples | processing payload, опциональный `dlqItemId` | Kafka -> idmMw | `KAFKA_TLS_*`; опциональное payload encryption | Worker group `KAFKA_CONSUMER_GROUP_ID`. |
| IF-006 | idmMw connector | Целевые системы | connector-specific HTTP/DB/API channel | target-specific | lifecycle operation payloads, read filters, schema/test requests | idmMw -> target; target data в ответе | per-target config credentials и TLS | REST, DB, Zabbix, CMDBuild, Passwork, ConsultantPlus и custom connectors. |
| IF-007 | idmMw | Redis | Redis idempotency store | 6379 default | idempotency keys, locks, TTLs | idmMw -> Redis | `REDIS_PASSWORD`, `REDIS_TLS_*` | Опционально. DB-backed idempotency используется при disabled Redis. |
| IF-008 | idmMw | idmMw DB | Prisma connection | 5432/5433/26257 или SQLite file | `TargetSystem`, `AuditLog`, `DlqItem`, `IdempotencyKey`, `EncryptionState` | idmMw -> DB; DB rows в ответе | `DATABASE_URL`; DB TLS через DSN/platform | Production использует PostgreSQL-compatible YugabyteDB или CockroachDB. |
| IF-009 | Платформа/SRE | idmMw | `GET /health`, `GET /about`, `GET /ready` | 3010 | liveness, build identity, readiness зависимостей | idmMw -> вызывающий как HTTP response | `/ready` должен быть internal; TLS/gateway policy | Используется для container healthchecks и operations. |
| IF-010 | Prometheus | idmMw | `GET /metrics` | 3010 | Prometheus metrics | idmMw -> Prometheus scrape response | HMAC guard при `METRICS_PUBLIC_ENABLED=false` | Без payloads и secrets. |
| IF-011 | idmMw | Indeed PAM/AAPM | HTTPS secret resolution | 443 | secret references и полученные values | PAM response -> idmMw | PAM application token | Опционально; secret values здесь не документируются. |
| IF-012 | idmMw | Log collector / sidecar / платформа | stdout/stderr и опциональный `LOG_SINK=file` | platform-specific | structured JSON events, diagnostics, errors | idmMw -> logging pipeline | redaction; collector/platform trust | `Verbose` только временно и с redaction. |

## Покрытие synchronous API

HTTP-потоки IF-001, IF-002, IF-003, IF-009 и IF-010 покрыты
[openapi.yaml](openapi.yaml). In-app Swagger endpoint доступен на `/api` на
порту `3010`.

## Покрытие asynchronous API

Kafka-потоки IF-004 и IF-005 покрыты [asyncapi.yaml](asyncapi.yaml) и
[kafka-access-map.md](kafka-access-map.md).
