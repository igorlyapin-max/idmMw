import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { JsonHelper } from '../database/json.helper';
import { ConnectorRegistry } from '../connectors/connector.registry';
import {
  mergeConfigPreservingSecrets,
  redactSecrets,
} from '../security/secret-redaction';
import type {
  CreateTargetSystemDto,
  UpdateTargetSystemDto,
} from './dto/target-system.dto';

@Injectable()
export class TargetSystemService {
  private readonly logger = new Logger(TargetSystemService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jsonHelper: JsonHelper,
    private readonly registry: ConnectorRegistry,
  ) {}

  async findAll(params: {
    type?: string;
    enabled?: boolean;
    limit?: number;
    offset?: number;
    allowedTypes?: string[];
  }) {
    if (params.allowedTypes && params.allowedTypes.length === 0) {
      return [];
    }
    if (
      params.type &&
      params.allowedTypes &&
      !params.allowedTypes.includes(params.type)
    ) {
      return [];
    }
    const items = await this.prisma.targetSystem.findMany({
      where: {
        ...(params.type
          ? { type: params.type }
          : params.allowedTypes
            ? { type: { in: params.allowedTypes } }
            : {}),
        ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
      },
      take: params.limit ?? 50,
      skip: params.offset ?? 0,
      orderBy: { createdAt: 'desc' },
    });
    return items.map((item) => this.toPublicTargetSystem(item));
  }

  async findById(id: string) {
    const item = await this.prisma.targetSystem.findUnique({ where: { id } });
    if (!item) return null;
    return this.toPublicTargetSystem(item);
  }

  async findByName(name: string) {
    const item = await this.prisma.targetSystem.findUnique({ where: { name } });
    if (!item) return null;
    return this.toPublicTargetSystem(item);
  }

  async findRawConfigByName(
    name: string,
  ): Promise<Record<string, unknown> | null> {
    const item = await this.prisma.targetSystem.findUnique({
      where: { name },
      select: { config: true },
    });
    if (!item) return null;
    return this.jsonHelper.fromJson<Record<string, unknown>>(item.config) ?? {};
  }

  async create(dto: CreateTargetSystemDto) {
    try {
      this.validateTargetSystemConfig(dto.type, dto.config);
      const item = await this.prisma.targetSystem.create({
        data: {
          name: dto.name,
          type: dto.type,
          label: dto.label,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          config: this.jsonHelper.toJson(dto.config) as any,
          enabled: dto.enabled ?? true,
        },
      });
      return this.toPublicTargetSystem(item);
    } catch (error: unknown) {
      this.handlePrismaMutationError(error);
    }
  }

  async update(id: string, dto: UpdateTargetSystemDto) {
    try {
      const needsCurrent = dto.config !== undefined || dto.type !== undefined;
      const current = needsCurrent
        ? await this.prisma.targetSystem.findUnique({ where: { id } })
        : null;
      if (needsCurrent && !current) {
        throw new NotFoundException('TargetSystem not found');
      }
      const currentConfig =
        current && needsCurrent
          ? (this.jsonHelper.fromJson<Record<string, unknown>>(
              current.config,
            ) ?? {})
          : {};
      const nextConfig =
        dto.config !== undefined
          ? mergeConfigPreservingSecrets(currentConfig, dto.config)
          : undefined;
      if (needsCurrent && current) {
        this.validateTargetSystemConfig(
          dto.type ?? current.type,
          nextConfig ?? currentConfig,
        );
      }
      const item = await this.prisma.targetSystem.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.type !== undefined ? { type: dto.type } : {}),
          ...(dto.label !== undefined ? { label: dto.label } : {}),
          ...(dto.config !== undefined
            ? {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                config: this.jsonHelper.toJson(nextConfig) as any,
              }
            : {}),
          ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        },
      });
      return this.toPublicTargetSystem(item);
    } catch (error: unknown) {
      this.handlePrismaMutationError(error);
    }
  }

  async delete(id: string) {
    try {
      const item = await this.prisma.targetSystem.delete({ where: { id } });
      return this.toPublicTargetSystem(item);
    } catch (error: unknown) {
      this.handlePrismaMutationError(error);
    }
  }

  async testConnection(
    id: string,
  ): Promise<{ success: boolean; message: string }> {
    const ts = await this.prisma.targetSystem.findUnique({ where: { id } });
    if (!ts) {
      return { success: false, message: 'TargetSystem not found' };
    }
    const config =
      this.jsonHelper.fromJson<Record<string, unknown>>(ts.config) ?? {};
    config['diagnosticTargetSystem'] = ts.name;
    return this.registry.testConnection(ts.type, config);
  }

  private handlePrismaMutationError(error: unknown): never {
    if (this.isPrismaError(error, 'P2002')) {
      throw new ConflictException('TargetSystem name already exists');
    }

    if (this.isPrismaError(error, 'P2025')) {
      throw new NotFoundException('TargetSystem not found');
    }

    throw error;
  }

  private isPrismaError(error: unknown, code: string): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === code
    );
  }

  private validateTargetSystemConfig(
    type: string,
    config: Record<string, unknown>,
  ): void {
    if (type !== 'cmdbuild') {
      return;
    }

    this.validateCmdbuildGroupMode(
      config['defaultUserGroupMode'],
      'defaultUserGroupMode',
    );
    this.validateCmdbuildGroupMode(
      config['incomingGroupsMode'],
      'incomingGroupsMode',
    );

    if (
      this.booleanConfig(config['defaultUserGroupEnabled']) &&
      !this.nonEmptyScalar(config['defaultUserGroupValue'])
    ) {
      throw new BadRequestException(
        'CMDBuild defaultUserGroupValue is required when defaultUserGroupEnabled is true',
      );
    }
  }

  private validateCmdbuildGroupMode(value: unknown, fieldName: string): void {
    if (value === undefined || value === null || value === '') {
      return;
    }
    if (typeof value !== 'string' || !['id', 'name'].includes(value)) {
      throw new BadRequestException(
        `Invalid CMDBuild ${fieldName}: expected id or name`,
      );
    }
  }

  private booleanConfig(value: unknown): boolean {
    return (
      value === true ||
      (typeof value === 'string' &&
        ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase()))
    );
  }

  private nonEmptyScalar(value: unknown): boolean {
    if (typeof value === 'number') {
      return Number.isFinite(value);
    }
    return typeof value === 'string' && value.trim().length > 0;
  }

  private toPublicTargetSystem<T extends { config: unknown }>(
    item: T,
  ): Omit<T, 'config'> & { config: Record<string, unknown> } {
    const config =
      this.jsonHelper.fromJson<Record<string, unknown>>(item.config) ?? {};
    return {
      ...item,
      config: redactSecrets(config) as Record<string, unknown>,
    };
  }
}
