import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import {
  SAML,
  ValidateInResponseTo,
  type CacheItem,
  type CacheProvider,
  type Profile,
} from '@node-saml/node-saml';
import { DiagnosticLoggerService } from '../diagnostics/diagnostic-logger.service';
import { safeEqualFixedLength } from '../security/constant-time';
import { AuthService, type ExternalAdminIdentity } from './auth.service';

const SAML_REQUEST_ID_PREFIX = '_idmmw_';
const SAML_REQUEST_ID_TTL_MS = 600_000;

interface SignedSamlRequestPayload {
  iat: number;
  exp: number;
  nonce: string;
}

export class SignedSamlRequestCacheProvider implements CacheProvider {
  private readonly used = new Map<string, number>();

  constructor(
    private readonly secret: string,
    private readonly ttlMs = SAML_REQUEST_ID_TTL_MS,
  ) {}

  createRequestId(): string {
    const now = Date.now();
    const payload = Buffer.from(
      JSON.stringify({
        iat: now,
        exp: now + this.ttlMs,
        nonce: randomUUID(),
      } satisfies SignedSamlRequestPayload),
      'utf8',
    ).toString('base64url');
    return `${SAML_REQUEST_ID_PREFIX}${payload}.${this.sign(payload)}`;
  }

  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    const payload = this.verify(key);
    if (!payload) return null;
    return { value, createdAt: payload.iat };
  }

  async getAsync(key: string): Promise<string | null> {
    const payload = this.verify(key);
    if (!payload || this.isUsed(key)) return null;
    return new Date(payload.iat).toISOString();
  }

  async removeAsync(key: string | null): Promise<string | null> {
    if (!key) return null;
    const payload = this.verify(key);
    if (!payload) return null;
    this.prune();
    this.used.set(key, payload.exp);
    return new Date(payload.iat).toISOString();
  }

  private verify(key: string): SignedSamlRequestPayload | null {
    if (!key.startsWith(SAML_REQUEST_ID_PREFIX)) return null;
    const body = key.slice(SAML_REQUEST_ID_PREFIX.length);
    const [payload, signature] = body.split('.');
    if (!payload || !signature) return null;
    if (
      !safeEqualFixedLength(
        signature,
        this.sign(payload),
        'saml-request-id-signature',
      )
    ) {
      return null;
    }
    try {
      const parsed = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as Partial<SignedSamlRequestPayload>;
      if (
        typeof parsed.iat !== 'number' ||
        typeof parsed.exp !== 'number' ||
        typeof parsed.nonce !== 'string' ||
        parsed.exp < Date.now()
      ) {
        return null;
      }
      return parsed as SignedSamlRequestPayload;
    } catch {
      return null;
    }
  }

  private isUsed(key: string): boolean {
    this.prune();
    return this.used.has(key);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.used.entries()) {
      if (expiresAt < now) this.used.delete(key);
    }
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret)
      .update(payload)
      .digest('base64url');
  }
}

@Injectable()
export class SamlAuthService {
  private saml?: SAML;
  private requestCache?: SignedSamlRequestCacheProvider;

  constructor(
    private readonly config: ConfigService,
    private readonly auth: AuthService,
    private readonly diagnostics: DiagnosticLoggerService,
  ) {}

  async startLogin(res: Response): Promise<void> {
    this.assertEnabled();
    const redirectTo = await this.client().getAuthorizeUrlAsync(
      '',
      undefined,
      {},
    );
    this.diagnostics.basic('admin_saml_login_started', { provider: 'saml' });
    res.redirect(302, redirectTo);
  }

  async completeAcs(req: Request, res: Response): Promise<void> {
    this.assertEnabled();
    const samlResponse = this.bodyValue(req.body, 'SAMLResponse');
    if (!samlResponse) {
      throw new BadRequestException('SAMLResponse is required');
    }

    const result = await this.client().validatePostResponseAsync({
      SAMLResponse: samlResponse,
      RelayState: this.bodyValue(req.body, 'RelayState') ?? '',
    });
    if (!result.profile) {
      throw new UnauthorizedException('SAML profile is missing');
    }

    const identity = this.identityFromProfile(result.profile);
    this.auth.loginExternal(identity, 'saml', res);
    this.diagnostics.basic('admin_saml_login_completed', {
      provider: 'saml',
      subject: identity.user,
      groupCount: identity.groups.length,
    });
    this.diagnostics.verbose('admin_saml_attributes_received', {
      provider: 'saml',
      attributeKeys: Object.keys(result.profile).sort(),
    });
    res.redirect(303, '/');
  }

  metadata(): string {
    this.assertEnabled();
    return this.client().generateServiceProviderMetadata(
      null,
      this.optionalPem('ADMIN_AUTH_SAML_SP_CERT'),
    );
  }

  private assertEnabled(): void {
    if (!this.auth.isSsoProviderEnabled('saml')) {
      throw new BadRequestException('SAML admin login is disabled');
    }
  }

  private client(): SAML {
    if (!this.saml) {
      this.saml = new SAML({
        entryPoint: this.required('ADMIN_AUTH_SAML_ENTRYPOINT'),
        issuer: this.required('ADMIN_AUTH_SAML_ISSUER'),
        callbackUrl: this.required('ADMIN_AUTH_SAML_CALLBACK_URL'),
        idpIssuer: this.required('ADMIN_AUTH_SAML_IDP_ISSUER'),
        idpCert: this.requiredPem('ADMIN_AUTH_SAML_IDP_CERT'),
        privateKey:
          this.optionalPem('ADMIN_AUTH_SAML_SP_PRIVATE_KEY') ?? undefined,
        publicCert: this.optionalPem('ADMIN_AUTH_SAML_SP_CERT') ?? undefined,
        wantAssertionsSigned: true,
        wantAuthnResponseSigned: false,
        acceptedClockSkewMs: 120_000,
        validateInResponseTo: ValidateInResponseTo.always,
        requestIdExpirationPeriodMs: SAML_REQUEST_ID_TTL_MS,
        cacheProvider: this.signedRequestCache(),
        generateUniqueId: () => this.signedRequestCache().createRequestId(),
        identifierFormat: null,
      });
    }
    return this.saml;
  }

  private signedRequestCache(): SignedSamlRequestCacheProvider {
    this.requestCache ??= new SignedSamlRequestCacheProvider(
      this.required('ADMIN_AUTH_SESSION_SECRET'),
      SAML_REQUEST_ID_TTL_MS,
    );
    return this.requestCache;
  }

  private identityFromProfile(profile: Profile): ExternalAdminIdentity {
    const userAttribute =
      this.config.get<string>('ADMIN_AUTH_SAML_USER_ATTRIBUTE') ?? 'nameID';
    const groupsAttribute =
      this.config.get<string>('ADMIN_AUTH_SAML_GROUPS_ATTRIBUTE') ?? 'groups';
    const user =
      userAttribute === 'nameID'
        ? this.claimText(profile.nameID)
        : this.claimText(profile[userAttribute]);
    if (!user) {
      throw new UnauthorizedException(
        `SAML user attribute is missing: ${userAttribute}`,
      );
    }
    return {
      user,
      groups: this.claimArray(profile[groupsAttribute]),
    };
  }

  private bodyValue(body: unknown, key: string): string | null {
    if (!body || typeof body !== 'object') return null;
    const value = (body as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private claimText(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private claimArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean);
    }
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }
    return [];
  }

  private required(name: string): string {
    const value = this.config.get<string>(name);
    if (!value) {
      throw new ServiceUnavailableException(`${name} is required`);
    }
    return value;
  }

  private requiredPem(name: string): string {
    return this.normalizePem(this.required(name));
  }

  private optionalPem(name: string): string | null {
    const value = this.config.get<string>(name);
    return value ? this.normalizePem(value) : null;
  }

  private normalizePem(value: string): string {
    return value.replace(/\\n/g, '\n').trim();
  }
}
