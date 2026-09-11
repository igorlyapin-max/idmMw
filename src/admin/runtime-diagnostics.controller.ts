import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  RuntimeDiagnosticsService,
  type EnableRuntimeDebugInput,
} from '../diagnostics/runtime-diagnostics.service';
import type { DebugLoggingLevel } from '../config/logging.config';

interface RuntimeDebugBody {
  targetSystem?: string;
  level?: DebugLoggingLevel;
  ttlSeconds?: number;
}

@Controller('admin/runtime')
export class RuntimeDiagnosticsController {
  constructor(private readonly diagnostics: RuntimeDiagnosticsService) {}

  @Get('debug')
  debugStatus() {
    return this.diagnostics.status();
  }

  @Post('debug')
  enableDebug(@Body() body: RuntimeDebugBody) {
    const input: EnableRuntimeDebugInput = {
      targetSystem: body.targetSystem,
      level: body.level === 'Verbose' ? 'Verbose' : 'Basic',
      ttlSeconds: body.ttlSeconds,
    };
    return this.diagnostics.enable(input);
  }

  @Delete('debug/:id')
  disableDebug(@Param('id') id: string) {
    return { success: this.diagnostics.disable(id) };
  }

  @Get('logs')
  logs(
    @Query('targetSystem') targetSystem?: string,
    @Query('level') level?: string,
    @Query('limit') limit?: string,
  ) {
    return {
      items: this.diagnostics.logs({
        targetSystem,
        level,
        limit: limit ? Number(limit) : undefined,
      }),
    };
  }

  @Delete('logs')
  clearLogs(@Query('targetSystem') targetSystem?: string) {
    const result = this.diagnostics.clearLogs({ targetSystem });
    return { success: true, ...result };
  }
}
