# Архитектурные артефакты idmMw

Этот каталог содержит комплект GKM AA для idmMw. Он дополняет
`docs/architecture/` governance-ориентированными контрактами: бизнес-процессы,
информационные потоки, контуры развертывания, OpenAPI, AsyncAPI, healthcheck,
метрики, секреты, Kafka access и карту событий логирования.

## Граница системы

idmMw - NestJS middleware между Avanpost IDM 7.8 и управляемыми целевыми
системами. Репозиторий владеет:

- входящими IDM HTTP-контрактами на порту `3010`;
- Admin UI и Admin API на том же порту `3010`;
- маршрутизацией connector'ов, retry, DLQ, audit, metrics, diagnostic logging и
  опциональными Kafka worker flows;
- контейнерными профилями развертывания в `deploy/`.

Внешние системы Avanpost IDM, target systems, Kafka, Redis, DB, Prometheus,
PAM/AAPM и платформенные log collectors являются участниками интеграции, а не
кодом, которым владеет этот репозиторий.

## Индекс артефактов

| Артефакт | Файл |
| --- | --- |
| Бизнес-процессы | [business-processes.md](business-processes.md) |
| Информационная модель | [information-model.md](information-model.md) |
| Контуры развертывания | [deployment.md](deployment.md) |
| OpenAPI | [openapi.yaml](openapi.yaml) |
| AsyncAPI | [asyncapi.yaml](asyncapi.yaml) |
| Карта доступа Kafka | [kafka-access-map.md](kafka-access-map.md) |
| Карта healthcheck | [healthcheck-map.md](healthcheck-map.md) |
| Карта метрик | [metrics-map.md](metrics-map.md) |
| Карта секретов | [secrets-map.md](secrets-map.md) |
| Карта событий логирования | [event-logging-map.md](event-logging-map.md) |

## Исключено из области

| Поверхность | Статус | Причина |
| --- | --- | --- |
| Upstream API целевых систем | вне области | idmMw вызывает их через connector'ы, но не владеет их HTTP/DB контрактами. |
| Endpoints `mock-idm` | только dev/test | Они нужны для локальной генерации сценариев и не являются production IDM contract. |
| VSDX exports | не сгенерированы | Markdown, Mermaid и YAML sources являются авторитетными в git; image/VSDX export выполняется отдельным delivery step по запросу. |

## Именование

Информационные потоки используют стабильные ID `IF-001`, `IF-002` и далее. Те
же ID используются в OpenAPI, AsyncAPI, healthcheck, metrics, secrets, Kafka и
event logging артефактах.

Сетевые соединения указывают protocol и port. Если порт задается deployment
платформой или внешней системой, артефакт фиксирует настроенное значение или
placeholder из репозитория.

## Правило по чувствительным данным

Артефакты не содержат live cookies, passwords, bearer tokens, private keys,
customer certificates, certificate fingerprints, реальные customer hostnames
или raw production payloads. Используются только имена env variables и
placeholders.

## Источники

При подготовке артефактов были сверены:

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
