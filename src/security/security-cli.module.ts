import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { appConfigSchema } from '../config/app.config';
import { createPinoHttpConfig } from '../config/logging.config';
import { PrismaModule } from '../database/prisma.module';
import { SecretsModule } from '../secrets/secrets.module';
import { SecurityModule } from './security.module';
import { EncryptionRotationService } from './encryption-rotation.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (config: Record<string, unknown>) => {
        const parsed = appConfigSchema.safeParse(config);
        if (!parsed.success) {
          throw new Error(`Config validation error: ${parsed.error.message}`);
        }
        return parsed.data;
      },
    }),
    LoggerModule.forRoot({
      pinoHttp: createPinoHttpConfig(),
    }),
    SecurityModule,
    SecretsModule,
    PrismaModule,
  ],
  providers: [EncryptionRotationService],
  exports: [EncryptionRotationService],
})
export class SecurityCliModule {}
