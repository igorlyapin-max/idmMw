import { Logger } from '@nestjs/common';
import { DiagnosticLoggerService } from './diagnostic-logger.service';
import { RuntimeDiagnosticsService } from './runtime-diagnostics.service';

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
    return new DiagnosticLoggerService(
      {
        get: (key: string) => values[key],
      } as never,
      new RuntimeDiagnosticsService(),
    );
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

    expect(logSpy).toHaveBeenCalledWith({
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
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('enables Verbose through runtime override for a target system', () => {
    const runtimeDiagnostics = new RuntimeDiagnosticsService();
    runtimeDiagnostics.enable({
      targetSystem: 'CMDB',
      level: 'Verbose',
      ttlSeconds: 300,
    });
    const service = new DiagnosticLoggerService(
      {
        get: () => false,
      } as never,
      runtimeDiagnostics,
    );

    service.verbose('cmdbuild.request', {
      targetSystem: 'CMDB',
      payload: { password: payloadCredential },
    });

    expect(logSpy).toHaveBeenCalledWith({
      diagnostic: true,
      diagnosticLevel: 'Verbose',
      event: 'cmdbuild.request',
      targetSystem: 'CMDB',
      payload: { password: '[REDACTED]' },
    });
  });

  it('does not apply target-scoped runtime override to unscoped events', () => {
    const runtimeDiagnostics = new RuntimeDiagnosticsService();
    runtimeDiagnostics.enable({
      targetSystem: 'CMDB',
      level: 'Verbose',
      ttlSeconds: 300,
    });
    const service = new DiagnosticLoggerService(
      {
        get: () => false,
      } as never,
      runtimeDiagnostics,
    );

    service.verbose('startup.runtime', {
      payload: { password: payloadCredential },
    });

    expect(logSpy).not.toHaveBeenCalled();
  });
});
