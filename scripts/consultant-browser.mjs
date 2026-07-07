#!/usr/bin/env node
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mode = process.argv[2] ?? 'discover';
const runId =
  process.env.CONSULTANT_RUN_ID ??
  `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${process.pid}`;
const runSlug =
  (process.env.CONSULTANT_RUN_SLUG ?? runId)
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(-12) || String(process.pid);
const baseUrl =
  process.env.CONSULTANT_BASE_URL ?? 'https://login.consultant.ru';
const apiBaseUrl = process.env.CONSULTANT_API_BASE_URL ?? baseUrl;
const outDir =
  process.env.CONSULTANT_OUT_DIR ??
  path.join(os.tmpdir(), `idmmw-consultant-${mode}-${runId}`);
const reportPath =
  process.env.CONSULTANT_REPORT_PATH ?? path.join(outDir, 'report.json');
const headless = process.env.CONSULTANT_HEADLESS !== 'false';
const loginTraceEnabled =
  process.env.CONSULTANT_LOGIN_TRACE === 'true' ||
  Boolean(process.env.CONSULTANT_TRACE_LEVEL);
const traceLevel =
  process.env.CONSULTANT_TRACE_LEVEL === 'verbose' ? 'verbose' : 'basic';
const timeoutMs = Number(process.env.CONSULTANT_TIMEOUT_MS ?? '30000');
const operatorLogin = process.env.CONSULTANT_LOGIN ?? '';
const operatorPassword = process.env.CONSULTANT_PASSWORD ?? '';
const protectedOperatorLogin =
  process.env.CONSULTANT_PROTECTED_OPERATOR_LOGIN ?? '1393020';
const allowedHosts = (
  process.env.CONSULTANT_ALLOWED_HOSTS ??
  'login.consultant.ru,cloud.consultant.ru'
)
  .split(',')
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
const chromeNoSandbox = process.env.CONSULTANT_CHROME_NO_SANDBOX === 'true';
const ignoreHttpsErrors = process.env.CONSULTANT_IGNORE_HTTPS_ERRORS === 'true';
const chromeExecutable =
  process.env.CONSULTANT_CHROME_EXECUTABLE ??
  (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : '');

const targetUser = {
  lastName: process.env.CONSULTANT_TARGET_LAST_NAME ?? 'Ляпин',
  firstName: process.env.CONSULTANT_TARGET_FIRST_NAME ?? 'Игорь',
  middleName: process.env.CONSULTANT_TARGET_MIDDLE_NAME ?? 'Алексеевич',
  email: process.env.CONSULTANT_TARGET_EMAIL ?? 'lyapin@gkm.ru',
};
const targetUsername =
  process.env.CONSULTANT_TARGET_USERNAME ?? targetUser.email;
const targetUserId = process.env.CONSULTANT_TARGET_USER_ID ?? '';
const targetPureLogin =
  process.env.CONSULTANT_TARGET_PURE_LOGIN ??
  (targetUsername.includes('@')
    ? targetUsername.split('@')[0]
    : targetUsername);
const managedLoginPrefix =
  process.env.CONSULTANT_MANAGED_LOGIN_PREFIX ?? operatorLogin;
const targetManagedLogin =
  process.env.CONSULTANT_TARGET_MANAGED_LOGIN ??
  (targetPureLogin && managedLoginPrefix
    ? `${managedLoginPrefix}#${targetPureLogin}`
    : targetPureLogin);
const targetFullName =
  process.env.CONSULTANT_TARGET_FULL_NAME ??
  [targetUser.firstName, targetUser.middleName, targetUser.lastName]
    .filter(Boolean)
    .join(' ');

const tokenLike = /[A-Za-z0-9_-]{24,}/g;
const sensitiveHeader = /cookie|authorization|token|csrf|session|set-cookie/i;
const passwordFieldPattern = /^(password|pwd|newValue)$/i;
const interestingUrl =
  /user|users|account|accounts|person|persons|client|clients|license|access|role|roles|admin|profile|employee|employees|польз|доступ|админ/i;
const cloudAdminEndpoint =
  process.env.CONSULTANT_CLOUD_ADMIN_ENDPOINT ?? '/cloud/cgi/online.cgi?';
const cloudEndpoints = {
  create: process.env.CONSULTANT_USER_CREATE_ENDPOINT ?? cloudAdminEndpoint,
  update: process.env.CONSULTANT_USER_UPDATE_ENDPOINT ?? cloudAdminEndpoint,
  changePassword:
    process.env.CONSULTANT_USER_CHANGE_PASSWORD_ENDPOINT ??
    process.env.CONSULTANT_USER_UPDATE_ENDPOINT ??
    cloudAdminEndpoint,
  block: process.env.CONSULTANT_USER_BLOCK_ENDPOINT ?? cloudAdminEndpoint,
  delete: process.env.CONSULTANT_USER_DELETE_ENDPOINT ?? cloudAdminEndpoint,
};

function requireCredentials() {
  if (!operatorLogin || !operatorPassword) {
    throw new Error(
      'CONSULTANT_LOGIN and CONSULTANT_PASSWORD are required for ConsultantPlus browser discovery',
    );
  }
}

function redact(value, extraSecrets = []) {
  if (value === undefined || value === null) {
    return value;
  }
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [
    operatorPassword,
    operatorLogin,
    protectedOperatorLogin,
    targetManagedLogin,
    ...extraSecrets,
  ].filter(Boolean)) {
    text = text.split(secret).join('[REDACTED]');
  }
  if (targetUser.email) {
    text = text.split(targetUser.email).join('[TARGET_EMAIL]');
  }
  return text.replace(tokenLike, '[TOKEN]');
}

function redactedHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers ?? {}).map(([key, value]) => [
      key,
      sensitiveHeader.test(key) ? '[REDACTED]' : redact(value),
    ]),
  );
}

function maybeParseJson(text) {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function traceStep(report, step) {
  if (!report.loginTrace) {
    return;
  }
  report.loginTrace.steps.push({
    at: new Date().toISOString(),
    ...step,
  });
}

function authFaultEvent(events) {
  return events.find(
    (event) =>
      event.type === 'response' &&
      /"authStatus"\s*:\s*"fault"/.test(String(event.body ?? '')),
  );
}

function authStartedEvent(events) {
  return events.find(
    (event) =>
      event.type === 'response' &&
      /"authStatus"\s*:\s*"started"/.test(String(event.body ?? '')),
  );
}

function stillGuestEvent(events) {
  return events.find(
    (event) =>
      event.type === 'response' &&
      /\/user-info\//.test(String(event.url)) &&
      /"status"\s*:\s*"gst"/.test(String(event.body ?? '')),
  );
}

function cloudFailureEvent(events) {
  return events.find(
    (event) =>
      event.type === 'response' &&
      String(event.url).startsWith(redact(apiBaseUrl)) &&
      Number(event.status ?? 0) >= 400,
  );
}

function postFieldNames(postData) {
  if (!postData) {
    return [];
  }
  const names = new Set();
  for (const match of postData.matchAll(/name="([^"]+)"/g)) {
    names.add(match[1]);
  }
  try {
    for (const key of new URLSearchParams(postData).keys()) {
      names.add(key);
    }
  } catch {
    // Multipart bodies are handled by the regex above.
  }
  return Array.from(names);
}

function summarizeAuthEvents(events) {
  return events
    .filter((event) =>
      /\/login\/|\/auth\/|\/user-info\/|\/check-agreement\//.test(
        String(event.url),
      ),
    )
    .map((event) => ({
      type: event.type,
      method: event.method,
      status: event.status,
      url: event.url,
      resourceType: event.resourceType,
      contentType: event.headers?.['content-type'] ?? null,
      postFields:
        event.type === 'request' ? postFieldNames(event.postData ?? '') : [],
      ...(traceLevel === 'verbose' && event.body ? { body: event.body } : {}),
    }));
}

function classifyAuth({ bodyText, events, agreement, currentUrl }) {
  const combined = `${bodyText} ${JSON.stringify(events)}`;
  const fault = authFaultEvent(events);
  const faultCode =
    maybeParseJson(String(fault?.body ?? ''))?.error?.code ??
    /"code"\s*:\s*"([^"]+)"/.exec(String(fault?.body ?? ''))?.[1] ??
    undefined;
  const wrongPassword =
    /Неверно указаны данные|WRONG_PASSWORD|wrong.password/i.test(combined) ||
    faultCode === 'WRONG_PASSWORD';

  if (wrongPassword) {
    return {
      success: false,
      status: 'fault',
      reason: 'wrong-password',
      error: 'WRONG_PASSWORD',
    };
  }

  if (agreement?.agreementRequired === true) {
    return {
      success: false,
      status: 'blocked',
      reason: 'agreement-required',
      error: 'AGREEMENT_REQUIRED',
    };
  }

  if (/captcha|капч|robot|робот|automated|автомат/i.test(combined)) {
    return {
      success: false,
      status: 'blocked',
      reason: 'captcha-or-antiautomation',
      error: 'CAPTCHA_OR_ANTIAUTOMATION',
    };
  }

  if (!currentUrl.startsWith(baseUrl)) {
    const cloudFailure = cloudFailureEvent(events);
    if (cloudFailure) {
      return {
        success: false,
        status: 'blocked',
        reason: 'cloud-unreachable',
        error: `Cloud HTTP ${cloudFailure.status}`,
      };
    }
    return {
      success: true,
      status: 'authenticated',
      reason: 'redirected',
    };
  }

  if (stillGuestEvent(events)) {
    return {
      success: false,
      status: 'guest',
      reason: 'still-guest',
      error: 'STILL_GUEST',
    };
  }

  if (authStartedEvent(events)) {
    return {
      success: false,
      status: 'timeout',
      reason: 'auth-timeout',
      error: 'AUTH_TIMEOUT',
    };
  }

  return {
    success: false,
    status: 'unknown',
    reason: 'unknown',
    error: 'AUTH_UNKNOWN',
  };
}

function writeReport(report) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  fs.chmodSync(reportPath, 0o600);
}

function writeSensitiveJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  fs.chmodSync(filePath, 0o600);
}

function assertAllowedAbsoluteUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error(`ConsultantPlus URL must use https: ${redact(url)}`);
  }
  if (!allowedHosts.includes(parsed.hostname.toLowerCase())) {
    throw new Error(
      `ConsultantPlus host is not allowed: ${redact(parsed.hostname)}`,
    );
  }
  return url;
}

function absoluteUrl(urlOrPath, urlBase = baseUrl) {
  return assertAllowedAbsoluteUrl(new URL(urlOrPath, urlBase).toString());
}

function assertConfiguredOrigins() {
  assertAllowedAbsoluteUrl(baseUrl);
  assertAllowedAbsoluteUrl(apiBaseUrl);
}

function redactedTargetUser(overrides = {}) {
  const values = targetValues(overrides);
  return {
    lastName: values.lastName,
    firstName: values.firstName,
    middleName: values.middleName,
    email: redact(values.email),
    username: redact(values.username),
    pureLogin: redact(values.pureLogin),
    managedLogin: redact(values.managedLogin),
    id: values.id ? redact(values.id) : undefined,
  };
}

function targetValues(overrides = {}) {
  const user = {
    ...targetUser,
    ...(overrides.user ?? {}),
    lastName:
      overrides.lastName ?? overrides.user?.lastName ?? targetUser.lastName,
    firstName:
      overrides.firstName ?? overrides.user?.firstName ?? targetUser.firstName,
    middleName:
      overrides.middleName ??
      overrides.user?.middleName ??
      targetUser.middleName,
    email: overrides.email ?? overrides.user?.email ?? targetUser.email,
  };
  const username = overrides.username ?? targetUsername ?? user.email;
  const pureLogin =
    overrides.pureLogin ??
    overrides.loginName ??
    (username.includes('@') ? username.split('@')[0] : username);
  const prefix = overrides.managedLoginPrefix ?? managedLoginPrefix;
  const managedLogin =
    overrides.managedLogin ??
    (pureLogin && prefix ? `${prefix}#${pureLogin}` : pureLogin);
  const fullName =
    overrides.fullName ??
    overrides.fio ??
    [user.firstName, user.middleName, user.lastName].filter(Boolean).join(' ');
  return {
    ...user,
    username,
    login: overrides.login ?? username,
    pureLogin,
    loginName: pureLogin,
    managedLoginPrefix: prefix,
    managedLogin,
    fio: fullName,
    fullName,
    id: overrides.id ?? targetUserId,
    userId: overrides.userId ?? targetUserId,
  };
}

function assertTargetNotProtected(values) {
  const protectedTargetValues = new Set([
    values.username,
    values.login,
    values.email,
    values.id,
    values.userId,
    values.pureLogin,
    values.loginName,
    values.managedLogin,
  ]);
  for (const value of [...protectedTargetValues]) {
    const text = String(value ?? '');
    if (text.includes('@')) {
      protectedTargetValues.add(text.split('@')[0]);
    }
    if (text.includes('#')) {
      const parts = text.split('#').filter(Boolean);
      const suffix = parts.at(-1);
      if (suffix) {
        protectedTargetValues.add(suffix);
      }
    }
  }
  if (
    [...protectedTargetValues].some(
      (value) => String(value ?? '') === protectedOperatorLogin,
    )
  ) {
    throw new Error('Refusing to operate on protected ConsultantPlus operator');
  }
}

function renderTemplate(raw, values) {
  return raw.replace(/\$\{([A-Za-z0-9_.-]+)\}/g, (_, key) => values[key] ?? '');
}

function renderPathTemplate(endpoint, values) {
  const missing = new Set();
  const rendered = endpoint.replace(/\{([A-Za-z0-9_.-]+)\}/g, (_, key) => {
    const value = values[key];
    if (value === undefined || value === null || value === '') {
      missing.add(key);
      return '';
    }
    return encodeURIComponent(String(value));
  });
  if (missing.size > 0) {
    throw new Error(
      `Missing ConsultantPlus endpoint parameter(s): ${Array.from(missing).join(
        ', ',
      )}`,
    );
  }
  return rendered;
}

function htmlText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

async function captureResponseBody(response, extraSecrets = []) {
  const contentType = response.headers()['content-type'] ?? '';
  if (!/json|text|html|xml/i.test(contentType)) {
    return undefined;
  }
  try {
    const body = await response.text();
    return redact(body.slice(0, 3000), extraSecrets);
  } catch {
    return undefined;
  }
}

async function fillLogin(page, credentials = {}) {
  const login = credentials.login ?? operatorLogin;
  const password = credentials.password ?? operatorPassword;
  const loginSelector = 'input[name="LoginForm[login]"], #loginform-login';
  const passwordSelector =
    'input[name="LoginForm[password]"], #loginform-password';
  await page.locator(loginSelector).first().fill(login);
  await page.locator(passwordSelector).first().fill(password);
  const confirmTou = page
    .locator('input[name="confirmTOU"], #loginform-confirmTOU')
    .first();
  if ((await confirmTou.count()) > 0) {
    await confirmTou.check({ force: true }).catch(() => undefined);
  }
  await page
    .locator('#buttonLogin, button[type="submit"], input[type="submit"]')
    .first()
    .click();
}

async function loginFormSnapshot(page) {
  return page.evaluate(() => {
    const form = document.querySelector('form');
    if (!form) {
      return { present: false };
    }
    const attributes = Object.fromEntries(
      Array.from(form.attributes).map((attribute) => [
        attribute.name,
        attribute.name.toLowerCase().includes('csrf')
          ? '[REDACTED]'
          : attribute.value,
      ]),
    );
    const inputs = Array.from(form.querySelectorAll('input')).map((input) => ({
      id: input.id || '',
      name: input.name || '',
      type: input.type || '',
      required: input.required,
      hasValue: Boolean(input.value),
      checked:
        input.type === 'checkbox' || input.type === 'radio'
          ? input.checked
          : undefined,
    }));
    return {
      present: true,
      action: form.getAttribute('action') || '',
      method: form.getAttribute('method') || '',
      attributes,
      inputs,
    };
  });
}

async function checkAgreement(page, report, login = operatorLogin) {
  const endpoint = `/check-agreement/?login=${encodeURIComponent(login)}`;
  const result = {
    attempted: true,
    endpoint: redact(absoluteUrl(endpoint)),
    success: false,
  };
  try {
    const response = await page.request.get(absoluteUrl(endpoint), {
      timeout: timeoutMs,
    });
    const text = await response.text().catch(() => '');
    const data = maybeParseJson(text);
    result.success = response.ok();
    result.status = response.status();
    result.agreementRequired = data?.agreementRequired;
    if (traceLevel === 'verbose') {
      result.response = redact(text.slice(0, 1000));
    }
  } catch (error) {
    result.error = redact(
      error instanceof Error ? error.message : String(error),
    );
  }
  traceStep(report, { phase: 'check-agreement', result });
  return result;
}

async function discoverLinks(page) {
  return page.evaluate(() => {
    const patterns =
      /польз|доступ|админ|управ|кабинет|профил|сотруд|user|access|admin|account|profile|employee|role|license/i;
    return Array.from(
      document.querySelectorAll('a[href], button, [role="button"]'),
    )
      .map((node) => ({
        tag: node.tagName.toLowerCase(),
        text: (node.textContent || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 160),
        href: node instanceof HTMLAnchorElement ? node.href : '',
        id: node.id || '',
        className:
          typeof node.className === 'string'
            ? node.className.slice(0, 160)
            : '',
      }))
      .filter((item) =>
        patterns.test(`${item.text} ${item.href} ${item.id} ${item.className}`),
      )
      .slice(0, 100);
  });
}

async function loginAndCollect() {
  requireCredentials();
  const events = [];
  const browser = await chromium.launch({
    headless,
    ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
    args: [
      ...(chromeNoSandbox ? ['--no-sandbox'] : []),
      '--disable-dev-shm-usage',
    ],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: ignoreHttpsErrors,
    locale: 'ru-RU',
  });
  const page = await context.newPage();

  page.on('request', (request) => {
    const url = request.url();
    if (
      url.startsWith(baseUrl) ||
      url.startsWith(apiBaseUrl) ||
      interestingUrl.test(url)
    ) {
      events.push({
        type: 'request',
        method: request.method(),
        url: redact(url),
        resourceType: request.resourceType(),
        headers: redactedHeaders(request.headers()),
        postData: redact(request.postData() ?? ''),
      });
    }
  });

  page.on('response', async (response) => {
    const url = response.url();
    if (
      url.startsWith(baseUrl) ||
      url.startsWith(apiBaseUrl) ||
      interestingUrl.test(url)
    ) {
      events.push({
        type: 'response',
        status: response.status(),
        url: redact(url),
        headers: redactedHeaders(response.headers()),
        body: await captureResponseBody(response),
      });
    }
  });

  const report = {
    mode,
    runId,
    baseUrl,
    apiBaseUrl,
    outDir,
    startedAt: new Date().toISOString(),
    targetUser: redactedTargetUser(),
    auth: {
      attempted: true,
      success: false,
      status: 'unknown',
    },
    pages: [],
    candidateLinks: [],
    candidateRequests: [],
    ...(loginTraceEnabled
      ? {
          loginTrace: {
            enabled: true,
            level: traceLevel,
            headless,
            chromeNoSandbox,
            ignoreHttpsErrors,
            executablePath: chromeExecutable ? redact(chromeExecutable) : null,
            steps: [],
          },
        }
      : {}),
    createEndpoint: process.env.CONSULTANT_USER_CREATE_ENDPOINT
      ? redact(process.env.CONSULTANT_USER_CREATE_ENDPOINT)
      : null,
    blockEndpoint: process.env.CONSULTANT_USER_BLOCK_ENDPOINT
      ? redact(process.env.CONSULTANT_USER_BLOCK_ENDPOINT)
      : null,
  };

  try {
    await page.goto(baseUrl, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
    report.pages.push({
      url: redact(page.url()),
      title: redact(await page.title()),
      text: redact(
        htmlText(
          await page
            .locator('body')
            .innerText({ timeout: 5000 })
            .catch(() => ''),
        ),
      ),
    });
    traceStep(report, {
      phase: 'login-page',
      url: redact(page.url()),
      form: await loginFormSnapshot(page),
    });
    const agreement = await checkAgreement(page, report);
    const firstAuthResponse = page
      .waitForResponse(
        (response) =>
          /\/login\/|\/auth\/|\/user-info\//.test(
            new URL(response.url()).pathname,
          ),
        { timeout: timeoutMs },
      )
      .catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      }));
    await fillLogin(page);
    traceStep(report, { phase: 'submit-login', clicked: true });
    const authSignal = await firstAuthResponse;
    traceStep(report, {
      phase: 'first-auth-response',
      result:
        'url' in authSignal
          ? {
              url: redact(authSignal.url()),
              status: authSignal.status(),
              contentType: authSignal.headers()['content-type'] ?? null,
            }
          : { error: redact(authSignal.error) },
    });
    await page
      .waitForLoadState('networkidle', { timeout: timeoutMs })
      .catch(() => undefined);
    await page.waitForTimeout(3000);

    const bodyText = await page
      .locator('body')
      .innerText({ timeout: 5000 })
      .catch(() => '');
    const authState = classifyAuth({
      bodyText,
      events,
      agreement,
      currentUrl: page.url(),
    });
    report.auth = {
      attempted: true,
      success: authState.success,
      status: authState.status,
      reason: authState.reason,
      currentUrl: redact(page.url()),
      error: authState.error,
      headless,
    };
    traceStep(report, {
      phase: 'classified-auth',
      auth: report.auth,
    });
    if (report.loginTrace) {
      report.loginTrace.authEvents = summarizeAuthEvents(events);
    }
    report.pages.push({
      url: redact(page.url()),
      title: redact(await page.title()),
      text: redact(htmlText(bodyText)),
    });
    report.candidateLinks = (await discoverLinks(page)).map((item) => ({
      ...item,
      text: redact(item.text),
      href: redact(item.href),
      id: redact(item.id),
      className: redact(item.className),
    }));
    report.candidateRequests = events
      .filter((event) =>
        interestingUrl.test(`${event.url} ${event.body ?? ''}`),
      )
      .slice(0, 100);

    return { report, page, context, browser };
  } catch (error) {
    report.auth.status = 'error';
    report.auth.error = redact(
      error instanceof Error ? error.message : String(error),
    );
    return { report, page, context, browser };
  }
}

function parseCreatePayloadTemplate() {
  const values = targetValues();
  assertTargetNotProtected(values);
  return parsePayloadTemplate(
    process.env.CONSULTANT_USER_CREATE_PAYLOAD_JSON,
    values,
    {
      lastName: values.lastName,
      firstName: values.firstName,
      middleName: values.middleName,
      email: values.email,
      username: values.username,
      login: values.login,
    },
  );
}

function parseBlockPayloadTemplate() {
  const values = targetValues();
  assertTargetNotProtected(values);
  return parsePayloadTemplate(
    process.env.CONSULTANT_USER_BLOCK_PAYLOAD_JSON,
    values,
    Object.fromEntries(
      Object.entries(values).filter(([, value]) => Boolean(value)),
    ),
  );
}

function parsePayloadTemplate(raw, values, fallback) {
  if (
    raw &&
    /\$\{(password|pwd|newValue)\}|"(password|pwd|newValue)"\s*:/i.test(raw)
  ) {
    throw new Error(
      'ConsultantPlus does not accept caller-provided password fields; password is generated and delivered by email',
    );
  }
  const payload = raw ? JSON.parse(renderTemplate(raw, values)) : fallback;
  assertPayloadHasNoPasswordFields(payload);
  return payload;
}

function assertPayloadHasNoPasswordFields(value) {
  if (!value || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertPayloadHasNoPasswordFields);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (passwordFieldPattern.test(key)) {
      throw new Error(
        'ConsultantPlus does not accept caller-provided password fields; password is generated and delivered by email',
      );
    }
    assertPayloadHasNoPasswordFields(item);
  }
}

function defaultCloudUserPayload(values) {
  return {
    login: values.pureLogin,
    email: values.email,
    fio: values.fullName,
  };
}

function defaultManagedCloudUserPayload(values) {
  return {
    ...defaultCloudUserPayload(values),
    login: values.managedLogin,
  };
}

function defaultManagedLoginPayload(values) {
  return { logins: values.managedLogin };
}

function withoutPasswordFields(payload) {
  if (Array.isArray(payload)) {
    return payload.map(withoutPasswordFields);
  }
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  return Object.fromEntries(
    Object.entries(payload)
      .filter(([key]) => !passwordFieldPattern.test(key))
      .map(([key, value]) => [key, withoutPasswordFields(value)]),
  );
}

function adminPayload(op, payload) {
  return {
    ...payload,
    req: 'admin',
    op,
    rnd: Math.random().toString(36).slice(2),
  };
}

function requestBody(payload, contentType) {
  if (contentType === 'form') {
    return new URLSearchParams(
      Object.entries(payload).map(([key, value]) => [key, String(value ?? '')]),
    ).toString();
  }
  return payload;
}

function contentTypeHeader(contentType) {
  return contentType === 'form'
    ? 'application/x-www-form-urlencoded; charset=UTF-8'
    : 'application/json';
}

function decodeXmlAttribute(value) {
  return String(value ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseXmlAttributes(raw) {
  const attributes = {};
  for (const match of String(raw ?? '').matchAll(/([\w:-]+)="([^"]*)"/g)) {
    attributes[match[1]] = decodeXmlAttribute(match[2]);
  }
  return attributes;
}

function parseUserListXml(xml) {
  const userListMatch = String(xml ?? '').match(
    /<userlist\b([^>]*)>([\s\S]*?)<\/userlist>/i,
  );
  if (!userListMatch) {
    return { users: [] };
  }
  const [, listAttrs, usersXml] = userListMatch;
  const users = [];
  for (const match of usersXml.matchAll(/<user\b([^>]*)\/?>/gi)) {
    const attrs = parseXmlAttributes(match[1]);
    users.push({
      login: attrs.login,
      pureLogin: attrs.purelogin,
      fio: attrs.fio,
      email: attrs.email,
      sessions: attrs.sessions,
      online: attrs.online,
    });
  }
  return {
    ...parseXmlAttributes(listAttrs),
    users,
  };
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function fetchAdminUserList(page, options = '') {
  const request =
    typeof options === 'string' ? { filter: options } : { ...(options ?? {}) };
  const pgsize = String(parsePositiveInt(request.pgsize, 25));
  const pgnum = String(parsePositiveInt(request.pgnum, 1));
  const params = new URLSearchParams({
    req: 'admin',
    op: 'admusrlist',
    pgsize,
    pgnum,
    srtfld: '',
    srtdir: '',
    filter: request.filter ?? '',
    rnd: Math.random().toString(36).slice(2),
  });
  const response = await page.request.fetch(
    absoluteUrl(`/cloud/cgi/online.cgi?${params.toString()}`, apiBaseUrl),
    { method: 'GET', timeout: timeoutMs },
  );
  const responseText = await response.text().catch(() => '');
  return {
    success: response.ok(),
    status: response.status(),
    endpoint: redact(
      absoluteUrl(`/cloud/cgi/online.cgi?${params.toString()}`, apiBaseUrl),
    ),
    list: parseUserListXml(responseText),
    response: redact(responseText.slice(0, 1200)),
  };
}

function userListStats(list) {
  return {
    allowedUsers: parseNonNegativeInt(list.allowedusers),
    existingUsers: parseNonNegativeInt(list.existingusers),
    shownUsersFrom: parseNonNegativeInt(list.shownusersfrom),
    shownUsersTo: parseNonNegativeInt(list.shownusersto),
    loadedUsers: Array.isArray(list.users) ? list.users.length : 0,
  };
}

function findUserByPureLogin(userList, pureLogin) {
  return userList.users.find(
    (user) =>
      user.pureLogin === pureLogin ||
      user.login === pureLogin ||
      String(user.login ?? '').endsWith(`#${pureLogin}`),
  );
}

function redactedListedUser(user) {
  if (!user) {
    return undefined;
  }
  return {
    login: redact(user.login),
    pureLogin: redact(user.pureLogin),
    fio: redact(user.fio),
    email: redact(user.email),
    sessions: user.sessions,
    online: user.online,
  };
}

async function verifyUserPresent(page, target, expected = {}) {
  const values = targetValues(target);
  const result = await fetchAdminUserList(page, values.pureLogin);
  const user = findUserByPureLogin(result.list, values.pureLogin);
  const checks = {
    found: Boolean(user),
    email:
      expected.email === undefined || user?.email === String(expected.email),
    fio: expected.fio === undefined || user?.fio === String(expected.fio),
  };
  return {
    success: result.success && checks.found && checks.email && checks.fio,
    status: result.status,
    checks,
    user: redactedListedUser(user),
    endpoint: result.endpoint,
  };
}

async function verifyUserAbsent(page, target) {
  const values = targetValues(target);
  const result = await fetchAdminUserList(page, values.pureLogin);
  const user = findUserByPureLogin(result.list, values.pureLogin);
  return {
    success: result.success && !user,
    status: result.status,
    checks: { absent: !user },
    user: redactedListedUser(user),
    endpoint: result.endpoint,
  };
}

function responseHasApplicationError(responseText) {
  return /<\s*(err|errdata|error)\b|Страница не найдена|wrong_account_data|authStatus["']?\s*:\s*["']?fault|\bfault\b/i.test(
    String(responseText ?? ''),
  );
}

function isCloudAdminAjaxOperation(endpoint, payload, contentType) {
  return (
    contentType === 'form' &&
    payload?.req === 'admin' &&
    typeof payload?.op === 'string' &&
    /\/cloud\/cgi\/online\.cgi\??$/.test(endpoint)
  );
}

async function fetchBrowserAjaxOperation(page, payload, method) {
  return page.evaluate(
    ({ payload: rawPayload, method: requestMethod }) =>
      new Promise((resolve) => {
        const payload = { ...rawPayload };
        const request = {
          req: payload.req,
          op: payload.op,
          ...(payload.rnd ? { rnd: payload.rnd } : {}),
        };
        delete payload.req;
        delete payload.op;
        delete payload.rnd;

        const serialize = (data) => {
          if (typeof data === 'string') {
            return data;
          }
          if (data?.documentElement) {
            return new XMLSerializer().serializeToString(data);
          }
          try {
            return JSON.stringify(data ?? null);
          } catch {
            return String(data ?? '');
          }
        };

        if (!window.$?.ajax) {
          resolve({
            attempted: true,
            success: false,
            status: 0,
            response: 'jQuery ajax is not available in page context',
          });
          return;
        }

        window.$.ajax({
          type: requestMethod,
          request,
          data: payload,
          displayErrors: false,
        })
          .done((data, _textStatus, jqXHR) => {
            resolve({
              attempted: true,
              success: jqXHR.status >= 200 && jqXHR.status < 300,
              status: jqXHR.status,
              response: serialize(data),
            });
          })
          .fail((jqXHR, textStatus, errorThrown) => {
            resolve({
              attempted: true,
              success: false,
              status: jqXHR.status,
              response: jqXHR.responseText ?? serialize(jqXHR.responseXML),
              error: errorThrown || textStatus,
            });
          });
      }),
    { payload, method },
  );
}

async function fetchLiveOperation(page, options) {
  const {
    endpoint,
    target = {},
    payload,
    method = 'POST',
    contentType = 'json',
  } = options;
  const values = targetValues(target);
  assertTargetNotProtected(values);
  const renderedEndpoint = renderPathTemplate(endpoint, values);
  const csrf = await page
    .locator('meta[name="csrf-token"]')
    .first()
    .getAttribute('content')
    .catch(() => undefined);
  const browserAjax = isCloudAdminAjaxOperation(
    renderedEndpoint,
    payload,
    contentType,
  );
  const ajaxResult = browserAjax
    ? await fetchBrowserAjaxOperation(page, payload, method)
    : undefined;
  const response = browserAjax
    ? undefined
    : await page.request.fetch(absoluteUrl(renderedEndpoint, apiBaseUrl), {
        method,
        data:
          method.toUpperCase() === 'GET'
            ? undefined
            : requestBody(payload, contentType),
        headers: {
          Accept:
            'application/json, text/xml, application/xml, text/plain, */*',
          'Content-Type': contentTypeHeader(contentType),
          'X-Requested-With': 'XMLHttpRequest',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
        timeout: timeoutMs,
      });
  const responseText =
    ajaxResult?.response ?? (await response?.text().catch(() => '')) ?? '';
  const httpSuccess = ajaxResult
    ? ajaxResult.success
    : (response?.ok() ?? false);
  const responseError = responseHasApplicationError(responseText);
  return {
    attempted: true,
    success: httpSuccess && !responseError,
    httpSuccess,
    responseError,
    method,
    endpoint: redact(absoluteUrl(renderedEndpoint, apiBaseUrl)),
    status: ajaxResult?.status ?? response?.status(),
    transport: browserAjax ? 'browser-jquery-ajax' : 'playwright-request',
    target: redactedTargetUser(target),
    payload: JSON.parse(redact(payload)),
    response: redact(responseText.slice(0, 3000)),
    error: ajaxResult?.error,
  };
}

async function liveCreate(page, report) {
  if (!report.auth.success) {
    report.liveCreate = {
      attempted: false,
      success: false,
      error: 'Authenticated ConsultantPlus browser session is required',
    };
    return report;
  }

  const endpoint = process.env.CONSULTANT_USER_CREATE_ENDPOINT;
  if (!endpoint) {
    report.liveCreate = {
      attempted: false,
      success: false,
      error:
        'CONSULTANT_USER_CREATE_ENDPOINT is required until discovery confirms a stable create-user API',
    };
    return report;
  }

  const payload = parseCreatePayloadTemplate();
  const method = process.env.CONSULTANT_USER_CREATE_METHOD ?? 'POST';
  const contentType = process.env.CONSULTANT_USER_CREATE_CONTENT_TYPE ?? 'json';
  report.liveCreate = await fetchLiveOperation(page, {
    endpoint,
    payload,
    method,
    contentType,
  });
  return report;
}

async function liveBlock(page, report) {
  if (!report.auth.success) {
    report.liveBlock = {
      attempted: false,
      success: false,
      error: 'Authenticated ConsultantPlus browser session is required',
    };
    return report;
  }

  const endpoint = process.env.CONSULTANT_USER_BLOCK_ENDPOINT;
  if (!endpoint) {
    report.liveBlock = {
      attempted: false,
      success: false,
      error:
        'CONSULTANT_USER_BLOCK_ENDPOINT is required until discovery confirms a stable block-user API',
    };
    return report;
  }

  const payload = parseBlockPayloadTemplate();
  const method = process.env.CONSULTANT_USER_BLOCK_METHOD ?? 'POST';
  const contentType = process.env.CONSULTANT_USER_BLOCK_CONTENT_TYPE ?? 'json';
  report.liveBlock = await fetchLiveOperation(page, {
    endpoint,
    payload,
    method,
    contentType,
  });
  return report;
}

async function liveUpdate(page, report) {
  if (!report.auth.success) {
    report.liveUpdate = {
      attempted: false,
      success: false,
      error: 'Authenticated ConsultantPlus browser session is required',
    };
    return report;
  }

  const endpoint = process.env.CONSULTANT_USER_UPDATE_ENDPOINT;
  if (!endpoint) {
    report.liveUpdate = {
      attempted: false,
      success: false,
      error:
        'CONSULTANT_USER_UPDATE_ENDPOINT is required until discovery confirms a stable update-user API',
    };
    return report;
  }

  const values = targetValues();
  const payload = parsePayloadTemplate(
    process.env.CONSULTANT_USER_UPDATE_PAYLOAD_JSON,
    values,
    defaultManagedCloudUserPayload(values),
  );
  report.liveUpdate = await fetchLiveOperation(page, {
    endpoint,
    payload,
    method: process.env.CONSULTANT_USER_UPDATE_METHOD ?? 'POST',
    contentType: process.env.CONSULTANT_USER_UPDATE_CONTENT_TYPE ?? 'json',
  });
  return report;
}

async function liveChangePassword(page, report) {
  if (!report.auth.success) {
    report.liveChangePassword = {
      attempted: false,
      success: false,
      error: 'Authenticated ConsultantPlus browser session is required',
    };
    return report;
  }

  const endpoint = process.env.CONSULTANT_USER_CHANGE_PASSWORD_ENDPOINT;
  if (!endpoint) {
    report.liveChangePassword = {
      attempted: false,
      success: false,
      error:
        'CONSULTANT_USER_CHANGE_PASSWORD_ENDPOINT is required until discovery confirms a stable password API',
    };
    return report;
  }

  const values = targetValues();
  const payload = withoutPasswordFields(
    parsePayloadTemplate(
      process.env.CONSULTANT_USER_CHANGE_PASSWORD_PAYLOAD_JSON,
      values,
      defaultManagedCloudUserPayload(values),
    ),
  );
  report.liveChangePassword = await fetchLiveOperation(page, {
    endpoint,
    payload,
    method: process.env.CONSULTANT_USER_CHANGE_PASSWORD_METHOD ?? 'POST',
    contentType:
      process.env.CONSULTANT_USER_CHANGE_PASSWORD_CONTENT_TYPE ?? 'json',
  });
  if (report.liveChangePassword.success) {
    report.liveChangePassword.passwordDelivery = 'email';
    report.liveChangePassword.passwordKnown = false;
    report.liveChangePassword.login = redact(values.managedLogin);
    report.liveChangePassword.email = redact(values.email);
  }
  return report;
}

function assertDeleteAllowed(values, expectedPureLogin) {
  if (expectedPureLogin && values.pureLogin === expectedPureLogin) {
    return;
  }
  if (process.env.CONSULTANT_ALLOW_ANY_DELETE === 'true') {
    return;
  }
  throw new Error(
    `Refusing live delete outside current run: ${redact(values.pureLogin)}`,
  );
}

async function liveDelete(page, report) {
  if (!report.auth.success) {
    report.liveDelete = {
      attempted: false,
      success: false,
      error: 'Authenticated ConsultantPlus browser session is required',
    };
    return report;
  }

  const endpoint = process.env.CONSULTANT_USER_DELETE_ENDPOINT;
  if (!endpoint) {
    report.liveDelete = {
      attempted: false,
      success: false,
      error:
        'CONSULTANT_USER_DELETE_ENDPOINT is required until discovery confirms a stable delete-user API',
    };
    return report;
  }

  const values = targetValues();
  try {
    assertDeleteAllowed(values, `mwtd${runSlug.toLowerCase().slice(-10)}`);
  } catch (error) {
    report.liveDelete = {
      attempted: false,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
    return report;
  }
  const payload = parsePayloadTemplate(
    process.env.CONSULTANT_USER_DELETE_PAYLOAD_JSON,
    values,
    defaultManagedLoginPayload(values),
  );
  report.liveDelete = await fetchLiveOperation(page, {
    endpoint,
    payload,
    method: process.env.CONSULTANT_USER_DELETE_METHOD ?? 'POST',
    contentType: process.env.CONSULTANT_USER_DELETE_CONTENT_TYPE ?? 'json',
  });
  return report;
}

function generatedCycleTarget(kind) {
  const cycleSlug = runSlug.toLowerCase().slice(-10);
  const pureLogin = `${kind === 'delete' ? 'mwtd' : 'mwtk'}${cycleSlug}`;
  const email = `${pureLogin}@gkm.ru`;
  const role = kind === 'delete' ? 'Delete' : 'Keep';
  return {
    firstName: 'IdmMw',
    middleName: 'Cycle',
    lastName: role,
    email,
    username: email,
    pureLogin,
    fullName: `IdmMw Cycle ${role}`,
  };
}

function generatedBulkTarget(index) {
  const bulkSlug = runSlug.toLowerCase().slice(-8);
  const suffix = String(index + 1).padStart(2, '0');
  const pureLogin = `mwtb${bulkSlug}${suffix}`;
  const email = `${pureLogin}@gkm.ru`;
  return {
    firstName: 'IdmMw',
    middleName: 'Bulk',
    lastName: 'User',
    email,
    username: email,
    pureLogin,
    fullName: 'IdmMw Bulk User',
  };
}

async function liveBulkPagination(page, report) {
  const requestedCount = parsePositiveInt(
    process.env.CONSULTANT_BULK_USER_COUNT,
    30,
  );
  const pageSize = parsePositiveInt(process.env.CONSULTANT_BULK_PAGE_SIZE, 25);
  const steps = [];
  const cleanup = [];
  const createdTargets = [];

  report.bulkPagination = {
    attempted: report.auth.success,
    success: false,
    blocked: false,
    runId,
    runSlug,
    requestedCount,
    pageSize,
    steps,
    cleanup,
  };

  if (!report.auth.success) {
    report.bulkPagination.error =
      'Authenticated ConsultantPlus browser session is required';
    return report;
  }

  const initialList = await fetchAdminUserList(page, {
    pgsize: pageSize,
    pgnum: 1,
  });
  const initialStats = userListStats(initialList.list);
  report.bulkPagination.initial = {
    success: initialList.success,
    status: initialList.status,
    endpoint: initialList.endpoint,
    ...initialStats,
  };

  if (!initialList.success) {
    report.bulkPagination.error = 'Could not read ConsultantPlus user list';
    return report;
  }

  const allowedUsers = initialStats.allowedUsers;
  const existingUsers = initialStats.existingUsers;
  const freeSlots =
    allowedUsers === undefined || existingUsers === undefined
      ? undefined
      : allowedUsers - existingUsers;
  const requiredTotalUsers = pageSize + 1;
  report.bulkPagination.capacity = {
    allowedUsers,
    existingUsers,
    freeSlots,
    requiredTotalUsers,
    requestedCount,
  };

  const gateReasons = [];
  if (allowedUsers === undefined || existingUsers === undefined) {
    gateReasons.push(
      'Could not parse allowedusers/existingusers from admusrlist',
    );
  }
  if (allowedUsers !== undefined && allowedUsers <= pageSize) {
    gateReasons.push(
      `Tenant allowedusers=${allowedUsers} cannot produce page 2 with pgsize=${pageSize}`,
    );
  }
  if (freeSlots !== undefined && freeSlots < requestedCount) {
    gateReasons.push(
      `Only ${freeSlots} free user slot(s), requested ${requestedCount}`,
    );
  }
  if (
    existingUsers !== undefined &&
    existingUsers + requestedCount <= pageSize
  ) {
    gateReasons.push(
      `existingusers + requestedCount must be greater than ${pageSize}`,
    );
  }

  if (gateReasons.length > 0) {
    report.bulkPagination.blocked = true;
    report.bulkPagination.error = gateReasons.join('; ');
    return report;
  }

  async function step(name, target, endpoint, payload, verify) {
    const result = await fetchLiveOperation(page, {
      endpoint,
      target,
      payload,
      method: 'POST',
      contentType: 'form',
    });
    if (result.success && verify) {
      result.verification = await verify();
      result.success = result.verification.success;
    }
    steps.push({ name, ...result });
    return result.success;
  }

  let paginationVerified = false;
  try {
    for (let index = 0; index < requestedCount; index += 1) {
      const target = generatedBulkTarget(index);
      const values = targetValues(target);
      const created = await step(
        `bulk-user.${index + 1}.create`,
        target,
        cloudEndpoints.create,
        adminPayload('admadd', defaultCloudUserPayload(values)),
        () =>
          verifyUserPresent(page, target, {
            email: values.email,
            fio: values.fullName,
          }),
      );
      if (!created) {
        report.bulkPagination.error =
          'One or more ConsultantPlus bulk create steps failed';
        break;
      }
      createdTargets.push(target);
    }

    if (createdTargets.length === requestedCount) {
      const pageOne = await fetchAdminUserList(page, {
        pgsize: pageSize,
        pgnum: 1,
      });
      const pageTwo = await fetchAdminUserList(page, {
        pgsize: pageSize,
        pgnum: 2,
      });
      const pageOneStats = userListStats(pageOne.list);
      const pageTwoStats = userListStats(pageTwo.list);
      const paginationChecks = {
        pageOneLoaded: pageOne.success && pageOneStats.loadedUsers > 0,
        pageTwoLoaded: pageTwo.success && pageTwoStats.loadedUsers > 0,
        totalExceedsPageSize:
          pageOneStats.existingUsers !== undefined &&
          pageOneStats.existingUsers > pageSize,
        pageOneStartsAtOne: pageOneStats.shownUsersFrom === 1,
        pageOneReachesPageSize:
          pageOneStats.shownUsersTo !== undefined &&
          pageOneStats.shownUsersTo >= pageSize,
        pageTwoStartsAfterPageOne:
          pageTwoStats.shownUsersFrom !== undefined &&
          pageOneStats.shownUsersTo !== undefined &&
          pageTwoStats.shownUsersFrom > pageOneStats.shownUsersTo,
      };
      report.bulkPagination.pagination = {
        pageOne: {
          success: pageOne.success,
          status: pageOne.status,
          endpoint: pageOne.endpoint,
          ...pageOneStats,
        },
        pageTwo: {
          success: pageTwo.success,
          status: pageTwo.status,
          endpoint: pageTwo.endpoint,
          ...pageTwoStats,
        },
        checks: paginationChecks,
      };
      paginationVerified = Object.values(paginationChecks).every(Boolean);

      if (!paginationVerified) {
        report.bulkPagination.error =
          'ConsultantPlus user-list pagination check failed';
      }
    }
  } finally {
    for (const target of createdTargets.reverse()) {
      const values = targetValues(target);
      assertDeleteAllowed(values, target.pureLogin);
      const result = await fetchLiveOperation(page, {
        endpoint: cloudEndpoints.delete,
        target,
        payload: adminPayload('admdel', defaultManagedLoginPayload(values)),
        method: 'POST',
        contentType: 'form',
      });
      if (result.success) {
        result.verification = await verifyUserAbsent(page, target);
        result.success = result.verification.success;
      }
      cleanup.push({ name: 'bulk-user.delete', ...result });
    }
  }

  report.bulkPagination.createdUsers = createdTargets.length;
  report.bulkPagination.cleanedUsers = cleanup.filter(
    (item) => item.success,
  ).length;
  report.bulkPagination.success =
    steps.every((item) => item.success === true) &&
    cleanup.every((item) => item.success === true) &&
    paginationVerified;
  if (!report.bulkPagination.success) {
    report.bulkPagination.error =
      report.bulkPagination.error ??
      'One or more ConsultantPlus bulk pagination steps failed';
  }
  return report;
}

async function liveCycle(page, report) {
  const deleteTarget = generatedCycleTarget('delete');
  const updateDeleteTarget = {
    ...deleteTarget,
    firstName: 'IdmMw',
    middleName: 'Updated',
    lastName: 'User',
    fullName: 'IdmMw Updated User',
  };
  const keepTarget = generatedCycleTarget('keep');
  const steps = [];

  report.liveCycle = {
    attempted: report.auth.success,
    success: false,
    runId,
    runSlug,
    deleteUser: redactedTargetUser(deleteTarget),
    keepUser: redactedTargetUser(keepTarget),
    steps,
  };

  if (!report.auth.success) {
    report.liveCycle.error =
      'Authenticated ConsultantPlus browser session is required';
    return report;
  }

  async function step(
    name,
    target,
    endpoint,
    payload,
    contentType = 'form',
    verify,
  ) {
    const result = await fetchLiveOperation(page, {
      endpoint,
      target,
      payload,
      method: 'POST',
      contentType,
    });
    if (result.success && verify) {
      result.verification = await verify();
      result.success = result.verification.success;
    }
    steps.push({ name, ...result });
    return result.success;
  }

  const deleteValues = targetValues(deleteTarget);
  const updateDeleteValues = targetValues(updateDeleteTarget);
  const keepValues = targetValues(keepTarget);

  const deleteCreated = await step(
    'delete-user.create',
    deleteTarget,
    cloudEndpoints.create,
    adminPayload('admadd', defaultCloudUserPayload(deleteValues)),
    'form',
    () =>
      verifyUserPresent(page, deleteTarget, {
        email: deleteValues.email,
        fio: deleteValues.fullName,
      }),
  );
  if (deleteCreated) {
    await step(
      'delete-user.update',
      updateDeleteTarget,
      cloudEndpoints.update,
      adminPayload(
        'admupd',
        defaultManagedCloudUserPayload(updateDeleteValues),
      ),
      'form',
      () =>
        verifyUserPresent(page, updateDeleteTarget, {
          email: updateDeleteValues.email,
          fio: updateDeleteValues.fullName,
        }),
    );
    await step(
      'delete-user.passwordReset',
      updateDeleteTarget,
      cloudEndpoints.changePassword,
      adminPayload(
        'admupd',
        defaultManagedCloudUserPayload(updateDeleteValues),
      ),
      'form',
    );
    await step(
      'delete-user.block',
      deleteTarget,
      cloudEndpoints.block,
      adminPayload('admdismiss', defaultManagedLoginPayload(deleteValues)),
      'form',
    );
    assertDeleteAllowed(deleteValues, deleteTarget.pureLogin);
    await step(
      'delete-user.delete',
      deleteTarget,
      cloudEndpoints.delete,
      adminPayload('admdel', defaultManagedLoginPayload(deleteValues)),
      'form',
      () => verifyUserAbsent(page, deleteTarget),
    );
  } else {
    steps.push({
      name: 'delete-user.update/passwordReset/block/delete',
      attempted: false,
      success: false,
      error: 'Skipped because create failed',
    });
  }

  const keepCreated = await step(
    'keep-user.create',
    keepTarget,
    cloudEndpoints.create,
    adminPayload('admadd', defaultCloudUserPayload(keepValues)),
    'form',
    () =>
      verifyUserPresent(page, keepTarget, {
        email: keepValues.email,
        fio: keepValues.fullName,
      }),
  );
  let keepPasswordReset = false;
  if (keepCreated) {
    keepPasswordReset = await step(
      'keep-user.passwordReset',
      keepTarget,
      cloudEndpoints.changePassword,
      adminPayload('admupd', defaultManagedCloudUserPayload(keepValues)),
      'form',
      () =>
        verifyUserPresent(page, keepTarget, {
          email: keepValues.email,
          fio: keepValues.fullName,
        }),
    );
  } else {
    steps.push({
      name: 'keep-user.passwordReset',
      attempted: false,
      success: false,
      error: 'Skipped because create failed',
    });
  }

  if (keepCreated && !keepPasswordReset) {
    assertDeleteAllowed(keepValues, keepTarget.pureLogin);
    await step(
      'keep-user.cleanupAfterFailedPasswordReset',
      keepTarget,
      cloudEndpoints.delete,
      adminPayload('admdel', defaultManagedLoginPayload(keepValues)),
      'form',
      () => verifyUserAbsent(page, keepTarget),
    );
  }

  if (keepCreated && keepPasswordReset) {
    report.liveCycle.keepUserAccess = {
      login: redact(keepValues.managedLogin),
      loginFormat: 'managedLogin',
      email: redact(keepValues.email),
      passwordDelivery: 'email',
      passwordKnown: false,
    };
  }

  report.liveCycle.success = steps.every((item) => item.success === true);
  if (!report.liveCycle.success) {
    report.liveCycle.error =
      'One or more ConsultantPlus live-cycle steps failed';
  }
  return report;
}

async function main() {
  assertConfiguredOrigins();
  if (
    ![
      'discover',
      'live-create',
      'live-update',
      'live-change-password',
      'live-block',
      'live-delete',
      'live-cycle',
      'bulk-pagination',
    ].includes(mode)
  ) {
    throw new Error(`Unsupported mode: ${mode}`);
  }
  const { report, page, browser } = await loginAndCollect();
  try {
    if (mode === 'live-create') {
      await liveCreate(page, report);
    }
    if (mode === 'live-update') {
      await liveUpdate(page, report);
    }
    if (mode === 'live-change-password') {
      await liveChangePassword(page, report);
    }
    if (mode === 'live-block') {
      await liveBlock(page, report);
    }
    if (mode === 'live-delete') {
      await liveDelete(page, report);
    }
    if (mode === 'live-cycle') {
      await liveCycle(page, report);
    }
    if (mode === 'bulk-pagination') {
      await liveBulkPagination(page, report);
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    writeReport(report);
    await browser.close().catch(() => undefined);
  }

  console.log(
    JSON.stringify(
      {
        mode,
        reportPath,
        auth: report.auth,
        liveCreate: report.liveCreate,
        liveUpdate: report.liveUpdate,
        liveChangePassword: report.liveChangePassword,
        liveBlock: report.liveBlock,
        liveDelete: report.liveDelete,
        liveCycle: report.liveCycle
          ? {
              attempted: report.liveCycle.attempted,
              success: report.liveCycle.success,
              runId: report.liveCycle.runId,
              keepUserAccess: report.liveCycle.keepUserAccess,
              steps: report.liveCycle.steps?.map((step) => ({
                name: step.name,
                attempted: step.attempted,
                success: step.success,
                status: step.status,
                error: step.error,
              })),
            }
          : undefined,
        bulkPagination: report.bulkPagination
          ? {
              attempted: report.bulkPagination.attempted,
              success: report.bulkPagination.success,
              blocked: report.bulkPagination.blocked,
              requestedCount: report.bulkPagination.requestedCount,
              pageSize: report.bulkPagination.pageSize,
              capacity: report.bulkPagination.capacity,
              initial: report.bulkPagination.initial,
              pagination: report.bulkPagination.pagination,
              createdUsers: report.bulkPagination.createdUsers,
              cleanedUsers: report.bulkPagination.cleanedUsers,
              error: report.bulkPagination.error,
            }
          : undefined,
        candidateLinks: report.candidateLinks.length,
        candidateRequests: report.candidateRequests.length,
      },
      null,
      2,
    ),
  );

  if (
    report.auth.error ||
    report.liveCreate?.error ||
    report.liveCreate?.success === false ||
    report.liveUpdate?.error ||
    report.liveUpdate?.success === false ||
    report.liveChangePassword?.error ||
    report.liveChangePassword?.success === false ||
    report.liveBlock?.error ||
    report.liveBlock?.success === false ||
    report.liveDelete?.error ||
    report.liveDelete?.success === false ||
    report.liveCycle?.error ||
    report.liveCycle?.success === false ||
    report.bulkPagination?.error ||
    report.bulkPagination?.success === false
  ) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
