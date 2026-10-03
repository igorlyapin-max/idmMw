import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { JsonHelper } from '../database/json.helper';
import { redactSecrets } from '../security/secret-redaction';

type LinuxSecretMode = 'env' | 'aapm';

interface ListParams {
  limit?: number;
  offset?: number;
  search?: string;
  enabled?: boolean;
}

interface CredentialProfileDto {
  name: string;
  mode: LinuxSecretMode;
  username: string;
  privateKeyRef?: string;
  passwordRef?: string;
  enabled?: boolean;
}

interface HostDto {
  name: string;
  host: string;
  port?: number;
  hostFingerprint: string;
  credentialProfileId?: string | null;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}

interface ServerGroupDto {
  code: string;
  name: string;
  description?: string | null;
  enabled?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

@Injectable()
export class LinuxFleetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jsonHelper: JsonHelper,
  ) {}

  async listCredentialProfiles(targetSystemId: string, params: ListParams) {
    await this.requireLinuxTargetSystem(targetSystemId);
    const items = await this.prisma.linuxCredentialProfile.findMany({
      where: {
        targetSystemId,
        ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
        ...(params.search
          ? { name: { contains: params.search } }
          : {}),
      },
      orderBy: { name: 'asc' },
      take: this.limit(params.limit),
      skip: params.offset ?? 0,
    });
    return items.map((item) => redactSecrets(item));
  }

  async targetSystemIdForCredentialProfile(id: string): Promise<string> {
    const item = await this.prisma.linuxCredentialProfile.findUnique({
      where: { id },
      select: { targetSystemId: true },
    });
    if (!item) throw new NotFoundException('Linux credential profile not found');
    return item.targetSystemId;
  }

  async createCredentialProfile(
    targetSystemId: string,
    body: Record<string, unknown>,
  ) {
    const dto = this.credentialProfileDto(body);
    await this.requireLinuxTargetSystem(targetSystemId);
    this.validateCredentialProfile(dto);
    const item = await this.prisma.linuxCredentialProfile.create({
      data: {
        targetSystemId,
        name: dto.name.trim(),
        mode: dto.mode,
        username: dto.username.trim(),
        privateKeyRef: this.optionalText(dto.privateKeyRef),
        passwordRef: this.optionalText(dto.passwordRef),
        enabled: dto.enabled ?? true,
      },
    });
    return redactSecrets(item);
  }

  async updateCredentialProfile(id: string, body: Record<string, unknown>) {
    const current = await this.prisma.linuxCredentialProfile.findUnique({
      where: { id },
    });
    if (!current) throw new NotFoundException('Linux credential profile not found');
    const dto = this.partialCredentialProfileDto(body);
    const merged: CredentialProfileDto = {
      name: dto.name ?? current.name,
      mode: dto.mode ?? this.secretMode(current.mode),
      username: dto.username ?? current.username,
      privateKeyRef: dto.privateKeyRef ?? current.privateKeyRef ?? undefined,
      passwordRef: dto.passwordRef ?? current.passwordRef ?? undefined,
      enabled: dto.enabled ?? current.enabled,
    };
    this.validateCredentialProfile(merged);
    const item = await this.prisma.linuxCredentialProfile.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.mode !== undefined ? { mode: dto.mode } : {}),
        ...(dto.username !== undefined ? { username: dto.username.trim() } : {}),
        ...(dto.privateKeyRef !== undefined
          ? { privateKeyRef: this.optionalText(dto.privateKeyRef) }
          : {}),
        ...(dto.passwordRef !== undefined
          ? { passwordRef: this.optionalText(dto.passwordRef) }
          : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      },
    });
    return redactSecrets(item);
  }

  async deleteCredentialProfile(id: string) {
    await this.prisma.linuxCredentialProfile.delete({ where: { id } });
    return { deleted: true };
  }

  async listHosts(targetSystemId: string, params: ListParams) {
    await this.requireLinuxTargetSystem(targetSystemId);
    const items = await this.prisma.linuxHost.findMany({
      where: {
        targetSystemId,
        ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
        ...(params.search
          ? {
              OR: [
                { name: { contains: params.search } },
                { host: { contains: params.search } },
              ],
            }
          : {}),
      },
      include: { credentialProfile: true, groups: { include: { group: true } } },
      orderBy: { name: 'asc' },
      take: this.limit(params.limit),
      skip: params.offset ?? 0,
    });
    return items.map((item) => ({
      ...item,
      metadata: this.fromJson<Record<string, unknown>>(item.metadata),
      credentialProfile: item.credentialProfile
        ? redactSecrets(item.credentialProfile)
        : null,
      groups: item.groups.map((membership) => membership.group),
    }));
  }

  async targetSystemIdForHost(id: string): Promise<string> {
    const item = await this.prisma.linuxHost.findUnique({
      where: { id },
      select: { targetSystemId: true },
    });
    if (!item) throw new NotFoundException('Linux host not found');
    return item.targetSystemId;
  }

  async createHost(targetSystemId: string, body: Record<string, unknown>) {
    const dto = this.hostDto(body);
    await this.requireLinuxTargetSystem(targetSystemId);
    this.validateHost(dto);
    if (dto.credentialProfileId) {
      await this.requireCredentialProfile(targetSystemId, dto.credentialProfileId);
    }
    const data: Prisma.LinuxHostUncheckedCreateInput = {
      targetSystemId,
      name: dto.name.trim(),
      host: dto.host.trim(),
      port: dto.port ?? 22,
      hostFingerprint: dto.hostFingerprint.trim(),
      credentialProfileId: dto.credentialProfileId || null,
      enabled: dto.enabled ?? true,
      metadata: this.toJson(dto.metadata ?? {}) as never,
    };
    return this.prisma.linuxHost.create({ data });
  }

  async updateHost(id: string, body: Record<string, unknown>) {
    const current = await this.prisma.linuxHost.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Linux host not found');
    const dto = this.partialHostDto(body);
    const merged: HostDto = {
      name: dto.name ?? current.name,
      host: dto.host ?? current.host,
      port: dto.port ?? current.port,
      hostFingerprint: dto.hostFingerprint ?? current.hostFingerprint,
      credentialProfileId:
        dto.credentialProfileId !== undefined
          ? dto.credentialProfileId
          : current.credentialProfileId,
      enabled: dto.enabled ?? current.enabled,
      metadata: dto.metadata,
    };
    this.validateHost(merged);
    if (dto.credentialProfileId) {
      await this.requireCredentialProfile(
        current.targetSystemId,
        dto.credentialProfileId,
      );
    }
    const data: Prisma.LinuxHostUncheckedUpdateInput = {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.host !== undefined ? { host: dto.host.trim() } : {}),
      ...(dto.port !== undefined ? { port: dto.port } : {}),
      ...(dto.hostFingerprint !== undefined
        ? { hostFingerprint: dto.hostFingerprint.trim() }
        : {}),
      ...(dto.credentialProfileId !== undefined
        ? { credentialProfileId: dto.credentialProfileId || null }
        : {}),
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(dto.metadata !== undefined
        ? { metadata: this.toJson(dto.metadata) as never }
        : {}),
    };
    return this.prisma.linuxHost.update({ where: { id }, data });
  }

  async deleteHost(id: string) {
    await this.prisma.linuxHost.delete({ where: { id } });
    return { deleted: true };
  }

  async listGroups(targetSystemId: string, params: ListParams) {
    await this.requireLinuxTargetSystem(targetSystemId);
    const items = await this.prisma.linuxServerGroup.findMany({
      where: {
        targetSystemId,
        ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
        ...(params.search
          ? {
              OR: [
                { code: { contains: params.search } },
                { name: { contains: params.search } },
              ],
            }
          : {}),
      },
      include: { hosts: true },
      orderBy: { code: 'asc' },
      take: this.limit(params.limit),
      skip: params.offset ?? 0,
    });
    return items.map((item) => ({
      ...item,
      hostCount: item.hosts.length,
      hosts: undefined,
    }));
  }

  async targetSystemIdForGroup(id: string): Promise<string> {
    const item = await this.prisma.linuxServerGroup.findUnique({
      where: { id },
      select: { targetSystemId: true },
    });
    if (!item) throw new NotFoundException('Linux server group not found');
    return item.targetSystemId;
  }

  async createGroup(targetSystemId: string, body: Record<string, unknown>) {
    const dto = this.serverGroupDto(body);
    await this.requireLinuxTargetSystem(targetSystemId);
    this.validateGroup(dto);
    return this.prisma.linuxServerGroup.create({
      data: {
        targetSystemId,
        code: dto.code.trim(),
        name: dto.name.trim(),
        description: this.optionalText(dto.description),
        enabled: dto.enabled ?? true,
      },
    });
  }

  async updateGroup(id: string, body: Record<string, unknown>) {
    const current = await this.prisma.linuxServerGroup.findUnique({
      where: { id },
    });
    if (!current) throw new NotFoundException('Linux server group not found');
    const dto = this.partialServerGroupDto(body);
    this.validateGroup({ ...current, ...dto });
    return this.prisma.linuxServerGroup.update({
      where: { id },
      data: {
        ...(dto.code !== undefined ? { code: dto.code.trim() } : {}),
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined
          ? { description: this.optionalText(dto.description) }
          : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      },
    });
  }

  async deleteGroup(id: string) {
    await this.prisma.linuxServerGroup.delete({ where: { id } });
    return { deleted: true };
  }

  async setGroupHosts(groupId: string, hostIds: string[]) {
    const group = await this.prisma.linuxServerGroup.findUnique({
      where: { id: groupId },
    });
    if (!group) throw new NotFoundException('Linux server group not found');
    const uniqueHostIds = [...new Set(hostIds)];
    const count = await this.prisma.linuxHost.count({
      where: { id: { in: uniqueHostIds }, targetSystemId: group.targetSystemId },
    });
    if (count !== uniqueHostIds.length) {
      throw new BadRequestException(
        'All hosts must belong to the same target system as the group',
      );
    }
    await this.prisma.$transaction([
      this.prisma.linuxServerGroupHost.deleteMany({ where: { groupId } }),
      this.prisma.linuxServerGroupHost.createMany({
        data: uniqueHostIds.map((hostId) => ({ groupId, hostId })),
      }),
    ]);
    return { groupId, hostIds: uniqueHostIds };
  }

  private async requireLinuxTargetSystem(id: string) {
    const targetSystem = await this.prisma.targetSystem.findUnique({
      where: { id },
    });
    if (!targetSystem) throw new NotFoundException('TargetSystem not found');
    if (targetSystem.type !== 'linux') {
      throw new BadRequestException('TargetSystem is not linux');
    }
    return targetSystem;
  }

  private async requireCredentialProfile(targetSystemId: string, id: string) {
    const profile = await this.prisma.linuxCredentialProfile.findFirst({
      where: { id, targetSystemId },
    });
    if (!profile) {
      throw new BadRequestException(
        'Credential profile must belong to the same target system',
      );
    }
    return profile;
  }

  private validateCredentialProfile(dto: CredentialProfileDto): void {
    if (!this.optionalText(dto.name)) throw new BadRequestException('Missing name');
    if (!['env', 'aapm'].includes(dto.mode)) {
      throw new BadRequestException('Linux credential mode must be env or aapm');
    }
    if (!this.optionalText(dto.username)) {
      throw new BadRequestException('Missing username');
    }
    if (!this.optionalText(dto.privateKeyRef) && !this.optionalText(dto.passwordRef)) {
      throw new BadRequestException('Missing privateKeyRef or passwordRef');
    }
  }

  private validateHost(dto: HostDto): void {
    if (!this.optionalText(dto.name)) throw new BadRequestException('Missing name');
    if (!this.optionalText(dto.host)) throw new BadRequestException('Missing host');
    if (!this.optionalText(dto.hostFingerprint)) {
      throw new BadRequestException('Missing hostFingerprint');
    }
    if (dto.port !== undefined && (!Number.isInteger(dto.port) || dto.port <= 0)) {
      throw new BadRequestException('Invalid port');
    }
  }

  private validateGroup(dto: ServerGroupDto): void {
    const code = this.optionalText(dto.code);
    if (!code) throw new BadRequestException('Missing code');
    if (!/^[A-Za-z0-9_.:-]{1,96}$/.test(code)) {
      throw new BadRequestException('Invalid Linux server group code');
    }
    if (!this.optionalText(dto.name)) throw new BadRequestException('Missing name');
  }

  private optionalText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private secretMode(value: string): LinuxSecretMode {
    return value === 'aapm' ? 'aapm' : 'env';
  }

  private credentialProfileDto(body: Record<string, unknown>): CredentialProfileDto {
    return {
      name: String(body['name'] ?? ''),
      mode: body['mode'] === 'aapm' ? 'aapm' : 'env',
      username: String(body['username'] ?? ''),
      privateKeyRef: this.optionalText(body['privateKeyRef']),
      passwordRef: this.optionalText(body['passwordRef']),
      enabled:
        typeof body['enabled'] === 'boolean' ? body['enabled'] : undefined,
    };
  }

  private partialCredentialProfileDto(
    body: Record<string, unknown>,
  ): Partial<CredentialProfileDto> {
    const dto: Partial<CredentialProfileDto> = {};
    if ('name' in body) dto.name = String(body['name'] ?? '');
    if ('mode' in body) dto.mode = body['mode'] === 'aapm' ? 'aapm' : 'env';
    if ('username' in body) dto.username = String(body['username'] ?? '');
    if ('privateKeyRef' in body) dto.privateKeyRef = this.optionalText(body['privateKeyRef']);
    if ('passwordRef' in body) dto.passwordRef = this.optionalText(body['passwordRef']);
    if (typeof body['enabled'] === 'boolean') dto.enabled = body['enabled'];
    return dto;
  }

  private hostDto(body: Record<string, unknown>): HostDto {
    return {
      name: String(body['name'] ?? ''),
      host: String(body['host'] ?? ''),
      port: this.optionalPositiveInteger(body['port']),
      hostFingerprint: String(body['hostFingerprint'] ?? ''),
      credentialProfileId:
        typeof body['credentialProfileId'] === 'string'
          ? body['credentialProfileId']
          : null,
      enabled:
        typeof body['enabled'] === 'boolean' ? body['enabled'] : undefined,
      metadata: asRecord(body['metadata']),
    };
  }

  private partialHostDto(body: Record<string, unknown>): Partial<HostDto> {
    const dto: Partial<HostDto> = {};
    if ('name' in body) dto.name = String(body['name'] ?? '');
    if ('host' in body) dto.host = String(body['host'] ?? '');
    if ('port' in body) dto.port = this.optionalPositiveInteger(body['port']);
    if ('hostFingerprint' in body) {
      dto.hostFingerprint = String(body['hostFingerprint'] ?? '');
    }
    if ('credentialProfileId' in body) {
      dto.credentialProfileId =
        typeof body['credentialProfileId'] === 'string'
          ? body['credentialProfileId']
          : null;
    }
    if (typeof body['enabled'] === 'boolean') dto.enabled = body['enabled'];
    if ('metadata' in body) dto.metadata = asRecord(body['metadata']);
    return dto;
  }

  private serverGroupDto(body: Record<string, unknown>): ServerGroupDto {
    return {
      code: String(body['code'] ?? ''),
      name: String(body['name'] ?? ''),
      description:
        body['description'] === null
          ? null
          : this.optionalText(body['description']),
      enabled:
        typeof body['enabled'] === 'boolean' ? body['enabled'] : undefined,
    };
  }

  private partialServerGroupDto(
    body: Record<string, unknown>,
  ): Partial<ServerGroupDto> {
    const dto: Partial<ServerGroupDto> = {};
    if ('code' in body) dto.code = String(body['code'] ?? '');
    if ('name' in body) dto.name = String(body['name'] ?? '');
    if ('description' in body) {
      dto.description =
        body['description'] === null
          ? null
          : this.optionalText(body['description']);
    }
    if (typeof body['enabled'] === 'boolean') dto.enabled = body['enabled'];
    return dto;
  }

  private optionalPositiveInteger(value: unknown): number | undefined {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }

  private limit(value: number | undefined): number {
    return Math.min(Math.max(value ?? 50, 1), 500);
  }

  private toJson(value: unknown): unknown {
    return this.jsonHelper.toJson(value);
  }

  private fromJson<T>(value: unknown): T | null {
    return this.jsonHelper.fromJson<T>(value);
  }
}
