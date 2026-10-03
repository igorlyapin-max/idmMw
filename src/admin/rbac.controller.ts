import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { AdminRbacService, ConnectorPermission } from './admin-rbac.service';
import type { AdminRequest } from '../auth/admin-request';

interface RoleBody {
  code?: string;
  name?: string;
  description?: string | null;
  enabled?: boolean;
  permissions?: ConnectorPermission[];
}

interface MappingBody {
  idpGroup?: string;
  roleId?: string;
  enabled?: boolean;
}

@Controller('admin/rbac')
export class RbacController {
  constructor(private readonly rbac: AdminRbacService) {}

  @Get('effective')
  effective(@Req() req: AdminRequest) {
    return this.rbac.effectivePermissions(this.session(req));
  }

  @Get('roles')
  async listRoles(@Req() req: AdminRequest) {
    await this.rbac.assertSuperadmin(this.session(req));
    return this.rbac.listRoles();
  }

  @Post('roles')
  async createRole(@Req() req: AdminRequest, @Body() body: RoleBody) {
    await this.rbac.assertSuperadmin(this.session(req));
    return this.rbac.createRole({
      code: body.code ?? '',
      name: body.name ?? '',
      description: body.description,
      enabled: body.enabled,
      permissions: body.permissions ?? [],
    });
  }

  @Patch('roles/:id')
  async updateRole(
    @Req() req: AdminRequest,
    @Param('id') id: string,
    @Body() body: RoleBody,
  ) {
    await this.rbac.assertSuperadmin(this.session(req));
    return this.rbac.updateRole(id, body);
  }

  @Delete('roles/:id')
  async deleteRole(@Req() req: AdminRequest, @Param('id') id: string) {
    await this.rbac.assertSuperadmin(this.session(req));
    return this.rbac.deleteRole(id);
  }

  @Get('mappings')
  async listMappings(@Req() req: AdminRequest) {
    await this.rbac.assertSuperadmin(this.session(req));
    return this.rbac.listMappings();
  }

  @Post('mappings')
  async createMapping(@Req() req: AdminRequest, @Body() body: MappingBody) {
    await this.rbac.assertSuperadmin(this.session(req));
    return this.rbac.createMapping({
      idpGroup: body.idpGroup ?? '',
      roleId: body.roleId ?? '',
      enabled: body.enabled,
    });
  }

  @Patch('mappings/:id')
  async updateMapping(
    @Req() req: AdminRequest,
    @Param('id') id: string,
    @Body() body: MappingBody,
  ) {
    await this.rbac.assertSuperadmin(this.session(req));
    return this.rbac.updateMapping(id, body);
  }

  @Delete('mappings/:id')
  async deleteMapping(@Req() req: AdminRequest, @Param('id') id: string) {
    await this.rbac.assertSuperadmin(this.session(req));
    return this.rbac.deleteMapping(id);
  }

  private session(req: AdminRequest) {
    if (!req.adminSession) {
      throw new Error('Admin session missing');
    }
    return req.adminSession;
  }
}
