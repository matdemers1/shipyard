import { defineConfig } from 'vitest/config';

// Named projects, because CI gates in layers: lint → unit → integration → e2e.
// The integration project is the only one that needs a database.
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          // A shared database makes these order-dependent; they run one file at a time.
          fileParallelism: false,
          hookTimeout: 30_000,
          globalSetup: ['test/integration/global-setup.ts'],
        },
      },
    ],
  },
});
