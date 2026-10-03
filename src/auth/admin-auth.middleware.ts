import { Injectable } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { AuthService } from './auth.service';
import type { AdminRequest } from './admin-request';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class AdminAuthMiddleware {
  constructor(private readonly auth: AuthService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    if (!this.requiresAdminAuth(req.path)) {
      next();
      return;
    }

    const session = this.auth.authenticateRequest(req, res);
    if (!session) {
      this.reject(res, 401, 'Admin authentication required');
      return;
    }
    (req as AdminRequest).adminSession = session;

    if (!SAFE_METHODS.has(req.method) && !this.auth.verifyCsrf(req, session)) {
      this.reject(res, 403, 'Invalid CSRF token');
      return;
    }

    next();
  }

  private requiresAdminAuth(path: string): boolean {
    return (
      path === '/auth/logout' || path === '/admin' || path.startsWith('/admin/')
    );
  }

  private reject(res: Response, status: number, message: string): void {
    res.status(status).json({ success: false, message });
  }
}
