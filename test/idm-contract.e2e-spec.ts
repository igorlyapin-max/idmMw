import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import {
  AVANPOST_OPERATION_VALUES,
  READ_OPERATIONS,
} from '../src/inbound/webhooks/avanpost-operation.enum';
import type { WebhookResponse } from '../src/inbound/webhooks/webhook.controller';

const originalMockIdmEnabled = process.env['MOCK_IDM_ENABLED'];
const originalMockIdmMiddlewareUrl = process.env['MOCK_IDM_MIDDLEWARE_URL'];
process.env['MOCK_IDM_ENABLED'] = 'true';

const { AppModule } =
  jest.requireActual<typeof import('../src/app.module')>('../src/app.module');

function setMockIdmMiddlewareUrl(app: INestApplication): void {
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') {
    throw new Error('Test app must listen on a TCP port');
  }
  process.env['MOCK_IDM_MIDDLEWARE_URL'] = `http://127.0.0.1:${address.port}`;
}

describe('IDM Contract (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.listen(0, '127.0.0.1');
    setMockIdmMiddlewareUrl(app);
  });

  afterAll(async () => {
    await app.close();
    if (originalMockIdmEnabled === undefined) {
      delete process.env['MOCK_IDM_ENABLED'];
    } else {
      process.env['MOCK_IDM_ENABLED'] = originalMockIdmEnabled;
    }
    if (originalMockIdmMiddlewareUrl === undefined) {
      delete process.env['MOCK_IDM_MIDDLEWARE_URL'];
    } else {
      process.env['MOCK_IDM_MIDDLEWARE_URL'] = originalMockIdmMiddlewareUrl;
    }
  });

  describe('operation validation', () => {
    it('should reject unknown operations', async () => {
      const res = await request(app.getHttpServer())
        .post('/webhooks/avanpost')
        .send({
          eventId: 'e-unknown',
          operation: 'unknown.operation',
          targetSystem: 'fake',
          payload: {},
        })
        .expect(400);

      const body = res.body as { message?: string[] };
      expect(body.message).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            'operation must be one of the following values',
          ),
        ]),
      );
    });

    it('should reject empty routing and idempotency keys', async () => {
      await request(app.getHttpServer())
        .post('/webhooks/avanpost')
        .send({
          eventId: '   ',
          operation: 'user.create',
          targetSystem: 'fake',
          payload: {},
        })
        .expect(400);

      await request(app.getHttpServer())
        .post('/webhooks/avanpost')
        .send({
          eventId: 'e-empty-target',
          operation: 'user.create',
          targetSystem: '   ',
          payload: {},
        })
        .expect(400);
    });

    it('should reject non-object payload zones', async () => {
      await request(app.getHttpServer())
        .post('/webhooks/avanpost')
        .send({
          eventId: 'e-invalid-payload',
          operation: 'user.create',
          targetSystem: 'fake',
          payload: 'not-object',
        })
        .expect(400);

      await request(app.getHttpServer())
        .post('/webhooks/avanpost')
        .send({
          eventId: 'e-invalid-payload-data',
          operation: 'user.create',
          targetSystem: 'fake',
          payload: { data: 'not-object' },
        })
        .expect(400);
    });
  });

  describe.each(AVANPOST_OPERATION_VALUES)('operation: %s', (operation) => {
    const isRead = READ_OPERATIONS.includes(operation);

    it(`should accept and process ${operation}`, async () => {
      const eventId = `e2e-${operation.replace(/\./g, '-')}-${Date.now()}`;
      const payload: Record<string, unknown> = isRead
        ? { params: {} }
        : { data: {}, params: {} };

      const res = await request(app.getHttpServer())
        .post('/webhooks/avanpost')
        .send({
          eventId,
          operation,
          targetSystem: 'fake',
          payload,
        })
        .expect(201);

      const body = res.body as WebhookResponse;
      expect(body.received).toBe(true);
      expect(body.processed).toBe(true);

      if (isRead) {
        expect(body).toHaveProperty('data');
      } else {
        expect(body.data).toBeUndefined();
      }
    });
  });

  describe('IDM read facade', () => {
    it('should expose every synchronous read/test operation through REST routes', async () => {
      await request(app.getHttpServer()).get('/idm/fake/test').expect(200);

      const usersRes = await request(app.getHttpServer())
        .get('/idm/fake/users?filter=jdoe&limit=10')
        .expect(200);
      expect(usersRes.body).toHaveProperty('items');

      const userRes = await request(app.getHttpServer())
        .get('/idm/fake/users/user-1')
        .expect(200);
      expect(userRes.body).toHaveProperty('id', 'user-1');

      const resolvedRes = await request(app.getHttpServer())
        .get('/idm/fake/users/resolve?username=jdoe')
        .expect(200);
      expect(resolvedRes.body).toHaveProperty('uid', 'uid-jdoe');

      const groupsRes = await request(app.getHttpServer())
        .get('/idm/fake/groups?filter=Admins&limit=10')
        .expect(200);
      expect(groupsRes.body).toHaveProperty('items');

      const groupRes = await request(app.getHttpServer())
        .get('/idm/fake/groups/group-1')
        .expect(200);
      expect(groupRes.body).toHaveProperty('id', 'group-1');

      const schemaRes = await request(app.getHttpServer())
        .get('/idm/fake/schema')
        .expect(200);
      expect(schemaRes.body).toHaveProperty('objectClasses');

      const fullSyncRes = await request(app.getHttpServer())
        .post('/idm/fake/sync')
        .send({ mode: 'full' })
        .expect(201);
      expect(fullSyncRes.body).toHaveProperty('mode', 'full');

      const incrementalSyncRes = await request(app.getHttpServer())
        .post('/idm/fake/sync')
        .send({ mode: 'incremental' })
        .expect(201);
      expect(incrementalSyncRes.body).toHaveProperty('mode', 'incremental');

      await request(app.getHttpServer())
        .get('/idm/fake/users?limit=bad')
        .expect(400);

      await request(app.getHttpServer())
        .post('/idm/fake/sync')
        .send({ mode: 'partial' })
        .expect(400);
    });
  });

  describe('multi-target routing', () => {
    it('should expose enabled target systems as an IDM catalog without config', async () => {
      const suffix = Date.now();
      const enabledName = `fake-catalog-${suffix}`;
      const disabledName = `fake-catalog-disabled-${suffix}`;
      const createdIds: string[] = [];

      try {
        const enabledRes = await request(app.getHttpServer())
          .post('/admin/target-systems')
          .send({
            name: enabledName,
            type: 'fake',
            label: 'Fake catalog target',
            config: { baseUrl: 'fake://local', apiKey: 'secret-token' },
            enabled: true,
          })
          .expect(201);
        createdIds.push((enabledRes.body as { id: string }).id);

        const disabledRes = await request(app.getHttpServer())
          .post('/admin/target-systems')
          .send({
            name: disabledName,
            type: 'fake',
            label: 'Disabled catalog target',
            config: { baseUrl: 'fake://local', apiKey: 'disabled-secret' },
            enabled: false,
          })
          .expect(201);
        createdIds.push((disabledRes.body as { id: string }).id);

        const listRes = await request(app.getHttpServer())
          .get('/idm/target-systems')
          .expect(200);

        const catalog = listRes.body as Array<Record<string, unknown>>;
        const enabled = catalog.find((item) => item.name === enabledName);
        expect(enabled).toBeDefined();
        if (!enabled) {
          throw new Error('Expected enabled target system in IDM catalog');
        }
        expect(enabled).toMatchObject({
          name: enabledName,
          type: 'fake',
          label: 'Fake catalog target',
          enabled: true,
        });
        expect(enabled).not.toHaveProperty('config');
        expect(JSON.stringify(enabled)).not.toContain('secret-token');
        expect(enabled.operations).toEqual(
          expect.arrayContaining([...AVANPOST_OPERATION_VALUES]),
        );
        expect(enabled.readOperations).toEqual(
          expect.arrayContaining(['system.test', 'user.search']),
        );
        expect(enabled.writeOperations).not.toContain('system.test');
        expect(enabled.capabilities).toMatchObject({
          supportsRead: true,
          supportsWrite: true,
          supportsSchema: true,
        });
        const operationStatus = enabled.operationStatus as Record<
          string,
          unknown
        >;
        expect(operationStatus['user.create']).toBeDefined();

        expect(catalog.some((item) => item.name === disabledName)).toBe(false);

        const itemRes = await request(app.getHttpServer())
          .get(`/idm/target-systems/${enabledName}`)
          .expect(200);
        expect(itemRes.body).toMatchObject({
          name: enabledName,
          type: 'fake',
          enabled: true,
        });
        expect(itemRes.body).not.toHaveProperty('config');

        await request(app.getHttpServer())
          .get(`/idm/target-systems/${disabledName}`)
          .expect(404);
      } finally {
        for (const id of createdIds) {
          await request(app.getHttpServer()).delete(
            `/admin/target-systems/${id}`,
          );
        }
      }
    });

    it('should process independent events for different target systems', async () => {
      const suffix = Date.now();
      const targets = [`fake-a-${suffix}`, `fake-b-${suffix}`];
      const createdIds: string[] = [];

      try {
        for (const target of targets) {
          const createRes = await request(app.getHttpServer())
            .post('/admin/target-systems')
            .send({
              name: target,
              type: 'fake',
              label: target,
              config: { baseUrl: 'fake://local' },
              enabled: true,
            })
            .expect(201);
          createdIds.push((createRes.body as { id: string }).id);
        }

        for (const target of targets) {
          const res = await request(app.getHttpServer())
            .post('/webhooks/avanpost')
            .send({
              eventId: `idm-${suffix}:${target}`,
              operation: 'user.create',
              targetSystem: target,
              payload: { data: { username: target } },
            })
            .expect(201);

          const body = res.body as WebhookResponse;
          expect(body.received).toBe(true);
          expect(body.processed).toBe(true);
          expect(body.data).toBeUndefined();
        }
      } finally {
        for (const id of createdIds) {
          await request(app.getHttpServer()).delete(
            `/admin/target-systems/${id}`,
          );
        }
      }
    });

    it('should expose schema and sync for DB-backed target systems', async () => {
      const suffix = Date.now();
      const target = `fake-read-${suffix}`;
      const createdIds: string[] = [];

      try {
        const createRes = await request(app.getHttpServer())
          .post('/admin/target-systems')
          .send({
            name: target,
            type: 'fake',
            label: target,
            config: { baseUrl: 'fake://local', apiKey: 'read-secret' },
            enabled: true,
          })
          .expect(201);
        createdIds.push((createRes.body as { id: string }).id);

        const schemaRes = await request(app.getHttpServer())
          .get(`/idm/${target}/schema`)
          .expect(200);
        expect(schemaRes.body).toHaveProperty('objectClasses');
        expect(JSON.stringify(schemaRes.body)).not.toContain('read-secret');

        const syncRes = await request(app.getHttpServer())
          .post(`/idm/${target}/sync`)
          .send({ mode: 'incremental' })
          .expect(201);
        expect(syncRes.body).toHaveProperty('mode', 'incremental');
        expect(JSON.stringify(syncRes.body)).not.toContain('read-secret');
      } finally {
        for (const id of createdIds) {
          await request(app.getHttpServer()).delete(
            `/admin/target-systems/${id}`,
          );
        }
      }
    });

    it('should reject duplicate eventId for the same accepted event', async () => {
      const eventId = `duplicate-${Date.now()}`;
      const payload = {
        eventId,
        operation: 'user.create',
        targetSystem: 'fake',
        payload: { data: { username: 'duplicate-user' } },
      };

      const first = await request(app.getHttpServer())
        .post('/webhooks/avanpost')
        .send(payload)
        .expect(201);
      const second = await request(app.getHttpServer())
        .post('/webhooks/avanpost')
        .send(payload)
        .expect(201);

      expect((first.body as WebhookResponse).processed).toBe(true);
      expect((second.body as WebhookResponse).processed).toBe(false);
    });

    it('should scope duplicate eventId by targetSystem', async () => {
      const suffix = Date.now();
      const eventId = `same-business-event-${suffix}`;
      const targets = [`fake-scope-a-${suffix}`, `fake-scope-b-${suffix}`];
      const createdIds: string[] = [];

      try {
        for (const target of targets) {
          const createRes = await request(app.getHttpServer())
            .post('/admin/target-systems')
            .send({
              name: target,
              type: 'fake',
              label: target,
              config: { baseUrl: 'fake://local' },
              enabled: true,
            })
            .expect(201);
          createdIds.push((createRes.body as { id: string }).id);
        }

        for (const target of targets) {
          const res = await request(app.getHttpServer())
            .post('/webhooks/avanpost')
            .send({
              eventId,
              operation: 'user.create',
              targetSystem: target,
              payload: { data: { username: target } },
            })
            .expect(201);

          expect((res.body as WebhookResponse).processed).toBe(true);
        }
      } finally {
        for (const id of createdIds) {
          await request(app.getHttpServer()).delete(
            `/admin/target-systems/${id}`,
          );
        }
      }
    });
  });

  describe('mock-idm scenarios', () => {
    it('should expose a scenario for every supported operation', async () => {
      interface ScenarioResponse {
        success: boolean;
        event: { operation: string };
      }

      for (const operation of AVANPOST_OPERATION_VALUES) {
        const scenarioName = operation.replace(/\./g, '-');
        const res = await request(app.getHttpServer()).post(
          `/mock-idm/scenario/${scenarioName}`,
        );

        if (res.status !== 200) {
          console.error(
            `Scenario ${scenarioName} failed:`,
            res.status,
            res.body,
          );
        }

        const body = res.body as ScenarioResponse;
        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.event.operation).toBe(operation);
      }
    });
  });
});
