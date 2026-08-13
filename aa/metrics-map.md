# Metrics Map

| Flow ID | Metric | Type | Labels | Purpose | Sensitive data |
| --- | --- | --- | --- | --- | --- |
| IF-010 | `idmmw_http_requests_total` | counter | `method`, `route`, `status` | HTTP request volume by normalized route/status | No payloads |
| IF-010 | `idmmw_http_request_duration_seconds` | histogram | `method`, `route` | HTTP latency | No payloads |
| IF-010 | `idmmw_connector_errors_total` | counter | `connector`, `operation` | Connector failure rate | Connector name and operation only |
| IF-010 | `idmmw_dlq_size` | gauge | `status` | Current DLQ backlog by status | No payloads |
| IF-010 | `idmmw_events_processed_total` | counter | `status`, `targetSystem` | Processed lifecycle event count | Target system name only |
| IF-010 | `idmmw_events_processed_last_5m` | gauge | `status`, `targetSystem` | Recent processing activity for Admin stats | Target system name only |

Operational notes:

- Metrics are exposed at `GET /metrics` on port `3010`.
- `METRICS_PUBLIC_ENABLED=false` in production profiles keeps metrics behind the
  integration-auth boundary unless the platform isolates the route.
- Metrics must not include IDM payload data, target-system credentials, tokens,
  cookies or raw connector responses.
