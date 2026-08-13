# Карта событий логирования

Structured logs отправляются через pino в stdout/stderr. `LOG_SINK=file`
добавляет второй JSON file sink. Diagnostic logging поддерживает `Basic` и
временный redacted `Verbose`.

| ID потока | Класс события | Источник | Когда фиксируется | Обязательные поля | Redaction / ограничения |
| --- | --- | --- | --- | --- | --- |
| IF-001 | `idm.webhook.received` | `WebhookController` / diagnostics | inbound webhook принят в обработку | `eventId`, `operation`, `targetSystem`, mode | без raw secrets; verbose payload только с redaction |
| IF-001, IF-008 | audit event | `AuditInterceptor` / core services | inbound и outbound processing | event id, operation, target system, status, error summary | persisted audit JSON может содержать business payload; в production включать encryption |
| IF-004, IF-005 | Kafka producer/consumer status | Kafka services | connect, consume, publish, failure | topic, partition при наличии, status/error summary | не логировать message payload secrets |
| IF-006 | connector operation result | connector/core services | success/failure/retry connector | connector, operation, target system, status | redact endpoint credentials, tokens, passwords, TLS material |
| IF-003 | admin auth/session event | auth/admin services | login, SSO login, logout, unauthorized request | user id/name если безопасно, result | без passwords или session cookie values |
| IF-003, IF-008 | TargetSystem CRUD | admin services | create/update/delete/test | target system id/name/type, result | никогда не логировать secret values из `TargetSystem.config` |
| IF-003, IF-008 | DLQ action | admin/DLQ services | retry, skip, retry-many, lease conflict | DLQ id, target system, status | replay payload по умолчанию не логировать |
| IF-009 | `startup.complete` | `main.ts` | process startup complete | URLs, TLS/debug/logging state | без secrets |
| IF-009 | shutdown signal | `main.ts` | SIGINT/SIGTERM | signal, service URLs | без secrets |
| IF-010 | metrics scrape | HTTP metrics middleware | request completion | method, normalized route, status, duration | без query values или bodies |
| IF-011 | secret provider operation | secret resolver | success/failure при secret resolution | provider, reference id/path если безопасно, status | никогда не логировать resolved secret value или token |

Операционные требования:

- `DebugLogging__Enabled=false` по умолчанию в production.
- `DebugLogging__Level=Verbose` используется только для incident diagnostics и
  должен сохранять redaction.
- Production delivery должен доказывать внешний log route: platform collector,
  sidecar, syslog, ELK/OpenSearch, Kafka log route или approved equivalent.
