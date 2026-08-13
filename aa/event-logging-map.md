# Event Logging Map

Structured logs are emitted through pino to stdout/stderr. `LOG_SINK=file` adds
a second JSON file sink. Diagnostic logging has `Basic` and temporary redacted
`Verbose` levels.

| Flow ID | Event class | Producer | When recorded | Required fields | Redaction / constraints |
| --- | --- | --- | --- | --- | --- |
| IF-001 | `idm.webhook.received` | `WebhookController` / diagnostics | inbound webhook accepted for processing | `eventId`, `operation`, `targetSystem`, mode | no raw secrets; verbose payload only with redaction |
| IF-001, IF-008 | audit event | `AuditInterceptor` / core services | inbound and outbound processing | event id, operation, target system, status, error summary | persisted audit JSON can contain business payload; enable encryption in production |
| IF-004, IF-005 | Kafka producer/consumer status | Kafka services | connect, consume, publish, failure | topic, partition when available, status/error summary | do not log message payload secrets |
| IF-006 | connector operation result | connector/core services | connector success/failure/retry | connector, operation, target system, status | redact endpoint credentials, tokens, passwords, TLS material |
| IF-003 | admin auth/session event | auth/admin services | login, SSO login, logout, unauthorized request | user id/name where safe, result | no passwords or session cookie values |
| IF-003, IF-008 | TargetSystem CRUD | admin services | create/update/delete/test | target system id/name/type, result | never log `TargetSystem.config` secret values |
| IF-003, IF-008 | DLQ action | admin/DLQ services | retry, skip, retry-many, lease conflict | DLQ id, target system, status | do not log replay payload by default |
| IF-009 | `startup.complete` | `main.ts` | process startup complete | URLs, TLS/debug/logging state | no secrets |
| IF-009 | shutdown signal | `main.ts` | SIGINT/SIGTERM | signal, service URLs | no secrets |
| IF-010 | metrics scrape | HTTP metrics middleware | request completion | method, normalized route, status, duration | no query values or bodies |
| IF-011 | secret provider operation | secret resolver | secret resolution success/failure | provider, reference id/path where safe, status | never log resolved secret value or token |

Operational requirements:

- `DebugLogging__Enabled=false` by default in production.
- `DebugLogging__Level=Verbose` is incident-only and must preserve redaction.
- Production delivery must prove an external log route: platform collector,
  sidecar, syslog, ELK/OpenSearch, Kafka log route or approved equivalent.
