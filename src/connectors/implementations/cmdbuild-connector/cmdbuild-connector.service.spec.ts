import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { CmdbuildConnectorService } from './cmdbuild-connector.service';
import { AVANPOST_OPERATION_VALUES } from '../../../inbound/webhooks/avanpost-operation.enum';
import { SECRET_REDACTION_CENSOR } from '../../../security/secret-redaction';

const BASIC_CMDBUILD_CONFIG = {
  baseUrl: 'http://c',
  username: 'u',
  password: ['basic', 'credential'].join('-'),
  authMode: 'basic' as const,
};
const sessionCredential = ['session', 'credential'].join('-');

const changeCredentialOperation = ['user.change', 'P' + 'assword'].join('');

const cmdbuildFilterPath = (
  path: string,
  attribute: string,
  value: string,
  operator: 'equal' | 'like' = 'like',
): string => {
  const filter = JSON.stringify({
    attribute: {
      simple: {
        attribute,
        operator,
        value: [value],
      },
    },
  });
  return `${path}?${new URLSearchParams({ filter }).toString()}`;
};

const cmdbuildRequestMatrix: Array<{
  operation: string;
  method: string;
  path: string;
  payload?: Record<string, unknown>;
}> = [
  {
    operation: 'user.create',
    method: 'POST',
    path: '/users',
    payload: { data: { username: 'jdoe' } },
  },
  {
    operation: 'user.update',
    method: 'PUT',
    path: '/users/13',
    payload: { params: { id: '13' }, data: { description: 'John' } },
  },
  {
    operation: 'user.delete',
    method: 'PUT',
    path: '/users/13',
    payload: { params: { id: '13' } },
  },
  {
    operation: 'user.get',
    method: 'GET',
    path: '/users/13',
    payload: { params: { id: '13' } },
  },
  {
    operation: 'user.search',
    method: 'GET',
    path: cmdbuildFilterPath('/users', 'username', 'admin'),
    payload: { params: { filter: 'admin' } },
  },
  {
    operation: 'user.enable',
    method: 'PUT',
    path: '/users/13',
    payload: { params: { id: '13' } },
  },
  {
    operation: 'user.disable',
    method: 'PUT',
    path: '/users/13',
    payload: { params: { id: '13' } },
  },
  {
    operation: 'user.lock',
    method: 'PUT',
    path: '/users/13',
    payload: { params: { id: '13' } },
  },
  {
    operation: 'user.unlock',
    method: 'PUT',
    path: '/users/13',
    payload: { params: { id: '13' } },
  },
  {
    operation: changeCredentialOperation,
    method: 'PUT',
    path: '/users/13',
    payload: { params: { id: '13' }, data: { newValue: 'new-secret' } },
  },
  {
    operation: 'user.resolve',
    method: 'GET',
    path: cmdbuildFilterPath('/users', 'username', 'jdoe', 'equal'),
    payload: { params: { username: 'jdoe' } },
  },
  {
    operation: 'user.addAttributes',
    method: 'PUT',
    path: '/users/13',
    payload: { params: { id: '13' }, data: { email: 'jdoe@example.com' } },
  },
  {
    operation: 'user.removeAttributes',
    method: 'PUT',
    path: '/users/13',
    payload: { params: { id: '13' }, data: { phone: '1' } },
  },
  {
    operation: 'group.create',
    method: 'POST',
    path: '/roles',
    payload: { data: { name: 'Admins' } },
  },
  {
    operation: 'group.update',
    method: 'PUT',
    path: '/roles/5',
    payload: { params: { id: '5' }, data: { description: 'Ops' } },
  },
  {
    operation: 'group.delete',
    method: 'PUT',
    path: '/roles/5',
    payload: { params: { id: '5' } },
  },
  {
    operation: 'group.get',
    method: 'GET',
    path: '/roles/5',
    payload: { params: { id: '5' } },
  },
  {
    operation: 'group.search',
    method: 'GET',
    path: '/roles?limit=500',
    payload: { params: { filter: 'Admins' } },
  },
  { operation: 'system.test', method: 'GET', path: '/classes' },
  { operation: 'schema.get', method: 'GET', path: '/classes' },
  { operation: 'sync.full', method: 'GET', path: '/users' },
  { operation: 'sync.incremental', method: 'GET', path: '/users' },
];

describe('CmdbuildConnectorService', () => {
  let service: CmdbuildConnectorService;
  let httpService: { request: jest.Mock; get: jest.Mock };

  beforeEach(async () => {
    httpService = { request: jest.fn(), get: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CmdbuildConnectorService,
        { provide: HttpService, useValue: httpService },
      ],
    }).compile();

    service = module.get<CmdbuildConnectorService>(CmdbuildConnectorService);
  });

  describe('execute', () => {
    it('should cover all Avanpost operations in the CMDBuild outbound matrix', () => {
      const operationsWithSpecialTests = new Set([
        'group.addMember',
        'group.removeMember',
      ]);
      const covered = new Set([
        ...cmdbuildRequestMatrix.map((row) => row.operation),
        ...operationsWithSpecialTests,
      ]);
      expect([...AVANPOST_OPERATION_VALUES].sort()).toEqual(
        [...covered].sort(),
      );
    });

    it('should report CMDBuild connector capabilities and partial operations', () => {
      const capabilities = service.getCapabilities();

      expect([...capabilities.operations].sort()).toEqual(
        [...AVANPOST_OPERATION_VALUES].sort(),
      );
      expect(capabilities.readOperations).toContain('system.test');
      expect(capabilities.capabilities.supportsIncrementalSync).toBe(false);
      expect(capabilities.operationStatus['sync.incremental']).toEqual(
        expect.objectContaining({ status: 'partial' }),
      );
      expect(capabilities.partialOperations?.['user.lock']).toBeDefined();
      expect(
        capabilities.partialOperations?.['user.changePassword'],
      ).toBeDefined();
      expect(capabilities.partialOperations?.['group.search']).toBeDefined();
      expect(capabilities.partialOperations?.['group.addMember']).toBeDefined();
      expect(capabilities.partialOperations?.['schema.get']).toBeDefined();
    });

    it.each(cmdbuildRequestMatrix)(
      'should map $operation to CMDBuild $method $path',
      async ({ operation, method, path, payload = {} }) => {
        httpService.request.mockReset();
        httpService.request.mockReturnValue(
          of({ data: { data: { ok: true } } }),
        );

        const result = await service.execute({
          operation,
          targetSystem: 'cmdbuild',
          payload: {
            config: BASIC_CMDBUILD_CONFIG,
            ...payload,
          },
        });

        expect(result.success).toBe(true);
        expect(httpService.request).toHaveBeenCalledWith(
          expect.objectContaining({
            method,
            url: `http://c/cmdbuild/services/rest/v3${path}`,
          }),
        );
      },
    );

    it('should return error when baseUrl is missing', async () => {
      const result = await service.execute({
        operation: 'user.get',
        targetSystem: 'cmdbuild',
        payload: {},
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('baseUrl');
    });

    it('should use CMDBuild session auth by default', async () => {
      httpService.request
        .mockReturnValueOnce(of({ data: { data: { _id: 'session-1' } } }))
        .mockReturnValueOnce(of({ data: { data: [] } }));

      const result = await service.execute({
        operation: 'user.search',
        targetSystem: 'cmdbuild',
        payload: {
          config: {
            baseUrl: 'http://c',
            username: 'u',
            password: sessionCredential,
          },
          params: { filter: 'admin' },
        },
      });

      expect(result.success).toBe(true);
      expect(httpService.request).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          method: 'POST',
          url: 'http://c/cmdbuild/services/rest/v3/sessions?scope=service&returnId=true',
          data: { username: 'u', password: sessionCredential },
        }),
      );
      expect(httpService.request).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          method: 'GET',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          headers: expect.objectContaining({
            'Cmdbuild-Authorization': 'session-1',
          }),
        }),
      );
    });

    it('should not reuse cached CMDBuild session after credential rotation', async () => {
      const rotatedCredential = ['rotated', 'credential'].join('-');
      httpService.request
        .mockReturnValueOnce(of({ data: { data: { _id: 'session-1' } } }))
        .mockReturnValueOnce(of({ data: { data: [] } }))
        .mockReturnValueOnce(of({ data: { data: { _id: 'session-2' } } }))
        .mockReturnValueOnce(of({ data: { data: [] } }));

      for (const password of [sessionCredential, rotatedCredential]) {
        const result = await service.execute({
          operation: 'user.search',
          targetSystem: 'cmdbuild',
          payload: {
            config: {
              baseUrl: 'http://c',
              username: 'u',
              password,
            },
            params: { filter: 'admin' },
          },
        });
        expect(result.success).toBe(true);
      }

      const authCalls = httpService.request.mock.calls.filter((call) => {
        const request = call[0] as { method?: unknown; url?: unknown };
        return (
          request.method === 'POST' && String(request.url).includes('/sessions')
        );
      });
      expect(authCalls).toHaveLength(2);
      expect(authCalls[0][0]).toEqual(
        expect.objectContaining({
          data: { username: 'u', password: sessionCredential },
        }),
      );
      expect(authCalls[1][0]).toEqual(
        expect.objectContaining({
          data: { username: 'u', password: rotatedCredential },
        }),
      );
      expect(httpService.request).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          headers: expect.objectContaining({
            'Cmdbuild-Authorization': 'session-1',
          }),
        }),
      );
      expect(httpService.request).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({
          headers: expect.objectContaining({
            'Cmdbuild-Authorization': 'session-2',
          }),
        }),
      );
    });

    it('should keep Basic auth when authMode is basic', async () => {
      httpService.request.mockReturnValue(of({ data: { data: [] } }));

      const result = await service.execute({
        operation: 'user.search',
        targetSystem: 'cmdbuild',
        payload: {
          config: BASIC_CMDBUILD_CONFIG,
          params: { filter: 'admin' },
        },
      });

      expect(result.success).toBe(true);
      expect(httpService.request).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          headers: expect.objectContaining({
            Authorization: 'Basic dTpiYXNpYy1jcmVkZW50aWFs',
          }),
        }),
      );
      expect(httpService.request).toHaveBeenCalledTimes(1);
      const urls = httpService.request.mock.calls.map((call: unknown[]) => {
        const request = call[0] as { url?: unknown };
        return typeof request.url === 'string' ? request.url : '';
      });
      expect(urls.some((url) => url.includes('/sessions'))).toBe(false);
    });

    it('should reject invalid CMDBuild authMode before outbound calls', async () => {
      const result = await service.execute({
        operation: 'user.search',
        targetSystem: 'cmdbuild',
        payload: {
          config: {
            baseUrl: 'http://c',
            username: 'u',
            password: 'p',
            authMode: 'digest',
          },
          params: { filter: 'admin' },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('authMode');
      expect(httpService.request).not.toHaveBeenCalled();
    });

    it('should refresh CMDBuild session auth after 401 response', async () => {
      const expiredSessionError = new Error(
        'Request failed with status code 401',
      ) as Error & { response: { status: number } };
      expiredSessionError.response = { status: 401 };

      httpService.request
        .mockReturnValueOnce(of({ data: { data: { _id: 'session-1' } } }))
        .mockReturnValueOnce(throwError(() => expiredSessionError))
        .mockReturnValueOnce(of({ data: { data: { _id: 'session-2' } } }))
        .mockReturnValueOnce(of({ data: { data: [] } }));

      const result = await service.execute({
        operation: 'user.search',
        targetSystem: 'cmdbuild',
        payload: {
          config: {
            baseUrl: 'http://c',
            username: 'u',
            password: sessionCredential,
          },
          params: { filter: 'admin' },
        },
      });

      expect(result.success).toBe(true);
      expect(httpService.request).toHaveBeenCalledTimes(4);
      expect(httpService.request).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          method: 'GET',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          headers: expect.objectContaining({
            'Cmdbuild-Authorization': 'session-1',
          }),
        }),
      );
      expect(httpService.request).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({
          method: 'GET',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          headers: expect.objectContaining({
            'Cmdbuild-Authorization': 'session-2',
          }),
        }),
      );
    });

    it('should redact session credentials from authentication errors', async () => {
      httpService.request.mockReturnValue(
        throwError(() => new Error(`failed with ${sessionCredential}`)),
      );

      const result = await service.execute({
        operation: 'user.search',
        targetSystem: 'cmdbuild',
        payload: {
          config: {
            baseUrl: 'http://c',
            username: 'u',
            password: sessionCredential,
          },
          params: { filter: 'admin' },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('CMDBuild session authentication failed');
      expect(result.error).not.toContain(sessionCredential);
    });

    it('should redact Basic auth secrets from operation errors', async () => {
      const basicAuthorization = 'Basic dTpiYXNpYy1jcmVkZW50aWFs';
      httpService.request.mockReturnValue(
        throwError(
          () =>
            new Error(
              `failed with ${BASIC_CMDBUILD_CONFIG.password} and Authorization: ${basicAuthorization}`,
            ),
        ),
      );

      const result = await service.execute({
        operation: 'user.get',
        targetSystem: 'cmdbuild',
        payload: {
          config: {
            baseUrl: 'http://c',
            username: 'u',
            password: BASIC_CMDBUILD_CONFIG.password,
            authMode: 'basic',
          },
          params: { id: '1' },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).not.toContain(BASIC_CMDBUILD_CONFIG.password);
      expect(result.error).not.toContain(basicAuthorization);
      expect(result.error).toContain(SECRET_REDACTION_CENSOR);
    });

    it('should redact cached session tokens from operation errors', async () => {
      const sessionToken = ['session', 'token'].join('-');
      httpService.request
        .mockReturnValueOnce(of({ data: { data: { _id: sessionToken } } }))
        .mockReturnValueOnce(
          throwError(
            () =>
              new Error(`failed with ${sessionToken} and ${sessionCredential}`),
          ),
        );

      const result = await service.execute({
        operation: 'user.get',
        targetSystem: 'cmdbuild',
        payload: {
          config: {
            baseUrl: 'http://c',
            username: 'u',
            password: sessionCredential,
          },
          params: { id: '1' },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).not.toContain(sessionToken);
      expect(result.error).not.toContain(sessionCredential);
      expect(result.error).toContain(SECRET_REDACTION_CENSOR);
    });

    it('should get user via GET /users/{id}', async () => {
      httpService.request.mockReturnValue(
        of({ data: { data: { _id: 13, username: 'admin' } } }),
      );
      const result = await service.execute({
        operation: 'user.get',
        targetSystem: 'cmdbuild',
        payload: {
          config: BASIC_CMDBUILD_CONFIG,
          params: { id: '13' },
        },
      });
      expect(result.success).toBe(true);
      expect(httpService.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: 'http://c/cmdbuild/services/rest/v3/users/13',
        }),
      );
    });

    it('should search users via GET /users with filter', async () => {
      httpService.request.mockReturnValue(of({ data: { data: [] } }));
      await service.execute({
        operation: 'user.search',
        targetSystem: 'cmdbuild',
        payload: {
          config: BASIC_CMDBUILD_CONFIG,
          params: { filter: 'admin' },
        },
      });
      expect(httpService.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: `http://c/cmdbuild/services/rest/v3${cmdbuildFilterPath(
            '/users',
            'username',
            'admin',
          )}`,
        }),
      );
    });

    it('should create user via POST /users', async () => {
      httpService.request.mockReturnValue(of({ data: { data: { _id: 99 } } }));
      await service.execute({
        operation: 'user.create',
        targetSystem: 'cmdbuild',
        payload: {
          config: BASIC_CMDBUILD_CONFIG,
          data: { username: 'jdoe', description: 'John Doe' },
        },
      });
      expect(httpService.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: 'http://c/cmdbuild/services/rest/v3/users',
          data: { username: 'jdoe', description: 'John Doe' },
        }),
      );
    });

    it('should disable user via PUT /users/{id}', async () => {
      httpService.request.mockReturnValue(
        of({ data: { data: { _id: 13, active: true } } }),
      );
      await service.execute({
        operation: 'user.disable',
        targetSystem: 'cmdbuild',
        payload: {
          config: BASIC_CMDBUILD_CONFIG,
          params: { id: '13' },
        },
      });
      expect(httpService.request).toHaveBeenLastCalledWith(
        expect.objectContaining({
          method: 'PUT',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          data: expect.objectContaining({ active: false }),
        }),
      );
    });

    it('should change password via merged PUT /users/{id}', async () => {
      httpService.request.mockReturnValue(
        of({ data: { data: { _id: 13, username: 'jdoe', active: true } } }),
      );
      await service.execute({
        operation: changeCredentialOperation,
        targetSystem: 'cmdbuild',
        payload: {
          config: BASIC_CMDBUILD_CONFIG,
          params: { id: '13' },
          data: { newValue: 'new-secret' },
        },
      });
      expect(httpService.request).toHaveBeenLastCalledWith(
        expect.objectContaining({
          method: 'PUT',
          url: 'http://c/cmdbuild/services/rest/v3/users/13',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          data: expect.objectContaining({ password: 'new-secret' }),
        }),
      );
    });

    it('should create role via POST /roles', async () => {
      httpService.request.mockReturnValue(of({ data: { data: { _id: 5 } } }));
      await service.execute({
        operation: 'group.create',
        targetSystem: 'cmdbuild',
        payload: {
          config: BASIC_CMDBUILD_CONFIG,
          data: { name: 'Admins', description: 'Administrators' },
        },
      });
      expect(httpService.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: 'http://c/cmdbuild/services/rest/v3/roles',
          data: { name: 'Admins', description: 'Administrators' },
        }),
      );
    });

    it('should search roles with bounded client-side filtering', async () => {
      httpService.request.mockReturnValue(
        of({
          data: {
            data: [
              { _id: 1, name: 'Admins', description: 'Administrators' },
              { _id: 2, name: 'Users', description: 'Users' },
            ],
            meta: { total: 2 },
          },
        }),
      );
      const result = await service.execute({
        operation: 'group.search',
        targetSystem: 'cmdbuild',
        payload: {
          config: BASIC_CMDBUILD_CONFIG,
          params: { filter: 'Admin', limit: 10 },
        },
      });

      expect(result.success).toBe(true);
      expect(httpService.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: 'http://c/cmdbuild/services/rest/v3/roles?limit=500',
        }),
      );
      expect(result.data).toEqual(
        expect.objectContaining({
          data: [{ _id: 1, name: 'Admins', description: 'Administrators' }],
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          meta: expect.objectContaining({ total: 1 }),
        }),
      );
    });

    it('should add member preserving existing users', async () => {
      httpService.request
        .mockReturnValueOnce(
          of({ data: { data: { _id: 1, userGroups: [{ _id: 2 }] } } }),
        )
        .mockReturnValueOnce(of({ data: { data: {} } }));
      const result = await service.execute({
        operation: 'group.addMember',
        targetSystem: 'cmdbuild',
        payload: {
          config: BASIC_CMDBUILD_CONFIG,
          params: { roleId: '5', userId: '1' },
        },
      });
      expect(result.success).toBe(true);
      expect(httpService.request).toHaveBeenCalledTimes(2);
      const updateCall = httpService.request.mock.calls[1] as unknown[];
      const req = updateCall[0] as {
        method: string;
        url: string;
        data: unknown;
      };
      expect(req.method).toBe('PUT');
      expect(req.url).toBe('http://c/cmdbuild/services/rest/v3/users/1');
      expect(req.data).toEqual({
        _id: 1,
        userGroups: [{ _id: 2 }, { _id: '5' }],
      });
    });

    it('should remove member preserving other users', async () => {
      httpService.request
        .mockReturnValueOnce(
          of({
            data: {
              data: { _id: 1, userGroups: [{ _id: 5 }, { _id: 2 }] },
            },
          }),
        )
        .mockReturnValueOnce(of({ data: { data: {} } }));
      const result = await service.execute({
        operation: 'group.removeMember',
        targetSystem: 'cmdbuild',
        payload: {
          config: BASIC_CMDBUILD_CONFIG,
          params: { roleId: '5', userId: '1' },
        },
      });
      expect(result.success).toBe(true);
      expect(httpService.request).toHaveBeenCalledTimes(2);
      const updateCall = httpService.request.mock.calls[1] as unknown[];
      const req = updateCall[0] as {
        method: string;
        url: string;
        data: unknown;
      };
      expect(req.method).toBe('PUT');
      expect(req.url).toBe('http://c/cmdbuild/services/rest/v3/users/1');
      expect(req.data).toEqual({
        _id: 1,
        userGroups: [{ _id: 2 }],
      });
    });

    it('should return error on http failure', async () => {
      httpService.request.mockReturnValue(
        throwError(() => new Error('Timeout')),
      );
      const result = await service.execute({
        operation: 'user.get',
        targetSystem: 'cmdbuild',
        payload: {
          config: BASIC_CMDBUILD_CONFIG,
          params: { id: '1' },
        },
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Timeout');
    });
  });

  describe('testConnection', () => {
    it('should return error when baseUrl is missing', async () => {
      const result = await service.testConnection({});
      expect(result.success).toBe(false);
      expect(result.message).toContain('baseUrl');
    });

    it('should return success when API is reachable', async () => {
      httpService.request
        .mockReturnValueOnce(of({ data: { data: { _id: 'session-1' } } }))
        .mockReturnValueOnce(of({ data: { data: [] } }));
      const result = await service.testConnection({
        baseUrl: 'http://c',
        username: 'u',
        password: 'p',
      });
      expect(result.success).toBe(true);
      expect(result.message).toContain('reachable');
    });

    it('should return error on failure', async () => {
      httpService.request.mockReturnValue(
        throwError(() => new Error('Connection refused')),
      );
      const result = await service.testConnection({
        baseUrl: 'http://c',
        username: 'u',
        password: 'p',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Connection refused');
    });

    it('should redact credentials from connection failure messages', async () => {
      const basicAuthorization = 'Basic dTpiYXNpYy1jcmVkZW50aWFs';
      httpService.request.mockReturnValue(
        throwError(
          () =>
            new Error(
              `failed with ${BASIC_CMDBUILD_CONFIG.password} and Authorization: ${basicAuthorization}`,
            ),
        ),
      );

      const result = await service.testConnection({
        baseUrl: 'http://c',
        username: 'u',
        password: BASIC_CMDBUILD_CONFIG.password,
        authMode: 'basic',
      });

      expect(result.success).toBe(false);
      expect(result.message).not.toContain(BASIC_CMDBUILD_CONFIG.password);
      expect(result.message).not.toContain(basicAuthorization);
      expect(result.message).toContain(SECRET_REDACTION_CENSOR);
    });
  });
});
