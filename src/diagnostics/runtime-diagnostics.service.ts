import { Injectable } from '@nestjs/common';
import type { DebugLoggingLevel } from '../config/logging.config';
import { runtimeLogBuffer, type BufferedLogEvent } from './log-buffer';

export interface RuntimeDebugSession {
  id: string;
  enabled: boolean;
  level: DebugLoggingLevel;
  targetSystem?: string;
  expiresAt: string;
  createdAt: string;
}

export interface EnableRuntimeDebugInput {
  targetSystem?: string;
  level?: DebugLoggingLevel;
  ttlSeconds?: number;
}

@Injectable()
export class RuntimeDiagnosticsService {
  private readonly sessions = new Map<string, RuntimeDebugSession>();

  enable(input: EnableRuntimeDebugInput): RuntimeDebugSession {
    const now = Date.now();
    const ttlSeconds = this.normalizeTtl(input.ttlSeconds);
    const session: RuntimeDebugSession = {
      id: `debug-${now}-${Math.random().toString(36).slice(2, 10)}`,
      enabled: true,
      level: input.level === 'Verbose' ? 'Verbose' : 'Basic',
      targetSystem: this.normalizeTarget(input.targetSystem),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  disable(id: string): boolean {
    return this.sessions.delete(id);
  }

  status(): { active: RuntimeDebugSession[] } {
    return { active: this.activeSessions() };
  }

  isEnabled(targetSystem?: string): boolean {
    return this.activeSessions().some((session) =>
      this.matchesTarget(session, targetSystem),
    );
  }

  level(targetSystem?: string): DebugLoggingLevel {
    const sessions = this.activeSessions().filter((session) =>
      this.matchesTarget(session, targetSystem),
    );
    return sessions.some((session) => session.level === 'Verbose')
      ? 'Verbose'
      : 'Basic';
  }

  logs(query: {
    targetSystem?: string;
    level?: string;
    limit?: number;
  }): BufferedLogEvent[] {
    return runtimeLogBuffer.query(query);
  }

  clearLogs(query: { targetSystem?: string } = {}): { cleared: number } {
    return { cleared: runtimeLogBuffer.clear(query) };
  }

  private activeSessions(): RuntimeDebugSession[] {
    const now = Date.now();
    const active: RuntimeDebugSession[] = [];

    for (const [id, session] of this.sessions.entries()) {
      if (Date.parse(session.expiresAt) <= now) {
        this.sessions.delete(id);
        continue;
      }
      active.push(session);
    }

    return active.sort((left, right) =>
      left.expiresAt.localeCompare(right.expiresAt),
    );
  }

  private normalizeTtl(value: unknown): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) return 300;
    return Math.min(Math.max(Math.trunc(parsed), 60), 1800);
  }

  private normalizeTarget(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private matchesTarget(
    session: RuntimeDebugSession,
    targetSystem?: string,
  ): boolean {
    const normalized = this.normalizeTarget(targetSystem);
    if (!session.targetSystem) {
      return true;
    }
    return normalized !== undefined && session.targetSystem === normalized;
  }
}
