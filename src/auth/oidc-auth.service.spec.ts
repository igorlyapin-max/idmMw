import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { OidcAuthService } from './oidc-auth.service';
import type { AuthService } from './auth.service';
import type { DiagnosticLoggerService } from '../diagnostics/diagnostic-logger.service';

function config(): ConfigService {
  const values: Record<string, unknown> = {
    ADMIN_AUTH_SESSION_SECRET: 'session-secret',
    ADMIN_AUTH_COOKIE_SECURE: false,
    NODE_ENV: 'test',
    HTTP_TLS_ENABLED: false,
    ADMIN_AUTH_OIDC_REDIRECT_URI:
      'https://idmmw.example.test/auth/oidc/callback',
  };
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

describe('OidcAuthService', () => {
  it('rejects callback without the signed OIDC state cookie', async () => {
    const service = new OidcAuthService(
      config(),
      { isSsoProviderEnabled: () => true } as unknown as AuthService,
      {
        basic: jest.fn(),
        verbose: jest.fn(),
      } as unknown as DiagnosticLoggerService,
    );

    await expect(
      service.completeCallback(
        {
          headers: {},
          originalUrl: '/auth/oidc/callback?code=abc&state=state',
        } as unknown as Request,
        { append: jest.fn() } as unknown as Response,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
