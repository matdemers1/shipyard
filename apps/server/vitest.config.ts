import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// `@shipyard/schema`'s package export points at dist/, which is not built during tests; alias it
// to source directly. In `projects` mode a project does not inherit the root `resolve`, so this
// is repeated inside each project below.
const schemaAlias = {
  '@shipyard/schema': resolve(import.meta.dirname, '../../packages/schema/src/index.ts'),
};

// Named projects, because CI gates in layers: lint → unit → integration → e2e.
// The integration project is the only one that needs a database.
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: schemaAlias },
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'] },
      },
      {
        resolve: { alias: schemaAlias },
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
