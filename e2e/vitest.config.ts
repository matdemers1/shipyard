import { defineConfig } from 'vitest/config';

// The harness boots Docker; nothing here runs in parallel with anything else.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
