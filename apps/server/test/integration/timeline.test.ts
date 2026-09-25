import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { ServiceDeps } from '../../src/deps.js';
import { Bus } from '../../src/events.js';
import type { ForemanStatus, TimelineItem, TimelinePage } from '../../src/deploys/timeline.js';

/** SHP-T-3.7: `GET /api/deploys/timeline` (S8) and `GET /api/deploys/:id/foreman` (S6). */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });

type Role = 'admin' | 'operator' | 'deployer' | 'viewer';

const SHA = 'a'.repeat(40);

let bus: Bus;
let app: Express;

async function signIn(role: Role): Promise<{ cookie: string }> {
  const email = `${role}-${randomUUID()}@example.com`;
  const user = await db.user.create({ data: { email, displayName: role, role } });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return { cookie: `${SESSION_COOKIE}=${session.token}` };
}

async function issueToken(cookie: string, apps: string[]): Promise<string> {
  const res = await request(app).post('/api/tokens').set('Cookie', cookie).send({ label: 'mcp', apps });
  expect(res.status).toBe(201);
  return (res.body as { token: string }).token;
}

async function seedApps(...names: string[]): Promise<Map<string, string>> {
  const agent = await db.agent.create({ data: { publicKey: 'test-key', fingerprint: `fp-${randomUUID()}` } });
  const ids = new Map<string, string>();
  for (const name of names) {
    const row = await db.app.create({
      data: { name, agentId: agent.id, manifestYaml: `name: ${name}\n`, manifestSha256: '0'.repeat(64), reportedAt: new Date() },
    });
    ids.set(name, row.id);
  }
  return ids;
}

interface SeedTargetInput {
  appId: string;
  kind?: 'deploy' | 'rollback' | 'restore';
  state:
    | 'queued'
    | 'awaiting_approval'
    | 'locked'
    | 'verifying'
    | 'backing_up'
    | 'migrating'
    | 'pulling'
    | 'swapping'
    | 'checking'
    | 'soaking'
    | 'rolling_back'
    | 'succeeded'
    | 'failed'
    | 'rolled_back'
    | 'refused'
    | 'cancelled';
  requesterLabel: string;
  dryRun?: boolean;
  createdAt?: Date;
  refusal?: { code: string; gate: string; message: string; fix: string };
}

/** Writes a deploy + its one target directly, bypassing the service layer for full state control. */
async function seedTarget(input: SeedTargetInput): Promise<{ deployId: string; targetId: string }> {
  const deploy = await db.deploy.create({
    data: {
      kind: input.kind ?? 'deploy',
      requestedSha: SHA,
      dryRun: input.dryRun ?? false,
      requesterLabel: input.requesterLabel,
      ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
      targets: {
        create: {
          appId: input.appId,
          state: input.state,
          ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
          ...(input.refusal !== undefined ? { refusal: input.refusal } : {}),
          ...(['succeeded', 'failed', 'rolled_back', 'refused', 'cancelled'].includes(input.state)
            ? { endedAt: input.createdAt ?? new Date() }
            : {}),
        },
      },
    },
    include: { targets: true },
  });
  const target = deploy.targets[0];
  if (target === undefined) throw new Error('target not created');
  return { deployId: deploy.id, targetId: target.id };
}

let appIds: Map<string, string>;

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "target_image", "step", "outbox", "deploy_target", "deploy", "audit_event", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  appIds = await seedApps('web', 'api', 'billing');
  bus = new Bus();
  const deps: ServiceDeps = { db, logger, config, bus };
  app = createApp(deps);
});

afterAll(async () => {
  await db.$disconnect();
});

describe('GET /api/deploys/timeline (SHP-REQ-062)', () => {
  /**
   * Twelve deploys across three apps, three requesters and every outcome (five terminal states
   * plus one non-terminal "active" state per app — the partial unique index allows only one
   * active target per app at a time).
   */
  async function seedFixture(): Promise<Record<string, { deployId: string; targetId: string }>> {
    const web = appIds.get('web') ?? '';
    const api = appIds.get('api') ?? '';
    const billing = appIds.get('billing') ?? '';
    const t0 = new Date('2026-01-01T00:00:00.000Z').getTime();
    const at = (n: number) => new Date(t0 + n * 60_000);

    const rows: Record<string, { deployId: string; targetId: string }> = {};
    rows['web-succeeded-alice'] = await seedTarget({
      appId: web,
      state: 'succeeded',
      requesterLabel: 'Alice',
      kind: 'deploy',
      createdAt: at(1),
    });
    rows['web-failed-bob'] = await seedTarget({
      appId: web,
      state: 'failed',
      requesterLabel: 'Bob',
      kind: 'deploy',
      createdAt: at(2),
    });
    rows['web-active-carol'] = await seedTarget({
      appId: web,
      state: 'pulling',
      requesterLabel: 'Carol',
      kind: 'rollback',
      createdAt: at(3),
    });
    rows['web-failed-carol'] = await seedTarget({
      appId: web,
      state: 'failed',
      requesterLabel: 'Carol',
      kind: 'deploy',
      createdAt: at(4),
    });

    rows['api-rolled_back-alice'] = await seedTarget({
      appId: api,
      state: 'rolled_back',
      requesterLabel: 'Alice',
      kind: 'rollback',
      createdAt: at(5),
    });
    rows['api-refused-bob'] = await seedTarget({
      appId: api,
      state: 'refused',
      requesterLabel: 'Bob',
      kind: 'deploy',
      createdAt: at(6),
      refusal: { code: 'app_frozen', gate: 'G2', message: 'frozen', fix: 'unfreeze' },
    });
    rows['api-active-carol'] = await seedTarget({
      appId: api,
      state: 'locked',
      requesterLabel: 'Carol',
      kind: 'deploy',
      createdAt: at(7),
    });
    rows['api-dryrun-alice'] = await seedTarget({
      appId: api,
      state: 'succeeded',
      requesterLabel: 'Alice',
      kind: 'deploy',
      dryRun: true,
      createdAt: at(8),
    });

    rows['billing-cancelled-alice'] = await seedTarget({
      appId: billing,
      state: 'cancelled',
      requesterLabel: 'Alice',
      kind: 'deploy',
      createdAt: at(9),
    });
    rows['billing-succeeded-bob'] = await seedTarget({
      appId: billing,
      state: 'succeeded',
      requesterLabel: 'Bob',
      kind: 'rollback',
      createdAt: at(10),
    });
    rows['billing-active-carol'] = await seedTarget({
      appId: billing,
      state: 'soaking',
      requesterLabel: 'Carol',
      kind: 'deploy',
      createdAt: at(11),
    });
    rows['billing-refused-bob'] = await seedTarget({
      appId: billing,
      state: 'refused',
      requesterLabel: 'Bob',
      kind: 'rollback',
      createdAt: at(12),
      refusal: { code: 'locked', gate: 'G4', message: 'locked', fix: 'wait' },
    });

    return rows;
  }

  it('excludes dry runs by default, newest first (11 of 12 rows)', async () => {
    await seedFixture();
    const { cookie } = await signIn('viewer');
    const res = await request(app).get('/api/deploys/timeline').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const page = res.body as TimelinePage;
    expect(page.items).toHaveLength(11);
    expect(page.items.every((i) => !i.dryRun)).toBe(true);
    const createdAts = page.items.map((i) => i.createdAt);
    expect(createdAts).toEqual([...createdAts].sort().reverse());
  });

  it('dryRun=true includes the dry run', async () => {
    await seedFixture();
    const { cookie } = await signIn('viewer');
    const res = await request(app).get('/api/deploys/timeline?dryRun=true').set('Cookie', cookie);
    const page = res.body as TimelinePage;
    expect(page.items).toHaveLength(12);
    expect(page.items.some((i) => i.dryRun)).toBe(true);
  });

  it('filters by app', async () => {
    const rows = await seedFixture();
    const { cookie } = await signIn('viewer');
    const res = await request(app).get('/api/deploys/timeline?app=web').set('Cookie', cookie);
    const page = res.body as TimelinePage;
    expect(page.items.every((i) => i.app === 'web')).toBe(true);
    expect(page.items.map((i) => i.deployId).sort()).toEqual(
      [rows['web-succeeded-alice'], rows['web-failed-bob'], rows['web-active-carol'], rows['web-failed-carol']]
        .map((r) => r?.deployId ?? '')
        .sort(),
    );
  });

  it('filters by requester as a case-insensitive substring', async () => {
    await seedFixture();
    const { cookie } = await signIn('viewer');
    const res = await request(app).get('/api/deploys/timeline?requester=ali').set('Cookie', cookie);
    const page = res.body as TimelinePage;
    expect(page.items.every((i) => i.requesterLabel.toLowerCase().includes('ali'))).toBe(true);
    // Alice: web-succeeded, api-rolled_back, billing-cancelled (the dry run is excluded by default).
    expect(page.items).toHaveLength(3);
  });

  it('treats % and _ in the requester search as themselves, not wildcards', async () => {
    await seedFixture();
    const { cookie } = await signIn('viewer');
    for (const q of ['%25', 'A_ice', '%5C']) {
      const res = await request(app).get(`/api/deploys/timeline?requester=${q}`).set('Cookie', cookie);
      expect((res.body as TimelinePage).items, q).toHaveLength(0);
    }
  });

  it('filters by outcome, including active for every non-terminal state', async () => {
    await seedFixture();
    const { cookie } = await signIn('viewer');

    const succeeded = await request(app).get('/api/deploys/timeline?outcome=succeeded').set('Cookie', cookie);
    expect((succeeded.body as TimelinePage).items.every((i: TimelineItem) => i.state === 'succeeded')).toBe(true);
    expect((succeeded.body as TimelinePage).items).toHaveLength(2);

    const failed = await request(app).get('/api/deploys/timeline?outcome=failed').set('Cookie', cookie);
    expect((failed.body as TimelinePage).items).toHaveLength(2);

    const active = await request(app).get('/api/deploys/timeline?outcome=active').set('Cookie', cookie);
    const activeItems = (active.body as TimelinePage).items;
    expect(activeItems).toHaveLength(3);
    expect(activeItems.map((i) => i.state).sort()).toEqual(['locked', 'pulling', 'soaking']);

    const refused = await request(app).get('/api/deploys/timeline?outcome=refused').set('Cookie', cookie);
    expect((refused.body as TimelinePage).items.map((i: TimelineItem) => i.refusalCode).sort()).toEqual(['app_frozen', 'locked']);
  });

  it('filters by kind', async () => {
    await seedFixture();
    const { cookie } = await signIn('viewer');
    const res = await request(app).get('/api/deploys/timeline?kind=rollback').set('Cookie', cookie);
    const page = res.body as TimelinePage;
    expect(page.items.every((i) => i.kind === 'rollback')).toBe(true);
    // rollback: web-active-carol, api-rolled_back-alice, billing-succeeded-bob, billing-refused-bob
    expect(page.items).toHaveLength(4);
  });

  it('combines app + outcome + requester to exactly the matching rows', async () => {
    const rows = await seedFixture();
    const { cookie } = await signIn('viewer');
    const res = await request(app)
      .get('/api/deploys/timeline?app=web&outcome=failed&requester=carol')
      .set('Cookie', cookie);
    const page = res.body as TimelinePage;
    expect(page.items.map((i) => i.deployId)).toEqual([rows['web-failed-carol']?.deployId]);
  });

  it('paginates with no duplicates or gaps', async () => {
    await seedFixture();
    const { cookie } = await signIn('viewer');
    const full = await request(app).get('/api/deploys/timeline').set('Cookie', cookie);
    const all = (full.body as TimelinePage).items;
    expect(all).toHaveLength(11);

    const collected: TimelineItem[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const url: string = `/api/deploys/timeline?limit=3${cursor !== null ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await request(app).get(url).set('Cookie', cookie);
      const page = res.body as TimelinePage;
      collected.push(...page.items);
      cursor = page.nextCursor;
      guard += 1;
    } while (cursor !== null && guard < 20);

    expect(collected.map((i) => i.deployId)).toEqual(all.map((i) => i.deployId));
    const ids = new Set(collected.map((i) => i.deployId));
    expect(ids.size).toBe(collected.length);
  });

  it('limits a token to its scoped apps, and refuses an out-of-scope app filter', async () => {
    await seedFixture();
    const { cookie } = await signIn('deployer');
    const token = await issueToken(cookie, ['web']);
    const res = await request(app).get('/api/deploys/timeline').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect((res.body as TimelinePage).items.every((i) => i.app === 'web')).toBe(true);

    const forbidden = await request(app).get('/api/deploys/timeline?app=api').set('Authorization', `Bearer ${token}`);
    expect(forbidden.status).toBe(403);
  });

  it('refuses an anonymous caller and a malformed outcome', async () => {
    const anon = await request(app).get('/api/deploys/timeline');
    expect(anon.status).toBe(401);

    const { cookie } = await signIn('viewer');
    const bad = await request(app).get('/api/deploys/timeline?outcome=nonsense').set('Cookie', cookie);
    expect(bad.status).toBe(400);
  });
});

describe('GET /api/deploys/:id/foreman (S6)', () => {
  it('empty when the app has no Foreman mapping', async () => {
    const web = appIds.get('web') ?? '';
    const { deployId } = await seedTarget({ appId: web, state: 'succeeded', requesterLabel: 'Alice' });
    const { cookie } = await signIn('viewer');
    const res = await request(app).get(`/api/deploys/${deployId}/foreman`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as ForemanStatus;
    expect(body.posts).toEqual([]);
    expect(body.stuck).toBe(false);
  });

  it('shows delivered, pending and stuck posts', async () => {
    const web = appIds.get('web') ?? '';
    const { deployId, targetId } = await seedTarget({ appId: web, state: 'succeeded', requesterLabel: 'Alice' });

    await db.outbox.create({
      data: {
        targetId,
        idempotencyKey: `${targetId}:web`,
        payload: { note: 'x' },
        attempts: 1,
        deliveredAt: new Date(),
        createdAt: new Date(),
      },
    });
    await db.outbox.create({
      data: {
        targetId,
        idempotencyKey: `${targetId}:worker`,
        payload: { note: 'y' },
        attempts: 0,
        createdAt: new Date(),
      },
    });
    const stuckAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await db.outbox.create({
      data: {
        targetId,
        idempotencyKey: `${targetId}:cron`,
        payload: { note: 'z' },
        attempts: 3,
        lastError: 'HTTP 503',
        createdAt: stuckAt,
        nextAt: stuckAt,
      },
    });

    const { cookie } = await signIn('viewer');
    const res = await request(app).get(`/api/deploys/${deployId}/foreman`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as ForemanStatus;
    expect(body.posts).toHaveLength(3);
    expect(body.stuck).toBe(true);

    const web1 = body.posts.find((p) => p.service === 'web');
    expect(web1?.delivered).toBe(true);
    const worker = body.posts.find((p) => p.service === 'worker');
    expect(worker?.delivered).toBe(false);
    const cron = body.posts.find((p) => p.service === 'cron');
    expect(cron?.delivered).toBe(false);
    expect(cron?.lastError).toBe('HTTP 503');
    expect(cron?.attempts).toBe(3);
  });

  it('404s for no such deploy, 403s out of a token scope', async () => {
    const { cookie } = await signIn('viewer');
    expect((await request(app).get(`/api/deploys/${randomUUID()}/foreman`).set('Cookie', cookie)).status).toBe(404);

    const web = appIds.get('web') ?? '';
    const { deployId } = await seedTarget({ appId: web, state: 'succeeded', requesterLabel: 'Alice' });
    const deployer = await signIn('deployer');
    const token = await issueToken(deployer.cookie, ['api']);
    const res = await request(app).get(`/api/deploys/${deployId}/foreman`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
