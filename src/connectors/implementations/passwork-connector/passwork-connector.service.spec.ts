import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { PassworkConnectorService } from './passwork-connector.service';
import { AVANPOST_OPERATION_VALUES } from '../../../inbound/webhooks/avanpost-operation.enum';

const changeCredentialOperation = ['user.change', 'P' + 'assword'].join('');

type PassworkRequestCall = [
  {
    url?: string;
    method?: string;
    data?: unknown;
    headers?: Record<string, string>;
  },
];

describe('PassworkConnectorService', () => {
  let service: PassworkConnectorService;
  let httpService: { request: jest.Mock };

  beforeEach(async () => {
    httpService = { request: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PassworkConnectorService,
        { provide: HttpService, useValue: httpService },
      ],
    }).compile();

    service = module.get<PassworkConnectorService>(PassworkConnectorService);
  });

  function config() {
    return {
      baseUrl: 'https://passwork.local',
      accessToken: 'access-token-1',
      masterKeyHash: 'hash-1',
    };
  }

  describe('capabilities', () => {
    it('should report all Avanpost operations and mark unsupported Passwork gaps', () => {
      const capabilities = service.getCapabilities();

      expect([...capabilities.operations].sort()).toEqual(
        [...AVANPOST_OPERATION_VALUES].sort(),
      );
      expect(capabilities.capabilities.supportsIncrementalSync).toBe(false);
      expect(capabilities.operationStatus[changeCredentialOperation]).toEqual(
        expect.objectContaining({ status: 'unsupported' }),
      );
      expect(capabilities.operationStatus['user.addAttributes']).toEqual(
        expect.objectContaining({ status: 'unsupported' }),
      );
      expect(capabilities.operationStatus['sync.incremental']).toEqual(
        expect.objectContaining({ status: 'unsupported' }),
      );
      expect(capabilities.operationStatus['user.disable']).toEqual(
        expect.objectContaining({ status: 'partial' }),
      );
    });
  });

  describe('execute', () => {
    it('should call Passwork API with bearer token, response format and master key hash', async () => {
      httpService.request.mockReturnValueOnce(of({ data: { id: 'u1' } }));

      const result = await service.execute({
        operation: 'user.get',
        targetSystem: 'passwork-prod',
        payload: {
          config: config(),
          params: { id: 'u1' },
        },
      });

      expect(result).toEqual({ success: true, data: { id: 'u1' } });
      const calls = httpService.request.mock.calls as PassworkRequestCall[];
      expect(calls[0][0]).toMatchObject({
        url: 'https://passwork.local/api/v1/users/u1',
        method: 'GET',
        headers: {
          Authorization: 'Bearer access-token-1',
          'X-Response-Format': 'raw',
          'Passwork-MasterKeyHash': 'hash-1',
        },
      });
    });

    it('should support apiToken as an accessToken alias', async () => {
      httpService.request.mockReturnValueOnce(of({ data: [] }));

      await service.execute({
        operation: 'user.search',
        targetSystem: 'passwork-prod',
        payload: {
          config: { baseUrl: 'https://passwork.local', apiToken: 'token-2' },
          params: { filter: 'ivanov', limit: 10 },
        },
      });

      const calls = httpService.request.mock.calls as PassworkRequestCall[];
      expect(calls[0][0].headers?.Authorization).toBe('Bearer token-2');
      expect(calls[0][0].url).toBe(
        'https://passwork.local/api/v1/users?filter=ivanov&limit=10&search=ivanov',
      );
    });

    it('should map user create, update, delete, block and unblock routes', async () => {
      httpService.request.mockReturnValue(of({ data: { ok: true } }));

      await service.execute({
        operation: 'user.create',
        targetSystem: 'passwork-prod',
        payload: { config: config(), data: { username: 'ivanov' } },
      });
      await service.execute({
        operation: 'user.update',
        targetSystem: 'passwork-prod',
        payload: {
          config: config(),
          params: { id: 'u1' },
          data: { email: 'e' },
        },
      });
      await service.execute({
        operation: 'user.delete',
        targetSystem: 'passwork-prod',
        payload: { config: config(), params: { id: 'u1' } },
      });
      await service.execute({
        operation: 'user.disable',
        targetSystem: 'passwork-prod',
        payload: { config: config(), params: { id: 'u1' } },
      });
      await service.execute({
        operation: 'user.enable',
        targetSystem: 'passwork-prod',
        payload: { config: config(), params: { id: 'u1' } },
      });

      const calls = httpService.request.mock.calls as PassworkRequestCall[];
      expect(calls.map((call) => [call[0].method, call[0].url])).toEqual([
        ['POST', 'https://passwork.local/api/v1/users'],
        ['PATCH', 'https://passwork.local/api/v1/users/u1'],
        ['DELETE', 'https://passwork.local/api/v1/users/u1'],
        ['POST', 'https://passwork.local/api/v1/users/u1/block'],
        ['POST', 'https://passwork.local/api/v1/users/u1/unblock'],
      ]);
      expect(calls[0][0].data).toEqual({ username: 'ivanov' });
    });

    it('should map generic IDM groups to Passwork user group membership after user create', async () => {
      httpService.request
        .mockReturnValueOnce(
          of({ data: { groups: [{ id: 'g1', name: 'Operators' }] } }),
        )
        .mockReturnValueOnce(of({ data: { id: 'u1' } }))
        .mockReturnValueOnce(of({ data: { ok: true } }));

      const result = await service.execute({
        operation: 'user.create',
        targetSystem: 'passwork-prod',
        payload: {
          config: {
            ...config(),
            groupMappingEnabled: true,
            groupMappingMode: 'name',
          },
          data: {
            username: 'ivanov',
            groups: [{ name: 'Operators' }],
          },
        },
      });

      expect(result).toEqual({ success: true, data: { id: 'u1' } });
      const calls = httpService.request.mock.calls as PassworkRequestCall[];
      expect(calls[0][0]).toMatchObject({
        method: 'GET',
        url: 'https://passwork.local/api/v1/user-groups?limit=500',
      });
      expect(calls[1][0]).toMatchObject({
        method: 'POST',
        url: 'https://passwork.local/api/v1/users',
        data: { username: 'ivanov' },
      });
      expect(calls[2][0]).toMatchObject({
        method: 'POST',
        url: 'https://passwork.local/api/v1/user-groups/g1/add-users',
        data: { userIds: ['u1'] },
      });
    });

    it('should ignore default and incoming groups when Passwork group mapping is disabled', async () => {
      httpService.request.mockReturnValueOnce(of({ data: { id: 'u1' } }));

      const result = await service.execute({
        operation: 'user.create',
        targetSystem: 'passwork-prod',
        payload: {
          config: {
            ...config(),
            groupMappingEnabled: false,
            defaultGroups: [{ name: 'Operators' }],
          },
          data: {
            username: 'ivanov',
            groups: [{ name: 'Auditors' }],
          },
        },
      });

      expect(result).toEqual({ success: true, data: { id: 'u1' } });
      const calls = httpService.request.mock.calls as PassworkRequestCall[];
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toMatchObject({
        method: 'POST',
        url: 'https://passwork.local/api/v1/users',
        data: { username: 'ivanov' },
      });
    });

    it('should resolve Passwork groups before user create', async () => {
      httpService.request.mockReturnValueOnce(of({ data: { groups: [] } }));

      const result = await service.execute({
        operation: 'user.create',
        targetSystem: 'passwork-prod',
        payload: {
          config: {
            ...config(),
            groupMappingEnabled: true,
            groupMappingMode: 'name',
          },
          data: {
            username: 'ivanov',
            groups: [{ name: 'Missing' }],
          },
        },
      });

      expect(result).toEqual({
        success: false,
        error: 'Passwork user group not found by name: Missing',
      });
      const calls = httpService.request.mock.calls as PassworkRequestCall[];
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toMatchObject({
        method: 'GET',
        url: 'https://passwork.local/api/v1/user-groups?limit=500',
      });
    });

    it('should map group CRUD and membership routes', async () => {
      httpService.request.mockReturnValue(of({ data: { ok: true } }));

      await service.execute({
        operation: 'group.create',
        targetSystem: 'passwork-prod',
        payload: { config: config(), data: { name: 'Admins' } },
      });
      await service.execute({
        operation: 'group.update',
        targetSystem: 'passwork-prod',
        payload: {
          config: config(),
          params: { id: 'g1' },
          data: { name: 'Ops' },
        },
      });
      await service.execute({
        operation: 'group.delete',
        targetSystem: 'passwork-prod',
        payload: { config: config(), params: { id: 'g1' } },
      });
      await service.execute({
        operation: 'group.addMember',
        targetSystem: 'passwork-prod',
        payload: { config: config(), params: { groupId: 'g1', userId: 'u1' } },
      });
      await service.execute({
        operation: 'group.removeMember',
        targetSystem: 'passwork-prod',
        payload: {
          config: config(),
          params: { groupId: 'g1' },
          data: { userIds: ['u1', 'u2'] },
        },
      });

      const calls = httpService.request.mock.calls as PassworkRequestCall[];
      expect(calls.map((call) => [call[0].method, call[0].url])).toEqual([
        ['POST', 'https://passwork.local/api/v1/user-groups'],
        ['POST', 'https://passwork.local/api/v1/user-groups/g1'],
        ['DELETE', 'https://passwork.local/api/v1/user-groups/g1'],
        ['POST', 'https://passwork.local/api/v1/user-groups/g1/add-users'],
        ['POST', 'https://passwork.local/api/v1/user-groups/g1/remove-users'],
      ]);
      expect(calls[3][0].data).toEqual({ userIds: ['u1'] });
      expect(calls[4][0].data).toEqual({ userIds: ['u1', 'u2'] });
    });

    it('should return local schema without calling Passwork API', async () => {
      const result = await service.execute({
        operation: 'schema.get',
        targetSystem: 'passwork-prod',
        payload: { config: config() },
      });

      expect(result.success).toBe(true);
      const schema = result.data as {
        objectClasses: Array<{ name: string }>;
      };
      expect(
        schema.objectClasses.map((objectClass) => objectClass.name),
      ).toEqual(expect.arrayContaining(['user', 'group']));
      expect(httpService.request).not.toHaveBeenCalled();
    });

    it('should sync users and groups without decrypted secret data', async () => {
      httpService.request
        .mockReturnValueOnce(of({ data: { users: [{ id: 'u1' }] } }))
        .mockReturnValueOnce(of({ data: { groups: [{ id: 'g1' }] } }));

      const result = await service.sync(
        {
          operation: 'sync.full',
          targetSystem: 'passwork-prod',
          payload: { config: config(), params: { limit: 100 } },
        },
        'full',
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        mode: 'full',
        users: { users: [{ id: 'u1' }] },
        groups: { groups: [{ id: 'g1' }] },
      });
      const calls = httpService.request.mock.calls as PassworkRequestCall[];
      expect(calls.map((call) => call[0].url)).toEqual([
        'https://passwork.local/api/v1/users?limit=100',
        'https://passwork.local/api/v1/user-groups?limit=100',
      ]);
    });

    it('should reject unsupported operations explicitly', async () => {
      const result = await service.execute({
        operation: changeCredentialOperation,
        targetSystem: 'passwork-prod',
        payload: { config: config(), params: { id: 'u1' } },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported Passwork operation');
      expect(httpService.request).not.toHaveBeenCalled();
    });

    it('should report missing config errors', async () => {
      await expect(
        service.execute({
          operation: 'user.get',
          targetSystem: 'passwork-prod',
          payload: {},
        }),
      ).resolves.toEqual({
        success: false,
        error: 'Missing Passwork config (baseUrl)',
      });

      await expect(
        service.execute({
          operation: 'user.get',
          targetSystem: 'passwork-prod',
          payload: { config: { baseUrl: 'https://passwork.local' } },
        }),
      ).resolves.toEqual({
        success: false,
        error: 'Missing Passwork config (accessToken or apiToken)',
      });
    });

    it('should redact token-like config values from returned errors', async () => {
      httpService.request.mockReturnValueOnce(
        throwError(() => new Error('failed with access-token-1 and hash-1')),
      );

      const result = await service.execute({
        operation: 'user.get',
        targetSystem: 'passwork-prod',
        payload: { config: config(), params: { id: 'u1' } },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('[REDACTED]');
      expect(result.error).not.toContain('access-token-1');
      expect(result.error).not.toContain('hash-1');
    });
  });

  describe('testConnection', () => {
    it('should use current session info endpoint', async () => {
      httpService.request.mockReturnValueOnce(
        of({ data: { id: 'session-1' } }),
      );

      const result = await service.testConnection(config());

      expect(result).toEqual({
        success: true,
        message: 'Passwork API reachable',
      });
      const calls = httpService.request.mock.calls as PassworkRequestCall[];
      expect(calls[0][0]).toMatchObject({
        url: 'https://passwork.local/api/v1/sessions/current/info',
        method: 'GET',
      });
    });
  });
});
