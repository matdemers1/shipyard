import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  fingerprintOf,
  signingString,
  type PollResponse,
  type Refusal,
  type RolloutAccepted,
  type RolloutPlan,
  type RolloutStatus,
} from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { Bus } from '../../src/events.js';
import { generateToken } from '../../src/tokens/tokens.js';

/**
 * Rollouts — "Roll all" (SHP-T-12.1; SHP-REQ-151, SHP-REQ-152, SHP-REQ-153), driven through the
 * real REST request and the agent's signed long poll: every app locked in one transaction, one app
 * dispatched at a time in rollout order and only after the one before it succeeded, Shipyard's own
 * app always last, and the rollout stopped at the first failure.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_S = 'e'.repeat(40);
const DIGEST = `sha256:${'1'.repeat(64)}`;

interface Key {
  privateKey: KeyObject;
  b64: string;
  fingerprint: string;
}

function makeKey(): Key {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const raw = Buffer.from(der.subarray(der.length - 32));
  return { privateKey, b64: raw.toString('base64'), fingerprint: fingerprintOf(raw) };
}

function signed(key: Key, path: string, body: string): Record<string, string> {
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString('base64url');
  const data = signingString({ method: 'POST', path, timestamp, nonce, body: Buffer.from(body, 'utf8') });
  return {
    'x-shipyard-key': key.fingerprint,
    'x-shipyard-timestamp': timestamp,
    'x-shipyard-nonce': nonce,
    'x-shipyard-signature': sign(null, Buffer.from(data, 'utf8'), key.privateKey).toString('base64'),
    'content-type': 'application/json',
  };
}

let app: Express;
let key: Key;
let agentId: string;
let cookie: string;
const appIds = new Map<string, string>();

async function agentPost(path: string, body: unknown) {
  const text = JSON.stringify(body);
  return request(app).post(path).set(signed(key, path, text)).send(text);
}

async function poll(): Promise<PollResponse['target']> {
  const res = await agentPost('/api/agent/poll', { waitSeconds: 0 });
  expect(res.status).toBe(200);
  return (res.body as PollResponse).target;
}

function targetOf(t: PollResponse['target']): NonNullable<PollResponse['target']> {
  if (t === null) throw new Error('expected a target');
  return t;
}

async function progress(targetId: string, state: string) {
  const res = await agentPost('/api/agent/progress', { targetId, state });
  expect(res.status).toBe(200);
}

async function report(target: NonNullable<PollResponse['target']>, state: string, refusalCode?: string) {
  const res = await agentPost('/api/agent/result', {
    targetId: target.targetId,
    state,
    images: state === 'succeeded' ? [{ service: 'server', sha: target.sha, digest: DIGEST }] : [],
    ...(refusalCode === undefined ? {} : { refusal: { code: refusalCode, gate: 'none', message: 'boom', fix: 'fix it' } }),
  });
  expect(res.status).toBe(200);
}

interface Seed {
  group?: string;
  canary?: boolean;
  approvalPolicy?: string;
}

async function seedApp(name: string, seed: Seed = {}): Promise<void> {
  const row = await db.app.create({
    data: {
      name,
      agentId,
      manifestYaml: `name: ${name}\n`,
      manifestSha256: '0'.repeat(64),
      reportedAt: new Date(),
      services: { server: { image: `ghcr.io/matdemers1/${name}/server` } },
      ...(seed.group === undefined ? {} : { groupName: seed.group }),
      ...(seed.canary === true ? { canary: true } : {}),
      ...(seed.approvalPolicy === undefined ? {} : { approvalPolicy: seed.approvalPolicy }),
    },
  });
  appIds.set(name, row.id);
}

const ITEMS = [
  { app: 'shipyard', sha: SHA_S },
  { app: 'charlie', sha: SHA_C },
  { app: 'alpha', sha: SHA_A },
  { app: 'bravo', sha: SHA_B },
];

async function startRollout(items: { app: string; sha: string }[] = ITEMS, auth: [string, string] = ['Cookie', cookie], extra: Record<string, unknown> = {}) {
  return request(app)
    .post('/api/rollouts')
    .set(auth[0], auth[1])
    .send({ items, ...extra });
}

async function accepted(items: { app: string; sha: string }[] = ITEMS): Promise<RolloutAccepted> {
  const res = await startRollout(items);
  expect(res.status).toBe(201);
  return res.body as RolloutAccepted;
}

async function rolloutStatus(rolloutId: string): Promise<RolloutStatus> {
  const res = await request(app).get(`/api/rollouts/${rolloutId}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body as RolloutStatus;
}

function err(res: { body: unknown }): Refusal {
  return (res.body as { error: Refusal }).error;
}

async function tokenFor(apps: string[]): Promise<string> {
  const user = await db.user.create({ data: { email: `tok-${randomUUID()}@example.com`, displayName: 'tok', role: 'deployer' } });
  const { token, hash, prefix } = generateToken();
  await db.apiToken.create({
    data: { userId: user.id, label: 'claude', tokenHash: hash, prefix, apps: { create: apps.map((a) => ({ appId: appIds.get(a) ?? '' })) } },
  });
  return token;
}

async function sessionFor(role: 'viewer' | 'deployer'): Promise<string> {
  const user = await db.user.create({ data: { email: `${role}-${randomUUID()}@example.com`, displayName: role, role } });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return `${SESSION_COOKIE}=${session.token}`;
}

const REQUESTER = { repo: 'matdemers1/shipyard', branch: 'main', label: 'claude: roll all' };

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "freeze", "approval", "backup_artifact", "outbox", "drift_event", "target_image", "step", "deploy_target", "deploy", "rollout", "audit_event", "agent_nonce", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  appIds.clear();
  key = makeKey();
  const agent = await db.agent.create({ data: { publicKey: key.b64, fingerprint: key.fingerprint, confirmedAt: new Date() } });
  agentId = agent.id;
  app = createApp({ db, logger, config, bus: new Bus() });
  cookie = await sessionFor('deployer');
  for (const name of ['alpha', 'bravo', 'charlie', 'shipyard', 'solo']) await seedApp(name);
});

afterAll(async () => {
  await db.$disconnect();
});

describe('rollout: one app at a time, each at its own SHA, Shipyard last (SHP-REQ-151, SHP-REQ-152)', () => {
  it('doneWhen: locks every app at once, dispatches each only after the one before succeeded, and ships shipyard last', async () => {
    const { rolloutId, deployIds } = await accepted();
    expect(deployIds).toHaveLength(4);

    // Every member holds its lock from the start, each in its own ordinary deploy at its own SHA.
    const deploys = await db.deploy.findMany({
      where: { rolloutId },
      include: { targets: { include: { app: true } } },
      orderBy: { rolloutPosition: 'asc' },
    });
    expect(deploys.map((d) => [d.rolloutPosition, d.targets[0]?.app.name, d.requestedSha, d.targets[0]?.state])).toEqual([
      [0, 'alpha', SHA_A, 'locked'],
      [1, 'bravo', SHA_B, 'locked'],
      [2, 'charlie', SHA_C, 'locked'],
      [3, 'shipyard', SHA_S, 'locked'],
    ]);
    expect(deploys.map((d) => d.id)).toEqual(deployIds);
    expect(deploys[1]?.requesterLabel).toMatch(/\(console\) · roll all 2\/4$/);

    // One member at a time, in order, each with its own SHA — and nothing more while one runs,
    // through every step up to and including its soak.
    for (const [name, sha] of [
      ['alpha', SHA_A],
      ['bravo', SHA_B],
      ['charlie', SHA_C],
      ['shipyard', SHA_S],
    ] as const) {
      const t = targetOf(await poll());
      expect([t.app, t.sha]).toEqual([name, sha]);
      expect(await poll()).toBeNull();
      await progress(t.targetId, 'swapping');
      await progress(t.targetId, 'soaking');
      expect(await poll()).toBeNull();
      const mid = await rolloutStatus(rolloutId);
      expect(mid.state).toBe('soaking');
      await report(t, 'succeeded');
    }
    expect(await poll()).toBeNull();

    const status = await rolloutStatus(rolloutId);
    expect(status.state).toBe('succeeded');
    expect(status.members.map((m) => [m.position, m.app, m.sha, m.state, m.self])).toEqual([
      [0, 'alpha', SHA_A, 'succeeded', false],
      [1, 'bravo', SHA_B, 'succeeded', false],
      [2, 'charlie', SHA_C, 'succeeded', false],
      [3, 'shipyard', SHA_S, 'succeeded', true],
    ]);

    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'rollout.requested', entityId: rolloutId } });
    expect(audit.after).toMatchObject({
      members: [
        { app: 'alpha', sha: SHA_A },
        { app: 'bravo', sha: SHA_B },
        { app: 'charlie', sha: SHA_C },
        { app: 'shipyard', sha: SHA_S },
      ],
    });
    expect(await db.auditEvent.count({ where: { action: 'deploy.requested', entityId: { in: deployIds } } })).toBe(4);
  });

  it("orders a group's canary before its group-mates and keeps them together, SELF_APP last", async () => {
    await seedApp('foreman', { group: 'board' });
    await seedApp('board-web', { group: 'board', canary: true });
    const res = await request(app)
      .post('/api/rollouts/plan')
      .set('Cookie', cookie)
      .send({
        items: [
          { app: 'shipyard', sha: SHA_S },
          { app: 'foreman', sha: SHA_A },
          { app: 'alpha', sha: SHA_A },
          { app: 'board-web', sha: SHA_A },
          { app: 'charlie', sha: SHA_C },
        ],
      });
    expect(res.status).toBe(200);
    const plan = res.body as RolloutPlan;
    expect(plan.members.map((m) => m.app)).toEqual(['alpha', 'board-web', 'foreman', 'charlie', 'shipyard']);
    expect(plan.members.map((m) => m.self)).toEqual([false, false, false, false, true]);
    // A plan writes nothing.
    expect(await db.rollout.count()).toBe(0);
    expect(await db.deploy.count()).toBe(0);
  });

  it('the plan names what is live now', async () => {
    const first = await accepted([{ app: 'alpha', sha: SHA_A }]);
    expect(first.deployIds).toHaveLength(1);
    await report(targetOf(await poll()), 'succeeded');
    const res = await request(app)
      .post('/api/rollouts/plan')
      .set('Cookie', cookie)
      .send({ items: [{ app: 'alpha', sha: SHA_B }, { app: 'bravo', sha: SHA_B }] });
    expect(res.status).toBe(200);
    expect((res.body as RolloutPlan).members).toEqual([
      { app: 'alpha', sha: SHA_B, liveSha: SHA_A, self: false },
      { app: 'bravo', sha: SHA_B, liveSha: null, self: false },
    ]);
  });

  it('a waiting reader wakes when a member moves', async () => {
    const { rolloutId } = await accepted();
    const t = targetOf(await poll());
    const waiting = request(app).get(`/api/rollouts/${rolloutId}?wait=30`).set('Cookie', cookie);
    const done = waiting.then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await report(t, 'succeeded');
    const res = await done;
    expect(res.status).toBe(200);
    expect((res.body as RolloutStatus).members[0]?.state).toBe('succeeded');
  });
});

describe('rollout: stop at the first failure (SHP-REQ-153)', () => {
  it('a failing second app cancels the rest untouched, with rollout_stopped naming it', async () => {
    const { rolloutId, deployIds } = await accepted();
    await report(targetOf(await poll()), 'succeeded');
    const second = targetOf(await poll());
    expect(second.app).toBe('bravo');
    await report(second, 'rolled_back', 'health_failed');

    expect(await poll()).toBeNull();
    for (const name of ['charlie', 'shipyard']) {
      const row = await db.deployTarget.findFirstOrThrow({ where: { deploy: { rolloutId }, app: { name } } });
      expect(row.state).toBe('cancelled');
      expect(row.dispatchedAt).toBeNull();
      expect(row.startedAt).toBeNull();
      expect(row.refusal).toMatchObject({ code: 'rollout_stopped' });
      expect((row.refusal as { message: string }).message).toContain('bravo');
      expect(await db.step.count({ where: { targetId: row.id } })).toBe(0);
    }

    const status = await rolloutStatus(rolloutId);
    expect(status.state).toBe('rolled_back');
    expect(status.members.map((m) => [m.app, m.state])).toEqual([
      ['alpha', 'succeeded'],
      ['bravo', 'rolled_back'],
      ['charlie', 'cancelled'],
      ['shipyard', 'cancelled'],
    ]);
    expect(status.members[2]?.refusal?.code).toBe('rollout_stopped');

    const result = await db.auditEvent.findFirstOrThrow({ where: { action: 'deploy.result', entityId: deployIds[1] ?? '' } });
    expect(result.after).toMatchObject({ rollout: rolloutId, rolloutStopped: ['charlie', 'shipyard'] });

    // The cancelled apps' locks are free again.
    const again = await request(app).post('/api/deploys').set('Cookie', cookie).send({ kind: 'deploy', app: 'charlie', sha: SHA_C });
    expect(again.status).toBe(201);
  });
});

describe('rollout: locks, scope and refusals', () => {
  it('every lock in one transaction: an app held elsewhere refuses the whole rollout, naming the holder, writing nothing', async () => {
    const holder = await request(app)
      .post('/api/deploys')
      .set('Cookie', cookie)
      .send({ kind: 'deploy', app: 'charlie', sha: SHA_C, requester: { ...REQUESTER, label: 'someone else' } });
    expect(holder.status).toBe(201);

    const plan = await request(app).post('/api/rollouts/plan').set('Cookie', cookie).send({ items: ITEMS });
    expect(plan.status).toBe(409);
    expect(err(plan).code).toBe('locked');

    const res = await startRollout();
    expect(res.status).toBe(409);
    expect(err(res).code).toBe('locked');
    expect(err(res).message).toContain('charlie');
    expect(err(res).message).toContain('someone else');
    expect(await db.rollout.count()).toBe(0);
    expect(await db.deploy.count()).toBe(1);
    // alpha and bravo were never held by the refused rollout.
    expect(await db.deployTarget.count({ where: { app: { name: { in: ['alpha', 'bravo'] } } } })).toBe(0);
  });

  it('a rollout holds later apps while an earlier one runs, so nobody else deploys them halfway', async () => {
    await accepted();
    const res = await request(app)
      .post('/api/deploys')
      .set('Cookie', cookie)
      .send({ kind: 'deploy', app: 'shipyard', sha: SHA_S, requester: REQUESTER });
    expect(res.status).toBe(409);
    expect(err(res).code).toBe('locked');
    expect(err(res).message).toContain('roll all 4/4');
  });

  it('a frozen app refuses the rollout', async () => {
    const by = await db.user.create({ data: { email: `freezer-${randomUUID()}@example.com`, displayName: 'freezer', role: 'deployer' } });
    await db.freeze.create({ data: { appId: appIds.get('bravo') ?? '', reason: 'release week', byUserId: by.id } });
    const res = await startRollout();
    expect(res.status).toBe(409);
    expect(err(res).code).toBe('app_frozen');
    expect(await db.rollout.count()).toBe(0);
  });

  it('an unknown app, a repeated app or a bad SHA is refused', async () => {
    const unknown = await startRollout([{ app: 'nope', sha: SHA_A }]);
    expect(unknown.status).toBe(404);
    expect(err(unknown).code).toBe('unknown_app');

    const repeated = await startRollout([
      { app: 'alpha', sha: SHA_A },
      { app: 'alpha', sha: SHA_B },
    ]);
    expect(repeated.status).toBe(400);
    expect(err(repeated).code).toBe('invalid_request');

    const bad = await startRollout([{ app: 'alpha', sha: 'main' }]);
    expect(bad.status).toBe(400);

    const command = await startRollout([{ app: 'alpha', sha: SHA_A, argv: ['rm', '-rf', '/'] } as unknown as { app: string; sha: string }]);
    expect(command.status).toBe(400);
  });

  it('a viewer cannot start a rollout', async () => {
    const viewer = await sessionFor('viewer');
    const res = await startRollout(ITEMS, ['Cookie', viewer]);
    expect(res.status).toBe(403);
    expect(await db.rollout.count()).toBe(0);
  });

  it('a token must be scoped to every app, name its requester, and is refused an approval-required app', async () => {
    const partial = await tokenFor(['alpha']);
    const outOfScope = await startRollout(
      [
        { app: 'alpha', sha: SHA_A },
        { app: 'bravo', sha: SHA_B },
      ],
      ['Authorization', `Bearer ${partial}`],
      { requester: REQUESTER },
    );
    expect(outOfScope.status).toBe(403);

    const full = await tokenFor(['alpha', 'bravo', 'solo']);
    const noRequester = await startRollout(
      [
        { app: 'alpha', sha: SHA_A },
        { app: 'bravo', sha: SHA_B },
      ],
      ['Authorization', `Bearer ${full}`],
    );
    expect(noRequester.status).toBe(400);

    await db.app.update({ where: { name: 'solo' }, data: { approvalPolicy: 'required' } });
    const needsApproval = await startRollout(
      [
        { app: 'alpha', sha: SHA_A },
        { app: 'solo', sha: SHA_B },
      ],
      ['Authorization', `Bearer ${full}`],
      { requester: REQUESTER },
    );
    expect(needsApproval.status).toBe(409);
    expect(err(needsApproval).code).toBe('approval_required');
    expect(err(needsApproval).message).toContain('solo');

    const ok = await startRollout(
      [
        { app: 'alpha', sha: SHA_A },
        { app: 'bravo', sha: SHA_B },
      ],
      ['Authorization', `Bearer ${full}`],
      { requester: REQUESTER },
    );
    expect(ok.status).toBe(201);
    const { rolloutId } = ok.body as RolloutAccepted;
    const read = await request(app).get(`/api/rollouts/${rolloutId}`).set('Authorization', `Bearer ${partial}`);
    expect(read.status).toBe(403);
  });

  it('a console request for an approval-required app needs no approval: confirming the sheet is the approval', async () => {
    await db.app.update({ where: { name: 'solo' }, data: { approvalPolicy: 'required' } });
    const { rolloutId } = await accepted([
      { app: 'solo', sha: SHA_A },
      { app: 'alpha', sha: SHA_A },
    ]);
    const status = await rolloutStatus(rolloutId);
    expect(status.members.map((m) => [m.app, m.state])).toEqual([
      ['alpha', 'locked'],
      ['solo', 'locked'],
    ]);
    expect(await db.approval.count()).toBe(0);
  });

  it('an unknown rollout is not_found', async () => {
    const res = await request(app).get(`/api/rollouts/${randomUUID()}`).set('Cookie', cookie);
    expect(res.status).toBe(404);
  });
});
