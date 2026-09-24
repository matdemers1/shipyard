import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { totpCode, verifyPassword, verifyTotp } from '../../src/auth/index.js';
import { AlreadyBootstrapped, bootstrapAdmin } from '../../src/cli/bootstrap-admin.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });

const PASSWORD = 'correct horse battery staple';

beforeEach(async () => {
  await db.$executeRawUnsafe('truncate table "audit_event" cascade');
  await db.$executeRawUnsafe('truncate table "user" cascade');
});

afterAll(async () => {
  await db.$disconnect();
});

describe('bootstrapAdmin', () => {
  it('creates the first admin on an empty database', async () => {
    const result = await bootstrapAdmin(db, {
      email: 'Admin@Example.com',
      name: 'The Admin',
      password: PASSWORD,
    });

    const user = await db.user.findUnique({ where: { id: result.userId } });
    expect(user).not.toBeNull();
    expect(user?.email).toBe('admin@example.com');
    expect(user?.role).toBe('admin');
    expect(user?.totpEnabledAt).not.toBeNull();
    expect(user?.passwordHash).not.toBeNull();
    expect(await verifyPassword(user?.passwordHash ?? '', PASSWORD)).toBe(true);
    expect(verifyTotp(result.secret, totpCode(result.secret))).toBe(true);
    expect(result.totpUri.startsWith('otpauth://')).toBe(true);

    const rows = await db.auditEvent.findMany({ where: { entityType: 'user', entityId: result.userId } });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.actorType).toBe('system');
    expect(row?.actorLabel).toBe('bootstrap-admin');
    expect(row?.action).toBe('user.bootstrap');
    const after = row?.after as { email?: string; role?: string } | null;
    expect(after).toEqual({ email: 'admin@example.com', role: 'admin' });
    expect(JSON.stringify(row?.after ?? {})).not.toContain(result.secret);
  });

  it('refuses a second call, leaving exactly one user', async () => {
    await bootstrapAdmin(db, { email: 'first@example.com', name: 'First', password: PASSWORD });
    await expect(
      bootstrapAdmin(db, { email: 'second@example.com', name: 'Second', password: PASSWORD }),
    ).rejects.toBeInstanceOf(AlreadyBootstrapped);

    const users = await db.user.findMany();
    expect(users).toHaveLength(1);
    expect(users[0]?.email).toBe('first@example.com');
  });

  it('lets exactly one of two concurrent calls succeed', async () => {
    const results = await Promise.allSettled([
      bootstrapAdmin(db, { email: 'race-a@example.com', name: 'Race A', password: PASSWORD }),
      bootstrapAdmin(db, { email: 'race-b@example.com', name: 'Race B', password: PASSWORD }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AlreadyBootstrapped);

    const users = await db.user.findMany();
    expect(users).toHaveLength(1);
  });

  it('refuses a password shorter than 12 characters', async () => {
    await expect(
      bootstrapAdmin(db, { email: 'short@example.com', name: 'Short', password: 'tooshort1' }),
    ).rejects.toThrow(/at least 12 characters/);
    const users = await db.user.findMany();
    expect(users).toHaveLength(0);
  });

  it('lets the created account sign in through the dual-login flow', async () => {
    const result = await bootstrapAdmin(db, {
      email: 'signin@example.com',
      name: 'Sign In',
      password: PASSWORD,
    });

    const app = createApp({ db, logger: pino({ enabled: false }), config });
    const agent = request.agent(app);
    const step1 = await agent.post('/api/auth/login').send({ email: 'signin@example.com', password: PASSWORD });
    expect(step1.status).toBe(200);
    expect(step1.body).toEqual({ next: 'totp' });

    const step2 = await agent.post('/api/auth/totp').send({ code: totpCode(result.secret) });
    expect(step2.status).toBe(200);
    const body = step2.body as { id: string; email: string; role: string };
    expect(body.id).toBe(result.userId);
    expect(body.email).toBe('signin@example.com');
    expect(body.role).toBe('admin');
  });
});

describe('bootstrap-admin CLI', () => {
  const require_ = createRequire(import.meta.url);

  function tsxLoader(): string {
    return require_.resolve('tsx');
  }

  // Spawning the CLI resolves `@shipyard/schema` through its package export, which points at
  // dist/ (see the package's `exports.default`); the vitest alias that lets the in-process tests
  // above use src/ directly does not apply to a spawned process.
  beforeAll(() => {
    const result = spawnSync('pnpm', ['--filter', '@shipyard/schema', 'build'], {
      cwd: join(import.meta.dirname, '../../../..'),
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`failed to build @shipyard/schema:\n${result.stderr}${result.stdout}`);
    }
  });

  function runCli(args: string[], env: Record<string, string | undefined>): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(
      process.execPath,
      ['--import', tsxLoader(), join(import.meta.dirname, '../../src/cli/bootstrap-admin.ts'), ...args],
      {
        cwd: join(import.meta.dirname, '../..'),
        env: { ...process.env, ...env },
        encoding: 'utf8',
      },
    );
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it(
    'creates the account on the first run and refuses the second',
    () => {
      const env = {
        DATABASE_URL: databaseUrl,
        BOOTSTRAP_PASSWORD: PASSWORD,
      };

      const first = runCli(['--email', 'cli@example.com', '--name', 'CLI Admin'], env);
      expect(first.status).toBe(0);
      expect(first.stdout).toContain('otpauth://');

      const second = runCli(['--email', 'cli2@example.com', '--name', 'CLI Admin 2'], env);
      expect(second.status).toBe(1);
      expect(second.stderr).toContain('an account already exists; bootstrap-admin only creates the first one');
    },
    20_000,
  );

  it(
    'rejects an unknown --password flag without reading it',
    () => {
      const result = runCli(['--email', 'nope@example.com', '--name', 'Nope', '--password', 'whatever12345'], {
        DATABASE_URL: databaseUrl,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/password may not be passed as an argument/);

      // No BOOTSTRAP_PASSWORD and no TTY, so even a valid pair of flags should not have created a user.
    },
    20_000,
  );
});
