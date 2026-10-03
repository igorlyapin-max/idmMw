import type { Request, Response } from 'express';
import { AdminAuthMiddleware } from './admin-auth.middleware';
import type { AuthService } from './auth.service';

function response(): Response & {
  statusCode?: number;
  body?: unknown;
} {
  const res = {
    status: jest.fn((status: number) => {
      res.statusCode = status;
      return res;
    }),
    json: jest.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
  } as unknown as Response & { statusCode?: number; body?: unknown };
  return res;
}

describe('AdminAuthMiddleware', () => {
  it('requires CSRF for POST /auth/logout', () => {
    const session = {
      sub: 'admin',
      provider: 'local',
      groups: [],
      csrfToken: 'csrf-token',
    };
    const middleware = new AdminAuthMiddleware({
      authenticateRequest: jest.fn(() => session),
      verifyCsrf: jest.fn(() => false),
    } as unknown as AuthService);
    const res = response();
    const next = jest.fn();

    middleware.use(
      { path: '/auth/logout', method: 'POST' } as unknown as Request,
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      success: false,
      message: 'Invalid CSRF token',
    });
  });
});
