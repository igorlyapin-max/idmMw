import { Injectable, Logger } from '@nestjs/common';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { DispatcherService } from '../../outbound/dispatcher.service';
import {
  ProcessingService,
  isDurablyAcceptedError,
} from '../../core/processing.service';
import type { AvanpostWebhookDto } from './webhook.controller';

export interface ProcessResult {
  processed: boolean;
  data?: unknown;
}

/**
 * WebhookService — orchestrates inbound event processing.
 *
 * Two-layer safety net:
 *   1. Idempotency — deduplicates events by eventId (Redis or PostgreSQL advisory lock)
 *   2. Dispatcher — routes the event to the correct target system
 *
 * If the same eventId arrives twice, the second call returns processed=false
 * and the Dispatcher is never invoked.
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly dispatcher: DispatcherService,
    private readonly processing: ProcessingService,
  ) {}

  /**
   * Process a webhook from Avanpost IDM.
   *
   * @param dto     The webhook payload
   * @param isRead  True if the operation is a read operation that returns data
   * @returns       Object with processed flag and optional data
   */
  async processWebhook(
    dto: AvanpostWebhookDto,
    isRead = false,
  ): Promise<ProcessResult> {
    const idempotencyKey = `avanpost:${dto.targetSystem}:${dto.eventId}`;

    // Check if we already processed this eventId.
    // TTL = 3600 sec — duplicates within 1 hour are silently ignored.
    const isNew = await this.idempotency.checkAndLock(idempotencyKey, 3600);

    if (!isNew) {
      this.logger.warn(`Duplicate webhook ignored: ${dto.eventId}`);
      return { processed: false };
    }

    try {
      // Read operations bypass the dispatcher (no Kafka/DLQ/retry semantics)
      // and return data synchronously from the connector.
      if (isRead) {
        const result = await this.processing.processWithResult({
          eventId: dto.eventId,
          operation: dto.operation,
          targetSystem: dto.targetSystem,
          payload: dto.payload,
        });
        return {
          processed: result.success,
          ...(result.data !== undefined ? { data: result.data } : {}),
        };
      }

      // Write operations go through the dispatcher for retry + DLQ + Kafka.
      const result = await this.dispatcher.dispatch(dto);
      const data = this.safeWriteResponseData(result?.data);
      return {
        processed: true,
        ...(data !== undefined ? { data } : {}),
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to process webhook ${dto.eventId}: ${msg}`);
      if (!isDurablyAcceptedError(error)) {
        await this.idempotency.release(idempotencyKey);
      }
      throw error;
    }
  }

  private safeWriteResponseData(data: unknown): unknown | undefined {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return undefined;
    }
    const metadata = data as Record<string, unknown>;
    if (
      metadata['passwordDelivery'] === 'email' &&
      metadata['passwordKnown'] === false
    ) {
      return metadata;
    }
    return undefined;
  }
}
