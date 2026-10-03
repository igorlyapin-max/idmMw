import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  RuntimeDiagnosticsService,
  type EnableRuntimeDebugInput,
} from '../diagnostics/runtime-diagnostics.service';
import type { DebugLoggingLevel } from '../config/logging.config';
import { AdminRbacService } from './admin-rbac.service';
import type { AdminRequest } from '../auth/admin-request';

interface RuntimeDebugBody {
  targetSystem?: string;
  level?: DebugLoggingLevel;
  ttlSeconds?: number;
}

@Controller('admin/runtime')
export class RuntimeDiagnosticsController {
  constructor(
    private readonly diagnostics: RuntimeDiagnosticsService,
    private readonly rbac: AdminRbacService,
  ) {}

  @Get('debug')
  async debugStatus(@Req() req: AdminRequest) {
    const status = this.diagnostics.status();
    const allowed = await this.rbac.allowedConnectorTypes(
      this.session(req),
      'read',
    );
    if (allowed === undefined) return status;
    const active = [];
    for (const session of status.active) {
      if (!session.targetSystem) continue;
      try {
        const type = await this.rbac.connectorTypeByTargetSystemName(
          session.targetSystem,
        );
        if (allowed.includes(type)) active.push(session);
      } catch {
        // Hidden stale debug sessions are not exposed to restricted operators.
      }
    }
    return { active };
  }

  @Post('debug')
  async enableDebug(@Req() req: AdminRequest, @Body() body: RuntimeDebugBody) {
    if (!body.targetSystem) {
      await this.rbac.assertSuperadmin(this.session(req));
    } else {
      await this.assertReadTargetSystemName(req, body.targetSystem);
    }
    const input: EnableRuntimeDebugInput = {
      targetSystem: body.targetSystem,
      level: body.level === 'Verbose' ? 'Verbose' : 'Basic',
      ttlSeconds: body.ttlSeconds,
    };
    return this.diagnostics.enable(input);
  }

  @Delete('debug/:id')
  async disableDebug(@Req() req: AdminRequest, @Param('id') id: string) {
    const debugSession = this.diagnostics.status().active.find((item) => item.id === id);
    if (!debugSession?.targetSystem) {
      await this.rbac.assertSuperadmin(this.session(req));
    } else {
      await this.assertReadTargetSystemName(req, debugSession.targetSystem);
    }
    return { success: this.diagnostics.disable(id) };
  }

  @Get('logs')
  async logs(
    @Req() req: AdminRequest,
    @Query('targetSystem') targetSystem?: string,
    @Query('level') level?: string,
    @Query('limit') limit?: string,
  ) {
    if (!targetSystem) {
      await this.rbac.assertSuperadmin(this.session(req));
    } else {
      await this.assertReadTargetSystemName(req, targetSystem);
    }
    return {
      items: this.diagnostics.logs({
        targetSystem,
        level,
        limit: limit ? Number(limit) : undefined,
      }),
    };
  }

  @Delete('logs')
  async clearLogs(
    @Req() req: AdminRequest,
    @Query('targetSystem') targetSystem?: string,
  ) {
    if (!targetSystem) {
      await this.rbac.assertSuperadmin(this.session(req));
    } else {
      await this.assertReadTargetSystemName(req, targetSystem);
    }
    const result = this.diagnostics.clearLogs({ targetSystem });
    return { success: true, ...result };
  }

  private session(req: AdminRequest) {
    if (!req.adminSession) throw new Error('Admin session missing');
    return req.adminSession;
  }

  private async assertReadTargetSystemName(
    req: AdminRequest,
    targetSystem: string,
  ): Promise<void> {
    const allowedTypes = await this.rbac.allowedConnectorTypes(
      this.session(req),
      'read',
    );
    if (allowedTypes === undefined) return;
    const connectorType =
      await this.rbac.connectorTypeByTargetSystemName(targetSystem);
    if (!allowedTypes.includes(connectorType)) {
      await this.rbac.assertRead(this.session(req), connectorType);
    }
  }
}
