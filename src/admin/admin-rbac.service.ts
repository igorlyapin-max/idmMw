import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { AdminUserSession } from '../auth/auth.service';

export interface ConnectorPermission {
  connectorType: string;
  canRead: boolean;
  canWrite: boolean;
}

export interface EffectiveAdminPermissions {
  superadmin: boolean;
  provider: AdminUserSession['provider'];
  groups: string[];
  roles: Array<{ id: string; code: string; name: string }>;
  permissions: ConnectorPermission[];
}

interface RoleDto {
  code: string;
  name: string;
  description?: string | null;
  enabled?: boolean;
  permissions?: ConnectorPermission[];
}

interface MappingDto {
  idpGroup: string;
  roleId: string;
  enabled?: boolean;
}

const CONNECTOR_TYPE_PATTERN = /^[A-Za-z0-9_.:-]{1,96}$/;
const ROLE_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,96}$/;

@Injectable()
export class AdminRbacService {
  constructor(private readonly prisma: PrismaService) {}

  async effectivePermissions(
    session: AdminUserSession,
  ): Promise<EffectiveAdminPermissions> {
    if (this.isSuperadminSession(session)) {
      return {
        superadmin: true,
        provider: session.provider,
        groups: session.groups ?? [],
        roles: [{ id: 'builtin-superadmin', code: 'superadmin', name: 'Superadmin' }],
        permissions: [],
      };
    }

    const groups = [...new Set(session.groups ?? [])];
    if (groups.length === 0) {
      return {
        superadmin: false,
        provider: session.provider,
        groups,
        roles: [],
        permissions: [],
      };
    }

    const mappings = await this.prisma.adminGroupRoleMapping.findMany({
      where: {
        enabled: true,
        idpGroup: { in: groups },
        role: { enabled: true },
      },
      include: { role: { include: { permissions: true } } },
      orderBy: { idpGroup: 'asc' },
    });

    const roleMap = new Map<string, { id: string; code: string; name: string }>();
    const permissionMap = new Map<string, ConnectorPermission>();
    for (const mapping of mappings) {
      roleMap.set(mapping.role.id, {
        id: mapping.role.id,
        code: mapping.role.code,
        name: mapping.role.name,
      });
      for (const permission of mapping.role.permissions) {
        const current = permissionMap.get(permission.connectorType) ?? {
          connectorType: permission.connectorType,
          canRead: false,
          canWrite: false,
        };
        current.canRead = current.canRead || permission.canRead || permission.canWrite;
        current.canWrite = current.canWrite || permission.canWrite;
        permissionMap.set(permission.connectorType, current);
      }
    }

    return {
      superadmin: false,
      provider: session.provider,
      groups,
      roles: [...roleMap.values()].sort((a, b) => a.code.localeCompare(b.code)),
      permissions: [...permissionMap.values()].sort((a, b) =>
        a.connectorType.localeCompare(b.connectorType),
      ),
    };
  }

  async canRead(session: AdminUserSession, connectorType: string): Promise<boolean> {
    const effective = await this.effectivePermissions(session);
    if (effective.superadmin) return true;
    return effective.permissions.some(
      (permission) =>
        permission.connectorType === connectorType &&
        (permission.canRead || permission.canWrite),
    );
  }

  async canWrite(session: AdminUserSession, connectorType: string): Promise<boolean> {
    const effective = await this.effectivePermissions(session);
    if (effective.superadmin) return true;
    return effective.permissions.some(
      (permission) =>
        permission.connectorType === connectorType && permission.canWrite,
    );
  }

  async assertRead(
    session: AdminUserSession,
    connectorType: string,
  ): Promise<void> {
    if (!(await this.canRead(session, connectorType))) {
      throw new ForbiddenException(`Missing read permission for ${connectorType}`);
    }
  }

  async assertWrite(
    session: AdminUserSession,
    connectorType: string,
  ): Promise<void> {
    if (!(await this.canWrite(session, connectorType))) {
      throw new ForbiddenException(`Missing write permission for ${connectorType}`);
    }
  }

  async assertSuperadmin(session: AdminUserSession): Promise<void> {
    const effective = await this.effectivePermissions(session);
    if (!effective.superadmin) {
      throw new ForbiddenException('Superadmin permission required');
    }
  }

  async allowedConnectorTypes(
    session: AdminUserSession,
    access: 'read' | 'write',
  ): Promise<string[] | undefined> {
    const effective = await this.effectivePermissions(session);
    if (effective.superadmin) return undefined;
    return effective.permissions
      .filter((permission) =>
        access === 'write'
          ? permission.canWrite
          : permission.canRead || permission.canWrite,
      )
      .map((permission) => permission.connectorType);
  }

  async connectorTypeByTargetSystemId(id: string): Promise<string> {
    const item = await this.prisma.targetSystem.findUnique({
      where: { id },
      select: { type: true },
    });
    if (!item) throw new NotFoundException('TargetSystem not found');
    return item.type;
  }

  async connectorTypeByTargetSystemName(name: string): Promise<string> {
    const item = await this.prisma.targetSystem.findUnique({
      where: { name },
      select: { type: true },
    });
    if (!item) throw new NotFoundException('TargetSystem not found');
    return item.type;
  }

  async targetSystemNamesForAccess(
    session: AdminUserSession,
    access: 'read' | 'write',
  ): Promise<string[] | undefined> {
    const allowedTypes = await this.allowedConnectorTypes(session, access);
    if (allowedTypes === undefined) return undefined;
    if (allowedTypes.length === 0) return [];
    const items = await this.prisma.targetSystem.findMany({
      where: { type: { in: allowedTypes } },
      select: { name: true },
    });
    return items.map((item) => item.name);
  }

  async listRoles() {
    return this.prisma.adminRole.findMany({
      include: { permissions: true },
      orderBy: { code: 'asc' },
    });
  }

  async createRole(dto: RoleDto) {
    this.validateRole(dto);
    const permissions = this.normalizedPermissions(dto.permissions ?? []);
    return this.prisma.adminRole.create({
      data: {
        code: dto.code.trim(),
        name: dto.name.trim(),
        description: this.optionalText(dto.description),
        enabled: dto.enabled ?? true,
        permissions: {
          create: permissions.map((permission) => ({
            connectorType: permission.connectorType,
            canRead: permission.canRead || permission.canWrite,
            canWrite: permission.canWrite,
          })),
        },
      },
      include: { permissions: true },
    });
  }

  async updateRole(id: string, dto: Partial<RoleDto>) {
    const current = await this.prisma.adminRole.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Admin role not found');
    this.validateRole({
      code: dto.code ?? current.code,
      name: dto.name ?? current.name,
      description: dto.description ?? current.description,
      enabled: dto.enabled ?? current.enabled,
      permissions: dto.permissions,
    });
    return this.prisma.$transaction(async (tx) => {
      if (dto.permissions !== undefined) {
        await tx.adminRoleConnectorPermission.deleteMany({ where: { roleId: id } });
        const permissions = this.normalizedPermissions(dto.permissions);
        if (permissions.length > 0) {
          await tx.adminRoleConnectorPermission.createMany({
            data: permissions.map((permission) => ({
              roleId: id,
              connectorType: permission.connectorType,
              canRead: permission.canRead || permission.canWrite,
              canWrite: permission.canWrite,
            })),
          });
        }
      }
      return tx.adminRole.update({
        where: { id },
        data: {
          ...(dto.code !== undefined ? { code: dto.code.trim() } : {}),
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.description !== undefined
            ? { description: this.optionalText(dto.description) }
            : {}),
          ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        },
        include: { permissions: true },
      });
    });
  }

  async deleteRole(id: string) {
    await this.prisma.adminRole.delete({ where: { id } });
    return { deleted: true };
  }

  async listMappings() {
    return this.prisma.adminGroupRoleMapping.findMany({
      include: { role: true },
      orderBy: [{ idpGroup: 'asc' }],
    });
  }

  async createMapping(dto: MappingDto) {
    this.validateMapping(dto);
    await this.requireRole(dto.roleId);
    return this.prisma.adminGroupRoleMapping.create({
      data: {
        idpGroup: dto.idpGroup.trim(),
        roleId: dto.roleId,
        enabled: dto.enabled ?? true,
      },
      include: { role: true },
    });
  }

  async updateMapping(id: string, dto: Partial<MappingDto>) {
    const current = await this.prisma.adminGroupRoleMapping.findUnique({
      where: { id },
    });
    if (!current) throw new NotFoundException('Admin group mapping not found');
    const merged = {
      idpGroup: dto.idpGroup ?? current.idpGroup,
      roleId: dto.roleId ?? current.roleId,
      enabled: dto.enabled ?? current.enabled,
    };
    this.validateMapping(merged);
    if (dto.roleId) await this.requireRole(dto.roleId);
    return this.prisma.adminGroupRoleMapping.update({
      where: { id },
      data: {
        ...(dto.idpGroup !== undefined ? { idpGroup: dto.idpGroup.trim() } : {}),
        ...(dto.roleId !== undefined ? { roleId: dto.roleId } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      },
      include: { role: true },
    });
  }

  async deleteMapping(id: string) {
    await this.prisma.adminGroupRoleMapping.delete({ where: { id } });
    return { deleted: true };
  }

  private isSuperadminSession(session: AdminUserSession): boolean {
    return session.provider === 'local' || session.provider === 'disabled';
  }

  private validateRole(dto: RoleDto): void {
    if (!ROLE_CODE_PATTERN.test(String(dto.code ?? '').trim())) {
      throw new BadRequestException('Invalid role code');
    }
    if (!this.optionalText(dto.name)) {
      throw new BadRequestException('Missing role name');
    }
    this.normalizedPermissions(dto.permissions ?? []);
  }

  private validateMapping(dto: MappingDto): void {
    if (!this.optionalText(dto.idpGroup)) {
      throw new BadRequestException('Missing IdP group');
    }
    if (!this.optionalText(dto.roleId)) {
      throw new BadRequestException('Missing roleId');
    }
  }

  private normalizedPermissions(
    permissions: ConnectorPermission[],
  ): ConnectorPermission[] {
    const map = new Map<string, ConnectorPermission>();
    for (const permission of permissions) {
      const connectorType = String(permission.connectorType ?? '').trim();
      if (!CONNECTOR_TYPE_PATTERN.test(connectorType)) {
        throw new BadRequestException('Invalid connector type permission');
      }
      const current = map.get(connectorType) ?? {
        connectorType,
        canRead: false,
        canWrite: false,
      };
      current.canRead = current.canRead || permission.canRead || permission.canWrite;
      current.canWrite = current.canWrite || permission.canWrite;
      map.set(connectorType, current);
    }
    return [...map.values()];
  }

  private async requireRole(id: string): Promise<void> {
    const role = await this.prisma.adminRole.findUnique({ where: { id } });
    if (!role) throw new NotFoundException('Admin role not found');
  }

  private optionalText(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }
}
