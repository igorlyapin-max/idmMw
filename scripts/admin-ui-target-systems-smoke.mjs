import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';

const baseUrl = process.env.IDMMW_UI_SMOKE_BASE_URL;
if (!baseUrl) {
  throw new Error('IDMMW_UI_SMOKE_BASE_URL is required');
}

const chrome = '/usr/bin/google-chrome';
const browser = await chromium.launch({
  headless: true,
  ...(existsSync(chrome) ? { executablePath: chrome } : {}),
});

const context = await browser.newContext({
  viewport: { width: 1366, height: 900 },
});
await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
  origin: baseUrl,
});
const page = await context.newPage();
const api = context.request;
const runId = Date.now();
const cmdbSmokeName = `ui-smoke-cmdb-${runId}`;
let cmdbTargetId;

try {
  const cmdbCreateResponse = await api.post(`${baseUrl}/admin/target-systems`, {
    data: {
      name: cmdbSmokeName,
      type: 'cmdbuild',
      label: 'UI smoke CMDBuild',
      config: {
        baseUrl: 'https://cmdbuild.example.local',
        defaultUserGroupId: 'TestUserAdmin',
      },
      enabled: true,
    },
  });
  const cmdbCreate = await cmdbCreateResponse.json();
  cmdbTargetId = cmdbCreate?.id;
  await api.post(`${baseUrl}/admin/target-systems`, {
    data: {
      name: 'ui-smoke-fake',
      type: 'fake',
      label: 'UI smoke fake',
      config: {},
      enabled: true,
    },
  });
  await api.post(`${baseUrl}/admin/runtime/debug`, {
    data: {
      targetSystem: 'ui-smoke-fake',
      level: 'Verbose',
      ttlSeconds: 300,
    },
  });
  await api.post(`${baseUrl}/webhooks/avanpost`, {
    data: {
      eventId: `ui-smoke-${Date.now()}`,
      operation: 'user.create',
      targetSystem: 'ui-smoke-fake',
      payload: {
        data: {
          username: 'ui-smoke-user',
          password: 'ui-smoke-password',
        },
      },
    },
  });

  await page.goto(`${baseUrl}/target-systems`);
  await page.getByRole('heading', { name: 'Target Systems' }).waitFor();

  await page.getByRole('button', { name: /Create target system/ }).click();
  await page.locator('#target-system-type').selectOption('postgres-role');
  await page.locator('#target-system-name').fill('ui-smoke-postgres');
  await page.locator('#target-system-label').fill('UI smoke PostgreSQL');
  await page.getByLabel('Default permissions (JSON)').fill('[{]');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByText('Invalid JSON').waitFor();
  const invalidBox = await page.getByText('Invalid JSON').boundingBox();
  if (!invalidBox || invalidBox.width === 0 || invalidBox.height === 0) {
    throw new Error('Invalid JSON error is not visibly rendered');
  }
  await page.getByLabel('Default permissions (JSON)').fill('[]');
  await page.getByText('Invalid JSON').waitFor({ state: 'detached' });

  const cmdbRow = page.getByRole('row').filter({ hasText: cmdbSmokeName });
  await cmdbRow.getByRole('button', { name: 'Edit' }).click();
  const defaultGroupEnabled = page.locator('#config-defaultUserGroupEnabled');
  if (!(await defaultGroupEnabled.isChecked())) {
    throw new Error(
      'Legacy defaultUserGroupId was not migrated in the UI form',
    );
  }
  await defaultGroupEnabled.uncheck();
  await page.locator('#config-defaultUserGroupValue').fill('');
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await page.getByText('Updated successfully').waitFor();

  const cmdbReadResponse = await api.get(
    `${baseUrl}/admin/target-systems/name/${encodeURIComponent(cmdbSmokeName)}`,
  );
  const cmdbRead = await cmdbReadResponse.json();
  if (
    cmdbRead?.config &&
    Object.prototype.hasOwnProperty.call(cmdbRead.config, 'defaultUserGroupId')
  ) {
    throw new Error('Cleared defaultUserGroupId remained in target config');
  }
  if (
    cmdbRead?.config &&
    (Object.prototype.hasOwnProperty.call(
      cmdbRead.config,
      'defaultUserGroupEnabled',
    ) ||
      Object.prototype.hasOwnProperty.call(
        cmdbRead.config,
        'defaultUserGroupValue',
      ))
  ) {
    throw new Error(
      'Disabled default CMDBuild group remained in target config',
    );
  }
  if (
    cmdbRead?.config &&
    Object.prototype.hasOwnProperty.call(
      cmdbRead.config,
      'defaultUserGroupMode',
    )
  ) {
    throw new Error(
      'Disabled default CMDBuild group mode remained in target config',
    );
  }

  await cmdbRow.getByRole('button', { name: 'Edit' }).click();
  await page.locator('#config-incomingGroupsEnabled').check();
  await page.locator('#config-incomingGroupsMode').selectOption('name');
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await page.getByText('Updated successfully').waitFor();

  const cmdbReadIncomingResponse = await api.get(
    `${baseUrl}/admin/target-systems/name/${encodeURIComponent(cmdbSmokeName)}`,
  );
  const cmdbReadIncoming = await cmdbReadIncomingResponse.json();
  if (
    cmdbReadIncoming?.config?.incomingGroupsEnabled !== true ||
    cmdbReadIncoming?.config?.incomingGroupsMode !== 'name'
  ) {
    throw new Error('Incoming CMDBuild group settings were not persisted');
  }

  const fakeRow = page.getByRole('row').filter({ hasText: 'ui-smoke-fake' });
  await fakeRow.getByRole('button', { name: 'Logs' }).click();
  await page.getByRole('dialog', { name: /Logs: ui-smoke-fake/ }).waitFor();
  await page.getByRole('button', { name: 'Copy all' }).click();
  await page.getByText('Logs copied to clipboard.').waitFor();
  const clipboardText = await page.evaluate(() =>
    navigator.clipboard.readText(),
  );
  if (!clipboardText.includes('idm.webhook.received')) {
    throw new Error('Copied logs do not include runtime log content');
  }
  await page.getByRole('button', { name: 'Close' }).click();

  await fakeRow.getByRole('button', { name: /Debug/ }).click();
  await page.getByRole('dialog', { name: /Debug: ui-smoke-fake/ }).waitFor();
  await page.getByLabel('Level').selectOption('Verbose');
  await page.getByLabel('Duration').selectOption('14400');
  const warning = page.getByText(/Verbose debug can expose/);
  await warning.waitFor();
  const warningBox = await warning.boundingBox();
  if (!warningBox || warningBox.width === 0 || warningBox.height === 0) {
    throw new Error('Verbose warning is not visibly rendered');
  }
} finally {
  if (cmdbTargetId) {
    await api.delete(`${baseUrl}/admin/target-systems/${cmdbTargetId}`);
  }
  await browser.close();
}
