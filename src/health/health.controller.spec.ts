import { ConfigService } from '@nestjs/config';
import { HealthCheckService, PrismaHealthIndicator } from '@nestjs/terminus';
import { PrismaService } from '../database/prisma.service';
import { RedisIdempotencyStore } from '../core/idempotency/stores/redis-idempotency.store';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  const createController = (
    values: Record<string, unknown>,
  ): HealthController => {
    const config = {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;

    return new HealthController(
      {} as HealthCheckService,
      {} as PrismaHealthIndicator,
      {} as PrismaService,
      config,
      {} as RedisIdempotencyStore,
    );
  };

  it('exposes safe build identity on health and about', () => {
    const controller = createController({
      APP_VERSION: '99.99.99.99',
      GIT_REVISION: '0123456789abcdef0123456789abcdef01234567',
      SOURCE_CLEAN: 'true',
      BUILD_PROVENANCE: 'verified',
      RUNTIME_ARTIFACT_SHA256:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });

    expect(controller.check()).toEqual({
      status: 'ok',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      build: expect.objectContaining({
        name: 'idmMw',
        gitRevision: '0123456789abcdef0123456789abcdef01234567',
        sourceClean: true,
        provenance: 'verified',
        runtimeArtifactSha256:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    });
    expect(controller.about()).toEqual({
      name: 'idmMw',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      build: expect.objectContaining({
        provenance: 'verified',
        sourceClean: true,
      }),
    });
  });
});
