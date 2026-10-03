import { Global, Module } from '@nestjs/common';
import { DiagnosticsModule } from '../diagnostics/diagnostics.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AdminAuthMiddleware } from './admin-auth.middleware';
import { OidcAuthService } from './oidc-auth.service';
import { SamlAuthService } from './saml-auth.service';

@Global()
@Module({
  imports: [DiagnosticsModule],
  controllers: [AuthController],
  providers: [AuthService, AdminAuthMiddleware, OidcAuthService, SamlAuthService],
  exports: [AuthService, AdminAuthMiddleware],
})
export class AuthModule {}
