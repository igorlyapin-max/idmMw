import { Logger } from '@nestjs/common';
import { DiagnosticLoggerService } from './diagnostic-logger.service';

describe('DiagnosticLoggerService', () => {
  const payloadCredential = ['plain', 'credential'].join('-');
  const payloadToken = ['plain', 'token'].join('-');
  let logSpy: jest.SpyInstance;
  let debugSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createService(
    values: Record<string, boolean | string | undefined>,
  ): DiagnosticLoggerService {
    return new DiagnosticLoggerService({
      get: (key: string) => values[key],
    } as never);
  }

  it('does not emit diagnostic events when disabled', () => {
    const service = createService({ DebugLogging__Enabled: false });

    service.basic('idm.webhook.received', { eventId: 'e1' });
    service.verbose('idm.webhook.payload', { payload: { token: 'secret' } });

    expect(logSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('keeps Basic events flat and redacts top-level sensitive values', () => {
    const service = createService({
      DebugLogging__Enabled: true,
      DebugLogging__Level: 'Basic',
    });

    service.basic('idm.webhook.received', {
      eventId: 'e1',
      targetSystem: 'fake',
      token: payloadToken,
      payload: { data: { password: payloadCredential } },
    });

    expect(logSpy).toHaveBeenCalledWith({
      diagnostic: true,
      diagnosticLevel: 'Basic',
      event: 'idm.webhook.received',
      eventId: 'e1',
      targetSystem: 'fake',
      token: '[REDACTED]',
      payload: '[omitted]',
    });
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('keeps Verbose structure but redacts nested sensitive values', () => {
    const service = createService({
      DebugLogging__Enabled: true,
      DebugLogging__Level: 'Verbose',
    });

    service.verbose('idm.webhook.payload', {
      payload: {
        data: {
          username: 'runtime-smoke',
          password: payloadCredential,
          token: payloadToken,
        },
      },
    });

    expect(debugSpy).toHaveBeenCalledWith({
      diagnostic: true,
      diagnosticLevel: 'Verbose',
      event: 'idm.webhook.payload',
      payload: {
        data: {
          username: 'runtime-smoke',
          password: '[REDACTED]',
          token: '[REDACTED]',
        },
      },
    });
  });
});
