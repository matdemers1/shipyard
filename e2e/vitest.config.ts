import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// The harness boots Docker; nothing here runs in parallel with anything else. Workspace packages
// resolve to their sources, so nothing has to be built first.
export default defineConfig({
  resolve: {
    alias: {
      '@shipyard/schema': resolve(import.meta.dirname, '../packages/schema/src/index.ts'),
      '@shipyard/sequence': resolve(import.meta.dirname, '../packages/sequence/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
