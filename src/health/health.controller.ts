import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaService } from '../database/prisma.service';
import { RedisIdempotencyStore } from '../core/idempotency/stores/redis-idempotency.store';

interface BuildIdentity {
  name: string;
  version: string;
  gitRevision: string;
  sourceClean: boolean;
  provenance: string;
  runtimeArtifactSha256: string;
}

@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prisma: PrismaHealthIndicator,
    private readonly prismaService: PrismaService,
    private readonly config: ConfigService,
    private readonly redisStore: RedisIdempotencyStore,
  ) {}

  @Get('health')
  check() {
    return { status: 'ok', build: this.buildIdentity() };
  }

  @Get('about')
  about() {
    return { name: 'idmMw', build: this.buildIdentity() };
  }

  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.prisma.pingCheck('database', this.prismaService),
      () => this.redisStore.healthCheck(),
      () =>
        Promise.resolve({
          kafka: {
            status: 'up',
            enabled: this.config.get<boolean>('KAFKA_ENABLED') ?? false,
            brokers: this.config.get<string>('KAFKA_BROKERS') ?? null,
            processingMode:
              this.config.get<string>('IDMMW_PROCESSING_MODE') ?? 'sync',
            topics: {
              eventsIn: this.config.get<string>('KAFKA_TOPIC_EVENTS_IN'),
              eventsOut: this.config.get<string>('KAFKA_TOPIC_EVENTS_OUT'),
              dlqRetry: this.config.get<string>('KAFKA_TOPIC_DLQ_RETRY'),
            },
          },
        }),
    ]);
  }

  private buildIdentity(): BuildIdentity {
    return {
      name: 'idmMw',
      version:
        this.readTextFile(resolve(process.cwd(), 'VERSION')) ??
        this.config.get<string>('APP_VERSION') ??
        '0.0.0.0',
      gitRevision: this.config.get<string>('GIT_REVISION') ?? 'unknown',
      sourceClean: this.config.get<string>('SOURCE_CLEAN') === 'true',
      provenance:
        this.config.get<string>('BUILD_PROVENANCE') ?? 'unverified-local',
      runtimeArtifactSha256:
        this.config.get<string>('RUNTIME_ARTIFACT_SHA256') ??
        this.readTextFile('/app/build/runtime-artifact.sha256') ??
        'unknown',
    };
  }

  private readTextFile(path: string): string | undefined {
    try {
      const value = readFileSync(path, 'utf8').trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  }
}
