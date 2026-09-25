import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitHubPort } from '@shipyard/sequence/github';
import { Bus } from '../../src/events.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { drainOnce, enqueueDeployment, outboxStats } from '../../src/outbox/index.js';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const logger = pino({ enabled: false });

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'truncate table "outbox", "step", "target_image", "deploy_target", "deploy", ' +
      '"api_token_app", "api_token", "session", "identity", "agent", "app", "user", "audit_event" cascade',
  );
}

async function makeAgent(): Promise<string> {
  const agent = await db.agent.create({
    data: { publicKey: 'base64-key', fingerprint: `fp-${randomUUID()}` },
  });
  return agent.id;
}

async function makeApp(
  agentId: string,
  overrides: {
    name?: string;
    foremanProject?: string | null;
    foremanEnvironment?: string | null;
    repo?: string | null;
    defaultBranch?: string | null;
  } = {},
): Promise<string> {
  const app = await db.app.create({
    data: {
      name: overrides.name ?? `app-${randomUUID()}`,
      agentId,
      manifestYaml: 'services: {}',
      manifestSha256: 'a'.repeat(64),
      foremanProject: 'foremanProject' in overrides ? overrides.foremanProject : 'SHP',
      foremanEnvironment: 'foremanEnvironment' in overrides ? overrides.foremanEnvironment : null,
      repo: overrides.repo ?? null,
      defaultBranch: overrides.defaultBranch ?? null,
    },
  });
  return app.id;
}

async function makeDeploy(overrides: { requestedSha?: string; kind?: 'deploy' | 'rollback' | 'restore' } = {}): Promise<string> {
  const deploy = await db.deploy.create({
    data: { requestedSha: overrides.requestedSha ?? 'a'.repeat(40), requesterLabel: 'test', kind: overrides.kind ?? 'deploy' },
  });
  return deploy.id;
}

async function makeSucceededTarget(
  appId: string,
  deployId: string,
  images: { service: string; repo: string; sha: string; digest: string }[],
  overrides: { liveShaBefore?: string | null } = {},
): Promise<string> {
  const target = await db.deployTarget.create({
    data: {
      deployId,
      appId,
      state: 'succeeded',
      endedAt: new Date(),
      liveShaBefore: overrides.liveShaBefore ?? null,
    },
  });
  if (images.length > 0) {
    await db.targetImage.createMany({
      data: images.map((image) => ({ ...image, targetId: target.id })),
    });
  }
  return target.id;
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

// ─── A fake Foreman HTTP server ────────────────────────────────────────────

interface FakeDeploymentRecord {
  note: string;
  imageSha: string;
  environment: string;
}

class FakeForeman {
  server: http.Server;
  url = '';
  posts: { path: string; body: unknown; auth: string | undefined }[] = [];
  gets: { path: string }[] = [];
  deployments: FakeDeploymentRecord[] = [];
  /** Queue of status codes to return for the *next* POSTs, in order; after the queue is drained,
   * every POST returns 201 and is recorded. */
  postStatusQueue: (number | 'lose')[] = [];

  constructor() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        const path = req.url ?? '';

        if (req.method === 'GET' && path.includes('/deployments')) {
          this.gets.push({ path });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ items: this.deployments }));
          return;
        }

        if (req.method === 'POST' && path.includes('/deployments')) {
          const body: unknown = bodyText.length > 0 ? JSON.parse(bodyText) : {};
          this.posts.push({ path, body, auth: req.headers.authorization });

          const next = this.postStatusQueue.shift();
          if (next === 'lose') {
            // "Lost response": Foreman records the deployment but the client never sees success.
            const b = body as { note: string; imageSha: string; environment: string };
            this.deployments.push({ note: b.note, imageSha: b.imageSha, environment: b.environment });
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'lost response' }));
            return;
          }
          if (next !== undefined) {
            res.writeHead(next, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'simulated failure' }));
            return;
          }

          const b = body as { note: string; imageSha: string; environment: string };
          this.deployments.push({ note: b.note, imageSha: b.imageSha, environment: b.environment });
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: randomUUID() }));
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

function deps(foremanUrl?: string): { db: Db; logger: typeof logger; config: ReturnType<typeof loadConfig>; bus: Bus } {
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    ...(foremanUrl === undefined ? {} : { FOREMAN_URL: foremanUrl, FOREMAN_TOKEN: 'test-token' }),
  });
  return { db, logger, config, bus: new Bus() };
}

let fake: FakeForeman | undefined;

afterEach(async () => {
  if (fake !== undefined) {
    await fake.stop();
    fake = undefined;
  }
});

describe('enqueueDeployment', () => {
  it('inserts one row per image, idempotent by targetId:service', async () => {
    const agentId = await makeAgent();
    const appId = await makeApp(agentId);
    const deployId = await makeDeploy();
    const targetId = await makeSucceededTarget(appId, deployId, [
      { service: 'web', repo: 'ghcr.io/x/web', sha: 'a'.repeat(40), digest: 'sha256:aaa' },
      { service: 'worker', repo: 'ghcr.io/x/worker', sha: 'b'.repeat(40), digest: 'sha256:bbb' },
    ]);

    const inserted = await enqueueDeployment(db, targetId);
    expect(inserted).toBe(2);

    const rows = await db.outbox.findMany({ where: { targetId } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.idempotencyKey).sort()).toEqual([`${targetId}:web`, `${targetId}:worker`].sort());

    // Calling it again does not duplicate rows.
    const insertedAgain = await enqueueDeployment(db, targetId);
    expect(insertedAgain).toBe(0);
    const rowsAgain = await db.outbox.findMany({ where: { targetId } });
    expect(rowsAgain).toHaveLength(2);
  });

  it('inserts nothing for an app with no foremanProject (SHP-D-062)', async () => {
    const agentId = await makeAgent();
    const appId = await makeApp(agentId, { foremanProject: null });
    const deployId = await makeDeploy();
    const targetId = await makeSucceededTarget(appId, deployId, [
      { service: 'web', repo: 'ghcr.io/x/web', sha: 'a'.repeat(40), digest: 'sha256:aaa' },
    ]);

    const inserted = await enqueueDeployment(db, targetId);
    expect(inserted).toBe(0);
    const rows = await db.outbox.findMany({ where: { targetId } });
    expect(rows).toHaveLength(0);
  });
});

describe('drainOnce', () => {
  it('drains after a simulated Foreman outage (503 x3 then 201), exactly one post per image', async () => {
    fake = new FakeForeman();
    await fake.start();
    fake.postStatusQueue = [503, 503, 503];

    const agentId = await makeAgent();
    const appId = await makeApp(agentId);
    const deployId = await makeDeploy();
    const targetId = await makeSucceededTarget(appId, deployId, [
      { service: 'web', repo: 'ghcr.io/x/web', sha: 'a'.repeat(40), digest: 'sha256:aaa' },
    ]);
    await enqueueDeployment(db, targetId);

    const d = deps(fake.url);
    let now = new Date();

    // Attempt 1: fails (503).
    await drainOnce(d, { now });
    let row = await db.outbox.findFirstOrThrow({ where: { targetId } });
    expect(row.deliveredAt).toBeNull();
    expect(row.attempts).toBe(1);

    // Attempt 2: fails (503). Advance past nextAt each time.
    now = new Date(row.nextAt.getTime() + 1);
    await drainOnce(d, { now });
    row = await db.outbox.findFirstOrThrow({ where: { targetId } });
    expect(row.deliveredAt).toBeNull();
    expect(row.attempts).toBe(2);

    // Attempt 3: fails (503).
    now = new Date(row.nextAt.getTime() + 1);
    await drainOnce(d, { now });
    row = await db.outbox.findFirstOrThrow({ where: { targetId } });
    expect(row.deliveredAt).toBeNull();
    expect(row.attempts).toBe(3);

    // Attempt 4: succeeds (201).
    now = new Date(row.nextAt.getTime() + 1);
    await drainOnce(d, { now });
    row = await db.outbox.findFirstOrThrow({ where: { targetId } });
    expect(row.deliveredAt).not.toBeNull();

    expect(fake.posts).toHaveLength(4);
    expect(fake.deployments).toHaveLength(1);
  });

  it('the lost-response case: a delivered-but-unseen post is found via GET and not duplicated', async () => {
    fake = new FakeForeman();
    await fake.start();
    fake.postStatusQueue = ['lose'];

    const agentId = await makeAgent();
    const appId = await makeApp(agentId);
    const deployId = await makeDeploy();
    const targetId = await makeSucceededTarget(appId, deployId, [
      { service: 'web', repo: 'ghcr.io/x/web', sha: 'a'.repeat(40), digest: 'sha256:aaa' },
    ]);
    await enqueueDeployment(db, targetId);

    const d = deps(fake.url);
    let now = new Date();

    // Attempt 1: the fake records the deployment but returns 500 ("lost response").
    await drainOnce(d, { now });
    let row = await db.outbox.findFirstOrThrow({ where: { targetId } });
    expect(row.deliveredAt).toBeNull();
    expect(row.attempts).toBe(1);
    expect(fake.posts).toHaveLength(1);
    expect(fake.deployments).toHaveLength(1);

    // Attempt 2: finds the existing deployment via GET (matching note) and marks delivered
    // without a second POST.
    now = new Date(row.nextAt.getTime() + 1);
    await drainOnce(d, { now });
    row = await db.outbox.findFirstOrThrow({ where: { targetId } });
    expect(row.deliveredAt).not.toBeNull();

    expect(fake.posts).toHaveLength(1); // no second POST
    expect(fake.deployments).toHaveLength(1); // no duplicate deployment
    expect(fake.gets.length).toBeGreaterThan(0);
  });

  it('a key that is a prefix of another is never taken as delivered by the other one', async () => {
    fake = new FakeForeman();
    await fake.start();
    // web2 lands on the first try; web fails once, so its retry consults Foreman's notes.
    const agentId = await makeAgent();
    const appId = await makeApp(agentId);
    const deployId = await makeDeploy();
    const targetId = await makeSucceededTarget(appId, deployId, [
      { service: 'web', repo: 'ghcr.io/x/web', sha: 'a'.repeat(40), digest: 'sha256:aaa' },
      { service: 'web2', repo: 'ghcr.io/x/web2', sha: 'a'.repeat(40), digest: 'sha256:bbb' },
    ]);
    await enqueueDeployment(db, targetId);
    const d = deps(fake.url);

    // Deliver web2 alone first, and make web's first attempt fail.
    await db.outbox.updateMany({ where: { targetId, idempotencyKey: `${targetId}:web` }, data: { nextAt: new Date(Date.now() + 60_000) } });
    await drainOnce(d, { now: new Date() });
    await db.outbox.updateMany({ where: { targetId, idempotencyKey: `${targetId}:web` }, data: { nextAt: new Date(0), attempts: 1 } });

    await drainOnce(d, { now: new Date() });
    const web = await db.outbox.findFirstOrThrow({ where: { idempotencyKey: `${targetId}:web` } });
    expect(web.deliveredAt).not.toBeNull();
    // web was really posted — not "found" through web2's note.
    expect(fake.deployments.map((x) => x.imageSha).sort()).toEqual(['sha256:aaa', 'sha256:bbb']);
  });

  it('two concurrent drainOnce calls post each row exactly once', async () => {
    fake = new FakeForeman();
    await fake.start();

    const agentId = await makeAgent();
    const appId = await makeApp(agentId);
    const deployId = await makeDeploy();
    const targetId = await makeSucceededTarget(appId, deployId, [
      { service: 'web', repo: 'ghcr.io/x/web', sha: 'a'.repeat(40), digest: 'sha256:aaa' },
      { service: 'worker', repo: 'ghcr.io/x/worker', sha: 'b'.repeat(40), digest: 'sha256:bbb' },
      { service: 'db-migrator', repo: 'ghcr.io/x/migrator', sha: 'c'.repeat(40), digest: 'sha256:ccc' },
    ]);
    await enqueueDeployment(db, targetId);

    const d = deps(fake.url);
    const now = new Date();

    await Promise.all([drainOnce(d, { now }), drainOnce(d, { now })]);

    const rows = await db.outbox.findMany({ where: { targetId } });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.deliveredAt).not.toBeNull();
    }
    expect(fake.posts).toHaveLength(3);
    expect(fake.deployments).toHaveLength(3);
  });

  it('leaves rows queued when FOREMAN_URL/FOREMAN_TOKEN are unset', async () => {
    const agentId = await makeAgent();
    const appId = await makeApp(agentId);
    const deployId = await makeDeploy();
    const targetId = await makeSucceededTarget(appId, deployId, [
      { service: 'web', repo: 'ghcr.io/x/web', sha: 'a'.repeat(40), digest: 'sha256:aaa' },
    ]);
    await enqueueDeployment(db, targetId);

    const d = deps(); // no FOREMAN_URL/FOREMAN_TOKEN
    const result = await drainOnce(d);
    expect(result.processed).toBe(0);

    const row = await db.outbox.findFirstOrThrow({ where: { targetId } });
    expect(row.deliveredAt).toBeNull();
    expect(row.attempts).toBe(0);
  });
});

// ─── A fake GitHubPort ──────────────────────────────────────────────────────

class FakeGitHub implements GitHubPort {
  compareResult: Awaited<ReturnType<GitHubPort['compare']>> = null;
  calls = 0;
  ranges: string[] = [];

  compare(_repo: string, base: string, head: string): ReturnType<GitHubPort['compare']> {
    this.calls++;
    this.ranges.push(`${base}..${head}`);
    return Promise.resolve(this.compareResult);
  }

  workflowRuns(): ReturnType<GitHubPort['workflowRuns']> {
    return Promise.resolve([]);
  }
}

describe('drainOnce — Foreman tasks cited (SHP-T-5.9, SHP-REQ-088)', () => {
  it('POSTs the cited task IDs, filtered to the app\'s own Foreman project', async () => {
    fake = new FakeForeman();
    await fake.start();

    const github = new FakeGitHub();
    github.compareResult = {
      status: 'ahead',
      aheadBy: 2,
      behindBy: 0,
      commits: [
        { sha: 'b'.repeat(40), message: 'SHP-T-5.8: changelog helper' },
        { sha: 'c'.repeat(40), message: 'FRM-T-006: deployments accept tasks\n\nAlso SHP-T-5.9.' },
      ],
    };

    const agentId = await makeAgent();
    const appId = await makeApp(agentId, { repo: 'matdemers1/shipyard', defaultBranch: 'main' });
    const deployId = await makeDeploy({ requestedSha: 'c'.repeat(40) });
    const targetId = await makeSucceededTarget(
      appId,
      deployId,
      [{ service: 'web', repo: 'ghcr.io/x/web', sha: 'c'.repeat(40), digest: 'sha256:ccc' }],
      { liveShaBefore: 'a'.repeat(40) },
    );
    await enqueueDeployment(db, targetId);

    const d = deps(fake.url);
    await drainOnce(d, { now: new Date(), github });

    expect(fake.posts).toHaveLength(1);
    const body = fake.posts[0]?.body as { tasks?: string[] };
    expect(body.tasks).toEqual(['SHP-T-5.8', 'SHP-T-5.9']);
    expect(github.calls).toBe(1);
  });

  it('sends no tasks for a rollback — a rollback ships nothing new', async () => {
    fake = new FakeForeman();
    await fake.start();

    const github = new FakeGitHub();
    github.compareResult = {
      status: 'ahead',
      aheadBy: 1,
      behindBy: 0,
      commits: [{ sha: 'b'.repeat(40), message: 'SHP-T-5.8: changelog helper' }],
    };

    const agentId = await makeAgent();
    const appId = await makeApp(agentId, { repo: 'matdemers1/shipyard', defaultBranch: 'main' });
    const deployId = await makeDeploy({ requestedSha: 'a'.repeat(40), kind: 'rollback' });
    const targetId = await makeSucceededTarget(
      appId,
      deployId,
      [{ service: 'web', repo: 'ghcr.io/x/web', sha: 'a'.repeat(40), digest: 'sha256:aaa' }],
      { liveShaBefore: 'c'.repeat(40) },
    );
    await enqueueDeployment(db, targetId);

    const d = deps(fake.url);
    await drainOnce(d, { now: new Date(), github });

    expect(fake.posts).toHaveLength(1);
    const body = fake.posts[0]?.body as { tasks?: string[] };
    expect(body.tasks).toBeUndefined();
    expect(github.calls).toBe(0);
  });

  it('a real deploy target (no liveShaBefore written) cites from the release that was live before it', async () => {
    fake = new FakeForeman();
    await fake.start();

    const github = new FakeGitHub();
    github.compareResult = {
      status: 'ahead',
      aheadBy: 1,
      behindBy: 0,
      commits: [{ sha: 'c'.repeat(40), message: 'SHP-T-5.9: cite shipped tasks' }],
    };

    const agentId = await makeAgent();
    const appId = await makeApp(agentId, { repo: 'matdemers1/shipyard', defaultBranch: 'main' });
    // The earlier release, then this one — as createDeploy and the agent's report leave them.
    await makeSucceededTarget(appId, await makeDeploy({ requestedSha: 'a'.repeat(40) }), [
      { service: 'web', repo: 'ghcr.io/x/web', sha: 'a'.repeat(40), digest: 'sha256:aaa' },
    ]);
    await new Promise((r) => setTimeout(r, 5));
    const targetId = await makeSucceededTarget(appId, await makeDeploy({ requestedSha: 'c'.repeat(40) }), [
      { service: 'web', repo: 'ghcr.io/x/web', sha: 'c'.repeat(40), digest: 'sha256:ccc' },
    ]);
    await enqueueDeployment(db, targetId);
    await drainOnce(deps(fake.url), { now: new Date(), github });

    expect(github.ranges).toEqual([`${'a'.repeat(40)}..${'c'.repeat(40)}`]);
    const post = fake.posts.find((p) => (p.body as { imageSha?: string }).imageSha === 'sha256:ccc');
    expect((post?.body as { tasks?: string[] }).tasks).toEqual(['SHP-T-5.9']);
  });

  it('sends no tasks on a first deploy (no liveShaBefore)', async () => {
    fake = new FakeForeman();
    await fake.start();

    const github = new FakeGitHub();
    const agentId = await makeAgent();
    const appId = await makeApp(agentId, { repo: 'matdemers1/shipyard', defaultBranch: 'main' });
    const deployId = await makeDeploy({ requestedSha: 'a'.repeat(40) });
    const targetId = await makeSucceededTarget(
      appId,
      deployId,
      [{ service: 'web', repo: 'ghcr.io/x/web', sha: 'a'.repeat(40), digest: 'sha256:aaa' }],
      { liveShaBefore: null },
    );
    await enqueueDeployment(db, targetId);

    const d = deps(fake.url);
    await drainOnce(d, { now: new Date(), github });

    expect(fake.posts).toHaveLength(1);
    const body = fake.posts[0]?.body as { tasks?: string[] };
    expect(body.tasks).toBeUndefined();
    expect(github.calls).toBe(0);
  });

  it('computes tasks once per range and reuses it across a retry, without a second GitHub call', async () => {
    fake = new FakeForeman();
    await fake.start();
    fake.postStatusQueue = [503];

    const github = new FakeGitHub();
    github.compareResult = {
      status: 'ahead',
      aheadBy: 1,
      behindBy: 0,
      commits: [{ sha: 'b'.repeat(40), message: 'SHP-T-5.8: changelog helper' }],
    };

    const agentId = await makeAgent();
    const appId = await makeApp(agentId, { repo: 'matdemers1/shipyard', defaultBranch: 'main' });
    const deployId = await makeDeploy({ requestedSha: 'c'.repeat(40) });
    const targetId = await makeSucceededTarget(
      appId,
      deployId,
      [{ service: 'web', repo: 'ghcr.io/x/web', sha: 'c'.repeat(40), digest: 'sha256:ccc' }],
      { liveShaBefore: 'a'.repeat(40) },
    );
    await enqueueDeployment(db, targetId);

    const d = deps(fake.url);
    let now = new Date();

    // First attempt: computes tasks (one GitHub call), then 503s and persists them.
    await drainOnce(d, { now, github });
    expect(github.calls).toBe(1);
    let row = await db.outbox.findFirstOrThrow({ where: { targetId } });
    expect(row.deliveredAt).toBeNull();
    expect((row.payload as { tasks?: string[] }).tasks).toEqual(['SHP-T-5.8']);

    // Retry: succeeds, and does not call GitHub again — the payload already carries `tasks`.
    now = new Date(row.nextAt.getTime() + 1);
    await drainOnce(d, { now, github });
    expect(github.calls).toBe(1);
    row = await db.outbox.findFirstOrThrow({ where: { targetId } });
    expect(row.deliveredAt).not.toBeNull();

    const body = fake.posts[fake.posts.length - 1]?.body as { tasks?: string[] };
    expect(body.tasks).toEqual(['SHP-T-5.8']);
  });
});

describe('outboxStats', () => {
  it('reports the count and oldest createdAt of undelivered rows', async () => {
    const agentId = await makeAgent();
    const appId = await makeApp(agentId);
    const deployId = await makeDeploy();
    const targetId = await makeSucceededTarget(appId, deployId, [
      { service: 'web', repo: 'ghcr.io/x/web', sha: 'a'.repeat(40), digest: 'sha256:aaa' },
    ]);

    const empty = await outboxStats(db);
    expect(empty.unsent).toBe(0);
    expect(empty.oldestUnsentAt).toBeNull();

    await enqueueDeployment(db, targetId);
    const stats = await outboxStats(db);
    expect(stats.unsent).toBe(1);
    expect(stats.oldestUnsentAt).not.toBeNull();
  });
});
