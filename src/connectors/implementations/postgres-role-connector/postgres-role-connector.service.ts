import { Injectable, Logger, Optional } from '@nestjs/common';
import { Pool, PoolClient, PoolConfig } from 'pg';
import {
  Connector,
  ConnectorCapabilities,
  ConnectorPayload,
  ConnectorResult,
} from '../../connector.interface';
import { createConnectorCapabilities } from '../../connector.capabilities';
import { safeConnectorErrorMessage } from '../../connector-error.util';
import {
  DbConnectorTlsConfig,
  TlsOptionsFactory,
} from '../../../security/tls-options.factory';

interface PostgresRoleConfig {
  connectionString?: string;
  tls?: DbConnectorTlsConfig;
  rolePrefix?: string;
  managedRolePrefix?: string;
  rolePolicyMode?: 'managed-namespace' | 'idm-full-control';
  permissionPolicyMode?: 'disabled' | 'managed-allowlist' | 'idm-full-control';
  allowedPermissions?: PostgresPermission[];
  defaultDatabase?: string;
  defaultLogin?: boolean;
  defaultRoles?: string[];
  defaultPermissions?: PostgresPermission[];
  physicalDeleteEnabled?: boolean;
  physicalRoleDeleteEnabled?: boolean;
  statementTimeoutMs?: number;
}

interface PostgresUserData extends Record<string, unknown> {
  login?: unknown;
  username?: unknown;
  managedLogin?: unknown;
  email?: unknown;
  password?: unknown;
  newValue?: unknown;
  roles?: unknown;
  permissions?: unknown;
  enabled?: unknown;
}

interface PostgresGroupData extends Record<string, unknown> {
  name?: unknown;
  role?: unknown;
  group?: unknown;
  login?: unknown;
  username?: unknown;
  managedLogin?: unknown;
}

interface PostgresPermission {
  action?: unknown;
  permission?: unknown;
  scope?: unknown;
}

interface NormalizedPostgresPermission {
  action: 'GRANT' | 'REVOKE';
  permission: string;
  scope: string;
}

type PostgresQueryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

const POSTGRES_ROLE_PARTIAL_OPERATIONS: Record<string, string> = {
  'user.delete':
    'Default mapping is safe disable (ALTER ROLE NOLOGIN); physical DROP ROLE requires physicalDeleteEnabled=true.',
  'user.lock': 'Mapped to ALTER ROLE NOLOGIN.',
  'user.disable': 'Mapped to ALTER ROLE NOLOGIN.',
  'user.unlock': 'Mapped to ALTER ROLE LOGIN.',
  'user.enable': 'Mapped to ALTER ROLE LOGIN.',
  'group.delete':
    'DROP ROLE requires physicalRoleDeleteEnabled=true; otherwise role delete is rejected.',
  'group.update': 'PostgreSQL role rename is out of first connector scope.',
};

const POSTGRES_ROLE_UNSUPPORTED_OPERATIONS: Record<string, string> = {
  'user.addAttributes':
    'PostgreSQL role custom attribute mapping is not supported.',
  'user.removeAttributes':
    'PostgreSQL role custom attribute mapping is not supported.',
};

@Injectable()
export class PostgresRoleConnectorService implements Connector {
  readonly name = 'postgres-role';
  private readonly logger = new Logger(PostgresRoleConnectorService.name);

  constructor(@Optional() private readonly tlsOptions?: TlsOptionsFactory) {}

  getCapabilities(): ConnectorCapabilities {
    return createConnectorCapabilities(
      POSTGRES_ROLE_PARTIAL_OPERATIONS,
      {},
      POSTGRES_ROLE_UNSUPPORTED_OPERATIONS,
    );
  }

  async execute(payload: ConnectorPayload): Promise<ConnectorResult> {
    const config = payload.payload['config'] as PostgresRoleConfig | undefined;
    const data = (payload.payload['data'] ?? {}) as PostgresUserData &
      PostgresGroupData;
    const params = (payload.payload['params'] ?? {}) as Record<string, unknown>;

    if (!config?.connectionString) {
      return { success: false, error: 'Missing PostgreSQL connectionString' };
    }

    const pool = this.createPool(config);
    try {
      const result = await this.executeWithPool(
        pool,
        payload.operation,
        config,
        data,
        params,
      );
      this.logger.log(
        `PostgreSQL role operation succeeded: ${payload.operation}`,
      );
      return { success: true, data: result };
    } catch (error: unknown) {
      const msg = safeConnectorErrorMessage(error, config, data, params);
      this.logger.error(`PostgreSQL role operation failed: ${msg}`);
      return { success: false, error: msg };
    } finally {
      await pool.end();
    }
  }

  async testConnection(
    config: Record<string, unknown>,
  ): Promise<{ success: boolean; message: string }> {
    const cfg = config as PostgresRoleConfig;
    if (!cfg.connectionString) {
      return { success: false, message: 'Missing PostgreSQL connectionString' };
    }

    const pool = this.createPool(cfg);
    try {
      await pool.query('SELECT 1');
      return { success: true, message: 'PostgreSQL role connection OK' };
    } catch (error: unknown) {
      const msg = safeConnectorErrorMessage(error, cfg);
      return {
        success: false,
        message: `PostgreSQL role connection failed: ${msg}`,
      };
    } finally {
      await pool.end();
    }
  }

  getSchema(): Promise<ConnectorResult> {
    return Promise.resolve({
      success: true,
      data: {
        objectClasses: [
          {
            name: 'user',
            attributes: [
              {
                name: 'login',
                type: 'string',
                required: true,
                multiValued: false,
              },
              {
                name: 'password',
                type: 'string',
                required: true,
                multiValued: false,
              },
              {
                name: 'roles',
                type: 'array',
                required: false,
                multiValued: true,
              },
              {
                name: 'permissions',
                type: 'array',
                required: false,
                multiValued: true,
              },
              {
                name: 'enabled',
                type: 'boolean',
                required: false,
                multiValued: false,
              },
            ],
          },
          {
            name: 'group',
            attributes: [{ name: 'name', type: 'string', required: true }],
          },
        ],
      },
    });
  }

  private async executeWithPool(
    pool: Pool,
    operation: string,
    config: PostgresRoleConfig,
    data: PostgresUserData & PostgresGroupData,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (operation) {
      case 'system.test':
        await pool.query('SELECT 1');
        return { reachable: true };
      case 'schema.get':
        return (await this.getSchema()).data;
      case 'user.create':
        return this.createRole(pool, config, data);
      case 'user.update':
        return this.updateRole(pool, config, data, params);
      case 'user.delete':
        return this.deleteRole(pool, config, data, params);
      case 'user.disable':
      case 'user.lock':
        return this.setLogin(pool, config, data, params, false);
      case 'user.enable':
      case 'user.unlock':
        return this.setLogin(pool, config, data, params, true);
      case 'user.changePassword':
        return this.changePassword(pool, config, data, params);
      case 'user.get':
      case 'user.resolve':
        return this.getRole(pool, config, data, params);
      case 'user.search':
      case 'sync.full':
      case 'sync.incremental':
        return this.searchRoles(pool, config, data);
      case 'group.create':
        return this.createGroupRole(pool, config, data);
      case 'group.update':
        throw new Error('Unsupported PostgreSQL role operation: group.update');
      case 'group.delete':
        return this.deleteGroupRole(pool, config, data, params);
      case 'group.addMember':
        return this.setGroupMembership(pool, config, data, params, true);
      case 'group.removeMember':
        return this.setGroupMembership(pool, config, data, params, false);
      case 'group.get':
        return this.getGroupRole(pool, config, data, params);
      case 'group.search':
        return this.searchGroupRoles(pool, config);
      default:
        throw new Error(`Unsupported PostgreSQL role operation: ${operation}`);
    }
  }

  private async createRole(
    pool: Pool,
    config: PostgresRoleConfig,
    data: PostgresUserData,
  ): Promise<Record<string, unknown>> {
    const login = this.login(data, {}, config);
    const password = this.password(data, true);
    const loginOption = config.defaultLogin === false ? 'NOLOGIN' : 'LOGIN';
    const roles = this.roles(config, data);
    const permissions = this.permissions(config, data);

    await this.withTransaction(pool, async (client) => {
      await client.query(
        `CREATE ROLE ${this.ident(login)} ${loginOption} PASSWORD ${this.literal(password)}`,
      );

      for (const role of roles) {
        await client.query(`GRANT ${this.ident(role)} TO ${this.ident(login)}`);
      }

      for (const permission of permissions) {
        await this.applyPermission(client, config, login, permission);
      }
    });

    return { login, enabled: loginOption === 'LOGIN' };
  }

  private async updateRole(
    pool: Pool,
    config: PostgresRoleConfig,
    data: PostgresUserData,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const login = this.login(data, params, config);
    const roles = this.roles(config, data, false);
    const permissions = this.permissions(config, data, false);
    let changed = false;
    await this.withTransaction(pool, async (client) => {
      if (typeof data.enabled === 'boolean') {
        await client.query(
          `ALTER ROLE ${this.ident(login)} ${data.enabled ? 'LOGIN' : 'NOLOGIN'}`,
        );
        changed = true;
      }
      for (const role of roles) {
        await client.query(`GRANT ${this.ident(role)} TO ${this.ident(login)}`);
        changed = true;
      }
      for (const permission of permissions) {
        await this.applyPermission(client, config, login, permission);
        changed = true;
      }
    });
    return {
      login,
      ...(typeof data.enabled === 'boolean' ? { enabled: data.enabled } : {}),
      changed,
    };
  }

  private async deleteRole(
    pool: Pool,
    config: PostgresRoleConfig,
    data: PostgresUserData,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const login = this.login(data, params, config);
    if (config.physicalDeleteEnabled) {
      await pool.query(`DROP ROLE ${this.ident(login)}`);
      return { login, deleted: true };
    }
    await pool.query(`ALTER ROLE ${this.ident(login)} NOLOGIN`);
    return { login, enabled: false, deleted: false };
  }

  private async setLogin(
    pool: Pool,
    config: PostgresRoleConfig,
    data: PostgresUserData,
    params: Record<string, unknown>,
    enabled: boolean,
  ): Promise<Record<string, unknown>> {
    const login = this.login(data, params, config);
    await pool.query(
      `ALTER ROLE ${this.ident(login)} ${enabled ? 'LOGIN' : 'NOLOGIN'}`,
    );
    return { login, enabled };
  }

  private async changePassword(
    pool: Pool,
    config: PostgresRoleConfig,
    data: PostgresUserData,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const login = this.login(data, params, config);
    const password = this.password(data, true);
    await pool.query(
      `ALTER ROLE ${this.ident(login)} PASSWORD ${this.literal(password)}`,
    );
    return { login, passwordChanged: true };
  }

  private async getRole(
    pool: Pool,
    config: PostgresRoleConfig,
    data: PostgresUserData,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const login = this.login(data, params, config);
    const result = await pool.query(
      'SELECT rolname AS login, rolcanlogin AS "canLogin" FROM pg_roles WHERE rolname = $1',
      [login],
    );
    return result.rows[0] ?? null;
  }

  private async searchRoles(
    pool: Pool,
    config: PostgresRoleConfig,
    data: PostgresUserData,
  ): Promise<Record<string, unknown>> {
    const prefix = this.prefixedValue(
      typeof data.login === 'string' ? data.login : '',
      config,
      false,
    );
    const result = await pool.query(
      'SELECT rolname AS login, rolcanlogin AS "canLogin" FROM pg_roles WHERE rolname LIKE $1 ORDER BY rolname LIMIT 200',
      [`${prefix}%`],
    );
    return { items: result.rows, total: result.rows.length };
  }

  private async createGroupRole(
    pool: Pool,
    config: PostgresRoleConfig,
    data: PostgresGroupData,
  ): Promise<Record<string, unknown>> {
    const role = this.roleName(data, {}, config);
    await pool.query(`CREATE ROLE ${this.ident(role)} NOLOGIN`);
    return { role, created: true };
  }

  private async deleteGroupRole(
    pool: Pool,
    config: PostgresRoleConfig,
    data: PostgresGroupData,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const role = this.roleName(data, params, config);
    if (!config.physicalRoleDeleteEnabled) {
      throw new Error(
        'PostgreSQL DROP ROLE requires physicalRoleDeleteEnabled=true',
      );
    }
    await pool.query(`DROP ROLE ${this.ident(role)}`);
    return { role, deleted: true };
  }

  private async setGroupMembership(
    pool: Pool,
    config: PostgresRoleConfig,
    data: PostgresUserData & PostgresGroupData,
    params: Record<string, unknown>,
    add: boolean,
  ): Promise<Record<string, unknown>> {
    const login = this.login(data, params, config);
    const role = this.roleName(data, params, config);
    await pool.query(
      `${add ? 'GRANT' : 'REVOKE'} ${this.ident(role)} ${add ? 'TO' : 'FROM'} ${this.ident(login)}`,
    );
    return { login, role, member: add };
  }

  private async getGroupRole(
    pool: Pool,
    config: PostgresRoleConfig,
    data: PostgresGroupData,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const role = this.roleName(data, params, config);
    const result = await pool.query(
      'SELECT rolname AS role FROM pg_roles WHERE rolcanlogin = false AND rolname = $1',
      [role],
    );
    return result.rows[0] ?? null;
  }

  private async searchGroupRoles(
    pool: Pool,
    config: PostgresRoleConfig,
  ): Promise<Record<string, unknown>> {
    const prefix = this.managedRolePrefix(config);
    const result =
      this.rolePolicyMode(config) === 'idm-full-control'
        ? await pool.query(
            'SELECT rolname AS role FROM pg_roles WHERE rolcanlogin = false ORDER BY rolname LIMIT 200',
          )
        : await pool.query(
            'SELECT rolname AS role FROM pg_roles WHERE rolcanlogin = false AND rolname LIKE $1 ORDER BY rolname LIMIT 200',
            [`${prefix}%`],
          );
    return { items: result.rows, total: result.rows.length };
  }

  private async applyPermission(
    pool: PostgresQueryable,
    config: PostgresRoleConfig,
    login: string,
    permission: NormalizedPostgresPermission,
  ): Promise<void> {
    const principalKeyword = permission.action === 'REVOKE' ? 'FROM' : 'TO';
    const scope = await this.permissionScope(pool, config, permission.scope);
    await pool.query(
      `${permission.action} ${permission.permission} ${scope} ${principalKeyword} ${this.ident(login)}`,
    );
  }

  private createPool(config: PostgresRoleConfig): Pool {
    const ssl = this.tlsOptions?.dbConnectorSslOptions(config.tls);
    const poolConfig: PoolConfig = {
      connectionString: config.connectionString,
      statement_timeout: config.statementTimeoutMs ?? 30000,
      ...(ssl ? { ssl } : {}),
    };
    return new Pool(poolConfig);
  }

  private async withTransaction<T>(
    pool: Pool,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private login(
    data: PostgresUserData,
    params: Record<string, unknown>,
    config: PostgresRoleConfig,
  ): string {
    const value =
      this.firstString(
        data.login,
        data.managedLogin,
        data.username,
        params['login'],
        params['id'],
      ) ?? this.firstString(data.email);
    if (!value) {
      throw new Error('Missing login for PostgreSQL role operation');
    }
    return this.prefixedValue(value, config, true);
  }

  private prefixedValue(
    value: string,
    config: PostgresRoleConfig,
    requireValid: boolean,
  ): string {
    const login = `${config.rolePrefix ?? ''}${value}`.trim();
    if (requireValid && !/^[A-Za-z_][A-Za-z0-9_@$.-]{0,62}$/.test(login)) {
      throw new Error('Invalid PostgreSQL role login');
    }
    return login;
  }

  private password(data: PostgresUserData, required: boolean): string {
    const value = this.firstString(data.newValue, data.password);
    if (!value && required) {
      throw new Error('Missing password for PostgreSQL role operation');
    }
    return value ?? '';
  }

  private roleName(
    data: PostgresGroupData,
    params: Record<string, unknown>,
    config?: PostgresRoleConfig,
  ): string {
    const value = this.firstString(
      data.role,
      data.name,
      data.group,
      params['role'],
      params['name'],
      params['group'],
    );
    if (!value) {
      throw new Error('Missing role for PostgreSQL group operation');
    }
    const role = this.validateIdentifier(value, 'PostgreSQL group role');
    if (config && this.rolePolicyMode(config) !== 'idm-full-control') {
      const prefix = this.managedRolePrefix(config);
      if (!role.startsWith(prefix)) {
        throw new Error('PostgreSQL group role is outside managed namespace');
      }
    }
    return role;
  }

  private roles(
    config: PostgresRoleConfig,
    data: PostgresUserData,
    includeDefaults = true,
  ): string[] {
    const payloadRoles = Array.isArray(data.roles)
      ? data.roles.filter((role): role is string => typeof role === 'string')
      : [];
    const roles = [
      ...(includeDefaults ? (config.defaultRoles ?? []) : []),
      ...payloadRoles,
    ];
    return roles
      .filter(
        (role): role is string => typeof role === 'string' && role.length > 0,
      )
      .map((role) => this.validateGrantRole(config, role));
  }

  private permissions(
    config: PostgresRoleConfig,
    data: PostgresUserData,
    includeDefaults = true,
  ): NormalizedPostgresPermission[] {
    const payload: unknown[] = Array.isArray(data.permissions)
      ? data.permissions
      : [];
    const permissions = [
      ...(includeDefaults ? (config.defaultPermissions ?? []) : []),
      ...payload,
    ];
    const normalized = permissions.map((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new Error('Invalid PostgreSQL permission');
      }
      const permission = item as PostgresPermission;
      return {
        action: this.permissionAction(permission.action),
        permission: this.permissionName(permission.permission),
        scope: this.permissionScopeValue(permission.scope),
      };
    });
    return normalized.map((permission) =>
      this.validatePermissionPolicy(config, permission),
    );
  }

  private validateGrantRole(config: PostgresRoleConfig, role: string): string {
    const validated = this.validateIdentifier(role, 'PostgreSQL grant role');
    if (this.rolePolicyMode(config) === 'idm-full-control') return validated;
    const prefix = this.managedRolePrefix(config);
    if (!validated.startsWith(prefix)) {
      throw new Error('PostgreSQL grant role is outside managed namespace');
    }
    return validated;
  }

  private validatePermissionPolicy(
    config: PostgresRoleConfig,
    permission: NormalizedPostgresPermission,
  ): NormalizedPostgresPermission {
    const mode = this.permissionPolicyMode(config);
    if (mode === 'idm-full-control') return permission;
    if (mode === 'disabled') {
      throw new Error(
        'PostgreSQL permissions are disabled for this target system',
      );
    }
    const allowed = [
      ...(config.defaultPermissions ?? []),
      ...(config.allowedPermissions ?? []),
    ]
      .filter((item): item is PostgresPermission => Boolean(item))
      .map((item) => ({
        action: this.permissionAction(item.action),
        permission: this.permissionName(item.permission),
        scope: this.permissionScopeValue(item.scope),
      }));
    const allowedKeys = new Set(
      allowed.map((item) => this.permissionKey(item)),
    );
    if (!allowedKeys.has(this.permissionKey(permission))) {
      throw new Error('PostgreSQL permission is outside managed allowlist');
    }
    return permission;
  }

  private permissionAction(value: unknown): 'GRANT' | 'REVOKE' {
    if (value === 'GRANT' || value === 'REVOKE') {
      return value;
    }
    throw new Error('Invalid PostgreSQL permission action');
  }

  private permissionName(value: unknown): string {
    const permission = this.firstString(value)?.toUpperCase();
    if (!permission || !/^[A-Z][A-Z0-9_ ]{0,63}$/.test(permission)) {
      throw new Error('Invalid PostgreSQL permission name');
    }
    return permission;
  }

  private permissionScopeValue(value: unknown): string {
    const scope = this.firstString(value) ?? 'DATABASE';
    if (scope === 'DATABASE') return scope;
    for (const prefix of ['SCHEMA::', 'TABLE::', 'SEQUENCE::', 'FUNCTION::']) {
      if (!scope.startsWith(prefix)) continue;
      const identifier = scope.slice(prefix.length);
      if (prefix === 'SCHEMA::') {
        this.validateIdentifier(identifier, 'PostgreSQL schema');
        return scope;
      }
      const parts = identifier.split('.');
      if (parts.length !== 2) {
        throw new Error(
          `Invalid PostgreSQL ${prefix.slice(0, -2).toLowerCase()} scope`,
        );
      }
      parts.forEach((part) =>
        this.validateIdentifier(part, 'PostgreSQL permission scope'),
      );
      return scope;
    }
    throw new Error('Invalid PostgreSQL permission scope');
  }

  private async permissionScope(
    pool: PostgresQueryable,
    config: PostgresRoleConfig,
    scope: string,
  ): Promise<string> {
    if (scope === 'DATABASE') {
      return `ON DATABASE ${this.ident(await this.database(pool, config))}`;
    }
    if (scope.startsWith('SCHEMA::')) {
      return `ON SCHEMA ${this.ident(scope.slice('SCHEMA::'.length))}`;
    }
    const scopeMap: Record<string, string> = {
      'TABLE::': 'TABLE',
      'SEQUENCE::': 'SEQUENCE',
      'FUNCTION::': 'FUNCTION',
    };
    for (const [prefix, keyword] of Object.entries(scopeMap)) {
      if (!scope.startsWith(prefix)) continue;
      const [schema, objectName] = scope.slice(prefix.length).split('.');
      return `ON ${keyword} ${this.ident(schema)}.${this.ident(objectName)}`;
    }
    throw new Error('Invalid PostgreSQL permission scope');
  }

  private async database(
    pool: PostgresQueryable,
    config: PostgresRoleConfig,
  ): Promise<string> {
    const configured = this.firstString(config.defaultDatabase);
    if (configured) {
      return this.validateIdentifier(configured, 'PostgreSQL database');
    }
    const result = await pool.query<{ database?: unknown }>(
      'SELECT current_database() AS database',
    );
    const value = this.firstString(result.rows?.[0]?.database);
    if (!value) {
      throw new Error('Unable to resolve PostgreSQL current database');
    }
    return this.validateIdentifier(value, 'PostgreSQL database');
  }

  private validateIdentifier(value: string, label: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_@$.-]{0,62}$/.test(value)) {
      throw new Error(`Invalid ${label}`);
    }
    return value;
  }

  private rolePolicyMode(
    config: PostgresRoleConfig,
  ): 'managed-namespace' | 'idm-full-control' {
    return config.rolePolicyMode === 'idm-full-control'
      ? 'idm-full-control'
      : 'managed-namespace';
  }

  private permissionPolicyMode(
    config: PostgresRoleConfig,
  ): 'disabled' | 'managed-allowlist' | 'idm-full-control' {
    if (config.permissionPolicyMode === 'disabled') return 'disabled';
    if (config.permissionPolicyMode === 'idm-full-control') {
      return 'idm-full-control';
    }
    return 'managed-allowlist';
  }

  private managedRolePrefix(config: PostgresRoleConfig): string {
    return (
      this.firstString(config.managedRolePrefix, config.rolePrefix) ?? 'idm_'
    );
  }

  private permissionKey(permission: NormalizedPostgresPermission): string {
    return `${permission.action}:${permission.permission}:${permission.scope}`;
  }

  private firstString(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return undefined;
  }

  private ident(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
  }

  private literal(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }
}
