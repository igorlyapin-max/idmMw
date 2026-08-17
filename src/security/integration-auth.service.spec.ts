import type { Request } from 'express';
import { IntegrationAuthService } from './integration-auth.service';

describe('IntegrationAuthService', () => {
  const secret = ['integration', 'credential'].join('-');

  function service(): IntegrationAuthService {
    return new IntegrationAuthService({
      get: jest.fn((key: string) => {
        if (key === 'INTEGRATION_AUTH_ENABLED') return true;
        if (key === 'INTEGRATION_AUTH_SECRET') return secret;
        if (key === 'INTEGRATION_AUTH_ALLOWED_CLOCK_SKEW_SECONDS') return 300;
        if (key === 'METRICS_PUBLIC_ENABLED') return false;
        return undefined;
      }),
    } as never);
  }

  function request(body: unknown, signature: string): Request {
    return {
      method: 'POST',
      originalUrl: '/webhooks/avanpost?ignored=true',
      headers: {
        'content-length': '1',
        'x-idmmw-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-idmmw-signature': signature,
      },
      body,
    } as never;
  }

  it('accepts sha256-prefixed signature over sorted JSON body and path without query', () => {
    const auth = service();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = { z: 1, a: { b: 2 } };
    const signature = auth.signForTest({
      timestamp,
      method: 'POST',
      path: '/webhooks/avanpost',
      body,
      secret,
    });
    const req = request(body, `sha256=${signature}`);
    req.headers['x-idmmw-timestamp'] = timestamp;

    expect(auth.verify(req)).toEqual({ ok: true, status: 200, message: 'ok' });
  });

  it('rejects signatures calculated over non-canonical body order', () => {
    const auth = service();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = { z: 1, a: { b: 2 } };
    const signature = auth.signForTest({
      timestamp,
      method: 'POST',
      path: '/webhooks/avanpost',
      body: '{"z":1,"a":{"b":2}}',
      secret,
    });
    const req = request(body, signature);
    req.headers['x-idmmw-timestamp'] = timestamp;

    expect(auth.verify(req)).toEqual({
      ok: false,
      status: 401,
      message: 'Invalid integration authentication signature',
    });
  });
});
