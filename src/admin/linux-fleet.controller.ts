import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { LinuxFleetService } from './linux-fleet.service';
import { AdminRbacService } from './admin-rbac.service';
import type { AdminRequest } from '../auth/admin-request';

@ApiTags('Linux Fleet')
@Controller('admin/linux-fleet')
export class LinuxFleetController {
  constructor(
    private readonly service: LinuxFleetService,
    private readonly rbac: AdminRbacService,
  ) {}

  @Get('target-systems/:targetSystemId/credential-profiles')
  async listCredentialProfiles(
    @Req() req: AdminRequest,
    @Param('targetSystemId') targetSystemId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('search') search?: string,
    @Query('enabled') enabled?: string,
  ) {
    await this.assertTargetSystemRead(req, targetSystemId);
    return this.service.listCredentialProfiles(targetSystemId, {
      limit: this.number(limit),
      offset: this.number(offset),
      search,
      enabled: this.boolean(enabled),
    });
  }

  @Post('target-systems/:targetSystemId/credential-profiles')
  async createCredentialProfile(
    @Req() req: AdminRequest,
    @Param('targetSystemId') targetSystemId: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.assertTargetSystemWrite(req, targetSystemId);
    return this.service.createCredentialProfile(targetSystemId, body);
  }

  @Patch('credential-profiles/:id')
  async updateCredentialProfile(
    @Req() req: AdminRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.assertTargetSystemWrite(
      req,
      await this.service.targetSystemIdForCredentialProfile(id),
    );
    return this.service.updateCredentialProfile(id, body);
  }

  @Delete('credential-profiles/:id')
  async deleteCredentialProfile(@Req() req: AdminRequest, @Param('id') id: string) {
    await this.assertTargetSystemWrite(
      req,
      await this.service.targetSystemIdForCredentialProfile(id),
    );
    return this.service.deleteCredentialProfile(id);
  }

  @Get('target-systems/:targetSystemId/hosts')
  async listHosts(
    @Req() req: AdminRequest,
    @Param('targetSystemId') targetSystemId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('search') search?: string,
    @Query('enabled') enabled?: string,
  ) {
    await this.assertTargetSystemRead(req, targetSystemId);
    return this.service.listHosts(targetSystemId, {
      limit: this.number(limit),
      offset: this.number(offset),
      search,
      enabled: this.boolean(enabled),
    });
  }

  @Post('target-systems/:targetSystemId/hosts')
  async createHost(
    @Req() req: AdminRequest,
    @Param('targetSystemId') targetSystemId: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.assertTargetSystemWrite(req, targetSystemId);
    return this.service.createHost(targetSystemId, body);
  }

  @Patch('hosts/:id')
  async updateHost(
    @Req() req: AdminRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.assertTargetSystemWrite(
      req,
      await this.service.targetSystemIdForHost(id),
    );
    return this.service.updateHost(id, body);
  }

  @Delete('hosts/:id')
  async deleteHost(@Req() req: AdminRequest, @Param('id') id: string) {
    await this.assertTargetSystemWrite(
      req,
      await this.service.targetSystemIdForHost(id),
    );
    return this.service.deleteHost(id);
  }

  @Get('target-systems/:targetSystemId/groups')
  async listGroups(
    @Req() req: AdminRequest,
    @Param('targetSystemId') targetSystemId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('search') search?: string,
    @Query('enabled') enabled?: string,
  ) {
    await this.assertTargetSystemRead(req, targetSystemId);
    return this.service.listGroups(targetSystemId, {
      limit: this.number(limit),
      offset: this.number(offset),
      search,
      enabled: this.boolean(enabled),
    });
  }

  @Post('target-systems/:targetSystemId/groups')
  async createGroup(
    @Req() req: AdminRequest,
    @Param('targetSystemId') targetSystemId: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.assertTargetSystemWrite(req, targetSystemId);
    return this.service.createGroup(targetSystemId, body);
  }

  @Patch('groups/:id')
  async updateGroup(
    @Req() req: AdminRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.assertTargetSystemWrite(
      req,
      await this.service.targetSystemIdForGroup(id),
    );
    return this.service.updateGroup(id, body);
  }

  @Delete('groups/:id')
  async deleteGroup(@Req() req: AdminRequest, @Param('id') id: string) {
    await this.assertTargetSystemWrite(
      req,
      await this.service.targetSystemIdForGroup(id),
    );
    return this.service.deleteGroup(id);
  }

  @Put('groups/:id/hosts')
  async setGroupHosts(
    @Req() req: AdminRequest,
    @Param('id') id: string,
    @Body() body: { hostIds?: string[] },
  ) {
    await this.assertTargetSystemWrite(
      req,
      await this.service.targetSystemIdForGroup(id),
    );
    return this.service.setGroupHosts(id, body.hostIds ?? []);
  }

  private async assertTargetSystemRead(
    req: AdminRequest,
    targetSystemId: string,
  ): Promise<void> {
    await this.rbac.assertRead(
      this.session(req),
      await this.rbac.connectorTypeByTargetSystemId(targetSystemId),
    );
  }

  private async assertTargetSystemWrite(
    req: AdminRequest,
    targetSystemId: string,
  ): Promise<void> {
    await this.rbac.assertWrite(
      this.session(req),
      await this.rbac.connectorTypeByTargetSystemId(targetSystemId),
    );
  }

  private session(req: AdminRequest) {
    if (!req.adminSession) throw new Error('Admin session missing');
    return req.adminSession;
  }

  private number(value: string | undefined): number | undefined {
    if (value === undefined || value === '') return undefined;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : undefined;
  }

  private boolean(value: string | undefined): boolean | undefined {
    if (value === undefined) return undefined;
    return value === 'true';
  }
}
