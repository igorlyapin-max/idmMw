import { Test, TestingModule } from '@nestjs/testing';
import { TargetSystemController } from './target-system.controller';
import { TargetSystemService } from './target-system.service';
import { ConnectorRegistry } from '../connectors/connector.registry';
import { AdminRbacService } from './admin-rbac.service';
import type { AdminRequest } from '../auth/admin-request';

describe('TargetSystemController', () => {
  let controller: TargetSystemController;
  let service: {
    findAll: jest.Mock;
    findById: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    testConnection: jest.Mock;
  };
  let registry: { reload: jest.Mock };
  let rbac: {
    allowedConnectorTypes: jest.Mock;
    assertRead: jest.Mock;
    assertWrite: jest.Mock;
    connectorTypeByTargetSystemId: jest.Mock;
  };
  const req = {
    adminSession: {
      sub: 'admin',
      name: 'admin',
      provider: 'local',
      csrfToken: 'csrf',
      expiresAt: Date.now() + 1000,
    },
  } as AdminRequest;

  beforeEach(async () => {
    service = {
      findAll: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      testConnection: jest.fn(),
    };
    registry = { reload: jest.fn() };
    rbac = {
      allowedConnectorTypes: jest.fn().mockResolvedValue(undefined),
      assertRead: jest.fn().mockResolvedValue(undefined),
      assertWrite: jest.fn().mockResolvedValue(undefined),
      connectorTypeByTargetSystemId: jest.fn().mockResolvedValue('zabbix'),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TargetSystemController],
      providers: [
        { provide: TargetSystemService, useValue: service },
        { provide: ConnectorRegistry, useValue: registry },
        { provide: AdminRbacService, useValue: rbac },
      ],
    }).compile();

    controller = module.get<TargetSystemController>(TargetSystemController);
  });

  it('findAll should delegate to service', async () => {
    service.findAll.mockResolvedValue([{ id: '1', name: 'z1' }]);
    const result = await controller.findAll(req, 'zabbix', 'true', '10', '0');
    expect(service.findAll).toHaveBeenCalledWith({
      type: 'zabbix',
      enabled: true,
      limit: 10,
      offset: 0,
      allowedTypes: undefined,
    });
    expect(rbac.assertRead).toHaveBeenCalledWith(req.adminSession, 'zabbix');
    expect(result).toEqual([{ id: '1', name: 'z1' }]);
  });

  it('findById should delegate to service', async () => {
    service.findById.mockResolvedValue({ id: '1', type: 'zabbix' });
    const result = await controller.findById(req, '1');
    expect(service.findById).toHaveBeenCalledWith('1');
    expect(rbac.assertRead).toHaveBeenCalledWith(req.adminSession, 'zabbix');
    expect(result).toEqual({ id: '1', type: 'zabbix' });
  });

  it('create should reload registry', async () => {
    service.create.mockResolvedValue({ id: '1' });
    const dto = {
      name: 'z1',
      type: 'zabbix',
      label: 'Z',
      config: {},
      enabled: true,
    };
    const result = await controller.create(req, dto);
    expect(rbac.assertWrite).toHaveBeenCalledWith(req.adminSession, 'zabbix');
    expect(service.create).toHaveBeenCalledWith(dto);
    expect(registry.reload).toHaveBeenCalled();
    expect(result).toEqual({ id: '1' });
  });

  it('update should reload registry', async () => {
    service.update.mockResolvedValue({ id: '1' });
    const dto = { label: 'Updated' };
    const result = await controller.update(req, '1', dto);
    expect(rbac.connectorTypeByTargetSystemId).toHaveBeenCalledWith('1');
    expect(rbac.assertWrite).toHaveBeenCalledWith(req.adminSession, 'zabbix');
    expect(service.update).toHaveBeenCalledWith('1', dto);
    expect(registry.reload).toHaveBeenCalled();
    expect(result).toEqual({ id: '1' });
  });

  it('delete should reload registry', async () => {
    service.delete.mockResolvedValue({ id: '1' });
    const result = await controller.delete(req, '1');
    expect(rbac.assertWrite).toHaveBeenCalledWith(req.adminSession, 'zabbix');
    expect(service.delete).toHaveBeenCalledWith('1');
    expect(registry.reload).toHaveBeenCalled();
    expect(result).toEqual({ id: '1' });
  });

  it('testConnection should delegate to service', async () => {
    service.testConnection.mockResolvedValue({ success: true, message: 'OK' });
    const result = await controller.testConnection(req, '1');
    expect(rbac.assertWrite).toHaveBeenCalledWith(req.adminSession, 'zabbix');
    expect(service.testConnection).toHaveBeenCalledWith('1');
    expect(result).toEqual({ success: true, message: 'OK' });
  });
});
