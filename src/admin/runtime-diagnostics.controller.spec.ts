import { RuntimeDiagnosticsController } from './runtime-diagnostics.controller';
import { RuntimeDiagnosticsService } from '../diagnostics/runtime-diagnostics.service';

describe('RuntimeDiagnosticsController', () => {
  let service: RuntimeDiagnosticsService;
  let controller: RuntimeDiagnosticsController;

  beforeEach(() => {
    service = new RuntimeDiagnosticsService();
    controller = new RuntimeDiagnosticsController(service);
  });

  it('enables, reports and disables runtime debug sessions', () => {
    const session = controller.enableDebug({
      targetSystem: 'CMDB',
      level: 'Verbose',
      ttlSeconds: 300,
    });

    expect(session.targetSystem).toBe('CMDB');
    expect(session.level).toBe('Verbose');
    expect(controller.debugStatus().active).toHaveLength(1);

    expect(controller.disableDebug(session.id)).toEqual({ success: true });
    expect(controller.debugStatus().active).toEqual([]);
  });

  it('returns buffered logs through the service boundary', () => {
    const logsSpy = jest.spyOn(service, 'logs');
    const logs = controller.logs('CMDB', 'error', '20');

    expect(logs).toHaveProperty('items');
    expect(logsSpy).toHaveBeenCalledWith({
      targetSystem: 'CMDB',
      level: 'error',
      limit: 20,
    });
  });

  it('does not partially parse malformed log limits', () => {
    const logsSpy = jest.spyOn(service, 'logs');

    controller.logs(undefined, undefined, '20abc');

    expect(logsSpy).toHaveBeenCalledWith({
      targetSystem: undefined,
      level: undefined,
      limit: Number.NaN,
    });
  });
});
