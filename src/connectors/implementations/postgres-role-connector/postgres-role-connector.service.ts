import { Injectable, Logger, Optional } from '@nestjs/common';
import { Pool, PoolConfig } from 'pg';
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
  defaultLogin?: boolean;
  defaultRoles?: string[];
  physicalDeleteEnabled?: boolean;
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
  enabled?: unknown;
}

const POSTGRES_ROLE_PARTIAL_OPERATIONS: Record<string, string> = {
  'user.delete':
    'Default mapping is safe disable (ALTER ROLE NOLOGIN); physical DROP ROLE requires physicalDeleteEnabled=true.',
  'user.lock': 'Mapped to ALTER ROLE NOLOGIN.',
  'user.disable': 'Mapped to ALTER ROLE NOLOGIN.',
  'user.unlock': 'Mapped to ALTER ROLE LOGIN.',
  'user.enable': 'Mapped to ALTER ROLE LOGIN.',
  'group.create':
    'PostgreSQL group roles are out of first PostgreSQL role connector scope.',
  'group.update':
    'PostgreSQL group roles are out of first PostgreSQL role connector scope.',
  'group.delete':
    'PostgreSQL group roles are out of first PostgreSQL role connector scope.',
  'group.addMember':
    'Role grants are applied during user.create from defaultRoles or payload.roles.',
  'group.removeMember':
    'Role revoke lifecycle is out of first PostgreSQL role connector scope.',
};

const POSTGRES_ROLE_UNSUPPORTED_OPERATIONS: Record<string, string> = {
  'user.addAttributes':
    'PostgreSQL role custom attribute mapping is not supported.',
  'user.removeAttributes':
    'PostgreSQL role custom attribute mapping is not supported.',
  'group.get': 'PostgreSQL group role read is out of connector scope.',
  'group.search': 'PostgreSQL group role search is out of connector scope.',
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
    const data = (payload.payload['data'] ?? {}) as PostgresUserData;
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
                name: 'enabled',
                type: 'boolean',
                required: false,
                multiValued: false,
              },
            ],
          },
        ],
      },
    });
  }

  private async executeWithPool(
    pool: Pool,
    operation: string,
    config: PostgresRoleConfig,
    data: PostgresUserData,
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

    await pool.query(
      `CREATE ROLE ${this.ident(login)} ${loginOption} PASSWORD ${this.literal(password)}`,
    );

    for (const role of this.roles(config, data)) {
      await pool.query(`GRANT ${this.ident(role)} TO ${this.ident(login)}`);
    }

    return { login, enabled: loginOption === 'LOGIN' };
  }

  private async updateRole(
    pool: Pool,
    config: PostgresRoleConfig,
    data: PostgresUserData,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const login = this.login(data, params, config);
    if (typeof data.enabled === 'boolean') {
      await pool.query(
        `ALTER ROLE ${this.ident(login)} ${data.enabled ? 'LOGIN' : 'NOLOGIN'}`,
      );
      return { login, enabled: data.enabled };
    }
    return { login, changed: false };
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

  private createPool(config: PostgresRoleConfig): Pool {
    const ssl = this.tlsOptions?.dbConnectorSslOptions(config.tls);
    const poolConfig: PoolConfig = {
      connectionString: config.connectionString,
      statement_timeout: config.statementTimeoutMs ?? 30000,
      ...(ssl ? { ssl } : {}),
    };
    return new Pool(poolConfig);
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

  private roles(config: PostgresRoleConfig, data: PostgresUserData): string[] {
    const payloadRoles = Array.isArray(data.roles)
      ? data.roles.filter((role): role is string => typeof role === 'string')
      : [];
    const roles = [...(config.defaultRoles ?? []), ...payloadRoles];
    return roles
      .filter(
        (role): role is string => typeof role === 'string' && role.length > 0,
      )
      .map((role) => {
        if (!/^[A-Za-z_][A-Za-z0-9_@$.-]{0,62}$/.test(role)) {
          throw new Error('Invalid PostgreSQL grant role');
        }
        return role;
      });
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
