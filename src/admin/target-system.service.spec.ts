import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { TargetSystemService } from './target-system.service';
import { PrismaService } from '../database/prisma.service';
import { JsonHelper } from '../database/json.helper';
import { ConnectorRegistry } from '../connectors/connector.registry';

describe('TargetSystemService', () => {
  const existingCredential = ['existing', 'credential'].join('-');
  const rotatedCredential = ['rotated', 'credential'].join('-');
  let service: TargetSystemService;
  let prisma: {
    targetSystem: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
  };
  let jsonHelper: { toJson: jest.Mock; fromJson: jest.Mock };
  let registry: { testConnection: jest.Mock; reload: jest.Mock };

  beforeEach(async () => {
    prisma = {
      targetSystem: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    };
    jsonHelper = {
      toJson: jest.fn((v) => JSON.stringify(v)),
      fromJson: jest.fn(
        (v) =>
          (typeof v === 'string' ? (JSON.parse(v) as unknown) : v) as Record<
            string,
            unknown
          >,
      ),
    };
    registry = {
      testConnection: jest.fn(),
      reload: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TargetSystemService,
        { provide: PrismaService, useValue: prisma },
        { provide: JsonHelper, useValue: jsonHelper },
        { provide: ConnectorRegistry, useValue: registry },
      ],
    }).compile();

    service = module.get<TargetSystemService>(TargetSystemService);
  });

  describe('findAll', () => {
    it('should return redacted parsed configs', async () => {
      prisma.targetSystem.findMany.mockResolvedValue([
        {
          id: '1',
          name: 'z1',
          type: 'zabbix',
          config: '{"a":1,"apiToken":"secret"}',
        },
      ]);
      const result = await service.findAll({});
      expect(result[0].config).toEqual({ a: 1, apiToken: '***' });
    });
  });

  describe('findById', () => {
    it('should return parsed config', async () => {
      prisma.targetSystem.findUnique.mockResolvedValue({
        id: '1',
        name: 'z1',
        type: 'zabbix',
        config: '{"a":1}',
      });
      const result = await service.findById('1');
      expect(result?.config).toEqual({ a: 1 });
    });

    it('should return null when not found', async () => {
      prisma.targetSystem.findUnique.mockResolvedValue(null);
      const result = await service.findById('x');
      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('should serialize config', async () => {
      prisma.targetSystem.create.mockResolvedValue({ id: '1' });
      await service.create({
        name: 'z1',
        type: 'zabbix',
        label: 'Zabbix',
        config: { url: 'http://z' },
      });
      expect(jsonHelper.toJson).toHaveBeenCalledWith({ url: 'http://z' });
    });

    it('should map duplicate names to conflict', async () => {
      prisma.targetSystem.create.mockRejectedValue({ code: 'P2002' });
      await expect(
        service.create({
          name: 'z1',
          type: 'zabbix',
          label: 'Zabbix',
          config: {},
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('update', () => {
    it('should serialize config when provided', async () => {
      prisma.targetSystem.findUnique.mockResolvedValue({
        id: '1',
        config: JSON.stringify({ password: existingCredential, url: 'http://old' }),
      });
      prisma.targetSystem.update.mockResolvedValue({ id: '1' });
      await service.update('1', { config: { url: 'http://z' } });
      expect(jsonHelper.toJson).toHaveBeenCalledWith({
        password: existingCredential,
        url: 'http://z',
      });
    });

    it('should preserve current secret when update sends masked placeholder', async () => {
      prisma.targetSystem.findUnique.mockResolvedValue({
        id: '1',
        config: JSON.stringify({ password: rotatedCredential, url: 'http://old' }),
      });
      prisma.targetSystem.update.mockResolvedValue({ id: '1' });

      await service.update('1', {
        config: { password: '***', url: 'http://new' },
      });

      expect(jsonHelper.toJson).toHaveBeenCalledWith({
        password: rotatedCredential,
        url: 'http://new',
      });
    });

    it('should map duplicate names to conflict', async () => {
      prisma.targetSystem.update.mockRejectedValue({ code: 'P2002' });
      await expect(service.update('1', { name: 'z1' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('should map missing target systems to not found', async () => {
      prisma.targetSystem.update.mockRejectedValue({ code: 'P2025' });
      await expect(
        service.update('missing', { label: 'Z' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('delete', () => {
    it('should map missing target systems to not found', async () => {
      prisma.targetSystem.delete.mockRejectedValue({ code: 'P2025' });
      await expect(service.delete('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('testConnection', () => {
    it('should return not found when missing', async () => {
      prisma.targetSystem.findUnique.mockResolvedValue(null);
      const result = await service.testConnection('x');
      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('should delegate to registry', async () => {
      prisma.targetSystem.findUnique.mockResolvedValue({
        id: '1',
        name: 'z1',
        type: 'zabbix',
        config: '{"baseUrl":"http://z"}',
      });
      registry.testConnection.mockResolvedValue({
        success: true,
        message: 'OK',
      });
      const result = await service.testConnection('1');
      expect(registry.testConnection).toHaveBeenCalledWith('zabbix', {
        baseUrl: 'http://z',
      });
      expect(result.success).toBe(true);
    });
  });
});
