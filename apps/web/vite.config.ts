import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Everything the console talks to lives on the server, which also serves the built console at `/`
// in production (one origin, one cookie). In development Vite serves it and proxies these through.
const SERVER = 'http://127.0.0.1:3300';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Types only (`import type`), so nothing from zod reaches the bundle; the alias exists because
    // the package export points at dist/, which is not built when the console is.
    alias: { '@shipyard/schema': resolve(import.meta.dirname, '../../packages/schema/src/index.ts') },
  },
  build: { outDir: 'dist', sourcemap: false },
  server: {
    proxy: {
      '/api': SERVER,
      '/mcp': SERVER,
      '/health': SERVER,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    // The design system imports its own CSS from JavaScript, which Node cannot load.
    server: { deps: { inline: ['@d3cloud/ui'] } },
    css: false,
  },
});
