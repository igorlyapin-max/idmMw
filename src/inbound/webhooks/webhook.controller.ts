import {
  Controller,
  Post,
  Body,
  Logger,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  IsIn,
  IsString,
  IsObject,
  Matches,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { WebhookService } from './webhook.service';
import { AuditInterceptor } from '../../core/audit/audit.interceptor';
import {
  AVANPOST_OPERATION_VALUES,
  isReadOperation,
} from './avanpost-operation.enum';
import { DiagnosticLoggerService } from '../../diagnostics/diagnostic-logger.service';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@ValidatorConstraint({ name: 'avanpostPayloadShape', async: false })
class AvanpostPayloadShapeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (!isRecord(value)) {
      return false;
    }

    return ['data', 'params', 'metadata'].every((key) => {
      const section = value[key];
      return section === undefined || isRecord(section);
    });
  }

  defaultMessage(): string {
    return 'payload.data, payload.params and payload.metadata must be objects when provided';
  }
}

/**
 * Payload from Avanpost IDM (or any compatible IDM system).
 *
 * Flow:
 *   Avanpost IDM ──POST /webhooks/avanpost──► WebhookController
 *                                               │
 *                                               ▼
 *                                         WebhookService
 *                                               │
 *                                               ▼
 *                                       Idempotency check
 *                                               │
 *                                               ▼
 *                                       DispatcherService
 *                                               │
 *                                               ▼
 *                                       ProcessingService
 *                                               │
 *                                               ▼
 *                                       ConnectorRegistry.get(targetSystem)
 *                                               │
 *                                               ▼
 *                                       Concrete Connector (zabbix, cmdbuild, fake, ...)
 *
 * The `targetSystem` field is the key routing field. It must match either:
 *   1. A static connector name (e.g. 'rest', 'db') — legacy mode
 *   2. A TargetSystem.name from the DB (e.g. 'zabbix-prod') — multi-instance mode
 */
export class AvanpostWebhookDto {
  /** Unique event identifier — used for idempotency/deduplication */
  @IsString()
  @Matches(/\S/, { message: 'eventId must not be empty' })
  eventId: string;

  /** Operation name — must be one of the idmMw Avanpost-compatible operations. */
  @IsString()
  @IsIn(AVANPOST_OPERATION_VALUES)
  operation: string;

  /**
   * Routing key for the connector registry.
   * In multi-instance mode this is the TargetSystem.name from the DB.
   * In legacy mode this is the static connector type ('rest', 'db', ...).
   */
  @IsString()
  @Matches(/\S/, { message: 'targetSystem must not be empty' })
  targetSystem: string;

  /**
   * Avanpost-compatible payload zones:
   * - payload.data: mutable write data
   * - payload.params: read/test identifiers and filters
   * - payload.metadata: optional IDM process context
   */
  @IsObject()
  @Validate(AvanpostPayloadShapeConstraint)
  payload: Record<string, unknown>;
}

/**
 * Webhook response shape.
 *
 * Write operations usually return only `received` and `processed`.
 * Connectors may include safe operational metadata in `data`, for example
 * ConsultantPlus password-reset delivery status without a password value.
 * For read/test operations (`user.get`, `user.search`, `system.test`,
 * `schema.get`, `sync.*`) the connector result is included in `data`.
 */
export interface WebhookResponse {
  received: boolean;
  processed: boolean;
  data?: unknown;
}

/**
 * Inbound webhook endpoint.
 *
 * Receives events from Avanpost IDM and forwards them through the processing pipeline.
 * Every request is audited via AuditInterceptor (writes to AuditLog table).
 */
@Controller('webhooks/avanpost')
@UseInterceptors(AuditInterceptor)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    private readonly webhookService: WebhookService,
    private readonly diagnostics: DiagnosticLoggerService,
  ) {}

  @Post()
  async receiveWebhook(
    @Body() dto: AvanpostWebhookDto,
  ): Promise<WebhookResponse> {
    this.logger.log(
      `Received webhook: ${dto.eventId}, operation: ${dto.operation}, targetSystem: ${dto.targetSystem}`,
    );
    const isRead = isReadOperation(dto.operation);
    this.diagnostics.basic('idm.webhook.received', {
      eventId: dto.eventId,
      operation: dto.operation,
      targetSystem: dto.targetSystem,
      mode: isRead ? 'read' : 'write',
    });
    this.diagnostics.verbose('idm.webhook.payload', {
      eventId: dto.eventId,
      operation: dto.operation,
      targetSystem: dto.targetSystem,
      payload: dto.payload,
    });
    const result = await this.webhookService.processWebhook(dto, isRead);
    return {
      received: true,
      processed: result.processed,
      ...(result.data !== undefined ? { data: result.data } : {}),
    };
  }
}
