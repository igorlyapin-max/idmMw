# Healthcheck Map

| Flow ID | Endpoint / probe | Caller | Port | Status semantics | Dependencies checked | Exposed data |
| --- | --- | --- | --- | --- | --- | --- |
| IF-009 | `GET /health` | Container healthcheck, SRE, smoke scripts | 3010 | `200` with `status=ok` means process liveness | Process is serving HTTP; no dependency probe | Build identity: app name, version, git revision, source clean flag, provenance, runtime artifact digest |
| IF-009 | `GET /about` | Release validation, SRE | 3010 | `200` means process can expose release identity | None beyond process | Same safe build identity as `/health` |
| IF-009 | `GET /ready` | Internal readiness checker | 3010 | Terminus readiness response; dependency failure should fail readiness | DB ping, Redis idempotency health, Kafka config/status summary | DB/Redis/Kafka status and configured Kafka topic names, no credentials |
| IF-010 | `GET /metrics` | Prometheus / SRE | 3010 | Prometheus exposition succeeds | Metrics registry | Counters/gauges/histograms only; no business payloads |

Notes:

- `/metrics` is protected by integration auth when `METRICS_PUBLIC_ENABLED=false`.
- Production should expose `/ready` and `/metrics` only through internal network,
  gateway policy or equivalent platform control.
- `/health` and `/about` are used by verified image handoff to compare runtime
  identity with image labels.
