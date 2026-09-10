import pino, { type DestinationStream } from 'pino';
import type { Options } from 'pino-http';
import { createLogBufferStream } from '../diagnostics/log-buffer';

export type DebugLoggingLevel = 'Basic' | 'Verbose';

export interface RuntimeLoggingConfig {
  debugEnabled: boolean;
  debugLevel: DebugLoggingLevel;
  logSink: 'stdout' | 'file';
  logFilePath: string;
  pinoLevel: 'debug' | 'info';
}

const SECRET_REDACTION_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.Authorization',
  'headers.authorization',
  'payload.config.password',
  'payload.config.passwd',
  'payload.config.token',
  'payload.config.accessToken',
  'payload.config.apiToken',
  'payload.config.refreshToken',
  'payload.config.masterKey',
  'payload.config.masterKeyHash',
  'payload.config.credential',
  'payload.config.apiKey',
  'payload.config.key',
  'payload.config.secret',
  'payload.config.tls.key',
  'payload.config.tls.cert',
  'payload.config.tls.ca',
  'payload.config.tls.walletPassword',
  'payload.data.password',
  'payload.data.passwd',
  'payload.data.newValue',
  'payload.data.oldValue',
  'payload.data.value',
  'payload.data.credential',
  'payload.params.password',
  'payload.params.passwd',
  'payload.params.token',
  'payload.params.secret',
  'payload.params.newValue',
  'payload.params.oldValue',
  'payload.params.value',
  'payload.params.credential',
  'config.password',
  'config.passwd',
  'config.token',
  'config.accessToken',
  'config.apiToken',
  'config.refreshToken',
  'config.masterKey',
  'config.masterKeyHash',
  'config.credential',
  'config.apiKey',
  'config.key',
  'config.secret',
  'config.tls.key',
  'config.tls.cert',
  'config.tls.ca',
  'config.tls.walletPassword',
  'tls.key',
  'tls.cert',
  'tls.ca',
  'tls.walletPassword',
  'ENCRYPTION_KEY',
  'ENCRYPTION_KEYS',
  'HTTP_TLS_KEY',
  'REDIS_TLS_KEY',
  'KAFKA_TLS_KEY',
  'DB_CONNECTOR_TLS_KEY',
  '*.password',
  '*.passwd',
  '*.token',
  '*.accessToken',
  '*.apiToken',
  '*.refreshToken',
  '*.masterKey',
  '*.masterKeyHash',
  '*.credential',
  '*.newValue',
  '*.oldValue',
  '*.value',
  '*.apiKey',
  '*.key',
  '*.secret',
  '*.cert',
  '*.ca',
  '*.walletPassword',
];

function envFlag(primary: string, fallback?: string): boolean {
  return (
    process.env[primary] === 'true' ||
    (fallback !== undefined && process.env[fallback] === 'true')
  );
}

function debugLevel(): DebugLoggingLevel {
  const value =
    process.env['DebugLogging__Level'] ?? process.env['DEBUG_LOGGING_LEVEL'];
  return value === 'Verbose' ? 'Verbose' : 'Basic';
}

export function runtimeLoggingConfig(): RuntimeLoggingConfig {
  const debugEnabled = envFlag(
    'DebugLogging__Enabled',
    'DEBUG_LOGGING_ENABLED',
  );
  const level = debugLevel();
  const logSink =
    process.env['LOG_SINK'] === 'file'
      ? ('file' as const)
      : ('stdout' as const);

  return {
    debugEnabled,
    debugLevel: level,
    logSink,
    logFilePath: process.env['LOG_FILE_PATH'] ?? '/tmp/idmmw.log',
    pinoLevel:
      debugEnabled && level === 'Verbose'
        ? 'debug'
        : process.env['NODE_ENV'] === 'production'
          ? 'info'
          : 'debug',
  };
}

export function createPinoHttpConfig(): Options | [Options, DestinationStream] {
  const cfg = runtimeLoggingConfig();
  const options: Options = {
    level: cfg.pinoLevel,
    base: {
      service: 'idmMw',
    },
    redact: {
      paths: SECRET_REDACTION_PATHS,
      censor: '[REDACTED]',
    },
    transport:
      cfg.logSink === 'stdout' && process.env['NODE_ENV'] !== 'production'
        ? { target: 'pino-pretty' }
        : undefined,
  };

  const streams = [
    { level: cfg.pinoLevel, stream: pino.destination(1) },
    { level: 'debug', stream: createLogBufferStream() },
  ];

  if (cfg.logSink === 'file') {
    streams.push({
      level: cfg.pinoLevel,
      stream: pino.destination({
        dest: cfg.logFilePath,
        sync: false,
        mkdir: true,
      }),
    });
  }

  return [{ ...options, transport: undefined }, pino.multistream(streams)];
}
