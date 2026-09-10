import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { RuntimeDiagnosticsController } from './runtime-diagnostics.controller';
import { AdminService } from './admin.service';
import { TargetSystemController } from './target-system.controller';
import { TargetSystemService } from './target-system.service';
import { IdmController } from '../inbound/idm/idm.controller';
import { CoreModule } from '../core/core.module';
import { KafkaModule } from '../kafka/kafka.module';
import { MetricsModule } from '../metrics/metrics.module';
import { ConnectorsModule } from '../connectors/connectors.module';

@Module({
  imports: [CoreModule, KafkaModule, MetricsModule, ConnectorsModule],
  controllers: [
    AdminController,
    RuntimeDiagnosticsController,
    TargetSystemController,
    IdmController,
  ],
  providers: [AdminService, TargetSystemService],
})
export class AdminModule {}
