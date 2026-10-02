import * as sql from 'mssql';
import { MssqlLoginConnectorService } from './mssql-login-connector.service';

jest.mock('mssql', () => ({
  ConnectionPool: jest.fn(),
  NVarChar: 'NVarChar',
}));

const query = jest.fn();
const input = jest.fn();
const close = jest.fn();
const connect = jest.fn();
const request = jest.fn();
const mockedPool = sql.ConnectionPool as unknown as jest.Mock;

describe('MssqlLoginConnectorService', () => {
  let service: MssqlLoginConnectorService;

  beforeEach(() => {
    service = new MssqlLoginConnectorService();
    query.mockReset();
    input.mockReset();
    close.mockReset();
    connect.mockReset();
    request.mockReset();
    mockedPool.mockReset();
    query.mockResolvedValue({ recordset: [] });
    input.mockReturnValue({ input, query });
    close.mockResolvedValue(undefined);
    connect.mockImplementation(function connectPool(this: unknown) {
      return Promise.resolve(this);
    });
    request.mockReturnValue({ input, query });
    mockedPool.mockImplementation(() => ({
      connect,
      close,
      request,
    }));
  });

  it('creates login, database user, role memberships, and permissions', async () => {
    const result = await service.execute({
      operation: 'user.create',
      targetSystem: 'mssql-prod',
      payload: {
        config: {
          connectionString: 'Server=sql;User Id=sa;Password=Secret;',
          loginPrefix: 'idm_',
          defaultDatabase: 'appdb',
          defaultDatabaseRoles: ['app_reader'],
          defaultPermissions: [
            {
              action: 'GRANT',
              permission: 'SELECT',
              scope: 'SCHEMA::dbo',
            },
          ],
        },
        data: {
          login: 'ivanov',
          password: 'secret-password',
          roles: ['app_writer'],
          permissions: [
            {
              action: 'DENY',
              permission: 'DELETE',
              scope: 'OBJECT::dbo.Customer',
            },
          ],
        },
      },
    });

    expect(result).toEqual({
      success: true,
      data: { login: 'idm_ivanov', database: 'appdb', enabled: true },
    });
    expect(query).toHaveBeenNthCalledWith(
      1,
      "CREATE LOGIN [idm_ivanov] WITH PASSWORD = N'secret-password', CHECK_POLICY = ON",
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      "USE [appdb]; IF USER_ID(N'idm_ivanov') IS NULL CREATE USER [idm_ivanov] FOR LOGIN [idm_ivanov]",
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      'USE [appdb]; ALTER ROLE [app_reader] ADD MEMBER [idm_ivanov]',
    );
    expect(query).toHaveBeenNthCalledWith(
      4,
      'USE [appdb]; ALTER ROLE [app_writer] ADD MEMBER [idm_ivanov]',
    );
    expect(query).toHaveBeenNthCalledWith(
      5,
      'USE [appdb]; GRANT SELECT ON SCHEMA::[dbo] TO [idm_ivanov]',
    );
    expect(query).toHaveBeenNthCalledWith(
      6,
      'USE [appdb]; DENY DELETE ON OBJECT::[dbo].[Customer] TO [idm_ivanov]',
    );
    expect(close).toHaveBeenCalled();
  });

  it('maps delete to safe DISABLE by default', async () => {
    const result = await service.execute({
      operation: 'user.delete',
      targetSystem: 'mssql-prod',
      payload: {
        config: { connectionString: 'Server=sql;User Id=sa;Password=Secret;' },
        data: { login: 'ivanov' },
      },
    });

    expect(result).toEqual({
      success: true,
      data: { login: 'ivanov', enabled: false, deleted: false },
    });
    expect(query).toHaveBeenCalledWith('ALTER LOGIN [ivanov] DISABLE');
  });

  it('drops database user and login only when physical delete is enabled', async () => {
    const result = await service.execute({
      operation: 'user.delete',
      targetSystem: 'mssql-prod',
      payload: {
        config: {
          connectionString: 'Server=sql;User Id=sa;Password=Secret;',
          defaultDatabase: 'appdb',
          physicalDeleteEnabled: true,
        },
        data: { login: 'ivanov' },
      },
    });

    expect(result).toEqual({
      success: true,
      data: { login: 'ivanov', database: 'appdb', deleted: true },
    });
    expect(query).toHaveBeenNthCalledWith(
      1,
      "USE [appdb]; IF USER_ID(N'ivanov') IS NOT NULL DROP USER [ivanov]",
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      "IF SUSER_ID(N'ivanov') IS NOT NULL DROP LOGIN [ivanov]",
    );
  });

  it('changes password without returning it', async () => {
    const result = await service.execute({
      operation: 'user.changePassword',
      targetSystem: 'mssql-prod',
      payload: {
        config: { connectionString: 'Server=sql;User Id=sa;Password=Secret;' },
        data: { login: 'ivanov', newValue: 'new-secret' },
      },
    });

    expect(result).toEqual({
      success: true,
      data: { login: 'ivanov', passwordChanged: true },
    });
    expect(query).toHaveBeenCalledWith(
      "ALTER LOGIN [ivanov] WITH PASSWORD = N'new-secret'",
    );
  });

  it('creates roles and manages role membership', async () => {
    await service.execute({
      operation: 'group.create',
      targetSystem: 'mssql-prod',
      payload: {
        config: {
          connectionString: 'Server=sql;User Id=sa;Password=Secret;',
          defaultDatabase: 'appdb',
        },
        data: { name: 'app_operator' },
      },
    });
    await service.execute({
      operation: 'group.addMember',
      targetSystem: 'mssql-prod',
      payload: {
        config: {
          connectionString: 'Server=sql;User Id=sa;Password=Secret;',
          defaultDatabase: 'appdb',
        },
        data: { login: 'ivanov', role: 'app_operator' },
      },
    });
    await service.execute({
      operation: 'group.removeMember',
      targetSystem: 'mssql-prod',
      payload: {
        config: {
          connectionString: 'Server=sql;User Id=sa;Password=Secret;',
          defaultDatabase: 'appdb',
        },
        data: { login: 'ivanov', role: 'app_operator' },
      },
    });

    expect(query).toHaveBeenNthCalledWith(
      1,
      "USE [appdb]; IF DATABASE_PRINCIPAL_ID(N'app_operator') IS NULL CREATE ROLE [app_operator]",
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      'USE [appdb]; ALTER ROLE [app_operator] ADD MEMBER [ivanov]',
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      'USE [appdb]; ALTER ROLE [app_operator] DROP MEMBER [ivanov]',
    );
  });

  it('rejects physical role delete unless explicitly enabled', async () => {
    const result = await service.execute({
      operation: 'group.delete',
      targetSystem: 'mssql-prod',
      payload: {
        config: { connectionString: 'Server=sql;User Id=sa;Password=Secret;' },
        data: { name: 'app_operator' },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('physicalRoleDeleteEnabled=true');
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects invalid identifiers and permissions before SQL execution', async () => {
    const badLogin = await service.execute({
      operation: 'user.create',
      targetSystem: 'mssql-prod',
      payload: {
        config: { connectionString: 'Server=sql;User Id=sa;Password=Secret;' },
        data: { login: 'bad login', password: 'secret-password' },
      },
    });
    const badPermission = await service.execute({
      operation: 'user.create',
      targetSystem: 'mssql-prod',
      payload: {
        config: { connectionString: 'Server=sql;User Id=sa;Password=Secret;' },
        data: {
          login: 'ivanov',
          password: 'secret-password',
          permissions: [
            {
              action: 'GRANT',
              permission: 'SELECT; DROP LOGIN x',
              scope: 'DATABASE',
            },
          ],
        },
      },
    });

    expect(badLogin.success).toBe(false);
    expect(badLogin.error).toContain('Invalid MSSQL login');
    expect(badPermission.success).toBe(false);
    expect(badPermission.error).toContain('Invalid MSSQL permission name');
  });

  it('generates valid MSSQL REVOKE and database-scope permission statements', async () => {
    const result = await service.execute({
      operation: 'user.update',
      targetSystem: 'mssql-prod',
      payload: {
        config: {
          connectionString: 'Server=sql;User Id=sa;Password=Secret;',
          defaultDatabase: 'appdb',
        },
        data: {
          login: 'ivanov',
          permissions: [
            {
              action: 'REVOKE',
              permission: 'SELECT',
              scope: 'DATABASE',
            },
          ],
        },
      },
    });

    expect(result.success).toBe(true);
    expect(query).toHaveBeenCalledWith(
      'USE [appdb]; REVOKE SELECT ON DATABASE::[appdb] FROM [ivanov]',
    );
  });

  it('redacts MSSQL connector secrets from returned errors', async () => {
    query.mockRejectedValueOnce(
      new Error(
        'failed with Server=sql;User Id=sa;Password=Secret; and secret-password',
      ),
    );

    const result = await service.execute({
      operation: 'user.create',
      targetSystem: 'mssql-prod',
      payload: {
        config: { connectionString: 'Server=sql;User Id=sa;Password=Secret;' },
        data: { login: 'ivanov', password: 'secret-password' },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('[REDACTED]');
    expect(result.error).not.toContain('secret-password');
    expect(result.error).not.toContain('Password=Secret');
  });

  it('marks unsupported MSSQL login operations in capabilities', () => {
    const capabilities = service.getCapabilities();

    expect(capabilities.operationStatus['user.addAttributes']).toEqual(
      expect.objectContaining({ status: 'unsupported' }),
    );
    expect(capabilities.operationStatus['group.addMember']).toEqual({
      status: 'implemented',
    });
  });
});
