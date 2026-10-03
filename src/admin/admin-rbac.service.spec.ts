import { ForbiddenException } from '@nestjs/common';
import { AdminRbacService } from './admin-rbac.service';
import { PrismaService } from '../database/prisma.service';
import type { AdminUserSession } from '../auth/auth.service';

function session(
  provider: AdminUserSession['provider'],
  groups: string[] = [],
): AdminUserSession {
  return {
    sub: 'user',
    name: 'user',
    provider,
    groups,
    csrfToken: 'csrf',
    expiresAt: Date.now() + 1000,
  };
}

describe('AdminRbacService', () => {
  let service: AdminRbacService;
  let prisma: {
    adminGroupRoleMapping: { findMany: jest.Mock };
    targetSystem: { findUnique: jest.Mock; findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      adminGroupRoleMapping: { findMany: jest.fn().mockResolvedValue([]) },
      targetSystem: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    service = new AdminRbacService(prisma as unknown as PrismaService);
  });

  it('treats local admin as superadmin', async () => {
    const effective = await service.effectivePermissions(session('local'));

    expect(effective.superadmin).toBe(true);
    await expect(service.assertWrite(session('local'), 'linux')).resolves.toBeUndefined();
  });

  it('maps SSO groups to connector read/write permissions', async () => {
    prisma.adminGroupRoleMapping.findMany.mockResolvedValue([
      {
        role: {
          id: 'role-1',
          code: 'linux-ops',
          name: 'Linux ops',
          permissions: [
            {
              connectorType: 'linux',
              canRead: true,
              canWrite: false,
            },
            {
              connectorType: 'cmdbuild',
              canRead: true,
              canWrite: true,
            },
          ],
        },
      },
    ]);

    const sso = session('sso', ['idmmw-linux-ops']);
    await expect(service.assertRead(sso, 'linux')).resolves.toBeUndefined();
    await expect(service.assertWrite(sso, 'linux')).rejects.toThrow(
      ForbiddenException,
    );
    await expect(service.assertWrite(sso, 'cmdbuild')).resolves.toBeUndefined();
  });

  it('fails closed for SSO users without mapped groups', async () => {
    await expect(service.assertRead(session('sso'), 'linux')).rejects.toThrow(
      ForbiddenException,
    );
  });
});
