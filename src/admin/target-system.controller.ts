import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiResponse, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { TargetSystemService } from './target-system.service';
import {
  CreateTargetSystemDto,
  UpdateTargetSystemDto,
} from './dto/target-system.dto';
import { ConnectorRegistry } from '../connectors/connector.registry';
import { AdminRbacService } from './admin-rbac.service';
import type { AdminRequest } from '../auth/admin-request';

@ApiTags('Target Systems')
@Controller('admin/target-systems')
export class TargetSystemController {
  constructor(
    private readonly service: TargetSystemService,
    private readonly registry: ConnectorRegistry,
    private readonly rbac: AdminRbacService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List target systems' })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'enabled', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  async findAll(
    @Req() req: AdminRequest,
    @Query('type') type?: string,
    @Query('enabled') enabled?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const allowedTypes = await this.rbac.allowedConnectorTypes(
      this.session(req),
      'read',
    );
    if (type) {
      await this.rbac.assertRead(this.session(req), type);
    }
    return this.service.findAll({
      type,
      enabled: enabled !== undefined ? enabled === 'true' : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      allowedTypes,
    });
  }

  @Get('name/:name')
  @ApiOperation({ summary: 'Get target system by name' })
  @ApiResponse({ status: 200, description: 'Found' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async findByName(@Req() req: AdminRequest, @Param('name') name: string) {
    const ts = await this.service.findByName(name);
    if (!ts) return { success: false, message: 'Not found' };
    await this.rbac.assertRead(this.session(req), ts.type);
    return ts;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get target system by ID' })
  @ApiResponse({ status: 200, description: 'Found' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async findById(@Req() req: AdminRequest, @Param('id') id: string) {
    const ts = await this.service.findById(id);
    if (ts) await this.rbac.assertRead(this.session(req), ts.type);
    return ts;
  }

  @Post()
  @ApiOperation({ summary: 'Create target system' })
  @ApiResponse({ status: 201, description: 'Created' })
  async create(@Req() req: AdminRequest, @Body() dto: CreateTargetSystemDto) {
    await this.rbac.assertWrite(this.session(req), dto.type);
    const result = await this.service.create(dto);
    await this.registry.reload();
    return result;
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update target system' })
  @ApiResponse({ status: 200, description: 'Updated' })
  async update(
    @Req() req: AdminRequest,
    @Param('id') id: string,
    @Body() dto: UpdateTargetSystemDto,
  ) {
    const currentType = await this.rbac.connectorTypeByTargetSystemId(id);
    await this.rbac.assertWrite(this.session(req), currentType);
    if (dto.type && dto.type !== currentType) {
      await this.rbac.assertWrite(this.session(req), dto.type);
    }
    const result = await this.service.update(id, dto);
    await this.registry.reload();
    return result;
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete target system' })
  @ApiResponse({ status: 200, description: 'Deleted' })
  async delete(@Req() req: AdminRequest, @Param('id') id: string) {
    await this.rbac.assertWrite(
      this.session(req),
      await this.rbac.connectorTypeByTargetSystemId(id),
    );
    const result = await this.service.delete(id);
    await this.registry.reload();
    return result;
  }

  @Post(':id/test')
  @HttpCode(200)
  @ApiOperation({ summary: 'Test connection to target system' })
  @ApiResponse({ status: 200, description: 'Test result' })
  async testConnection(@Req() req: AdminRequest, @Param('id') id: string) {
    await this.rbac.assertWrite(
      this.session(req),
      await this.rbac.connectorTypeByTargetSystemId(id),
    );
    return this.service.testConnection(id);
  }

  private session(req: AdminRequest) {
    if (!req.adminSession) throw new Error('Admin session missing');
    return req.adminSession;
  }
}
