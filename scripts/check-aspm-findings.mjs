#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const bannedPatterns = [
  ['sha256 createHash in reported files', /createHash\(['"]sha256['"]\)/],
  ['disabled PostgreSQL TLS', /sslmode=disable/],
  ['dev database credential literal', /idmmw_dev/],
  ['database password placeholder signature', /REPLACE_WITH_DB_PASSWORD/],
  [
    'secret-looking fixture literal',
    /secret-password|session-secret|basic-secret|old-secret|plain-secret|plain-token|operator-supplied-password|rnd-password/,
  ],
  [
    'legacy PAM environment variable',
    /\bPAM(URL|TOKEN|USERNAME|PASSWORD|DEFAULTACCOUNTPATH)\b/,
  ],
  ['idmmw secret URI signature', /secret:\/\/idmmw-(admin|encryption)/],
  [
    'local PostgreSQL credential literal',
    /postgresql:\/\/idmmw:idmmw@localhost:5432\/idmmw/,
  ],
  [
    'local CockroachDB insecure DSN literal',
    /postgresql:\/\/root@localhost:26257\/defaultdb\?sslmode=disable/,
  ],
];

export function checkAspmReport(reportPathInput, cwd = process.cwd()) {
  const reportPath = resolve(cwd, reportPathInput ?? '../aspm/3.json');

  if (!existsSync(reportPath)) {
    return {
      code: 2,
      messages: [`ASPM report not found: ${reportPath}`],
    };
  }

  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const findings = Array.isArray(report?.report)
    ? report.report
    : Array.isArray(report?.vulnerabilities)
      ? report.vulnerabilities
      : [];

  if (findings.length === 0) {
    return {
      code: 1,
      messages: [
        'ASPM report does not contain report/vulnerabilities findings.',
      ],
    };
  }

  const filePaths = new Set(
    findings
      .map((finding) => finding?.info?.file_path)
      .filter((filePath) => typeof filePath === 'string'),
  );

  if (filePaths.size === 0) {
    return {
      code: 1,
      messages: ['ASPM report findings do not contain info.file_path values.'],
    };
  }

  const violations = [];

  for (const filePath of filePaths) {
    const absolutePath = resolve(cwd, filePath);
    if (!existsSync(absolutePath)) {
      continue;
    }
    const source = readFileSync(absolutePath, 'utf8');
    for (const [label, pattern] of bannedPatterns) {
      if (pattern.test(source)) {
        violations.push(`${filePath}: ${label}`);
      }
    }
  }

  if (violations.length > 0) {
    return {
      code: 1,
      messages: [
        'ASPM remediation check failed:',
        ...violations.map((violation) => `- ${violation}`),
      ],
    };
  }

  return {
    code: 0,
    messages: [
      `ASPM remediation check passed for ${filePaths.size} reported files.`,
    ],
  };
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  const result = checkAspmReport(process.argv[2]);
  const output = result.code === 0 ? console.log : console.error;
  output(result.messages.join('\n'));
  process.exit(result.code);
}
