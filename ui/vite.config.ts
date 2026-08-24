import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION_PATTERN = /^\d{2}\.\d{2}\.\d{2}\.\d{2}$/;
const FALLBACK_VERSION = '0.0.0.0';

export function readAppVersion(
  rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
): string {
  const versionPath = resolve(rootDir, 'VERSION');
  if (!existsSync(versionPath)) {
    return FALLBACK_VERSION;
  }
  const version = readFileSync(versionPath, 'utf8').trim();
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(
      `Invalid VERSION format in ${versionPath}: expected XX.YY.ZZ.NN`,
    );
  }
  return version;
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    cssMinify: 'esbuild',
  },
  define: {
    __APP_VERSION__: JSON.stringify(readAppVersion()),
  },
});
