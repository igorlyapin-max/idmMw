import { useCallback, useEffect, useState } from 'react';
import {
  createTargetSystem,
  deleteTargetSystem,
  fetchTargetSystems,
  testTargetSystemConnection,
  updateTargetSystem,
  type TargetSystem,
} from '../api/client';

const TYPE_OPTIONS = ['zabbix', 'cmdbuild', 'passwork', 'rest', 'db', 'fake'];

interface ConfigField {
  name: string;
  label: string;
  help?: string;
  inputType?: 'password' | 'text';
  placeholder?: string;
  defaultValue?: string;
  options?: Array<{ value: string; label: string }>;
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
  rest: [{ name: 'baseUrl', label: 'Base URL' }],
  db: [
    { name: 'client', label: 'Dialect (pg | mysql2 | sqlite3 | oracledb)' },
    { name: 'connection', label: 'Connection string / Oracle connectString' },
    { name: 'username', label: 'Username (Oracle)' },
    { name: 'password', label: 'Password (Oracle)', inputType: 'password' },
  ],
  fake: [
    { name: 'baseUrl', label: 'Base URL' },
    { name: 'apiKey', label: 'API key', inputType: 'password' },
    { name: 'timeout', label: 'Timeout ms' },
  ],
};

function newForm(): TargetSystemForm {
  return {
    ...EMPTY_FORM,
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

function buildConfig(form: TargetSystemForm): Record<string, unknown> {
  const cfg: Record<string, unknown> = { ...form.extraConfig };
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
    if (value !== undefined && value !== '') {
      cfg[field.name] = value;
    }
  });

  const retryPolicy = buildRetryPolicy(form.retryPolicy);
  if (retryPolicy) {
    cfg['retryPolicy'] = retryPolicy;
  }

  return cfg;
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

const SECRET_CONFIG_KEY_PATTERN = /(pass|token|secret|key|code|credential)/i;

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

export function TargetSystemsPage() {
  const [items, setItems] = useState<TargetSystem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [form, setForm] = useState<TargetSystemForm>(() => newForm());
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState('');

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

  const resetForm = () => {
    setForm(newForm());
    setEditing(false);
    setMessage('');
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const config = buildConfig(form);
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

  const handleEdit = (item: TargetSystem) => {
    const rawConfig = item.config ?? {};
    const fieldNames = new Set(
      TYPE_FIELDS[item.type]?.map((f) => f.name) ?? [],
    );
    const configValues: Record<string, string> = {};
    const extraConfig: Record<string, unknown> = {};

    Object.entries(rawConfig).forEach(([key, value]) => {
      if (key === 'retryPolicy') {
        return;
      }
      if (fieldNames.has(key)) {
        configValues[key] =
          isSecretConfigKey(key) && isMaskedSecretPlaceholder(value)
            ? ''
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
    setMessage('');
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

  const currentFields = TYPE_FIELDS[form.type] ?? [];
  const extraConfigEntries = Object.entries(form.extraConfig);

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
          <h2>{editing ? 'Edit target system' : 'Create target system'}</h2>
          {editing && (
            <button className="button" onClick={resetForm}>
              Cancel
            </button>
          )}
        </div>

        <div className="form-grid">
          <label>
            Name
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            Type
            <select
              value={form.type}
              onChange={(e) =>
                setForm({
                  ...form,
                  type: e.target.value,
                  configValues: {},
                  extraConfig: {},
                })
              }
            >
              {TYPE_OPTIONS.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label>
            Label
            <input
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            Enabled
          </label>
        </div>

        <fieldset className="fieldset">
          <legend>Connector config</legend>
          <div className="form-grid">
            {currentFields.map((field) => (
              <label key={field.name}>
                {field.label}
                {field.options ? (
                  <select
                    value={
                      form.configValues[field.name] ?? field.defaultValue ?? ''
                    }
                    onChange={(e) =>
                      setForm({
                        ...form,
                        configValues: {
                          ...form.configValues,
                          [field.name]: e.target.value,
                        },
                      })
                    }
                  >
                    {field.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={field.inputType ?? 'text'}
                    placeholder={field.placeholder}
                    value={form.configValues[field.name] ?? ''}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        configValues: {
                          ...form.configValues,
                          [field.name]: e.target.value,
                        },
                      })
                    }
                  />
                )}
                {field.help && <span className="field-help">{field.help}</span>}
              </label>
            ))}
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
                Preserved in TargetSystem.config but not edited by this form.
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
          disabled={saving}
        >
          {saving ? 'Saving...' : editing ? 'Update' : 'Create'}
        </button>
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
                      disabled={testingId === item.id}
                    >
                      {testingId === item.id ? 'Testing...' : 'Test'}
                    </button>
                    <button
                      className="button small"
                      onClick={() => handleEdit(item)}
                    >
                      Edit
                    </button>
                    <button
                      className="button danger small"
                      onClick={() => handleDelete(item.id)}
                      disabled={deletingId === item.id}
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
    </div>
  );
}
