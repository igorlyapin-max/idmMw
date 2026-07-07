import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProcessingService } from '../core/processing.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { AvanpostWebhookDto } from '../inbound/webhooks/webhook.controller';
import type { ConnectorResult } from '../connectors/connector.interface';

/**
 * DispatcherService — the bridge between inbound webhooks and the processing layer.
 *
 * Responsibilities:
 *   1. In sync mode, call ProcessingService to execute the event immediately.
 *   2. In async mode, enqueue write events to Kafka for worker consumers.
 *   3. Optionally emit status messages to the Kafka out topic.
 */
@Injectable()
export class DispatcherService {
  private readonly logger = new Logger(DispatcherService.name);

  constructor(
    private readonly processing: ProcessingService,
    private readonly kafkaProducer: KafkaProducerService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Dispatch an event to the target system.
   *
   * Flow:
   *   dto.targetSystem ──► ConnectorRegistry.get(name)
   *                            │
   *                            ▼
   *                       ProcessingService.process()
   *                            │
   *                            ├── success ──► metrics ++
   *                            └── failure ──► DLQ + metrics ++
   *
   * After processing (success or failure) an optional Kafka message
   * is sent to topic `idm.events.out` for downstream consumers.
   */
  async dispatch(
    dto: AvanpostWebhookDto,
  ): Promise<ConnectorResult | undefined> {
    const kafkaEnabled = this.config.get<boolean>('KAFKA_ENABLED') ?? false;
    const processingMode =
      this.config.get<string>('IDMMW_PROCESSING_MODE') ?? 'sync';
    const eventsInTopic =
      this.config.get<string>('KAFKA_TOPIC_EVENTS_IN') ?? 'idm.events.in';
    const eventsOutTopic =
      this.config.get<string>('KAFKA_TOPIC_EVENTS_OUT') ?? 'idm.events.out';

    if (processingMode === 'async') {
      if (!kafkaEnabled) {
        throw new Error('Async processing mode requires KAFKA_ENABLED=true');
      }
      await this.kafkaProducer.send(eventsInTopic, {
        eventId: dto.eventId,
        operation: dto.operation,
        targetSystem: dto.targetSystem,
        payload: dto.payload,
      });
      this.logger.log(
        `Dispatch queued event ${dto.eventId} to Kafka topic ${eventsInTopic}`,
      );
      return;
    }

    try {
      // Core execution: route to the concrete connector via registry lookup.
      const result = await this.processing.process({
        eventId: dto.eventId,
        operation: dto.operation,
        targetSystem: dto.targetSystem,
        payload: dto.payload,
      });
      this.logger.log(`Dispatch succeeded for event ${dto.eventId}`);

      // Optional: emit async success event for external consumers.
      if (kafkaEnabled) {
        await this.kafkaProducer.send(eventsOutTopic, {
          eventId: dto.eventId,
          operation: dto.operation,
          targetSystem: dto.targetSystem,
          status: 'success',
        });
      }
      return result;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Dispatch failed for event ${dto.eventId}: ${msg}`);

      // Optional: emit async failure event for external consumers / alerting.
      if (kafkaEnabled) {
        await this.kafkaProducer.send(eventsOutTopic, {
          eventId: dto.eventId,
          operation: dto.operation,
          targetSystem: dto.targetSystem,
          status: 'failed',
          error: msg,
        });
      }
      throw error;
    }
  }
}
