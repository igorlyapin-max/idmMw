import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Server } from 'http';

const originalAdminAuthEnabled = process.env['ADMIN_AUTH_ENABLED'];
const originalAdminAuthMode = process.env['ADMIN_AUTH_MODE'];
const originalAdminAuthUsername = process.env['ADMIN_AUTH_LOCAL_USERNAME'];
const originalAdminAuthPassword = process.env['ADMIN_AUTH_LOCAL_PASSWORD'];
const originalAdminAuthSessionSecret = process.env['ADMIN_AUTH_SESSION_SECRET'];

process.env['ADMIN_AUTH_ENABLED'] = 'true';
process.env['ADMIN_AUTH_MODE'] = 'local';
process.env['ADMIN_AUTH_LOCAL_USERNAME'] = 'admin-runtime-test';
process.env['ADMIN_AUTH_LOCAL_PASSWORD'] = 'admin-runtime-password';
process.env['ADMIN_AUTH_SESSION_SECRET'] = 'admin-runtime-session-secret';

const { AppModule } =
  jest.requireActual<typeof import('../src/app.module')>('../src/app.module');
const { PrismaService } = jest.requireActual<
  typeof import('../src/database/prisma.service')
>('../src/database/prisma.service');

interface LoginResponseBody {
  csrfToken: string;
}

interface RuntimeDebugResponseBody {
  id: string;
}

describe('Admin runtime diagnostics auth (e2e)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        $connect: jest.fn(),
        $disconnect: jest.fn(),
        targetSystem: {
          findMany: jest.fn().mockResolvedValue([]),
          count: jest.fn().mockResolvedValue(0),
          aggregate: jest.fn().mockResolvedValue({ _max: { updatedAt: null } }),
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    server = getHttpServer(app);
  });

  afterAll(async () => {
    await app.close();
    restoreEnv('ADMIN_AUTH_ENABLED', originalAdminAuthEnabled);
    restoreEnv('ADMIN_AUTH_MODE', originalAdminAuthMode);
    restoreEnv('ADMIN_AUTH_LOCAL_USERNAME', originalAdminAuthUsername);
    restoreEnv('ADMIN_AUTH_LOCAL_PASSWORD', originalAdminAuthPassword);
    restoreEnv('ADMIN_AUTH_SESSION_SECRET', originalAdminAuthSessionSecret);
  });

  it('requires admin session and CSRF for runtime debug mutations', async () => {
    await request(server).get('/admin/runtime/logs').expect(401);

    await request(server)
      .post('/admin/runtime/debug')
      .send({ targetSystem: 'CMDB', level: 'Verbose', ttlSeconds: 300 })
      .expect(401);

    const login = await request(server)
      .post('/auth/login')
      .send({
        username: 'admin-runtime-test',
        password: 'admin-runtime-password',
      })
      .expect(201);
    const cookies = login.headers['set-cookie'] as string[];
    const csrfToken = (login.body as LoginResponseBody).csrfToken;

    await request(server)
      .get('/admin/runtime/logs')
      .set('Cookie', cookies)
      .expect(200);

    await request(server)
      .post('/admin/runtime/debug')
      .set('Cookie', cookies)
      .send({ targetSystem: 'CMDB', level: 'Verbose', ttlSeconds: 300 })
      .expect(403);

    const enable = await request(server)
      .post('/admin/runtime/debug')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .send({ targetSystem: 'CMDB', level: 'Verbose', ttlSeconds: 300 })
      .expect(201);
    const debugSessionId = (enable.body as RuntimeDebugResponseBody).id;

    await request(server)
      .delete(`/admin/runtime/debug/${debugSessionId}`)
      .set('Cookie', cookies)
      .expect(403);

    await request(server)
      .delete(`/admin/runtime/debug/${debugSessionId}`)
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .expect(200);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function getHttpServer(
  application: INestApplication,
): Parameters<typeof request>[0] {
  const server = application.getHttpServer() as unknown;
  if (server instanceof Server) {
    return server;
  }
  throw new TypeError('Nest application did not return an HTTP Server');
}
