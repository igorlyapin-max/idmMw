import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth/auth.service';
import { EncryptionService } from '../security/encryption.service';
import { IndeedPamAapmClient } from './indeed-pam-aapm.client';
import { SecretResolverService } from './secret-resolver.service';

describe('prod profile secret resolution reachability', () => {
  const originalEnv = process.env;
  const adminCredential = ['resolved', 'admin', 'credential'].join('-');
  const sessionCredential = ['resolved', 'session', 'credential'].join('-');
  const encryptionKey = Buffer.alloc(32, 7).toString('base64');

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      SECRETS_PROVIDER: 'IndeedPamAapm',
      ADMIN_AUTH_ENABLED: 'true',
      ADMIN_AUTH_MODE: 'local',
      ADMIN_AUTH_LOCAL_USERNAME: 'admin',
      ADMIN_AUTH_LOCAL_PASSWORD: 'aapm://idmmw-admin-local-credential',
      ADMIN_AUTH_SESSION_SECRET: 'aapm://idmmw-admin-session-credential',
      ADMIN_AUTH_SESSION_TTL_SECONDS: '28800',
      ENCRYPTION_ENABLED: 'true',
      ENCRYPTION_ACTIVE_KEY_ID: 'key_2026_06',
      ENCRYPTION_KEYS: 'key_2026_06',
      ENCRYPTION_KEY_KEY_2026_06: 'aapm://idmmw-encryption-key-2026-06',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('resolves aapm references before AuthService and EncryptionService consume them', async () => {
    const pamClient = {
      getValue: jest.fn(async (refId: string) => {
        if (refId === 'idmmw-admin-local-credential') return adminCredential;
        if (refId === 'idmmw-admin-session-credential')
          return sessionCredential;
        if (refId === 'idmmw-encryption-key-2026-06') return encryptionKey;
        throw new Error(`Unexpected ref ${refId}`);
      }),
    };
    const config = {
      get: jest.fn((key: string) => process.env[key]),
    } as unknown as ConfigService;

    await new SecretResolverService(
      config,
      pamClient as unknown as IndeedPamAapmClient,
    ).resolveAll();

    const auth = new AuthService(config);
    expect(
      auth.loginLocal('admin', adminCredential, {
        setHeader: jest.fn(),
      } as never).authenticated,
    ).toBe(true);

    const encryption = new EncryptionService(config);
    expect(() => encryption.validateConfiguration()).not.toThrow();
    expect(pamClient.getValue).toHaveBeenCalledWith(
      'idmmw-admin-local-credential',
    );
    expect(pamClient.getValue).toHaveBeenCalledWith(
      'idmmw-admin-session-credential',
    );
    expect(pamClient.getValue).toHaveBeenCalledWith(
      'idmmw-encryption-key-2026-06',
    );
  });
});
