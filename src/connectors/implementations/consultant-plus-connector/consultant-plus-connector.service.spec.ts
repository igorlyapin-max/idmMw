import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { ConsultantPlusConnectorService } from './consultant-plus-connector.service';
import { AVANPOST_OPERATION_VALUES } from '../../../inbound/webhooks/avanpost-operation.enum';

type ConsultantRequestCall = [
  {
    url?: string;
    method?: string;
    data?: unknown;
    headers?: Record<string, string>;
    params?: Record<string, unknown>;
  },
];

describe('ConsultantPlusConnectorService', () => {
  const operatorCredential = ['operator', 'credential'].join('-');
  const generatedCredential = ['generated', 'credential'].join('-');
  let service: ConsultantPlusConnectorService;
  let httpService: { request: jest.Mock };

  beforeEach(async () => {
    httpService = { request: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConsultantPlusConnectorService,
        { provide: HttpService, useValue: httpService },
      ],
    }).compile();

    service = module.get<ConsultantPlusConnectorService>(
      ConsultantPlusConnectorService,
    );
  });

  function config() {
    return {
      baseUrl: 'https://login.consultant.ru',
      login: '1393020',
      password: operatorCredential,
    };
  }

  function mockSuccessfulLogin() {
    httpService.request
      .mockReturnValueOnce(
        of({
          data: '<input type="hidden" name="client_csrf" value="csrf-1">',
          headers: { 'set-cookie': ['sid=session-1; Path=/'] },
        }),
      )
      .mockReturnValueOnce(
        of({
          data: { authStatus: 'started', pid: 'pid-1' },
          headers: { 'set-cookie': ['auth=session-2; Path=/'] },
        }),
      )
      .mockReturnValueOnce(
        of({
          data: { authStatus: 'successful', newCsrfToken: 'csrf-2' },
          headers: {},
        }),
      );
  }

  describe('capabilities', () => {
    it('should report only configured ConsultantPlus writes as partial', () => {
      const capabilities = service.getCapabilities();

      expect([...capabilities.operations].sort()).toEqual(
        [...AVANPOST_OPERATION_VALUES].sort(),
      );
      expect(capabilities.capabilities.supportsRead).toBe(false);
      expect(capabilities.capabilities.supportsWrite).toBe(true);
      expect(capabilities.capabilities.supportsSync).toBe(false);
      expect(capabilities.capabilities.supportsSchema).toBe(true);
      expect(capabilities.operationStatus['system.test']).toEqual(
        expect.objectContaining({ status: 'partial' }),
      );
      expect(capabilities.operationStatus['schema.get']).toEqual(
        expect.objectContaining({ status: 'partial' }),
      );
      expect(capabilities.operationStatus['user.create']).toEqual(
        expect.objectContaining({ status: 'partial' }),
      );
      expect(capabilities.operationStatus['user.update']).toEqual(
        expect.objectContaining({ status: 'partial' }),
      );
      expect(capabilities.operationStatus['user.delete']).toEqual(
        expect.objectContaining({ status: 'partial' }),
      );
      expect(capabilities.operationStatus['user.changePassword']).toEqual(
        expect.objectContaining({ status: 'partial' }),
      );
      expect(capabilities.operationStatus['user.disable']).toEqual(
        expect.objectContaining({ status: 'partial' }),
      );
      expect(capabilities.operationStatus['user.lock']).toEqual(
        expect.objectContaining({ status: 'partial' }),
      );
      expect(capabilities.operationStatus['user.search']).toEqual(
        expect.objectContaining({ status: 'unsupported' }),
      );
    });
  });

  describe('execute', () => {
    it('should return local schema without calling ConsultantPlus', async () => {
      const result = await service.execute({
        operation: 'schema.get',
        targetSystem: 'consultant-test',
        payload: { config: config() },
      });

      expect(result.success).toBe(true);
      const schema = result.data as {
        observedEndpoints: Array<{ path: string }>;
      };
      expect(schema.observedEndpoints).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: '/login/' })]),
      );
      expect(httpService.request).not.toHaveBeenCalled();
    });

    it('should reject unsupported user operations without HTTP calls', async () => {
      const result = await service.execute({
        operation: 'user.search',
        targetSystem: 'consultant-test',
        payload: {
          config: config(),
          data: { username: 'idmmw-test-user' },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported ConsultantPlus operation');
      expect(httpService.request).not.toHaveBeenCalled();
    });

    it('should reject user.create without configured endpoint before HTTP calls', async () => {
      const result = await service.execute({
        operation: 'user.create',
        targetSystem: 'consultant-test',
        payload: {
          config: config(),
          data: { username: 'idmmw-test-user' },
        },
      });

      expect(result).toEqual({
        success: false,
        error: 'Missing ConsultantPlus config (userCreatePath)',
      });
      expect(httpService.request).not.toHaveBeenCalled();
    });

    it('should create a user through an explicitly configured endpoint', async () => {
      mockSuccessfulLogin();
      httpService.request.mockReturnValueOnce(
        of({
          status: 201,
          data: { id: 'u-1', sessionToken: 'sensitive-session-token' },
          headers: {},
        }),
      );

      const result = await service.execute({
        operation: 'user.create',
        targetSystem: 'consultant-test',
        payload: {
          config: {
            ...config(),
            userCreatePath: '/api/users',
            userCreatePayload: {
              login: '${username}',
              mail: '${email}',
              displayName: '${lastName} ${firstName}',
            },
          },
          data: {
            username: 'lyapin@gkm.ru',
            email: 'lyapin@gkm.ru',
            lastName: 'Ляпин',
            firstName: 'Игорь',
          },
        },
      });

      expect(result).toEqual({
        success: true,
        data: {
          status: 201,
          managedLogin: '1393020#lyapin',
          email: 'lyapin@gkm.ru',
          passwordAction: 'create',
          passwordDelivery: 'email',
          passwordKnown: false,
        },
      });
      const calls = httpService.request.mock.calls as ConsultantRequestCall[];
      expect(calls.map((call) => [call[0].method, call[0].url])).toEqual([
        ['GET', 'https://login.consultant.ru/'],
        ['POST', 'https://login.consultant.ru/login/'],
        ['GET', 'https://login.consultant.ru/auth/?pid=pid-1'],
        ['POST', 'https://login.consultant.ru/api/users'],
      ]);
      expect(calls[3][0].headers).toMatchObject({
        Cookie: 'sid=session-1; auth=session-2',
        'X-CSRF-Token': 'csrf-2',
      });
      expect(calls[3][0].data).toEqual({
        login: 'lyapin@gkm.ru',
        mail: 'lyapin@gkm.ru',
        displayName: 'Ляпин Игорь',
      });
    });

    it('should create a ConsultantPlus cloud user with form payload', async () => {
      mockSuccessfulLogin();
      httpService.request.mockReturnValueOnce(
        of({
          status: 200,
          data: '<?xml version="1.0"?><ok/>',
          headers: {},
        }),
      );

      const result = await service.execute({
        operation: 'user.create',
        targetSystem: 'consultant-test',
        payload: {
          config: {
            ...config(),
            apiBaseUrl: 'https://cloud.consultant.ru',
            userCreatePath: '/cloud/cgi/online.cgi?',
            userCreateContentType: 'form',
            userCreatePayload: {
              req: 'admin',
              op: 'admadd',
              rnd: '${rnd}',
              login: '${pureLogin}',
              email: '${email}',
              fio: '${fullName}',
            },
          },
          data: {
            username: 'lyapin@gkm.ru',
            email: 'lyapin@gkm.ru',
            lastName: 'Ляпин',
            firstName: 'Игорь',
            middleName: 'Алексеевич',
            rnd: 'rnd-create',
          },
        },
      });

      expect(result.success).toBe(true);
      const calls = httpService.request.mock.calls as ConsultantRequestCall[];
      expect(calls[3][0]).toMatchObject({
        method: 'POST',
        url: 'https://cloud.consultant.ru/cloud/cgi/online.cgi?',
      });
      expect(calls[3][0].headers).toMatchObject({
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      });
      expect(calls[3][0].data).toBe(
        'req=admin&op=admadd&rnd=rnd-create&login=lyapin&email=lyapin%40gkm.ru&fio=%D0%98%D0%B3%D0%BE%D1%80%D1%8C+%D0%90%D0%BB%D0%B5%D0%BA%D1%81%D0%B5%D0%B5%D0%B2%D0%B8%D1%87+%D0%9B%D1%8F%D0%BF%D0%B8%D0%BD',
      );
      expect(result.data).toEqual(
        expect.objectContaining({
          managedLogin: '1393020#lyapin',
          email: 'lyapin@gkm.ru',
          passwordAction: 'create',
          passwordDelivery: 'email',
          passwordKnown: false,
        }),
      );
    });

    it('should block a user through a configured path template', async () => {
      mockSuccessfulLogin();
      httpService.request.mockReturnValueOnce(
        of({ status: 204, data: '', headers: {} }),
      );

      const result = await service.execute({
        operation: 'user.disable',
        targetSystem: 'consultant-test',
        payload: {
          config: {
            ...config(),
            userBlockPath: '/api/users/{id}/block',
            userBlockMethod: 'PATCH',
            userBlockPayload: { blocked: true },
          },
          params: { id: 'user-1' },
        },
      });

      expect(result).toEqual({
        success: true,
        data: { status: 204 },
      });
      const calls = httpService.request.mock.calls as ConsultantRequestCall[];
      expect(calls[3][0]).toMatchObject({
        method: 'PATCH',
        url: 'https://login.consultant.ru/api/users/user-1/block',
        data: { blocked: true },
      });
    });

    it('should block a ConsultantPlus cloud user with managed login form payload', async () => {
      mockSuccessfulLogin();
      httpService.request.mockReturnValueOnce(
        of({
          status: 200,
          data: '<?xml version="1.0"?><ok/>',
          headers: {},
        }),
      );

      const result = await service.execute({
        operation: 'user.disable',
        targetSystem: 'consultant-test',
        payload: {
          config: {
            ...config(),
            apiBaseUrl: 'https://cloud.consultant.ru',
            managedLoginPrefix: '1393020',
            userBlockPath: '/cloud/cgi/online.cgi?',
            userBlockContentType: 'form',
            userBlockPayload: {
              req: 'admin',
              op: 'admdismiss',
              rnd: '${rnd}',
              logins: '${managedLogin}',
            },
          },
          params: { email: 'lyapin@gkm.ru', rnd: 'rnd-block' },
        },
      });

      expect(result.success).toBe(true);
      const calls = httpService.request.mock.calls as ConsultantRequestCall[];
      expect(calls[3][0]).toMatchObject({
        method: 'POST',
        url: 'https://cloud.consultant.ru/cloud/cgi/online.cgi?',
      });
      expect(calls[3][0].headers).toMatchObject({
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      });
      expect(calls[3][0].data).toBe(
        'req=admin&op=admdismiss&rnd=rnd-block&logins=1393020%23lyapin',
      );
    });

    it('should update a ConsultantPlus cloud user with form payload', async () => {
      mockSuccessfulLogin();
      httpService.request.mockReturnValueOnce(
        of({
          status: 200,
          data: '<?xml version="1.0"?><ok/>',
          headers: {},
        }),
      );

      const result = await service.execute({
        operation: 'user.update',
        targetSystem: 'consultant-test',
        payload: {
          config: {
            ...config(),
            apiBaseUrl: 'https://cloud.consultant.ru',
            userUpdatePath: '/cloud/cgi/online.cgi?',
            userUpdateContentType: 'form',
            userUpdatePayload: {
              req: 'admin',
              op: 'admupd',
              rnd: '${rnd}',
              login: '${managedLogin}',
              email: '${email}',
              fio: '${fullName}',
            },
          },
          data: {
            username: 'mwtd123@gkm.ru',
            email: 'mwtd123-updated@gkm.ru',
            lastName: 'Testov',
            firstName: 'Updated',
            rnd: 'rnd-update',
          },
        },
      });

      expect(result.success).toBe(true);
      const calls = httpService.request.mock.calls as ConsultantRequestCall[];
      expect(calls[3][0]).toMatchObject({
        method: 'POST',
        url: 'https://cloud.consultant.ru/cloud/cgi/online.cgi?',
      });
      expect(calls[3][0].data).toBe(
        'req=admin&op=admupd&rnd=rnd-update&login=1393020%23mwtd123&email=mwtd123-updated%40gkm.ru&fio=Updated+Testov',
      );
    });

    it('should request a ConsultantPlus cloud password reset through admupd', async () => {
      mockSuccessfulLogin();
      httpService.request.mockReturnValueOnce(
        of({
          status: 200,
          data: '<?xml version="1.0"?><ok/>',
          headers: {},
        }),
      );

      const result = await service.execute({
        operation: 'user.changePassword',
        targetSystem: 'consultant-test',
        payload: {
          config: {
            ...config(),
            apiBaseUrl: 'https://cloud.consultant.ru',
            userChangePasswordPath: '/cloud/cgi/online.cgi?',
            userChangePasswordContentType: 'form',
            userChangePasswordPayload: {
              req: 'admin',
              op: 'admupd',
              rnd: '${rnd}',
              login: '${managedLogin}',
              email: '${email}',
              fio: '${fullName}',
            },
          },
          params: { username: 'mwtd123@gkm.ru' },
          data: {
            email: 'mwtd123@gkm.ru',
            firstName: 'Password',
            lastName: 'Changed',
            rnd: generatedCredential,
          },
        },
      });

      expect(result.success).toBe(true);
      const calls = httpService.request.mock.calls as ConsultantRequestCall[];
      expect(calls[3][0]).toMatchObject({
        method: 'POST',
        url: 'https://cloud.consultant.ru/cloud/cgi/online.cgi?',
      });
      expect(calls[3][0].data).toBe(
        `req=admin&op=admupd&rnd=${generatedCredential}&login=1393020%23mwtd123&email=mwtd123%40gkm.ru&fio=Password+Changed`,
      );
      expect(result.data).toEqual(
        expect.objectContaining({
          managedLogin: '1393020#mwtd123',
          email: 'mwtd123@gkm.ru',
          passwordAction: 'reset',
          passwordDelivery: 'email',
          passwordKnown: false,
        }),
      );
    });

    it('should request ConsultantPlus password reset without a supplied password', async () => {
      mockSuccessfulLogin();
      httpService.request.mockReturnValueOnce(
        of({
          status: 200,
          data: '<?xml version="1.0"?><ok/>',
          headers: {},
        }),
      );

      const result = await service.execute({
        operation: 'user.changePassword',
        targetSystem: 'consultant-test',
        payload: {
          config: {
            ...config(),
            userChangePasswordPath: '/cloud/cgi/online.cgi?',
            userChangePasswordContentType: 'form',
          },
          params: {
            username: 'mwtd123@gkm.ru',
            email: 'mwtd123@gkm.ru',
            rnd: 'rnd-reset',
          },
        },
      });

      expect(result.success).toBe(true);
      const calls = httpService.request.mock.calls as ConsultantRequestCall[];
      expect(calls[3][0].data).toBe(
        'login=1393020%23mwtd123&email=mwtd123%40gkm.ru&fio=',
      );
      expect(result.data).toEqual(
        expect.objectContaining({
          managedLogin: '1393020#mwtd123',
          email: 'mwtd123@gkm.ru',
          passwordAction: 'reset',
          passwordDelivery: 'email',
          passwordKnown: false,
        }),
      );
    });

    it('should reject caller-provided passwords for ConsultantPlus reset', async () => {
      const result = await service.execute({
        operation: 'user.changePassword',
        targetSystem: 'consultant-test',
        payload: {
          config: {
            ...config(),
            userChangePasswordPath: '/cloud/cgi/online.cgi?',
          },
          params: { username: 'mwtd123@gkm.ru', email: 'mwtd123@gkm.ru' },
          data: { newValue: operatorCredential },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain(
        'does not accept caller-provided password',
      );
      expect(httpService.request).not.toHaveBeenCalled();
    });

    it('should reject configured payload templates that reference passwords', async () => {
      const result = await service.execute({
        operation: 'user.create',
        targetSystem: 'consultant-test',
        payload: {
          config: {
            ...config(),
            userCreatePath: '/cloud/cgi/online.cgi?',
            userCreatePayload: {
              login: '${pureLogin}',
              email: '${email}',
              password: '${password}',
            },
          },
          data: { username: 'mwtd123@gkm.ru', email: 'mwtd123@gkm.ru' },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain(
        'does not accept caller-provided password',
      );
      expect(httpService.request).not.toHaveBeenCalled();
    });

    it('should delete a ConsultantPlus cloud user with managed login form payload', async () => {
      mockSuccessfulLogin();
      httpService.request.mockReturnValueOnce(
        of({
          status: 200,
          data: '<?xml version="1.0"?><ok/>',
          headers: {},
        }),
      );

      const result = await service.execute({
        operation: 'user.delete',
        targetSystem: 'consultant-test',
        payload: {
          config: {
            ...config(),
            apiBaseUrl: 'https://cloud.consultant.ru',
            managedLoginPrefix: '1393020',
            userDeletePath: '/cloud/cgi/online.cgi?',
            userDeleteContentType: 'form',
            userDeletePayload: {
              req: 'admin',
              op: 'admdel',
              rnd: '${rnd}',
              logins: '${managedLogin}',
            },
          },
          params: { username: 'mwtd123@gkm.ru', rnd: 'rnd-delete' },
        },
      });

      expect(result.success).toBe(true);
      const calls = httpService.request.mock.calls as ConsultantRequestCall[];
      expect(calls[3][0]).toMatchObject({
        method: 'POST',
        url: 'https://cloud.consultant.ru/cloud/cgi/online.cgi?',
      });
      expect(calls[3][0].data).toBe(
        'req=admin&op=admdel&rnd=rnd-delete&logins=1393020%23mwtd123',
      );
    });

    it('should use login and password from configured env names', async () => {
      const originalLogin = process.env['CONSULTANT_TEST_LOGIN'];
      const originalPassword = process.env['CONSULTANT_TEST_PASSWORD'];
      process.env['CONSULTANT_TEST_LOGIN'] = '1393020';
      process.env['CONSULTANT_TEST_PASSWORD'] = operatorCredential;
      try {
        mockSuccessfulLogin();
        httpService.request.mockReturnValueOnce(
          of({
            status: 200,
            data: '<?xml version="1.0"?><ok/>',
            headers: {},
          }),
        );

        const result = await service.execute({
          operation: 'user.create',
          targetSystem: 'consultant-test',
          payload: {
            config: {
              baseUrl: 'https://login.consultant.ru',
              loginEnv: 'CONSULTANT_TEST_LOGIN',
              passwordEnv: 'CONSULTANT_TEST_PASSWORD',
              userCreatePath: '/cloud/cgi/online.cgi?',
            },
            data: { username: 'mwtd123@gkm.ru', email: 'mwtd123@gkm.ru' },
          },
        });

        expect(result.success).toBe(true);
      } finally {
        if (originalLogin === undefined) {
          delete process.env['CONSULTANT_TEST_LOGIN'];
        } else {
          process.env['CONSULTANT_TEST_LOGIN'] = originalLogin;
        }
        if (originalPassword === undefined) {
          delete process.env['CONSULTANT_TEST_PASSWORD'];
        } else {
          process.env['CONSULTANT_TEST_PASSWORD'] = originalPassword;
        }
      }
    });

    it('should follow ConsultantPlus auth return URL before cloud admin calls', async () => {
      httpService.request
        .mockReturnValueOnce(
          of({
            data: '<input type="hidden" name="client_csrf" value="csrf-1">',
            headers: { 'set-cookie': ['sid=session-1; Path=/'] },
          }),
        )
        .mockReturnValueOnce(
          of({ data: { authStatus: 'started', pid: 'pid-1' }, headers: {} }),
        )
        .mockReturnValueOnce(
          of({
            status: 302,
            data: '',
            headers: {
              location:
                'https://cloud.consultant.ru/cloud/cgi/online.cgi?req=auth&op=tokenauth&token=token-1',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: '',
            headers: { 'set-cookie': ['cloud=cloud-session; Path=/'] },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: '<?xml version="1.0"?><ok/>',
            headers: {},
          }),
        );

      const result = await service.execute({
        operation: 'user.disable',
        targetSystem: 'consultant-test',
        payload: {
          config: {
            ...config(),
            apiBaseUrl: 'https://cloud.consultant.ru',
            userBlockPath: '/cloud/cgi/online.cgi?',
            userBlockContentType: 'form',
            userBlockPayload: {
              req: 'admin',
              op: 'admdismiss',
              rnd: '${rnd}',
              logins: '${managedLogin}',
            },
          },
          params: { pureLogin: 'lyapin', rnd: 'rnd-auth-return' },
        },
      });

      expect(result.success).toBe(true);
      const calls = httpService.request.mock.calls as ConsultantRequestCall[];
      expect(calls.map((call) => [call[0].method, call[0].url])).toEqual([
        ['GET', 'https://login.consultant.ru/'],
        ['POST', 'https://login.consultant.ru/login/'],
        ['GET', 'https://login.consultant.ru/auth/?pid=pid-1'],
        [
          'GET',
          'https://cloud.consultant.ru/cloud/cgi/online.cgi?req=auth&op=tokenauth&token=token-1',
        ],
        ['POST', 'https://cloud.consultant.ru/cloud/cgi/online.cgi?'],
      ]);
      expect(calls[4][0].headers).toMatchObject({
        Cookie: 'sid=session-1; cloud=cloud-session',
      });
    });

    it('should reject block path templates with missing identifiers before HTTP calls', async () => {
      const result = await service.execute({
        operation: 'user.lock',
        targetSystem: 'consultant-test',
        payload: {
          config: {
            ...config(),
            userBlockPath: '/api/users/{id}/block',
          },
          params: { email: 'lyapin@gkm.ru' },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain(
        'Missing ConsultantPlus path parameter(s)',
      );
      expect(httpService.request).not.toHaveBeenCalled();
    });

    it('should refuse mutating operations that target protected operator login', async () => {
      const result = await service.execute({
        operation: 'user.disable',
        targetSystem: 'consultant-test',
        payload: {
          config: config(),
          params: { username: '1393020' },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Refusing to operate on protected');
      expect(httpService.request).not.toHaveBeenCalled();
    });

    it('should refuse protected operator aliases before template rendering', async () => {
      const result = await service.execute({
        operation: 'user.create',
        targetSystem: 'consultant-test',
        payload: {
          config: {
            ...config(),
            userCreatePath: '/cloud/cgi/online.cgi?',
            userCreateContentType: 'form',
          },
          data: { pureLogin: '1393020', email: 'operator@example.test' },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Refusing to operate on protected');
      expect(httpService.request).not.toHaveBeenCalled();
    });

    it('should reject absolute configured endpoint paths before HTTP calls', async () => {
      const result = await service.execute({
        operation: 'user.create',
        targetSystem: 'consultant-test',
        payload: {
          config: {
            ...config(),
            userCreatePath: 'https://cloud.consultant.ru/cloud/cgi/online.cgi?',
          },
          data: { username: 'mwtd123@gkm.ru', email: 'mwtd123@gkm.ru' },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('endpoint path must be relative');
      expect(httpService.request).not.toHaveBeenCalled();
    });

    it('should reject disallowed ConsultantPlus API hosts before HTTP calls', async () => {
      const result = await service.execute({
        operation: 'user.create',
        targetSystem: 'consultant-test',
        payload: {
          config: {
            ...config(),
            apiBaseUrl: 'https://evil.example.test',
            userCreatePath: '/api/users',
          },
          data: { username: 'mwtd123@gkm.ru', email: 'mwtd123@gkm.ru' },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('host is not allowed');
      expect(httpService.request).not.toHaveBeenCalled();
    });

    it('should treat HTTP 200 ConsultantPlus application errors as failures', async () => {
      mockSuccessfulLogin();
      httpService.request.mockReturnValueOnce(
        of({
          status: 200,
          data: '<?xml version="1.0"?><errdata>wrong_account_data</errdata>',
          headers: {},
        }),
      );

      const result = await service.execute({
        operation: 'user.disable',
        targetSystem: 'consultant-test',
        payload: {
          config: {
            ...config(),
            userBlockPath: '/cloud/cgi/online.cgi?',
            userBlockContentType: 'form',
          },
          params: { username: 'mwtd123@gkm.ru', email: 'mwtd123@gkm.ru' },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('application error');
    });

    it('should reject auth redirects to non-allowed hosts before cloud calls', async () => {
      httpService.request
        .mockReturnValueOnce(
          of({
            data: '<input type="hidden" name="client_csrf" value="csrf-1">',
            headers: { 'set-cookie': ['sid=session-1; Path=/'] },
          }),
        )
        .mockReturnValueOnce(
          of({ data: { authStatus: 'started', pid: 'pid-1' }, headers: {} }),
        )
        .mockReturnValueOnce(
          of({
            status: 302,
            data: '',
            headers: { location: 'https://evil.example.test/token' },
          }),
        );

      const result = await service.execute({
        operation: 'user.disable',
        targetSystem: 'consultant-test',
        payload: {
          config: {
            ...config(),
            userBlockPath: '/cloud/cgi/online.cgi?',
            userBlockContentType: 'form',
          },
          params: { username: 'mwtd123@gkm.ru', email: 'mwtd123@gkm.ru' },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('host is not allowed');
      expect(httpService.request).toHaveBeenCalledTimes(3);
    });

    it('should report missing config errors', async () => {
      await expect(
        service.execute({
          operation: 'system.test',
          targetSystem: 'consultant-test',
          payload: {},
        }),
      ).resolves.toEqual({
        success: false,
        error: 'Missing ConsultantPlus config (baseUrl)',
      });
    });
  });

  describe('testConnection', () => {
    it('should check login page reachability without credentials', async () => {
      httpService.request.mockReturnValueOnce(
        of({
          data: '<input type="hidden" name="client_csrf" value="csrf-1">',
          headers: {},
        }),
      );

      const result = await service.testConnection({
        baseUrl: 'https://login.consultant.ru',
      });

      expect(result).toEqual({
        success: true,
        message: 'ConsultantPlus login page reachable',
      });
      const calls = httpService.request.mock.calls as ConsultantRequestCall[];
      expect(calls[0][0]).toMatchObject({
        url: 'https://login.consultant.ru/',
        method: 'GET',
      });
    });

    it('should run async login status flow and report backend auth failure', async () => {
      httpService.request
        .mockReturnValueOnce(
          of({
            data: '<input type="hidden" name="client_csrf" value="csrf-1">',
            headers: { 'set-cookie': ['sid=session-1; Path=/'] },
          }),
        )
        .mockReturnValueOnce(
          of({ data: { authStatus: 'started', pid: 'pid-1' } }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              authStatus: 'fault',
              error: { code: 'WRONG_PASSWORD' },
            },
          }),
        );

      const result = await service.testConnection(config());

      expect(result).toEqual({
        success: false,
        message: 'ConsultantPlus login failed: WRONG_PASSWORD',
      });
      const calls = httpService.request.mock.calls as ConsultantRequestCall[];
      expect(calls.map((call) => [call[0].method, call[0].url])).toEqual([
        ['GET', 'https://login.consultant.ru/'],
        ['POST', 'https://login.consultant.ru/login/'],
        ['GET', 'https://login.consultant.ru/auth/?pid=pid-1'],
      ]);
      expect(calls[1][0].headers).toMatchObject({
        Cookie: 'sid=session-1',
        'X-CSRF-Token': 'csrf-1',
      });
    });

    it('should reject unexpected auth status responses', async () => {
      httpService.request
        .mockReturnValueOnce(
          of({
            data: '<input type="hidden" name="client_csrf" value="csrf-1">',
            headers: { 'set-cookie': ['sid=session-1; Path=/'] },
          }),
        )
        .mockReturnValueOnce(
          of({ data: { authStatus: 'started', pid: 'pid-1' } }),
        )
        .mockReturnValueOnce(
          of({
            data: '<html>unexpected login body</html>',
            headers: {},
          }),
        );

      const result = await service.testConnection(config());

      expect(result).toEqual({
        success: false,
        message: 'ConsultantPlus login failed: UNEXPECTED_AUTH_RESPONSE',
      });
    });

    it('should redact configured secrets from returned errors', async () => {
      httpService.request.mockReturnValueOnce(
        throwError(() => new Error(`failed with ${operatorCredential}`)),
      );

      const result = await service.testConnection(config());

      expect(result.success).toBe(false);
      expect(result.message).toContain('[REDACTED]');
      expect(result.message).not.toContain(operatorCredential);
    });
  });
});
