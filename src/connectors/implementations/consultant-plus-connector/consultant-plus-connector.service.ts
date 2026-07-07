import { Injectable, Logger, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import {
  Connector,
  ConnectorCapabilities,
  ConnectorOperationCapability,
  ConnectorPayload,
  ConnectorResult,
} from '../../connector.interface';
import {
  AVANPOST_OPERATION_VALUES,
  READ_OPERATIONS,
  WRITE_OPERATIONS,
} from '../../../inbound/webhooks/avanpost-operation.enum';
import {
  TlsConnectionConfig,
  TlsOptionsFactory,
} from '../../../security/tls-options.factory';

export interface ConsultantPlusConfig {
  baseUrl: string;
  apiBaseUrl?: string;
  allowedHosts?: string[];
  login?: string;
  loginEnv?: string;
  password?: string;
  passwordEnv?: string;
  timeout?: number;
  authPollAttempts?: number;
  protectedOperatorLogin?: string;
  managedLoginPrefix?: string;
  userCreatePath?: string;
  userCreateMethod?: string;
  userCreateContentType?: 'json' | 'form';
  userCreatePayload?: Record<string, unknown>;
  userUpdatePath?: string;
  userUpdateMethod?: string;
  userUpdateContentType?: 'json' | 'form';
  userUpdatePayload?: Record<string, unknown>;
  userChangePasswordPath?: string;
  userChangePasswordMethod?: string;
  userChangePasswordContentType?: 'json' | 'form';
  userChangePasswordPayload?: Record<string, unknown>;
  userBlockPath?: string;
  userBlockMethod?: string;
  userBlockContentType?: 'json' | 'form';
  userBlockPayload?: Record<string, unknown>;
  userDeletePath?: string;
  userDeleteMethod?: string;
  userDeleteContentType?: 'json' | 'form';
  userDeletePayload?: Record<string, unknown>;
  tls?: TlsConnectionConfig;
}

interface ConsultantPlusAuthStatus {
  pid?: string;
  authStatus?: 'started' | 'successful' | 'redirect' | 'missing' | 'fault';
  returnUrl?: string;
  newCsrfToken?: string;
  error?: {
    code?: string;
    text?: string;
    displayType?: string;
    data?: unknown;
  };
}

interface ConsultantPlusSchema {
  objectClasses: Array<{
    name: string;
    attributes: Array<{
      name: string;
      type: string;
      required: boolean;
      multiValued: boolean;
    }>;
  }>;
  notes: string[];
  observedEndpoints: Array<{
    method: string;
    path: string;
    purpose: string;
  }>;
}

interface ConsultantPlusSession {
  csrf: string;
  cookies: string;
  authenticated: boolean;
}

type CookieJar = Map<string, string>;
type ConsultantPlusContentType = 'json' | 'form';

const CONSULTANT_CONFIGURED_WRITE_OPERATIONS = [
  'user.create',
  'user.update',
  'user.delete',
  'user.disable',
  'user.lock',
  'user.changePassword',
] as const;

const CONSULTANT_PARTIAL_OPERATIONS: Record<string, string> = {
  'schema.get':
    'Returns locally documented login/session surface, not a ConsultantPlus user-management API schema.',
  'system.test':
    'Checks login.consultant.ru reachability and optional operator login only.',
  'user.create':
    'Executes only an explicitly configured create endpoint discovered outside the connector.',
  'user.update':
    'Executes only an explicitly configured update endpoint discovered outside the connector.',
  'user.delete':
    'Executes only an explicitly configured delete endpoint discovered outside the connector.',
  'user.disable':
    'Executes only an explicitly configured block endpoint discovered outside the connector.',
  'user.lock':
    'Executes only an explicitly configured block endpoint discovered outside the connector.',
  'user.changePassword':
    'Executes only an explicitly configured ConsultantPlus password reset endpoint; the generated password is delivered by ConsultantPlus email and is not known to idmMw.',
};

const CONSULTANT_UNSUPPORTED_REASON =
  'ConsultantPlus user-management surface is limited to explicitly configured create/update/password-reset/block/delete cloud admin endpoints; read/search/enable/unlock/group/sync operations remain unsupported.';

const CONSULTANT_UNSUPPORTED_OPERATIONS: Record<string, string> =
  Object.fromEntries(
    AVANPOST_OPERATION_VALUES.filter(
      (operation) =>
        !['schema.get', 'system.test'].includes(operation) &&
        !CONSULTANT_CONFIGURED_WRITE_OPERATIONS.includes(
          operation as (typeof CONSULTANT_CONFIGURED_WRITE_OPERATIONS)[number],
        ),
    ).map((operation) => [operation, CONSULTANT_UNSUPPORTED_REASON]),
  );

const TOKEN_LIKE =
  /(?=[A-Za-z0-9_-]{24,})(?=[A-Za-z0-9_-]*[a-z0-9])[A-Za-z0-9_-]+/g;
const DEFAULT_CONSULTANT_ALLOWED_HOSTS = [
  'login.consultant.ru',
  'cloud.consultant.ru',
];
const PASSWORD_FIELD_KEYS = new Set(['password', 'pwd', 'newValue']);
const PASSWORD_FIELD_PATTERN = /^(password|pwd|newValue)$/i;

@Injectable()
export class ConsultantPlusConnectorService implements Connector {
  readonly name = 'consultant-plus';
  private readonly logger = new Logger(ConsultantPlusConnectorService.name);

  constructor(
    private readonly httpService: HttpService,
    @Optional() private readonly tlsOptions?: TlsOptionsFactory,
  ) {}

  getCapabilities(): ConnectorCapabilities {
    const operationStatus = Object.fromEntries(
      AVANPOST_OPERATION_VALUES.map((operation) => {
        const unsupportedReason = CONSULTANT_UNSUPPORTED_OPERATIONS[operation];
        const partialReason = CONSULTANT_PARTIAL_OPERATIONS[operation];
        const capability: ConnectorOperationCapability = unsupportedReason
          ? { status: 'unsupported', reason: unsupportedReason }
          : partialReason
            ? { status: 'partial', reason: partialReason }
            : { status: 'implemented' };
        return [operation, capability];
      }),
    ) as Record<string, ConnectorOperationCapability>;

    return {
      operations: [...AVANPOST_OPERATION_VALUES],
      readOperations: [...READ_OPERATIONS],
      writeOperations: [...WRITE_OPERATIONS],
      capabilities: {
        supportsRead: false,
        supportsWrite: true,
        supportsSync: false,
        supportsIncrementalSync: false,
        supportsSchema: true,
      },
      operationStatus,
      partialOperations: CONSULTANT_PARTIAL_OPERATIONS,
    };
  }

  async execute(payload: ConnectorPayload): Promise<ConnectorResult> {
    const rawConfig = payload.payload['config'] as
      | ConsultantPlusConfig
      | undefined;
    const config = rawConfig ? this.resolveConfig(rawConfig) : undefined;
    if (!config?.baseUrl) {
      return {
        success: false,
        error: 'Missing ConsultantPlus config (baseUrl)',
      };
    }

    const configError = this.validateConfig(config);
    if (configError) {
      return { success: false, error: configError };
    }

    if (payload.operation === 'schema.get') {
      return { success: true, data: this.localSchema() };
    }

    if (payload.operation === 'system.test') {
      const result = await this.testConnection(
        config as unknown as Record<string, unknown>,
      );
      return result.success
        ? { success: true, data: { message: result.message } }
        : { success: false, error: result.message };
    }

    if (payload.operation === 'user.create') {
      return this.createUser(payload, config);
    }

    if (payload.operation === 'user.update') {
      return this.updateUser(payload, config);
    }

    if (payload.operation === 'user.changePassword') {
      return this.changePassword(payload, config);
    }

    if (payload.operation === 'user.delete') {
      return this.deleteUser(payload, config);
    }

    if (
      payload.operation === 'user.disable' ||
      payload.operation === 'user.lock'
    ) {
      return this.blockUser(payload, config);
    }

    const unsupportedReason =
      CONSULTANT_UNSUPPORTED_OPERATIONS[payload.operation] ??
      CONSULTANT_UNSUPPORTED_REASON;
    return {
      success: false,
      error: `Unsupported ConsultantPlus operation: ${payload.operation}. ${unsupportedReason}`,
    };
  }

  async testConnection(
    config: Record<string, unknown>,
  ): Promise<{ success: boolean; message: string }> {
    const cfg = this.resolveConfig(config as unknown as ConsultantPlusConfig);
    if (!cfg.baseUrl) {
      return { success: false, message: 'Missing baseUrl in config' };
    }
    const configError = this.validateConfig(cfg);
    if (configError) {
      return { success: false, message: configError };
    }

    try {
      const session = await this.authenticate(cfg);
      if (!session.csrf) {
        return {
          success: false,
          message:
            'ConsultantPlus login page reachable but CSRF token not found',
        };
      }

      if (!cfg.login && !cfg.password) {
        return {
          success: true,
          message: 'ConsultantPlus login page reachable',
        };
      }
      if (!cfg.login || !cfg.password) {
        return {
          success: false,
          message: 'Missing ConsultantPlus config (login or password)',
        };
      }
      if (session.authenticated) {
        return {
          success: true,
          message: 'ConsultantPlus operator login succeeded',
        };
      }

      return {
        success: false,
        message: 'ConsultantPlus login failed: fault',
      };
    } catch (error: unknown) {
      const msg = this.sanitizeError(error, cfg);
      if (
        msg ===
          'ConsultantPlus login page reachable but CSRF token not found' ||
        msg === 'Missing ConsultantPlus config (login or password)' ||
        msg.startsWith('ConsultantPlus login failed:')
      ) {
        return {
          success: false,
          message: msg,
        };
      }
      this.logger.error(`ConsultantPlus connection failed: ${msg}`);
      return {
        success: false,
        message: `ConsultantPlus connection failed: ${msg}`,
      };
    }
  }

  getSchema(): Promise<ConnectorResult> {
    return Promise.resolve({ success: true, data: this.localSchema() });
  }

  sync(): Promise<ConnectorResult> {
    return Promise.resolve({
      success: false,
      error: `Unsupported ConsultantPlus operation: sync.full. ${CONSULTANT_UNSUPPORTED_REASON}`,
    });
  }

  private async createUser(
    payload: ConnectorPayload,
    config: ConsultantPlusConfig,
  ): Promise<ConnectorResult> {
    if (!config.userCreatePath) {
      return {
        success: false,
        error: 'Missing ConsultantPlus config (userCreatePath)',
      };
    }

    const data = this.recordPayload(payload, 'data');
    const values = this.userValues(data, config);
    const validationError = this.validateManagedUserOperation(
      'user.create',
      values,
      config,
      data,
    );
    if (validationError) {
      return { success: false, error: validationError };
    }

    const passwordlessValues = this.withoutPasswordValues(values);
    const result = await this.callConfiguredUserEndpoint({
      operation: 'user.create',
      config,
      path: config.userCreatePath,
      missingPathName: 'userCreatePath',
      method: config.userCreateMethod ?? 'POST',
      contentType: config.userCreateContentType ?? 'json',
      payloadTemplate: config.userCreatePayload,
      fallbackBody: this.defaultCreatePayload(passwordlessValues),
      values: passwordlessValues,
    });
    return this.withEmailPasswordDelivery(result, passwordlessValues, 'create');
  }

  private async updateUser(
    payload: ConnectorPayload,
    config: ConsultantPlusConfig,
  ): Promise<ConnectorResult> {
    const data = this.recordPayload(payload, 'data');
    const params = this.recordPayload(payload, 'params');
    const values = this.userValues({ ...params, ...data }, config);
    const validationError = this.validateManagedUserOperation(
      'user.update',
      values,
      config,
      params,
      data,
    );
    if (validationError) {
      return { success: false, error: validationError };
    }
    const passwordlessValues = this.withoutPasswordValues(values);

    return this.callConfiguredUserEndpoint({
      operation: 'user.update',
      config,
      path: config.userUpdatePath,
      missingPathName: 'userUpdatePath',
      method: config.userUpdateMethod ?? 'POST',
      contentType: config.userUpdateContentType ?? 'json',
      payloadTemplate: config.userUpdatePayload,
      fallbackBody: this.defaultManagedCloudUserPayload(passwordlessValues),
      values: passwordlessValues,
    });
  }

  private async changePassword(
    payload: ConnectorPayload,
    config: ConsultantPlusConfig,
  ): Promise<ConnectorResult> {
    const data = this.recordPayload(payload, 'data');
    const params = this.recordPayload(payload, 'params');
    const values = this.userValues({ ...params, ...data }, config);
    const validationError = this.validateManagedUserOperation(
      'user.changePassword',
      values,
      config,
      params,
      data,
    );
    if (validationError) {
      return { success: false, error: validationError };
    }
    const passwordlessValues = this.withoutPasswordValues(values);

    const result = await this.callConfiguredUserEndpoint({
      operation: 'user.changePassword',
      config,
      path: config.userChangePasswordPath,
      missingPathName: 'userChangePasswordPath',
      method: config.userChangePasswordMethod ?? 'POST',
      contentType: config.userChangePasswordContentType ?? 'json',
      payloadTemplate: config.userChangePasswordPayload,
      fallbackBody: this.defaultManagedCloudUserPayload(passwordlessValues),
      values: passwordlessValues,
    });
    return this.withEmailPasswordDelivery(result, passwordlessValues, 'reset');
  }

  private async blockUser(
    payload: ConnectorPayload,
    config: ConsultantPlusConfig,
  ): Promise<ConnectorResult> {
    const data = this.recordPayload(payload, 'data');
    const params = this.recordPayload(payload, 'params');
    const values = this.userValues({ ...params, ...data }, config);
    const validationError = this.validateManagedUserOperation(
      payload.operation,
      values,
      config,
      params,
      data,
    );
    if (validationError) {
      return { success: false, error: validationError };
    }
    const passwordlessValues = this.withoutPasswordValues(values);

    return this.callConfiguredUserEndpoint({
      operation: payload.operation,
      config,
      path: config.userBlockPath,
      missingPathName: 'userBlockPath',
      method: config.userBlockMethod ?? 'POST',
      contentType: config.userBlockContentType ?? 'json',
      payloadTemplate: config.userBlockPayload,
      fallbackBody: this.defaultManagedCloudUserPayload(passwordlessValues),
      values: passwordlessValues,
    });
  }

  private async deleteUser(
    payload: ConnectorPayload,
    config: ConsultantPlusConfig,
  ): Promise<ConnectorResult> {
    const data = this.recordPayload(payload, 'data');
    const params = this.recordPayload(payload, 'params');
    const values = this.userValues({ ...params, ...data }, config);
    const validationError = this.validateManagedUserOperation(
      'user.delete',
      values,
      config,
      params,
      data,
    );
    if (validationError) {
      return { success: false, error: validationError };
    }
    const passwordlessValues = this.withoutPasswordValues(values);

    return this.callConfiguredUserEndpoint({
      operation: 'user.delete',
      config,
      path: config.userDeletePath,
      missingPathName: 'userDeletePath',
      method: config.userDeleteMethod ?? 'POST',
      contentType: config.userDeleteContentType ?? 'json',
      payloadTemplate: config.userDeletePayload,
      fallbackBody: this.defaultDeletePayload(passwordlessValues),
      values: passwordlessValues,
    });
  }

  private async callConfiguredUserEndpoint(options: {
    operation: string;
    config: ConsultantPlusConfig;
    path: string | undefined;
    missingPathName: string;
    method: string;
    contentType: ConsultantPlusContentType;
    payloadTemplate: Record<string, unknown> | undefined;
    fallbackBody: Record<string, unknown>;
    values: Record<string, unknown>;
  }): Promise<ConnectorResult> {
    if (!options.path) {
      return {
        success: false,
        error: `Missing ConsultantPlus config (${options.missingPathName})`,
      };
    }
    if (this.templateReferencesPassword(options.payloadTemplate)) {
      return {
        success: false,
        error:
          'ConsultantPlus does not accept caller-provided password fields; password is generated and delivered by email',
      };
    }

    let path: string;
    try {
      path = this.renderPathTemplate(options.path, options.values);
    } catch (error: unknown) {
      return {
        success: false,
        error: this.sanitizeError(error, options.config),
      };
    }

    const body = this.renderPayloadTemplate(
      options.payloadTemplate,
      options.values,
      options.fallbackBody,
    );

    return this.callConfiguredEndpoint({
      operation: options.operation,
      config: options.config,
      path,
      method: options.method,
      contentType: options.contentType,
      body,
    });
  }

  private async callConfiguredEndpoint(options: {
    operation: string;
    config: ConsultantPlusConfig;
    path: string;
    method: string;
    contentType: ConsultantPlusContentType;
    body: Record<string, unknown>;
  }): Promise<ConnectorResult> {
    const method = options.method.toUpperCase();
    const requestBody = this.requestBody(options.body, options.contentType);
    try {
      const session = await this.authenticate(options.config);
      if (!session.authenticated) {
        return {
          success: false,
          error: `ConsultantPlus operator login is required for ${options.operation}`,
        };
      }

      const response = await lastValueFrom(
        this.httpService.request<unknown>({
          url: this.apiUrl(options.config, options.path),
          method,
          data: method === 'GET' ? undefined : requestBody,
          params: method === 'GET' ? options.body : undefined,
          headers: {
            Accept:
              'application/json, text/xml, application/xml, text/plain, */*',
            'Content-Type': this.contentTypeHeader(options.contentType),
            Cookie: session.cookies,
            'X-CSRF-Token': session.csrf,
            'X-Requested-With': 'XMLHttpRequest',
          },
          timeout: options.config.timeout ?? 15000,
          validateStatus: () => true,
          ...this.axiosTlsConfig(options.config),
        }),
      );

      if ((response.status ?? 0) >= 200 && (response.status ?? 0) < 300) {
        if (this.responseHasApplicationError(response.data)) {
          return {
            success: false,
            error: `ConsultantPlus ${options.operation} failed with application error: ${this.sanitizeError(
              response.data,
              options.config,
            )}`,
          };
        }
        return {
          success: true,
          data: {
            status: response.status,
          },
        };
      }

      return {
        success: false,
        error: `ConsultantPlus ${options.operation} failed with HTTP ${response.status}: ${this.sanitizeError(response.data, options.config)}`,
      };
    } catch (error: unknown) {
      return {
        success: false,
        error: `ConsultantPlus ${options.operation} failed: ${this.sanitizeError(
          error,
          options.config,
        )}`,
      };
    }
  }

  private async authenticate(
    config: ConsultantPlusConfig,
  ): Promise<ConsultantPlusSession> {
    const jar: CookieJar = new Map();
    const loginPage = await this.getLoginPage(config);
    this.addCookies(jar, loginPage.headers?.['set-cookie']);
    const csrf = this.extractCsrf(loginPage.data);
    if (!csrf) {
      throw new Error(
        'ConsultantPlus login page reachable but CSRF token not found',
      );
    }

    if (!config.login && !config.password) {
      return {
        csrf,
        cookies: this.cookieHeaderFromJar(jar),
        authenticated: false,
      };
    }
    if (!config.login || !config.password) {
      throw new Error('Missing ConsultantPlus config (login or password)');
    }

    const initialStatus = await this.startLogin(
      config,
      csrf,
      this.cookieHeaderFromJar(jar),
      jar,
    );
    const finalStatus = await this.resolveAuthStatus(
      config,
      initialStatus,
      jar,
    );

    if (finalStatus.authStatus === 'successful') {
      return {
        csrf: finalStatus.newCsrfToken ?? csrf,
        cookies: this.cookieHeaderFromJar(jar),
        authenticated: true,
      };
    }
    if (finalStatus.authStatus === 'redirect' && finalStatus.returnUrl) {
      await this.followAuthReturnUrl(config, finalStatus.returnUrl, jar);
      return {
        csrf: finalStatus.newCsrfToken ?? csrf,
        cookies: this.cookieHeaderFromJar(jar),
        authenticated: true,
      };
    }

    const code = finalStatus.error?.code ?? finalStatus.authStatus ?? 'fault';
    throw new Error(
      `ConsultantPlus login failed: ${this.sanitizeError(code, config)}`,
    );
  }

  private async getLoginPage(
    config: ConsultantPlusConfig,
  ): Promise<AxiosResponse<string>> {
    return lastValueFrom(
      this.httpService.request<string>({
        url: this.url(config, '/'),
        method: 'GET',
        responseType: 'text',
        timeout: config.timeout ?? 15000,
        ...this.axiosTlsConfig(config),
      }),
    );
  }

  private async startLogin(
    config: ConsultantPlusConfig,
    csrf: string,
    cookies: string,
    jar: CookieJar,
  ): Promise<ConsultantPlusAuthStatus> {
    const form = new FormData();
    form.append('client_csrf', csrf);
    form.append('LoginForm[login]', config.login ?? '');
    form.append('LoginForm[password]', config.password ?? '');
    form.append('LoginForm[rememberMe]', '1');

    const response = await lastValueFrom(
      this.httpService.request<ConsultantPlusAuthStatus>({
        url: this.url(config, '/login/'),
        method: 'POST',
        data: form,
        headers: {
          Cookie: cookies,
          'X-CSRF-Token': csrf,
          'X-Requested-With': 'XMLHttpRequest',
        },
        timeout: config.timeout ?? 15000,
        ...this.axiosTlsConfig(config),
      }),
    );
    this.addCookies(jar, response.headers?.['set-cookie']);
    return response.data;
  }

  private async resolveAuthStatus(
    config: ConsultantPlusConfig,
    initialStatus: ConsultantPlusAuthStatus,
    jar: CookieJar,
  ): Promise<ConsultantPlusAuthStatus> {
    if (initialStatus.authStatus !== 'started' || !initialStatus.pid) {
      return initialStatus;
    }

    const attempts = Math.max(1, config.authPollAttempts ?? 12);
    let current = initialStatus;
    for (let i = 0; i < attempts; i += 1) {
      const response = await lastValueFrom(
        this.httpService.request<unknown>({
          url: this.url(
            config,
            `/auth/?pid=${encodeURIComponent(initialStatus.pid)}`,
          ),
          method: 'GET',
          headers: { Cookie: this.cookieHeaderFromJar(jar) },
          timeout: config.timeout ?? 15000,
          maxRedirects: 0,
          validateStatus: (status) => status < 400,
          ...this.axiosTlsConfig(config),
        }),
      );
      this.addCookies(jar, response.headers?.['set-cookie']);
      current = this.authStatusFromResponse(response);
      if (current.authStatus !== 'started') {
        return current;
      }
    }
    return current;
  }

  private async followAuthReturnUrl(
    config: ConsultantPlusConfig,
    returnUrl: string,
    jar: CookieJar,
  ): Promise<void> {
    const url = this.allowedAbsoluteUrl(config, returnUrl, config.baseUrl);
    const response = await lastValueFrom(
      this.httpService.request<unknown>({
        url,
        method: 'GET',
        headers: { Cookie: this.cookieHeaderFromJar(jar) },
        timeout: config.timeout ?? 15000,
        validateStatus: (status) => status < 400,
        ...this.axiosTlsConfig(config),
      }),
    );
    this.addCookies(jar, response.headers?.['set-cookie']);
  }

  private authStatusFromResponse(
    response: AxiosResponse<unknown>,
  ): ConsultantPlusAuthStatus {
    const location = response.headers?.['location'] as unknown;
    if (response.status && response.status >= 300 && response.status < 400) {
      const returnUrl = Array.isArray(location)
        ? this.stringValue(location[0])
        : this.stringValue(location);
      if (!returnUrl) {
        return {
          authStatus: 'fault',
          error: { code: 'MISSING_AUTH_REDIRECT_LOCATION' },
        };
      }
      return {
        authStatus: 'redirect',
        returnUrl,
      };
    }
    if (this.isAuthStatus(response.data)) {
      return response.data;
    }
    if (typeof response.data === 'string') {
      try {
        const parsed: unknown = JSON.parse(response.data);
        if (this.isAuthStatus(parsed)) {
          return parsed;
        }
      } catch {
        if (
          /WRONG_PASSWORD|authStatus["']?\s*:\s*["']?fault/i.test(response.data)
        ) {
          return { authStatus: 'fault', error: { code: 'WRONG_PASSWORD' } };
        }
      }
    }
    return {
      authStatus: 'fault',
      error: { code: 'UNEXPECTED_AUTH_RESPONSE' },
    };
  }

  private localSchema(): ConsultantPlusSchema {
    return {
      objectClasses: [
        {
          name: 'user',
          attributes: [
            {
              name: 'username',
              type: 'string',
              required: true,
              multiValued: false,
            },
            {
              name: 'email',
              type: 'string',
              required: true,
              multiValued: false,
            },
            {
              name: 'lastName',
              type: 'string',
              required: false,
              multiValued: false,
            },
            {
              name: 'firstName',
              type: 'string',
              required: false,
              multiValued: false,
            },
            {
              name: 'middleName',
              type: 'string',
              required: false,
              multiValued: false,
            },
            {
              name: 'pureLogin',
              type: 'string',
              required: false,
              multiValued: false,
            },
            {
              name: 'managedLogin',
              type: 'string',
              required: false,
              multiValued: false,
            },
          ],
        },
      ],
      notes: [
        'ConsultantPlus user create, update, password-reset, block and delete operations require explicitly configured cloud admin endpoint paths.',
        'Authenticated cloud admin surface observed on 2026-07-07: GET admusrlist uses query parameters; POST admadd, admupd, admdismiss and admdel use https://cloud.consultant.ru/cloud/cgi/online.cgi? with req/op/rnd in form body.',
        'Create uses pureLogin; update/password-reset and block/delete use managedLogin in the <operator>#<pureLogin> format for the checked tenant.',
        'ConsultantPlus generates user passwords and delivers them by email; idmMw does not know or store managed-user passwords.',
        'Observed public surface is login/session oriented: CSRF-protected async login, auth polling, user-info and agreement check.',
        'Read/search/enable/unlock/group/sync operations are intentionally unsupported.',
        'Do not automate browser DOM flows as a production idmMw connector without a separate design decision.',
      ],
      observedEndpoints: [
        {
          method: 'GET',
          path: '/',
          purpose: 'Login form and CSRF token bootstrap',
        },
        {
          method: 'POST',
          path: '/login/',
          purpose: 'Async login start; returns authStatus and pid',
        },
        {
          method: 'GET',
          path: '/auth/?pid=<pid>',
          purpose: 'Async login status polling',
        },
        {
          method: 'GET',
          path: '/check-agreement/?login=<login>',
          purpose: 'License agreement requirement check',
        },
        {
          method: 'GET',
          path: '/user-info/',
          purpose: 'Current browser session status and CSRF refresh',
        },
        {
          method: 'GET',
          path: 'https://cloud.consultant.ru/cloud/cgi/online.cgi?req=admin&op=admusrlist',
          purpose:
            'Authenticated cloud admin user list used for manual verification only',
        },
        {
          method: 'POST',
          path: 'https://cloud.consultant.ru/cloud/cgi/online.cgi?',
          purpose:
            'Authenticated cloud admin create user form endpoint; body includes req=admin, op=admadd and rnd',
        },
        {
          method: 'POST',
          path: 'https://cloud.consultant.ru/cloud/cgi/online.cgi?',
          purpose:
            'Authenticated cloud admin update user and password reset form endpoint; body includes req=admin, op=admupd, rnd and managed login',
        },
        {
          method: 'POST',
          path: 'https://cloud.consultant.ru/cloud/cgi/online.cgi?',
          purpose:
            'Authenticated cloud admin block/dismiss user form endpoint; body includes req=admin, op=admdismiss and rnd',
        },
        {
          method: 'POST',
          path: 'https://cloud.consultant.ru/cloud/cgi/online.cgi?',
          purpose:
            'Authenticated cloud admin delete user form endpoint; body includes req=admin, op=admdel and rnd',
        },
      ],
    };
  }

  private extractCsrf(html: string): string | undefined {
    return (
      html.match(/name="client_csrf"\s+value="([^"]+)"/)?.[1] ??
      html.match(/name="csrf-token"\s+content="([^"]+)"/)?.[1]
    );
  }

  private validateManagedUserOperation(
    operation: string,
    values: Record<string, unknown>,
    config: ConsultantPlusConfig,
    ...rawPayloads: Array<Record<string, unknown>>
  ): string | undefined {
    if (rawPayloads.some((payload) => this.hasPasswordFields(payload))) {
      return 'ConsultantPlus does not accept caller-provided password fields; password is generated and delivered by email';
    }

    if (this.touchesProtectedOperator(values, config)) {
      return `Refusing to operate on protected ConsultantPlus operator login ${this.protectedOperatorLogin(config)}`;
    }

    const missing = this.missingRequiredValues(operation, values);
    if (missing.length > 0) {
      return `Missing ConsultantPlus ${operation} value(s): ${missing.join(
        ', ',
      )}`;
    }
    return undefined;
  }

  private missingRequiredValues(
    operation: string,
    values: Record<string, unknown>,
  ): string[] {
    if (operation === 'user.create') {
      return ['pureLogin', 'email'].filter(
        (key) => !this.stringValue(values[key]),
      );
    }
    if (operation === 'user.update' || operation === 'user.changePassword') {
      return ['managedLogin', 'email'].filter(
        (key) => !this.stringValue(values[key]),
      );
    }
    if (operation === 'user.delete' || operation === 'user.disable') {
      const hasAnyId = ['managedLogin', 'id', 'userId'].some((key) =>
        this.stringValue(values[key]),
      );
      return hasAnyId ? [] : ['managedLogin'];
    }
    if (operation === 'user.lock') {
      const hasAnyId = ['managedLogin', 'id', 'userId'].some((key) =>
        this.stringValue(values[key]),
      );
      return hasAnyId ? [] : ['managedLogin'];
    }
    return [];
  }

  private hasPasswordFields(value: unknown): boolean {
    if (!value || typeof value !== 'object') {
      return false;
    }
    if (Array.isArray(value)) {
      return value.some((item) => this.hasPasswordFields(item));
    }
    return Object.entries(value as Record<string, unknown>).some(
      ([key, item]) =>
        PASSWORD_FIELD_PATTERN.test(key) || this.hasPasswordFields(item),
    );
  }

  private touchesProtectedOperator(
    values: Record<string, unknown>,
    config: ConsultantPlusConfig,
  ): boolean {
    const protectedLogin = this.protectedOperatorLogin(config);
    return this.protectedTargetCandidates(values).some(
      (value) => value === protectedLogin,
    );
  }

  private protectedTargetCandidates(values: Record<string, unknown>): string[] {
    const candidates = new Set<string>();
    for (const key of [
      'login',
      'username',
      'id',
      'userId',
      'email',
      'pureLogin',
      'loginName',
      'managedLogin',
    ]) {
      const value = this.stringValue(values[key]);
      if (!value) {
        continue;
      }
      candidates.add(value);
      const emailLocalPart = this.emailLocalPart(value);
      if (emailLocalPart) {
        candidates.add(emailLocalPart);
      }
      if (value.includes('#')) {
        const parts = value.split('#').filter(Boolean);
        const suffix = parts.at(-1);
        if (suffix) {
          candidates.add(suffix);
        }
      }
    }
    return [...candidates];
  }

  private protectedOperatorLogin(config: ConsultantPlusConfig): string {
    return config.protectedOperatorLogin ?? '1393020';
  }

  private resolveConfig(config: ConsultantPlusConfig): ConsultantPlusConfig {
    return {
      ...config,
      login: config.login ?? this.envValue(config.loginEnv),
      password: config.password ?? this.envValue(config.passwordEnv),
    };
  }

  private validateConfig(config: ConsultantPlusConfig): string | undefined {
    const baseUrlError = this.validateConfiguredUrl(config, config.baseUrl);
    if (baseUrlError) {
      return baseUrlError;
    }
    if (config.apiBaseUrl) {
      const apiBaseUrlError = this.validateConfiguredUrl(
        config,
        config.apiBaseUrl,
      );
      if (apiBaseUrlError) {
        return apiBaseUrlError;
      }
    }

    for (const [key, value] of Object.entries(config)) {
      if (!key.endsWith('Path') || typeof value !== 'string') {
        continue;
      }
      if (/^https?:\/\//i.test(value)) {
        return `ConsultantPlus endpoint path must be relative: ${key}`;
      }
    }
    return undefined;
  }

  private validateConfiguredUrl(
    config: ConsultantPlusConfig,
    url: string,
  ): string | undefined {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `Invalid ConsultantPlus URL: ${url}`;
    }
    if (parsed.protocol !== 'https:') {
      return `ConsultantPlus URL must use https: ${url}`;
    }
    if (!this.isAllowedHost(config, parsed.hostname)) {
      return `ConsultantPlus host is not allowed: ${parsed.hostname}`;
    }
    return undefined;
  }

  private allowedHosts(config: ConsultantPlusConfig): string[] {
    const configured = config.allowedHosts
      ?.map((host) => host.trim().toLowerCase())
      .filter(Boolean);
    return configured && configured.length > 0
      ? configured
      : DEFAULT_CONSULTANT_ALLOWED_HOSTS;
  }

  private isAllowedHost(config: ConsultantPlusConfig, host: string): boolean {
    return this.allowedHosts(config).includes(host.toLowerCase());
  }

  private envValue(name: string | undefined): string | undefined {
    if (!name) {
      return undefined;
    }
    const value = process.env[name];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private addCookies(
    jar: CookieJar,
    setCookie: string[] | string | undefined,
  ): void {
    const cookies = Array.isArray(setCookie)
      ? setCookie
      : setCookie
        ? [setCookie]
        : [];
    for (const cookie of cookies) {
      const [pair] = cookie.split(';');
      const separator = pair.indexOf('=');
      if (separator <= 0) {
        continue;
      }
      jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  private cookieHeaderFromJar(jar: CookieJar): string {
    return Array.from(jar.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }

  private url(config: ConsultantPlusConfig, path: string): string {
    return `${config.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  private apiUrl(config: ConsultantPlusConfig, path: string): string {
    if (/^https?:\/\//i.test(path)) {
      throw new Error('ConsultantPlus endpoint path must be relative');
    }
    const base = (config.apiBaseUrl ?? config.baseUrl).replace(/\/+$/, '');
    return this.allowedAbsoluteUrl(
      config,
      `${base}/${path.replace(/^\/+/, '')}`,
      base,
    );
  }

  private absoluteUrl(baseUrl: string, pathOrUrl: string): string {
    return new URL(pathOrUrl, baseUrl).toString();
  }

  private allowedAbsoluteUrl(
    config: ConsultantPlusConfig,
    pathOrUrl: string,
    baseUrl: string,
  ): string {
    const url = this.absoluteUrl(baseUrl, pathOrUrl);
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      !this.isAllowedHost(config, parsed.hostname)
    ) {
      throw new Error(`ConsultantPlus host is not allowed: ${parsed.hostname}`);
    }
    return url;
  }

  private recordPayload(
    payload: ConnectorPayload,
    key: 'data' | 'params',
  ): Record<string, unknown> {
    const value = payload.payload[key];
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private userValues(
    data: Record<string, unknown>,
    config: ConsultantPlusConfig,
  ): Record<string, unknown> {
    const email = this.stringValue(data['email']);
    const username =
      this.stringValue(data['username']) ??
      this.stringValue(data['login']) ??
      email;
    const pureLogin =
      this.stringValue(data['pureLogin']) ??
      this.stringValue(data['loginName']) ??
      this.emailLocalPart(username ?? email) ??
      username;
    const login = this.stringValue(data['login']) ?? username;
    const lastName =
      this.stringValue(data['lastName']) ??
      this.stringValue(data['surname']) ??
      this.stringValue(data['familyName']);
    const firstName =
      this.stringValue(data['firstName']) ??
      this.stringValue(data['givenName']);
    const middleName =
      this.stringValue(data['middleName']) ??
      this.stringValue(data['patronymic']);
    const fio =
      this.stringValue(data['fio']) ??
      this.stringValue(data['fullName']) ??
      [firstName, middleName, lastName].filter(Boolean).join(' ');
    const managedLoginPrefix =
      config.managedLoginPrefix ??
      config.login ??
      config.protectedOperatorLogin ??
      this.protectedOperatorLogin(config);
    const managedLogin =
      this.stringValue(data['managedLogin']) ??
      (pureLogin ? `${managedLoginPrefix}#${pureLogin}` : undefined);
    const rnd =
      this.stringValue(data['rnd']) ?? Math.random().toString(36).slice(2);

    return {
      ...data,
      rnd,
      username,
      login,
      email,
      pureLogin,
      loginName: pureLogin,
      managedLoginPrefix,
      managedLogin,
      lastName,
      firstName,
      middleName,
      fio,
      fullName: fio,
    };
  }

  private defaultCreatePayload(
    values: Record<string, unknown>,
  ): Record<string, unknown> {
    return this.removeUndefined(values);
  }

  private defaultCloudUserPayload(
    values: Record<string, unknown>,
  ): Record<string, unknown> {
    return this.removeUndefined({
      login: values['pureLogin'],
      email: values['email'],
      fio: values['fullName'] ?? values['fio'],
    });
  }

  private defaultManagedCloudUserPayload(
    values: Record<string, unknown>,
  ): Record<string, unknown> {
    return this.removeUndefined({
      ...this.defaultCloudUserPayload(values),
      login: values['managedLogin'],
    });
  }

  private withoutPasswordValues(
    values: Record<string, unknown>,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(values).filter(
        ([key]) =>
          !PASSWORD_FIELD_KEYS.has(key) && !PASSWORD_FIELD_PATTERN.test(key),
      ),
    );
  }

  private withEmailPasswordDelivery(
    result: ConnectorResult,
    values: Record<string, unknown>,
    passwordAction: 'create' | 'reset',
  ): ConnectorResult {
    if (!result.success) {
      return result;
    }
    const responseData =
      result.data &&
      typeof result.data === 'object' &&
      !Array.isArray(result.data)
        ? (result.data as Record<string, unknown>)
        : { response: result.data };
    return {
      ...result,
      data: {
        ...responseData,
        managedLogin: values['managedLogin'],
        email: values['email'],
        passwordAction,
        passwordDelivery: 'email',
        passwordKnown: false,
      },
    };
  }

  private defaultDeletePayload(
    values: Record<string, unknown>,
  ): Record<string, unknown> {
    return this.removeUndefined({ logins: values['managedLogin'] });
  }

  private templateReferencesPassword(template: unknown): boolean {
    if (!template) {
      return false;
    }
    if (typeof template === 'string') {
      return /\$\{(password|pwd|newValue)\}/i.test(template);
    }
    if (Array.isArray(template)) {
      return template.some((item) => this.templateReferencesPassword(item));
    }
    if (typeof template === 'object') {
      return Object.entries(template as Record<string, unknown>).some(
        ([key, value]) =>
          PASSWORD_FIELD_PATTERN.test(key) ||
          this.templateReferencesPassword(value),
      );
    }
    return false;
  }

  private renderPayloadTemplate(
    template: Record<string, unknown> | undefined,
    values: Record<string, unknown>,
    fallback: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!template) {
      return this.removeUndefined(fallback);
    }
    const rendered = this.renderTemplateValue(template, values);
    return rendered && typeof rendered === 'object' && !Array.isArray(rendered)
      ? this.removeUndefined(rendered as Record<string, unknown>)
      : {};
  }

  private renderTemplateValue(
    value: unknown,
    values: Record<string, unknown>,
  ): unknown {
    if (typeof value === 'string') {
      const exact = value.match(/^\$\{([A-Za-z0-9_.-]+)\}$/);
      if (exact) {
        return values[exact[1]];
      }
      return value.replace(/\$\{([A-Za-z0-9_.-]+)\}/g, (_, key: string) =>
        this.scalarString(values[key]),
      );
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.renderTemplateValue(item, values));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          this.renderTemplateValue(item, values),
        ]),
      );
    }
    return value;
  }

  private renderPathTemplate(
    path: string,
    values: Record<string, unknown>,
  ): string {
    const missing = new Set<string>();
    const rendered = path.replace(
      /\{([A-Za-z0-9_.-]+)\}/g,
      (_, key: string) => {
        const value = values[key];
        if (value === undefined || value === null || value === '') {
          missing.add(key);
          return '';
        }
        return encodeURIComponent(this.scalarString(value));
      },
    );
    if (missing.size > 0) {
      throw new Error(
        `Missing ConsultantPlus path parameter(s): ${Array.from(missing).join(
          ', ',
        )}`,
      );
    }
    return rendered;
  }

  private removeUndefined(
    value: Record<string, unknown>,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(value).filter(([, item]) => item !== undefined),
    );
  }

  private requestBody(
    body: Record<string, unknown>,
    contentType: ConsultantPlusContentType,
  ): Record<string, unknown> | string {
    if (contentType === 'json') {
      return body;
    }
    return new URLSearchParams(
      Object.entries(body).map(([key, value]) => [
        key,
        this.scalarString(value),
      ]),
    ).toString();
  }

  private contentTypeHeader(contentType: ConsultantPlusContentType): string {
    return contentType === 'form'
      ? 'application/x-www-form-urlencoded; charset=UTF-8'
      : 'application/json';
  }

  private stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private scalarString(value: unknown): string {
    if (value === undefined || value === null) {
      return '';
    }
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      return String(value);
    }
    if (typeof value === 'symbol' || typeof value === 'function') {
      return '';
    }
    return JSON.stringify(value) ?? '';
  }

  private isAuthStatus(value: unknown): value is ConsultantPlusAuthStatus {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const record = value as Record<string, unknown>;
    return (
      typeof record['authStatus'] === 'string' ||
      typeof record['pid'] === 'string' ||
      Boolean(record['error'])
    );
  }

  private responseHasApplicationError(value: unknown): boolean {
    if (value === undefined || value === null) {
      return false;
    }
    if (typeof value === 'string') {
      return /<\s*(err|errdata|error)\b|wrong_account_data|authStatus["']?\s*:\s*["']?fault|\bfault\b/i.test(
        value,
      );
    }
    if (Array.isArray(value)) {
      return value.some((item) => this.responseHasApplicationError(item));
    }
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (record['authStatus'] === 'fault' || record['status'] === 'fault') {
        return true;
      }
      if (record['error'] && record['success'] !== true) {
        return true;
      }
      return Object.values(record).some((item) =>
        this.responseHasApplicationError(item),
      );
    }
    return false;
  }

  private emailLocalPart(value: string | undefined): string | undefined {
    if (!value?.includes('@')) {
      return undefined;
    }
    return value.split('@')[0];
  }

  private axiosTlsConfig(config: ConsultantPlusConfig): AxiosRequestConfig {
    return (
      this.tlsOptions?.axiosConfig(
        config.baseUrl,
        config.tls,
        'ConsultantPlus',
      ) ?? {}
    );
  }

  private sanitizeError(error: unknown, config: ConsultantPlusConfig): string {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : (JSON.stringify(error) ?? String(error));
    const secrets = [
      config.password,
      config.login,
      config.protectedOperatorLogin,
    ].filter((value): value is string => Boolean(value));
    const withoutSecrets = secrets.reduce((current, secret) => {
      return current.split(secret).join('[REDACTED]');
    }, message);
    if (/^[A-Z0-9_.:-]+$/.test(withoutSecrets)) {
      return withoutSecrets;
    }
    return withoutSecrets.replace(TOKEN_LIKE, '[TOKEN]');
  }

  private sanitizeData(value: unknown, config: ConsultantPlusConfig): unknown {
    if (typeof value === 'string') {
      return this.sanitizeError(value, config);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeData(item, config));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          /password|token|cookie|csrf|session|secret/i.test(key)
            ? '[REDACTED]'
            : this.sanitizeData(item, config),
        ]),
      );
    }
    return value;
  }
}
