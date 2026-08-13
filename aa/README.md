# idmMw Architecture Artifacts

This directory is the GKM AA artifact set for idmMw. It complements
`docs/architecture/` with governance-facing contracts: business processes,
information flows, deployment contours, OpenAPI, AsyncAPI, healthchecks,
metrics, secrets, Kafka access and event logging.

## Boundary

idmMw is a NestJS middleware between Avanpost IDM 7.8 and managed target
systems. It owns:

- inbound IDM HTTP contracts on port `3010`;
- Admin UI and Admin API on the same port `3010`;
- connector routing, retry, DLQ, audit, metrics, diagnostic logging and
  optional Kafka worker flows;
- container deployment profiles under `deploy/`.

External systems such as Avanpost IDM, target systems, Kafka, Redis, DB,
Prometheus, PAM/AAPM and platform log collectors are integration participants,
not code owned by this repository.

## Artifact Index

| Artifact | File |
| --- | --- |
| Business processes | [business-processes.md](business-processes.md) |
| Information model | [information-model.md](information-model.md) |
| Deployment contours | [deployment.md](deployment.md) |
| OpenAPI | [openapi.yaml](openapi.yaml) |
| AsyncAPI | [asyncapi.yaml](asyncapi.yaml) |
| Kafka access map | [kafka-access-map.md](kafka-access-map.md) |
| Healthcheck map | [healthcheck-map.md](healthcheck-map.md) |
| Metrics map | [metrics-map.md](metrics-map.md) |
| Secrets map | [secrets-map.md](secrets-map.md) |
| Event logging map | [event-logging-map.md](event-logging-map.md) |

## Omitted or Out of Scope

| Surface | Status | Reason |
| --- | --- | --- |
| Target-system upstream APIs | out of scope | idmMw calls them through connectors but does not own their HTTP/DB contracts. |
| `mock-idm` endpoints | dev/test only | They support local scenario generation and are not a production IDM contract. |
| VSDX exports | not generated | Markdown, Mermaid and YAML sources are authoritative in git; image/VSDX export is a separate delivery step if requested. |

## Naming

Information flows use stable IDs `IF-001`, `IF-002`, and so on. The same IDs
are referenced from OpenAPI, AsyncAPI, healthcheck, metrics, secrets, Kafka and
event logging artifacts.

Network connections list protocol and port. Where a port is deployment-owned
or external, the artifact records the configured value or the repository
placeholder.

## Sensitive Data Rule

Artifacts do not contain live cookies, passwords, bearer tokens, private keys,
customer certificates, certificate fingerprints, real customer hostnames or raw
production payloads. Use env variable names and placeholders only.

## Source Notes

Source files inspected for this artifact set:

- `README.md`
- `docs/architecture/*`
- `docs/CONTAINER_DEPLOYMENT_ADMIN_GUIDE.md`
- `docs/DEPLOYMENT_PROFILES.md`
- `deploy/docker-compose.*.yml`
- `deploy/profiles/*.env.example`
- `src/main.ts`
- `src/health/health.controller.ts`
- `src/metrics/metrics.service.ts`
- `src/inbound/webhooks/webhook.controller.ts`
- `src/inbound/idm/idm.controller.ts`
- `src/admin/*.ts`
- `src/auth/auth.controller.ts`
- `src/kafka/*.ts`
- `src/config/app.config.ts`
