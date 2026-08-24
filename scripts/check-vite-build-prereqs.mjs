#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const projectDir = resolve(process.argv[2] ?? '.');
const projectName = process.argv[3] ?? projectDir;
const viteModulePath = resolve(projectDir, 'node_modules/vite/dist/node/index.js');

function fail(message) {
  console.error(`Vite build preflight failed for ${projectName}: ${message}`);
  process.exit(1);
}

function requireBuildModule(packageName) {
  const modulePath = resolve(projectDir, 'node_modules', packageName);
  if (!existsSync(modulePath)) {
    fail(
      `missing ${packageName}. Corporate npm mirror/proxy must provide Vite native optional packages for the target linux platform.`,
    );
  }
}

if (!existsSync(viteModulePath)) {
  fail('missing vite after npm ci');
}

requireBuildModule('@rolldown/binding-linux-x64-gnu');
requireBuildModule('esbuild');

const vite = await import(pathToFileURL(viteModulePath).href);
const config = await vite.resolveConfig(
  {
    root: projectDir,
    mode: 'production',
    configFile: resolve(projectDir, 'vite.config.ts'),
  },
  'build',
  'production',
);

if (config.build.cssMinify !== 'esbuild') {
  fail(
    `expected build.cssMinify=esbuild, got ${JSON.stringify(
      config.build.cssMinify,
    )}. This avoids the lightningcss native optional package during customer builds.`,
  );
}

console.log(`Vite build preflight passed for ${projectName}`);
