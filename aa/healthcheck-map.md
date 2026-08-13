# Карта healthcheck

| ID потока | Endpoint / probe | Вызывающий компонент | Порт | Семантика статуса | Проверяемые зависимости | Раскрываемые данные |
| --- | --- | --- | --- | --- | --- | --- |
| IF-009 | `GET /health` | Container healthcheck, SRE, smoke scripts | 3010 | `200` с `status=ok` означает process liveness | Только то, что process обслуживает HTTP; dependency probe не выполняется | Build identity: app name, version, git revision, source clean flag, provenance, runtime artifact digest |
| IF-009 | `GET /about` | Release validation, SRE | 3010 | `200` означает, что process может раскрыть release identity | Нет, кроме самого process | Та же safe build identity, что и `/health` |
| IF-009 | `GET /ready` | Internal readiness checker | 3010 | Terminus readiness response; dependency failure должен проваливать readiness | DB ping, Redis idempotency health, Kafka config/status summary | DB/Redis/Kafka status и configured Kafka topic names, без credentials |
| IF-010 | `GET /metrics` | Prometheus / SRE | 3010 | Prometheus exposition успешно возвращается | Metrics registry | Только counters/gauges/histograms; без business payloads |

Примечания:

- `/metrics` защищается integration auth при `METRICS_PUBLIC_ENABLED=false`.
- В production `/ready` и `/metrics` должны быть доступны только через internal
  network, gateway policy или эквивалентный platform control.
- `/health` и `/about` используются verified image handoff для сравнения runtime
  identity с image labels.
