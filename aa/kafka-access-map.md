# Kafka Access Map

Status: applicable when `KAFKA_ENABLED=true`.

| Flow ID | Topic | Direction | Producer | Consumer | Port | Purpose | Payload protection |
| --- | --- | --- | --- | --- | --- | --- | --- |
| IF-004 | `idm.events.in` | idmMw to Kafka | `KafkaProducerService` via `DispatcherService` | `KafkaConsumerService` worker group | 9093 in prod examples | Async write processing input | Kafka TLS via `KAFKA_TLS_*`; payload encrypted when `ENCRYPTION_KAFKA_ENABLED` or global encryption is enabled |
| IF-004 | `idm.events.out` | idmMw to Kafka | `KafkaProducerService` / worker | External consumers or operations tooling | 9093 in prod examples | Processing status messages | Same as above |
| IF-005 | `idm.dlq.retry` | idmMw admin to Kafka, Kafka to worker | Admin retry path | `KafkaConsumerService` worker group | 9093 in prod examples | DLQ retry requests | Same as above |

## Runtime Configuration

| Variable | Meaning |
| --- | --- |
| `KAFKA_ENABLED` | Enables producer/consumer integration |
| `KAFKA_BROKERS` | Broker list |
| `KAFKA_CLIENT_ID` | Base Kafka client id |
| `KAFKA_CONSUMER_GROUP_ID` | Worker group id |
| `KAFKA_TOPIC_EVENTS_IN` | Async input topic |
| `KAFKA_TOPIC_EVENTS_OUT` | Status topic |
| `KAFKA_TOPIC_DLQ_RETRY` | DLQ retry topic |
| `KAFKA_TLS_*` | TLS trust/client certificate settings |

## Access Rules

- Production HA profiles set `KAFKA_ENABLED=true` and use TLS-related settings.
- `IDMMW_PROCESSING_MODE=async` is invalid unless `KAFKA_ENABLED=true`.
- Read/catalog operations do not use Kafka.
- Kafka payload schemas are defined in [asyncapi.yaml](asyncapi.yaml).
