import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes } from 'crypto';
import type { Request, Response } from 'express';
import { isIpAllowed } from '../security/ip-utils';
import { safeEqualFixedLength } from '../security/constant-time';

export interface AdminUserSession {
  sub: string;
  name: string;
  provider: 'local' | 'sso' | 'disabled';
  csrfToken: string;
  expiresAt: number;
}

export interface SessionStatus {
  authEnabled: boolean;
  authenticated: boolean;
  user?: Omit<AdminUserSession, 'csrfToken' | 'expiresAt'>;
  csrfToken?: string;
  mode: string;
}

interface SsoIdentity {
  user: string;
  groups: string[];
}

const DEFAULT_COOKIE_NAME = 'idmmw_admin_session';

@Injectable()
export class AuthService {
  constructor(private readonly config: ConfigService) {}

  isEnabled(): boolean {
    return this.config.get<boolean>('ADMIN_AUTH_ENABLED') ?? false;
  }

  mode(): 'local' | 'sso' | 'both' {
    const mode = this.config.get<string>('ADMIN_AUTH_MODE') ?? 'local';
    return mode === 'sso' || mode === 'both' ? mode : 'local';
  }

  cookieName(): string {
    return (
      this.config.get<string>('ADMIN_AUTH_COOKIE_NAME') ?? DEFAULT_COOKIE_NAME
    );
  }

  sessionStatus(req: Request): SessionStatus {
    if (!this.isEnabled()) {
      return {
        authEnabled: false,
        authenticated: true,
        mode: 'disabled',
        user: {
          sub: 'auth-disabled',
          name: 'Auth disabled',
          provider: 'disabled',
        },
      };
    }

    const session = this.readSession(req);
    if (!session) {
      return {
        authEnabled: true,
        authenticated: false,
        mode: this.mode(),
      };
    }

    return {
      authEnabled: true,
      authenticated: true,
      mode: this.mode(),
      csrfToken: session.csrfToken,
      user: {
        sub: session.sub,
        name: session.name,
        provider: session.provider,
      },
    };
  }

  loginLocal(username: string, password: string, res: Response): SessionStatus {
    if (!this.isEnabled()) {
      return this.issueDisabledStatus();
    }
    if (this.mode() === 'sso') {
      throw new UnauthorizedException('Local admin login is disabled');
    }

    const expectedUser = this.config.get<string>('ADMIN_AUTH_LOCAL_USERNAME');
    const expectedPassword = this.config.get<string>(
      'ADMIN_AUTH_LOCAL_PASSWORD',
    );
    if (
      !expectedUser ||
      !expectedPassword ||
      !this.safeEqual(username, expectedUser) ||
      !this.safeEqual(password, expectedPassword)
    ) {
      throw new UnauthorizedException('Invalid admin credentials');
    }

    const session = this.createSession(username, username, 'local');
    this.writeSessionCookie(res, session);
    return this.sessionStatusFromSession(session);
  }

  loginSso(req: Request, res: Response): SessionStatus {
    if (!this.isEnabled()) {
      return this.issueDisabledStatus();
    }
    if (this.mode() === 'local') {
      throw new UnauthorizedException('SSO admin login is disabled');
    }
    if (!this.isTrustedSsoSource(req)) {
      throw new UnauthorizedException('SSO headers require a trusted proxy');
    }

    const identity = this.extractSsoIdentity(req);
    if (!identity || !this.isSsoAllowed(identity)) {
      throw new UnauthorizedException('SSO user is not allowed for Admin UI');
    }

    const session = this.createSession(identity.user, identity.user, 'sso');
    this.writeSessionCookie(res, session);
    return this.sessionStatusFromSession(session);
  }

  logout(res: Response): void {
    res.setHeader('Set-Cookie', this.clearCookieHeader());
  }

  authenticateRequest(req: Request, res?: Response): AdminUserSession | null {
    if (!this.isEnabled()) {
      return {
        sub: 'auth-disabled',
        name: 'Auth disabled',
        provider: 'disabled',
        csrfToken: 'auth-disabled',
        expiresAt: Date.now() + 60_000,
      };
    }

    const session = this.readSession(req);
    if (session) {
      return session;
    }

    if (this.mode() !== 'local' && res) {
      const identity = this.isTrustedSsoSource(req)
        ? this.extractSsoIdentity(req)
        : null;
      if (identity && this.isSsoAllowed(identity)) {
        const ssoSession = this.createSession(
          identity.user,
          identity.user,
          'sso',
        );
        this.writeSessionCookie(res, ssoSession);
        return ssoSession;
      }
    }

    return null;
  }

  verifyCsrf(req: Request, session: AdminUserSession): boolean {
    if (!this.isEnabled()) {
      return true;
    }
    const value = this.header(req, 'x-csrf-token');
    return Boolean(value && this.safeEqual(value, session.csrfToken));
  }

  private createSession(
    sub: string,
    name: string,
    provider: 'local' | 'sso',
  ): AdminUserSession {
    return {
      sub,
      name,
      provider,
      csrfToken: randomBytes(24).toString('base64url'),
      expiresAt: Date.now() + this.ttlSeconds() * 1000,
    };
  }

  private readSession(req: Request): AdminUserSession | null {
    const raw = this.cookies(req)[this.cookieName()];
    if (!raw) {
      return null;
    }
    const [payload, signature] = raw.split('.');
    if (
      !payload ||
      !signature ||
      !this.safeEqual(signature, this.sign(payload))
    ) {
      return null;
    }
    try {
      const session = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as AdminUserSession;
      if (!session.expiresAt || session.expiresAt < Date.now()) {
        return null;
      }
      return session;
    } catch {
      return null;
    }
  }

  private writeSessionCookie(res: Response, session: AdminUserSession): void {
    const payload = Buffer.from(JSON.stringify(session), 'utf8').toString(
      'base64url',
    );
    const value = `${payload}.${this.sign(payload)}`;
    res.setHeader(
      'Set-Cookie',
      `${this.cookieName()}=${value}; ${this.cookieAttributes()}`,
    );
  }

  private clearCookieHeader(): string {
    return `${this.cookieName()}=; Max-Age=0; Path=/; HttpOnly; SameSite=${this.sameSite()}`;
  }

  private cookieAttributes(): string {
    const secure = this.secureCookie() ? '; Secure' : '';
    return `Max-Age=${this.ttlSeconds()}; Path=/; HttpOnly; SameSite=${this.sameSite()}${secure}`;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.sessionSecret())
      .update(payload)
      .digest('base64url');
  }

  private sessionSecret(): string {
    const secret = this.config.get<string>('ADMIN_AUTH_SESSION_SECRET');
    if (!secret) {
      throw new Error(
        'ADMIN_AUTH_SESSION_SECRET is required when ADMIN_AUTH_ENABLED=true',
      );
    }
    return secret;
  }

  private ttlSeconds(): number {
    return this.config.get<number>('ADMIN_AUTH_SESSION_TTL_SECONDS') ?? 28800;
  }

  private sameSite(): string {
    const configured =
      this.config.get<string>('ADMIN_AUTH_COOKIE_SAMESITE') ?? 'Strict';
    return ['Strict', 'Lax', 'None'].includes(configured)
      ? configured
      : 'Strict';
  }

  private secureCookie(): boolean {
    const explicit = this.config.get<boolean>('ADMIN_AUTH_COOKIE_SECURE');
    if (explicit !== undefined) {
      return explicit;
    }
    return (
      this.config.get<string>('NODE_ENV') === 'production' ||
      (this.config.get<boolean>('HTTP_TLS_ENABLED') ?? false)
    );
  }

  private extractSsoIdentity(req: Request): SsoIdentity | null {
    const userHeader =
      this.config.get<string>('ADMIN_AUTH_SSO_USER_HEADER') ??
      'x-authenticated-user';
    const groupsHeader =
      this.config.get<string>('ADMIN_AUTH_SSO_GROUPS_HEADER') ??
      'x-authenticated-groups';
    const user = this.header(req, userHeader);
    if (!user) {
      return null;
    }
    const delimiter =
      this.config.get<string>('ADMIN_AUTH_SSO_GROUPS_DELIMITER') ?? ',';
    const groups = (this.header(req, groupsHeader) ?? '')
      .split(delimiter)
      .map((group) => group.trim())
      .filter(Boolean);
    return { user, groups };
  }

  private isTrustedSsoSource(req: Request): boolean {
    const allowlist = this.csv('ADMIN_AUTH_TRUSTED_PROXY_CIDRS');
    if (allowlist.length === 0) {
      return false;
    }

    return [req.ip, req.socket?.remoteAddress].some((candidate) =>
      isIpAllowed(candidate, allowlist),
    );
  }

  private isSsoAllowed(identity: SsoIdentity): boolean {
    const allowlist = this.csv('ADMIN_AUTH_ALLOWLIST');
    const allowedGroups = this.csv('ADMIN_AUTH_ALLOWED_GROUPS');
    return (
      allowlist.includes(identity.user) ||
      identity.groups.some((group) => allowedGroups.includes(group))
    );
  }

  private csv(name: string): string[] {
    return (this.config.get<string>(name) ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private header(req: Request, name: string): string | undefined {
    const value = req.headers[name.toLowerCase()];
    if (Array.isArray(value)) {
      return value[0];
    }
    return value;
  }

  private cookies(req: Request): Record<string, string> {
    const raw = req.headers.cookie;
    if (!raw) {
      return {};
    }
    return Object.fromEntries(
      raw.split(';').map((part) => {
        const [key, ...rest] = part.trim().split('=');
        return [key, rest.join('=')];
      }),
    );
  }

  private safeEqual(a: string, b: string): boolean {
    return safeEqualFixedLength(a, b, 'auth-service');
  }

  private sessionStatusFromSession(session: AdminUserSession): SessionStatus {
    return {
      authEnabled: true,
      authenticated: true,
      mode: this.mode(),
      csrfToken: session.csrfToken,
      user: {
        sub: session.sub,
        name: session.name,
        provider: session.provider,
      },
    };
  }

  private issueDisabledStatus(): SessionStatus {
    return {
      authEnabled: false,
      authenticated: true,
      mode: 'disabled',
      user: {
        sub: 'auth-disabled',
        name: 'Auth disabled',
        provider: 'disabled',
      },
    };
  }
}
