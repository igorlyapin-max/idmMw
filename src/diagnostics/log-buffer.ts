import { Writable } from 'stream';

export interface BufferedLogEvent {
  id: number;
  time: number;
  level: number | string;
  msg?: string;
  event?: string;
  diagnostic?: boolean;
  diagnosticLevel?: string;
  targetSystem?: string;
  context?: string;
  method?: string;
  path?: string;
  status?: number;
  responseTime?: number;
}

export interface LogQuery {
  targetSystem?: string;
  level?: string;
  limit?: number;
}

const MAX_LOG_EVENTS = 2000;
const LEVEL_BY_NUMBER: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

class RuntimeLogBuffer {
  private readonly events: BufferedLogEvent[] = [];
  private nextId = 1;

  append(value: Record<string, unknown>): void {
    this.events.push(this.normalize(value));
    if (this.events.length > MAX_LOG_EVENTS) {
      this.events.splice(0, this.events.length - MAX_LOG_EVENTS);
    }
  }

  clear(): void {
    this.events.splice(0, this.events.length);
    this.nextId = 1;
  }

  query(query: LogQuery = {}): BufferedLogEvent[] {
    const limit = this.normalizeLimit(query.limit);
    const targetSystem = query.targetSystem?.trim();
    const level = query.level?.trim().toLowerCase();
    const result: BufferedLogEvent[] = [];

    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (targetSystem && event.targetSystem !== targetSystem) {
        continue;
      }
      if (level && this.levelName(event.level) !== level) {
        continue;
      }
      result.push(event);
      if (result.length >= limit) break;
    }

    return result.reverse();
  }

  private normalize(value: Record<string, unknown>): BufferedLogEvent {
    return {
      id: this.nextId++,
      time: this.numberOrNow(value['time']),
      level: this.logLevel(value['level']),
      msg: this.stringValue(value['msg']),
      event: this.stringValue(value['event']),
      diagnostic: value['diagnostic'] === true,
      diagnosticLevel: this.stringValue(value['diagnosticLevel']),
      targetSystem: this.stringValue(value['targetSystem']),
      context: this.stringValue(value['context']),
      method: this.stringValue(value['method']) ?? this.requestMethod(value),
      path: this.safePath(value['path']) ?? this.requestPath(value),
      status: this.statusValue(value['status']) ?? this.responseStatus(value),
      responseTime: this.numberValue(value['responseTime']),
    };
  }

  private normalizeLimit(value: unknown): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) return 200;
    return Math.min(Math.max(Math.trunc(parsed), 1), 500);
  }

  private numberOrNow(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : Date.now();
  }

  private logLevel(value: unknown): number | string {
    if (typeof value === 'number' || typeof value === 'string') {
      return value;
    }
    return 'info';
  }

  private stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined;
  }

  private statusValue(value: unknown): number | undefined {
    const parsed = this.numberValue(value);
    return parsed === undefined ? undefined : Math.trunc(parsed);
  }

  private requestMethod(value: Record<string, unknown>): string | undefined {
    const req = value['req'];
    if (req === null || typeof req !== 'object' || Array.isArray(req)) {
      return undefined;
    }
    return this.stringValue((req as Record<string, unknown>)['method']);
  }

  private requestPath(value: Record<string, unknown>): string | undefined {
    const req = value['req'];
    if (req === null || typeof req !== 'object' || Array.isArray(req)) {
      return undefined;
    }
    return this.safePath((req as Record<string, unknown>)['url']);
  }

  private responseStatus(value: Record<string, unknown>): number | undefined {
    const res = value['res'];
    if (res === null || typeof res !== 'object' || Array.isArray(res)) {
      return undefined;
    }
    return this.statusValue((res as Record<string, unknown>)['statusCode']);
  }

  private safePath(value: unknown): string | undefined {
    const raw = this.stringValue(value);
    if (!raw) return undefined;
    const queryStart = raw.indexOf('?');
    return queryStart >= 0 ? raw.slice(0, queryStart) : raw;
  }

  private levelName(value: number | string): string {
    if (typeof value === 'number') {
      return LEVEL_BY_NUMBER[value] ?? String(value);
    }
    return value.toLowerCase();
  }
}

class LogBufferStream extends Writable {
  private pending = '';

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.pending += chunk.toString();
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        runtimeLogBuffer.append(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        runtimeLogBuffer.append({
          time: Date.now(),
          level: 30,
          msg: trimmed,
        });
      }
    }

    callback();
  }
}

export const runtimeLogBuffer = new RuntimeLogBuffer();

export function createLogBufferStream(): Writable {
  return new LogBufferStream();
}

export function resetRuntimeLogBufferForTests(): void {
  runtimeLogBuffer.clear();
}
