import { Pool } from 'pg';
import { PostgresRoleConnectorService } from './postgres-role-connector.service';

jest.mock('pg', () => ({
  Pool: jest.fn(),
}));

const poolQuery = jest.fn();
const poolEnd = jest.fn();
const mockedPool = Pool as unknown as jest.Mock;

describe('PostgresRoleConnectorService', () => {
  let service: PostgresRoleConnectorService;

  beforeEach(() => {
    service = new PostgresRoleConnectorService();
    poolQuery.mockReset();
    poolEnd.mockReset();
    mockedPool.mockReset();
    poolEnd.mockResolvedValue(undefined);
    poolQuery.mockResolvedValue({ rows: [] });
    mockedPool.mockImplementation(() => ({
      query: poolQuery,
      end: poolEnd,
    }));
  });

  it('creates a PostgreSQL role and grants configured roles', async () => {
    const result = await service.execute({
      operation: 'user.create',
      targetSystem: 'pg-prod',
      payload: {
        config: {
          connectionString: 'postgres://admin:secret@db/postgres',
          rolePrefix: 'idm_',
          defaultRoles: ['app_read'],
        },
        data: {
          login: 'ivanov',
          password: 'secret-password',
          roles: ['app_write'],
        },
      },
    });

    expect(result).toEqual({
      success: true,
      data: { login: 'idm_ivanov', enabled: true },
    });
    expect(poolQuery).toHaveBeenNthCalledWith(
      1,
      'CREATE ROLE "idm_ivanov" LOGIN PASSWORD \'secret-password\'',
    );
    expect(poolQuery).toHaveBeenNthCalledWith(
      2,
      'GRANT "app_read" TO "idm_ivanov"',
    );
    expect(poolQuery).toHaveBeenNthCalledWith(
      3,
      'GRANT "app_write" TO "idm_ivanov"',
    );
    expect(poolEnd).toHaveBeenCalled();
  });

  it('maps delete to safe NOLOGIN by default', async () => {
    const result = await service.execute({
      operation: 'user.delete',
      targetSystem: 'pg-prod',
      payload: {
        config: { connectionString: 'postgres://admin:secret@db/postgres' },
        data: { login: 'ivanov' },
      },
    });

    expect(result).toEqual({
      success: true,
      data: { login: 'ivanov', enabled: false, deleted: false },
    });
    expect(poolQuery).toHaveBeenCalledWith('ALTER ROLE "ivanov" NOLOGIN');
  });

  it('uses DROP ROLE only when physicalDeleteEnabled is true', async () => {
    const result = await service.execute({
      operation: 'user.delete',
      targetSystem: 'pg-prod',
      payload: {
        config: {
          connectionString: 'postgres://admin:secret@db/postgres',
          physicalDeleteEnabled: true,
        },
        data: { login: 'ivanov' },
      },
    });

    expect(result).toEqual({
      success: true,
      data: { login: 'ivanov', deleted: true },
    });
    expect(poolQuery).toHaveBeenCalledWith('DROP ROLE "ivanov"');
  });

  it('changes password without logging it in result data', async () => {
    const result = await service.execute({
      operation: 'user.changePassword',
      targetSystem: 'pg-prod',
      payload: {
        config: { connectionString: 'postgres://admin:secret@db/postgres' },
        data: { login: 'ivanov', newValue: 'new-secret' },
      },
    });

    expect(result).toEqual({
      success: true,
      data: { login: 'ivanov', passwordChanged: true },
    });
    expect(poolQuery).toHaveBeenCalledWith(
      'ALTER ROLE "ivanov" PASSWORD \'new-secret\'',
    );
  });

  it('rejects invalid role identifiers before SQL execution', async () => {
    const result = await service.execute({
      operation: 'user.create',
      targetSystem: 'pg-prod',
      payload: {
        config: { connectionString: 'postgres://admin:secret@db/postgres' },
        data: { login: 'bad role', password: 'secret' },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid PostgreSQL role login');
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('redacts PostgreSQL role secrets from returned errors', async () => {
    poolQuery.mockRejectedValueOnce(
      new Error(
        'failed with postgres://admin:secret@db/postgres and secret-password',
      ),
    );

    const result = await service.execute({
      operation: 'user.create',
      targetSystem: 'pg-prod',
      payload: {
        config: { connectionString: 'postgres://admin:secret@db/postgres' },
        data: { login: 'ivanov', password: 'secret-password' },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('[REDACTED]');
    expect(result.error).not.toContain('secret-password');
    expect(result.error).not.toContain('admin:secret');
  });

  it('marks unsupported PostgreSQL role operations in capabilities', () => {
    const capabilities = service.getCapabilities();

    expect(capabilities.operationStatus['user.addAttributes']).toEqual(
      expect.objectContaining({ status: 'unsupported' }),
    );
    expect(capabilities.operationStatus['user.create']).toEqual({
      status: 'implemented',
    });
  });
});
