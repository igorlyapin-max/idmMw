import { Injectable, Logger, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import {
  Connector,
  ConnectorCapabilities,
  ConnectorPayload,
  ConnectorResult,
} from '../../connector.interface';
import { createConnectorCapabilities } from '../../connector.capabilities';
import {
  TlsConnectionConfig,
  TlsOptionsFactory,
} from '../../../security/tls-options.factory';
import { SECRET_REDACTION_CENSOR } from '../../../security/secret-redaction';
import { fixedLengthFingerprint } from '../../../security/constant-time';

export type CmdbuildAuthMode = 'session' | 'basic';

export interface CmdbuildConfig {
  baseUrl: string;
  username: string;
  password: string;
  apiPath?: string;
  defaultUserGroupId?: string | number;
  authMode?: CmdbuildAuthMode;
  tls?: TlsConnectionConfig;
}

const CMDBUILD_PARTIAL_OPERATIONS: Record<string, string> = {
  'user.delete':
    'CMDBuild REST v3 user DELETE is not available on the test stand; mapped to active=false.',
  'user.lock':
    'CMDBuild user API has no separate IDM lock flag; mapped to active=false.',
  'user.unlock':
    'CMDBuild user API has no separate IDM unlock flag; mapped to active=true.',
  'user.changePassword':
    'CMDBuild REST v3 /users/{id}/password is not available on the test stand; mapped to full PUT /users/{id} with password.',
  'user.addAttributes':
    'Generic PUT on /users/{id}; accepted attributes depend on CMDBuild user model.',
  'user.removeAttributes':
    'Generic PUT on /users/{id}; requested fields are sent as null values.',
  'schema.get':
    'Returns CMDBuild class catalog, not a transformed Avanpost IDM schema.',
  'group.delete':
    'CMDBuild REST v3 role DELETE is not available on the test stand; mapped to active=false.',
  'group.addMember':
    'CMDBuild REST v3 POST /roles/{id}/users fails on the test stand; mapped to full PUT /users/{id} userGroups update.',
  'group.removeMember':
    'CMDBuild REST v3 POST /roles/{id}/users fails on the test stand; mapped to full PUT /users/{id} userGroups update.',
  'group.search':
    'CMDBuild REST v3 /roles filter is ignored on the test stand; connector applies bounded client-side filtering.',
  'sync.incremental':
    'Uses /users without a CMDBuild change cursor or high-watermark.',
};

const MIN_LITERAL_SECRET_LENGTH = 4;

@Injectable()
export class CmdbuildConnectorService implements Connector {
  readonly name = 'cmdbuild';
  private readonly logger = new Logger(CmdbuildConnectorService.name);
  private readonly sessionTokens = new Map<string, string>();

  constructor(
    private readonly httpService: HttpService,
    @Optional() private readonly tlsOptions?: TlsOptionsFactory,
  ) {}

  getCapabilities(): ConnectorCapabilities {
    return createConnectorCapabilities(CMDBUILD_PARTIAL_OPERATIONS, {
      supportsIncrementalSync: false,
    });
  }

  async execute(payload: ConnectorPayload): Promise<ConnectorResult> {
    const config = payload.payload['config'] as CmdbuildConfig | undefined;
    if (!config?.baseUrl) {
      return { success: false, error: 'Missing CMDBuild config (baseUrl)' };
    }

    try {
      const operation = payload.operation;
      const data = (payload.payload['data'] ?? {}) as Record<string, unknown>;
      const params = (payload.payload['params'] ?? {}) as Record<
        string,
        unknown
      >;

      // Special handling for group member operations to preserve existing members
      if (
        operation === 'group.addMember' ||
        operation === 'group.removeMember'
      ) {
        const roleId = (params['roleId'] ??
          data['roleId'] ??
          params['id'] ??
          data['id']) as string;
        const userId = (params['userId'] ?? data['userId']) as string;
        if (!roleId || !userId) {
          return {
            success: false,
            error: 'Missing roleId or userId for group member operation',
          };
        }
        const response = await this.updateUserRoleMembership(
          config,
          roleId,
          userId,
          operation === 'group.addMember',
        );
        return { success: true, data: response };
      }

      const specialResponse = await this.executeStatefulOperation(
        config,
        operation,
        data,
        params,
      );
      if (specialResponse !== undefined) {
        this.logger.log(`CMDBuild ${operation} succeeded`);
        return { success: true, data: specialResponse };
      }

      const { url, method, body } = this.buildRequest(
        config,
        operation,
        data,
        params,
      );
      const response = await this.call(config, method, url, body);
      this.logger.log(`CMDBuild ${operation} succeeded`);
      return { success: true, data: response };
    } catch (error: unknown) {
      const msg = this.safeErrorMessage(error, config);
      this.logger.error(`CMDBuild operation failed: ${msg}`);
      return { success: false, error: msg };
    }
  }

  private getApiPath(config: CmdbuildConfig): string {
    return config.apiPath ?? '/cmdbuild/services/rest/v3';
  }

  private getBasicAuthHeader(config: CmdbuildConfig): string {
    const creds = Buffer.from(`${config.username}:${config.password}`).toString(
      'base64',
    );
    return `Basic ${creds}`;
  }

  private normalizeAuthMode(config: CmdbuildConfig): CmdbuildAuthMode {
    const raw = config.authMode as unknown;
    if (raw === undefined || raw === null) {
      return 'session';
    }
    if (typeof raw !== 'string') {
      throw new Error('Invalid CMDBuild authMode: expected session or basic');
    }
    const normalized = raw.trim().toLowerCase();
    if (!normalized || normalized === 'session') {
      return 'session';
    }
    if (normalized === 'basic') {
      return 'basic';
    }
    throw new Error('Invalid CMDBuild authMode: expected session or basic');
  }

  private async getAuthHeaders(
    config: CmdbuildConfig,
    authMode = this.normalizeAuthMode(config),
  ): Promise<Record<string, string>> {
    if (authMode === 'basic') {
      return { Authorization: this.getBasicAuthHeader(config) };
    }

    return { 'Cmdbuild-Authorization': await this.getSessionId(config) };
  }

  private sessionCacheKey(config: CmdbuildConfig): string {
    return [
      config.baseUrl.replace(/\/+$/, ''),
      this.getApiPath(config),
      config.username,
      this.normalizeAuthMode(config),
      fixedLengthFingerprint(config.password ?? '', 'cmdbuild-session-cache'),
    ].join('|');
  }

  private async getSessionId(config: CmdbuildConfig): Promise<string> {
    const cacheKey = this.sessionCacheKey(config);
    const cached = this.sessionTokens.get(cacheKey);
    if (cached) {
      return cached;
    }

    const apiPath = this.getApiPath(config);
    const url = `${config.baseUrl}${apiPath}/sessions?scope=service&returnId=true`;

    try {
      const response = await lastValueFrom(
        this.httpService.request({
          url,
          method: 'POST',
          data: { username: config.username, password: config.password },
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000,
          ...(this.tlsOptions?.axiosConfig(
            config.baseUrl,
            config.tls,
            'CMDBuild',
          ) ?? {}),
        }),
      );
      const sessionId = this.extractSessionId(response.data);
      if (!sessionId) {
        throw new Error('CMDBuild session response did not include _id');
      }
      this.sessionTokens.set(cacheKey, sessionId);
      return sessionId;
    } catch (error: unknown) {
      throw new Error(
        `CMDBuild session authentication failed: ${this.safeErrorMessage(
          error,
          config,
        )}`,
      );
    }
  }

  private extractSessionId(value: unknown): string | undefined {
    if (value === null || typeof value !== 'object') {
      return undefined;
    }
    const topLevel = value as Record<string, unknown>;
    const topLevelId = topLevel['_id'];
    if (typeof topLevelId === 'string' && topLevelId.trim()) {
      return topLevelId;
    }
    const data = topLevel['data'];
    if (data === null || typeof data !== 'object') {
      return undefined;
    }
    const nestedId = (data as Record<string, unknown>)['_id'];
    return typeof nestedId === 'string' && nestedId.trim()
      ? nestedId
      : undefined;
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (
      error !== null &&
      typeof error === 'object' &&
      typeof (error as { message?: unknown }).message === 'string'
    ) {
      return (error as { message: string }).message;
    }
    return String(error);
  }

  private safeErrorMessage(error: unknown, config?: CmdbuildConfig): string {
    let msg = this.getErrorMessage(error);
    const basicHeader =
      config?.username !== undefined && config.password !== undefined
        ? this.getBasicAuthHeader(config)
        : undefined;
    const secrets = [
      config?.password,
      basicHeader,
      ...Array.from(this.sessionTokens.values()),
    ]
      .filter(
        (secret): secret is string =>
          typeof secret === 'string' &&
          secret.length >= MIN_LITERAL_SECRET_LENGTH,
      )
      .sort((left, right) => right.length - left.length);
    for (const secret of secrets) {
      msg = msg.split(secret).join(SECRET_REDACTION_CENSOR);
    }
    return msg
      .replace(
        /\bBasic\s+[A-Za-z0-9+/=._-]+/g,
        `Basic ${SECRET_REDACTION_CENSOR}`,
      )
      .replace(
        /((?:Authorization|Cmdbuild-Authorization)\s*[:=]\s*)(?:Basic\s+)?[^,\s}]+/gi,
        `$1${SECRET_REDACTION_CENSOR}`,
      )
      .replace(
        /((?:password|passwd|pwd|token|secret)\s*[:=]\s*)[^,\s}]+/gi,
        `$1${SECRET_REDACTION_CENSOR}`,
      );
  }

  private appendQuery(path: string, query: Record<string, unknown>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        params.set(key, this.toQueryString(value));
      }
    }
    const suffix = params.toString();
    return suffix ? `${path}?${suffix}` : path;
  }

  private firstQueryValue(...values: unknown[]): unknown {
    return values.find(
      (value) => value !== undefined && value !== null && value !== '',
    );
  }

  private buildSimpleFilter(
    attribute: string,
    value: unknown,
    operator: 'equal' | 'like' = 'like',
  ): string | undefined {
    const normalized = this.firstQueryValue(value);
    if (normalized === undefined) {
      return undefined;
    }
    if (typeof normalized === 'object') {
      return JSON.stringify(normalized);
    }
    const text = this.toQueryString(normalized).trim();
    if (!text) {
      return undefined;
    }
    if (text.startsWith('{') || text.startsWith('[')) {
      return text;
    }

    return JSON.stringify({
      attribute: {
        simple: {
          attribute,
          operator,
          value: [text],
        },
      },
    });
  }

  private async call(
    config: CmdbuildConfig,
    method: string,
    path: string,
    body?: unknown,
    retrySessionAuth = true,
  ): Promise<unknown> {
    const authMode = this.normalizeAuthMode(config);
    const apiPath = this.getApiPath(config);
    const url = `${config.baseUrl}${apiPath}${path}`;

    try {
      const authHeaders = await this.getAuthHeaders(config, authMode);
      const response = await lastValueFrom(
        this.httpService.request({
          url,
          method,
          data: body,
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          timeout: 30000,
          ...(this.tlsOptions?.axiosConfig(
            config.baseUrl,
            config.tls,
            'CMDBuild',
          ) ?? {}),
        }),
      );
      return response.data;
    } catch (error: unknown) {
      if (
        retrySessionAuth &&
        authMode === 'session' &&
        this.isSessionAuthFailure(error)
      ) {
        this.sessionTokens.delete(this.sessionCacheKey(config));
        return this.call(config, method, path, body, false);
      }
      throw error;
    }
  }

  private isSessionAuthFailure(error: unknown): boolean {
    if (error === null || typeof error !== 'object') {
      return false;
    }
    const status = (error as { response?: { status?: unknown } }).response
      ?.status;
    return status === 401 || status === 403;
  }

  private async getEntity(
    config: CmdbuildConfig,
    path: string,
  ): Promise<Record<string, unknown>> {
    const response = (await this.call(config, 'GET', path)) as {
      data?: Record<string, unknown>;
    };
    if (!response.data) {
      throw new Error(`CMDBuild entity not found: ${path}`);
    }
    return response.data;
  }

  private async putMerged(
    config: CmdbuildConfig,
    path: string,
    patch: Record<string, unknown>,
  ): Promise<unknown> {
    const current = await this.getEntity(config, path);
    return this.call(config, 'PUT', path, { ...current, ...patch });
  }

  private applyDefaultUserGroup(
    config: CmdbuildConfig,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    if (
      data['userGroups'] !== undefined ||
      config.defaultUserGroupId === undefined
    ) {
      return data;
    }

    return {
      active: true,
      service: false,
      language: 'en',
      ...data,
      userGroups: [{ _id: config.defaultUserGroupId }],
    };
  }

  private async updateUserRoleMembership(
    config: CmdbuildConfig,
    roleId: string,
    userId: string,
    add: boolean,
  ): Promise<unknown> {
    const safeUserId = this.pathSegment(userId, 'userId');
    const user = await this.getEntity(config, `/users/${safeUserId}`);
    const currentGroups = Array.isArray(user['userGroups'])
      ? (user['userGroups'] as Array<Record<string, unknown>>)
      : [];
    const hasRole = currentGroups.some(
      (group) => String(group['_id']) === String(roleId),
    );
    let nextGroups = currentGroups;
    if (add && !hasRole) {
      nextGroups = [...currentGroups, { _id: roleId }];
    } else if (!add) {
      nextGroups = currentGroups.filter(
        (group) => String(group['_id']) !== String(roleId),
      );
    }

    return this.call(config, 'PUT', `/users/${safeUserId}`, {
      ...user,
      userGroups: nextGroups.map((group) => ({ _id: group['_id'] })),
    });
  }

  private toPositiveInteger(value: unknown, fallback: number): number {
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric <= 0) {
      return fallback;
    }
    return numeric;
  }

  private async searchRoles(
    config: CmdbuildConfig,
    filter: unknown,
    limitValue: unknown,
  ): Promise<unknown> {
    const requestedLimit = this.toPositiveInteger(limitValue, 50);
    const sourceLimit = Math.max(requestedLimit, 500);
    const response = (await this.call(
      config,
      'GET',
      this.appendQuery('/roles', { limit: sourceLimit }),
    )) as { data?: Array<Record<string, unknown>>; meta?: unknown };
    const rows = Array.isArray(response.data) ? response.data : [];
    const text = this.firstQueryValue(filter);
    const needle =
      text === undefined
        ? undefined
        : this.toQueryString(text).trim().toLocaleLowerCase();
    const filtered = needle
      ? rows.filter((row) =>
          [row['name'], row['description']]
            .filter((value) => value !== undefined && value !== null)
            .some((value) =>
              this.toQueryString(value).toLocaleLowerCase().includes(needle),
            ),
        )
      : rows;

    return {
      ...response,
      data: filtered.slice(0, requestedLimit),
      meta: {
        ...((response.meta as Record<string, unknown> | undefined) ?? {}),
        total: filtered.length,
      },
    };
  }

  private async executeStatefulOperation(
    config: CmdbuildConfig,
    operation: string,
    data: Record<string, unknown>,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = (params['id'] ?? data['id']) as string | undefined;

    switch (operation) {
      case 'user.create':
        return this.call(
          config,
          'POST',
          '/users',
          this.applyDefaultUserGroup(config, data),
        );

      case 'user.update':
      case 'user.addAttributes':
        return this.putMerged(
          config,
          `/users/${this.pathSegment(id, 'id')}`,
          data,
        );

      case 'user.removeAttributes':
        return this.putMerged(
          config,
          `/users/${this.pathSegment(id, 'id')}`,
          Object.fromEntries(Object.keys(data).map((key) => [key, null])),
        );

      case 'user.enable':
      case 'user.unlock':
        return this.putMerged(config, `/users/${this.pathSegment(id, 'id')}`, {
          active: true,
        });

      case 'user.disable':
      case 'user.lock':
      case 'user.delete':
        return this.putMerged(config, `/users/${this.pathSegment(id, 'id')}`, {
          active: false,
        });

      case 'user.changePassword': {
        const password = this.firstQueryValue(
          data['newValue'],
          data['password'],
        );
        if (!password) {
          throw new Error('Missing password for user.changePassword');
        }
        return this.putMerged(config, `/users/${this.pathSegment(id, 'id')}`, {
          password,
        });
      }

      case 'group.update':
        return this.putMerged(
          config,
          `/roles/${this.pathSegment(id, 'id')}`,
          data,
        );

      case 'group.delete':
        return this.putMerged(config, `/roles/${this.pathSegment(id, 'id')}`, {
          active: false,
        });

      case 'group.search':
        return this.searchRoles(
          config,
          this.firstQueryValue(params['filter'], data['filter']),
          this.firstQueryValue(params['limit'], data['limit']),
        );

      default:
        return undefined;
    }
  }

  private toQueryString(value: unknown): string {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      return String(value);
    }
    return JSON.stringify(value);
  }

  private pathSegment(value: unknown, name: string): string {
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new Error(`Missing ${name}`);
    }
    const text = String(value).trim();
    if (
      !text ||
      text === '.' ||
      text === '..' ||
      text.includes('/') ||
      text.includes('\\') ||
      text.includes('?') ||
      text.includes('#') ||
      /%2f|%5c/i.test(text)
    ) {
      throw new Error(`Invalid CMDBuild path segment: ${name}`);
    }
    return encodeURIComponent(text);
  }

  private buildRequest(
    config: CmdbuildConfig,
    operation: string,
    data: Record<string, unknown>,
    params: Record<string, unknown>,
  ): { url: string; method: string; body?: unknown } {
    const userId = (params['id'] ?? data['id']) as string | undefined;

    switch (operation) {
      case 'user.create':
        return { url: '/users', method: 'POST', body: data };

      case 'user.update':
        return {
          url: `/users/${this.pathSegment(userId, 'id')}`,
          method: 'PUT',
          body: data,
        };

      case 'user.delete':
        return {
          url: `/users/${this.pathSegment(userId, 'id')}`,
          method: 'DELETE',
        };

      case 'user.get':
        return {
          url: `/users/${this.pathSegment(userId, 'id')}`,
          method: 'GET',
        };

      case 'user.search':
        return {
          url: this.appendQuery('/users', {
            filter: this.buildSimpleFilter(
              'username',
              this.firstQueryValue(params['filter'], data['filter']),
            ),
            limit: this.firstQueryValue(params['limit'], data['limit']),
          }),
          method: 'GET',
        };

      case 'user.enable':
      case 'user.unlock':
        return {
          url: `/users/${this.pathSegment(userId, 'id')}`,
          method: 'PUT',
          body: { active: true },
        };

      case 'user.disable':
      case 'user.lock':
        return {
          url: `/users/${this.pathSegment(userId, 'id')}`,
          method: 'PUT',
          body: { active: false },
        };

      case 'user.changePassword': {
        const newPass = data['newValue'] ?? data['password'];
        return {
          url: `/users/${this.pathSegment(userId, 'id')}/password`,
          method: 'POST',
          body: { password: newPass },
        };
      }

      case 'user.resolve':
        return {
          url: this.appendQuery('/users', {
            filter: this.buildSimpleFilter(
              'username',
              this.firstQueryValue(
                params['username'],
                data['username'],
                params['login'],
                data['login'],
                params['filter'],
                data['filter'],
              ),
              'equal',
            ),
          }),
          method: 'GET',
        };

      case 'user.addAttributes':
        return {
          url: `/users/${this.pathSegment(userId, 'id')}`,
          method: 'PUT',
          body: data,
        };

      case 'user.removeAttributes':
        return {
          url: `/users/${this.pathSegment(userId, 'id')}`,
          method: 'PUT',
          body: Object.fromEntries(Object.keys(data).map((k) => [k, null])),
        };

      case 'group.create':
        return { url: '/roles', method: 'POST', body: data };

      case 'group.update':
        return {
          url: `/roles/${this.pathSegment(userId, 'id')}`,
          method: 'PUT',
          body: data,
        };

      case 'group.delete':
        return {
          url: `/roles/${this.pathSegment(userId, 'id')}`,
          method: 'DELETE',
        };

      case 'group.get':
        return {
          url: `/roles/${this.pathSegment(userId, 'id')}`,
          method: 'GET',
        };

      case 'group.search':
        return {
          url: this.appendQuery('/roles', {
            filter: this.buildSimpleFilter(
              'name',
              this.firstQueryValue(params['filter'], data['filter']),
            ),
            limit: this.firstQueryValue(params['limit'], data['limit']),
          }),
          method: 'GET',
        };

      case 'system.test':
        return { url: '/classes', method: 'GET' };

      case 'schema.get':
        return { url: '/classes', method: 'GET' };

      case 'sync.full':
      case 'sync.incremental':
        return { url: '/users', method: 'GET' };

      default:
        throw new Error(`Unsupported CMDBuild operation: ${operation}`);
    }
  }

  async testConnection(
    config: Record<string, unknown>,
  ): Promise<{ success: boolean; message: string }> {
    const cfg = config as unknown as CmdbuildConfig;
    if (!cfg.baseUrl) {
      return { success: false, message: 'Missing baseUrl in config' };
    }

    try {
      await this.call(cfg, 'GET', '/classes');
      return { success: true, message: 'CMDBuild API reachable' };
    } catch (error: unknown) {
      const msg = this.safeErrorMessage(error, cfg);
      return { success: false, message: `CMDBuild connection failed: ${msg}` };
    }
  }
}
