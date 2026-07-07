import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../database/prisma.module';
import { ConnectorRegistry } from './connector.registry';
import { RestConnectorService } from './implementations/rest-connector/rest-connector.service';
import { DbConnectorService } from './implementations/db-connector/db-connector.service';
import { ZabbixConnectorService } from './implementations/zabbix-connector/zabbix-connector.service';
import { CmdbuildConnectorService } from './implementations/cmdbuild-connector/cmdbuild-connector.service';
import { FakeConnectorService } from './implementations/fake-connector/fake-connector.service';
import { PassworkConnectorService } from './implementations/passwork-connector/passwork-connector.service';
import { ConsultantPlusConnectorService } from './implementations/consultant-plus-connector/consultant-plus-connector.service';

@Module({
  imports: [HttpModule, PrismaModule],
  providers: [
    ConnectorRegistry,
    RestConnectorService,
    DbConnectorService,
    ZabbixConnectorService,
    CmdbuildConnectorService,
    FakeConnectorService,
    PassworkConnectorService,
    ConsultantPlusConnectorService,
  ],
  exports: [ConnectorRegistry],
})
export class ConnectorsModule {}
