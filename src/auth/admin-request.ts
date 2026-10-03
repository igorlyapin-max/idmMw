import type { Request } from 'express';
import type { AdminUserSession } from './auth.service';

export interface AdminRequest extends Request {
  adminSession?: AdminUserSession;
}
