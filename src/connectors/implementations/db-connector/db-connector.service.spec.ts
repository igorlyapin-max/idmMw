import { ConfigService } from '@nestjs/config';
import knex from 'knex';
import { DbConnectorService } from './db-connector.service';

jest.mock('knex', () => ({
  __esModule: true,
  default: jest.fn(),
}));

const mockedKnex = knex as unknown as jest.Mock;
const rawMock = jest.fn();
const destroyMock = jest.fn();

type MockKnexInstance = ((table: string) => {
  insert: jest.Mock;
  where: jest.Mock;
}) & {
  raw: jest.Mock;
  destroy: jest.Mock;
};

function createKnexInstance(): MockKnexInstance {
  const instance = jest.fn(() => ({
    insert: jest.fn(),
    where: jest.fn(),
  })) as unknown as MockKnexInstance;
  instance.raw = rawMock;
  instance.destroy = destroyMock;
  return instance;
}

function createService(values: Record<string, unknown>): DbConnectorService {
  const config = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
  return new DbConnectorService(config);
}

describe('DbConnectorService', () => {
  const dbCredential = ['db', 'credential'].join('-');
  beforeEach(() => {
    mockedKnex.mockReset();
    rawMock.mockReset();
    destroyMock.mockReset();
    rawMock.mockResolvedValue({ rows: [{ ok: 1 }] });
    destroyMock.mockResolvedValue(undefined);
    mockedKnex.mockImplementation(() => createKnexInstance());
  });

  it('does not initialize when the DB connector is disabled', async () => {
    const service = createService({ DB_CONNECTOR_ENABLED: false });

    await service.onModuleInit();

    expect(mockedKnex).not.toHaveBeenCalled();
  });

  it('initializes PostgreSQL with a string connection', async () => {
    const service = createService({
      DB_CONNECTOR_ENABLED: true,
      DB_CONNECTOR_DIALECT: 'pg',
      DB_CONNECTOR_URL: 'postgresql://user:pass@localhost:5432/db',
    });

    await service.onModuleInit();

    expect(mockedKnex).toHaveBeenCalledWith({
      client: 'pg',
      connection: 'postgresql://user:pass@localhost:5432/db',
      pool: { min: 1, max: 5 },
    });
  });

  it('initializes Oracle with connectString and credentials', async () => {
    const service = createService({
      DB_CONNECTOR_ENABLED: true,
      DB_CONNECTOR_DIALECT: 'oracledb',
      DB_CONNECTOR_URL: '127.0.0.1:1521/FREEPDB1',
      DB_CONNECTOR_USERNAME: 'scott',
      DB_CONNECTOR_PASSWORD: dbCredential,
    });

    await service.onModuleInit();

    expect(mockedKnex).toHaveBeenCalledWith({
      client: 'oracledb',
      connection: {
        connectString: '127.0.0.1:1521/FREEPDB1',
        user: 'scott',
        password: dbCredential,
      },
      pool: { min: 1, max: 5 },
    });
  });

  it('leaves Oracle uninitialized when credentials are missing', async () => {
    const service = createService({
      DB_CONNECTOR_ENABLED: true,
      DB_CONNECTOR_DIALECT: 'oracledb',
      DB_CONNECTOR_URL: '127.0.0.1:1521/FREEPDB1',
    });

    await service.onModuleInit();
    const result = await service.execute({
      operation: 'raw',
      targetSystem: 'db',
      payload: { rawQuery: 'SELECT 1 FROM DUAL' },
    });

    expect(mockedKnex).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: 'DB connector not initialized',
    });
  });

  it('tests Oracle connections with SELECT 1 FROM DUAL', async () => {
    const service = createService({});

    const result = await service.testConnection({
      client: 'oracledb',
      connection: '127.0.0.1:1521/FREEPDB1',
      username: 'scott',
      password: 'tiger',
    });

    expect(mockedKnex).toHaveBeenCalledWith({
      client: 'oracledb',
      connection: {
        connectString: '127.0.0.1:1521/FREEPDB1',
        user: 'scott',
        password: 'tiger',
      },
      pool: { min: 1, max: 2 },
    });
    expect(rawMock).toHaveBeenCalledWith('SELECT 1 FROM DUAL');
    expect(destroyMock).toHaveBeenCalled();
    expect(result).toEqual({ success: true, message: 'DB connection OK' });
  });

  it('tests non-Oracle connections with SELECT 1', async () => {
    const service = createService({});

    const result = await service.testConnection({
      client: 'mysql2',
      connection: 'mysql://user:pass@localhost:3306/db',
    });

    expect(mockedKnex).toHaveBeenCalledWith({
      client: 'mysql2',
      connection: 'mysql://user:pass@localhost:3306/db',
      pool: { min: 1, max: 2 },
    });
    expect(rawMock).toHaveBeenCalledWith('SELECT 1');
    expect(result).toEqual({ success: true, message: 'DB connection OK' });
  });
});
