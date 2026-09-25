// A separate process appending to a shared ledger file (SHP-T-6.11's cross-process test).
// Run with `node --experimental-strip-types ledger-writer.mjs <path> <name> <count>`: it opens its
// own Ledger on the real filesystem, waits for `<path>.go` (so every writer starts together), then
// appends `count` entries as fast as it can.
import { existsSync } from 'node:fs';
import { register } from 'node:module';

// The source imports `./x.js`; with type stripping the file on disk is `./x.ts`.
register(
  'data:text/javascript,' +
    encodeURIComponent(
      "export async function resolve(s, c, next) { try { return await next(s, c); } catch (e) { if (s.startsWith('.') && s.endsWith('.js')) return next(s.slice(0, -3) + '.ts', c); throw e; } }",
    ),
);

const [path, name, countArg] = process.argv.slice(2);
const count = Number(countArg);

const { Ledger } = await import('../../src/ledger.ts');
const { nodeFs } = await import('../../src/adapters/node.ts');

const ledger = await Ledger.open(nodeFs(), path);
process.stdout.write('ready\n');
while (!existsSync(`${path}.go`)) await new Promise((r) => setTimeout(r, 2));

for (let i = 0; i < count; i++) {
  await ledger.append({
    app: 'bindery',
    deployId: `${name}-${i}`,
    kind: 'deploy',
    sha: 'a'.repeat(40),
    images: [{ service: 'server', repo: 'ghcr.io/matdemers1/bindery/server', digest: `sha256:${'b'.repeat(64)}`, migration: null }],
    backupArtifact: null,
    at: new Date().toISOString(),
  });
}
