import { RuntimeDiagnosticsService } from './runtime-diagnostics.service';
import { resetRuntimeLogBufferForTests, runtimeLogBuffer } from './log-buffer';

describe('RuntimeDiagnosticsService', () => {
  beforeEach(() => {
    resetRuntimeLogBufferForTests();
  });

  it('enables target-scoped debug with bounded ttl', () => {
    const service = new RuntimeDiagnosticsService();

    const session = service.enable({
      targetSystem: 'CMDB',
      level: 'Verbose',
      ttlSeconds: 999999,
    });

    expect(session.targetSystem).toBe('CMDB');
    expect(session.level).toBe('Verbose');
    expect(service.isEnabled('CMDB')).toBe(true);
    expect(service.level('CMDB')).toBe('Verbose');
    expect(Date.parse(session.expiresAt) - Date.parse(session.createdAt)).toBe(
      1800 * 1000,
    );
  });

  it('disables active debug sessions', () => {
    const service = new RuntimeDiagnosticsService();
    const session = service.enable({ targetSystem: 'CMDB' });

    expect(service.disable(session.id)).toBe(true);
    expect(service.isEnabled('CMDB')).toBe(false);
  });

  it('does not match target-scoped debug sessions to unscoped events', () => {
    const service = new RuntimeDiagnosticsService();
    service.enable({
      targetSystem: 'CMDB',
      level: 'Verbose',
      ttlSeconds: 300,
    });

    expect(service.isEnabled()).toBe(false);
    expect(service.isEnabled('OTHER')).toBe(false);
    expect(service.isEnabled('CMDB')).toBe(true);
  });

  it('matches global debug sessions to all events', () => {
    const service = new RuntimeDiagnosticsService();
    service.enable({ level: 'Verbose', ttlSeconds: 300 });

    expect(service.isEnabled()).toBe(true);
    expect(service.isEnabled('CMDB')).toBe(true);
  });

  it('queries process-local logs by target system and level', () => {
    const service = new RuntimeDiagnosticsService();
    runtimeLogBuffer.append({
      time: Date.now(),
      level: 30,
      targetSystem: 'CMDB',
      msg: 'info',
    });
    runtimeLogBuffer.append({
      time: Date.now(),
      level: 50,
      targetSystem: 'CMDB',
      msg: 'error',
    });
    runtimeLogBuffer.append({
      time: Date.now(),
      level: 50,
      targetSystem: 'OTHER',
      msg: 'other',
    });

    const logs = service.logs({
      targetSystem: 'CMDB',
      level: 'error',
      limit: 10,
    });

    expect(logs).toHaveLength(1);
    expect(logs[0].msg).toBe('error');
  });

  it('normalizes malformed log limits and returns safe log records', () => {
    const service = new RuntimeDiagnosticsService();
    for (let index = 0; index < 600; index += 1) {
      runtimeLogBuffer.append({
        time: Date.now(),
        level: 30,
        targetSystem: 'CMDB',
        msg: `event-${index}`,
        req: {
          method: 'GET',
          url: `/users?filter=user-${index}`,
          headers: { authorization: 'Bearer secret' },
        },
        payload: { password: 'plain-secret' },
      });
    }

    const malformedLimitLogs = service.logs({
      targetSystem: 'CMDB',
      limit: Number.NaN,
    });
    const oversizedLimitLogs = service.logs({
      targetSystem: 'CMDB',
      limit: 9999,
    });

    expect(malformedLimitLogs).toHaveLength(200);
    expect(oversizedLimitLogs).toHaveLength(500);
    expect(oversizedLimitLogs[0]).not.toHaveProperty('raw');
    expect(oversizedLimitLogs[0]).toEqual(
      expect.objectContaining({
        method: 'GET',
        path: '/users',
      }),
    );
    expect(JSON.stringify(oversizedLimitLogs)).not.toContain('plain-secret');
    expect(JSON.stringify(oversizedLimitLogs)).not.toContain('Bearer secret');
    expect(JSON.stringify(oversizedLimitLogs)).not.toContain('filter=user');
  });
});
