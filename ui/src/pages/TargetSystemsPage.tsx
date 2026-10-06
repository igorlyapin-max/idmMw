import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import {
  clearRuntimeLogs,
  createLinuxCredentialProfile,
  createLinuxHost,
  createLinuxServerGroup,
  createTargetSystem,
  deleteTargetSystem,
  disableRuntimeDebug,
  enableRuntimeDebug,
  fetchLinuxCredentialProfiles,
  fetchLinuxHosts,
  fetchLinuxServerGroups,
  fetchRuntimeDebugStatus,
  fetchRuntimeLogs,
  fetchTargetSystems,
  setLinuxServerGroupHosts,
  testTargetSystemConnection,
  updateTargetSystem,
  type LinuxCredentialProfile,
  type LinuxHost,
  type LinuxServerGroup,
  type EffectiveAdminPermissions,
  type RuntimeDebugSession,
  type RuntimeLogEvent,
  type TargetSystem,
} from '../api/client';

const TYPE_OPTIONS = [
  'zabbix',
  'cmdbuild',
  'passwork',
  'consultant-plus',
  'postgres-role',
  'mssql-login',
  'rest',
  'db',
  'linux',
  'fake',
];

interface ConfigField {
  name: string;
  label: string;
  help?: string;
  inputType?: 'password' | 'text' | 'json';
  placeholder?: string;
  defaultValue?: string;
  options?: Array<{ value: string; label: string }>;
}

interface BuildConfigResult {
  config: Record<string, unknown>;
  errors: Record<string, string>;
}

interface RetryPolicyForm {
  maxRetries: string;
  baseDelayMs: string;
  maxDelayMs: string;
  dlqLeaseSeconds: string;
  jitter: boolean;
}

interface TargetSystemForm {
  id?: string;
  name: string;
  type: string;
  label: string;
  configValues: Record<string, string>;
  retryPolicy: RetryPolicyForm;
  extraConfig: Record<string, unknown>;
  enabled: boolean;
}

interface LinuxProfileForm {
  name: string;
  mode: 'env' | 'aapm';
  username: string;
  privateKeyRef: string;
  passwordRef: string;
  enabled: boolean;
}

interface LinuxHostForm {
  name: string;
  host: string;
  port: string;
  hostFingerprint: string;
  credentialProfileId: string;
  enabled: boolean;
}

interface LinuxGroupForm {
  code: string;
  name: string;
  description: string;
  enabled: boolean;
}

const DEFAULT_RETRY_POLICY_FORM: RetryPolicyForm = {
  maxRetries: '',
  baseDelayMs: '',
  maxDelayMs: '',
  dlqLeaseSeconds: '',
  jitter: true,
};

const EMPTY_FORM: TargetSystemForm = {
  name: '',
  type: 'zabbix',
  label: '',
  configValues: {},
  retryPolicy: DEFAULT_RETRY_POLICY_FORM,
  extraConfig: {},
  enabled: true,
};

type PermissionsStatus = 'loading' | 'ready' | 'failed';

const TYPE_FIELDS: Record<string, ConfigField[]> = {
  zabbix: [
    {
      name: 'baseUrl',
      label: 'Base URL',
      placeholder: 'https://zabbix.example.local',
      help: 'Zabbix API root URL.',
    },
    {
      name: 'apiToken',
      label: 'API token',
      inputType: 'password',
      help: 'Preferred Zabbix authentication secret. Username/password can be left empty when this is set.',
    },
    {
      name: 'username',
      label: 'Username',
      help: 'Used with Password when API token authentication is not configured.',
    },
    {
      name: 'password',
      label: 'Password',
      inputType: 'password',
      help: 'Used only with Username when API token authentication is not configured.',
    },
    {
      name: 'apiVersion',
      label: 'API version',
      placeholder: '7.0',
      help: 'Optional operator-facing version hint.',
    },
    {
      name: 'enableGroupId',
      label: 'Enable group ID',
      help: 'Optional group used by user.enable and user.unlock. Default is 7.',
    },
    {
      name: 'disableGroupId',
      label: 'Disable group ID',
      help: 'Optional group used by user.disable and user.lock. Default is 9.',
    },
  ],
  cmdbuild: [
    {
      name: 'baseUrl',
      label: 'Base URL',
      placeholder: 'https://cmdbuild.example.local',
      help: 'CMDBuild host URL without the REST v3 path.',
    },
    {
      name: 'apiPath',
      label: 'API path',
      placeholder: '/cmdbuild/services/rest/v3',
      help: 'Optional REST API path. Defaults to /cmdbuild/services/rest/v3.',
    },
    { name: 'username', label: 'Username' },
    {
      name: 'password',
      label: 'Password',
      inputType: 'password',
      help: 'CMDBuild credential used by the selected auth mode.',
    },
    {
      name: 'authMode',
      label: 'Auth mode',
      defaultValue: 'session',
      options: [
        { value: 'session', label: 'session' },
        { value: 'basic', label: 'basic' },
      ],
      help: 'Defaults to session. Basic is intended for read-only stands that do not allow service sessions.',
    },
    {
      name: 'defaultUserGroupId',
      label: 'Default user group ID',
      help: 'Optional role/group assigned when user.create has no userGroups.',
    },
  ],
  passwork: [
    {
      name: 'baseUrl',
      label: 'Base URL',
      placeholder: 'https://passwork.example.local',
      help: 'Passwork host URL without /api/v1.',
    },
    {
      name: 'accessToken',
      label: 'Access token',
      inputType: 'password',
      help: 'Bearer accessToken generated in Passwork API tokens.',
    },
    {
      name: 'masterKeyHash',
      label: 'Master key hash',
      inputType: 'password',
      help: 'Optional Passwork-MasterKeyHash header for client-side encryption mode. Secret values are not decrypted by idmMw.',
    },
    {
      name: 'timeout',
      label: 'Timeout ms',
      help: 'Optional request timeout. Default is 30000.',
    },
    {
      name: 'responseFormat',
      label: 'Response format',
      placeholder: 'raw',
      help: 'Passwork X-Response-Format header. Default is raw.',
    },
  ],
  'consultant-plus': [
    {
      name: 'baseUrl',
      label: 'Base URL',
      placeholder: 'https://login.consultant.ru',
      help: 'ConsultantPlus login/auth host.',
    },
    {
      name: 'apiBaseUrl',
      label: 'API base URL',
      placeholder: 'https://cloud.consultant.ru',
      help: 'Optional. Host used for the CGI endpoints once authenticated. Defaults to Base URL.',
    },
    {
      name: 'loginEnv',
      label: 'Operator login env var',
      placeholder: 'CONSULTANT_OPERATOR_LOGIN',
      help: 'Name of the environment variable on the idmMw server that holds the operator login. The value itself is set in server env, not here.',
    },
    {
      name: 'passwordEnv',
      label: 'Operator password env var',
      placeholder: 'CONSULTANT_OPERATOR_PASSWORD',
      help: 'Name of the environment variable on the idmMw server that holds the operator password.',
    },
    {
      name: 'protectedOperatorLogin',
      label: 'Protected operator login',
      placeholder: '1393020',
      help: 'Root operator login that the connector refuses to modify/delete. Defaults to 1393020.',
    },
    {
      name: 'managedLoginPrefix',
      label: 'Managed login prefix',
      help: 'Optional prefix used when building managed logins, e.g. "1393020#".',
    },
    {
      name: 'timeout',
      label: 'Timeout ms',
      help: 'Optional HTTP request timeout. Default is 30000.',
    },
    {
      name: 'authPollAttempts',
      label: 'Auth poll attempts',
      help: 'Optional. How many times to poll /auth/?pid=... while logging in.',
    },
    {
      name: 'userCreatePath',
      label: 'Create: path',
      placeholder: '/cloud/cgi/online.cgi?',
      help: 'Required for user.create. Endpoint path (relative to API base URL) that performs account creation.',
    },
    {
      name: 'userCreateMethod',
      label: 'Create: HTTP method',
      defaultValue: 'POST',
      help: 'Defaults to POST.',
    },
    {
      name: 'userCreateContentType',
      label: 'Create: content type',
      defaultValue: 'form',
      options: [
        { value: 'form', label: 'form' },
        { value: 'json', label: 'json' },
      ],
    },
    {
      name: 'userCreatePayload',
      label: 'Create: payload template (JSON)',
      inputType: 'json',
      placeholder:
        '{\n  "req": "admin",\n  "op": "admadd",\n  "login": "${pureLogin}",\n  "email": "${email}",\n  "fio": "${fullName}"\n}',
      help: 'Template body sent on user.create. Use ${field} placeholders resolved from the webhook payload.data.',
    },
    {
      name: 'userUpdatePath',
      label: 'Update: path',
      help: 'Optional. Endpoint used for user.update.',
    },
    {
      name: 'userUpdateContentType',
      label: 'Update: content type',
      defaultValue: 'form',
      options: [
        { value: 'form', label: 'form' },
        { value: 'json', label: 'json' },
      ],
    },
    {
      name: 'userUpdatePayload',
      label: 'Update: payload template (JSON)',
      inputType: 'json',
      help: 'Template body sent on user.update.',
    },
    {
      name: 'userChangePasswordPath',
      label: 'Change password: path',
      help: 'Optional. Endpoint used for user.changePassword.',
    },
    {
      name: 'userChangePasswordPayload',
      label: 'Change password: payload template (JSON)',
      inputType: 'json',
    },
    {
      name: 'userBlockPath',
      label: 'Block/disable: path',
      help: 'Optional. Endpoint used for user.disable / user.lock.',
    },
    {
      name: 'userBlockPayload',
      label: 'Block/disable: payload template (JSON)',
      inputType: 'json',
    },
    {
      name: 'userDeletePath',
      label: 'Delete: path',
      help: 'Optional. Endpoint used for user.delete.',
    },
    {
      name: 'userDeletePayload',
      label: 'Delete: payload template (JSON)',
      inputType: 'json',
    },
  ],
  'postgres-role': [
    {
      name: 'connectionString',
      label: 'Connection string',
      inputType: 'password',
      placeholder:
        'postgresql://idm_admin:REPLACE_WITH_SECRET@postgres.example.local:5432/postgres',
      help: 'PostgreSQL connection string for role administration.',
    },
    {
      name: 'rolePrefix',
      label: 'Role prefix',
      placeholder: 'idm_',
      help: 'Optional prefix applied to managed user login roles.',
    },
    {
      name: 'managedRolePrefix',
      label: 'Managed role prefix',
      placeholder: 'idm_',
      help: 'Default namespace for manageable PostgreSQL group/grant roles.',
    },
    {
      name: 'rolePolicyMode',
      label: 'Role policy mode',
      defaultValue: 'managed-namespace',
      options: [
        { value: 'managed-namespace', label: 'managed-namespace' },
        { value: 'idm-full-control', label: 'idm-full-control' },
      ],
      help: 'Default restricts roles to the managed namespace. idm-full-control lets IDM manage all roles allowed by the DB service account.',
    },
    {
      name: 'permissionPolicyMode',
      label: 'Permission policy mode',
      defaultValue: 'managed-allowlist',
      options: [
        { value: 'managed-allowlist', label: 'managed-allowlist' },
        { value: 'disabled', label: 'disabled' },
        { value: 'idm-full-control', label: 'idm-full-control' },
      ],
      help: 'Default allows only configured permission allowlist. idm-full-control lets IDM send arbitrary valid GRANT/REVOKE payload permissions.',
    },
    {
      name: 'defaultDatabase',
      label: 'Default database',
      placeholder: 'appdb',
      help: 'Optional database name used for DATABASE permission scope. Defaults to current_database().',
    },
    {
      name: 'defaultLogin',
      label: 'Default login flag (JSON)',
      inputType: 'json',
      placeholder: 'true',
      help: 'Boolean. false creates user roles with NOLOGIN by default.',
    },
    {
      name: 'defaultRoles',
      label: 'Default roles (JSON)',
      inputType: 'json',
      placeholder: '["app_read"]',
      help: 'Roles granted to users during user.create.',
    },
    {
      name: 'defaultPermissions',
      label: 'Default permissions (JSON)',
      inputType: 'json',
      placeholder:
        '[{"action":"GRANT","permission":"SELECT","scope":"SCHEMA::public"}]',
      help: 'Permissions applied during user.create. Actions: GRANT, REVOKE.',
    },
    {
      name: 'allowedPermissions',
      label: 'Allowed payload permissions (JSON)',
      inputType: 'json',
      placeholder:
        '[{"action":"GRANT","permission":"UPDATE","scope":"TABLE::public.customer"}]',
      help: 'Additional permission allowlist for managed-allowlist mode.',
    },
    {
      name: 'physicalDeleteEnabled',
      label: 'Physical user delete enabled (JSON)',
      inputType: 'json',
      placeholder: 'false',
      help: 'Boolean. true allows DROP ROLE for user.delete.',
    },
    {
      name: 'physicalRoleDeleteEnabled',
      label: 'Physical group role delete enabled (JSON)',
      inputType: 'json',
      placeholder: 'false',
      help: 'Boolean. true allows DROP ROLE for group.delete.',
    },
    {
      name: 'statementTimeoutMs',
      label: 'Statement timeout ms',
      placeholder: '30000',
    },
    {
      name: 'tls',
      label: 'TLS config (JSON)',
      inputType: 'json',
      placeholder:
        '{"enabled":true,"caPath":"/etc/idmmw/tls/postgres-ca.crt","serverName":"postgres.example.local","rejectUnauthorized":true}',
    },
  ],
  'mssql-login': [
    {
      name: 'connectionString',
      label: 'Connection string',
      inputType: 'password',
      placeholder:
        'Server=mssql.example.local,1433;Database=master;User Id=idm_admin;Password=REPLACE_WITH_SECRET;',
      help: 'SQL Server connection string for login and database role administration.',
    },
    {
      name: 'loginPrefix',
      label: 'Login prefix',
      placeholder: 'idm_',
      help: 'Optional prefix applied to managed SQL Server logins.',
    },
    {
      name: 'defaultDatabase',
      label: 'Default database',
      placeholder: 'appdb',
      help: 'Database used for database users, roles and permissions.',
    },
    {
      name: 'defaultDatabaseRoles',
      label: 'Default roles (JSON)',
      inputType: 'json',
      placeholder: '["db_datareader"]',
      help: 'Database roles granted to users during user.create.',
    },
    {
      name: 'defaultPermissions',
      label: 'Default permissions (JSON)',
      inputType: 'json',
      placeholder:
        '[{"action":"GRANT","permission":"SELECT","scope":"SCHEMA::dbo"}]',
      help: 'Permissions applied during user.create. Actions: GRANT, DENY, REVOKE.',
    },
    {
      name: 'physicalDeleteEnabled',
      label: 'Physical user delete enabled (JSON)',
      inputType: 'json',
      placeholder: 'false',
      help: 'Boolean. true allows DROP USER/DROP LOGIN for user.delete.',
    },
    {
      name: 'physicalRoleDeleteEnabled',
      label: 'Physical role delete enabled (JSON)',
      inputType: 'json',
      placeholder: 'false',
      help: 'Boolean. true allows DROP ROLE for group.delete.',
    },
    {
      name: 'statementTimeoutMs',
      label: 'Statement timeout ms',
      placeholder: '30000',
    },
    {
      name: 'tls',
      label: 'TLS config (JSON)',
      inputType: 'json',
      placeholder: '{"encrypt":true,"trustServerCertificate":false}',
    },
  ],
  rest: [{ name: 'baseUrl', label: 'Base URL' }],
  db: [
    { name: 'client', label: 'Dialect (pg | mysql2 | sqlite3 | oracledb)' },
    { name: 'connection', label: 'Connection string / Oracle connectString' },
    { name: 'username', label: 'Username (Oracle)' },
    { name: 'password', label: 'Password (Oracle)', inputType: 'password' },
  ],
  linux: [
    {
      name: 'provider',
      label: 'Provider',
      defaultValue: 'ssh-sudo-fleet',
      options: [
        { value: 'ssh-sudo-fleet', label: 'ssh-sudo-fleet' },
        { value: 'ssh-sudo', label: 'ssh-sudo' },
        { value: 'remote-agent', label: 'remote-agent' },
      ],
      help: 'Fleet mode maps IDM serverGroups to idmMw managed Linux hosts.',
    },
    {
      name: 'diagnosticTargetSystem',
      label: 'Diagnostic target system',
      help: 'Optional TargetSystem.name used by direct Test when the payload targetSystem is unavailable.',
    },
    {
      name: 'defaultShell',
      label: 'Default shell',
      placeholder: '/bin/bash',
    },
    {
      name: 'defaultHomeBase',
      label: 'Default home base',
      placeholder: '/home',
    },
    {
      name: 'defaultGroups',
      label: 'Default POSIX groups (JSON)',
      inputType: 'json',
      placeholder: '["users"]',
    },
    {
      name: 'sudoMode',
      label: 'Sudo mode',
      defaultValue: 'passwordless',
      options: [{ value: 'passwordless', label: 'passwordless' }],
    },
    {
      name: 'timeoutMs',
      label: 'Timeout ms',
      placeholder: '30000',
    },
  ],
  fake: [
    { name: 'baseUrl', label: 'Base URL' },
    { name: 'apiKey', label: 'API key', inputType: 'password' },
    { name: 'timeout', label: 'Timeout ms' },
  ],
};

function newForm(type = 'zabbix'): TargetSystemForm {
  return {
    ...EMPTY_FORM,
    type,
    configValues: {},
    retryPolicy: { ...DEFAULT_RETRY_POLICY_FORM },
    extraConfig: {},
  };
}

function positiveInteger(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function buildRetryPolicy(
  form: RetryPolicyForm,
): Record<string, unknown> | undefined {
  const retryPolicy: Record<string, unknown> = {};
  const numericFields: Array<keyof Omit<RetryPolicyForm, 'jitter'>> = [
    'maxRetries',
    'baseDelayMs',
    'maxDelayMs',
    'dlqLeaseSeconds',
  ];

  for (const field of numericFields) {
    const value = positiveInteger(form[field]);
    if (value !== undefined) {
      retryPolicy[field] = value;
    }
  }

  if (Object.keys(retryPolicy).length > 0 || !form.jitter) {
    retryPolicy['jitter'] = form.jitter;
  }

  return Object.keys(retryPolicy).length > 0 ? retryPolicy : undefined;
}

function buildConfig(form: TargetSystemForm): BuildConfigResult {
  const cfg: Record<string, unknown> = { ...form.extraConfig };
  const errors: Record<string, string> = {};
  TYPE_FIELDS[form.type]?.forEach((field) => {
    const value = form.configValues[field.name];
    if (isSecretConfigKey(field.name) && isMaskedSecretPlaceholder(value)) {
      return;
    }
    if (
      field.options &&
      value !== undefined &&
      !field.options.some((option) => option.value === value)
    ) {
      return;
    }
    if (value === undefined || value === '') {
      return;
    }
    if (field.inputType === 'json') {
      try {
        cfg[field.name] = JSON.parse(value);
      } catch {
        errors[field.name] = 'Invalid JSON';
      }
      return;
    }
    cfg[field.name] = value;
  });

  const retryPolicy = buildRetryPolicy(form.retryPolicy);
  if (retryPolicy) {
    cfg['retryPolicy'] = retryPolicy;
  }

  return { config: cfg, errors };
}

function retryPolicyFromConfig(
  config: Record<string, unknown>,
): RetryPolicyForm {
  const raw = config['retryPolicy'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_RETRY_POLICY_FORM };
  }
  const retryPolicy = raw as Record<string, unknown>;
  return {
    maxRetries:
      retryPolicy['maxRetries'] === undefined
        ? ''
        : String(retryPolicy['maxRetries']),
    baseDelayMs:
      retryPolicy['baseDelayMs'] === undefined
        ? ''
        : String(retryPolicy['baseDelayMs']),
    maxDelayMs:
      retryPolicy['maxDelayMs'] === undefined
        ? ''
        : String(retryPolicy['maxDelayMs']),
    dlqLeaseSeconds:
      retryPolicy['dlqLeaseSeconds'] === undefined
        ? ''
        : String(retryPolicy['dlqLeaseSeconds']),
    jitter:
      typeof retryPolicy['jitter'] === 'boolean'
        ? retryPolicy['jitter']
        : DEFAULT_RETRY_POLICY_FORM.jitter,
  };
}

const SECRET_CONFIG_KEY_PATTERN =
  /(connectionString|pass|token|secret|key|code|credential)/i;

function isSecretConfigKey(key: string): boolean {
  return SECRET_CONFIG_KEY_PATTERN.test(key);
}

function isMaskedSecretPlaceholder(value: unknown): boolean {
  return typeof value === 'string' && value.trim().startsWith('***');
}

function formatExtraConfigValue(key: string, value: unknown): string {
  if (isSecretConfigKey(key)) {
    return value === undefined || value === null || value === ''
      ? ''
      : '*** preserved ***';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value === undefined) {
    return 'undefined';
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const RUNTIME_LOG_DATE_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function formatRuntimeReceivedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const base = RUNTIME_LOG_DATE_FORMATTER.format(date)
    .replace(',', '')
    .replace(/\s+/g, ' ');
  return `${base}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function runtimeLogLevelName(level: RuntimeLogEvent['level']): string {
  if (typeof level === 'string') return level;
  const names: Record<number, string> = {
    10: 'trace',
    20: 'debug',
    30: 'info',
    40: 'warn',
    50: 'error',
    60: 'fatal',
  };
  return names[level] ?? String(level);
}

function runtimeLogTitle(item: RuntimeLogEvent): string {
  return item.event ?? item.msg ?? item.context ?? `log #${item.id}`;
}

function runtimeLogHttpSummary(item: RuntimeLogEvent): string | undefined {
  const parts = [
    item.method,
    item.path,
    item.status === undefined ? undefined : String(item.status),
    item.responseTime === undefined ? undefined : `${item.responseTime}ms`,
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : undefined;
}

function formatRuntimeLogDetails(item: RuntimeLogEvent): string {
  return JSON.stringify(
    {
      id: item.id,
      timeEpochMs: item.time,
      receivedAtUtc: item.receivedAt,
      receivedAtLocal: formatRuntimeReceivedAt(item.receivedAt),
      level: item.level,
      msg: item.msg,
      event: item.event,
      diagnostic: item.diagnostic,
      diagnosticLevel: item.diagnosticLevel,
      targetSystem: item.targetSystem,
      context: item.context,
      method: item.method,
      path: item.path,
      status: item.status,
      responseTime: item.responseTime,
      ...(item.details ? { details: item.details } : {}),
    },
    null,
    2,
  );
}

function formatRuntimeLogsForCopy(items: RuntimeLogEvent[]): string {
  return items
    .map((item) => {
      const header = [
        `[${formatRuntimeReceivedAt(item.receivedAt)}]`,
        runtimeLogLevelName(item.level),
        item.targetSystem,
        runtimeLogTitle(item),
        runtimeLogHttpSummary(item),
      ]
        .filter(Boolean)
        .join(' ');
      return `${header}\n${formatRuntimeLogDetails(item)}`;
    })
    .join('\n\n');
}

function RuntimeLogEntry({ item }: { item: RuntimeLogEvent }) {
  const httpSummary = runtimeLogHttpSummary(item);
  return (
    <article className="log-entry">
      <div className="log-entry-header">
        <time className="log-entry-time" dateTime={item.receivedAt}>
          {formatRuntimeReceivedAt(item.receivedAt)}
        </time>
        <span className={`badge ${runtimeLogLevelName(item.level)}`}>
          {runtimeLogLevelName(item.level)}
        </span>
        {item.targetSystem && (
          <span className="log-entry-target">{item.targetSystem}</span>
        )}
      </div>
      <div className="log-entry-summary">
        <span>{runtimeLogTitle(item)}</span>
        {httpSummary && <span className="log-entry-http">{httpSummary}</span>}
      </div>
      <details className="log-entry-details">
        <summary>Details</summary>
        <pre className="log-line">{formatRuntimeLogDetails(item)}</pre>
      </details>
    </article>
  );
}

function canWriteConnector(
  effective: EffectiveAdminPermissions | null | undefined,
  connectorType: string,
  authEnabled = true,
): boolean {
  if (!authEnabled) return true;
  if (!effective) return false;
  if (effective.superadmin) return true;
  return effective.permissions.some(
    (permission) =>
      permission.connectorType === connectorType && permission.canWrite,
  );
}

export function TargetSystemsPage({
  authEnabled = true,
  effectivePermissions,
  permissionsStatus = 'ready',
}: {
  authEnabled?: boolean;
  effectivePermissions?: EffectiveAdminPermissions | null;
  permissionsStatus?: PermissionsStatus;
}) {
  const permissionsReady =
    !authEnabled || (permissionsStatus === 'ready' && !!effectivePermissions);
  const writableTypes = useMemo(
    () =>
      !authEnabled || effectivePermissions?.superadmin
        ? TYPE_OPTIONS
        : permissionsReady
          ? TYPE_OPTIONS.filter((type) =>
              canWriteConnector(effectivePermissions, type, authEnabled),
            )
          : [],
    [authEnabled, effectivePermissions, permissionsReady],
  );
  const defaultWritableType = useMemo(
    () => writableTypes[0] ?? 'zabbix',
    [writableTypes],
  );
  const [items, setItems] = useState<TargetSystem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [form, setForm] = useState<TargetSystemForm>(() =>
    newForm(defaultWritableType),
  );
  const [editing, setEditing] = useState(false);
  const [formExpanded, setFormExpanded] = useState(false);
  const [message, setMessage] = useState('');
  const [logsTarget, setLogsTarget] = useState<TargetSystem | null>(null);
  const [logs, setLogs] = useState<RuntimeLogEvent[]>([]);
  const [logsLevel, setLogsLevel] = useState('');
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsClearing, setLogsClearing] = useState(false);
  const [logsAutoRefresh, setLogsAutoRefresh] = useState(false);
  const [logsCopyState, setLogsCopyState] = useState<
    'idle' | 'copied' | 'failed'
  >('idle');
  const [configErrors, setConfigErrors] = useState<Record<string, string>>({});
  const [debugTarget, setDebugTarget] = useState<TargetSystem | null>(null);
  const [debugSessions, setDebugSessions] = useState<RuntimeDebugSession[]>([]);
  const [debugLevel, setDebugLevel] = useState<'Basic' | 'Verbose'>('Basic');
  const [debugTtlSeconds, setDebugTtlSeconds] = useState(300);
  const [debugSaving, setDebugSaving] = useState(false);
  const [linuxFleetTarget, setLinuxFleetTarget] = useState<TargetSystem | null>(
    null,
  );
  const [linuxProfiles, setLinuxProfiles] = useState<LinuxCredentialProfile[]>(
    [],
  );
  const [linuxHosts, setLinuxHosts] = useState<LinuxHost[]>([]);
  const [linuxGroups, setLinuxGroups] = useState<LinuxServerGroup[]>([]);
  const [linuxFleetLoading, setLinuxFleetLoading] = useState(false);
  const [linuxFleetSaving, setLinuxFleetSaving] = useState(false);
  const [linuxProfileForm, setLinuxProfileForm] = useState<LinuxProfileForm>({
    name: '',
    mode: 'env',
    username: '',
    privateKeyRef: '',
    passwordRef: '',
    enabled: true,
  });
  const [linuxHostForm, setLinuxHostForm] = useState<LinuxHostForm>({
    name: '',
    host: '',
    port: '22',
    hostFingerprint: '',
    credentialProfileId: '',
    enabled: true,
  });
  const [linuxGroupForm, setLinuxGroupForm] = useState<LinuxGroupForm>({
    code: '',
    name: '',
    description: '',
    enabled: true,
  });
  const [linuxGroupHostDrafts, setLinuxGroupHostDrafts] = useState<
    Record<string, string[]>
  >({});
  const lastModalTriggerRef = useRef<HTMLElement | null>(null);
  const logsPanelRef = useRef<HTMLDivElement | null>(null);
  const logsCloseRef = useRef<HTMLButtonElement | null>(null);
  const logsRequestSeqRef = useRef(0);
  const debugPanelRef = useRef<HTMLDivElement | null>(null);
  const debugCloseRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await fetchTargetSystems({ limit: 200 }));
    } catch (e: unknown) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const loadLinuxFleet = useCallback(async (target: TargetSystem) => {
    setLinuxFleetLoading(true);
    try {
      const [profiles, hosts, groups] = await Promise.all([
        fetchLinuxCredentialProfiles(target.id),
        fetchLinuxHosts(target.id),
        fetchLinuxServerGroups(target.id),
      ]);
      setLinuxProfiles(profiles);
      setLinuxHosts(hosts);
      setLinuxGroups(groups);
      setLinuxGroupHostDrafts(
        Object.fromEntries(
          groups.map((group) => [
            group.id,
            hosts
              .filter((host) =>
                (host.groups ?? []).some(
                  (membershipGroup) => membershipGroup.id === group.id,
                ),
              )
              .map((host) => host.id),
          ]),
        ),
      );
    } catch (e: unknown) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLinuxFleetLoading(false);
    }
  }, []);

  const openLinuxFleet = async (target: TargetSystem) => {
    setLinuxFleetTarget(target);
    await loadLinuxFleet(target);
  };

  const loadDebugStatus = useCallback(async () => {
    try {
      const status = await fetchRuntimeDebugStatus();
      setDebugSessions(status.active);
    } catch (e: unknown) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const loadLogs = useCallback(async () => {
    if (!logsTarget || logsClearing) return;
    const requestSeq = (logsRequestSeqRef.current += 1);
    setLogsLoading(true);
    try {
      const items = await fetchRuntimeLogs({
        targetSystem: logsTarget.name,
        level: logsLevel || undefined,
        limit: 200,
      });
      if (logsRequestSeqRef.current === requestSeq) {
        setLogsCopyState('idle');
        setLogs(items);
      }
    } catch (e: unknown) {
      if (logsRequestSeqRef.current === requestSeq) {
        setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      if (logsRequestSeqRef.current === requestSeq) {
        setLogsLoading(false);
      }
    }
  }, [logsClearing, logsLevel, logsTarget]);

  const clearLogs = useCallback(async () => {
    if (!logsTarget) return;
    logsRequestSeqRef.current += 1;
    setLogsLoading(false);
    setLogsClearing(true);
    try {
      const result = await clearRuntimeLogs({ targetSystem: logsTarget.name });
      setLogs([]);
      setLogsCopyState('idle');
      setMessage(
        `Cleared ${result.cleared} buffered logs for ${logsTarget.name}`,
      );
    } catch (e: unknown) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLogsClearing(false);
    }
  }, [logsTarget]);

  const copyLogs = useCallback(async () => {
    if (logs.length === 0) return;
    const text = formatRuntimeLogsForCopy(logs);
    try {
      await navigator.clipboard.writeText(text);
      setLogsCopyState('copied');
    } catch (e: unknown) {
      setLogsCopyState('failed');
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [logs]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadDebugStatus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadDebugStatus]);

  useEffect(() => {
    if (!logsTarget) return;
    const timer = window.setTimeout(() => {
      void loadLogs();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadLogs, logsTarget]);

  useEffect(() => {
    if (!logsTarget || !logsAutoRefresh || logsClearing) return;
    const timer = window.setInterval(() => {
      void loadLogs();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [loadLogs, logsAutoRefresh, logsClearing, logsTarget]);

  useEffect(() => {
    if (debugSessions.length === 0 && !debugTarget) return;
    const timer = window.setInterval(() => {
      void loadDebugStatus();
    }, 30000);
    return () => window.clearInterval(timer);
  }, [debugSessions.length, debugTarget, loadDebugStatus]);

  useEffect(() => {
    if (debugSessions.length === 0) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setDebugSessions((sessions) =>
        sessions.filter((session) => Date.parse(session.expiresAt) > now),
      );
    }, 1000);
    return () => window.clearInterval(timer);
  }, [debugSessions.length]);

  useEffect(() => {
    if (!logsTarget) return;
    logsCloseRef.current?.focus();
  }, [logsTarget]);

  useEffect(() => {
    if (!debugTarget) return;
    debugCloseRef.current?.focus();
  }, [debugTarget]);

  const resetForm = () => {
    setForm(newForm(defaultWritableType));
    setEditing(false);
    setFormExpanded(false);
    setMessage('');
    setConfigErrors({});
  };

  const toggleFormExpanded = () => {
    const nextExpanded = !formExpanded;
    if (
      nextExpanded &&
      !editing &&
      writableTypes.length > 0 &&
      !writableTypes.includes(form.type)
    ) {
      setForm(newForm(defaultWritableType));
      setConfigErrors({});
    }
    setFormExpanded(nextExpanded);
  };

  const handleSave = async () => {
    const { config, errors } = buildConfig(form);
    setConfigErrors(errors);
    if (Object.keys(errors).length > 0) {
      setMessage('Fix invalid connector config JSON before saving');
      return;
    }
    setSaving(true);
    try {
      if (editing && form.id) {
        await updateTargetSystem(form.id, {
          name: form.name,
          type: form.type,
          label: form.label,
          config,
          enabled: form.enabled,
        });
        setMessage('Updated successfully');
      } else {
        await createTargetSystem({
          name: form.name,
          type: form.type,
          label: form.label,
          config,
          enabled: form.enabled,
        });
        setMessage('Created successfully');
      }
      resetForm();
      await load();
    } catch (e: unknown) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const setConfigValue = (fieldName: string, value: string) => {
    setConfigErrors((current) => {
      if (current[fieldName] === undefined) return current;
      const next = { ...current };
      delete next[fieldName];
      return next;
    });
    setForm((current) => ({
      ...current,
      configValues: {
        ...current.configValues,
        [fieldName]: value,
      },
    }));
  };

  const handleEdit = (item: TargetSystem) => {
    const rawConfig = item.config ?? {};
    const fieldNames = new Set(
      TYPE_FIELDS[item.type]?.map((f) => f.name) ?? [],
    );
    const configValues: Record<string, string> = {};
    const extraConfig: Record<string, unknown> = {};

    const fieldByName = new Map(
      (TYPE_FIELDS[item.type] ?? []).map((f) => [f.name, f]),
    );

    Object.entries(rawConfig).forEach(([key, value]) => {
      if (key === 'retryPolicy') {
        return;
      }
      if (fieldNames.has(key)) {
        if (isSecretConfigKey(key) && isMaskedSecretPlaceholder(value)) {
          configValues[key] = '';
          return;
        }
        const field = fieldByName.get(key);
        configValues[key] =
          field?.inputType === 'json'
            ? JSON.stringify(value, null, 2)
            : String(value ?? '');
      } else {
        extraConfig[key] = value;
      }
    });

    setForm({
      id: item.id,
      name: item.name,
      type: item.type,
      label: item.label,
      configValues,
      retryPolicy: retryPolicyFromConfig(rawConfig),
      extraConfig,
      enabled: item.enabled,
    });
    setEditing(true);
    setFormExpanded(true);
    setMessage('');
    setConfigErrors({});
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this target system?')) {
      return;
    }
    setDeletingId(id);
    try {
      await deleteTargetSystem(id);
      setMessage('Deleted successfully');
      await load();
    } catch (e: unknown) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeletingId(null);
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const result = await testTargetSystemConnection(id);
      setMessage(result.message);
    } catch (e: unknown) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTestingId(null);
    }
  };

  const handleCreateLinuxProfile = async () => {
    if (!linuxFleetTarget) return;
    setLinuxFleetSaving(true);
    try {
      await createLinuxCredentialProfile(linuxFleetTarget.id, {
        name: linuxProfileForm.name,
        mode: linuxProfileForm.mode,
        username: linuxProfileForm.username,
        privateKeyRef: linuxProfileForm.privateKeyRef || undefined,
        passwordRef: linuxProfileForm.passwordRef || undefined,
        enabled: linuxProfileForm.enabled,
      });
      setLinuxProfileForm({
        name: '',
        mode: 'env',
        username: '',
        privateKeyRef: '',
        passwordRef: '',
        enabled: true,
      });
      await loadLinuxFleet(linuxFleetTarget);
      setMessage('Linux credential profile created');
    } catch (e: unknown) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLinuxFleetSaving(false);
    }
  };

  const handleCreateLinuxHost = async () => {
    if (!linuxFleetTarget) return;
    setLinuxFleetSaving(true);
    try {
      await createLinuxHost(linuxFleetTarget.id, {
        name: linuxHostForm.name,
        host: linuxHostForm.host,
        port: positiveInteger(linuxHostForm.port),
        hostFingerprint: linuxHostForm.hostFingerprint,
        credentialProfileId: linuxHostForm.credentialProfileId || null,
        enabled: linuxHostForm.enabled,
      });
      setLinuxHostForm({
        name: '',
        host: '',
        port: '22',
        hostFingerprint: '',
        credentialProfileId: '',
        enabled: true,
      });
      await loadLinuxFleet(linuxFleetTarget);
      setMessage('Linux host created');
    } catch (e: unknown) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLinuxFleetSaving(false);
    }
  };

  const handleCreateLinuxGroup = async () => {
    if (!linuxFleetTarget) return;
    setLinuxFleetSaving(true);
    try {
      await createLinuxServerGroup(linuxFleetTarget.id, {
        code: linuxGroupForm.code,
        name: linuxGroupForm.name,
        description: linuxGroupForm.description || undefined,
        enabled: linuxGroupForm.enabled,
      });
      setLinuxGroupForm({
        code: '',
        name: '',
        description: '',
        enabled: true,
      });
      await loadLinuxFleet(linuxFleetTarget);
      setMessage('Linux server group created');
    } catch (e: unknown) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLinuxFleetSaving(false);
    }
  };

  const handleSaveLinuxGroupHosts = async (groupId: string) => {
    if (!linuxFleetTarget) return;
    setLinuxFleetSaving(true);
    try {
      await setLinuxServerGroupHosts(
        groupId,
        linuxGroupHostDrafts[groupId] ?? [],
      );
      await loadLinuxFleet(linuxFleetTarget);
      setMessage('Linux server group hosts saved');
    } catch (e: unknown) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLinuxFleetSaving(false);
    }
  };

  const toggleLinuxGroupHost = (
    groupId: string,
    hostId: string,
    checked: boolean,
  ) => {
    setLinuxGroupHostDrafts((current) => {
      const ids = new Set(current[groupId] ?? []);
      if (checked) {
        ids.add(hostId);
      } else {
        ids.delete(hostId);
      }
      return { ...current, [groupId]: [...ids] };
    });
  };

  const restoreModalFocus = useCallback(() => {
    lastModalTriggerRef.current?.focus();
    lastModalTriggerRef.current = null;
  }, []);

  const closeLogs = useCallback(() => {
    setLogsTarget(null);
    setLogsAutoRefresh(false);
    setLogsCopyState('idle');
    restoreModalFocus();
  }, [restoreModalFocus]);

  const closeDebug = useCallback(() => {
    setDebugTarget(null);
    restoreModalFocus();
  }, [restoreModalFocus]);

  useEffect(() => {
    if (!logsTarget && !debugTarget) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (logsTarget) {
        closeLogs();
      } else if (debugTarget) {
        closeDebug();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closeDebug, closeLogs, debugTarget, logsTarget]);

  const openLogs = (item: TargetSystem) => {
    lastModalTriggerRef.current = document.activeElement as HTMLElement | null;
    setLogsTarget(item);
    setLogs([]);
    setLogsLevel('');
    setLogsCopyState('idle');
  };

  const openDebug = async (item: TargetSystem) => {
    lastModalTriggerRef.current = document.activeElement as HTMLElement | null;
    setDebugTarget(item);
    setDebugLevel('Basic');
    setDebugTtlSeconds(300);
    await loadDebugStatus();
  };

  const handleEnableDebug = async () => {
    if (!debugTarget) return;
    setDebugSaving(true);
    try {
      await enableRuntimeDebug({
        targetSystem: debugTarget.name,
        level: debugLevel,
        ttlSeconds: debugTtlSeconds,
      });
      await loadDebugStatus();
      setMessage(`Temporary debug enabled for ${debugTarget.name}`);
    } catch (e: unknown) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDebugSaving(false);
    }
  };

  const handleDisableDebug = async (id: string) => {
    setDebugSaving(true);
    try {
      await disableRuntimeDebug(id);
      await loadDebugStatus();
      setMessage('Temporary debug disabled');
    } catch (e: unknown) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDebugSaving(false);
    }
  };

  const currentFields = TYPE_FIELDS[form.type] ?? [];
  const extraConfigEntries = Object.entries(form.extraConfig);
  const configHasErrors = Object.keys(configErrors).length > 0;
  const canSaveCurrentForm = canWriteConnector(
    effectivePermissions,
    form.type,
    authEnabled,
  );
  const createReadonlyReason =
    writableTypes.length === 0
      ? permissionsStatus === 'failed'
        ? 'Cannot load RBAC permissions. Create and edit actions are disabled.'
        : permissionsStatus === 'loading'
          ? 'Loading RBAC permissions. Create and edit actions are disabled.'
          : 'No write permissions for target system connector types.'
      : '';
  const formPanelId = 'target-system-form-panel';
  const activeDebugForTarget = (targetSystem: string) =>
    debugSessions.filter((session) => session.targetSystem === targetSystem);
  const trapModalKeyboard = (
    event: KeyboardEvent,
    panelRef: RefObject<HTMLDivElement | null>,
    close: () => void,
  ) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((element) => !element.hasAttribute('disabled'));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="page-shell">
      <div className="page-title-row">
        <h1>Target Systems</h1>
        <button className="button" onClick={load} disabled={loading}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {message && <div className="message">{message}</div>}

      <section className="panel">
        <div className="section-title-row">
          <button
            className="disclosure-heading"
            type="button"
            aria-expanded={formExpanded}
            aria-controls={formPanelId}
            onClick={toggleFormExpanded}
          >
            <span className="disclosure-indicator" aria-hidden="true">
              {formExpanded ? 'v' : '>'}
            </span>
            <span className="disclosure-title">
              {editing
                ? `Edit target system: ${form.name}`
                : 'Create target system'}
            </span>
          </button>
          {editing && (
            <button className="button" onClick={resetForm}>
              Cancel
            </button>
          )}
        </div>

        {formExpanded && (
          <div className="collapsible-panel-body" id={formPanelId}>
            {createReadonlyReason && (
              <div className="error-text">{createReadonlyReason}</div>
            )}
            <div className="form-grid">
              <label htmlFor="target-system-name">
                Name
                <input
                  id="target-system-name"
                  value={form.name}
                  disabled={!!createReadonlyReason}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label htmlFor="target-system-type">
                Type
                <select
                  id="target-system-type"
                  value={form.type}
                  disabled={!!createReadonlyReason}
                  onChange={(e) => {
                    setConfigErrors({});
                    setForm({
                      ...form,
                      type: e.target.value,
                      configValues: {},
                      extraConfig: {},
                    });
                  }}
                >
                  {writableTypes.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="target-system-label">
                Label
                <input
                  id="target-system-label"
                  value={form.label}
                  disabled={!!createReadonlyReason}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                />
              </label>
              <label className="checkbox-row">
                <input
                  id="target-system-enabled"
                  type="checkbox"
                  checked={form.enabled}
                  disabled={!!createReadonlyReason}
                  onChange={(e) =>
                    setForm({ ...form, enabled: e.target.checked })
                  }
                />
                Enabled
              </label>
            </div>

            <fieldset className="fieldset">
              <legend>Connector config</legend>
              <div className="form-grid">
                {currentFields.map((field) => {
                  const error = configErrors[field.name];
                  const fieldId = `config-${field.name}`;
                  const errorId = `${fieldId}-error`;
                  const descriptionId = `${fieldId}-help`;
                  const describedBy = [
                    field.help ? descriptionId : undefined,
                    error ? errorId : undefined,
                  ]
                    .filter(Boolean)
                    .join(' ');
                  const commonProps = {
                    id: fieldId,
                    disabled: !!createReadonlyReason,
                    'aria-invalid': error ? true : undefined,
                    'aria-describedby': describedBy || undefined,
                  };
                  return (
                    <label key={field.name} htmlFor={fieldId}>
                      {field.label}
                      {field.options ? (
                        <select
                          {...commonProps}
                          value={
                            form.configValues[field.name] ??
                            field.defaultValue ??
                            ''
                          }
                          onChange={(e) =>
                            setConfigValue(field.name, e.target.value)
                          }
                        >
                          {field.options.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : field.inputType === 'json' ? (
                        <textarea
                          {...commonProps}
                          className="mono"
                          rows={5}
                          placeholder={field.placeholder}
                          value={form.configValues[field.name] ?? ''}
                          onChange={(e) =>
                            setConfigValue(field.name, e.target.value)
                          }
                        />
                      ) : (
                        <input
                          {...commonProps}
                          type={field.inputType ?? 'text'}
                          placeholder={field.placeholder}
                          value={form.configValues[field.name] ?? ''}
                          onChange={(e) =>
                            setConfigValue(field.name, e.target.value)
                          }
                        />
                      )}
                      {field.help && (
                        <span className="field-help" id={descriptionId}>
                          {field.help}
                        </span>
                      )}
                      {error && (
                        <span className="error-text" id={errorId}>
                          {error}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
              {extraConfigEntries.length > 0 && (
                <details className="config-details">
                  <summary>
                    <span>Additional config keys</span>
                    <span className="details-count">
                      {extraConfigEntries.length}
                    </span>
                  </summary>
                  <p className="details-note">
                    Preserved in TargetSystem.config but not edited by this
                    form.
                  </p>
                  <dl className="extra-config-list">
                    {extraConfigEntries.map(([key, value]) => {
                      const formatted = formatExtraConfigValue(key, value);
                      return (
                        <div className="extra-config-row" key={key}>
                          <dt className="mono">{key}</dt>
                          <dd title={formatted}>{formatted}</dd>
                        </div>
                      );
                    })}
                  </dl>
                </details>
              )}
            </fieldset>

            <fieldset className="fieldset">
              <legend>DLQ retry policy</legend>
              <div className="form-grid">
                <label>
                  Max retries
                  <input
                    inputMode="numeric"
                    value={form.retryPolicy.maxRetries}
                    disabled={!!createReadonlyReason}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        retryPolicy: {
                          ...form.retryPolicy,
                          maxRetries: e.target.value,
                        },
                      })
                    }
                  />
                </label>
                <label>
                  Base delay ms
                  <input
                    inputMode="numeric"
                    value={form.retryPolicy.baseDelayMs}
                    disabled={!!createReadonlyReason}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        retryPolicy: {
                          ...form.retryPolicy,
                          baseDelayMs: e.target.value,
                        },
                      })
                    }
                  />
                </label>
                <label>
                  Max delay ms
                  <input
                    inputMode="numeric"
                    value={form.retryPolicy.maxDelayMs}
                    disabled={!!createReadonlyReason}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        retryPolicy: {
                          ...form.retryPolicy,
                          maxDelayMs: e.target.value,
                        },
                      })
                    }
                  />
                </label>
                <label>
                  DLQ lease seconds
                  <input
                    inputMode="numeric"
                    value={form.retryPolicy.dlqLeaseSeconds}
                    disabled={!!createReadonlyReason}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        retryPolicy: {
                          ...form.retryPolicy,
                          dlqLeaseSeconds: e.target.value,
                        },
                      })
                    }
                  />
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={form.retryPolicy.jitter}
                    disabled={!!createReadonlyReason}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        retryPolicy: {
                          ...form.retryPolicy,
                          jitter: e.target.checked,
                        },
                      })
                    }
                  />
                  Jitter
                </label>
              </div>
            </fieldset>

            <button
              className="button primary"
              onClick={handleSave}
              disabled={
                saving ||
                !!createReadonlyReason ||
                !canSaveCurrentForm ||
                configHasErrors
              }
            >
              {saving ? 'Saving...' : editing ? 'Update' : 'Create'}
            </button>
          </div>
        )}
      </section>

      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Label</th>
            <th>Enabled</th>
            <th>Retry policy</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const retryPolicy = retryPolicyFromConfig(item.config ?? {});
            const retrySummary = [
              retryPolicy.maxRetries ? `${retryPolicy.maxRetries} retries` : '',
              retryPolicy.dlqLeaseSeconds
                ? `${retryPolicy.dlqLeaseSeconds}s lease`
                : '',
            ]
              .filter(Boolean)
              .join(', ');

            return (
              <tr key={item.id}>
                <td className="mono">{item.name}</td>
                <td>{item.type}</td>
                <td>{item.label}</td>
                <td>
                  <span
                    className={`badge ${item.enabled ? 'resolved' : 'skipped'}`}
                  >
                    {item.enabled ? 'enabled' : 'disabled'}
                  </span>
                </td>
                <td>{retrySummary || 'default'}</td>
                <td>
                  <div className="actions">
                    <button
                      className="button small"
                      onClick={() => handleTest(item.id)}
                      disabled={
                        testingId === item.id ||
                        !canWriteConnector(
                          effectivePermissions,
                          item.type,
                          authEnabled,
                        )
                      }
                    >
                      {testingId === item.id ? 'Testing...' : 'Test'}
                    </button>
                    <button
                      className="button small"
                      onClick={() => openLogs(item)}
                    >
                      Logs
                    </button>
                    <button
                      className="button small"
                      onClick={() => void openDebug(item)}
                    >
                      Debug
                      {activeDebugForTarget(item.name).length > 0 && (
                        <span className="button-indicator" aria-label="active">
                          on
                        </span>
                      )}
                    </button>
                    {item.type === 'linux' && (
                      <button
                        className="button small"
                        onClick={() => void openLinuxFleet(item)}
                      >
                        Fleet
                      </button>
                    )}
                    <button
                      className="button small"
                      onClick={() => handleEdit(item)}
                      disabled={
                        !canWriteConnector(
                          effectivePermissions,
                          item.type,
                          authEnabled,
                        )
                      }
                    >
                      Edit
                    </button>
                    <button
                      className="button danger small"
                      onClick={() => handleDelete(item.id)}
                      disabled={
                        deletingId === item.id ||
                        !canWriteConnector(
                          effectivePermissions,
                          item.type,
                          authEnabled,
                        )
                      }
                    >
                      {deletingId === item.id ? 'Deleting...' : 'Delete'}
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {linuxFleetTarget && (
        <section className="panel linux-fleet-panel">
          <div className="section-title-row">
            <h2>Linux Fleet: {linuxFleetTarget.name}</h2>
            <div className="actions">
              <button
                className="button"
                onClick={() => void loadLinuxFleet(linuxFleetTarget)}
                disabled={linuxFleetLoading}
              >
                {linuxFleetLoading ? 'Loading...' : 'Refresh'}
              </button>
              <button
                className="button"
                onClick={() => setLinuxFleetTarget(null)}
              >
                Close
              </button>
            </div>
          </div>

          <div className="fleet-grid">
            <section className="fleet-column">
              <h3>Credential profiles</h3>
              <div className="form-grid single">
                <label>
                  Name
                  <input
                    value={linuxProfileForm.name}
                    onChange={(e) =>
                      setLinuxProfileForm({
                        ...linuxProfileForm,
                        name: e.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  Mode
                  <select
                    value={linuxProfileForm.mode}
                    onChange={(e) =>
                      setLinuxProfileForm({
                        ...linuxProfileForm,
                        mode: e.target.value === 'aapm' ? 'aapm' : 'env',
                      })
                    }
                  >
                    <option value="env">env</option>
                    <option value="aapm">aapm</option>
                  </select>
                </label>
                <label>
                  Username
                  <input
                    value={linuxProfileForm.username}
                    onChange={(e) =>
                      setLinuxProfileForm({
                        ...linuxProfileForm,
                        username: e.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  Private key ref
                  <input
                    placeholder="env:LINUX_SSH_KEY"
                    value={linuxProfileForm.privateKeyRef}
                    onChange={(e) =>
                      setLinuxProfileForm({
                        ...linuxProfileForm,
                        privateKeyRef: e.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  Password ref
                  <input
                    placeholder="env:LINUX_SSH_PASSWORD"
                    value={linuxProfileForm.passwordRef}
                    onChange={(e) =>
                      setLinuxProfileForm({
                        ...linuxProfileForm,
                        passwordRef: e.target.value,
                      })
                    }
                  />
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={linuxProfileForm.enabled}
                    onChange={(e) =>
                      setLinuxProfileForm({
                        ...linuxProfileForm,
                        enabled: e.target.checked,
                      })
                    }
                  />
                  Enabled
                </label>
                <button
                  className="button primary"
                  onClick={() => void handleCreateLinuxProfile()}
                  disabled={
                    linuxFleetSaving ||
                    !canWriteConnector(
                      effectivePermissions,
                      linuxFleetTarget.type,
                      authEnabled,
                    )
                  }
                >
                  Add profile
                </button>
              </div>
              <table className="data-table compact-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Mode</th>
                    <th>User</th>
                    <th>Enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {linuxProfiles.map((profile) => (
                    <tr key={profile.id}>
                      <td>{profile.name}</td>
                      <td>{profile.mode}</td>
                      <td className="mono">{profile.username}</td>
                      <td>{profile.enabled ? 'yes' : 'no'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="fleet-column">
              <h3>Hosts</h3>
              <div className="form-grid single">
                <label>
                  Name
                  <input
                    value={linuxHostForm.name}
                    onChange={(e) =>
                      setLinuxHostForm({
                        ...linuxHostForm,
                        name: e.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  Host
                  <input
                    value={linuxHostForm.host}
                    onChange={(e) =>
                      setLinuxHostForm({
                        ...linuxHostForm,
                        host: e.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  Port
                  <input
                    inputMode="numeric"
                    value={linuxHostForm.port}
                    onChange={(e) =>
                      setLinuxHostForm({
                        ...linuxHostForm,
                        port: e.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  Host fingerprint
                  <input
                    value={linuxHostForm.hostFingerprint}
                    onChange={(e) =>
                      setLinuxHostForm({
                        ...linuxHostForm,
                        hostFingerprint: e.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  Credential profile
                  <select
                    value={linuxHostForm.credentialProfileId}
                    onChange={(e) =>
                      setLinuxHostForm({
                        ...linuxHostForm,
                        credentialProfileId: e.target.value,
                      })
                    }
                  >
                    <option value="">None</option>
                    {linuxProfiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={linuxHostForm.enabled}
                    onChange={(e) =>
                      setLinuxHostForm({
                        ...linuxHostForm,
                        enabled: e.target.checked,
                      })
                    }
                  />
                  Enabled
                </label>
                <button
                  className="button primary"
                  onClick={() => void handleCreateLinuxHost()}
                  disabled={
                    linuxFleetSaving ||
                    !canWriteConnector(
                      effectivePermissions,
                      linuxFleetTarget.type,
                      authEnabled,
                    )
                  }
                >
                  Add host
                </button>
              </div>
              <table className="data-table compact-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Host</th>
                    <th>Profile</th>
                    <th>Enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {linuxHosts.map((host) => (
                    <tr key={host.id}>
                      <td>{host.name}</td>
                      <td className="mono">
                        {host.host}:{host.port}
                      </td>
                      <td>{host.credentialProfile?.name ?? 'none'}</td>
                      <td>{host.enabled ? 'yes' : 'no'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          <section className="fleet-groups">
            <h3>Server groups exposed to Avanpost IDM</h3>
            <div className="form-grid">
              <label>
                Code
                <input
                  value={linuxGroupForm.code}
                  onChange={(e) =>
                    setLinuxGroupForm({
                      ...linuxGroupForm,
                      code: e.target.value,
                    })
                  }
                />
              </label>
              <label>
                Name
                <input
                  value={linuxGroupForm.name}
                  onChange={(e) =>
                    setLinuxGroupForm({
                      ...linuxGroupForm,
                      name: e.target.value,
                    })
                  }
                />
              </label>
              <label>
                Description
                <input
                  value={linuxGroupForm.description}
                  onChange={(e) =>
                    setLinuxGroupForm({
                      ...linuxGroupForm,
                      description: e.target.value,
                    })
                  }
                />
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={linuxGroupForm.enabled}
                  onChange={(e) =>
                    setLinuxGroupForm({
                      ...linuxGroupForm,
                      enabled: e.target.checked,
                    })
                  }
                />
                Enabled
              </label>
              <button
                className="button primary"
                onClick={() => void handleCreateLinuxGroup()}
                disabled={
                  linuxFleetSaving ||
                  !canWriteConnector(
                    effectivePermissions,
                    linuxFleetTarget.type,
                    authEnabled,
                  )
                }
              >
                Add server group
              </button>
            </div>

            <div className="fleet-group-list">
              {linuxGroups.map((group) => (
                <article className="fleet-group-row" key={group.id}>
                  <div>
                    <strong className="mono">{group.code}</strong>
                    <span> {group.name}</span>
                    <span className="field-help">
                      {group.hostCount ?? 0} hosts
                    </span>
                  </div>
                  <div className="fleet-host-checks">
                    {linuxHosts.map((host) => (
                      <label className="checkbox-row" key={host.id}>
                        <input
                          type="checkbox"
                          checked={(
                            linuxGroupHostDrafts[group.id] ?? []
                          ).includes(host.id)}
                          onChange={(e) =>
                            toggleLinuxGroupHost(
                              group.id,
                              host.id,
                              e.target.checked,
                            )
                          }
                        />
                        {host.name}
                      </label>
                    ))}
                  </div>
                  <button
                    className="button small"
                    onClick={() => void handleSaveLinuxGroupHosts(group.id)}
                    disabled={
                      linuxFleetSaving ||
                      !canWriteConnector(
                        effectivePermissions,
                        linuxFleetTarget.type,
                        authEnabled,
                      )
                    }
                  >
                    Save hosts
                  </button>
                </article>
              ))}
              {linuxGroups.length === 0 && (
                <div className="empty-state">No Linux server groups.</div>
              )}
            </div>
          </section>
        </section>
      )}

      {logsTarget && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="target-logs-title"
          onKeyDown={(event) =>
            trapModalKeyboard(event, logsPanelRef, closeLogs)
          }
        >
          <div className="modal-panel wide" ref={logsPanelRef}>
            <div className="section-title-row">
              <h2 id="target-logs-title">Logs: {logsTarget.name}</h2>
              <button className="button" ref={logsCloseRef} onClick={closeLogs}>
                Close
              </button>
            </div>
            <div className="toolbar">
              <label>
                Level
                <select
                  value={logsLevel}
                  onChange={(e) => {
                    setLogsLevel(e.target.value);
                    setLogsCopyState('idle');
                  }}
                >
                  <option value="">All</option>
                  <option value="debug">debug</option>
                  <option value="info">info</option>
                  <option value="warn">warn</option>
                  <option value="error">error</option>
                </select>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={logsAutoRefresh}
                  onChange={(e) => setLogsAutoRefresh(e.target.checked)}
                />
                Auto-refresh
              </label>
              <button
                className="button"
                onClick={() => void loadLogs()}
                disabled={logsLoading || logsClearing}
              >
                {logsLoading ? 'Refreshing...' : 'Refresh'}
              </button>
              <button
                className="button"
                onClick={() => void copyLogs()}
                disabled={logs.length === 0}
              >
                {logsCopyState === 'copied'
                  ? 'Copied'
                  : logsCopyState === 'failed'
                    ? 'Copy failed'
                    : 'Copy all'}
              </button>
              <button
                className="button danger"
                onClick={() => void clearLogs()}
                disabled={logsClearing || logsLoading}
              >
                {logsClearing ? 'Clearing...' : 'Clear'}
              </button>
            </div>
            {logsCopyState === 'copied' && (
              <div className="message" role="status">
                Logs copied to clipboard.
              </div>
            )}
            {logsCopyState === 'failed' && (
              <div className="error-text" role="alert">
                Could not copy logs. Select the visible log text and copy it
                manually.
              </div>
            )}
            <div className="log-viewer" aria-live="polite">
              {logs.length === 0 ? (
                <div className="empty-state">
                  No buffered logs for this target system.
                </div>
              ) : (
                logs.map((item) => (
                  <RuntimeLogEntry item={item} key={item.id} />
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {debugTarget && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="target-debug-title"
          onKeyDown={(event) =>
            trapModalKeyboard(event, debugPanelRef, closeDebug)
          }
        >
          <div className="modal-panel" ref={debugPanelRef}>
            <div className="section-title-row">
              <h2 id="target-debug-title">Debug: {debugTarget.name}</h2>
              <button
                className="button"
                ref={debugCloseRef}
                onClick={closeDebug}
              >
                Close
              </button>
            </div>
            <div className="form-grid">
              <label>
                Level
                <select
                  value={debugLevel}
                  onChange={(e) =>
                    setDebugLevel(
                      e.target.value === 'Verbose' ? 'Verbose' : 'Basic',
                    )
                  }
                >
                  <option value="Basic">Basic</option>
                  <option value="Verbose">Verbose</option>
                </select>
              </label>
              <label>
                Duration
                <select
                  value={debugTtlSeconds}
                  onChange={(e) => setDebugTtlSeconds(Number(e.target.value))}
                >
                  <option value={300}>5m</option>
                  <option value={900}>15m</option>
                  <option value={1800}>30m</option>
                  <option value={14400}>4h</option>
                </select>
              </label>
            </div>
            {debugLevel === 'Verbose' && (
              <div className="error-text" role="alert">
                Verbose debug can expose detailed diagnostic summaries. Use it
                only temporarily; 4h is intended for long incident reproduction.
              </div>
            )}
            <button
              className="button primary"
              onClick={() => void handleEnableDebug()}
              disabled={debugSaving}
            >
              {debugSaving ? 'Enabling...' : 'Enable temporary debug'}
            </button>
            <button
              className="button"
              onClick={() => void loadDebugStatus()}
              disabled={debugSaving}
            >
              Refresh
            </button>
            <div className="runtime-debug-list">
              {activeDebugForTarget(debugTarget.name).length === 0 ? (
                <div className="empty-state">
                  No active debug sessions for this target system.
                </div>
              ) : (
                activeDebugForTarget(debugTarget.name).map((session) => (
                  <div className="runtime-debug-row" key={session.id}>
                    <div>
                      <strong>{session.level}</strong>
                      <span>
                        {' '}
                        expires {new Date(session.expiresAt).toLocaleString()}
                      </span>
                    </div>
                    <button
                      className="button small"
                      onClick={() => void handleDisableDebug(session.id)}
                      disabled={debugSaving}
                    >
                      Disable
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
