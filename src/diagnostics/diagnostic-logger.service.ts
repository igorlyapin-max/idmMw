import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DebugLoggingLevel } from '../config/logging.config';
import {
  SECRET_REDACTION_CENSOR,
  isSecretKey,
} from '../security/secret-redaction';
import { RuntimeDiagnosticsService } from './runtime-diagnostics.service';

@Injectable()
export class DiagnosticLoggerService {
  private readonly logger = new Logger(DiagnosticLoggerService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly runtimeDiagnostics: RuntimeDiagnosticsService,
  ) {}

  basic(event: string, fields: Record<string, unknown> = {}): void {
    const targetSystem = this.targetSystem(fields);
    if (!this.enabled(targetSystem)) return;
    this.logger.log({
      diagnostic: true,
      diagnosticLevel: 'Basic',
      event,
      ...this.redactRecord(fields, false),
    });
  }

  verbose(event: string, fields: Record<string, unknown> = {}): void {
    const targetSystem = this.targetSystem(fields);
    if (!this.enabled(targetSystem) || this.level(targetSystem) !== 'Verbose') {
      return;
    }
    this.logger.log({
      diagnostic: true,
      diagnosticLevel: 'Verbose',
      event,
      ...this.redactRecord(fields, true),
    });
  }

  isEnabled(targetSystem?: string): boolean {
    return this.enabled(targetSystem);
  }

  level(targetSystem?: string): DebugLoggingLevel {
    if (this.runtimeDiagnostics.isEnabled(targetSystem)) {
      return this.runtimeDiagnostics.level(targetSystem);
    }
    const value =
      this.config.get<string>('DebugLogging__Level') ??
      this.config.get<string>('DEBUG_LOGGING_LEVEL');
    return value === 'Verbose' ? 'Verbose' : 'Basic';
  }

  private enabled(targetSystem?: string): boolean {
    return (
      this.runtimeDiagnostics.isEnabled(targetSystem) ||
      (this.config.get<boolean>('DebugLogging__Enabled') ?? false) ||
      (this.config.get<boolean>('DEBUG_LOGGING_ENABLED') ?? false)
    );
  }

  private targetSystem(fields: Record<string, unknown>): string | undefined {
    return typeof fields['targetSystem'] === 'string'
      ? fields['targetSystem']
      : undefined;
  }

  private redactRecord(
    value: Record<string, unknown>,
    keepStructure: boolean,
  ): Record<string, unknown> {
    return this.redact(value, keepStructure) as Record<string, unknown>;
  }

  private redact(value: unknown, keepStructure: boolean): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item, keepStructure));
    }

    if (value === null || typeof value !== 'object') {
      return value;
    }

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSecretKey(key)) {
        result[key] = SECRET_REDACTION_CENSOR;
        continue;
      }
      if (!keepStructure && typeof item === 'object' && item !== null) {
        result[key] = '[omitted]';
        continue;
      }
      result[key] = this.redact(item, keepStructure);
    }
    return result;
  }
}
