import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { RuntimeDiagnosticsController } from './runtime-diagnostics.controller';
import { AdminService } from './admin.service';
import { TargetSystemController } from './target-system.controller';
import { TargetSystemService } from './target-system.service';
import { LinuxFleetController } from './linux-fleet.controller';
import { LinuxFleetService } from './linux-fleet.service';
import { RbacController } from './rbac.controller';
import { AdminRbacService } from './admin-rbac.service';
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
    LinuxFleetController,
    RbacController,
    IdmController,
  ],
  providers: [AdminService, TargetSystemService, LinuxFleetService, AdminRbacService],
})
export class AdminModule {}
