# Карта доступа Kafka

Статус: применимо при `KAFKA_ENABLED=true`.

| ID потока | Topic | Направление | Producer | Consumer | Порт | Назначение | Защита payload |
| --- | --- | --- | --- | --- | --- | --- | --- |
| IF-004 | `idm.events.in` | idmMw -> Kafka | `KafkaProducerService` через `DispatcherService` | `KafkaConsumerService` worker group | 9093 в prod examples | Вход для async write processing | Kafka TLS через `KAFKA_TLS_*`; payload encrypted при `ENCRYPTION_KAFKA_ENABLED` или global encryption |
| IF-004 | `idm.events.out` | idmMw -> Kafka | `KafkaProducerService` / worker | Внешние consumers или operations tooling | 9093 в prod examples | Сообщения о статусе обработки | То же |
| IF-005 | `idm.dlq.retry` | idmMw admin -> Kafka, Kafka -> worker | Admin retry path | `KafkaConsumerService` worker group | 9093 в prod examples | DLQ retry requests | То же |

## Runtime configuration

| Переменная | Значение |
| --- | --- |
| `KAFKA_ENABLED` | Включает producer/consumer integration |
| `KAFKA_BROKERS` | Broker list |
| `KAFKA_CLIENT_ID` | Base Kafka client id |
| `KAFKA_CONSUMER_GROUP_ID` | Worker group id |
| `KAFKA_TOPIC_EVENTS_IN` | Async input topic |
| `KAFKA_TOPIC_EVENTS_OUT` | Topic статусов |
| `KAFKA_TOPIC_DLQ_RETRY` | DLQ retry topic |
| `KAFKA_TLS_*` | TLS trust/client certificate settings |

## Правила доступа

- Production HA profiles устанавливают `KAFKA_ENABLED=true` и используют
  TLS-related settings.
- `IDMMW_PROCESSING_MODE=async` недопустим без `KAFKA_ENABLED=true`.
- Read/catalog operations не используют Kafka.
- Kafka payload schemas определены в [asyncapi.yaml](asyncapi.yaml).
