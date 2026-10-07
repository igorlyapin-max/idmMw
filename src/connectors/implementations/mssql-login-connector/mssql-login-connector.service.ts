import { Injectable, Logger } from '@nestjs/common';
import * as sql from 'mssql';
import {
  Connector,
  ConnectorCapabilities,
  ConnectorPayload,
  ConnectorResult,
} from '../../connector.interface';
import { createConnectorCapabilities } from '../../connector.capabilities';
import { safeConnectorErrorMessage } from '../../connector-error.util';
import {
  groupMappingSettings,
  groupRefValues,
  type GroupMappingConfig,
} from '../../group-mapping.util';

interface MssqlLoginConfig extends GroupMappingConfig {
  connectionString?: string;
  loginPrefix?: string;
  defaultDatabase?: string;
  defaultGroups?: unknown[];
  defaultDatabaseRoles?: string[];
  defaultPermissions?: MssqlPermission[];
  physicalDeleteEnabled?: boolean;
  physicalRoleDeleteEnabled?: boolean;
  statementTimeoutMs?: number;
  tls?: {
    encrypt?: boolean;
    trustServerCertificate?: boolean;
  };
}

interface MssqlUserData extends Record<string, unknown> {
  login?: unknown;
  username?: unknown;
  managedLogin?: unknown;
  email?: unknown;
  password?: unknown;
  newValue?: unknown;
  database?: unknown;
  groups?: unknown;
  roles?: unknown;
  permissions?: unknown;
  enabled?: unknown;
}

interface MssqlGroupData extends Record<string, unknown> {
  name?: unknown;
  role?: unknown;
  group?: unknown;
  login?: unknown;
  username?: unknown;
  managedLogin?: unknown;
  database?: unknown;
}

interface MssqlPermission {
  action?: unknown;
  permission?: unknown;
  scope?: unknown;
}

interface NormalizedMssqlPermission {
  action: 'GRANT' | 'DENY' | 'REVOKE';
  permission: string;
  scope: string;
}

const MSSQL_PARTIAL_OPERATIONS: Record<string, string> = {
  'user.delete':
    'Default mapping is safe disable (ALTER LOGIN DISABLE); physical DROP USER/DROP LOGIN requires physicalDeleteEnabled=true.',
  'group.update': 'MSSQL role rename is out of first connector scope.',
  'group.delete':
    'DROP ROLE requires physicalRoleDeleteEnabled=true; otherwise role delete is rejected.',
};

const MSSQL_UNSUPPORTED_OPERATIONS: Record<string, string> = {
  'user.addAttributes': 'MSSQL login attribute mapping is not supported.',
  'user.removeAttributes': 'MSSQL login attribute mapping is not supported.',
};

@Injectable()
export class MssqlLoginConnectorService implements Connector {
  readonly name = 'mssql-login';
  private readonly logger = new Logger(MssqlLoginConnectorService.name);

  getCapabilities(): ConnectorCapabilities {
    return createConnectorCapabilities(
      MSSQL_PARTIAL_OPERATIONS,
      {},
      MSSQL_UNSUPPORTED_OPERATIONS,
    );
  }

  async execute(payload: ConnectorPayload): Promise<ConnectorResult> {
    const config = payload.payload['config'] as MssqlLoginConfig | undefined;
    const data = (payload.payload['data'] ?? {}) as MssqlUserData &
      MssqlGroupData;
    const params = (payload.payload['params'] ?? {}) as Record<string, unknown>;

    if (!config?.connectionString) {
      return { success: false, error: 'Missing MSSQL connectionString' };
    }

    const pool = await this.connect(config);
    try {
      const result = await this.executeWithPool(
        pool,
        payload.operation,
        config,
        data,
        params,
      );
      this.logger.log(`MSSQL login operation succeeded: ${payload.operation}`);
      return { success: true, data: result };
    } catch (error: unknown) {
      const msg = safeConnectorErrorMessage(error, config, data, params);
      this.logger.error(`MSSQL login operation failed: ${msg}`);
      return { success: false, error: msg };
    } finally {
      await pool.close();
    }
  }

  async testConnection(
    config: Record<string, unknown>,
  ): Promise<{ success: boolean; message: string }> {
    const cfg = config as MssqlLoginConfig;
    if (!cfg.connectionString) {
      return { success: false, message: 'Missing MSSQL connectionString' };
    }

    try {
      const pool = await this.connect(cfg);
      try {
        await pool.request().query('SELECT 1 AS ok');
        return { success: true, message: 'MSSQL login connection OK' };
      } finally {
        await pool.close();
      }
    } catch (error: unknown) {
      const msg = safeConnectorErrorMessage(error, cfg);
      return {
        success: false,
        message: `MSSQL login connection failed: ${msg}`,
      };
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
              { name: 'login', type: 'string', required: true },
              { name: 'password', type: 'string', required: true },
              { name: 'database', type: 'string', required: false },
              { name: 'roles', type: 'array', required: false },
              { name: 'permissions', type: 'array', required: false },
              { name: 'enabled', type: 'boolean', required: false },
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
    pool: sql.ConnectionPool,
    operation: string,
    config: MssqlLoginConfig,
    data: MssqlUserData & MssqlGroupData,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (operation) {
      case 'system.test':
        await pool.request().query('SELECT 1 AS ok');
        return { reachable: true };
      case 'schema.get':
        return (await this.getSchema()).data;
      case 'user.create':
        return this.createLogin(pool, config, data);
      case 'user.update':
        return this.updateLogin(pool, config, data, params);
      case 'user.delete':
        return this.deleteLogin(pool, config, data, params);
      case 'user.disable':
      case 'user.lock':
        return this.setLoginEnabled(pool, config, data, params, false);
      case 'user.enable':
      case 'user.unlock':
        return this.setLoginEnabled(pool, config, data, params, true);
      case 'user.changePassword':
        return this.changePassword(pool, config, data, params);
      case 'user.get':
      case 'user.resolve':
        return this.getLogin(pool, config, data, params);
      case 'user.search':
      case 'sync.full':
      case 'sync.incremental':
        return this.searchLogins(pool, config, data);
      case 'group.create':
        return this.createRole(pool, config, data);
      case 'group.update':
        return { role: this.roleName(data, params), changed: false };
      case 'group.delete':
        return this.deleteRole(pool, config, data, params);
      case 'group.addMember':
        return this.setRoleMembership(pool, config, data, params, true);
      case 'group.removeMember':
        return this.setRoleMembership(pool, config, data, params, false);
      case 'group.get':
        return this.getRole(pool, config, data, params);
      case 'group.search':
        return this.searchRoles(pool, config, data);
      default:
        throw new Error(`Unsupported MSSQL login operation: ${operation}`);
    }
  }

  private async createLogin(
    pool: sql.ConnectionPool,
    config: MssqlLoginConfig,
    data: MssqlUserData,
  ): Promise<Record<string, unknown>> {
    const login = this.login(data, {}, config);
    const password = this.password(data, true);
    const database = this.database(config, data);
    const enabled = data.enabled !== false;

    await this.exec(
      pool,
      `CREATE LOGIN ${this.bracket(login)} WITH PASSWORD = ${this.literal(password)}, CHECK_POLICY = ON`,
    );
    await this.exec(
      pool,
      `USE ${this.bracket(database)}; IF USER_ID(${this.literal(login)}) IS NULL CREATE USER ${this.bracket(login)} FOR LOGIN ${this.bracket(login)}`,
    );
    for (const role of this.roles(config, data)) {
      await this.exec(
        pool,
        `USE ${this.bracket(database)}; ALTER ROLE ${this.bracket(role)} ADD MEMBER ${this.bracket(login)}`,
      );
    }
    for (const permission of this.permissions(config, data)) {
      await this.applyPermission(pool, database, login, permission);
    }
    if (!enabled) {
      await this.exec(pool, `ALTER LOGIN ${this.bracket(login)} DISABLE`);
    }
    return { login, database, enabled };
  }

  private async updateLogin(
    pool: sql.ConnectionPool,
    config: MssqlLoginConfig,
    data: MssqlUserData,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const login = this.login(data, params, config);
    const database = this.database(config, data);
    if (typeof data.enabled === 'boolean') {
      await this.exec(
        pool,
        `ALTER LOGIN ${this.bracket(login)} ${data.enabled ? 'ENABLE' : 'DISABLE'}`,
      );
    }
    for (const role of this.roles(config, data, false)) {
      await this.exec(
        pool,
        `USE ${this.bracket(database)}; ALTER ROLE ${this.bracket(role)} ADD MEMBER ${this.bracket(login)}`,
      );
    }
    for (const permission of this.permissions(config, data, false)) {
      await this.applyPermission(pool, database, login, permission);
    }
    return {
      login,
      database,
      changed:
        typeof data.enabled === 'boolean' ||
        this.roles(config, data, false).length > 0 ||
        this.permissions(config, data, false).length > 0,
    };
  }

  private async deleteLogin(
    pool: sql.ConnectionPool,
    config: MssqlLoginConfig,
    data: MssqlUserData,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const login = this.login(data, params, config);
    const database = this.database(config, data);
    if (!config.physicalDeleteEnabled) {
      await this.exec(pool, `ALTER LOGIN ${this.bracket(login)} DISABLE`);
      return { login, enabled: false, deleted: false };
    }
    await this.exec(
      pool,
      `USE ${this.bracket(database)}; IF USER_ID(${this.literal(login)}) IS NOT NULL DROP USER ${this.bracket(login)}`,
    );
    await this.exec(
      pool,
      `IF SUSER_ID(${this.literal(login)}) IS NOT NULL DROP LOGIN ${this.bracket(login)}`,
    );
    return { login, database, deleted: true };
  }

  private async setLoginEnabled(
    pool: sql.ConnectionPool,
    config: MssqlLoginConfig,
    data: MssqlUserData,
    params: Record<string, unknown>,
    enabled: boolean,
  ): Promise<Record<string, unknown>> {
    const login = this.login(data, params, config);
    await this.exec(
      pool,
      `ALTER LOGIN ${this.bracket(login)} ${enabled ? 'ENABLE' : 'DISABLE'}`,
    );
    return { login, enabled };
  }

  private async changePassword(
    pool: sql.ConnectionPool,
    config: MssqlLoginConfig,
    data: MssqlUserData,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const login = this.login(data, params, config);
    const password = this.password(data, true);
    await this.exec(
      pool,
      `ALTER LOGIN ${this.bracket(login)} WITH PASSWORD = ${this.literal(password)}`,
    );
    return { login, passwordChanged: true };
  }

  private async getLogin(
    pool: sql.ConnectionPool,
    config: MssqlLoginConfig,
    data: MssqlUserData,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const login = this.login(data, params, config);
    const result = await pool
      .request()
      .input('login', sql.NVarChar, login)
      .query(
        'SELECT name AS login, is_disabled AS isDisabled FROM sys.sql_logins WHERE name = @login',
      );
    return result.recordset[0] ?? null;
  }

  private async searchLogins(
    pool: sql.ConnectionPool,
    config: MssqlLoginConfig,
    data: MssqlUserData,
  ): Promise<Record<string, unknown>> {
    const prefix = this.prefixedValue(
      typeof data.login === 'string' ? data.login : '',
      config,
      false,
      'MSSQL login',
    );
    const result = await pool
      .request()
      .input('prefix', sql.NVarChar, `${prefix}%`)
      .query(
        'SELECT TOP 200 name AS login, is_disabled AS isDisabled FROM sys.sql_logins WHERE name LIKE @prefix ORDER BY name',
      );
    return { items: result.recordset, total: result.recordset.length };
  }

  private async createRole(
    pool: sql.ConnectionPool,
    config: MssqlLoginConfig,
    data: MssqlGroupData,
  ): Promise<Record<string, unknown>> {
    const role = this.roleName(data, {});
    const database = this.database(config, data);
    await this.exec(
      pool,
      `USE ${this.bracket(database)}; IF DATABASE_PRINCIPAL_ID(${this.literal(role)}) IS NULL CREATE ROLE ${this.bracket(role)}`,
    );
    return { role, database, created: true };
  }

  private async deleteRole(
    pool: sql.ConnectionPool,
    config: MssqlLoginConfig,
    data: MssqlGroupData,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const role = this.roleName(data, params);
    const database = this.database(config, data);
    if (!config.physicalRoleDeleteEnabled) {
      throw new Error(
        'MSSQL DROP ROLE requires physicalRoleDeleteEnabled=true',
      );
    }
    await this.exec(
      pool,
      `USE ${this.bracket(database)}; IF DATABASE_PRINCIPAL_ID(${this.literal(role)}) IS NOT NULL DROP ROLE ${this.bracket(role)}`,
    );
    return { role, database, deleted: true };
  }

  private async setRoleMembership(
    pool: sql.ConnectionPool,
    config: MssqlLoginConfig,
    data: MssqlUserData & MssqlGroupData,
    params: Record<string, unknown>,
    add: boolean,
  ): Promise<Record<string, unknown>> {
    const login = this.login(data, params, config);
    const role = this.roleName(data, params);
    const database = this.database(config, data);
    await this.exec(
      pool,
      `USE ${this.bracket(database)}; ALTER ROLE ${this.bracket(role)} ${add ? 'ADD' : 'DROP'} MEMBER ${this.bracket(login)}`,
    );
    return { login, role, database, member: add };
  }

  private async getRole(
    pool: sql.ConnectionPool,
    config: MssqlLoginConfig,
    data: MssqlGroupData,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const role = this.roleName(data, params);
    const database = this.database(config, data);
    const result = await pool
      .request()
      .input('role', sql.NVarChar, role)
      .query(
        `USE ${this.bracket(database)}; SELECT name AS role FROM sys.database_principals WHERE type = 'R' AND name = @role`,
      );
    return result.recordset[0] ?? null;
  }

  private async searchRoles(
    pool: sql.ConnectionPool,
    config: MssqlLoginConfig,
    data: MssqlGroupData,
  ): Promise<Record<string, unknown>> {
    const database = this.database(config, data);
    const result = await pool
      .request()
      .query(
        `USE ${this.bracket(database)}; SELECT TOP 200 name AS role FROM sys.database_principals WHERE type = 'R' ORDER BY name`,
      );
    return { items: result.recordset, total: result.recordset.length };
  }

  private async applyPermission(
    pool: sql.ConnectionPool,
    database: string,
    login: string,
    permission: NormalizedMssqlPermission,
  ): Promise<void> {
    const principalKeyword = permission.action === 'REVOKE' ? 'FROM' : 'TO';
    await this.exec(
      pool,
      `USE ${this.bracket(database)}; ${permission.action} ${permission.permission} ${this.permissionScope(permission.scope, database)} ${principalKeyword} ${this.bracket(login)}`,
    );
  }

  private async connect(config: MssqlLoginConfig): Promise<sql.ConnectionPool> {
    const pool = new sql.ConnectionPool(this.connectionString(config));
    return pool.connect();
  }

  private async exec(
    pool: sql.ConnectionPool,
    statement: string,
  ): Promise<void> {
    await pool.request().query(statement);
  }

  private connectionString(config: MssqlLoginConfig): string {
    const parts = [config.connectionString ?? ''];
    if (config.statementTimeoutMs !== undefined) {
      parts.push(`Request Timeout=${config.statementTimeoutMs}`);
    }
    if (config.tls?.encrypt !== undefined) {
      parts.push(`Encrypt=${config.tls.encrypt ? 'true' : 'false'}`);
    }
    if (config.tls?.trustServerCertificate !== undefined) {
      parts.push(
        `TrustServerCertificate=${config.tls.trustServerCertificate ? 'true' : 'false'}`,
      );
    }
    return parts
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => (part.endsWith(';') ? part.slice(0, -1) : part))
      .join(';');
  }

  private login(
    data: MssqlUserData,
    params: Record<string, unknown>,
    config: MssqlLoginConfig,
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
      throw new Error('Missing login for MSSQL operation');
    }
    return this.prefixedValue(value, config, true, 'MSSQL login');
  }

  private roleName(
    data: MssqlGroupData,
    params: Record<string, unknown>,
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
      throw new Error('Missing role for MSSQL operation');
    }
    return this.validateIdentifier(value, 'MSSQL role');
  }

  private database(
    config: MssqlLoginConfig,
    data: MssqlUserData | MssqlGroupData,
  ): string {
    return this.validateIdentifier(
      this.firstString(data.database, config.defaultDatabase) ?? 'master',
      'MSSQL database',
    );
  }

  private roles(
    config: MssqlLoginConfig,
    data: MssqlUserData,
    includeDefaults = true,
  ): string[] {
    const payloadRoles = Array.isArray(data.roles)
      ? data.roles.filter((role): role is string => typeof role === 'string')
      : [];
    const mapping = groupMappingSettings(config);
    const mappedGroups = mapping.enabled
      ? groupRefValues(data.groups, mapping.mode, 'groups').map(String)
      : [];
    const defaultGroups =
      includeDefaults && mapping.enabled && config.defaultGroups !== undefined
        ? groupRefValues(
            config.defaultGroups,
            mapping.mode,
            'defaultGroups',
          ).map(String)
        : [];
    const roles = [
      ...(includeDefaults ? (config.defaultDatabaseRoles ?? []) : []),
      ...defaultGroups,
      ...payloadRoles,
      ...mappedGroups,
    ];
    return roles
      .filter(
        (role): role is string => typeof role === 'string' && role.length > 0,
      )
      .map((role) => this.validateIdentifier(role, 'MSSQL role'));
  }

  private permissions(
    config: MssqlLoginConfig,
    data: MssqlUserData,
    includeDefaults = true,
  ): NormalizedMssqlPermission[] {
    const payload: unknown[] = Array.isArray(data.permissions)
      ? data.permissions
      : [];
    const permissions = [
      ...(includeDefaults ? (config.defaultPermissions ?? []) : []),
      ...payload,
    ];
    return permissions.map((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new Error('Invalid MSSQL permission');
      }
      const permission = item as MssqlPermission;
      const action = this.permissionAction(permission.action);
      return {
        action,
        permission: this.permissionName(permission.permission),
        scope: this.permissionScopeValue(permission.scope),
      };
    });
  }

  private permissionAction(value: unknown): 'GRANT' | 'DENY' | 'REVOKE' {
    if (value === 'GRANT' || value === 'DENY' || value === 'REVOKE') {
      return value;
    }
    throw new Error('Invalid MSSQL permission action');
  }

  private permissionName(value: unknown): string {
    const permission = this.firstString(value)?.toUpperCase();
    if (!permission || !/^[A-Z][A-Z0-9_ ]{0,63}$/.test(permission)) {
      throw new Error('Invalid MSSQL permission name');
    }
    return permission;
  }

  private permissionScopeValue(value: unknown): string {
    const scope = this.firstString(value) ?? 'DATABASE';
    if (scope === 'DATABASE') {
      return scope;
    }
    if (scope.startsWith('SCHEMA::')) {
      this.validateIdentifier(scope.slice('SCHEMA::'.length), 'MSSQL schema');
      return scope;
    }
    if (scope.startsWith('OBJECT::')) {
      const objectName = scope.slice('OBJECT::'.length);
      const parts = objectName.split('.');
      if (parts.length !== 2) {
        throw new Error('Invalid MSSQL object scope');
      }
      parts.forEach((part) => this.validateIdentifier(part, 'MSSQL object'));
      return scope;
    }
    throw new Error('Invalid MSSQL permission scope');
  }

  private permissionScope(scope: unknown, database: string): string {
    const value = this.permissionScopeValue(scope);
    if (value === 'DATABASE') {
      return `ON DATABASE::${this.bracket(database)}`;
    }
    if (value.startsWith('SCHEMA::')) {
      return `ON SCHEMA::${this.bracket(value.slice('SCHEMA::'.length))}`;
    }
    const [schema, objectName] = value.slice('OBJECT::'.length).split('.');
    return `ON OBJECT::${this.bracket(schema)}.${this.bracket(objectName)}`;
  }

  private password(data: MssqlUserData, required: boolean): string {
    const value = this.firstString(data.newValue, data.password);
    if (!value && required) {
      throw new Error('Missing password for MSSQL operation');
    }
    return value ?? '';
  }

  private prefixedValue(
    value: string,
    config: MssqlLoginConfig,
    requireValid: boolean,
    label: string,
  ): string {
    const login = `${config.loginPrefix ?? ''}${value}`.trim();
    return requireValid ? this.validateIdentifier(login, label) : login;
  }

  private validateIdentifier(value: string, label: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_@$.-]{0,127}$/.test(value)) {
      throw new Error(`Invalid ${label}`);
    }
    return value;
  }

  private firstString(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return undefined;
  }

  private bracket(value: string): string {
    return `[${value.replace(/]/g, ']]')}]`;
  }

  private literal(value: string): string {
    return `N'${value.replace(/'/g, "''")}'`;
  }
}
