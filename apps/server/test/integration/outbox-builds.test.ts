import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Bus } from '../../src/events.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { drainOnce, outboxStats } from '../../src/outbox/index.js';
import { registerBuildNotifications } from '../../src/outbox/builds.js';
import { recordBuildProgress, recordBuildResult } from '../../src/builds/service.js';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const logger = pino({ enabled: false });

/**
 * SHP-T-7.15: `outbox.target_id` is `NOT NULL` today (a real migration is needed to make a
 * `github_status`/`foreman_build` row's `target_id` optional — see `outbox/builds.ts`'s module
 * doc, and `needsOutside` in this task's result). This relaxes the constraint on THIS PRIVATE test
 * database only, at run time — never a migration file, never touching `prisma/**`, never run
 * against a shared database. It is idempotent (`DROP NOT NULL` on an already-nullable column is a
 * no-op) and is exactly the migration reported under `needsOutside`.
 */
async function allowNullTargetId(): Promise<void> {
  await db.$executeRawUnsafe('ALTER TABLE "outbox" ALTER COLUMN "target_id" DROP NOT NULL');
}

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'truncate table "outbox", "build_log", "build_stage", "build", "step", "target_image", "deploy_target", "deploy", ' +
      '"api_token_app", "api_token", "session", "identity", "agent", "app", "user", "audit_event" cascade',
  );
}

async function makeAgent(): Promise<string> {
  const agent = await db.agent.create({ data: { publicKey: 'base64-key', fingerprint: `fp-${randomUUID()}` } });
  return agent.id;
}

async function makeApp(
  agentId: string,
  overrides: { name?: string; repo?: string | null; foremanProject?: string | null; foremanEnvironment?: string | null } = {},
): Promise<string> {
  const app = await db.app.create({
    data: {
      name: overrides.name ?? `app-${randomUUID()}`,
      agentId,
      manifestYaml: 'services: {}',
      manifestSha256: 'a'.repeat(64),
      repo: 'repo' in overrides ? overrides.repo : 'matdemers1/example',
      foremanProject: 'foremanProject' in overrides ? overrides.foremanProject : null,
      foremanEnvironment: 'foremanEnvironment' in overrides ? overrides.foremanEnvironment : null,
    },
  });
  return app.id;
}

async function makeRunningBuild(appId: string, sha = 'a'.repeat(40)): Promise<string> {
  const build = await db.build.create({
    data: {
      appId,
      sha,
      state: 'running',
      trigger: 'manual',
      requesterLabel: 'test',
      dispatchedAt: new Date(),
      startedAt: new Date(),
    },
  });
  return build.id;
}

beforeAll(async () => {
  await allowNullTargetId();
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

// ─── A fake GitHub statuses endpoint ────────────────────────────────────────

class FakeGitHub {
  server: http.Server;
  url = '';
  posts: { path: string; body: unknown; auth: string | undefined }[] = [];
  postStatusQueue: number[] = [];

  constructor() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        if (req.method === 'POST' && (req.url ?? '').includes('/statuses/')) {
          const body: unknown = bodyText.length > 0 ? JSON.parse(bodyText) : {};
          this.posts.push({ path: req.url ?? '', body, auth: req.headers.authorization });
          const next = this.postStatusQueue.shift();
          if (next !== undefined) {
            res.writeHead(next, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ message: 'simulated failure' }));
            return;
          }
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 1 }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${String(port)}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

let fakeGithub: FakeGitHub | undefined;

afterEach(async () => {
  if (fakeGithub !== undefined) {
    await fakeGithub.stop();
    fakeGithub = undefined;
  }
});

function deps(config: {
  githubTokenStatus?: string;
  githubTokenServer?: string;
  foremanUrl?: string;
  foremanToken?: string;
  publicUrl?: string;
}): { db: Db; logger: typeof logger; config: ReturnType<typeof loadConfig>; bus: Bus } {
  const loaded = loadConfig({
    DATABASE_URL: databaseUrl,
    ...(config.githubTokenStatus === undefined ? {} : { GITHUB_TOKEN_STATUS: config.githubTokenStatus }),
    ...(config.githubTokenServer === undefined ? {} : { GITHUB_TOKEN_SERVER: config.githubTokenServer }),
    ...(config.foremanUrl === undefined ? {} : { FOREMAN_URL: config.foremanUrl, FOREMAN_TOKEN: config.foremanToken ?? 'f-token' }),
    ...(config.publicUrl === undefined ? {} : { PUBLIC_URL: config.publicUrl }),
  });
  return { db, logger, config: loaded, bus: new Bus() };
}

describe('registerBuildNotifications — GitHub commit statuses (SHP-REQ-146)', () => {
  it('a succeeded test stage enqueues shipyard/test success, delivered with the status token', async () => {
    fakeGithub = new FakeGitHub();
    await fakeGithub.start();

    const agentId = await makeAgent();
    const appId = await makeApp(agentId);
    const buildId = await makeRunningBuild(appId, 'b'.repeat(40));

    const d = deps({ githubTokenStatus: 'status-token', githubTokenServer: 'server-token' });
    const unregister = registerBuildNotifications(d);
    try {
      await recordBuildProgress(d, { buildId, stage: 'test', state: 'succeeded', at: new Date().toISOString() });
    } finally {
      unregister();
    }

    const stats = await outboxStats(db);
    expect(stats.unsent).toBe(1);

    await drainOnce(d, { fetch, now: new Date(), githubApiBaseUrl: fakeGithub.url });

    expect(fakeGithub.posts).toHaveLength(1);
    expect(fakeGithub.posts[0]?.path).toBe(`/repos/matdemers1/example/statuses/${'b'.repeat(40)}`);
    expect(fakeGithub.posts[0]?.body).toMatchObject({ state: 'success', context: 'shipyard/test' });
    // The status token is used — never the read-only server token.
    expect(fakeGithub.posts[0]?.auth).toBe('Bearer status-token');

    const after = await outboxStats(db);
    expect(after.unsent).toBe(0);
  });

  it('a failed test stage enqueues shipyard/test failure', async () => {
    fakeGithub = new FakeGitHub();
    await fakeGithub.start();

    const agentId = await makeAgent();
    const appId = await makeApp(agentId);
    const buildId = await makeRunningBuild(appId);

    const d = deps({ githubTokenStatus: 'status-token' });
    const unregister = registerBuildNotifications(d);
    try {
      await recordBuildProgress(d, { buildId, stage: 'test', state: 'failed', at: new Date().toISOString() });
    } finally {
      unregister();
    }
    await drainOnce(d, { fetch, now: new Date(), githubApiBaseUrl: fakeGithub.url });

    expect(fakeGithub.posts).toHaveLength(1);
    expect(fakeGithub.posts[0]?.body).toMatchObject({ state: 'failure', context: 'shipyard/test' });
  });

  it('a skipped test stage posts nothing', async () => {
    const agentId = await makeAgent();
    const appId = await makeApp(agentId);
    const buildId = await makeRunningBuild(appId);

    const d = deps({ githubTokenStatus: 'status-token' });
    const unregister = registerBuildNotifications(d);
    try {
      await recordBuildProgress(d, { buildId, stage: 'test', state: 'skipped', at: new Date().toISOString() });
    } finally {
      unregister();
    }

    const stats = await outboxStats(db);
    expect(stats.unsent).toBe(0);
  });

  it('a build succeeding enqueues shipyard/build success with a target_url to the build', async () => {
    fakeGithub = new FakeGitHub();
    await fakeGithub.start();

    const agentId = await makeAgent();
    const appId = await makeApp(agentId);
    const buildId = await makeRunningBuild(appId, 'c'.repeat(40));

    const d = deps({ githubTokenStatus: 'status-token', publicUrl: 'https://shipyard.example' });
    const unregister = registerBuildNotifications(d);
    try {
      await recordBuildResult(d, { buildId, state: 'succeeded', digests: { web: 'sha256:' + 'a'.repeat(64) } });
    } finally {
      unregister();
    }
    await drainOnce(d, { fetch, now: new Date(), githubApiBaseUrl: fakeGithub.url });

    expect(fakeGithub.posts).toHaveLength(1);
    expect(fakeGithub.posts[0]?.body).toMatchObject({
      state: 'success',
      context: 'shipyard/build',
      target_url: `https://shipyard.example/builds/${buildId}`,
    });
  });

  it('a build failing at push enqueues shipyard/build failure at the stage boundary, ahead of the result', async () => {
    fakeGithub = new FakeGitHub();
    await fakeGithub.start();

    const agentId = await makeAgent();
    const appId = await makeApp(agentId);
    const buildId = await makeRunningBuild(appId);

    const d = deps({ githubTokenStatus: 'status-token' });
    const unregister = registerBuildNotifications(d);
    try {
      await recordBuildProgress(d, { buildId, stage: 'push', state: 'failed', at: new Date().toISOString() });
      await recordBuildResult(d, { buildId, state: 'failed', digests: {}, failedStage: 'push' });
    } finally {
      unregister();
    }
    await drainOnce(d, { fetch, now: new Date(), githubApiBaseUrl: fakeGithub.url });

    // One post from the stage boundary, one from the terminal result — both shipyard/build failure.
    expect(fakeGithub.posts).toHaveLength(2);
    for (const post of fakeGithub.posts) {
      expect(post.body).toMatchObject({ state: 'failure', context: 'shipyard/build' });
    }
  });

  it('a refused build posts shipyard/build error', async () => {
    fakeGithub = new FakeGitHub();
    await fakeGithub.start();

    const agentId = await makeAgent();
    const appId = await makeApp(agentId);
    const buildId = await makeRunningBuild(appId);

    const d = deps({ githubTokenStatus: 'status-token' });
    const unregister = registerBuildNotifications(d);
    try {
      await recordBuildResult(d, {
        buildId,
        state: 'refused',
        digests: {},
        refusal: { code: 'not_ahead_of_live', gate: 'G6', message: 'not ahead of live', fix: 'push a new commit' },
      });
    } finally {
      unregister();
    }
    await drainOnce(d, { fetch, now: new Date(), githubApiBaseUrl: fakeGithub.url });

    expect(fakeGithub.posts).toHaveLength(1);
    expect(fakeGithub.posts[0]?.body).toMatchObject({ state: 'error', context: 'shipyard/build', description: 'not ahead of live' });
  });

  it('a 5xx retries with backoff and is delivered once', async () => {
    fakeGithub = new FakeGitHub();
    await fakeGithub.start();
    fakeGithub.postStatusQueue = [503, 503];

    const agentId = await makeAgent();
    const appId = await makeApp(agentId);
    const buildId = await makeRunningBuild(appId);

    const d = deps({ githubTokenStatus: 'status-token' });
    const unregister = registerBuildNotifications(d);
    try {
      await recordBuildProgress(d, { buildId, stage: 'test', state: 'succeeded', at: new Date().toISOString() });
    } finally {
      unregister();
    }

    let now = new Date();
    await drainOnce(d, { fetch, now, githubApiBaseUrl: fakeGithub.url });
    let row = await db.outbox.findFirstOrThrow({ where: { idempotencyKey: `${buildId}:status:test` } });
    expect(row.deliveredAt).toBeNull();
    expect(row.attempts).toBe(1);

    now = new Date(row.nextAt.getTime() + 1);
    await drainOnce(d, { fetch, now, githubApiBaseUrl: fakeGithub.url });
    row = await db.outbox.findFirstOrThrow({ where: { idempotencyKey: `${buildId}:status:test` } });
    expect(row.deliveredAt).toBeNull();
    expect(row.attempts).toBe(2);

    now = new Date(row.nextAt.getTime() + 1);
    await drainOnce(d, { fetch, now, githubApiBaseUrl: fakeGithub.url });
    row = await db.outbox.findFirstOrThrow({ where: { idempotencyKey: `${buildId}:status:test` } });
    expect(row.deliveredAt).not.toBeNull();

    expect(fakeGithub.posts).toHaveLength(3);
  });

  it('a 4xx (not 429) is terminal: logged, parked, and never retried again', async () => {
    fakeGithub = new FakeGitHub();
    await fakeGithub.start();
    fakeGithub.postStatusQueue = [422];

    const agentId = await makeAgent();
    const appId = await makeApp(agentId);
    const buildId = await makeRunningBuild(appId);

    const d = deps({ githubTokenStatus: 'status-token' });
    const unregister = registerBuildNotifications(d);
    try {
      await recordBuildProgress(d, { buildId, stage: 'test', state: 'succeeded', at: new Date().toISOString() });
    } finally {
      unregister();
    }

    const now = new Date();
    await drainOnce(d, { fetch, now, githubApiBaseUrl: fakeGithub.url });
    const row = await db.outbox.findFirstOrThrow({ where: { idempotencyKey: `${buildId}:status:test` } });
    expect(row.deliveredAt).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('422');

    // Not due again for the backoff cap: a second drain right away makes no further POST.
    await drainOnce(d, { fetch, now, githubApiBaseUrl: fakeGithub.url });
    expect(fakeGithub.posts).toHaveLength(1);
  });

  it('no GITHUB_TOKEN_STATUS configured: no row is ever posted', async () => {
    fakeGithub = new FakeGitHub();
    await fakeGithub.start();

    const agentId = await makeAgent();
    const appId = await makeApp(agentId);
    const buildId = await makeRunningBuild(appId);

    const d = deps({}); // no GITHUB_TOKEN_STATUS
    const unregister = registerBuildNotifications(d);
    try {
      await recordBuildProgress(d, { buildId, stage: 'test', state: 'succeeded', at: new Date().toISOString() });
    } finally {
      unregister();
    }

    // The row is still enqueued (SHP-REQ-146 records intent) but never drained without a token.
    const stats = await outboxStats(db);
    expect(stats.unsent).toBe(1);

    const result = await drainOnce(d, { fetch, now: new Date(), githubApiBaseUrl: fakeGithub.url });
    expect(result.processed).toBe(0);
    expect(fakeGithub.posts).toHaveLength(0);

    const row = await db.outbox.findFirstOrThrow({ where: { idempotencyKey: `${buildId}:status:test` } });
    expect(row.deliveredAt).toBeNull();
    expect(row.attempts).toBe(0);
  });

  it('the read-only GITHUB_TOKEN_SERVER never appears in a commit-status POST', async () => {
    fakeGithub = new FakeGitHub();
    await fakeGithub.start();

    const agentId = await makeAgent();
    const appId = await makeApp(agentId);
    const buildId = await makeRunningBuild(appId);

    const d = deps({ githubTokenStatus: 'status-only-token', githubTokenServer: 'read-only-server-token' });
    const unregister = registerBuildNotifications(d);
    try {
      await recordBuildProgress(d, { buildId, stage: 'test', state: 'succeeded', at: new Date().toISOString() });
      await recordBuildResult(d, { buildId, state: 'succeeded', digests: { web: 'sha256:' + 'a'.repeat(64) } });
    } finally {
      unregister();
    }
    await drainOnce(d, { fetch, now: new Date(), githubApiBaseUrl: fakeGithub.url });

    expect(fakeGithub.posts.length).toBeGreaterThan(0);
    for (const post of fakeGithub.posts) {
      expect(post.auth).toBe('Bearer status-only-token');
      expect(post.auth).not.toContain('read-only-server-token');
    }
  });

  it('no app repo: no github_status row is enqueued', async () => {
    const agentId = await makeAgent();
    const appId = await makeApp(agentId, { repo: null });
    const buildId = await makeRunningBuild(appId);

    const d = deps({ githubTokenStatus: 'status-token' });
    const unregister = registerBuildNotifications(d);
    try {
      await recordBuildProgress(d, { buildId, stage: 'test', state: 'succeeded', at: new Date().toISOString() });
    } finally {
      unregister();
    }

    const stats = await outboxStats(db);
    expect(stats.unsent).toBe(0);
  });
});

describe('registerBuildNotifications — a Foreman build record through the outbox (SHP-REQ-147)', () => {
  it('a terminal build for an app with a Foreman project enqueues a foreman_build row', async () => {
    const agentId = await makeAgent();
    const appId = await makeApp(agentId, { foremanProject: 'SHP', foremanEnvironment: 'production' });
    const buildId = await makeRunningBuild(appId);

    const d = deps({});
    const unregister = registerBuildNotifications(d);
    try {
      await recordBuildResult(d, { buildId, state: 'succeeded', digests: { web: 'sha256:' + 'a'.repeat(64) } });
    } finally {
      unregister();
    }

    const row = await db.outbox.findFirstOrThrow({ where: { idempotencyKey: `${buildId}:foreman-build` } });
    expect(row.deliveredAt).toBeNull();
    expect(row.payload).toMatchObject({ kind: 'foreman_build', project: 'SHP', environment: 'production', state: 'succeeded' });

    // No Foreman endpoint for this exists yet (see needsOutside): the drain never claims it, so it
    // stays queued rather than erroring — "recorded through the outbox" without inventing an API.
    const result = await drainOnce(d, { fetch, now: new Date() });
    expect(result.processed).toBe(0);
    const after = await db.outbox.findFirstOrThrow({ where: { idempotencyKey: `${buildId}:foreman-build` } });
    expect(after.deliveredAt).toBeNull();
    expect(after.attempts).toBe(0);
  });

  it('no foremanProject on the app: no foreman_build row', async () => {
    const agentId = await makeAgent();
    const appId = await makeApp(agentId, { foremanProject: null });
    const buildId = await makeRunningBuild(appId);

    const d = deps({});
    const unregister = registerBuildNotifications(d);
    try {
      await recordBuildResult(d, { buildId, state: 'succeeded', digests: { web: 'sha256:' + 'a'.repeat(64) } });
    } finally {
      unregister();
    }

    const row = await db.outbox.findFirst({ where: { idempotencyKey: `${buildId}:foreman-build` } });
    expect(row).toBeNull();
  });
});
