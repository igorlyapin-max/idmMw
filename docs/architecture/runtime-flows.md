# Runtime flows

## Sync write webhook

```mermaid
sequenceDiagram
  participant IDM as Avanpost IDM
  participant Webhook as WebhookController
  participant Idem as IdempotencyService
  participant Dispatcher as DispatcherService
  participant Processing as ProcessingService
  participant Registry as ConnectorRegistry
  participant Connector as Target connector
  participant DLQ as DlqService
  participant Audit as AuditLog

  IDM->>Webhook: POST /webhooks/avanpost
  Webhook->>Audit: audit inbound request
  Webhook->>Idem: checkAndLock("avanpost:" + eventId)
  alt duplicate
    Idem-->>Webhook: false
    Webhook-->>IDM: {received:true, processed:false}
  else new event
    Idem-->>Webhook: true
    Webhook->>Dispatcher: dispatch(dto)
    Dispatcher->>Processing: process(dto)
    Processing->>Registry: get(targetSystem)
    Registry-->>Processing: static connector or dynamic proxy
    Processing->>Connector: execute(operation, payload)
    alt success
      Connector-->>Processing: {success:true, data?}
      Processing-->>Dispatcher: ConnectorResult
      Dispatcher-->>Webhook: ConnectorResult
      Webhook-->>IDM: {received:true, processed:true, data?}
    else retry exhausted / connector failure
      Processing->>DLQ: add(DlqItem)
      Processing-->>Dispatcher: error
      Dispatcher-->>Webhook: error
      Webhook-->>IDM: 4xx/5xx
    end
  end
```

For generic write operations `data` is omitted. A connector may expose only safe
operational metadata; currently ConsultantPlus password reset/create can return
`passwordKnown=false`, `passwordDelivery=email`, `managedLogin`, and `email`
without a password value.

## Async write webhook

`IDMMW_PROCESSING_MODE=async` requires `KAFKA_ENABLED=true`.

```mermaid
sequenceDiagram
  participant IDM as Avanpost IDM
  participant Webhook as WebhookController
  participant Idem as IdempotencyService
  participant Dispatcher as DispatcherService
  participant KafkaIn as KAFKA_TOPIC_EVENTS_IN
  participant Worker as KafkaConsumerService
  participant Processing as ProcessingService
  participant KafkaOut as KAFKA_TOPIC_EVENTS_OUT

  IDM->>Webhook: POST /webhooks/avanpost
  Webhook->>Idem: checkAndLock(eventId)
  Webhook->>Dispatcher: dispatch(dto)
  Dispatcher->>KafkaIn: send event payload
  Dispatcher-->>Webhook: queued
  Webhook-->>IDM: {received:true, processed:true}

  Worker->>KafkaIn: consume event
  Worker->>Processing: process(payload)
  alt success
    Worker->>KafkaOut: status=success
  else failure
    Worker->>KafkaOut: status=failed
  end
```

## Read/catalog facade for IDM

Read operations are synchronous and do not use Kafka, retry or DLQ. They are
used by IDM for catalog, schema, user/group search and connection tests.

```mermaid
sequenceDiagram
  participant IDM as Avanpost IDM
  participant Facade as IdmController
  participant TS as TargetSystemService
  participant Registry as ConnectorRegistry
  participant Connector as Target connector

  IDM->>Facade: GET /idm/target-systems
  Facade->>TS: find enabled TargetSystem rows
  Facade->>Registry: get(name), getCapabilities()
  Facade-->>IDM: catalog without config/secrets

  IDM->>Facade: GET /idm/:targetSystem/users?filter=x
  Facade->>TS: findByName(targetSystem)
  Facade->>Registry: get(targetSystem)
  Facade->>Connector: execute user.search with payload.params
  Connector-->>Facade: ConnectorResult.data
  Facade-->>IDM: read result data
```

## Admin TargetSystem CRUD and registry reload

```mermaid
sequenceDiagram
  participant UI as Admin UI / Admin API client
  participant Auth as AdminAuthMiddleware
  participant Admin as TargetSystemController
  participant DB as Prisma TargetSystem
  participant Registry as ConnectorRegistry

  UI->>Auth: POST/PATCH/DELETE /admin/target-systems
  Auth->>Admin: authorized request
  Admin->>DB: create/update/delete TargetSystem
  Admin->>Registry: reload()
  Registry->>DB: findMany({enabled:true})
  Registry-->>Admin: static connectors + dynamic proxies refreshed
  Admin-->>UI: saved entity/test result
```

## DLQ retry

```mermaid
sequenceDiagram
  participant Operator as Operator
  participant Admin as Admin API
  participant DLQ as DlqService
  participant Kafka as KAFKA_TOPIC_DLQ_RETRY
  participant Worker as KafkaConsumerService
  participant Processing as ProcessingService

  Operator->>Admin: retry DLQ item
  Admin->>DLQ: retry(id)
  DLQ-->>Admin: lease acquired
  Admin->>Kafka: publish retry message with dlqItemId
  Worker->>Kafka: consume retry
  Worker->>Processing: process(payload)
  alt success
    Worker->>DLQ: resolve(dlqItemId)
  else failure
    Worker-->>Admin: status remains retrying until lease expiry / next action
  end
```

## Diagnostic logging flow

```mermaid
flowchart LR
  Runtime[Runtime event]
  Diagnostics[DiagnosticLoggerService]
  Pino[pino structured logging]
  Stdout[stdout/stderr]
  File[optional LOG_SINK=file]
  Collector[collector/sidecar/ELK/syslog/Kafka log route]

  Runtime --> Diagnostics
  Diagnostics -->|Basic/Verbose redacted| Pino
  Pino --> Stdout
  Pino -. optional .-> File
  Stdout --> Collector
  File --> Collector
```
