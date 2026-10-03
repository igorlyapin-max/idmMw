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

  it('allows direct OIDC SSO without trusted proxy CIDRs', () => {
    const result = appConfigSchema.safeParse({
      ...baseConfig,
      ADMIN_AUTH_ENABLED: 'true',
      ADMIN_AUTH_MODE: 'sso',
      ADMIN_AUTH_SSO_PROVIDERS: 'oidc',
      ADMIN_AUTH_SESSION_SECRET: 'session-secret',
      ADMIN_AUTH_ALLOWED_GROUPS: 'idmmw-admins',
      ADMIN_AUTH_OIDC_ISSUER_URL: 'https://fam.example.test',
      ADMIN_AUTH_OIDC_CLIENT_ID: 'idmmw',
      ADMIN_AUTH_OIDC_CLIENT_SECRET: 'client-secret',
      ADMIN_AUTH_OIDC_REDIRECT_URI:
        'https://idmmw.example.test/auth/oidc/callback',
    });

    expect(result.success).toBe(true);
  });

  it('requires SAML IdP issuer for direct SAML SSO', () => {
    const result = appConfigSchema.safeParse({
      ...baseConfig,
      ADMIN_AUTH_ENABLED: 'true',
      ADMIN_AUTH_MODE: 'sso',
      ADMIN_AUTH_SSO_PROVIDERS: 'saml',
      ADMIN_AUTH_SESSION_SECRET: 'session-secret',
      ADMIN_AUTH_ALLOWED_GROUPS: 'idmmw-admins',
      ADMIN_AUTH_SAML_ENTRYPOINT: 'https://fam.example.test/saml/login',
      ADMIN_AUTH_SAML_ISSUER: 'https://idmmw.example.test/saml/metadata',
      ADMIN_AUTH_SAML_CALLBACK_URL: 'https://idmmw.example.test/auth/saml/acs',
      ADMIN_AUTH_SAML_IDP_CERT:
        '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----',
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('IdP issuer');
  });

  it('allows direct SAML SSO with an explicit IdP issuer', () => {
    const result = appConfigSchema.safeParse({
      ...baseConfig,
      ADMIN_AUTH_ENABLED: 'true',
      ADMIN_AUTH_MODE: 'sso',
      ADMIN_AUTH_SSO_PROVIDERS: 'saml',
      ADMIN_AUTH_SESSION_SECRET: 'session-secret',
      ADMIN_AUTH_ALLOWED_GROUPS: 'idmmw-admins',
      ADMIN_AUTH_SAML_ENTRYPOINT: 'https://fam.example.test/saml/login',
      ADMIN_AUTH_SAML_ISSUER: 'https://idmmw.example.test/saml/metadata',
      ADMIN_AUTH_SAML_CALLBACK_URL: 'https://idmmw.example.test/auth/saml/acs',
      ADMIN_AUTH_SAML_IDP_ISSUER: 'https://fam.example.test/saml',
      ADMIN_AUTH_SAML_IDP_CERT:
        '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----',
    });

    expect(result.success).toBe(true);
  });

  it('requires trusted proxy CIDRs only for header SSO', () => {
    const result = appConfigSchema.safeParse({
      ...baseConfig,
      ADMIN_AUTH_ENABLED: 'true',
      ADMIN_AUTH_MODE: 'sso',
      ADMIN_AUTH_SSO_PROVIDERS: 'header',
      ADMIN_AUTH_SESSION_SECRET: 'session-secret',
      ADMIN_AUTH_ALLOWED_GROUPS: 'idmmw-admins',
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain(
      'Header SSO admin auth requires ADMIN_AUTH_TRUSTED_PROXY_CIDRS',
    );
  });
});
