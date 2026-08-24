import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  base: '/idm-emulator/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/webhooks': {
        target: 'http://localhost:3010',
        changeOrigin: true,
      },
      '/mock-idm': {
        target: 'http://localhost:3010',
        changeOrigin: true,
      },
      '/idm': {
        target: 'http://localhost:3010',
        changeOrigin: true,
      },
      '/admin': {
        target: 'http://localhost:3010',
        changeOrigin: true,
      },
    },
  },
  build: {
    cssMinify: 'esbuild',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
