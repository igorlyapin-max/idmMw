#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAspmReport } from './check-aspm-findings.mjs';

function writeReport(root, value) {
  const reportPath = join(root, 'aspm.json');
  writeFileSync(reportPath, JSON.stringify(value), 'utf8');
  return reportPath;
}

function writeSource(root, path, source) {
  const absolutePath = join(root, path);
  mkdirSync(absolutePath.replace(/\/[^/]+$/, ''), { recursive: true });
  writeFileSync(absolutePath, source, 'utf8');
}

function expectExit(name, actual, expectedCode, expectedText) {
  if (actual.code !== expectedCode) {
    throw new Error(
      `${name}: expected exit ${expectedCode}, got ${actual.code}\n${actual.messages.join('\n')}`,
    );
  }
  const combined = actual.messages.join('\n');
  if (expectedText && !combined.includes(expectedText)) {
    throw new Error(
      `${name}: expected output to include ${expectedText}\n${combined}`,
    );
  }
}

const tests = [
  {
    name: 'passes clean report schema',
    setup(root) {
      writeSource(root, 'src/example.ts', 'const value = "aapm://Allowed";\n');
      return writeReport(root, {
        report: [{ info: { file_path: 'src/example.ts' } }],
      });
    },
    code: 0,
    text: 'ASPM remediation check passed',
  },
  {
    name: 'passes vulnerabilities schema',
    setup(root) {
      writeSource(
        root,
        'src/example.ts',
        'const value = "REPLACE_WITH_DB_CREDENTIAL";\n',
      );
      return writeReport(root, {
        vulnerabilities: [{ info: { file_path: 'src/example.ts' } }],
      });
    },
    code: 0,
    text: 'ASPM remediation check passed',
  },
  {
    name: 'fails unknown schema',
    setup(root) {
      return writeReport(root, { findings: [] });
    },
    code: 1,
    text: 'does not contain report/vulnerabilities findings',
  },
  {
    name: 'fails findings without file paths',
    setup(root) {
      return writeReport(root, { report: [{ info: { title: 'x' } }] });
    },
    code: 1,
    text: 'do not contain info.file_path',
  },
  {
    name: 'fails banned literal',
    setup(root) {
      writeSource(root, 'src/example.ts', 'const dsn = "sslmode=disable";\n');
      return writeReport(root, {
        report: [{ info: { file_path: 'src/example.ts' } }],
      });
    },
    code: 1,
    text: 'disabled PostgreSQL TLS',
  },
  {
    name: 'ignores deleted reported file',
    setup(root) {
      return writeReport(root, {
        report: [{ info: { file_path: 'src/deleted.ts' } }],
      });
    },
    code: 0,
    text: 'ASPM remediation check passed',
  },
];

for (const test of tests) {
  const root = mkdtempSync(join(tmpdir(), 'idmmw-aspm-check-'));
  try {
    const report = test.setup(root);
    expectExit(test.name, checkAspmReport(report, root), test.code, test.text);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`ASPM checker tests passed: ${tests.length}`);
