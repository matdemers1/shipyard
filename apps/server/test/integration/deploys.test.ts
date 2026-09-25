import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { ACTIVE_STATES, type DeployAccepted, type DeployStatus, type Refusal } from '@shipyard/schema';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { ServiceDeps } from '../../src/deps.js';
import { createDeploy, isRefusal, type DeployCaller } from '../../src/deploys/service.js';
import { Bus } from '../../src/events.js';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });

type Role = 'admin' | 'operator' | 'deployer' | 'viewer';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b1c2d3e4f5'.repeat(4);

let bus: Bus;
let app: Express;
let deps: ServiceDeps;

function err(res: { body: unknown }): Refusal {
  return (res.body as { error: Refusal }).error;
}

async function signIn(role: Role): Promise<{ userId: string; email: string; cookie: string }> {
  const email = `${role}-${randomUUID()}@example.com`;
  const user = await db.user.create({ data: { email, displayName: role, role } });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return { userId: user.id, email, cookie: `${SESSION_COOKIE}=${session.token}` };
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
      // As the agent's report writes it (SHP-T-2.3): reported, so deployable.
      data: { name, agentId: agent.id, manifestYaml: `name: ${name}\n`, manifestSha256: '0'.repeat(64), reportedAt: new Date() },
    });
    ids.set(name, row.id);
  }
  return ids;
}

/** A caller as the service sees one: a deployer user, with the audit writer recording rows. */
async function userCaller(): Promise<DeployCaller> {
  const user = await db.user.create({
    data: { email: `svc-${randomUUID()}@example.com`, displayName: 'svc', role: 'deployer' },
  });
  return {
    actor: { type: 'user', id: user.id, label: user.email },
    role: 'deployer',
    tokenApps: undefined,
    audit: async (event) => {
      await db.auditEvent.create({
        data: {
          actorType: 'user',
          actorUserId: user.id,
          actorLabel: user.email,
          action: event.action,
          entityType: event.entityType,
          ...(event.entityId !== undefined ? { entityId: event.entityId } : {}),
          ...(event.after !== undefined ? { after: event.after as object } : {}),
          requestId: randomUUID(),
        },
      });
    },
  };
}

async function activeCount(appId: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `select count(*) as n from deploy_target where app_id = $1::uuid and state::text = any($2::text[])`,
    appId,
    [...ACTIVE_STATES],
  );
  return Number(rows[0]?.n ?? -1);
}

let appIds: Map<string, string>;

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "target_image", "step", "outbox", "deploy_target", "deploy", "audit_event", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  appIds = await seedApps('web', 'api', 'billing');
  bus = new Bus();
  deps = { db, logger, config, bus };
  app = createApp({ db, logger, config, bus });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('the lock is the partial unique index (SHP-REQ-038)', () => {
  it('fifty concurrent deploys of one app: exactly one accepted, 49 refused locked, one active target', async () => {
    const caller = await userCaller();
    let published = 0;
    const origPublish = bus.publish.bind(bus);
    bus.publish = (topic) => {
      if (topic === 'work') published += 1;
      origPublish(topic);
    };

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => createDeploy(deps, caller, { kind: 'deploy', app: 'web', sha: SHA_A })),
    );

    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const values = results.map((r) => (r.status === 'fulfilled' ? r.value : null));
    const accepted = values.filter((v): v is DeployAccepted => v !== null && !isRefusal(v));
    const refused = values.filter((v): v is Refusal => v !== null && isRefusal(v));
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.state).toBe('locked');
    expect(refused).toHaveLength(49);
    for (const r of refused) {
      expect(r.code).toBe('locked');
      expect(r.gate).toBe('G4');
    }

    expect(await activeCount(appIds.get('web') ?? '')).toBe(1);
    // A refused request leaves no Deploy behind: the nested create is one transaction.
    expect(await db.deploy.count()).toBe(1);
    expect(await db.auditEvent.count({ where: { action: 'deploy.requested' } })).toBe(1);
    expect(published).toBe(1);
  });

  it('the refusal names the holder, the short SHA and the current step (SHP-REQ-039)', async () => {
    const { cookie, email } = await signIn('deployer');
    const first = await request(app).post('/api/deploys').set('Cookie', cookie).send({ kind: 'deploy', app: 'web', sha: SHA_B });
    expect(first.status).toBe(201);
    const { deployId } = first.body as DeployAccepted;

    // Before the agent reports a step, the state stands in for it.
    const early = await request(app).post('/api/deploys').set('Cookie', cookie).send({ kind: 'deploy', app: 'web', sha: SHA_A });
    expect(early.status).toBe(409);
    expect(err(early).message).toBe(`web is being deployed by ${email} (console): ${SHA_B.slice(0, 7)} at step locked.`);

    await db.deployTarget.updateMany({ where: { deployId }, data: { state: 'pulling', currentStep: 'pulling' } });
    const res = await request(app).post('/api/deploys').set('Cookie', cookie).send({ kind: 'deploy', app: 'web', sha: SHA_A });
    expect(res.status).toBe(409);
    expect(err(res).code).toBe('locked');
    expect(err(res).message).toContain(`${email} (console)`);
    expect(err(res).message).toContain(SHA_B.slice(0, 7));
    expect(err(res).message).toContain('at step pulling');
  });

  it('names a token requester by the label it sent', async () => {
    const { cookie } = await signIn('deployer');
    const token = await issueToken(cookie, ['web']);
    const requester = { label: 'claude on shipyard#12', repo: 'matdemers1/web', branch: 'main' };
    const first = await request(app)
      .post('/api/deploys')
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'deploy', app: 'web', sha: SHA_B, requester });
    expect(first.status).toBe(201);

    const deploy = await db.deploy.findFirstOrThrow();
    expect(deploy.requesterLabel).toBe(requester.label);
    expect(deploy.requesterRepo).toBe(requester.repo);
    expect(deploy.requesterBranch).toBe(requester.branch);
    expect(deploy.requesterTokenId).not.toBeNull();

    const res = await request(app).post('/api/deploys').set('Cookie', cookie).send({ kind: 'deploy', app: 'web', sha: SHA_A });
    expect(err(res).message).toContain('claude on shipyard#12');

    const noRequester = await request(app)
      .post('/api/deploys')
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'deploy', app: 'web', sha: SHA_A });
    expect(noRequester.status).toBe(400);
    expect(err(noRequester).code).toBe('invalid_request');
  });

  it('a dry run while locked is accepted, queued and never active (SHP-REQ-050)', async () => {
    const caller = await userCaller();
    const held = await createDeploy(deps, caller, { kind: 'deploy', app: 'web', sha: SHA_A });
    expect(isRefusal(held)).toBe(false);

    const dry = await createDeploy(deps, caller, { kind: 'deploy', app: 'web', sha: SHA_B, dryRun: true });
    expect(isRefusal(dry)).toBe(false);
    expect((dry as DeployAccepted).state).toBe('queued');
    const target = await db.deployTarget.findFirstOrThrow({ where: { deployId: (dry as DeployAccepted).deployId } });
    expect(target.state).toBe('queued');
    expect(target.dispatchedAt).toBeNull();
    expect(await activeCount(appIds.get('web') ?? '')).toBe(1);
  });

  it('a lock on one app does not block another', async () => {
    const caller = await userCaller();
    expect(isRefusal(await createDeploy(deps, caller, { kind: 'deploy', app: 'web', sha: SHA_A }))).toBe(false);
    const other = await createDeploy(deps, caller, { kind: 'deploy', app: 'api', sha: SHA_A });
    expect(isRefusal(other)).toBe(false);
    expect((other as DeployAccepted).state).toBe('locked');
  });

  it('a finished deploy releases the lock', async () => {
    const caller = await userCaller();
    const first = (await createDeploy(deps, caller, { kind: 'deploy', app: 'web', sha: SHA_A })) as DeployAccepted;
    await db.deployTarget.updateMany({ where: { deployId: first.deployId }, data: { state: 'succeeded' } });
    const second = await createDeploy(deps, caller, { kind: 'deploy', app: 'web', sha: SHA_B });
    expect(isRefusal(second)).toBe(false);
  });
});

describe('server-side pre-checks', () => {
  it('refuses an app the agent has not reported (SHP-REQ-037)', async () => {
    const { cookie } = await signIn('deployer');
    const res = await request(app).post('/api/deploys').set('Cookie', cookie).send({ kind: 'deploy', app: 'ghost', sha: SHA_A });
    expect(res.status).toBe(404);
    expect(err(res).code).toBe('unknown_app');
    expect(err(res).message).toContain('ghost');
    expect(await db.deploy.count()).toBe(0);
  });

  it('refuses a drifted app (G3)', async () => {
    // As the report records drift: the app flagged, with an open event.
    const drifted = await db.app.update({ where: { name: 'web' }, data: { driftedAt: new Date() } });
    await db.driftEvent.create({ data: { appId: drifted.id, observed: { web: 'sha256:b' }, recorded: { web: 'sha256:a' } } });
    const { cookie } = await signIn('deployer');
    const res = await request(app).post('/api/deploys').set('Cookie', cookie).send({ kind: 'deploy', app: 'web', sha: SHA_A });
    expect(res.status).toBe(409);
    expect(err(res).code).toBe('drift_unresolved');
    expect(err(res).gate).toBe('G3');
  });

  it('uses an injected deployable check', async () => {
    const caller = await userCaller();
    const refused = await createDeploy(deps, caller, { kind: 'deploy', app: 'web', sha: SHA_A }, {
      check: () => Promise.resolve({ code: 'app_frozen', gate: 'G2', message: 'frozen', fix: 'unfreeze' }),
    });
    expect(isRefusal(refused) && refused.code).toBe('app_frozen');
  });

  it('refuses a token out of scope with 403', async () => {
    const { cookie } = await signIn('deployer');
    const token = await issueToken(cookie, ['api']);
    const res = await request(app)
      .post('/api/deploys')
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'deploy', app: 'web', sha: SHA_A, requester: { label: 'x', repo: 'o/r', branch: 'main' } });
    expect(res.status).toBe(403);
    expect(err(res).code).toBe('forbidden');
  });

  it('refuses a viewer with 403', async () => {
    const { cookie } = await signIn('viewer');
    const res = await request(app).post('/api/deploys').set('Cookie', cookie).send({ kind: 'deploy', app: 'web', sha: SHA_A });
    expect(res.status).toBe(403);
    expect(err(res).code).toBe('forbidden');
  });

  it('refuses anonymous callers, unknown groups and malformed bodies', async () => {
    const anon = await request(app).post('/api/deploys').send({ kind: 'deploy', app: 'web', sha: SHA_A });
    expect(anon.status).toBe(401);

    const { cookie } = await signIn('deployer');
    const group = await request(app).post('/api/deploys').set('Cookie', cookie).send({ kind: 'deploy', group: 'core', sha: SHA_A });
    // Group deploys exist since Phase 5; an unknown group is simply not found.
    expect(group.status).toBe(404);
    expect(err(group).code).toBe('not_found');
    expect(err(group).message).toContain('group core');

    const bad = await request(app).post('/api/deploys').set('Cookie', cookie).send({ kind: 'deploy', app: 'web', sha: 'nope' });
    expect(bad.status).toBe(400);
    expect(err(bad).code).toBe('invalid_request');
  });
});

describe('rollbacks', () => {
  it('refuses a bogus toDeployId', async () => {
    const { cookie } = await signIn('deployer');
    const res = await request(app)
      .post('/api/deploys')
      .set('Cookie', cookie)
      .send({ kind: 'rollback', app: 'web', toDeployId: randomUUID() });
    expect(res.status).toBe(409);
    expect(err(res).code).toBe('rollback_target_invalid');
  });

  it('refuses a succeeded deploy of a different app', async () => {
    const caller = await userCaller();
    const other = (await createDeploy(deps, caller, { kind: 'deploy', app: 'api', sha: SHA_A })) as DeployAccepted;
    await db.deployTarget.updateMany({ where: { deployId: other.deployId }, data: { state: 'succeeded' } });
    const res = await createDeploy(deps, caller, { kind: 'rollback', app: 'web', toDeployId: other.deployId });
    expect(isRefusal(res) && res.code).toBe('rollback_target_invalid');
  });

  it('accepts an earlier succeeded deploy, taking its SHA', async () => {
    const { cookie } = await signIn('deployer');
    const first = await request(app).post('/api/deploys').set('Cookie', cookie).send({ kind: 'deploy', app: 'web', sha: SHA_B });
    const earlier = (first.body as DeployAccepted).deployId;
    await db.deployTarget.updateMany({ where: { deployId: earlier }, data: { state: 'succeeded', endedAt: new Date(), dispatchedAt: new Date() } });

    const res = await request(app).post('/api/deploys').set('Cookie', cookie).send({ kind: 'rollback', app: 'web', toDeployId: earlier });
    expect(res.status).toBe(201);
    const accepted = res.body as DeployAccepted;
    expect(accepted.state).toBe('locked');

    const status = await request(app).get(`/api/deploys/${accepted.deployId}`).set('Cookie', cookie);
    expect(status.status).toBe(200);
    expect((status.body as DeployStatus).sha).toBe(SHA_B);
    expect((status.body as DeployStatus).kind).toBe('rollback');
    const target = await db.deployTarget.findFirstOrThrow({ where: { deployId: accepted.deployId } });
    expect(target.rollbackToDeployId).toBe(earlier);
  });
});

describe('reading deploys', () => {
  it('returns a status, audited on request', async () => {
    const { cookie, email } = await signIn('deployer');
    const created = await request(app).post('/api/deploys').set('Cookie', cookie).send({ kind: 'deploy', app: 'web', sha: SHA_A });
    const { deployId } = created.body as DeployAccepted;

    const res = await request(app).get(`/api/deploys/${deployId}`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    const status = res.body as DeployStatus;
    expect(status).toMatchObject({
      deployId,
      kind: 'deploy',
      app: 'web',
      sha: SHA_A,
      dryRun: false,
      state: 'locked',
      currentStep: null,
      requester: { label: `${email} (console)`, repo: null, branch: null },
      images: [],
      refusal: null,
      gates: [],
      endedAt: null,
    });

    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'deploy.requested' } });
    expect(audit.entityId).toBe(deployId);

    expect((await request(app).get(`/api/deploys/${randomUUID()}`).set('Cookie', cookie)).status).toBe(404);
    expect((await request(app).get('/api/deploys/not-a-uuid').set('Cookie', cookie)).status).toBe(404);
    expect((await request(app).get(`/api/deploys/${deployId}?wait=91`).set('Cookie', cookie)).status).toBe(400);
  });

  it('lets a viewer read, and a token read only its scoped apps', async () => {
    const caller = await userCaller();
    const web = (await createDeploy(deps, caller, { kind: 'deploy', app: 'web', sha: SHA_A })) as DeployAccepted;
    await createDeploy(deps, caller, { kind: 'deploy', app: 'api', sha: SHA_A });
    const newest = (await createDeploy(deps, caller, { kind: 'deploy', app: 'billing', sha: SHA_A })) as DeployAccepted;

    const viewer = await signIn('viewer');
    const all = await request(app).get('/api/deploys').set('Cookie', viewer.cookie);
    expect(all.status).toBe(200);
    const list = all.body as DeployStatus[];
    expect(list.map((d) => d.app)).toEqual(['billing', 'api', 'web']);
    expect(list[0]?.deployId).toBe(newest.deployId);

    const limited = await request(app).get('/api/deploys?limit=1').set('Cookie', viewer.cookie);
    expect((limited.body as DeployStatus[]).map((d) => d.app)).toEqual(['billing']);
    const byApp = await request(app).get('/api/deploys?app=web').set('Cookie', viewer.cookie);
    expect((byApp.body as DeployStatus[]).map((d) => d.deployId)).toEqual([web.deployId]);

    const deployer = await signIn('deployer');
    const token = await issueToken(deployer.cookie, ['web']);
    const scoped = await request(app).get('/api/deploys').set('Authorization', `Bearer ${token}`);
    expect((scoped.body as DeployStatus[]).map((d) => d.app)).toEqual(['web']);
    expect((await request(app).get('/api/deploys?app=api').set('Authorization', `Bearer ${token}`)).status).toBe(403);
    expect((await request(app).get(`/api/deploys/${newest.deployId}`).set('Authorization', `Bearer ${token}`)).status).toBe(403);
    expect((await request(app).get(`/api/deploys/${web.deployId}`).set('Authorization', `Bearer ${token}`)).status).toBe(200);

    expect((await request(app).get('/api/deploys')).status).toBe(401);
  });

  it('?wait= returns after the timeout with the same state', async () => {
    const caller = await userCaller();
    const { deployId } = (await createDeploy(deps, caller, { kind: 'deploy', app: 'web', sha: SHA_A })) as DeployAccepted;
    const { cookie } = await signIn('viewer');

    const started = Date.now();
    const res = await request(app).get(`/api/deploys/${deployId}?wait=2`).set('Cookie', cookie);
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    expect((res.body as DeployStatus).state).toBe('locked');
    expect(elapsed).toBeGreaterThanOrEqual(1900);
  });

  it('?wait= returns early when deploy:<id> is published after the row changes', async () => {
    const caller = await userCaller();
    const { deployId } = (await createDeploy(deps, caller, { kind: 'deploy', app: 'web', sha: SHA_A })) as DeployAccepted;
    const { cookie } = await signIn('viewer');

    const started = Date.now();
    const pending = request(app).get(`/api/deploys/${deployId}?wait=10`).set('Cookie', cookie).then((r) => r);
    setTimeout(() => {
      void db.deployTarget
        .updateMany({ where: { deployId }, data: { state: 'pulling', currentStep: 'pulling' } })
        .then(() => {
          bus.publish(`deploy:${deployId}`);
        });
    }, 300);
    const res = await pending;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(res.status).toBe(200);
    expect((res.body as DeployStatus).state).toBe('pulling');
    expect((res.body as DeployStatus).currentStep).toBe('pulling');
  });

  it('?wait= returns at once for a terminal deploy', async () => {
    const caller = await userCaller();
    const { deployId } = (await createDeploy(deps, caller, { kind: 'deploy', app: 'web', sha: SHA_A })) as DeployAccepted;
    await db.deployTarget.updateMany({ where: { deployId }, data: { state: 'failed' } });
    const { cookie } = await signIn('viewer');
    const started = Date.now();
    const res = await request(app).get(`/api/deploys/${deployId}?wait=30`).set('Cookie', cookie);
    expect(Date.now() - started).toBeLessThan(2000);
    expect((res.body as DeployStatus).state).toBe('failed');
  });
});
