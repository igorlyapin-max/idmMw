import { Body, Controller, Get, Header, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import type { SessionStatus } from './auth.service';
import { OidcAuthService } from './oidc-auth.service';
import { SamlAuthService } from './saml-auth.service';

interface LoginBody {
  username?: string;
  password?: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly oidc: OidcAuthService,
    private readonly saml: SamlAuthService,
  ) {}

  @Get('session')
  session(@Req() req: Request): SessionStatus {
    return this.auth.sessionStatus(req);
  }

  @Post('login')
  login(
    @Body() body: LoginBody,
    @Res({ passthrough: true }) res: Response,
  ): SessionStatus {
    return this.auth.loginLocal(body.username ?? '', body.password ?? '', res);
  }

  @Post('sso-login')
  ssoLogin(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): SessionStatus {
    return this.auth.loginSso(req, res);
  }

  @Get('oidc/login')
  async oidcLogin(@Res() res: Response): Promise<void> {
    await this.oidc.startLogin(res);
  }

  @Get('oidc/callback')
  async oidcCallback(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.oidc.completeCallback(req, res);
  }

  @Get('saml/login')
  async samlLogin(@Res() res: Response): Promise<void> {
    await this.saml.startLogin(res);
  }

  @Post('saml/acs')
  async samlAcs(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.saml.completeAcs(req, res);
  }

  @Get('saml/metadata')
  @Header('Content-Type', 'application/samlmetadata+xml; charset=utf-8')
  samlMetadata(): string {
    return this.saml.metadata();
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response): { success: true } {
    this.auth.logout(res);
    return { success: true };
  }
}
