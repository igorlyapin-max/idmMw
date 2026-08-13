# Бизнес-процессы

## BP-001 Provisioning управляемой учетной записи

```mermaid
sequenceDiagram
  participant Operator as Оператор IDM
  participant IDM as Avanpost IDM 7.8
  participant MW as idmMw HTTP API :3010
  participant DB as idmMw DB :5432/5433/26257
  participant Target as API целевой системы
  participant Logs as Структурированные логи

  Operator->>IDM: Согласует lifecycle action учетной записи
  IDM->>MW: IF-001 POST /webhooks/avanpost :3010
  MW->>Logs: IF-012 idm.webhook.received
  MW->>DB: IF-008 idempotency/audit/DLQ
  MW->>Target: IF-006 операция connector
  alt connector успешно выполнил операцию
    MW-->>IDM: received=true, processed=true
    MW->>Logs: IF-012 событие успеха
  else дублирующее событие
    MW-->>IDM: received=true, processed=false
    MW->>Logs: IF-012 диагностика дубля
  else ошибка connector
    MW->>DB: IF-008 store DLQ item
    MW-->>IDM: 4xx/5xx
    MW->>Logs: IF-012 диагностика отказа
  end
```

Позитивный сценарий: IDM отправляет уникальное событие с `eventId`,
`operation`, `targetSystem` и `payload`; idmMw маршрутизирует его в
настроенный connector и возвращает безопасный результат.

Негативный сценарий: некорректный payload, неизвестная target system,
дублирующее событие или отказ connector возвращают ошибку либо
`processed=false`; DLQ и structured logs фиксируют отказ без secret values.

Переиспользуемые подпроцессы: проверка idempotency, поиск в connector registry,
обработка retry/DLQ, запись audit log и diagnostic logging.

## BP-002 IDM catalog и read facade

```mermaid
sequenceDiagram
  participant IDM as Avanpost IDM 7.8
  participant MW as idmMw /idm API :3010
  participant DB as TargetSystem DB
  participant Target as API целевой системы

  IDM->>MW: IF-002 GET /idm/target-systems :3010
  MW->>DB: IF-008 enabled TargetSystem rows
  MW-->>IDM: каталог без config/secrets
  IDM->>MW: IF-002 GET /idm/{targetSystem}/users :3010
  MW->>Target: IF-006 операция чтения
  MW-->>IDM: данные результата connector
```

Негативный сценарий: disabled или неизвестные target systems возвращают `404`;
некорректные query parameters возвращают `400`; отказ connector возвращает
`400` без раскрытия сохраненной connector configuration.

Точки логирования: поиск в catalog, выполнение чтения connector, отказ
connector.

## BP-003 Admin операции с TargetSystem

```mermaid
sequenceDiagram
  participant Browser as Браузер администратора
  participant MW as idmMw Admin UI/API :3010
  participant DB as idmMw DB
  participant Target as API целевой системы

  Browser->>MW: IF-003 /auth/login или /auth/sso-login
  Browser->>MW: IF-003 POST /admin/target-systems
  MW->>DB: IF-008 create/update TargetSystem
  MW->>MW: перезагрузка connector registry
  Browser->>MW: IF-003 POST /admin/target-systems/{id}/test
  MW->>Target: IF-006 system.test
  MW-->>Browser: сохраненная сущность / результат проверки
```

Негативный сценарий: неаутентифицированный admin request отклоняется при
`ADMIN_AUTH_ENABLED=true`; дублирующее target system name возвращает conflict;
ошибка test возвращает безопасный diagnostic text.

Точки логирования: результат admin auth, TargetSystem CRUD, перезагрузка
registry, проверка соединения.

## BP-004 DLQ review и retry

```mermaid
sequenceDiagram
  participant Browser as Браузер администратора
  participant MW as idmMw Admin API :3010
  participant DB as Таблица DLQ
  participant Kafka as Kafka :9093
  participant Worker as idmMw worker

  Browser->>MW: IF-003 GET /admin/dlq
  MW->>DB: IF-008 read DLQ items
  Browser->>MW: IF-003 POST /admin/dlq/{id}/retry
  MW->>DB: IF-008 acquire retry lease
  alt Kafka enabled
    MW->>Kafka: IF-005 idm.dlq.retry
    Worker->>Kafka: IF-005 потребление retry
  else синхронная обработка
    MW->>MW: локальная обработка retry
  end
```

Негативный сценарий: DLQ item в состояниях already leased, skipped или resolved
нельзя повторно отправить в retry, пока состояние lease этого не позволяет.

## BP-005 Monitoring и support

```mermaid
flowchart LR
  Ops[Платформа/SRE]
  MW[idmMw :3010]
  Prom[Prometheus]
  Logs[Collector / sidecar / platform logs]

  Ops -->|IF-009 GET /health /ready /about :3010| MW
  Prom -->|IF-010 scrape /metrics :3010| MW
  MW -->|IF-012 stdout/stderr и опциональный file sink| Logs
```

Support-процессы включают проверку startup, readiness checks, сбор метрик,
debug logging на уровне `Basic` или временном redacted `Verbose`, key rotation
и проверки provenance container image.
