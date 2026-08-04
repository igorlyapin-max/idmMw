import { Injectable, Logger, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import {
  Connector,
  ConnectorPayload,
  ConnectorResult,
} from '../../connector.interface';
import {
  TlsConnectionConfig,
  TlsOptionsFactory,
} from '../../../security/tls-options.factory';
import { isPrivateOrLocalAddress } from '../../../security/ip-utils';

interface RestConnectorConfig {
  baseUrl?: string;
  allowedPaths?: string[];
  allowPrivateNetwork?: boolean;
  headers?: Record<string, string>;
  tls?: TlsConnectionConfig;
}

@Injectable()
export class RestConnectorService implements Connector {
  readonly name = 'rest';
  private readonly logger = new Logger(RestConnectorService.name);

  constructor(
    private readonly httpService: HttpService,
    @Optional() private readonly tlsOptions?: TlsOptionsFactory,
  ) {}

  async execute(payload: ConnectorPayload): Promise<ConnectorResult> {
    const config = payload.payload['config'] as RestConnectorConfig | undefined;
    if (!config?.baseUrl) {
      return { success: false, error: 'Missing baseUrl in REST config' };
    }

    const method = this.method(payload.payload['method']);
    const path = this.relativePath(payload.payload['path']);
    if (!path.success) {
      return { success: false, error: path.error };
    }

    const targetUrl = new URL(path.path, config.baseUrl).toString();
    const url = new URL(targetUrl);
    if (!config.allowPrivateNetwork && isPrivateOrLocalAddress(url.hostname)) {
      return {
        success: false,
        error: `REST target host is private/local and not allowed: ${url.hostname}`,
      };
    }
    if (!this.isPathAllowed(url.pathname, config.allowedPaths)) {
      return {
        success: false,
        error: `REST target path is not allowed: ${url.pathname}`,
      };
    }

    try {
      const response = await lastValueFrom(
        this.httpService.request({
          url: targetUrl,
          method,
          data: payload.payload['data'] ?? {},
          headers: {
            ...(config.headers ?? {}),
            ...((payload.payload['headers'] as Record<string, string>) ?? {}),
          },
          ...(this.tlsOptions?.axiosConfig(
            targetUrl,
            config?.tls,
            'REST target',
          ) ?? {}),
        }),
      );
      this.logger.log(
        `REST call to ${targetUrl} succeeded: ${response.status}`,
      );
      return { success: true, data: response.data };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`REST call to ${targetUrl} failed: ${msg}`);
      return { success: false, error: msg };
    }
  }

  async testConnection(
    config: Record<string, unknown>,
  ): Promise<{ success: boolean; message: string }> {
    const cfg = config as unknown as RestConnectorConfig;
    const baseUrl = cfg.baseUrl;
    if (!baseUrl) {
      return { success: false, message: 'Missing baseUrl in config' };
    }

    try {
      const response = await lastValueFrom(
        this.httpService.get(baseUrl, {
          timeout: 10000,
          ...(this.tlsOptions?.axiosConfig(baseUrl, cfg.tls, 'REST target') ??
            {}),
        }),
      );
      return {
        success: true,
        message: `REST endpoint reachable (status ${response.status})`,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, message: `REST connection failed: ${msg}` };
    }
  }

  private method(value: unknown): string {
    const method = typeof value === 'string' ? value.toUpperCase() : 'POST';
    return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
      ? method
      : 'POST';
  }

  private relativePath(
    value: unknown,
  ): { success: true; path: string } | { success: false; error: string } {
    if (value === undefined || value === null || value === '') {
      return { success: true, path: '/' };
    }
    if (typeof value !== 'string') {
      return { success: false, error: 'REST payload.path must be a string' };
    }
    if (!value.startsWith('/') || value.startsWith('//')) {
      return {
        success: false,
        error: 'REST payload.path must be a relative absolute path',
      };
    }
    return { success: true, path: value };
  }

  private isPathAllowed(path: string, allowedPaths?: string[]): boolean {
    if (!allowedPaths || allowedPaths.length === 0) {
      return true;
    }
    return allowedPaths.some((allowed) => {
      const normalized = allowed.endsWith('/') ? allowed : `${allowed}/`;
      return path === allowed || path.startsWith(normalized);
    });
  }
}
