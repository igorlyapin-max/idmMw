# idmMw — Middleware для Avanpost IDM 7.8

Промежуточный слой (integration hub) между Avanpost IDM 7.8 и целевыми системами. Обеспечивает идемпотентность, retry с экспоненциальным backoff, DLQ (Dead Letter Queue), audit log и административный UI.

## Стек

- **Backend:** Node.js 20+, NestJS 11+, TypeScript strict
- **Frontend:** React 19, Vite, TypeScript
- **Database:** PostgreSQL 15+ (dev) / CockroachDB или YugabyteDB (prod)
- **ORM:** Prisma
- **Cache/Lock:** PostgreSQL или Redis idempotency store
- **Message Bus (опц.):** Apache Kafka 3.x
- **Monitoring:** Prometheus + Grafana
- **Logging:** pino (JSON) в stdout/stderr, опционально второй sink в JSON log file
- **Security:** per-connection TLS, AES-256-GCM infrastructure encryption, keyring/key rotation

## Быстрый старт

### Требования

- Node.js 20+
- Docker + Docker Compose
- PostgreSQL (или Docker)

### Установка

```bash
npm install
```

### Dev окружение

```bash
# Поднять PostgreSQL
docker compose -f docker-compose.dev.yml up -d

# Применить миграции
npx prisma migrate dev

# Запустить backend
cp .env.example .env
npm run start:dev
```

Backend доступен на `http://localhost:3010`.

TLS для inbound API/Admin UI включается через `HTTP_TLS_ENABLED=true`; после
этого endpoint доступен на `https://localhost:3010`.

### Контейнерная поставка

Для передачи unix-админам используйте готовые image-only compose/env профили,
а не локальный `npm` workflow. Подробная инструкция по сборке и push образов,
`.env`, PAM secret references, DB init/migrations и runtime checks:
[docs/CONTAINER_DEPLOYMENT_ADMIN_GUIDE.md](docs/CONTAINER_DEPLOYMENT_ADMIN_GUIDE.md).

Default DEV поставка:

```bash
cp deploy/profiles/dev-sqlite.env.example deploy/profiles/dev-sqlite.env
# replace REPLACE_REGISTRY in deploy/profiles/dev-sqlite.env
docker compose --env-file deploy/profiles/dev-sqlite.env \
  -f deploy/docker-compose.dev-sqlite.yml \
  --profile init run --rm idmmw-db-init
docker compose --env-file deploy/profiles/dev-sqlite.env \
  -f deploy/docker-compose.dev-sqlite.yml up -d idmmw
```

### Сборка и запуск UI

```bash
cd ui
npm install
npm run build
```

UI раздаётся NestJS автоматически при `ADMIN_UI_ENABLED=true`.

### Monitoring

```bash
docker compose -f docker-compose.monitoring.yml up -d
```

- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3000` (admin/admin)
- Метрики приложения: `http://localhost:3010/metrics`
- Admin summary: `GET http://localhost:3010/admin/stats` показывает DLQ size,
  processed events за последние 5 минут и состояние Kafka/Redis mode.

## Архитектура

Архитектурные артефакты: GKM AA set находится в [aa/README.md](aa/README.md),
а C4-like views, runtime flows, deployment view, data/security view и ADR
находятся в [docs/architecture/README.md](docs/architecture/README.md).

### Компоненты

| Компонент          | Описание                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| Webhook Controller | Приём событий от Avanpost IDM (`POST /webhooks/avanpost`)                                                       |
| Idempotency        | Предотвращение дубликатов через PostgreSQL `IdempotencyKey` или Redis `SET NX EX`                               |
| Retry              | Экспоненциальный backoff, max 3 попытки по умолчанию; можно переопределить на `TargetSystem.config.retryPolicy` |
| DLQ                | Хранение неуспешных событий для ручной обработки                                                                |
| Audit              | Логирование всех входящих и исходящих вызовов                                                                   |
| Dispatcher         | Маршрутизация событий → коннекторы                                                                              |
| Connectors         | REST, DB (SQL через knex), Zabbix, CMDBuild, Passwork                                                           |
| Kafka (опц.)       | Event mirror, DLQ retry и async worker pipeline                                                                 |
| Admin API          | DLQ management, Target Systems management, protected by optional admin auth                                     |
| Admin UI           | React-приложение для DLQ, Target Systems и ручного retry                                                        |

### IDM multi-target contract

Avanpost IDM взаимодействует с idmMw как с одним middleware endpoint для многих
целевых систем:

```text
POST /webhooks/avanpost
```

Один webhook адресован одной системе. Для нескольких систем IDM отправляет
несколько webhook в тот же endpoint, меняя `targetSystem`.

```json
{
  "eventId": "idm-1001:zabbix-prod",
  "operation": "user.create",
  "targetSystem": "zabbix-prod",
  "payload": {
    "data": {
      "username": "ivanov"
    }
  }
}
```

Правила контракта:

- `targetSystem = TargetSystem.name` из БД или static connector name для legacy
  mode.
- `eventId = бизнес-событие + targetSystem`, чтобы одно бизнес-событие могло
  безопасно уйти в несколько систем без idempotency collision.
- `payload.data` содержит данные изменения, `payload.params` содержит
  query/path-like параметры read operations.
- `/idm/target-systems` и `/idm/:targetSystem/*` используются как IDM-facing
  catalog/read facade и не возвращают `config` или секреты.

Подробная инструкция администратора IDM:
[docs/IDM_ADMIN_DEPLOYMENT.md](docs/IDM_ADMIN_DEPLOYMENT.md).

### Feature-флаги

Все опциональные компоненты управляются через env-переменные:

```env
REDIS_ENABLED=false          # true включает Redis idempotency store
KAFKA_ENABLED=false          # true включает Kafka producer/consumer
IDMMW_PROCESSING_MODE=sync   # sync | async
DB_CONNECTOR_ENABLED=false   # true для SQL-коннектора
ADMIN_UI_ENABLED=true        # true для раздачи React UI
ADMIN_AUTH_ENABLED=false     # true включает auth guard для /admin/*
ADMIN_AUTH_MODE=local        # local | sso | both
ADMIN_AUTH_TRUSTED_PROXY_CIDRS=127.0.0.1/32 # обязательно для SSO modes
INTEGRATION_AUTH_ENABLED=false # true включает HMAC auth для /webhooks/* и /idm/*
INTEGRATION_AUTH_SECRET=      # HMAC secret; обязателен, если auth включен
METRICS_PUBLIC_ENABLED=true   # false закрывает /metrics тем же HMAC auth
STATIC_CONNECTOR_ALLOWLIST=fake # direct static routes; prod-ha оставляет пустым
DebugLogging__Enabled=false  # true для diagnostic logging
DebugLogging__Level=Basic    # Basic | Verbose
LOG_SINK=stdout              # stdout | file
LOG_FILE_PATH=/tmp/idmmw.log # используется при LOG_SINK=file
```

### Модель данных (Prisma)

- **AuditLog** — запись всех webhook и исходящих вызовов
- **DlqItem** — неуспешные события (status: pending, retrying, skipped, resolved)
- **IdempotencyKey** — ключи для deduplication
- **TargetSystem** — конфигурация целевых систем (Zabbix, CMDBuild, Passwork, REST, DB)
- **EncryptionState** — состояние включенного шифрования и active key id

## Security: TLS и шифрование

Полная процедура включения TLS, первого запуска шифрования и key rotation:
[docs/SECURITY_TLS_ENCRYPTION.md](docs/SECURITY_TLS_ENCRYPTION.md).

Кратко:

- TLS управляется отдельно для каждого соединения: `HTTP_TLS_*`, `REDIS_TLS_*`, `KAFKA_TLS_*`, `DB_CONNECTOR_TLS_*`, а для целевых систем через `config.tls`.
- Admin UI использует тот же listener/TLS, что inbound API. В production включайте `ADMIN_AUTH_ENABLED=true`; поддерживаются local credentials и SSO headers с allowlist/groups.
- При `ENCRYPTION_ENABLED=true` шифруются audit/DLQ/TargetSystem JSON поля, Kafka payloads и idempotency keys через HMAC.
- Первое включение шифрования допускается только на пустой системе.
- Key rotation выполняется в maintenance mode командой `npm run security:rotate-key`.
- Ключи должны быть base64 32 bytes; для Indeed PAM используйте `secret://...` значения в `ENCRYPTION_KEY_<KEY_ID>`.

## Легковесный режим (SQLite)

Для dev и маленьких инсталляций доступен режим на SQLite — без PostgreSQL, Redis, Kafka:

```bash
# Настройка SQLite (один раз)
npm run db:setup:sqlite

# Запуск в lightweight режиме
npm run dev:sqlite
```

Переменные окружения для SQLite:

```env
LIGHTWEIGHT_MODE=true
DATABASE_PROVIDER=sqlite
DATABASE_URL=file:./data/idmmw.db
```

В lightweight режиме:

- База данных — SQLite (файл `data/idmmw.db`)
- Kafka и Redis по умолчанию отключены; для HA используйте PostgreSQL/YugabyteDB/CockroachDB плюс Redis/Kafka
- Single worker (no clustering)
- JSON поля хранятся как сериализованные строки

## Env-переменные

```env
# App
PORT=3010
NODE_ENV=development

# Database (обязательно)
DATABASE_URL=postgresql://user:pass@host:port/db
DATABASE_FLAVOR=postgresql   # postgresql | yugabytedb | cockroachdb

# Redis (опционально)
REDIS_ENABLED=false          # true включает Redis idempotency store
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_DB=0
REDIS_PASSWORD=
# REDIS_SENTINEL_HOSTS=redis1:26379,redis2:26379,redis3:26379  # prod only

# Kafka (опционально)
KAFKA_ENABLED=false
KAFKA_BROKERS=localhost:9092
KAFKA_CLIENT_ID=idmmw
KAFKA_CONSUMER_GROUP_ID=idmmw-worker-group
KAFKA_TOPIC_EVENTS_IN=idm.events.in
KAFKA_TOPIC_EVENTS_OUT=idm.events.out
KAFKA_TOPIC_DLQ_RETRY=idm.dlq.retry
IDMMW_PROCESSING_MODE=sync   # sync | async
DLQ_RETRY_LEASE_SECONDS=300

# DB Connector (опционально)
DB_CONNECTOR_ENABLED=false
DB_CONNECTOR_URL=postgresql://... # для oracledb: host:1521/service
DB_CONNECTOR_DIALECT=pg           # pg | mysql2 | sqlite3 | oracledb
DB_CONNECTOR_USERNAME=            # требуется для oracledb
DB_CONNECTOR_PASSWORD=            # требуется для oracledb
DB_CONNECTOR_TLS_ENABLED=false

# Admin UI
ADMIN_UI_ENABLED=true
ADMIN_UI_SERVE_STATIC=true
ADMIN_AUTH_ENABLED=false
ADMIN_AUTH_MODE=local                # local | sso | both
ADMIN_AUTH_LOCAL_USERNAME=admin
ADMIN_AUTH_LOCAL_PASSWORD=change-me
ADMIN_AUTH_SESSION_SECRET=           # длинный random secret, required when auth enabled
ADMIN_AUTH_COOKIE_SECURE=            # default: true in production or when HTTP_TLS_ENABLED=true
ADMIN_AUTH_ALLOWLIST=                # SSO users, comma-separated
ADMIN_AUTH_ALLOWED_GROUPS=           # SSO groups, comma-separated
ADMIN_AUTH_SSO_USER_HEADER=x-authenticated-user
ADMIN_AUTH_SSO_GROUPS_HEADER=x-authenticated-groups
HTTP_TLS_ENABLED=false

# Mock IDM (только dev/test)
MOCK_IDM_ENABLED=true

# Diagnostic logging
DebugLogging__Enabled=false
DebugLogging__Level=Basic    # Basic | Verbose
LOG_SINK=stdout              # stdout | file
LOG_FILE_PATH=/tmp/idmmw.log

# Security
ENCRYPTION_ENABLED=false
ENCRYPTION_ACTIVE_KEY_ID=key_2026_06
ENCRYPTION_KEYS=key_2026_06
ENCRYPTION_KEY_KEY_2026_06=       # base64 32 bytes или secret://...
```

Oracle DB connector использует `oracledb` Thin mode, поэтому Oracle Instant
Client не требуется для базового подключения. Для runtime-конфигурации
`DB_CONNECTOR_URL` задается как `connectString`, например `host:1521/service`.

## HA deployment modes

| Режим               | Конфигурация                                                                                   | Поведение                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Single-node sync    | `IDMMW_PROCESSING_MODE=sync`, `KAFKA_ENABLED=false`, `REDIS_ENABLED=false`                     | Текущий простой режим: запрос IDM сразу вызывает целевую систему, deduplication в БД.                                           |
| Multi-worker sync   | `IDMMW_PROCESSING_MODE=sync`, общая PostgreSQL-compatible БД, опционально `REDIS_ENABLED=true` | Несколько процессов принимают webhook; duplicate `eventId` отсекается через БД или Redis.                                       |
| Async Kafka workers | `IDMMW_PROCESSING_MODE=async`, `KAFKA_ENABLED=true`                                            | Write-события кладутся в `KAFKA_TOPIC_EVENTS_IN`, worker group обрабатывает их, статусы публикуются в `KAFKA_TOPIC_EVENTS_OUT`. |
| DLQ retry workers   | `KAFKA_ENABLED=true`, `KAFKA_TOPIC_DLQ_RETRY=idm.dlq.retry`                                    | Ручной retry получает lease на `DlqItem`, публикует событие в Kafka и worker помечает item `resolved` при успехе.               |

DB compatibility:

- PostgreSQL: основной production provider `provider = "postgresql"`.
- YugabyteDB: используется как PostgreSQL-compatible YSQL backend через текущий Prisma `provider = "postgresql"` и обычный PostgreSQL DSN.
- CockroachDB: используйте `prisma/schema.cockroach.prisma` с Prisma `provider = "cockroachdb"` и проверяйте его через `npm run db:validate:cockroach` перед rollout.

Live HA проверка на текущем стенде:

```bash
# Использует Redis 127.0.0.1:16379 и Kafka 127.0.0.1:9092
npm run test:ha-live
```

Deployment profiles for CI and rollout:

- `dev-sqlite`: default administrator-facing DEV profile with prebuilt image
  and SQLite volume.
- `dev-postgres`: APP + PostgreSQL DEV profile with prebuilt app image.
- `sqlite-test`: one worker, SQLite, no Kafka/Redis; used by CI smoke.
- `prod-ha-yugabyte`: recommended production HA profile with external Kafka and
  YugabyteDB YSQL through the normal PostgreSQL Prisma schema.
- `prod-ha-cockroach`: alternative HA profile with
  `prisma/schema.cockroach.prisma`.

Detailed profile contracts and commands:
[docs/DEPLOYMENT_PROFILES.md](docs/DEPLOYMENT_PROFILES.md).

## API Endpoints

| Метод  | Путь                               | Описание                                          |
| ------ | ---------------------------------- | ------------------------------------------------- |
| GET    | `/health`                          | Liveness без внутренней топологии                 |
| GET    | `/ready`                           | Readiness: DB, Redis и Kafka runtime state        |
| POST   | `/webhooks/avanpost`               | Приём событий от Avanpost IDM                     |
| GET    | `/idm/target-systems`              | IDM-facing каталог включённых целевых систем      |
| GET    | `/idm/target-systems/:name`        | IDM-facing карточка целевой системы               |
| GET    | `/idm/:targetSystem/test`          | Read facade: `system.test` целевой системы        |
| GET    | `/idm/:targetSystem/users`         | Read facade: список пользователей целевой системы |
| GET    | `/idm/:targetSystem/users/resolve` | Read facade: resolve пользователя                 |
| GET    | `/idm/:targetSystem/users/:id`     | Read facade: пользователь целевой системы         |
| GET    | `/idm/:targetSystem/groups`        | Read facade: список групп целевой системы         |
| GET    | `/idm/:targetSystem/groups/:id`    | Read facade: группа целевой системы               |
| GET    | `/idm/:targetSystem/schema`        | Read facade: schema целевой системы               |
| POST   | `/idm/:targetSystem/sync`          | Read facade: `sync.full` или `sync.incremental`   |
| GET    | `/auth/session`                    | Состояние Admin UI auth session                   |
| POST   | `/auth/login`                      | Local admin login                                 |
| POST   | `/auth/sso-login`                  | SSO header-based admin login                      |
| POST   | `/auth/logout`                     | Завершить admin session                           |
| GET    | `/admin/stats`                     | DLQ size и processed last 5 minutes               |
| GET    | `/admin/dlq`                       | Список DLQ (`status`, `targetSystem`, пагинация)  |
| POST   | `/admin/dlq/retry`                 | Массовый retry по статусу/целевой системе         |
| POST   | `/admin/dlq/:id/retry`             | Повторная обработка                               |
| POST   | `/admin/dlq/:id/skip`              | Пропустить событие                                |
| GET    | `/metrics`                         | Prometheus метрики                                |
| GET    | `/api`                             | Swagger UI                                        |
| GET    | `/admin/target-systems`            | Список target systems                             |
| POST   | `/admin/target-systems`            | Создать target system                             |
| PATCH  | `/admin/target-systems/:id`        | Обновить target system                            |
| DELETE | `/admin/target-systems/:id`        | Удалить target system                             |
| POST   | `/admin/target-systems/:id/test`   | Проверить связь                                   |

Когда `ADMIN_AUTH_ENABLED=true`, все `/admin/*` endpoints требуют admin session.
State-changing запросы (`POST`, `PATCH`, `DELETE`) должны передавать
`X-CSRF-Token` из `/auth/session` или ответа login. `/webhooks/avanpost` и
`/idm/*` защищаются отдельным HMAC-контрактом при
`INTEGRATION_AUTH_ENABLED=true`: `X-IDMMW-Timestamp` и `X-IDMMW-Signature`.
Подпись считается как lowercase hex HMAC-SHA256 по canonical string
`<timestamp>\n<METHOD>\n<path-without-query>\n<sha256-body>`. Тело перед
подписью канонизируется как JSON с сортировкой ключей; пустое тело подписывается
как пустая строка. Заголовок `X-IDMMW-Signature` может содержать чистый hex или
префикс `sha256=`.
`/metrics` публичен только при `METRICS_PUBLIC_ENABLED=true`.

## Mock IDM (dev/test)

Модуль для тестирования без реального Avanpost IDM:

```bash
POST /mock-idm/scenario/user-create   # Создание пользователя
POST /mock-idm/scenario/user-update   # Обновление
POST /mock-idm/scenario/user-delete   # Удаление
POST /mock-idm/scenario/duplicate     # Дубликат (проверка idempotency)
POST /mock-idm/scenario/malformed     # Невалидный payload
POST /mock-idm/scenario/fail          # Ошибка коннектора → DLQ
```

## Тестирование

```bash
# Unit tests
npm run test

# E2E tests
npm run test:e2e

# E2E contract tests with isolated SQLite database
npm run test:e2e:sqlite

# Runtime smoke: build, startup, /health, /metrics,
# Verbose diagnostics, redaction and file log sink
npm run test:runtime-smoke

# Live HA smoke: real Redis + real Kafka containers
npm run test:ha-live

# Full local validation gate
./scripts/validate-structure.sh

# Нагрузочное тестирование
npx autocannon -c 10 -d 10 -m POST \
  -H "Content-Type: application/json" \
  -b '{"eventId":"load-1","operation":"user.create","targetSystem":"fake","payload":{"data":{"username":"load-user"}}}' \
  http://localhost:3010/webhooks/avanpost

# Валидация
npm run validate
```

## Troubleshooting

### Приложение не запускается

```bash
# Проверить конфигурацию
npm run validate

# Проверить подключение к БД
docker compose -f docker-compose.dev.yml ps

# Проверить логи
tail -f /tmp/idmmw.log
```

### DLQ растёт

1. Проверить метрики: `curl http://localhost:3010/metrics | grep dlq_size`
2. Проверить ошибки коннекторов: `grep "connector" /tmp/idmmw.log`
3. Ручной retry через Admin UI или API:
   ```bash
   curl -X POST http://localhost:3010/admin/dlq/<id>/retry
   ```

### Kafka не подключается

- Убедиться, что `KAFKA_ENABLED=true` и `KAFKA_BROKERS` корректны
- При `KAFKA_ENABLED=false` middleware работает синхронно (без потери функциональности)

### Redis недоступен

- При `REDIS_ENABLED=false` используется PostgreSQL `IdempotencyKey`.
- При `REDIS_ENABLED=true` startup подключается к `REDIS_HOST:REDIS_PORT`; если Redis недоступен, startup/readiness падают.
- Для локального стенда live smoke ожидает Redis на `127.0.0.1:16379`.

### Diagnostic logging

- По умолчанию diagnostic logging выключен.
- `DebugLogging__Enabled=true` включает diagnostic события через основной structured logging pipeline.
- `DebugLogging__Level=Basic` пишет безопасные события маршрутизации без payload.
- `DebugLogging__Level=Verbose` временно пишет расширенные diagnostic события с маскированием секретов.
- `LOG_SINK=file` добавляет второй JSON file sink в `LOG_FILE_PATH` для collector/sidecar; stdout/stderr остаётся включённым.
- `npm run test:runtime-smoke` проверяет реальный startup с `DebugLogging__Level=Verbose`, webhook diagnostics и отсутствие утечки password/token в log sink.

## Custom connector deployment

Подробное руководство по созданию и развёртыванию пользовательского коннектора:
[docs/CUSTOM_CONNECTOR_DEPLOYMENT.md](docs/CUSTOM_CONNECTOR_DEPLOYMENT.md)

Инструкция для администратора IDM по настройке multi-target webhook contract:
[docs/IDM_ADMIN_DEPLOYMENT.md](docs/IDM_ADMIN_DEPLOYMENT.md)

## Multi-instance target systems

Приложение поддерживает динамическую загрузку коннекторов из БД. Каждая запись `TargetSystem` описывает отдельный инстанс целевой системы:

```bash
# Пример: создать инстанс Zabbix
POST /admin/target-systems
{
  "name": "zabbix-prod",
  "type": "zabbix",
  "label": "Zabbix Production",
  "config": {
    "baseUrl": "http://zabbix.local",
    "apiToken": "...",
    "retryPolicy": {
      "maxRetries": 5,
      "baseDelayMs": 1000,
      "maxDelayMs": 30000,
      "dlqLeaseSeconds": 600,
      "jitter": true
    }
  },
  "enabled": true
}
```

Для Passwork используйте отдельный `TargetSystem` типа `passwork`. V1 connector
управляет пользователями и группами Passwork через HTTP API и не читает,
не расшифровывает и не изменяет password/vault item secrets.

```json
{
  "name": "passwork-prod",
  "type": "passwork",
  "label": "Passwork Production",
  "config": {
    "baseUrl": "https://passwork.example.local",
    "accessToken": "REPLACE_WITH_SECRET",
    "responseFormat": "raw",
    "timeout": 30000,
    "tls": {
      "enabled": true,
      "caPath": "/etc/idmmw/tls/passwork-ca.crt",
      "serverName": "passwork.example.local",
      "rejectUnauthorized": true
    }
  },
  "enabled": true
}
```

Локальный mutating smoke для тестового Passwork стенда:

```bash
npm run test:passwork-live
```

Скрипт читает `../passwork/url.passwork` и `../passwork/api.passwork`, стартует
временный idmMw runtime и удаляет созданные тестовые user/group в cleanup. Для
локального стенда поддержан fallback через
`../passwork/passwork-admin-credentials.txt`, если token-файл не является
действующей Passwork-сессией.

Поддерживаемые типы: `zabbix`, `cmdbuild`, `passwork`, `rest`, `db`, `fake`.

`retryPolicy` задаётся для конкретной управляемой системы. Он применяется к
обычной обработке write-событий и к ручному DLQ retry. Если политика не задана,
используются defaults: `maxRetries=3`, `baseDelayMs=1000`,
`maxDelayMs=30000`, `dlqLeaseSeconds=DLQ_RETRY_LEASE_SECONDS`, `jitter=true`.

## Лицензия

UNLICENSED

## Управление секретами (Indeed PAM AAPM)

Для production-инсталляций рекомендуется использовать внешнее хранилище секретов вместо env-переменных.

### Конфигурация

```env
SECRETS_PROVIDER=IndeedPamAapm
SECRETS_INDEEDPAMAAPM_BASEURL=https://pam.company.local
SECRETS_INDEEDPAMAAPM_APPLICATIONTOKEN=app-token
# или
SECRETS_INDEEDPAMAAPM_APPLICATIONUSERNAME=app-user
SECRETS_INDEEDPAMAAPM_APPLICATIONPASSWORD=app-pass
SECRETS_INDEEDPAMAAPM_DEFAULTACCOUNTPATH=default/path
```

### Формат ссылок

В значениях env-переменных можно использовать PAM-ссылки:

```env
ZABBIX_PASSWORD=secret://Zabbix.ProdPass
CMDBUILD_PASSWORD=aapm://CMDBuild/ProdPass
```

При старте приложения `SecretResolverService` автоматически резолвит ссылки через Indeed PAM AAPM API.

### Legacy env vars

Legacy переменные `PAM*` не поддерживаются. Используйте только canonical
`SECRETS_INDEEDPAMAAPM_*` и явно задавайте `SECRETS_PROVIDER=IndeedPamAapm`.
