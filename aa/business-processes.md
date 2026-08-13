# Business Processes

## BP-001 Managed Account Provisioning

```mermaid
sequenceDiagram
  participant Operator as IDM operator
  participant IDM as Avanpost IDM 7.8
  participant MW as idmMw HTTP API :3010
  participant DB as idmMw DB :5432/5433/26257
  participant Target as Target system API
  participant Logs as Structured logs

  Operator->>IDM: Approve account lifecycle action
  IDM->>MW: IF-001 POST /webhooks/avanpost :3010
  MW->>Logs: IF-012 idm.webhook.received
  MW->>DB: IF-008 idempotency/audit/DLQ
  MW->>Target: IF-006 connector operation
  alt connector success
    MW-->>IDM: received=true, processed=true
    MW->>Logs: IF-012 success event
  else duplicate event
    MW-->>IDM: received=true, processed=false
    MW->>Logs: IF-012 duplicate diagnostic
  else connector failure
    MW->>DB: IF-008 store DLQ item
    MW-->>IDM: 4xx/5xx
    MW->>Logs: IF-012 failure diagnostic
  end
```

Positive scenario: IDM sends a unique event with `eventId`, `operation`,
`targetSystem` and `payload`; idmMw routes it to the configured connector and
returns a safe result.

Negative scenario: invalid payload, unknown target system, duplicate event or
connector failure returns an error or `processed=false`; DLQ and structured logs
record the failure without secret values.

Reusable subprocesses: idempotency check, connector registry lookup, retry/DLQ
handling, audit log write and diagnostic logging.

## BP-002 IDM Catalog and Read Facade

```mermaid
sequenceDiagram
  participant IDM as Avanpost IDM 7.8
  participant MW as idmMw /idm API :3010
  participant DB as TargetSystem DB
  participant Target as Target system API

  IDM->>MW: IF-002 GET /idm/target-systems :3010
  MW->>DB: IF-008 enabled TargetSystem rows
  MW-->>IDM: catalog without config/secrets
  IDM->>MW: IF-002 GET /idm/{targetSystem}/users :3010
  MW->>Target: IF-006 read operation
  MW-->>IDM: connector result data
```

Negative scenario: disabled or unknown target systems return `404`; invalid
query parameters return `400`; connector failure returns `400` without leaking
stored connector configuration.

Logging points: catalog lookup, connector read execution, connector failure.

## BP-003 Admin Target System Operations

```mermaid
sequenceDiagram
  participant Browser as Admin browser
  participant MW as idmMw Admin UI/API :3010
  participant DB as idmMw DB
  participant Target as Target system API

  Browser->>MW: IF-003 /auth/login or /auth/sso-login
  Browser->>MW: IF-003 POST /admin/target-systems
  MW->>DB: IF-008 create/update TargetSystem
  MW->>MW: reload connector registry
  Browser->>MW: IF-003 POST /admin/target-systems/{id}/test
  MW->>Target: IF-006 system.test
  MW-->>Browser: saved entity / test result
```

Negative scenario: unauthenticated admin request is rejected when
`ADMIN_AUTH_ENABLED=true`; duplicate target system name returns conflict; test
failure returns safe diagnostic text.

Logging points: admin auth result, TargetSystem CRUD, registry reload,
connection test.

## BP-004 DLQ Review and Retry

```mermaid
sequenceDiagram
  participant Browser as Admin browser
  participant MW as idmMw Admin API :3010
  participant DB as DLQ table
  participant Kafka as Kafka :9093
  participant Worker as idmMw worker

  Browser->>MW: IF-003 GET /admin/dlq
  MW->>DB: IF-008 read DLQ items
  Browser->>MW: IF-003 POST /admin/dlq/{id}/retry
  MW->>DB: IF-008 acquire retry lease
  alt Kafka enabled
    MW->>Kafka: IF-005 idm.dlq.retry
    Worker->>Kafka: IF-005 consume retry
  else sync fallback
    MW->>MW: process retry locally
  end
```

Negative scenario: an already leased, skipped or resolved DLQ item cannot be
retried again until the lease state permits it.

## BP-005 Monitoring and Support

```mermaid
flowchart LR
  Ops[Platform/SRE]
  MW[idmMw :3010]
  Prom[Prometheus]
  Logs[Collector / sidecar / platform logs]

  Ops -->|IF-009 GET /health /ready /about :3010| MW
  Prom -->|IF-010 scrape /metrics :3010| MW
  MW -->|IF-012 stdout/stderr and optional file sink| Logs
```

Support processes include startup verification, readiness checks, metric
scraping, debug logging at `Basic` or temporary `Verbose`, key rotation and
container image provenance checks.
