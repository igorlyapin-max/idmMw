import { Injectable, Logger, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import { Client, ConnectConfig } from 'ssh2';
import type { AxiosRequestConfig } from 'axios';
import {
  Connector,
  ConnectorCapabilities,
  ConnectorPayload,
  ConnectorResult,
} from '../../connector.interface';
import { createConnectorCapabilities } from '../../connector.capabilities';
import { safeConnectorErrorMessage } from '../../connector-error.util';
import {
  TlsConnectionConfig,
  TlsOptionsFactory,
} from '../../../security/tls-options.factory';

type LinuxProvider = 'ssh-sudo' | 'remote-agent';

interface LinuxConnectorConfig {
  provider?: LinuxProvider;
  loginPrefix?: string;
  defaultShell?: string;
  defaultHomeBase?: string;
  defaultGroups?: string[];
  physicalDeleteEnabled?: boolean;
  removeHomeOnDelete?: boolean;
  timeoutMs?: number;
  host?: string;
  port?: number;
  username?: string;
  privateKey?: string;
  password?: string;
  hostFingerprint?: string;
  sudoMode?: 'passwordless';
  baseUrl?: string;
  apiToken?: string;
  allowedHosts?: string[];
  tls?: TlsConnectionConfig;
}

interface LinuxUserData extends Record<string, unknown> {
  login?: unknown;
  username?: unknown;
  managedLogin?: unknown;
  email?: unknown;
  password?: unknown;
  newValue?: unknown;
  groups?: unknown;
  shell?: unknown;
  homeDirectory?: unknown;
}

const LINUX_PARTIAL_OPERATIONS: Record<string, string> = {
  'user.delete':
    'Default mapping is safe lock and expire; physical userdel requires physicalDeleteEnabled=true.',
  'user.disable': 'Mapped to account lock and expire.',
  'user.lock': 'Mapped to account lock and expire.',
  'user.enable': 'Mapped to account unlock and unexpire.',
  'user.unlock': 'Mapped to account unlock and unexpire.',
  'group.create': 'Linux group lifecycle is out of first connector scope.',
  'group.update': 'Linux group lifecycle is out of first connector scope.',
  'group.delete': 'Linux group lifecycle is out of first connector scope.',
};

const LINUX_UNSUPPORTED_OPERATIONS: Record<string, string> = {
  'user.addAttributes': 'Linux custom attribute mapping is not supported.',
  'user.removeAttributes': 'Linux custom attribute mapping is not supported.',
  'group.addMember': 'Linux group membership lifecycle is not supported.',
  'group.removeMember': 'Linux group membership lifecycle is not supported.',
  'group.get': 'Linux group read is not supported.',
  'group.search': 'Linux group search is not supported.',
};

@Injectable()
export class LinuxConnectorService implements Connector {
  readonly name = 'linux';
  private readonly logger = new Logger(LinuxConnectorService.name);

  constructor(
    private readonly httpService: HttpService,
    @Optional() private readonly tlsOptions?: TlsOptionsFactory,
  ) {}

  getCapabilities(): ConnectorCapabilities {
    return createConnectorCapabilities(
      LINUX_PARTIAL_OPERATIONS,
      {},
      LINUX_UNSUPPORTED_OPERATIONS,
    );
  }

  async execute(payload: ConnectorPayload): Promise<ConnectorResult> {
    const config = payload.payload['config'] as
      | LinuxConnectorConfig
      | undefined;
    if (!config?.provider) {
      return { success: false, error: 'Missing Linux provider' };
    }

    try {
      const result =
        config.provider === 'remote-agent'
          ? await this.executeRemoteAgent(payload, config)
          : await this.executeSsh(payload, config);
      this.logger.log(`Linux operation succeeded: ${payload.operation}`);
      return { success: true, data: result };
    } catch (error: unknown) {
      const data = payload.payload['data'];
      const params = payload.payload['params'];
      const msg = safeConnectorErrorMessage(error, config, data, params);
      this.logger.error(`Linux operation failed: ${msg}`);
      return { success: false, error: msg };
    }
  }

  async testConnection(
    config: Record<string, unknown>,
  ): Promise<{ success: boolean; message: string }> {
    const cfg = config as LinuxConnectorConfig;
    try {
      if (cfg.provider === 'remote-agent') {
        if (!cfg.baseUrl) {
          return {
            success: false,
            message: 'Missing Linux remote-agent baseUrl',
          };
        }
        await this.remoteRequest(cfg, 'GET', '/health');
        return { success: true, message: 'Linux remote-agent reachable' };
      }

      if (cfg.provider === 'ssh-sudo') {
        await this.execSsh(cfg, 'id');
        return { success: true, message: 'Linux SSH reachable' };
      }

      return { success: false, message: 'Missing Linux provider' };
    } catch (error: unknown) {
      const msg = safeConnectorErrorMessage(error, cfg);
      return { success: false, message: `Linux connection failed: ${msg}` };
    }
  }

  getSchema(): Promise<ConnectorResult> {
    return Promise.resolve({
      success: true,
      data: {
        objectClasses: [
          {
            name: 'user',
            attributes: [
              {
                name: 'login',
                type: 'string',
                required: true,
                multiValued: false,
              },
              {
                name: 'password',
                type: 'string',
                required: true,
                multiValued: false,
              },
              {
                name: 'groups',
                type: 'array',
                required: false,
                multiValued: true,
              },
              {
                name: 'shell',
                type: 'string',
                required: false,
                multiValued: false,
              },
            ],
          },
        ],
      },
    });
  }

  private async executeRemoteAgent(
    payload: ConnectorPayload,
    config: LinuxConnectorConfig,
  ): Promise<unknown> {
    const data = (payload.payload['data'] ?? {}) as LinuxUserData;
    const params = (payload.payload['params'] ?? {}) as Record<string, unknown>;

    switch (payload.operation) {
      case 'system.test':
        return this.remoteRequest(config, 'GET', '/health');
      case 'schema.get':
        return this.remoteRequest(config, 'GET', '/schema');
      case 'user.create': {
        const createLogin = this.login(data, params, config);
        return this.remoteRequest(config, 'POST', '/users', {
          ...data,
          login: createLogin,
          password: this.password(data, true),
        });
      }
      case 'user.update': {
        const updateLogin = this.login(data, params, config);
        return this.remoteRequest(
          config,
          'PATCH',
          `/users/${encodeURIComponent(updateLogin)}`,
          data,
        );
      }
      case 'user.delete': {
        const deleteLogin = this.login(data, params, config);
        return config.physicalDeleteEnabled
          ? this.remoteRequest(
              config,
              'DELETE',
              `/users/${encodeURIComponent(deleteLogin)}`,
              {
                removeHome: config.removeHomeOnDelete === true,
              },
            )
          : this.remoteRequest(
              config,
              'POST',
              `/users/${encodeURIComponent(deleteLogin)}/disable`,
            );
      }
      case 'user.disable':
      case 'user.lock': {
        const disableLogin = this.login(data, params, config);
        return this.remoteRequest(
          config,
          'POST',
          `/users/${encodeURIComponent(disableLogin)}/disable`,
        );
      }
      case 'user.enable':
      case 'user.unlock': {
        const enableLogin = this.login(data, params, config);
        return this.remoteRequest(
          config,
          'POST',
          `/users/${encodeURIComponent(enableLogin)}/enable`,
        );
      }
      case 'user.changePassword': {
        const passwordLogin = this.login(data, params, config);
        return this.remoteRequest(
          config,
          'POST',
          `/users/${encodeURIComponent(passwordLogin)}/password`,
          { password: this.password(data, true) },
        );
      }
      case 'user.get':
      case 'user.resolve': {
        const getLogin = this.login(data, params, config);
        return this.remoteRequest(
          config,
          'GET',
          `/users/${encodeURIComponent(getLogin)}`,
        );
      }
      case 'user.search':
      case 'sync.full':
      case 'sync.incremental':
        return this.remoteRequest(config, 'GET', '/users');
      default:
        throw new Error(`Unsupported Linux operation: ${payload.operation}`);
    }
  }

  private async executeSsh(
    payload: ConnectorPayload,
    config: LinuxConnectorConfig,
  ): Promise<unknown> {
    const data = (payload.payload['data'] ?? {}) as LinuxUserData;
    const params = (payload.payload['params'] ?? {}) as Record<string, unknown>;

    switch (payload.operation) {
      case 'system.test':
        await this.execSsh(config, 'id');
        return { reachable: true };
      case 'schema.get':
        return (await this.getSchema()).data;
      case 'user.create': {
        const createLogin = this.login(data, params, config);
        await this.execSsh(
          config,
          this.userAddCommand(config, createLogin, data),
        );
        await this.execSshWithInput(
          config,
          'sudo chpasswd',
          `${createLogin}:${this.password(data, true)}\n`,
        );
        return { login: createLogin, created: true };
      }
      case 'user.update': {
        const updateLogin = this.login(data, params, config);
        await this.execSsh(
          config,
          this.userModifyCommand(config, updateLogin, data),
        );
        return { login: updateLogin, updated: true };
      }
      case 'user.delete': {
        const deleteLogin = this.login(data, params, config);
        if (config.physicalDeleteEnabled) {
          await this.execSsh(
            config,
            `sudo userdel ${config.removeHomeOnDelete === true ? '-r ' : ''}${this.arg(deleteLogin)}`,
          );
          return { login: deleteLogin, deleted: true };
        }
        await this.disableSshUser(config, deleteLogin);
        return { login: deleteLogin, deleted: false, enabled: false };
      }
      case 'user.disable':
      case 'user.lock': {
        const disableLogin = this.login(data, params, config);
        await this.disableSshUser(config, disableLogin);
        return { login: disableLogin, enabled: false };
      }
      case 'user.enable':
      case 'user.unlock': {
        const enableLogin = this.login(data, params, config);
        await this.execSsh(
          config,
          `sudo passwd -u ${this.arg(enableLogin)} && sudo chage -E -1 ${this.arg(enableLogin)}`,
        );
        return { login: enableLogin, enabled: true };
      }
      case 'user.changePassword': {
        const passwordLogin = this.login(data, params, config);
        await this.execSshWithInput(
          config,
          'sudo chpasswd',
          `${passwordLogin}:${this.password(data, true)}\n`,
        );
        return { login: passwordLogin, passwordChanged: true };
      }
      case 'user.get':
      case 'user.resolve': {
        const getLogin = this.login(data, params, config);
        return {
          login: getLogin,
          raw: await this.execSsh(
            config,
            `getent passwd ${this.arg(getLogin)}`,
          ),
        };
      }
      case 'user.search':
      case 'sync.full':
      case 'sync.incremental':
        return { raw: await this.execSsh(config, 'getent passwd') };
      default:
        throw new Error(`Unsupported Linux operation: ${payload.operation}`);
    }
  }

  private async disableSshUser(
    config: LinuxConnectorConfig,
    login: string,
  ): Promise<void> {
    await this.execSsh(
      config,
      `sudo passwd -l ${this.arg(login)} && sudo chage -E 0 ${this.arg(login)}`,
    );
  }

  private userAddCommand(
    config: LinuxConnectorConfig,
    login: string,
    data: LinuxUserData,
  ): string {
    const shell =
      this.firstString(data.shell) ?? config.defaultShell ?? '/bin/bash';
    const home =
      this.firstString(data.homeDirectory) ??
      `${config.defaultHomeBase ?? '/home'}/${login}`;
    const groups = this.groups(config, data);
    return [
      'sudo useradd',
      '-m',
      `-d ${this.arg(home)}`,
      `-s ${this.arg(shell)}`,
      groups.length ? `-G ${this.arg(groups.join(','))}` : '',
      this.arg(login),
    ]
      .filter(Boolean)
      .join(' ');
  }

  private userModifyCommand(
    config: LinuxConnectorConfig,
    login: string,
    data: LinuxUserData,
  ): string {
    const parts = ['sudo usermod'];
    const shell = this.firstString(data.shell);
    if (shell) {
      parts.push(`-s ${this.arg(shell)}`);
    }
    const groups = this.groups(config, data);
    if (groups.length) {
      parts.push(`-G ${this.arg(groups.join(','))}`);
    }
    parts.push(this.arg(login));
    return parts.join(' ');
  }

  private async remoteRequest(
    config: LinuxConnectorConfig,
    method: string,
    path: string,
    data?: unknown,
  ): Promise<unknown> {
    if (!config.baseUrl) {
      throw new Error('Missing Linux remote-agent baseUrl');
    }
    const parsed = new URL(path, config.baseUrl);
    if (config.apiToken && parsed.protocol !== 'https:') {
      throw new Error('Linux remote-agent apiToken requires https baseUrl');
    }
    const allowedHosts = (config.allowedHosts ?? []).map((host) =>
      host.toLowerCase(),
    );
    if (config.apiToken && allowedHosts.length === 0) {
      throw new Error('Linux remote-agent apiToken requires allowedHosts');
    }
    if (
      allowedHosts.length > 0 &&
      !allowedHosts.includes(parsed.hostname.toLowerCase())
    ) {
      throw new Error('Linux remote-agent host is not allowed');
    }
    const url = parsed.toString();
    const requestConfig: AxiosRequestConfig = {
      url,
      method,
      data,
      timeout: config.timeoutMs ?? 30000,
      maxRedirects: config.apiToken ? 0 : undefined,
      headers: {
        ...(config.apiToken
          ? { Authorization: `Bearer ${config.apiToken}` }
          : {}),
      },
      ...(this.tlsOptions?.axiosConfig(url, config.tls, 'Linux remote-agent') ??
        {}),
    };
    const response = await lastValueFrom(
      this.httpService.request(requestConfig),
    );
    return response.data;
  }

  private execSsh(
    config: LinuxConnectorConfig,
    command: string,
  ): Promise<string> {
    return this.execSshWithInput(config, command);
  }

  private execSshWithInput(
    config: LinuxConnectorConfig,
    command: string,
    input?: string,
  ): Promise<string> {
    if (!config.host || !config.username) {
      return Promise.reject(new Error('Missing Linux SSH host or username'));
    }
    if (config.sudoMode !== 'passwordless') {
      return Promise.reject(
        new Error('Linux ssh-sudo requires sudoMode=passwordless'),
      );
    }
    if (!config.hostFingerprint) {
      return Promise.reject(
        new Error('Linux ssh-sudo requires hostFingerprint'),
      );
    }

    const connectConfig: ConnectConfig = {
      host: config.host,
      port: config.port ?? 22,
      username: config.username,
      readyTimeout: config.timeoutMs ?? 30000,
      hostHash: 'sha256',
      hostVerifier: (hashedKey: string) =>
        this.normalizeFingerprint(hashedKey) ===
        this.normalizeFingerprint(config.hostFingerprint ?? ''),
      ...(config.privateKey ? { privateKey: config.privateKey } : {}),
      ...(config.password ? { password: config.password } : {}),
    };

    return new Promise((resolve, reject) => {
      const client = new Client();
      let stdout = '';
      let stderr = '';
      client
        .on('ready', () => {
          client.exec(command, (error, stream) => {
            if (error) {
              client.end();
              reject(error);
              return;
            }
            stream
              .on('close', (code: number | null) => {
                client.end();
                if (code && code !== 0) {
                  reject(
                    new Error(
                      `SSH command failed with code ${code}: ${stderr.trim()}`,
                    ),
                  );
                  return;
                }
                resolve(stdout);
              })
              .on('data', (chunk: Buffer) => {
                stdout += chunk.toString('utf8');
              })
              .stderr.on('data', (chunk: Buffer) => {
                stderr += chunk.toString('utf8');
              });
            if (input !== undefined) {
              stream.write(input);
              stream.end();
            }
          });
        })
        .on('error', reject)
        .connect(connectConfig);
    });
  }

  private normalizeFingerprint(value: string): string {
    return value
      .trim()
      .replace(/^SHA256:/i, '')
      .replace(/=+$/g, '');
  }

  private login(
    data: LinuxUserData,
    params: Record<string, unknown>,
    config: LinuxConnectorConfig,
  ): string {
    const value =
      this.firstString(
        data.login,
        data.managedLogin,
        data.username,
        params['login'],
        params['id'],
      ) ?? this.firstString(data.email);
    if (!value) {
      throw new Error('Missing login for Linux operation');
    }
    const login = `${config.loginPrefix ?? ''}${value}`.trim();
    if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(login)) {
      throw new Error('Invalid Linux login');
    }
    return login;
  }

  private password(data: LinuxUserData, required: boolean): string {
    const value = this.firstString(data.newValue, data.password);
    if (!value && required) {
      throw new Error('Missing password for Linux operation');
    }
    return value ?? '';
  }

  private groups(config: LinuxConnectorConfig, data: LinuxUserData): string[] {
    const payloadGroups = Array.isArray(data.groups)
      ? data.groups.filter(
          (group): group is string => typeof group === 'string',
        )
      : [];
    return [...(config.defaultGroups ?? []), ...payloadGroups]
      .filter(
        (group): group is string =>
          typeof group === 'string' && group.trim().length > 0,
      )
      .map((group) => {
        const value = group.trim();
        if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(value)) {
          throw new Error('Invalid Linux group');
        }
        return value;
      });
  }

  private firstString(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return undefined;
  }

  private arg(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }
}
