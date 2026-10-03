import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { JsonHelper } from '../database/json.helper';
import { DlqService } from '../core/dlq/dlq.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { MetricsService } from '../metrics/metrics.service';
import { ProcessingService } from '../core/processing.service';

interface RetryManyParams {
  targetSystem?: string;
  status?: string;
  limit?: number;
  allowedTargetSystems?: string[];
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jsonHelper: JsonHelper,
    private readonly dlq: DlqService,
    private readonly kafkaProducer: KafkaProducerService,
    private readonly metrics: MetricsService,
    private readonly processing: ProcessingService,
    private readonly config: ConfigService,
  ) {}

  async findDlqItems(params: {
    status?: string;
    targetSystem?: string;
    limit?: number;
    offset?: number;
    allowedTargetSystems?: string[];
  }) {
    if (params.allowedTargetSystems && params.allowedTargetSystems.length === 0) {
      return [];
    }
    const items = await this.prisma.dlqItem.findMany({
      where: {
        ...(params.status ? { status: params.status } : {}),
        ...(params.targetSystem
          ? { targetSystem: params.targetSystem }
          : params.allowedTargetSystems
            ? { targetSystem: { in: params.allowedTargetSystems } }
            : {}),
      },
      take: this.limit(params.limit, 50, 200),
      skip: this.offset(params.offset),
      orderBy: { createdAt: 'desc' },
    });
    return items.map((item) => ({
      ...item,
      payload: this.jsonHelper.fromJson(item.payload),
    }));
  }

  async updateDlqMetrics(): Promise<void> {
    await this.dlq.updateMetrics();
  }

  async findDlqItemTargetSystem(id: string): Promise<string | null> {
    const item = await this.prisma.dlqItem.findUnique({
      where: { id },
      select: { targetSystem: true },
    });
    return item?.targetSystem ?? null;
  }

  async stats(params: { allowedTargetSystems?: string[] } = {}): Promise<{
    dlq: Record<string, number>;
    processedLast5Minutes: ReturnType<MetricsService['processedLast5Minutes']>;
    infrastructure: {
      kafkaEnabled: boolean;
      redisEnabled: boolean;
      processingMode: string;
    };
  }> {
    if (params.allowedTargetSystems && params.allowedTargetSystems.length === 0) {
      return {
        dlq: { pending: 0, retrying: 0, skipped: 0, resolved: 0 },
        processedLast5Minutes: { total: 0, byStatus: {}, byTargetSystem: {} },
        infrastructure: {
          kafkaEnabled: this.config.get<boolean>('KAFKA_ENABLED') ?? false,
          redisEnabled: this.config.get<boolean>('REDIS_ENABLED') ?? false,
          processingMode:
            this.config.get<string>('IDMMW_PROCESSING_MODE') ?? 'sync',
        },
      };
    }
    const counts = await this.prisma.dlqItem.groupBy({
      by: ['status'],
      _count: { status: true },
      where: params.allowedTargetSystems
        ? { targetSystem: { in: params.allowedTargetSystems } }
        : undefined,
    });
    const dlq = Object.fromEntries(
      ['pending', 'retrying', 'skipped', 'resolved'].map((status) => [
        status,
        counts.find((row) => row.status === status)?._count.status ?? 0,
      ]),
    );
    const processed = this.filteredProcessedLast5Minutes(
      params.allowedTargetSystems,
    );
    return {
      dlq,
      processedLast5Minutes: processed,
      infrastructure: {
        kafkaEnabled: this.config.get<boolean>('KAFKA_ENABLED') ?? false,
        redisEnabled: this.config.get<boolean>('REDIS_ENABLED') ?? false,
        processingMode:
          this.config.get<string>('IDMMW_PROCESSING_MODE') ?? 'sync',
      },
    };
  }

  async retry(id: string): Promise<void> {
    const claimed = await this.dlq.retry(id);
    if (!claimed) {
      throw new Error(
        `DLQ item ${id} is already retrying, skipped, or resolved`,
      );
    }
    const item = await this.prisma.dlqItem.findUnique({ where: { id } });
    if (item) {
      await this.retryItem(item);
    }
    await this.updateDlqMetrics();
  }

  async retryMany(params: RetryManyParams): Promise<{
    requested: number;
    queued: number;
    skipped: number;
    errors: Array<{ id: string; error: string }>;
  }> {
    if (params.allowedTargetSystems && params.allowedTargetSystems.length === 0) {
      return { requested: 0, queued: 0, skipped: 0, errors: [] };
    }
    const items = await this.prisma.dlqItem.findMany({
      where: {
        status: params.status ?? 'pending',
        ...(params.targetSystem
          ? { targetSystem: params.targetSystem }
          : params.allowedTargetSystems
            ? { targetSystem: { in: params.allowedTargetSystems } }
            : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: this.limit(params.limit, 25, 100),
    });
    let queued = 0;
    let skipped = 0;
    const errors: Array<{ id: string; error: string }> = [];

    for (const item of items) {
      try {
        const claimed = await this.dlq.retry(item.id);
        if (!claimed) {
          skipped += 1;
          continue;
        }
        await this.retryItem(item);
        queued += 1;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        errors.push({ id: item.id, error: msg });
      }
    }

    await this.updateDlqMetrics();
    return {
      requested: items.length,
      queued,
      skipped,
      errors,
    };
  }

  async skip(id: string): Promise<void> {
    await this.dlq.skip(id);
    await this.updateDlqMetrics();
  }

  private async retryItem(item: {
    id: string;
    eventId: string;
    operation: string;
    targetSystem: string;
    payload: unknown;
  }): Promise<void> {
    const payload =
      this.jsonHelper.fromJson<Record<string, unknown>>(item.payload) ?? {};
    if (this.config.get<boolean>('KAFKA_ENABLED') ?? false) {
      await this.kafkaProducer.send(
        this.config.get<string>('KAFKA_TOPIC_DLQ_RETRY') ?? 'idm.dlq.retry',
        {
          dlqItemId: item.id,
          eventId: item.eventId,
          operation: item.operation,
          targetSystem: item.targetSystem,
          payload,
        },
      );
      return;
    }

    await this.processing.processRetry(
      {
        eventId: item.eventId,
        operation: item.operation,
        targetSystem: item.targetSystem,
        payload,
      },
      item.id,
    );
  }

  private limit(
    value: number | undefined,
    defaultValue: number,
    maxValue: number,
  ): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return defaultValue;
    }
    return Math.min(parsed, maxValue);
  }

  private offset(value: number | undefined): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  }

  private filteredProcessedLast5Minutes(allowedTargetSystems?: string[]) {
    const snapshot = this.metrics.processedLast5Minutes();
    if (!allowedTargetSystems) return snapshot;
    const allowed = new Set(allowedTargetSystems);
    const byTargetSystem = Object.fromEntries(
      Object.entries(snapshot.byTargetSystem).filter(([targetSystem]) =>
        allowed.has(targetSystem),
      ),
    );
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const statuses of Object.values(byTargetSystem)) {
      for (const [status, count] of Object.entries(statuses)) {
        byStatus[status] = (byStatus[status] ?? 0) + count;
        total += count;
      }
    }
    return { total, byStatus, byTargetSystem };
  }
}
