# Руководство по развёртыванию пользовательского (custom) коннектора в idmMw

> **Цель:** Дать инженеру и администратору полное пошаговое руководство по созданию, развёртыванию и эксплуатации custom коннектора целевой системы внутри middleware idmMw.
> **Версия:** 1.0
> **Основа:** Текущая кодовая база `~/projects/idmMw` (NestJS 11, Prisma, React Admin UI).

---

## Содержание

1. [Обзор и предварительные условия](#1-обзор-и-предварительные-условия)
2. [Архитектура и поток данных](#2-архитектура-и-поток-данных)
3. [Пошаговая инструкция: создание custom коннектора](#3-пошаговая-инструкция-создание-custom-коннектора)
4. [Справочник по конфигурации](#4-справочник-по-конфигурации)
5. [Процедуры развёртывания](#5-процедуры-развёртывания)
6. [Процедуры проверки и тестирования](#6-процедуры-проверки-и-тестирования)
7. [Диагностика неисправностей](#7-диагностика-неисправностей)
8. [Чек-лист безопасности](#8-чек-лист-безопасности)
9. [Интеграция с существующей документацией](#9-интеграция-с-существующей-документацией)

---

## 1. Обзор и предварительные условия

### Стек и версии

| Компонент  | Версия        |
| ---------- | ------------- |
| Node.js    | 22+           |
| NestJS     | 11+           |
| TypeScript | strict        |
| Prisma     | latest        |
| React      | 19 (Admin UI) |

### Роли и ответственность

| Роль                | Зона ответственности                                                        |
| ------------------- | --------------------------------------------------------------------------- |
| Backend-разработчик | Написание сервиса коннектора, unit-тесты, регистрация в DI                  |
| DevOps-инженер      | Развёртывание, миграции БД, мониторинг, env-переменные                      |
| Администратор IDM   | Создание `TargetSystem` через Admin UI, заполнение `config`, проверка связи |

### Что такое custom коннектор

Custom коннектор — это новая реализация интерфейса `Connector`, позволяющая idmMw отправлять события управления учётными записями (создание, изменение, удаление пользователей и групп) в произвольную целевую систему через HTTP REST API.

---

## 2. Архитектура и поток данных

### 2.1 Терминология

- **Static connector (blueprint)** — класс в исходном коде, который знает, _как_ разговаривать с типом системы (REST, Zabbix, CMDBuild и т.д.). Регистрируется один раз в `ConnectorRegistry` через `registerStatic()`.
- **Dynamic proxy** — обёртка вокруг static connector, создаваемая для каждой записи `TargetSystem` в БД. Внедряет per-instance конфигурацию (URL, ключи, таймауты) в каждый вызов `execute()`.
- **TargetSystem** — запись в таблице БД: `name`, `type`, `config` (JSON), `enabled`.

### 2.2 Полный flow от webhook до коннектора

```
Avanpost IDM
     │
     ▼
POST /webhooks/avanpost  (WebhookController)
     │
     ▼
WebhookService.processWebhook()
     │
     ├── idempotency check (deduplication by eventId)
     │
     ▼
DispatcherService.dispatch()
     │
     ├── ProcessingService.process()  (retry logic, max 3 attempts)
     │       │
     │       ▼
     │   ConnectorRegistry.get(targetSystem)
     │       │
     │       ├── static name ──► static connector (legacy mode)
     │       │
     │       └── DB name ──────► proxy ──► static connector
     │               │
     │               ▼
     │        payload.config = DB config  (merged by proxy)
     │               │
     │               ▼
     │        HTTP request to target system
     │
     ▼
Kafka event (optional, only if KAFKA_ENABLED=true)
```

### 2.3 Как проносятся настройки подключения

```
Admin UI / API
     │
     ▼
POST /admin/target-systems
     │
     ▼
Prisma: TargetSystem { name: "my-system-prod",
                        type: "my-system",
                        config: { baseUrl: "https://api.example.com",
                                  apiKey: "...",
                                  timeout: 15000 } }
     │
     ▼
ConnectorRegistry.reload()  (called automatically on every CRUD)
     │
     ▼
createProxy("my-system", "my-system-prod", config)
     │
     ▼
Proxy.execute(payload) {
   payload.config = config  // <-- inject from DB
   return baseConnector.execute(payload)
}
```

**Ключевое правило:** параметры подключения никогда не хранятся в коде коннектора. Они приходят через `payload.config`, который заполняется в Admin UI и хранится в БД.

### 2.4 Как мапятся operations

`operation` из webhook передаётся **как есть** через всю цепочку:

```
Webhook:  { operation: "user.create", ... }
              │
              ▼
Dispatcher ──► ProcessingService.process({ operation: "user.create" })
              │
              ▼
Connector ──► execute({ operation: "user.create", ... })
```

Каждый коннектор сам решает, как интерпретировать `operation`:

- **Zabbix** — передаёт как `method` в Zabbix API.
- **CMDBuild** — использует `switch(operation)` для выбора URL/method.
- **Fake/REST/Custom** — может игнорировать, логировать или мапить на собственные endpoint'ы.

---

## 3. Пошаговая инструкция: создание custom коннектора

> **Оценка времени:** 10–15 минут на код + 10 минут на тестирование и проверку.
> **Живой пример:** `src/connectors/implementations/fake-connector/fake-connector.service.ts`

### 3.1 Шаг 1 — Создать сервис-коннектор

Создайте файл `src/connectors/implementations/my-system/my-system.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import {
  Connector,
  ConnectorPayload,
  ConnectorResult,
} from '../../connector.interface';

export interface MySystemConfig {
  baseUrl: string;
  apiKey?: string;
  timeout?: number;
}

@Injectable()
export class MySystemConnectorService implements Connector {
  readonly name = 'my-system';
  private readonly logger = new Logger(MySystemConnectorService.name);

  constructor(private readonly httpService: HttpService) {}

  async execute(payload: ConnectorPayload): Promise<ConnectorResult> {
    const config = payload.payload['config'] as MySystemConfig | undefined;
    if (!config?.baseUrl) {
      return { success: false, error: 'Missing config (baseUrl)' };
    }

    try {
      const response = await lastValueFrom(
        this.httpService.post(
          `${config.baseUrl}/api/users`,
          payload.payload['data'] ?? {},
          {
            headers: config.apiKey ? { 'X-Api-Key': config.apiKey } : undefined,
            timeout: config.timeout ?? 10000,
          },
        ),
      );
      this.logger.log(`Success: ${response.status}`);
      return { success: true, data: response.data };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed: ${msg}`);
      return { success: false, error: msg };
    }
  }

  async testConnection(
    config: Record<string, unknown>,
  ): Promise<{ success: boolean; message: string }> {
    const cfg = config as unknown as MySystemConfig;
    if (!cfg.baseUrl) {
      return { success: false, message: 'Missing baseUrl' };
    }
    try {
      const res = await lastValueFrom(
        this.httpService.get(`${cfg.baseUrl}/health`, {
          timeout: cfg.timeout ?? 5000,
        }),
      );
      return {
        success: true,
        message: `Reachable (status ${res.status})`,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, message: `Connection failed: ${msg}` };
    }
  }
}
```

**Обязательные правила:**

1. Всегда валидируйте `config` перед использованием.
2. Всегда оборачивайте HTTP-вызовы в `try/catch`.
3. Возвращайте понятные сообщения об ошибках.
4. Не храните чувствительные данные в коде — они приходят через `payload.config`.

**Интерфейс `Connector` (для справки):**

```typescript
export interface Connector {
  readonly name: string;
  execute(payload: ConnectorPayload): Promise<ConnectorResult>;
  testConnection(
    config: Record<string, unknown>,
  ): Promise<{ success: boolean; message: string }>;
  getSchema?(payload: ConnectorPayload): Promise<ConnectorResult>;
  sync?(payload: ConnectorPayload, mode: string): Promise<ConnectorResult>;
}
```

### 3.2 Шаг 2 — Зарегистрировать в модуле

Откройте `src/connectors/connectors.module.ts` и добавьте импорт и провайдер:

```typescript
import { MySystemConnectorService } from './implementations/my-system/my-system.service';

@Module({
  imports: [HttpModule, PrismaModule],
  providers: [
    ConnectorRegistry,
    RestConnectorService,
    DbConnectorService,
    ZabbixConnectorService,
    CmdbuildConnectorService,
    FakeConnectorService,
    MySystemConnectorService, // <-- добавить
  ],
  exports: [ConnectorRegistry],
})
export class ConnectorsModule {}
```

### 3.3 Шаг 3 — Зарегистрировать в ConnectorRegistry

Откройте `src/connectors/connector.registry.ts`:

```typescript
import { MySystemConnectorService } from './implementations/my-system/my-system.service';

export class ConnectorRegistry implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jsonHelper: JsonHelper,
    private readonly restConnector: RestConnectorService,
    private readonly dbConnector: DbConnectorService,
    private readonly zabbixConnector: ZabbixConnectorService,
    private readonly cmdbuildConnector: CmdbuildConnectorService,
    private readonly fakeConnector: FakeConnectorService,
    private readonly mySystemConnector: MySystemConnectorService, // <-- inject
  ) {
    this.registerStatic(this.restConnector);
    this.registerStatic(this.dbConnector);
    this.registerStatic(this.zabbixConnector);
    this.registerStatic(this.cmdbuildConnector);
    this.registerStatic(this.fakeConnector);
    this.registerStatic(this.mySystemConnector); // <-- register
  }
  // ... остальной код без изменений
}
```

После этого `ConnectorRegistry` автоматически:

- Создаст proxy для каждой записи `TargetSystem` с `type = 'my-system'`.
- Будет мержить `config` из БД в `payload` при вызове `execute`.

### 3.4 Шаг 4 — Добавить форму в Admin UI

Откройте `ui/src/pages/TargetSystemsPage.tsx` (или эквивалентный файл с конфигурацией полей):

```typescript
const TYPE_OPTIONS = ['zabbix', 'cmdbuild', 'rest', 'db', 'fake', 'my-system'];

const TYPE_FIELDS: Record<string, ConfigField[]> = {
  // ... другие типы
  'my-system': [
    {
      name: 'baseUrl',
      label: 'Base URL',
      placeholder: 'https://api.internal.local',
      help: 'Target API root URL.',
    },
    {
      name: 'apiKey',
      label: 'API key',
      inputType: 'password',
      help: 'Optional bearer/API secret used by the connector.',
    },
    { name: 'timeout', label: 'Timeout ms' },
  ],
};
```

Имена `TYPE_FIELDS[].name` должны совпадать с реальными ключами
`TargetSystem.config`, которые читает коннектор. Не добавляйте абстрактные поля
вроде `code`, если коннектор ожидает `apiToken`, `password`, `apiKey` или другой
конкретный ключ.

Пересоберите UI:

```bash
cd ui
npm install
npm run build
```

> **Примечание:** NestJS автоматически раздаёт собранный UI при `ADMIN_UI_ENABLED=true`.

### 3.5 Шаг 5 — Написать unit-тест

Скопируйте `src/connectors/implementations/fake-connector/fake-connector.service.spec.ts` и адаптируйте под свои endpoint'ы.

Минимальный набор тестов:

- `execute` — успешный HTTP-вызов.
- `execute` — ошибка при отсутствии `baseUrl`.
- `execute` — ошибка сети (ECONNREFUSED).
- `testConnection` — успех.
- `testConnection` — неудача.

Запуск:

```bash
npm test -- my-system
```

### 3.6 Шаг 6 — Создать TargetSystem через Admin API или UI

**Через API:**

```bash
curl -X POST http://localhost:3010/admin/target-systems \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-system-prod",
    "type": "my-system",
    "label": "My System Production",
    "config": {
      "baseUrl": "https://api.mysystem.local",
      "apiKey": "REPLACE_ME",
      "timeout": 15000
    },
    "enabled": true
  }'
```

Если `ADMIN_AUTH_ENABLED=true`, перед вызовом `/admin/*` получите admin
session через `/auth/login` или `/auth/sso-login`. Для state-changing запросов
(`POST`, `PATCH`, `DELETE`) передавайте `X-CSRF-Token` из ответа login или
`/auth/session`.

**Через Admin UI:**
Откройте `http://localhost:3010/` → **Target Systems** → **Create**.

> **Важно:** После создания или изменения `TargetSystem` контроллер автоматически вызывает `registry.reload()`, поэтому перезапуск приложения **не требуется**.

---

## 4. Справочник по конфигурации

### 4.1 Env-переменные, относящиеся к коннекторам

| Переменная               | Значение по умолчанию | Описание                                               |
| ------------------------ | --------------------- | ------------------------------------------------------ |
| `DB_CONNECTOR_ENABLED`   | `false`               | Включить SQL-коннектор (knex)                          |
| `DB_CONNECTOR_URL`       | —                     | URL для SQL-коннектора; для Oracle `host:1521/service` |
| `DB_CONNECTOR_DIALECT`   | `pg`                  | Диалект: `pg`, `mysql2`, `sqlite3`, `oracledb`         |
| `DB_CONNECTOR_USERNAME`  | —                     | Пользователь Oracle-коннектора                         |
| `DB_CONNECTOR_PASSWORD`  | —                     | Пароль Oracle-коннектора                               |
| `ADMIN_UI_ENABLED`       | `true`                | Раздавать React Admin UI                               |
| `ADMIN_UI_SERVE_STATIC`  | `true`                | Раздавать статику из `ui/dist`                         |
| `KAFKA_ENABLED`          | `false`               | Включить Kafka producer/consumer                       |
| `KAFKA_BROKERS`          | `localhost:9092`      | Kafka bootstrap brokers                                |
| `KAFKA_TOPIC_EVENTS_IN`  | `idm.events.in`       | Topic для async write-событий                          |
| `KAFKA_TOPIC_EVENTS_OUT` | `idm.events.out`      | Topic статусов обработки                               |
| `KAFKA_TOPIC_DLQ_RETRY`  | `idm.dlq.retry`       | Topic ручного DLQ retry                                |
| `IDMMW_PROCESSING_MODE`  | `sync`                | `sync` или `async`; async требует Kafka                |
| `REDIS_ENABLED`          | `false`               | Redis idempotency store                                |
| `REDIS_HOST`             | `localhost`           | Redis host                                             |
| `REDIS_PORT`             | `6379`                | Redis port                                             |

Для `DB_CONNECTOR_DIALECT=oracledb` используется `oracledb` Thin mode:
достаточно npm-драйвера, `DB_CONNECTOR_URL` в формате `host:1521/service`,
`DB_CONNECTOR_USERNAME` и `DB_CONNECTOR_PASSWORD`. Oracle Instant Client нужен
только для Thick mode, который сейчас не включается автоматически.

### 4.2 Схема JSON поля `config` в `TargetSystem`

Поле `config` произвольного формата — структура определяется конкретным коннектором. Рекомендуемые соглашения:

```json
{
  "baseUrl": "https://api.example.com",
  "timeout": 15000,
  "apiKey": "...",
  "retryPolicy": {
    "maxRetries": 3,
    "baseDelayMs": 1000,
    "maxDelayMs": 30000,
    "dlqLeaseSeconds": 300,
    "jitter": true
  },
  "tls": {
    "enabled": true,
    "caPath": "/etc/idmmw/tls/target-ca.crt",
    "certPath": "/etc/idmmw/tls/idmmw-client.crt",
    "keyPath": "/etc/idmmw/tls/idmmw-client.key",
    "serverName": "api.example.com",
    "rejectUnauthorized": true
  }
}
```

Коннектор обязан валидировать наличие обязательных полей самостоятельно в методе `execute`.
Если `tls.enabled=true`, URL целевой системы должен использовать `https://`.
`retryPolicy` применяется idmMw к write-событиям и ручному DLQ retry для
конкретного `TargetSystem`; коннектор не должен реализовывать собственный
глобальный счётчик попыток поверх этого контракта.
Подробный security runbook: `docs/SECURITY_TLS_ENCRYPTION.md`.

### 4.3 Управление учётными данными

Для production-инсталляций рекомендуется использовать внешнее хранилище секретов (Indeed PAM AAPM) вместо хранения паролей в `config`.

Конфигурация PAM описана в `README.md` разделе "Управление секретами". При использовании PAM ссылки на секреты резолвятся при старте приложения, а значения env-переменных подставляются в `process.env` до инициализации Prisma.

> **Важно:** Не размещайте пароли в Admin UI поле `config` в production без PAM. Если PAM недоступен, используйте env-переменные приложения и читайте их через `process.env` (только для статических параметров, не для per-instance конфигурации).

---

## 5. Процедуры развёртывания

### 5.1 Dev / Lightweight режим (SQLite)

Для разработки и тестирования custom коннектора не требуется PostgreSQL, Redis или Kafka:

```bash
# Настройка SQLite (один раз)
npm run db:setup:sqlite

# Запуск в lightweight режиме
npm run dev:sqlite
```

Переменные окружения (автоматически при `dev:sqlite`):

```env
LIGHTWEIGHT_MODE=true
DATABASE_PROVIDER=sqlite
DATABASE_URL=file:./data/idmmw.db
```

В lightweight режиме:

- База данных — SQLite (файл `data/idmmw.db`).
- Kafka и Redis по умолчанию отключены.
- Single worker (no clustering); для HA включайте общую БД, Redis и/или Kafka.
- JSON поля хранятся как сериализованные строки.

### 5.2 Stand/dev deployment (PostgreSQL + Redis + Kafka)

`docker-compose.dev.yml` предназначен для dev/stand развёртывания и проверки
интеграции. Для production используйте управляемые PostgreSQL-compatible БД,
Redis/Kafka, systemd/Kubernetes/Compose profile с production secrets и TLS.

```bash
# Dev/stand инфраструктура
docker compose -f docker-compose.dev.yml up -d

# Миграции
npx prisma migrate deploy

# Сборка
npm run build

# Запуск
npm run start:prod
```

HA режимы:

- `IDMMW_PROCESSING_MODE=sync`: webhook сразу вызывает коннектор; Kafka может публиковать статусы в `KAFKA_TOPIC_EVENTS_OUT`.
- `IDMMW_PROCESSING_MODE=async`: write webhook кладётся в `KAFKA_TOPIC_EVENTS_IN`, worker group обрабатывает событие и публикует результат в `KAFKA_TOPIC_EVENTS_OUT`.
- `REDIS_ENABLED=true`: duplicate `eventId` отсекается Redis `SET NX EX`; при `false` используется таблица `IdempotencyKey`.
- Для live-проверки текущего стенда используйте `npm run test:ha-live` с Redis `127.0.0.1:16379` и Kafka `127.0.0.1:9092`.

### 5.3 Zero-downtime обновление коннектора

| Тип изменения                       | Требуется restart? | Процедура                                                                      |
| ----------------------------------- | ------------------ | ------------------------------------------------------------------------------ |
| Изменение `config` в `TargetSystem` | **Нет**            | Сохранить через Admin UI / API — `registry.reload()` вызывается автоматически. |
| Изменение кода коннектора           | **Да**             | Rolling restart: `npm run build && pm2 reload` (или аналог).                   |
| Добавление нового коннектора        | **Да**             | Требуется пересборка и перезапуск, т.к. меняется DI-контейнер.                 |

---

## 6. Процедуры проверки и тестирования

### 6.1 Статические проверки

```bash
# Lint + TypeScript + Unit tests
npm run validate

# Только unit-тесты нового коннектора
npm test -- my-system
```

### 6.2 Проверка связи (testConnection)

```bash
curl -X POST http://localhost:3010/admin/target-systems/<id>/test
```

При включённом `ADMIN_AUTH_ENABLED=true` этот endpoint требует admin session, а
запрос должен содержать `X-CSRF-Token`.

**Ожидаемые ответы:**

```json
// Успех
{ "success": true, "message": "Reachable (status 200)" }

// Неудача
{ "success": false, "message": "Connection failed: connect ECONNREFUSED ..." }
```

### 6.3 End-to-End тест через Mock IDM

```bash
# 1. Создание пользователя
curl -X POST http://localhost:3010/mock-idm/scenario/user-create \
  -H "Content-Type: application/json" \
  -d '{
    "eventId": "test-custom-001",
    "operation": "user.create",
    "targetSystem": "my-system-prod",
    "payload": { "data": { "username": "jdoe", "email": "jdoe@example.com" } }
  }'
```

**Проверки после E2E:**

```bash
# 2. Проверить обработку в structured logs
tail -50 /tmp/idmmw.log | grep "test-custom-001"

# 2a. Если нужен прямой DB check, проверьте AuditLog через Prisma/SQL
psql "$DATABASE_URL" -c \
  "select \"eventId\", operation, \"targetSystem\" from \"AuditLog\" where \"eventId\" = 'test-custom-001';"

# 3. Проверить, что DLQ не растёт
curl -s http://localhost:3010/metrics | grep idmmw_dlq_size

# 4. Проверить логи
tail -50 /tmp/idmmw.log | grep "my-system-prod"
```

### 6.4 Health и метрики

```bash
# Health check
curl -s http://localhost:3010/health | jq .
# Ожидаемый ответ: {"status":"ok","info":{"database":{"status":"up"}}}

# Prometheus метрики
curl -s http://localhost:3010/metrics | grep "idmmw_"
```

**Ключевые метрики для мониторинга коннектора:**

| Метрика                                   | Порог    | Действие                             |
| ----------------------------------------- | -------- | ------------------------------------ |
| `idmmw_dlq_size{status="pending"}`        | > 100    | Проверить коннекторы, массовый retry |
| `idmmw_connector_errors_total`            | > 10/мин | Проверить целевые системы            |
| `idmmw_http_request_duration_seconds` p95 | > 2s     | Проверить нагрузку, БД               |

---

## 7. Диагностика неисправностей

| Симптом                                  | Причина                                                | Действие                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `No connector found for type: my-system` | Опечатка в `ConnectorRegistry` или `TargetSystem.type` | Убедитесь, что свойство `name` класса (`'my-system'`) точно совпадает с полем `type` в БД                              |
| `Missing config (baseUrl)`               | В JSON `config` отсутствует обязательное поле          | Проверьте форму в Admin UI / payload API                                                                               |
| `ECONNREFUSED` в `execute`               | Целевая система недоступна или неверный URL            | Проверьте сеть, выполните `testConnection`                                                                             |
| DLQ растёт для custom коннектора         | Коннектор бросает необработанные ошибки                | Проверьте логи `/tmp/idmmw.log`, исправьте код коннектора                                                              |
| Изменения не применяются                 | Registry не перезагружен                               | Любая операция CRUD с `TargetSystem` вызывает `reload()` автоматически. При изменении кода — перезапустите приложение. |
| `Request failed with status code 404`    | Неверный URL в `payload` или `config`                  | Исправьте конфигурацию, пропустите событие (skip) через Admin UI если ошибка необратима                                |
| `Timeout`                                | Целевая система медленная                              | Увеличьте `timeout` в `config`, выполните retry                                                                        |

---

## 8. Чек-лист безопасности

- [ ] В коде коннектора нет захардкоженных паролей, ключей или URL production-систем.
- [ ] Чувствительные данные передаются только через `payload.config`.
- [ ] Метод `testConnection` не включает учётные данные в сообщения об ошибках.
- [ ] Все входящие поля `payload.config` проходят валидацию (тип, диапазон, обязательность).
- [ ] HTTP-вызовы имеют настроенный `timeout` (рекомендуется 5000–30000 мс).
- [ ] Включён `AuditLog` — все исходящие запросы фиксируются.
- [ ] Для production используется PAM AAPM или аналогичное хранилище секретов.
- [ ] Unit-тесты покрывают пути ошибок (network failure, timeout, 4xx/5xx).

---

## 9. Интеграция с существующей документацией

Этот документ является дополнением к следующим руководствам проекта idmMw:

| Документ                     | Что содержит                                           | Когда использовать                           |
| ---------------------------- | ------------------------------------------------------ | -------------------------------------------- |
| `README.md`                  | Общий обзор, стек, quick start, API endpoints          | Перед началом работы с проектом              |
| `OPERATOR_RUNBOOK.md`        | Health checks, DLQ, мониторинг, инциденты              | В процессе эксплуатации, при авариях         |
| `docs/CONNECTOR_TEMPLATE.md` | Шаблон кода нового коннектора (6 шагов)                | При написании кода коннектора                |
| **Этот документ**            | Развёртывание, конфигурация, проверка, troubleshooting | При внедрении custom коннектора в production |

---

## Приложение A: Пример полного JSON для создания TargetSystem

```json
{
  "name": "custom-api-prod",
  "type": "my-system",
  "label": "Custom API Production",
  "config": {
    "baseUrl": "https://api.internal.local/v1",
    "apiKey": "REPLACE_ME_IN_PRODUCTION",
    "timeout": 20000,
    "headers": {
      "X-Request-Source": "idmMw"
    }
  },
  "enabled": true
}
```

## Приложение B: Быстрая команда проверки связи

```bash
# Замените <id> на UUID из ответа POST /admin/target-systems
curl -s -X POST http://localhost:3010/admin/target-systems/<id>/test | jq .
```
