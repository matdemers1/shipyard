import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// `@shipyard/schema`'s package export points at dist/, which is not built during tests; alias it
// to source directly. In `projects` mode a project does not inherit the root `resolve`, so this
// is repeated inside each project below.
const schemaAlias = {
  '@shipyard/schema': resolve(import.meta.dirname, '../../packages/schema/src/index.ts'),
  // The server reads GitHub through the engine's adapter (commits waiting); same reason.
  '@shipyard/sequence/github': resolve(import.meta.dirname, '../../packages/sequence/src/adapters/github.ts'),
};

// Named projects, because CI gates in layers: lint → unit → integration → e2e.
// The integration project is the only one that needs a database.
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: schemaAlias },
        test: { name: 'unit',
          setupFiles: ['test/setup/loopback.ts'], include: ['test/unit/**/*.test.ts'] },
      },
      {
        resolve: { alias: schemaAlias },
        test: {
          name: 'integration',
          setupFiles: ['test/setup/loopback.ts'],
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
