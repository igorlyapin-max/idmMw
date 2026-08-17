import { EncryptionService } from './encryption.service';

const keyA = Buffer.alloc(32, 1).toString('base64');
const keyB = Buffer.alloc(32, 2).toString('base64');
const storedCredential = ['stored', 'credential'].join('-');

describe('EncryptionService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env['ENCRYPTION_ENABLED'];
    delete process.env['ENCRYPTION_ACTIVE_KEY_ID'];
    delete process.env['ENCRYPTION_KEYS'];
    delete process.env['ENCRYPTION_KEY_KEY_A'];
    delete process.env['ENCRYPTION_KEY_KEY_B'];
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('encrypts and decrypts storage envelopes with active key', () => {
    process.env['ENCRYPTION_ENABLED'] = 'true';
    process.env['ENCRYPTION_ACTIVE_KEY_ID'] = 'key_a';
    process.env['ENCRYPTION_KEYS'] = 'key_a';
    process.env['ENCRYPTION_KEY_KEY_A'] = keyA;

    const service = new EncryptionService();
    const encrypted = service.encryptForStorage({ password: storedCredential });

    expect(service.isEnvelope(encrypted)).toBe(true);
    expect(service.decryptFromStorage(encrypted)).toEqual({
      password: storedCredential,
    });
  });

  it('decrypts old key ids from keyring and encrypts only with active key', () => {
    process.env['ENCRYPTION_ENABLED'] = 'true';
    process.env['ENCRYPTION_ACTIVE_KEY_ID'] = 'key_a';
    process.env['ENCRYPTION_KEYS'] = 'key_a,key_b';
    process.env['ENCRYPTION_KEY_KEY_A'] = keyA;
    process.env['ENCRYPTION_KEY_KEY_B'] = keyB;

    const oldService = new EncryptionService();
    const oldEnvelope = oldService.encryptObject({ value: 1 });

    process.env['ENCRYPTION_ACTIVE_KEY_ID'] = 'key_b';
    const newService = new EncryptionService();
    const newEnvelope = newService.encryptObject({ value: 2 });

    expect(newService.decryptObject(oldEnvelope)).toEqual({ value: 1 });
    expect(newEnvelope.kid).toBe('key_b');
  });

  it('rejects unresolved secret references and wrong key sizes', () => {
    process.env['ENCRYPTION_ENABLED'] = 'true';
    process.env['ENCRYPTION_ACTIVE_KEY_ID'] = 'key_a';
    process.env['ENCRYPTION_KEYS'] = 'key_a';
    process.env['ENCRYPTION_KEY_KEY_A'] = 'secret://unresolved';

    expect(() => new EncryptionService().validateConfiguration()).toThrow(
      /still a secret reference/,
    );

    process.env['ENCRYPTION_KEY_KEY_A'] = Buffer.alloc(16, 1).toString(
      'base64',
    );
    expect(() => new EncryptionService().validateConfiguration()).toThrow(
      /32 bytes/,
    );
  });

  it('derives active and previous idempotency HMAC keys', () => {
    process.env['ENCRYPTION_ENABLED'] = 'true';
    process.env['ENCRYPTION_ACTIVE_KEY_ID'] = 'key_b';
    process.env['ENCRYPTION_KEYS'] = 'key_a,key_b';
    process.env['ENCRYPTION_KEY_KEY_A'] = keyA;
    process.env['ENCRYPTION_KEY_KEY_B'] = keyB;

    const keys = new EncryptionService().idempotencyKeys('event-1');

    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^idmmw:hmac:key_b:/);
    expect(keys[1]).toMatch(/^idmmw:hmac:key_a:/);
  });
});
