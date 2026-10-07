import { Injectable, Logger, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import type { AxiosRequestConfig } from 'axios';
import {
  Connector,
  ConnectorCapabilities,
  ConnectorOperationCapability,
  ConnectorPayload,
  ConnectorResult,
} from '../../connector.interface';
import {
  AVANPOST_OPERATION_VALUES,
  READ_OPERATIONS,
  WRITE_OPERATIONS,
} from '../../../inbound/webhooks/avanpost-operation.enum';
import {
  TlsConnectionConfig,
  TlsOptionsFactory,
} from '../../../security/tls-options.factory';
import {
  groupMappingSettings,
  groupRefValues,
  type GroupMappingConfig,
} from '../../group-mapping.util';

export interface PassworkConfig extends GroupMappingConfig {
  baseUrl: string;
  accessToken?: string;
  apiToken?: string;
  defaultGroups?: unknown[];
  masterKeyHash?: string;
  timeout?: number;
  responseFormat?: 'raw' | 'base64';
  tls?: TlsConnectionConfig;
}

interface PassworkSchemaAttribute {
  name: string;
  type: string;
  required: boolean;
  multiValued: boolean;
}

interface PassworkSchemaObjectClass {
  name: string;
  attributes: PassworkSchemaAttribute[];
}

interface PassworkSchemaResult {
  objectClasses: PassworkSchemaObjectClass[];
}

interface PassworkSyncResult {
  mode: 'full';
  users: unknown;
  groups: unknown;
}

interface PassworkRequest {
  method: string;
  path: string;
  body?: unknown;
}

const PASSWORK_PARTIAL_OPERATIONS: Record<string, string> = {
  'user.enable':
    'Mapped to Passwork unblock endpoint; Passwork has no separate IDM enable flag.',
  'user.disable':
    'Mapped to Passwork block endpoint; Passwork has no separate IDM disable flag.',
  'user.lock':
    'Mapped to Passwork block endpoint; Passwork has no separate IDM lock flag.',
  'user.unlock':
    'Mapped to Passwork unblock endpoint; Passwork has no separate IDM unlock flag.',
  'schema.get':
    'Returns idmMw Passwork user/group schema, not the full Passwork API schema.',
  'sync.full':
    'Reads Passwork users and user groups without decrypted secrets.',
};

const PASSWORK_UNSUPPORTED_OPERATIONS: Record<string, string> = {
  'user.changePassword':
    'Passwork password item and secret rotation operations are out of scope for the IAM connector.',
  'user.addAttributes':
    'Passwork user custom attribute mapping is not defined in the v1 IAM connector.',
  'user.removeAttributes':
    'Passwork user custom attribute removal mapping is not defined in the v1 IAM connector.',
  'sync.incremental':
    'Passwork API overview does not expose a stable IDM change cursor; use sync.full.',
};

@Injectable()
export class PassworkConnectorService implements Connector {
  readonly name = 'passwork';
  private readonly logger = new Logger(PassworkConnectorService.name);

  constructor(
    private readonly httpService: HttpService,
    @Optional() private readonly tlsOptions?: TlsOptionsFactory,
  ) {}

  getCapabilities(): ConnectorCapabilities {
    const operationStatus = Object.fromEntries(
      AVANPOST_OPERATION_VALUES.map((operation) => {
        const unsupportedReason = PASSWORK_UNSUPPORTED_OPERATIONS[operation];
        const partialReason = PASSWORK_PARTIAL_OPERATIONS[operation];
        const capability: ConnectorOperationCapability = unsupportedReason
          ? { status: 'unsupported', reason: unsupportedReason }
          : partialReason
            ? { status: 'partial', reason: partialReason }
            : { status: 'implemented' };
        return [operation, capability];
      }),
    ) as Record<string, ConnectorOperationCapability>;

    return {
      operations: [...AVANPOST_OPERATION_VALUES],
      readOperations: [...READ_OPERATIONS],
      writeOperations: [...WRITE_OPERATIONS],
      capabilities: {
        supportsRead: true,
        supportsWrite: true,
        supportsSync: true,
        supportsIncrementalSync: false,
        supportsSchema: true,
      },
      operationStatus,
      partialOperations: PASSWORK_PARTIAL_OPERATIONS,
    };
  }

  async execute(payload: ConnectorPayload): Promise<ConnectorResult> {
    const config = payload.payload['config'] as PassworkConfig | undefined;
    if (!config?.baseUrl) {
      return { success: false, error: 'Missing Passwork config (baseUrl)' };
    }

    const authToken = this.getAuthToken(config);
    if (!authToken) {
      return {
        success: false,
        error: 'Missing Passwork config (accessToken or apiToken)',
      };
    }

    const unsupportedReason =
      PASSWORK_UNSUPPORTED_OPERATIONS[payload.operation];
    if (unsupportedReason) {
      return {
        success: false,
        error: `Unsupported Passwork operation: ${payload.operation}. ${unsupportedReason}`,
      };
    }

    try {
      if (payload.operation === 'schema.get') {
        return { success: true, data: this.localSchema() };
      }
      if (payload.operation === 'sync.full') {
        return this.sync(payload, 'full');
      }

      const data = (payload.payload['data'] ?? {}) as Record<string, unknown>;
      const params = (payload.payload['params'] ?? {}) as Record<
        string,
        unknown
      >;
      const requestData = this.isUserWriteOperation(payload.operation)
        ? this.withoutGenericGroups(data)
        : data;
      const request = this.buildRequest(payload.operation, requestData, params);
      const mappedUserGroupIds =
        payload.operation === 'user.create'
          ? await this.resolveUserGroupMapping(config, data)
          : [];
      const response = await this.call(config, request);
      if (payload.operation === 'user.create') {
        await this.applyUserGroupMapping(
          config,
          data,
          response,
          mappedUserGroupIds,
        );
      }
      this.logger.log(`Passwork ${payload.operation} succeeded`);
      return { success: true, data: response };
    } catch (error: unknown) {
      const msg = this.sanitizeError(error, config);
      this.logger.error(`Passwork operation failed: ${msg}`);
      return { success: false, error: msg };
    }
  }

  async testConnection(
    config: Record<string, unknown>,
  ): Promise<{ success: boolean; message: string }> {
    const cfg = config as unknown as PassworkConfig;
    if (!cfg.baseUrl) {
      return { success: false, message: 'Missing baseUrl in config' };
    }
    if (!this.getAuthToken(cfg)) {
      return {
        success: false,
        message: 'Missing accessToken or apiToken in config',
      };
    }

    try {
      await this.call(cfg, { method: 'GET', path: '/sessions/current/info' });
      return { success: true, message: 'Passwork API reachable' };
    } catch (error: unknown) {
      const msg = this.sanitizeError(error, cfg);
      return { success: false, message: `Passwork connection failed: ${msg}` };
    }
  }

  async getSchema(payload: ConnectorPayload): Promise<ConnectorResult> {
    return this.execute({ ...payload, operation: 'schema.get' });
  }

  async sync(
    payload: ConnectorPayload,
    mode: string,
  ): Promise<ConnectorResult> {
    if (mode === 'incremental') {
      return {
        success: false,
        error: `Unsupported Passwork operation: sync.incremental. ${PASSWORK_UNSUPPORTED_OPERATIONS['sync.incremental']}`,
      };
    }

    const config = payload.payload['config'] as PassworkConfig | undefined;
    if (!config?.baseUrl) {
      return { success: false, error: 'Missing Passwork config (baseUrl)' };
    }
    if (!this.getAuthToken(config)) {
      return {
        success: false,
        error: 'Missing Passwork config (accessToken or apiToken)',
      };
    }

    try {
      const params = (payload.payload['params'] ?? {}) as Record<
        string,
        unknown
      >;
      const query = this.pickQuery(params, {
        limit: params['limit'] ?? 500,
        offset: params['offset'],
      });
      const [users, groups] = await Promise.all([
        this.call(config, {
          method: 'GET',
          path: this.appendQuery('/users', query),
        }),
        this.call(config, {
          method: 'GET',
          path: this.appendQuery('/user-groups', query),
        }),
      ]);
      const result: PassworkSyncResult = {
        mode: 'full',
        users,
        groups,
      };
      return { success: true, data: result };
    } catch (error: unknown) {
      const msg = this.sanitizeError(error, config);
      this.logger.error(`Passwork sync failed: ${msg}`);
      return { success: false, error: msg };
    }
  }

  private buildRequest(
    operation: string,
    data: Record<string, unknown>,
    params: Record<string, unknown>,
  ): PassworkRequest {
    const id = this.toOptionalString(
      this.firstValue(
        params['id'],
        data['id'],
        params['userId'],
        data['userId'],
      ),
    );
    const groupId = this.toOptionalString(
      this.firstValue(
        params['groupId'],
        data['groupId'],
        params['id'],
        data['id'],
      ),
    );
    const query = this.searchQuery(data, params);

    switch (operation) {
      case 'user.create':
        return { method: 'POST', path: '/users', body: data };

      case 'user.update':
        return {
          method: 'PATCH',
          path: `/users/${this.requireId(id)}`,
          body: data,
        };

      case 'user.delete':
        return { method: 'DELETE', path: `/users/${this.requireId(id)}` };

      case 'user.get':
        return { method: 'GET', path: `/users/${this.requireId(id)}` };

      case 'user.search':
        return { method: 'GET', path: this.appendQuery('/users', query) };

      case 'user.resolve':
        return {
          method: 'GET',
          path: this.appendQuery(
            '/users',
            this.pickQuery(params, {
              username: this.firstValue(
                params['username'],
                data['username'],
                params['login'],
                data['login'],
              ),
              email: this.firstValue(params['email'], data['email']),
              search: this.firstValue(
                params['filter'],
                data['filter'],
                params['query'],
                data['query'],
                params['username'],
                data['username'],
                params['email'],
                data['email'],
              ),
            }),
          ),
        };

      case 'user.disable':
      case 'user.lock':
        return { method: 'POST', path: `/users/${this.requireId(id)}/block` };

      case 'user.enable':
      case 'user.unlock':
        return { method: 'POST', path: `/users/${this.requireId(id)}/unblock` };

      case 'group.create':
        return { method: 'POST', path: '/user-groups', body: data };

      case 'group.update':
        return {
          method: 'POST',
          path: `/user-groups/${this.requireId(groupId)}`,
          body: data,
        };

      case 'group.delete':
        return {
          method: 'DELETE',
          path: `/user-groups/${this.requireId(groupId)}`,
        };

      case 'group.get':
        return {
          method: 'GET',
          path: `/user-groups/${this.requireId(groupId)}`,
        };

      case 'group.search':
        return { method: 'GET', path: this.appendQuery('/user-groups', query) };

      case 'group.addMember':
      case 'group.removeMember': {
        const userIds = this.memberUserIds(data, params);
        if (!userIds.length) {
          throw new Error(
            'Missing userId or userIds for group member operation',
          );
        }
        return {
          method: 'POST',
          path: `/user-groups/${this.requireId(groupId)}/${
            operation === 'group.addMember' ? 'add-users' : 'remove-users'
          }`,
          body: { userIds },
        };
      }

      case 'system.test':
        return { method: 'GET', path: '/sessions/current/info' };

      default:
        throw new Error(`Unsupported Passwork operation: ${operation}`);
    }
  }

  private async resolveUserGroupMapping(
    config: PassworkConfig,
    data: Record<string, unknown>,
  ): Promise<string[]> {
    const mapping = groupMappingSettings(config);
    const defaults =
      mapping.enabled && config.defaultGroups !== undefined
        ? groupRefValues(config.defaultGroups, mapping.mode, 'defaultGroups')
        : [];
    const incoming = mapping.enabled
      ? groupRefValues(data['groups'], mapping.mode, 'groups')
      : [];
    const groupRefs = [...defaults, ...incoming];
    if (groupRefs.length === 0) {
      return [];
    }

    return mapping.mode === 'id'
      ? groupRefs.map(String)
      : this.resolveGroupIds(config, groupRefs.map(String), mapping.mode);
  }

  private async applyUserGroupMapping(
    config: PassworkConfig,
    data: Record<string, unknown>,
    response: unknown,
    groupIds: string[],
  ): Promise<void> {
    if (groupIds.length === 0) {
      return;
    }

    const userId =
      this.responseId(response) ?? this.toOptionalString(data['id']);
    if (!userId) {
      throw new Error(
        'Passwork user.create did not return user id for group mapping',
      );
    }
    for (const groupId of groupIds) {
      await this.call(config, {
        method: 'POST',
        path: `/user-groups/${this.requireId(groupId)}/add-users`,
        body: { userIds: [userId] },
      });
    }
  }

  private async resolveGroupIds(
    config: PassworkConfig,
    values: string[],
    key: 'name' | 'code',
  ): Promise<string[]> {
    const uniqueValues = [...new Set(values)];
    if (uniqueValues.length === 0) {
      return [];
    }
    const response = await this.call(config, {
      method: 'GET',
      path: this.appendQuery('/user-groups', { limit: 500 }),
    });
    const groups = this.collectionItems(response);
    return uniqueValues.map((value) => {
      const row = groups.find((item) => {
        const record = item as Record<string, unknown>;
        return this.toOptionalString(record[key]) === value;
      }) as Record<string, unknown> | undefined;
      const id = this.toOptionalString(row?.['id']);
      if (!id) {
        throw new Error(`Passwork user group not found by ${key}: ${value}`);
      }
      return id;
    });
  }

  private collectionItems(response: unknown): unknown[] {
    if (Array.isArray(response)) {
      return response;
    }
    if (typeof response !== 'object' || response === null) {
      return [];
    }
    const record = response as Record<string, unknown>;
    for (const key of ['groups', 'data', 'items', 'rows']) {
      if (Array.isArray(record[key])) {
        return record[key];
      }
    }
    return [];
  }

  private responseId(response: unknown): string | undefined {
    if (typeof response !== 'object' || response === null) {
      return undefined;
    }
    const record = response as Record<string, unknown>;
    return (
      this.toOptionalString(record['id']) ??
      (typeof record['data'] === 'object' && record['data'] !== null
        ? this.toOptionalString(
            (record['data'] as Record<string, unknown>)['id'],
          )
        : undefined)
    );
  }

  private withoutGenericGroups(
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const result = { ...data };
    delete result['groups'];
    return result;
  }

  private isUserWriteOperation(operation: string): boolean {
    return operation === 'user.create' || operation === 'user.update';
  }

  private async call(
    config: PassworkConfig,
    request: PassworkRequest,
  ): Promise<unknown> {
    const url = `${this.apiBaseUrl(config.baseUrl)}${request.path}`;
    const authToken = this.getAuthToken(config);
    if (!authToken) {
      throw new Error('Missing Passwork config (accessToken or apiToken)');
    }

    const axiosConfig: AxiosRequestConfig = {
      url,
      method: request.method,
      data: request.body,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
        'X-Response-Format': config.responseFormat ?? 'raw',
        ...(config.masterKeyHash
          ? { 'Passwork-MasterKeyHash': config.masterKeyHash }
          : {}),
      },
      timeout: config.timeout ?? 30000,
      ...(this.tlsOptions?.axiosConfig(
        config.baseUrl,
        config.tls,
        'Passwork',
      ) ?? {}),
    };
    const response = await lastValueFrom(this.httpService.request(axiosConfig));
    return response.data;
  }

  private apiBaseUrl(baseUrl: string): string {
    return `${baseUrl.replace(/\/+$/, '')}/api/v1`;
  }

  private getAuthToken(config: PassworkConfig): string | undefined {
    return config.accessToken || config.apiToken;
  }

  private appendQuery(path: string, query: Record<string, unknown>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          params.append(key, this.toQueryValue(item));
        }
      } else {
        params.set(key, this.toQueryValue(value));
      }
    }
    const suffix = params.toString();
    return suffix ? `${path}?${suffix}` : path;
  }

  private searchQuery(
    data: Record<string, unknown>,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    return this.pickQuery(params, {
      search: this.firstValue(
        params['search'],
        data['search'],
        params['query'],
        data['query'],
        params['filter'],
        data['filter'],
      ),
      limit: this.firstValue(params['limit'], data['limit']),
      offset: this.firstValue(params['offset'], data['offset']),
    });
  }

  private pickQuery(
    source: Record<string, unknown>,
    defaults: Record<string, unknown>,
  ): Record<string, unknown> {
    const query: Record<string, unknown> = {};
    for (const [key, value] of Object.entries({ ...source, ...defaults })) {
      if (
        value !== undefined &&
        value !== null &&
        value !== '' &&
        key !== 'id' &&
        key !== 'userId' &&
        key !== 'groupId'
      ) {
        query[key] = value;
      }
    }
    return query;
  }

  private memberUserIds(
    data: Record<string, unknown>,
    params: Record<string, unknown>,
  ): string[] {
    const value = this.firstValue(data['userIds'], params['userIds']);
    if (Array.isArray(value)) {
      return value
        .map((item) => this.toOptionalString(item))
        .filter((item): item is string => Boolean(item));
    }
    const userId = this.toOptionalString(
      this.firstValue(params['userId'], data['userId']),
    );
    return userId ? [userId] : [];
  }

  private localSchema(): PassworkSchemaResult {
    return {
      objectClasses: [
        {
          name: 'user',
          attributes: [
            { name: 'id', type: 'string', required: false, multiValued: false },
            {
              name: 'username',
              type: 'string',
              required: true,
              multiValued: false,
            },
            {
              name: 'email',
              type: 'string',
              required: false,
              multiValued: false,
            },
            {
              name: 'roleId',
              type: 'string',
              required: false,
              multiValued: false,
            },
            {
              name: 'isBlocked',
              type: 'boolean',
              required: false,
              multiValued: false,
            },
          ],
        },
        {
          name: 'group',
          attributes: [
            { name: 'id', type: 'string', required: false, multiValued: false },
            {
              name: 'name',
              type: 'string',
              required: true,
              multiValued: false,
            },
            {
              name: 'userIds',
              type: 'array',
              required: false,
              multiValued: true,
            },
          ],
        },
      ],
    };
  }

  private firstValue(...values: unknown[]): unknown {
    return values.find(
      (value) => value !== undefined && value !== null && value !== '',
    );
  }

  private requireId(value: string | undefined): string {
    if (!value) {
      throw new Error('Missing id for Passwork operation');
    }
    return encodeURIComponent(value);
  }

  private toOptionalString(value: unknown): string | undefined {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      return String(value);
    }
    return undefined;
  }

  private toQueryValue(value: unknown): string {
    const scalar = this.toOptionalString(value);
    return scalar ?? JSON.stringify(value);
  }

  private sanitizeError(error: unknown, config: PassworkConfig): string {
    const message = error instanceof Error ? error.message : String(error);
    const secrets = [
      config.accessToken,
      config.apiToken,
      config.masterKeyHash,
    ].filter((value): value is string => Boolean(value));
    return secrets.reduce((current, secret) => {
      return current.split(secret).join('[REDACTED]');
    }, message);
  }
}
