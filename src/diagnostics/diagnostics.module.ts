import { Global, Module } from '@nestjs/common';
import { DiagnosticLoggerService } from './diagnostic-logger.service';
import { RuntimeDiagnosticsService } from './runtime-diagnostics.service';

@Global()
@Module({
  providers: [DiagnosticLoggerService, RuntimeDiagnosticsService],
  exports: [DiagnosticLoggerService, RuntimeDiagnosticsService],
})
export class DiagnosticsModule {}
