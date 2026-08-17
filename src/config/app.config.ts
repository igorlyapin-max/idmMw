import { z } from 'zod';

const LEGACY_PAM_ENV_NAMES = [
  'PAMURL',
  'PAMTOKEN',
  'PAMUSERNAME',
  'PAMPASSWORD',
  'PAMDEFAULTACCOUNTPATH',
] as const;

export const appConfigSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'production', 'test'])
      .default('development'),
    PORT: z.string().transform(Number).default(3010),
    DATABASE_URL: z.string().min(1),
    DATABASE_PROVIDER: z.enum(['postgresql', 'sqlite']).default('postgresql'),
    DATABASE_FLAVOR: z
      .enum(['postgresql', 'yugabytedb', 'cockroachdb'])
      .default('postgresql'),
    LIGHTWEIGHT_MODE: z
      .string()
      .transform((v) => v === 'true')
      .default(false),

    REDIS_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default(false),
    REDIS_HOST: z.string().optional(),
    REDIS_PORT: z.string().transform(Number).default(6379),
    REDIS_PASSWORD: z.string().optional(),
    REDIS_DB: z.string().transform(Number).default(0),
    REDIS_TLS_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default(false),
    REDIS_TLS_VERIFY: z.string().optional(),
    REDIS_TLS_REJECT_UNAUTHORIZED: z.string().optional(),
    REDIS_TLS_CA: z.string().optional(),
    REDIS_TLS_CA_PATH: z.string().optional(),
    REDIS_TLS_CERT: z.string().optional(),
    REDIS_TLS_CERT_PATH: z.string().optional(),
    REDIS_TLS_KEY: z.string().optional(),
    REDIS_TLS_KEY_PATH: z.string().optional(),
    REDIS_TLS_SERVER_NAME: z.string().optional(),

    KAFKA_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default(false),
    KAFKA_BROKERS: z.string().default('localhost:9092'),
    KAFKA_CLIENT_ID: z.string().default('idmmw'),
    KAFKA_CONSUMER_GROUP_ID: z.string().default('idmmw-worker-group'),
    KAFKA_TOPIC_EVENTS_IN: z.string().default('idm.events.in'),
    KAFKA_TOPIC_EVENTS_OUT: z.string().default('idm.events.out'),
    KAFKA_TOPIC_DLQ_RETRY: z.string().default('idm.dlq.retry'),
    KAFKA_TLS_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default(false),
    KAFKA_TLS_VERIFY: z.string().optional(),
    KAFKA_TLS_REJECT_UNAUTHORIZED: z.string().optional(),
    KAFKA_TLS_CA: z.string().optional(),
    KAFKA_TLS_CA_PATH: z.string().optional(),
    KAFKA_TLS_CERT: z.string().optional(),
    KAFKA_TLS_CERT_PATH: z.string().optional(),
    KAFKA_TLS_KEY: z.string().optional(),
    KAFKA_TLS_KEY_PATH: z.string().optional(),
    KAFKA_TLS_SERVER_NAME: z.string().optional(),
    IDMMW_PROCESSING_MODE: z.enum(['sync', 'async']).default('sync'),
    DLQ_RETRY_LEASE_SECONDS: z.string().transform(Number).default(300),
    INTEGRATION_AUTH_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default(false),
    INTEGRATION_AUTH_SECRET: z.string().optional(),
    INTEGRATION_AUTH_ALLOWED_CLOCK_SKEW_SECONDS: z
      .string()
      .transform(Number)
      .default(300),

    DB_CONNECTOR_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default(false),
    DB_CONNECTOR_URL: z.string().optional(),
    DB_CONNECTOR_DIALECT: z
      .enum(['pg', 'mysql2', 'sqlite3', 'oracledb'])
      .optional(),
    DB_CONNECTOR_USERNAME: z.string().optional(),
    DB_CONNECTOR_PASSWORD: z.string().optional(),
    DB_CONNECTOR_TLS_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default(false),
    DB_CONNECTOR_TLS_VERIFY: z.string().optional(),
    DB_CONNECTOR_TLS_REJECT_UNAUTHORIZED: z.string().optional(),
    DB_CONNECTOR_TLS_CA: z.string().optional(),
    DB_CONNECTOR_TLS_CA_PATH: z.string().optional(),
    DB_CONNECTOR_TLS_CERT: z.string().optional(),
    DB_CONNECTOR_TLS_CERT_PATH: z.string().optional(),
    DB_CONNECTOR_TLS_KEY: z.string().optional(),
    DB_CONNECTOR_TLS_KEY_PATH: z.string().optional(),
    DB_CONNECTOR_TLS_SERVER_NAME: z.string().optional(),
    DB_CONNECTOR_TLS_WALLET_LOCATION: z.string().optional(),
    DB_CONNECTOR_TLS_WALLET_PASSWORD: z.string().optional(),

    MOCK_IDM_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default(false),
    MOCK_IDM_PORT: z.string().transform(Number).default(5100),
    MOCK_IDM_MIDDLEWARE_URL: z.string().optional(),

    ADMIN_UI_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default(false),
    ADMIN_UI_SERVE_STATIC: z
      .string()
      .transform((v) => v === 'true')
      .default(false),
    ADMIN_AUTH_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default(false),
    ADMIN_AUTH_MODE: z.enum(['local', 'sso', 'both']).default('local'),
    ADMIN_AUTH_LOCAL_USERNAME: z.string().optional(),
    ADMIN_AUTH_LOCAL_PASSWORD: z.string().optional(),
    ADMIN_AUTH_SESSION_SECRET: z.string().optional(),
    ADMIN_AUTH_SESSION_TTL_SECONDS: z.string().transform(Number).default(28800),
    ADMIN_AUTH_COOKIE_NAME: z.string().default('idmmw_admin_session'),
    ADMIN_AUTH_COOKIE_SECURE: z
      .string()
      .transform((v) => v === 'true')
      .optional(),
    ADMIN_AUTH_COOKIE_SAMESITE: z
      .enum(['Strict', 'Lax', 'None'])
      .default('Strict'),
    ADMIN_AUTH_ALLOWLIST: z.string().optional(),
    ADMIN_AUTH_ALLOWED_GROUPS: z.string().optional(),
    ADMIN_AUTH_SSO_USER_HEADER: z.string().default('x-authenticated-user'),
    ADMIN_AUTH_SSO_GROUPS_HEADER: z.string().default('x-authenticated-groups'),
    ADMIN_AUTH_SSO_GROUPS_DELIMITER: z.string().default(','),
    ADMIN_AUTH_TRUSTED_PROXY_CIDRS: z.string().optional(),
    HTTP_TLS_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default(false),
    HTTP_TLS_VERIFY: z.string().optional(),
    HTTP_TLS_REJECT_UNAUTHORIZED: z.string().optional(),
    HTTP_TLS_CA: z.string().optional(),
    HTTP_TLS_CA_PATH: z.string().optional(),
    HTTP_TLS_CERT: z.string().optional(),
    HTTP_TLS_CERT_PATH: z.string().optional(),
    HTTP_TLS_KEY: z.string().optional(),
    HTTP_TLS_KEY_PATH: z.string().optional(),
    HTTP_TLS_SERVER_NAME: z.string().optional(),
    HTTP_TLS_REQUEST_CLIENT_CERT: z.string().optional(),

    SECRETS_PROVIDER: z.enum(['None', 'IndeedPamAapm']).default('None'),
    SECRETS_INDEEDPAMAAPM_TOKEN_TRANSPORT: z
      .enum(['header', 'query'])
      .default('header'),
    ENCRYPTION_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default(false),
    ENCRYPTION_KAFKA_ENABLED: z.string().optional(),
    ENCRYPTION_IDEMPOTENCY_HMAC_ENABLED: z.string().optional(),
    ENCRYPTION_ROTATION_MODE: z.string().optional(),
    ENCRYPTION_ROTATION_SKIP_KAFKA_LAG_CHECK: z.string().optional(),
    ENCRYPTION_ACTIVE_KEY_ID: z.string().optional(),
    ENCRYPTION_KEY_ID: z.string().optional(),
    ENCRYPTION_KEYS: z.string().optional(),
    ENCRYPTION_KEY: z.string().optional(),

    DebugLogging__Enabled: z
      .string()
      .transform((v) => v === 'true')
      .default(false),
    DebugLogging__Level: z.enum(['Basic', 'Verbose']).default('Basic'),
    DEBUG_LOGGING_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default(false),
    DEBUG_LOGGING_LEVEL: z.enum(['Basic', 'Verbose']).optional(),

    LOG_SINK: z.enum(['stdout', 'file']).default('stdout'),
    LOG_FILE_PATH: z.string().default('/tmp/idmmw.log'),
    LOG_EXTERNAL_SINK: z
      .enum(['compose-logging-profile', 'platform-managed'])
      .optional(),
    METRICS_PUBLIC_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default(true),
    STATIC_CONNECTOR_ALLOWLIST: z.string().optional(),
    TARGET_SYSTEM_REGISTRY_REFRESH_SECONDS: z
      .string()
      .transform(Number)
      .default(10),
    APP_VERSION: z.string().optional(),
    GIT_REVISION: z.string().optional(),
    SOURCE_CLEAN: z.enum(['true', 'false']).optional(),
    BUILD_PROVENANCE: z
      .enum(['verified', 'unverified-local'])
      .default('unverified-local'),
    RUNTIME_ARTIFACT_SHA256: z.string().optional(),
    IMAGE_CREATED: z.string().optional(),
  })
  .passthrough()
  .superRefine((config, ctx) => {
    for (const envName of LEGACY_PAM_ENV_NAMES) {
      const value = config[envName];
      if (typeof value === 'string' && value.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [envName],
          message:
            'Legacy PAM* environment variables are not supported. Use SECRETS_PROVIDER=IndeedPamAapm and SECRETS_INDEEDPAMAAPM_* instead.',
        });
      }
    }
    if (config.IDMMW_PROCESSING_MODE === 'async' && !config.KAFKA_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['IDMMW_PROCESSING_MODE'],
        message:
          'IDMMW_PROCESSING_MODE=async requires KAFKA_ENABLED=true and reachable Kafka brokers',
      });
    }
    if (config.NODE_ENV === 'production' && config.MOCK_IDM_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MOCK_IDM_ENABLED'],
        message: 'MOCK_IDM_ENABLED=true is not allowed in production',
      });
    }
    if (config.INTEGRATION_AUTH_ENABLED && !config.INTEGRATION_AUTH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['INTEGRATION_AUTH_SECRET'],
        message:
          'INTEGRATION_AUTH_SECRET is required when INTEGRATION_AUTH_ENABLED=true',
      });
    }
    if (!config.METRICS_PUBLIC_ENABLED && !config.INTEGRATION_AUTH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['INTEGRATION_AUTH_SECRET'],
        message:
          'INTEGRATION_AUTH_SECRET is required when METRICS_PUBLIC_ENABLED=false',
      });
    }
    if (config.ADMIN_AUTH_ENABLED) {
      if (!config.ADMIN_AUTH_SESSION_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ADMIN_AUTH_SESSION_SECRET'],
          message:
            'ADMIN_AUTH_SESSION_SECRET is required when ADMIN_AUTH_ENABLED=true',
        });
      }
      if (
        (config.ADMIN_AUTH_MODE === 'local' ||
          config.ADMIN_AUTH_MODE === 'both') &&
        (!config.ADMIN_AUTH_LOCAL_USERNAME || !config.ADMIN_AUTH_LOCAL_PASSWORD)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ADMIN_AUTH_LOCAL_USERNAME'],
          message:
            'Local admin auth requires ADMIN_AUTH_LOCAL_USERNAME and ADMIN_AUTH_LOCAL_PASSWORD',
        });
      }
      if (
        (config.ADMIN_AUTH_MODE === 'sso' ||
          config.ADMIN_AUTH_MODE === 'both') &&
        !config.ADMIN_AUTH_ALLOWLIST &&
        !config.ADMIN_AUTH_ALLOWED_GROUPS
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ADMIN_AUTH_ALLOWLIST'],
          message:
            'SSO admin auth requires ADMIN_AUTH_ALLOWLIST or ADMIN_AUTH_ALLOWED_GROUPS',
        });
      }
      if (
        (config.ADMIN_AUTH_MODE === 'sso' ||
          config.ADMIN_AUTH_MODE === 'both') &&
        !config.ADMIN_AUTH_TRUSTED_PROXY_CIDRS
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ADMIN_AUTH_TRUSTED_PROXY_CIDRS'],
          message:
            'SSO admin auth requires ADMIN_AUTH_TRUSTED_PROXY_CIDRS to prevent spoofed SSO headers',
        });
      }
    }
  });

export type AppConfig = z.infer<typeof appConfigSchema>;
