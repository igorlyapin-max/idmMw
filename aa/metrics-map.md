# Карта метрик

| ID потока | Метрика | Тип | Labels | Назначение | Чувствительные данные |
| --- | --- | --- | --- | --- | --- |
| IF-010 | `idmmw_http_requests_total` | counter | `method`, `route`, `status` | HTTP request volume по normalized route/status | Payloads отсутствуют |
| IF-010 | `idmmw_http_request_duration_seconds` | histogram | `method`, `route` | HTTP latency | Payloads отсутствуют |
| IF-010 | `idmmw_connector_errors_total` | counter | `connector`, `operation` | Connector failure rate | Только connector name и operation |
| IF-010 | `idmmw_dlq_size` | gauge | `status` | Текущий DLQ backlog по status | Payloads отсутствуют |
| IF-010 | `idmmw_events_processed_total` | counter | `status`, `targetSystem` | Количество обработанных lifecycle events | Только target system name |
| IF-010 | `idmmw_events_processed_last_5m` | gauge | `status`, `targetSystem` | Recent processing activity для Admin stats | Только target system name |

Операционные примечания:

- Метрики доступны через `GET /metrics` на порту `3010`.
- `METRICS_PUBLIC_ENABLED=false` в production profiles оставляет metrics за
  integration-auth boundary, если route не изолирован платформой.
- Метрики не должны включать IDM payload data, target-system credentials,
  tokens, cookies или raw connector responses.
