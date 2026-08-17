import { appConfigSchema } from './app.config';

describe('appConfigSchema', () => {
  const baseConfig = {
    DATABASE_URL: 'file:/tmp/idmmw-config-test.db',
  };

  it('rejects legacy PAM environment variables with migration guidance', () => {
    const result = appConfigSchema.safeParse({
      ...baseConfig,
      PAMURL: 'https://pam.example.local',
      PAMTOKEN: 'legacy-token',
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain(
      'Legacy PAM* environment variables are not supported',
    );
    expect(result.error?.message).toContain('SECRETS_INDEEDPAMAAPM_*');
  });
});
