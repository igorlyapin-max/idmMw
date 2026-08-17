import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac } from 'crypto';
import type { Request } from 'express';
import { safeEqualFixedLength } from './constant-time';

export interface IntegrationAuthResult {
  ok: boolean;
  status: number;
  message: string;
}

@Injectable()
export class IntegrationAuthService {
  constructor(private readonly config: ConfigService) {}

  requiresAuth(req: Request): boolean {
    const path = this.path(req);
    if (path === '/metrics') {
      return !(this.config.get<boolean>('METRICS_PUBLIC_ENABLED') ?? true);
    }

    if (!(this.config.get<boolean>('INTEGRATION_AUTH_ENABLED') ?? false)) {
      return false;
    }

    return (
      path === '/idm' ||
      path.startsWith('/idm/') ||
      path.startsWith('/webhooks/')
    );
  }

  verify(req: Request): IntegrationAuthResult {
    const secret = this.secret();
    if (!secret) {
      return {
        ok: false,
        status: 503,
        message: 'Integration authentication is not configured',
      };
    }

    const timestampHeader = this.header(req, 'x-idmmw-timestamp');
    const signatureHeader = this.header(req, 'x-idmmw-signature');
    if (!timestampHeader || !signatureHeader) {
      return {
        ok: false,
        status: 401,
        message: 'Integration authentication headers are required',
      };
    }

    const timestamp = this.parseTimestamp(timestampHeader);
    if (timestamp === undefined) {
      return {
        ok: false,
        status: 401,
        message: 'Invalid integration authentication timestamp',
      };
    }

    const skewSeconds =
      this.config.get<number>('INTEGRATION_AUTH_ALLOWED_CLOCK_SKEW_SECONDS') ??
      300;
    if (Math.abs(Date.now() - timestamp) > skewSeconds * 1000) {
      return {
        ok: false,
        status: 401,
        message: 'Integration authentication timestamp is outside allowed skew',
      };
    }

    const expected = this.signature(req, timestampHeader, secret);
    const actual = this.normalizeSignature(signatureHeader);
    if (!actual || !this.safeEqual(actual, expected)) {
      return {
        ok: false,
        status: 401,
        message: 'Invalid integration authentication signature',
      };
    }

    return { ok: true, status: 200, message: 'ok' };
  }

  signForTest(params: {
    method: string;
    path: string;
    body?: unknown;
    timestamp: string;
    secret: string;
  }): string {
    return createHmac('sha256', params.secret)
      .update(
        [
          params.timestamp,
          params.method.toUpperCase(),
          params.path,
          this.sha256(this.bodyToString(params.body, true)),
        ].join('\n'),
      )
      .digest('hex');
  }

  private signature(req: Request, timestamp: string, secret: string): string {
    const canonical = [
      timestamp,
      req.method.toUpperCase(),
      this.path(req),
      this.sha256(this.requestBodyToString(req)),
    ].join('\n');

    return createHmac('sha256', secret).update(canonical).digest('hex');
  }

  private secret(): string | undefined {
    const value =
      process.env['INTEGRATION_AUTH_SECRET'] ??
      this.config.get<string>('INTEGRATION_AUTH_SECRET');
    return value?.trim() || undefined;
  }

  private header(req: Request, name: string): string | undefined {
    const value = req.headers[name.toLowerCase()];
    if (Array.isArray(value)) {
      return value[0];
    }
    return value;
  }

  private path(req: Request): string {
    const value = req.originalUrl ?? req.url ?? req.path;
    return value.split('?')[0] || '/';
  }

  private parseTimestamp(value: string): number | undefined {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return undefined;
    }
    return parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
  }

  private normalizeSignature(value: string): string | undefined {
    const normalized = value.trim().replace(/^sha256=/i, '');
    return /^[a-f0-9]{64}$/i.test(normalized)
      ? normalized.toLowerCase()
      : undefined;
  }

  private requestBodyToString(req: Request): string {
    const hasBody =
      req.headers['content-length'] !== undefined ||
      req.headers['transfer-encoding'] !== undefined;
    return this.bodyToString(req.body, hasBody);
  }

  private bodyToString(value: unknown, hasBody: boolean): string {
    if (!hasBody) {
      return '';
    }
    if (value === undefined || value === null) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    return this.stableStringify(value);
  }

  private stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value);
    }

    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${this.stableStringify(item)}`,
      )
      .join(',')}}`;
  }

  private sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private safeEqual(a: string, b: string): boolean {
    return safeEqualFixedLength(a, b, 'integration-auth-signature');
  }
}
