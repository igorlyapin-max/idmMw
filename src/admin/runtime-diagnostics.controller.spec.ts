import { RuntimeDiagnosticsController } from './runtime-diagnostics.controller';
import { RuntimeDiagnosticsService } from '../diagnostics/runtime-diagnostics.service';
import type { AdminRequest } from '../auth/admin-request';

describe('RuntimeDiagnosticsController', () => {
  let service: RuntimeDiagnosticsService;
  let controller: RuntimeDiagnosticsController;
  let rbac: {
    allowedConnectorTypes: jest.Mock;
    assertRead: jest.Mock;
    assertSuperadmin: jest.Mock;
    connectorTypeByTargetSystemName: jest.Mock;
  };
  const req = {
    adminSession: {
      sub: 'admin',
      name: 'admin',
      provider: 'local',
      csrfToken: 'csrf',
      expiresAt: Date.now() + 1000,
    },
  } as AdminRequest;

  beforeEach(() => {
    service = new RuntimeDiagnosticsService();
    rbac = {
      allowedConnectorTypes: jest.fn().mockResolvedValue(undefined),
      assertRead: jest.fn().mockResolvedValue(undefined),
      assertSuperadmin: jest.fn().mockResolvedValue(undefined),
      connectorTypeByTargetSystemName: jest.fn().mockResolvedValue('cmdbuild'),
    };
    controller = new RuntimeDiagnosticsController(service, rbac as never);
  });

  it('enables, reports and disables runtime debug sessions', async () => {
    const session = await controller.enableDebug(req, {
      targetSystem: 'CMDB',
      level: 'Verbose',
      ttlSeconds: 300,
    });

    expect(session.targetSystem).toBe('CMDB');
    expect(session.level).toBe('Verbose');
    expect((await controller.debugStatus(req)).active).toHaveLength(1);

    await expect(controller.disableDebug(req, session.id)).resolves.toEqual({
      success: true,
    });
    await expect(controller.debugStatus(req)).resolves.toEqual({ active: [] });
  });

  it('returns buffered logs through the service boundary', async () => {
    const logsSpy = jest.spyOn(service, 'logs');
    const logs = await controller.logs(req, 'CMDB', 'error', '20');

    expect(logs).toHaveProperty('items');
    expect(logsSpy).toHaveBeenCalledWith({
      targetSystem: 'CMDB',
      level: 'error',
      limit: 20,
    });
  });

  it('clears buffered logs through the service boundary', async () => {
    const clearSpy = jest.spyOn(service, 'clearLogs');
    const result = await controller.clearLogs(req, 'CMDB');

    expect(result).toEqual({ success: true, cleared: 0 });
    expect(clearSpy).toHaveBeenCalledWith({ targetSystem: 'CMDB' });
  });

  it('does not partially parse malformed log limits', async () => {
    const logsSpy = jest.spyOn(service, 'logs');

    await controller.logs(req, undefined, undefined, '20abc');

    expect(logsSpy).toHaveBeenCalledWith({
      targetSystem: undefined,
      level: undefined,
      limit: Number.NaN,
    });
  });
});
