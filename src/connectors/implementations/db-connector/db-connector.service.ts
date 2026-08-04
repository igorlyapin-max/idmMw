import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import knex, { Knex } from 'knex';
import {
  Connector,
  ConnectorPayload,
  ConnectorResult,
} from '../../connector.interface';
import {
  DbConnectorTlsConfig,
  TlsOptionsFactory,
} from '../../../security/tls-options.factory';

type DbConnectorPoolConfig = { min: number; max: number };

interface DbConnectorKnexInput {
  client?: string;
  connection?: string;
  connectString?: string;
  username?: string;
  user?: string;
  password?: string;
  pool?: DbConnectorPoolConfig;
  tls?: DbConnectorTlsConfig;
}

type DbConnectorKnexConfigResult =
  | { success: true; client: string; config: Knex.Config }
  | { success: false; error: string };

@Injectable()
export class DbConnectorService
  implements Connector, OnModuleInit, OnModuleDestroy
{
  readonly name = 'db';
  private readonly logger = new Logger(DbConnectorService.name);
  private knex: Knex | undefined;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly tlsOptions?: TlsOptionsFactory,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async onModuleInit(): Promise<void> {
    const enabled = this.config.get<boolean>('DB_CONNECTOR_ENABLED') ?? false;
    if (!enabled) {
      this.logger.log('DB connector is disabled');
      return;
    }

    const knexConfig = this.buildKnexConfig(
      {
        client: this.config.get<string>('DB_CONNECTOR_DIALECT'),
        connection: this.config.get<string>('DB_CONNECTOR_URL'),
        username: this.config.get<string>('DB_CONNECTOR_USERNAME'),
        password: this.config.get<string>('DB_CONNECTOR_PASSWORD'),
        pool: { min: 1, max: 5 },
        tls: this.tlsOptions?.dbConnectorTlsFromEnv(),
      },
      'runtime',
    );

    if (!knexConfig.success) {
      this.logger.error(knexConfig.error);
      return;
    }

    this.knex = knex(knexConfig.config);

    this.logger.log(
      `DB connector initialized with dialect: ${knexConfig.client}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.knex?.destroy();
  }

  async execute(payload: ConnectorPayload): Promise<ConnectorResult> {
    const dynamicConfig = payload.payload['config'] as
      | DbConnectorKnexInput
      | undefined;
    const knexClient = dynamicConfig
      ? this.createDynamicKnex(dynamicConfig)
      : this.knex;
    const shouldDestroy = Boolean(dynamicConfig);

    if (!knexClient) {
      return { success: false, error: 'DB connector not initialized' };
    }

    const operation = payload.payload['sqlOperation'] as string | undefined;
    const table = payload.payload['table'] as string | undefined;
    const data = payload.payload['data'] as Record<string, unknown> | undefined;
    const where = payload.payload['where'] as
      | Record<string, unknown>
      | undefined;
    const rawQuery = payload.payload['rawQuery'] as string | undefined;
    const bindings = payload.payload['bindings'] as unknown[] | undefined;

    try {
      if (rawQuery) {
        // @ts-expect-error knex raw bindings type mismatch
        const result: unknown = await knexClient.raw(rawQuery, bindings ?? []);
        return { success: true, data: result };
      }

      if (!table) {
        return {
          success: false,
          error: 'Missing table or rawQuery in payload',
        };
      }

      switch (operation) {
        case 'insert': {
          const result = await knexClient(table).insert(data);
          return { success: true, data: result };
        }
        case 'update': {
          if (!where) {
            return { success: false, error: 'Missing where clause for update' };
          }
          const result = await knexClient(table).where(where).update(data);
          return { success: true, data: result };
        }
        case 'delete': {
          if (!where) {
            return { success: false, error: 'Missing where clause for delete' };
          }
          const result = await knexClient(table).where(where).del();
          return { success: true, data: result };
        }
        case 'query': {
          const result = await knexClient(table).where(where ?? {});
          return { success: true, data: result };
        }
        default:
          return {
            success: false,
            error: `Unsupported SQL operation: ${operation}`,
          };
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`DB operation failed: ${msg}`);
      return { success: false, error: msg };
    } finally {
      if (shouldDestroy) {
        await knexClient.destroy();
      }
    }
  }

  async testConnection(
    config: Record<string, unknown>,
  ): Promise<{ success: boolean; message: string }> {
    const knexConfig = this.buildKnexConfig(
      {
        client: config['client'] as string | undefined,
        connection: config['connection'] as string | undefined,
        connectString: config['connectString'] as string | undefined,
        username: config['username'] as string | undefined,
        user: config['user'] as string | undefined,
        password: config['password'] as string | undefined,
        pool: { min: 1, max: 2 },
        tls: config['tls'] as DbConnectorTlsConfig | undefined,
      },
      'dynamic',
    );
    if (!knexConfig.success) {
      return { success: false, message: knexConfig.error };
    }

    let testKnex: Knex | undefined;
    try {
      testKnex = knex(knexConfig.config);
      await testKnex.raw(
        knexConfig.client === 'oracledb' ? 'SELECT 1 FROM DUAL' : 'SELECT 1',
      );
      return { success: true, message: 'DB connection OK' };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, message: `DB connection failed: ${msg}` };
    } finally {
      await testKnex?.destroy();
    }
  }

  private buildKnexConfig(
    input: DbConnectorKnexInput,
    source: 'runtime' | 'dynamic',
  ): DbConnectorKnexConfigResult {
    const client = input.client;
    const connection = input.connectString ?? input.connection;
    const pool = input.pool ?? { min: 1, max: 5 };
    const ssl = this.tlsOptions?.dbConnectorSslOptions(input.tls);

    if (!client || !connection) {
      return {
        success: false,
        error:
          source === 'runtime'
            ? 'DB_CONNECTOR_DIALECT and DB_CONNECTOR_URL are required when DB_CONNECTOR_ENABLED=true'
            : 'Missing client and connection/connectString in config',
      };
    }

    if (client === 'sqlite3') {
      if (ssl) {
        return {
          success: false,
          error: 'SQLite DB connector does not support TLS',
        };
      }
      return {
        success: true,
        client,
        config: { client, connection, pool },
      };
    }

    if (client === 'pg') {
      return {
        success: true,
        client,
        config: {
          client,
          connection: ssl ? { connectionString: connection, ssl } : connection,
          pool,
        },
      };
    }

    if (client === 'mysql2') {
      return {
        success: true,
        client,
        config: {
          client,
          connection: ssl ? { uri: connection, ssl } : connection,
          pool,
        },
      };
    }

    const user = input.username ?? input.user;
    if (!user || !input.password) {
      return {
        success: false,
        error:
          source === 'runtime'
            ? 'Oracle DB connector requires DB_CONNECTOR_USERNAME and DB_CONNECTOR_PASSWORD'
            : 'Oracle DB connector requires username/user and password',
      };
    }

    if (
      ssl &&
      !connection.toLowerCase().startsWith('tcps:') &&
      !connection.toLowerCase().includes('protocol=tcps')
    ) {
      return {
        success: false,
        error:
          'Oracle DB connector TLS requires a TCPS connect string (tcps://... or PROTOCOL=TCPS)',
      };
    }

    return {
      success: true,
      client,
      config: {
        client,
        connection: {
          connectString: connection,
          user,
          password: input.password,
          ...(input.tls?.walletLocation
            ? { walletLocation: input.tls.walletLocation }
            : {}),
          ...(input.tls?.walletPassword
            ? { walletPassword: input.tls.walletPassword }
            : {}),
        },
        pool,
      },
    };
  }

  private createDynamicKnex(config: DbConnectorKnexInput): Knex | undefined {
    const knexConfig = this.buildKnexConfig(
      {
        client: config.client,
        connection: config.connection,
        connectString: config.connectString,
        username: config.username,
        user: config.user,
        password: config.password,
        pool: config.pool ?? { min: 1, max: 2 },
        tls: config.tls,
      },
      'dynamic',
    );
    if (!knexConfig.success) {
      this.logger.error(knexConfig.error);
      return undefined;
    }
    return knex(knexConfig.config);
  }
}
