import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import { DiagnosticLoggerService } from '../diagnostics/diagnostic-logger.service';
import { AuthService, type ExternalAdminIdentity } from './auth.service';

type OpenIdClientModule = typeof import('openid-client');

interface OidcStateCookie {
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
}

const OIDC_STATE_COOKIE = 'idmmw_oidc_state';
const OIDC_STATE_TTL_SECONDS = 600;

@Injectable()
export class OidcAuthService {
  private clientModule?: Promise<OpenIdClientModule>;
  private configuration?: Promise<unknown>;

  constructor(
    private readonly config: ConfigService,
    private readonly auth: AuthService,
    private readonly diagnostics: DiagnosticLoggerService,
  ) {}

  async startLogin(res: Response): Promise<void> {
    this.assertEnabled();
    const client = await this.openidClient();
    const configuration = await this.clientConfiguration(client);
    const codeVerifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);

    this.writeStateCookie(res, {
      state,
      nonce,
      codeVerifier,
      expiresAt: Date.now() + OIDC_STATE_TTL_SECONDS * 1000,
    });

    const redirectTo = client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.required('ADMIN_AUTH_OIDC_REDIRECT_URI'),
      scope: this.config.get<string>('ADMIN_AUTH_OIDC_SCOPES') ?? 'openid',
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });

    this.diagnostics.basic('admin_oidc_login_started', {
      provider: 'oidc',
      stateId: this.shortId(state),
    });
    res.redirect(302, redirectTo.toString());
  }

  async completeCallback(req: Request, res: Response): Promise<void> {
    this.assertEnabled();
    const stored = this.readStateCookie(req);
    this.clearStateCookie(res);
    if (!stored) {
      throw new UnauthorizedException('OIDC login state is missing or expired');
    }

    const client = await this.openidClient();
    const configuration = await this.clientConfiguration(client);
    const tokens = await client.authorizationCodeGrant(
      configuration,
      this.callbackUrl(req),
      {
        expectedState: stored.state,
        expectedNonce: stored.nonce,
        pkceCodeVerifier: stored.codeVerifier,
        idTokenExpected: true,
      },
    );
    const claims = tokens.claims();
    if (!claims) {
      throw new UnauthorizedException('OIDC ID token claims are missing');
    }

    const identity = this.identityFromClaims(claims as Record<string, unknown>);
    this.auth.loginExternal(identity, 'oidc', res);
    this.diagnostics.basic('admin_oidc_login_completed', {
      provider: 'oidc',
      subject: identity.user,
      groupCount: identity.groups.length,
    });
    this.diagnostics.verbose('admin_oidc_claims_received', {
      provider: 'oidc',
      claimKeys: Object.keys(claims as Record<string, unknown>).sort(),
    });
    res.redirect(303, '/');
  }

  private assertEnabled(): void {
    if (!this.auth.isSsoProviderEnabled('oidc')) {
      throw new BadRequestException('OIDC admin login is disabled');
    }
  }

  private async openidClient(): Promise<OpenIdClientModule> {
    this.clientModule ??= import('openid-client');
    return this.clientModule;
  }

  private async clientConfiguration(
    client: OpenIdClientModule,
  ): Promise<Parameters<typeof client.buildAuthorizationUrl>[0]> {
    if (!this.configuration) {
      const clientSecret = this.required('ADMIN_AUTH_OIDC_CLIENT_SECRET');
      this.configuration = client.discovery(
        new URL(this.required('ADMIN_AUTH_OIDC_ISSUER_URL')),
        this.required('ADMIN_AUTH_OIDC_CLIENT_ID'),
        {
          redirect_uris: [this.required('ADMIN_AUTH_OIDC_REDIRECT_URI')],
          response_types: ['code'],
        },
        client.ClientSecretPost(clientSecret),
      );
    }
    return this.configuration as Promise<
      Parameters<typeof client.buildAuthorizationUrl>[0]
    >;
  }

  private identityFromClaims(
    claims: Record<string, unknown>,
  ): ExternalAdminIdentity {
    const userClaim = this.config.get<string>('ADMIN_AUTH_OIDC_USER_CLAIM') ?? 'sub';
    const groupsClaim =
      this.config.get<string>('ADMIN_AUTH_OIDC_GROUPS_CLAIM') ?? 'groups';
    const user = this.claimText(claims[userClaim]);
    if (!user) {
      throw new UnauthorizedException(`OIDC user claim is missing: ${userClaim}`);
    }
    return {
      user,
      groups: this.claimArray(claims[groupsClaim]),
    };
  }

  private callbackUrl(req: Request): URL {
    const base = new URL(this.required('ADMIN_AUTH_OIDC_REDIRECT_URI'));
    const query = (req.originalUrl ?? req.url).split('?')[1];
    base.search = query ? `?${query}` : '';
    return base;
  }

  private writeStateCookie(res: Response, state: OidcStateCookie): void {
    const payload = Buffer.from(JSON.stringify(state), 'utf8').toString(
      'base64url',
    );
    const value = `${payload}.${this.sign(payload)}`;
    res.setHeader(
      'Set-Cookie',
      `${OIDC_STATE_COOKIE}=${value}; Max-Age=${OIDC_STATE_TTL_SECONDS}; Path=/auth/oidc; HttpOnly; SameSite=Lax${this.secureCookie()}`,
    );
  }

  private clearStateCookie(res: Response): void {
    res.append?.(
      'Set-Cookie',
      `${OIDC_STATE_COOKIE}=; Max-Age=0; Path=/auth/oidc; HttpOnly; SameSite=Lax${this.secureCookie()}`,
    );
  }

  private readStateCookie(req: Request): OidcStateCookie | null {
    const raw = this.cookies(req)[OIDC_STATE_COOKIE];
    if (!raw) return null;
    const [payload, signature] = raw.split('.');
    if (!payload || !signature || signature !== this.sign(payload)) return null;
    try {
      const state = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as OidcStateCookie;
      if (!state.expiresAt || state.expiresAt < Date.now()) return null;
      return state;
    } catch {
      return null;
    }
  }

  private cookies(req: Request): Record<string, string> {
    const raw = req.headers.cookie;
    if (!raw) return {};
    return Object.fromEntries(
      raw.split(';').map((part) => {
        const [key, ...rest] = part.trim().split('=');
        return [key, rest.join('=')];
      }),
    );
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.required('ADMIN_AUTH_SESSION_SECRET'))
      .update(payload)
      .digest('base64url');
  }

  private secureCookie(): string {
    const explicit = this.config.get<boolean>('ADMIN_AUTH_COOKIE_SECURE');
    const secure =
      explicit ??
      (this.config.get<string>('NODE_ENV') === 'production' ||
        (this.config.get<boolean>('HTTP_TLS_ENABLED') ?? false));
    return secure ? '; Secure' : '';
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

  private shortId(value: string): string {
    return createHmac('sha256', randomUUID()).update(value).digest('hex').slice(0, 8);
  }
}
