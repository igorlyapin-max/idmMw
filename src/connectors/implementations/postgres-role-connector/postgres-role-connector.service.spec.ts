import { Pool } from 'pg';
import { PostgresRoleConnectorService } from './postgres-role-connector.service';

jest.mock('pg', () => ({
  Pool: jest.fn(),
}));

const poolQuery = jest.fn();
const clientQuery = jest.fn();
const clientRelease = jest.fn();
const poolEnd = jest.fn();
const mockedPool = Pool as unknown as jest.Mock;

describe('PostgresRoleConnectorService', () => {
  let service: PostgresRoleConnectorService;

  beforeEach(() => {
    service = new PostgresRoleConnectorService();
    poolQuery.mockReset();
    clientQuery.mockReset();
    clientRelease.mockReset();
    poolEnd.mockReset();
    mockedPool.mockReset();
    poolEnd.mockResolvedValue(undefined);
    poolQuery.mockResolvedValue({ rows: [] });
    clientQuery.mockResolvedValue({ rows: [] });
    mockedPool.mockImplementation(() => ({
      query: poolQuery,
      connect: jest.fn().mockResolvedValue({
        query: clientQuery,
        release: clientRelease,
      }),
      end: poolEnd,
    }));
  });

  it('creates a PostgreSQL role and grants configured roles and permissions', async () => {
    const result = await service.execute({
      operation: 'user.create',
      targetSystem: 'pg-prod',
      payload: {
        config: {
          connectionString: 'postgres://admin:secret@db/postgres',
          rolePrefix: 'idm_',
          managedRolePrefix: 'app_',
          defaultDatabase: 'appdb',
          defaultRoles: ['app_read'],
          defaultPermissions: [
            { action: 'GRANT', permission: 'CONNECT', scope: 'DATABASE' },
          ],
          allowedPermissions: [
            { action: 'GRANT', permission: 'CONNECT', scope: 'DATABASE' },
            {
              action: 'GRANT',
              permission: 'SELECT',
              scope: 'TABLE::public.customer',
            },
          ],
        },
        data: {
          login: 'ivanov',
          password: 'secret-password',
          roles: ['app_write'],
          permissions: [
            {
              action: 'GRANT',
              permission: 'SELECT',
              scope: 'TABLE::public.customer',
            },
          ],
        },
      },
    });

    expect(result).toEqual({
      success: true,
      data: { login: 'idm_ivanov', enabled: true },
    });
    expect(clientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(clientQuery).toHaveBeenNthCalledWith(
      2,
      'CREATE ROLE "idm_ivanov" LOGIN PASSWORD \'secret-password\'',
    );
    expect(clientQuery).toHaveBeenNthCalledWith(
      3,
      'GRANT "app_read" TO "idm_ivanov"',
    );
    expect(clientQuery).toHaveBeenNthCalledWith(
      4,
      'GRANT "app_write" TO "idm_ivanov"',
    );
    expect(clientQuery).toHaveBeenNthCalledWith(
      5,
      'GRANT CONNECT ON DATABASE "appdb" TO "idm_ivanov"',
    );
    expect(clientQuery).toHaveBeenNthCalledWith(
      6,
      'GRANT SELECT ON TABLE "public"."customer" TO "idm_ivanov"',
    );
    expect(clientQuery).toHaveBeenNthCalledWith(7, 'COMMIT');
    expect(clientRelease).toHaveBeenCalled();
    expect(poolEnd).toHaveBeenCalled();
  });

  it('updates a PostgreSQL role with payload roles and permissions only', async () => {
    const result = await service.execute({
      operation: 'user.update',
      targetSystem: 'pg-prod',
      payload: {
        config: {
          connectionString: 'postgres://admin:secret@db/postgres',
          rolePolicyMode: 'idm-full-control',
          permissionPolicyMode: 'idm-full-control',
          defaultRoles: ['app_read'],
          defaultPermissions: [
            { action: 'GRANT', permission: 'CONNECT', scope: 'DATABASE' },
          ],
        },
        data: {
          login: 'ivanov',
          roles: ['app_write'],
          permissions: [
            { action: 'REVOKE', permission: 'SELECT', scope: 'SCHEMA::audit' },
          ],
        },
      },
    });

    expect(result).toEqual({
      success: true,
      data: { login: 'ivanov', changed: true },
    });
    expect(clientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(clientQuery).toHaveBeenNthCalledWith(
      2,
      'GRANT "app_write" TO "ivanov"',
    );
    expect(clientQuery).toHaveBeenNthCalledWith(
      3,
      'REVOKE SELECT ON SCHEMA "audit" FROM "ivanov"',
    );
    expect(clientQuery).toHaveBeenNthCalledWith(4, 'COMMIT');
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

  it('manages PostgreSQL group roles and memberships', async () => {
    await expect(
      service.execute({
        operation: 'group.create',
        targetSystem: 'pg-prod',
        payload: {
          config: {
            connectionString: 'postgres://admin:secret@db/postgres',
            managedRolePrefix: 'app_',
          },
          data: { name: 'app_writer' },
        },
      }),
    ).resolves.toEqual({
      success: true,
      data: { role: 'app_writer', created: true },
    });
    expect(poolQuery).toHaveBeenLastCalledWith(
      'CREATE ROLE "app_writer" NOLOGIN',
    );

    poolQuery.mockClear();
    await expect(
      service.execute({
        operation: 'group.addMember',
        targetSystem: 'pg-prod',
        payload: {
          config: {
            connectionString: 'postgres://admin:secret@db/postgres',
            managedRolePrefix: 'app_',
          },
          data: { login: 'ivanov', role: 'app_writer' },
        },
      }),
    ).resolves.toEqual({
      success: true,
      data: { login: 'ivanov', role: 'app_writer', member: true },
    });
    expect(poolQuery).toHaveBeenLastCalledWith(
      'GRANT "app_writer" TO "ivanov"',
    );

    poolQuery.mockClear();
    await expect(
      service.execute({
        operation: 'group.removeMember',
        targetSystem: 'pg-prod',
        payload: {
          config: {
            connectionString: 'postgres://admin:secret@db/postgres',
            managedRolePrefix: 'app_',
          },
          data: { login: 'ivanov', role: 'app_writer' },
        },
      }),
    ).resolves.toEqual({
      success: true,
      data: { login: 'ivanov', role: 'app_writer', member: false },
    });
    expect(poolQuery).toHaveBeenLastCalledWith(
      'REVOKE "app_writer" FROM "ivanov"',
    );
  });

  it('requires explicit opt-in for PostgreSQL group role deletion', async () => {
    const rejected = await service.execute({
      operation: 'group.delete',
      targetSystem: 'pg-prod',
      payload: {
        config: {
          connectionString: 'postgres://admin:secret@db/postgres',
          managedRolePrefix: 'app_',
        },
        data: { name: 'app_writer' },
      },
    });

    expect(rejected.success).toBe(false);
    expect(rejected.error).toContain('physicalRoleDeleteEnabled=true');
    expect(poolQuery).not.toHaveBeenCalled();

    const deleted = await service.execute({
      operation: 'group.delete',
      targetSystem: 'pg-prod',
      payload: {
        config: {
          connectionString: 'postgres://admin:secret@db/postgres',
          managedRolePrefix: 'app_',
          physicalRoleDeleteEnabled: true,
        },
        data: { name: 'app_writer' },
      },
    });

    expect(deleted).toEqual({
      success: true,
      data: { role: 'app_writer', deleted: true },
    });
    expect(poolQuery).toHaveBeenCalledWith('DROP ROLE "app_writer"');
  });

  it('reads PostgreSQL group roles', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ role: 'app_writer' }] });

    const getResult = await service.execute({
      operation: 'group.get',
      targetSystem: 'pg-prod',
      payload: {
        config: {
          connectionString: 'postgres://admin:secret@db/postgres',
          managedRolePrefix: 'app_',
        },
        data: { role: 'app_writer' },
      },
    });

    expect(getResult).toEqual({
      success: true,
      data: { role: 'app_writer' },
    });
    expect(poolQuery).toHaveBeenCalledWith(
      'SELECT rolname AS role FROM pg_roles WHERE rolcanlogin = false AND rolname = $1',
      ['app_writer'],
    );

    poolQuery.mockReset();
    poolQuery.mockResolvedValueOnce({ rows: [{ role: 'app_reader' }] });
    const searchResult = await service.execute({
      operation: 'group.search',
      targetSystem: 'pg-prod',
      payload: {
        config: {
          connectionString: 'postgres://admin:secret@db/postgres',
          managedRolePrefix: 'app_',
        },
        data: {},
      },
    });

    expect(searchResult).toEqual({
      success: true,
      data: { items: [{ role: 'app_reader' }], total: 1 },
    });
    expect(poolQuery).toHaveBeenCalledWith(
      'SELECT rolname AS role FROM pg_roles WHERE rolcanlogin = false AND rolname LIKE $1 ORDER BY rolname LIMIT 200',
      ['app_%'],
    );
  });

  it('resolves current database for DATABASE permissions when no defaultDatabase is configured', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ database: 'postgres' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.execute({
      operation: 'user.update',
      targetSystem: 'pg-prod',
      payload: {
        config: {
          connectionString: 'postgres://admin:secret@db/postgres',
          permissionPolicyMode: 'idm-full-control',
        },
        data: {
          login: 'ivanov',
          permissions: [
            { action: 'GRANT', permission: 'CONNECT', scope: 'DATABASE' },
          ],
        },
      },
    });

    expect(result.success).toBe(true);
    expect(clientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(clientQuery).toHaveBeenNthCalledWith(
      2,
      'SELECT current_database() AS database',
    );
    expect(clientQuery).toHaveBeenNthCalledWith(
      3,
      'GRANT CONNECT ON DATABASE "postgres" TO "ivanov"',
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

  it('rejects invalid PostgreSQL permissions before SQL execution', async () => {
    const result = await service.execute({
      operation: 'user.create',
      targetSystem: 'pg-prod',
      payload: {
        config: { connectionString: 'postgres://admin:secret@db/postgres' },
        data: {
          login: 'ivanov',
          password: 'secret',
          permissions: [
            {
              action: 'DENY',
              permission: 'SELECT',
              scope: 'TABLE::public.customer',
            },
          ],
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid PostgreSQL permission action');
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('redacts PostgreSQL role secrets from returned errors', async () => {
    clientQuery.mockRejectedValueOnce(
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

  it('rejects unmanaged grant roles by default', async () => {
    const result = await service.execute({
      operation: 'user.update',
      targetSystem: 'pg-prod',
      payload: {
        config: {
          connectionString: 'postgres://admin:secret@db/postgres',
          rolePrefix: 'idm_',
        },
        data: { login: 'ivanov', roles: ['dba'] },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('outside managed namespace');
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('allows unmanaged roles and full group search with explicit IDM full control', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ role: 'pg_read_all_data' }] });

    const searchResult = await service.execute({
      operation: 'group.search',
      targetSystem: 'pg-prod',
      payload: {
        config: {
          connectionString: 'postgres://admin:secret@db/postgres',
          rolePolicyMode: 'idm-full-control',
        },
        data: {},
      },
    });

    expect(searchResult).toEqual({
      success: true,
      data: { items: [{ role: 'pg_read_all_data' }], total: 1 },
    });
    expect(poolQuery).toHaveBeenCalledWith(
      'SELECT rolname AS role FROM pg_roles WHERE rolcanlogin = false ORDER BY rolname LIMIT 200',
    );

    const updateResult = await service.execute({
      operation: 'user.update',
      targetSystem: 'pg-prod',
      payload: {
        config: {
          connectionString: 'postgres://admin:secret@db/postgres',
          rolePolicyMode: 'idm-full-control',
        },
        data: { login: 'ivanov', roles: ['pg_read_all_data'] },
      },
    });

    expect(updateResult.success).toBe(true);
    expect(clientQuery).toHaveBeenCalledWith(
      'GRANT "pg_read_all_data" TO "ivanov"',
    );
  });

  it('rejects payload permissions outside managed allowlist by default', async () => {
    const result = await service.execute({
      operation: 'user.update',
      targetSystem: 'pg-prod',
      payload: {
        config: {
          connectionString: 'postgres://admin:secret@db/postgres',
          allowedPermissions: [
            { action: 'GRANT', permission: 'SELECT', scope: 'SCHEMA::public' },
          ],
        },
        data: {
          login: 'ivanov',
          permissions: [
            { action: 'GRANT', permission: 'UPDATE', scope: 'SCHEMA::public' },
          ],
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('outside managed allowlist');
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('rolls back PostgreSQL role creation when a later grant fails', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('grant failed'))
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.execute({
      operation: 'user.create',
      targetSystem: 'pg-prod',
      payload: {
        config: {
          connectionString: 'postgres://admin:secret@db/postgres',
          rolePrefix: 'idm_',
          managedRolePrefix: 'app_',
          defaultRoles: ['app_read'],
        },
        data: { login: 'ivanov', password: 'secret-password' },
      },
    });

    expect(result.success).toBe(false);
    expect(clientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(clientQuery).toHaveBeenNthCalledWith(
      2,
      'CREATE ROLE "idm_ivanov" LOGIN PASSWORD \'secret-password\'',
    );
    expect(clientQuery).toHaveBeenNthCalledWith(
      3,
      'GRANT "app_read" TO "idm_ivanov"',
    );
    expect(clientQuery).toHaveBeenNthCalledWith(4, 'ROLLBACK');
    expect(clientRelease).toHaveBeenCalled();
  });

  it('marks PostgreSQL role operations in capabilities', () => {
    const capabilities = service.getCapabilities();

    expect(capabilities.operationStatus['user.addAttributes']).toEqual(
      expect.objectContaining({ status: 'unsupported' }),
    );
    expect(capabilities.operationStatus['user.create']).toEqual({
      status: 'implemented',
    });
    expect(capabilities.operationStatus['group.addMember']).toEqual({
      status: 'implemented',
    });
    expect(capabilities.operationStatus['group.delete']).toEqual(
      expect.objectContaining({ status: 'partial' }),
    );
    expect(capabilities.operationStatus['group.update']).toEqual(
      expect.objectContaining({ status: 'partial' }),
    );
  });
});
