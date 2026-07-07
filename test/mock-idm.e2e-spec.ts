import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

const originalMockIdmEnabled = process.env['MOCK_IDM_ENABLED'];
const originalMockIdmMiddlewareUrl = process.env['MOCK_IDM_MIDDLEWARE_URL'];
process.env['MOCK_IDM_ENABLED'] = 'true';

const { AppModule } =
  jest.requireActual<typeof import('../src/app.module')>('../src/app.module');

interface MockIdmResponse {
  success: boolean;
  event: {
    operation: string;
  };
}

function setMockIdmMiddlewareUrl(app: INestApplication): void {
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') {
    throw new Error('Test app must listen on a TCP port');
  }
  process.env['MOCK_IDM_MIDDLEWARE_URL'] = `http://127.0.0.1:${address.port}`;
}

describe('Mock IDM (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.listen(0, '127.0.0.1');
    setMockIdmMiddlewareUrl(app);
  });

  it('POST /mock-idm/scenario/user-create', async () => {
    const res = await request(app.getHttpServer())
      .post('/mock-idm/scenario/user-create')
      .expect(200);

    const body = res.body as MockIdmResponse;
    expect(body.success).toBe(true);
    expect(body.event.operation).toBe('user.create');
  });

  it('POST /mock-idm/scenario/duplicate — second request returns processed=false', async () => {
    const res = await request(app.getHttpServer())
      .post('/mock-idm/scenario/duplicate')
      .expect(200);

    const body = res.body as MockIdmResponse;
    expect(body.success).toBe(true);
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
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
});
