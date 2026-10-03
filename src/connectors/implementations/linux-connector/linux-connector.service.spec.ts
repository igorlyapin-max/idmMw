import { EventEmitter } from 'events';
import { of } from 'rxjs';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Client } from 'ssh2';
import { PrismaService } from '../../../database/prisma.service';
import { IndeedPamAapmClient } from '../../../secrets/indeed-pam-aapm.client';
import { LinuxConnectorService } from './linux-connector.service';

const sshCommands: string[] = [];

jest.mock('ssh2', () => ({
  Client: jest.fn().mockImplementation(() => {
    const client = new EventEmitter() as EventEmitter & {
      exec: jest.Mock;
      connect: jest.Mock;
      end: jest.Mock;
    };
    client.exec = jest.fn(
      (
        command: string,
        cb: (
          error: Error | null,
          stream: EventEmitter & { stderr: EventEmitter },
        ) => void,
      ) => {
        sshCommands.push(command);
        const stream = new EventEmitter() as EventEmitter & {
          stderr: EventEmitter;
          write: jest.Mock;
          end: jest.Mock;
        };
        stream.stderr = new EventEmitter();
        stream.write = jest.fn();
        stream.end = jest.fn();
        cb(null, stream);
        process.nextTick(() => stream.emit('close', 0));
      },
    );
    client.connect = jest.fn(() => {
      process.nextTick(() => client.emit('ready'));
      return client;
    });
    client.end = jest.fn();
    return client;
  }),
}));

describe('LinuxConnectorService', () => {
  let request: jest.Mock;
  let service: LinuxConnectorService;
  let prisma: {
    targetSystem: { findUnique: jest.Mock };
    linuxHost: { count: jest.Mock };
    linuxServerGroup: { findMany: jest.Mock; findFirst: jest.Mock };
  };
  let configService: { get: jest.Mock };
  let pamClient: { getValue: jest.Mock };

  beforeEach(() => {
    sshCommands.length = 0;
    request = jest
      .fn()
      .mockReturnValue(of({ data: { ok: true }, status: 200 }));
    prisma = {
      targetSystem: { findUnique: jest.fn() },
      linuxHost: { count: jest.fn() },
      linuxServerGroup: { findMany: jest.fn(), findFirst: jest.fn() },
    };
    configService = { get: jest.fn((key: string) => process.env[key]) };
    pamClient = { getValue: jest.fn() };
    service = new LinuxConnectorService(
      { request } as unknown as HttpService,
      prisma as unknown as PrismaService,
      configService as unknown as ConfigService,
      pamClient as unknown as IndeedPamAapmClient,
    );
    (Client as unknown as jest.Mock).mockClear();
  });

  it('calls remote-agent create user endpoint with IDM password', async () => {
    const result = await service.execute({
      operation: 'user.create',
      targetSystem: 'linux-prod',
      payload: {
        config: {
          provider: 'remote-agent',
          baseUrl: 'https://linux-agent.local',
          apiToken: 'agent-token',
          allowedHosts: ['linux-agent.local'],
        },
        data: { login: 'ivanov', password: 'secret-password', groups: ['ops'] },
      },
    });

    expect(result).toEqual({ success: true, data: { ok: true } });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://linux-agent.local/users',
        method: 'POST',
        data: {
          login: 'ivanov',
          password: 'secret-password',
          groups: ['ops'],
        },
        headers: { Authorization: 'Bearer agent-token' },
      }),
    );
  });

  it('maps remote-agent delete to disable by default', async () => {
    await service.execute({
      operation: 'user.delete',
      targetSystem: 'linux-prod',
      payload: {
        config: {
          provider: 'remote-agent',
          baseUrl: 'https://linux-agent.local',
        },
        data: { login: 'ivanov' },
      },
    });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://linux-agent.local/users/ivanov/disable',
        method: 'POST',
      }),
    );
  });

  it('builds ssh-sudo lifecycle commands with safe delete default', async () => {
    const basePayload = {
      targetSystem: 'linux-prod',
      payload: {
        config: {
          provider: 'ssh-sudo',
          host: 'linux.local',
          username: 'idm',
          privateKey: 'key',
          hostFingerprint: 'SHA256:test-fingerprint',
          sudoMode: 'passwordless',
          defaultGroups: ['ops'],
        },
      },
    };

    await service.execute({
      ...basePayload,
      operation: 'user.create',
      payload: {
        ...basePayload.payload,
        data: { login: 'ivanov', password: 'secret-password' },
      },
    });
    await service.execute({
      ...basePayload,
      operation: 'user.delete',
      payload: {
        ...basePayload.payload,
        data: { login: 'ivanov' },
      },
    });

    expect(sshCommands).toEqual([
      "sudo useradd -m -d '/home/ivanov' -s '/bin/bash' -G 'ops' 'ivanov'",
      'sudo chpasswd',
      "sudo passwd -l 'ivanov' && sudo chage -E 0 'ivanov'",
    ]);
    expect(sshCommands.join('\n')).not.toContain('secret-password');
  });

  it('allows Linux search and sync without a login', async () => {
    const result = await service.execute({
      operation: 'user.search',
      targetSystem: 'linux-prod',
      payload: {
        config: {
          provider: 'remote-agent',
          baseUrl: 'https://linux-agent.local',
        },
        data: {},
      },
    });

    expect(result).toEqual({ success: true, data: { ok: true } });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://linux-agent.local/users',
        method: 'GET',
      }),
    );
  });

  it('redacts Linux connector secrets from returned errors', async () => {
    request.mockImplementation(() => {
      throw new Error(
        'failed with agent-token and private key PRIVATE_KEY_VALUE and password secret-password',
      );
    });

    const result = await service.execute({
      operation: 'user.create',
      targetSystem: 'linux-prod',
      payload: {
        config: {
          provider: 'remote-agent',
          baseUrl: 'https://linux-agent.local',
          apiToken: 'agent-token',
          allowedHosts: ['linux-agent.local'],
          privateKey: 'PRIVATE_KEY_VALUE',
        },
        data: { login: 'ivanov', password: 'secret-password' },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('[REDACTED]');
    expect(result.error).not.toContain('agent-token');
    expect(result.error).not.toContain('PRIVATE_KEY_VALUE');
    expect(result.error).not.toContain('secret-password');
  });

  it('marks unsupported Linux operations in capabilities', () => {
    const capabilities = service.getCapabilities();

    expect(capabilities.operationStatus['group.addMember']).toEqual(
      expect.objectContaining({ status: 'unsupported' }),
    );
    expect(capabilities.operationStatus['user.search']).toEqual({
      status: 'implemented',
    });
  });

  it('rejects ssh-sudo without passwordless sudo mode', async () => {
    const result = await service.execute({
      operation: 'system.test',
      targetSystem: 'linux-prod',
      payload: {
        config: {
          provider: 'ssh-sudo',
          host: 'linux.local',
          username: 'idm',
          privateKey: 'key',
        },
        data: { login: 'ivanov' },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('sudoMode=passwordless');
  });

  it('returns Linux fleet server groups as IDM groups', async () => {
    prisma.targetSystem.findUnique.mockResolvedValue({
      id: 'ts-linux',
      type: 'linux',
    });
    prisma.linuxServerGroup.findMany.mockResolvedValue([
      {
        code: 'linux-app',
        name: 'Linux App Servers',
        description: 'application nodes',
        enabled: true,
        hosts: [{ hostId: 'host-1' }, { hostId: 'host-2' }],
      },
    ]);

    const result = await service.execute({
      operation: 'group.search',
      targetSystem: 'linux-prod',
      payload: {
        config: { provider: 'ssh-sudo-fleet' },
        data: {},
      },
    });

    expect(result).toEqual({
      success: true,
      data: {
        data: [
          expect.objectContaining({
            _id: 'linux-app',
            code: 'linux-app',
            hostCount: 2,
          }),
        ],
        meta: { total: 1 },
      },
    });
  });

  it('fans out Linux fleet user operations to selected server group hosts', async () => {
    process.env.LINUX_TEST_KEY = 'key';
    prisma.targetSystem.findUnique.mockResolvedValue({
      id: 'ts-linux',
      type: 'linux',
    });
    prisma.linuxServerGroup.findMany.mockResolvedValue([
      {
        code: 'linux-app',
        hosts: [
          {
            host: {
              id: 'host-1',
              name: 'app-1',
              host: 'app-1.local',
              port: 22,
              hostFingerprint: 'SHA256:test-fingerprint',
              enabled: true,
              credentialProfile: {
                username: 'idm',
                mode: 'env',
                privateKeyRef: 'env:LINUX_TEST_KEY',
                passwordRef: null,
                enabled: true,
              },
            },
          },
        ],
      },
    ]);

    const result = await service.execute({
      operation: 'user.create',
      targetSystem: 'linux-prod',
      payload: {
        config: {
          provider: 'ssh-sudo-fleet',
          sudoMode: 'passwordless',
        },
        data: {
          login: 'ivanov',
          password: 'secret-password',
          serverGroups: ['linux-app'],
          posixGroups: ['ops'],
        },
      },
    });

    expect(configService.get).toHaveBeenCalledWith('LINUX_TEST_KEY');
    expect(result.success).toBe(true);
    expect(sshCommands).toEqual([
      "sudo useradd -m -d '/home/ivanov' -s '/bin/bash' -G 'ops' 'ivanov'",
      'sudo chpasswd',
    ]);
  });
});
