import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// `@shipyard/schema` resolves to `dist` at runtime; tests use its source so nothing has to be built.
export default defineConfig({
  resolve: {
    alias: { '@shipyard/schema': resolve(import.meta.dirname, '../schema/src/index.ts') },
  },
  test: { include: ['test/**/*.test.ts'] },
});
