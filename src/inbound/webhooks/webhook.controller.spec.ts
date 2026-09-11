import { Test, TestingModule } from '@nestjs/testing';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { PrismaService } from '../../database/prisma.service';
import { JsonHelper } from '../../database/json.helper';
import { DiagnosticLoggerService } from '../../diagnostics/diagnostic-logger.service';

describe('WebhookController', () => {
  let controller: WebhookController;
  let service: { processWebhook: jest.Mock };
  let diagnostics: { basic: jest.Mock; verbose: jest.Mock };

  beforeEach(async () => {
    service = { processWebhook: jest.fn() };
    diagnostics = { basic: jest.fn(), verbose: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [
        { provide: WebhookService, useValue: service },
        { provide: DiagnosticLoggerService, useValue: diagnostics },
        { provide: PrismaService, useValue: {} },
        { provide: JsonHelper, useValue: {} },
      ],
    }).compile();

    controller = module.get<WebhookController>(WebhookController);
  });

  it('should receive and process write webhook', async () => {
    service.processWebhook.mockResolvedValue({ processed: true });
    const result = await controller.receiveWebhook({
      eventId: 'e1',
      operation: 'user.create',
      targetSystem: 'zabbix',
      payload: {},
    });
    expect(result.received).toBe(true);
    expect(result.processed).toBe(true);
    expect(result.data).toBeUndefined();
    expect(diagnostics.basic).toHaveBeenCalledWith(
      'idm.webhook.received',
      expect.objectContaining({
        mode: 'write',
        receivedAt: expect.stringMatching(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
        ),
      }),
    );
  });

  it('should receive and process read webhook with data', async () => {
    service.processWebhook.mockResolvedValue({
      processed: true,
      data: { id: 'user-1' },
    });
    const result = await controller.receiveWebhook({
      eventId: 'e1',
      operation: 'user.get',
      targetSystem: 'zabbix',
      payload: {},
    });
    expect(result.received).toBe(true);
    expect(result.processed).toBe(true);
    expect(result.data).toEqual({ id: 'user-1' });
    expect(diagnostics.basic).toHaveBeenCalledWith(
      'idm.webhook.received',
      expect.objectContaining({
        mode: 'read',
        receivedAt: expect.stringMatching(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
        ),
      }),
    );
  });
});
