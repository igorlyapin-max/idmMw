import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  Query,
  Logger,
  Req,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminRbacService } from './admin-rbac.service';
import type { AdminRequest } from '../auth/admin-request';

interface RetryManyBody {
  targetSystem?: string;
  status?: string;
  limit?: number;
}

@Controller('admin')
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(
    private readonly adminService: AdminService,
    private readonly rbac: AdminRbacService,
  ) {}

  @Get('stats')
  async getStats(@Req() req: AdminRequest) {
    return this.adminService.stats({
      allowedTargetSystems: await this.rbac.targetSystemNamesForAccess(
        this.session(req),
        'read',
      ),
    });
  }

  @Get('dlq')
  async getDlq(
    @Req() req: AdminRequest,
    @Query('status') status?: string,
    @Query('targetSystem') targetSystem?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    if (targetSystem) {
      await this.rbac.assertRead(
        this.session(req),
        await this.rbac.connectorTypeByTargetSystemName(targetSystem),
      );
    }
    return this.adminService.findDlqItems({
      status,
      targetSystem,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      allowedTargetSystems: targetSystem
        ? undefined
        : await this.rbac.targetSystemNamesForAccess(this.session(req), 'read'),
    });
  }

  @Post('dlq/retry')
  async retryMany(@Req() req: AdminRequest, @Body() body: RetryManyBody) {
    if (body.targetSystem) {
      await this.rbac.assertRead(
        this.session(req),
        await this.rbac.connectorTypeByTargetSystemName(body.targetSystem),
      );
    }
    this.logger.log(
      `Retrying DLQ items target=${body.targetSystem ?? 'all'} limit=${body.limit ?? 25}`,
    );
    return this.adminService.retryMany({
      ...body,
      allowedTargetSystems: body.targetSystem
        ? undefined
        : await this.rbac.targetSystemNamesForAccess(this.session(req), 'read'),
    });
  }

  @Post('dlq/:id/retry')
  async retry(@Req() req: AdminRequest, @Param('id') id: string) {
    await this.assertDlqRead(req, id);
    this.logger.log(`Retrying DLQ item ${id}`);
    await this.adminService.retry(id);
    return { success: true };
  }

  @Post('dlq/:id/skip')
  async skip(@Req() req: AdminRequest, @Param('id') id: string) {
    await this.assertDlqRead(req, id);
    this.logger.log(`Skipping DLQ item ${id}`);
    await this.adminService.skip(id);
    return { success: true };
  }

  private async assertDlqRead(req: AdminRequest, id: string): Promise<void> {
    const targetSystem = await this.adminService.findDlqItemTargetSystem(id);
    if (!targetSystem) return;
    await this.rbac.assertRead(
      this.session(req),
      await this.rbac.connectorTypeByTargetSystemName(targetSystem),
    );
  }

  private session(req: AdminRequest) {
    if (!req.adminSession) throw new Error('Admin session missing');
    return req.adminSession;
  }
}
