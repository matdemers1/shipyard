// Playwright's webServer: build what ships, bring the test database's schema up to date, then run
// the REAL server serving the REAL built console at one origin — what a deploy runs, not a dev
// server. GitHub is answered by `github-stub.mjs`, preloaded into the server process.
//
//   DATABASE_URL            required; a dedicated database whose name ends in _test (it is wiped)
//   SHIPYARD_PORT           default 3462
//   CONSOLE_E2E_SKIP_BUILD  set to 1 when the workspace is already built (CI builds in its own step)
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';

const here = import.meta.dirname;
const root = join(here, '..', '..');
const serverDir = join(root, 'apps', 'server');

const url = process.env.DATABASE_URL;
if (url === undefined || url === '') {
  console.error('console-e2e: DATABASE_URL is required (a PostgreSQL 16 database whose name ends in _test)');
  process.exit(1);
}
if (!new URL(url).pathname.slice(1).endsWith('_test')) {
  console.error('console-e2e: refusing a DATABASE_URL whose database name does not end in _test — the suite wipes it');
  process.exit(1);
}
const port = process.env.SHIPYARD_PORT ?? '3462';

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    console.error(`console-e2e: \`${command} ${args.join(' ')}\` failed`);
    process.exit(result.status ?? 1);
  }
}

if (process.env.CONSOLE_E2E_SKIP_BUILD !== '1') {
  // Always rebuilt: a stale bundle would test yesterday's console against today's fix.
  for (const pkg of ['@shipyard/schema', '@shipyard/sequence', 'shipyard-server', 'shipyard-web']) {
    run('pnpm', ['--filter', pkg, 'build'], root);
  }
}

// `prisma migrate deploy` creates the database when it is missing, then applies every migration.
const prismaCli = join(dirname(createRequire(join(serverDir, 'package.json')).resolve('prisma/package.json')), 'build', 'index.js');
run(process.execPath, [prismaCli, 'migrate', 'deploy'], serverDir);

// Express's static and sendFile refuse any path with a dot-segment (`dotfiles: 'ignore'`), so a
// checkout under e.g. `.claude/worktrees/` would 404 the whole console. Serve it through a symlink
// whose own path has none; the server never resolves it.
let consoleDist = join(root, 'apps', 'web', 'dist');
if (consoleDist.split(sep).some((segment) => segment.startsWith('.'))) {
  const link = join(tmpdir(), `shipyard-console-e2e-dist-${port}`);
  rmSync(link, { force: true, recursive: true });
  symlinkSync(consoleDist, link, 'dir');
  consoleDist = link;
}

const backupDir = join(here, '..', '.state', 'backups');
mkdirSync(backupDir, { recursive: true });

const server = spawn(process.execPath, ['--import', join(here, 'github-stub.mjs'), join(serverDir, 'dist', 'index.js')], {
  cwd: serverDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    DATABASE_URL: url,
    PORT: port,
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    SESSION_SECRET: 'console-e2e-session-secret-not-for-production',
    CONSOLE_DIST: consoleDist,
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
    SHIPYARD_VERSION: 'console-e2e',
    BACKUP_DIR: backupDir,
    // Nothing leaves the machine: no D3 Auth, no Foreman, no mail relay, no GitHub token.
    D3AUTH_ISSUER: '',
    D3AUTH_CLIENT_ID: '',
    D3AUTH_CLIENT_SECRET: '',
    FOREMAN_URL: '',
    FOREMAN_TOKEN: '',
    GITHUB_TOKEN_SERVER: '',
    MAIL_RELAY_URL: '',
    MAIL_RELAY_TOKEN: '',
    ALERT_TO: '',
    TRUST_PROXY_HOPS: '',
  },
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.kill(signal);
  });
}
server.on('exit', (code, signal) => {
  process.exit(code ?? (signal === null ? 0 : 1));
});
