import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// `@shipyard/schema` and `@shipyard/sequence` resolve to `dist` at runtime; tests use their
// source so nothing has to be built (see `packages/sequence/vitest.config.ts`).
export default defineConfig({
  resolve: {
    alias: {
      '@shipyard/schema': resolve(import.meta.dirname, '../../packages/schema/src/index.ts'),
      '@shipyard/sequence': resolve(import.meta.dirname, '../../packages/sequence/src/index.ts'),
    },
  },
  test: { include: ['test/**/*.test.ts'] },
});
