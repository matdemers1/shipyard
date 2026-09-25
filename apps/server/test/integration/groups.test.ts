import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  fingerprintOf,
  signingString,
  type DeployAccepted,
  type GroupDeployStatus,
  type GroupSummary,
  type PollResponse,
  type Refusal,
} from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { Bus } from '../../src/events.js';
import { generateToken } from '../../src/tokens/tokens.js';

/**
 * Group deploys (SHP-T-5.2, SHP-T-5.3; SHP-REQ-078, SHP-REQ-079, SHP-D-047), driven through the
 * real REST request and the agent's signed long poll: every member locked in one transaction,
 * one member dispatched at a time in order, the group stopped at the first failure, and a
 * canary's soaked digests carried to every later member.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });

const SHA = 'd'.repeat(40);
const DIGEST_SERVER = `sha256:${'1'.repeat(64)}`;
const DIGEST_WORKER = `sha256:${'2'.repeat(64)}`;
const DIGEST_MCP = `sha256:${'3'.repeat(64)}`;

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

async function report(targetId: string, state: string, images: { service: string; digest: string }[] = [], refusalCode?: string) {
  const res = await agentPost('/api/agent/result', {
    targetId,
    state,
    images: images.map((i) => ({ service: i.service, sha: SHA, digest: i.digest })),
    ...(refusalCode === undefined ? {} : { refusal: { code: refusalCode, gate: 'none', message: 'boom', fix: 'fix it' } }),
  });
  expect(res.status).toBe(200);
}

interface Seed {
  group?: string;
  canary?: boolean;
  services?: string[];
  approvalPolicy?: string;
}

async function seedApp(name: string, seed: Seed = {}): Promise<void> {
  const services = Object.fromEntries((seed.services ?? ['server', 'worker']).map((s) => [s, { image: `ghcr.io/matdemers1/foreman/${s}` }]));
  const row = await db.app.create({
    data: {
      name,
      agentId,
      manifestYaml: `name: ${name}\n`,
      manifestSha256: '0'.repeat(64),
      reportedAt: new Date(),
      services,
      ...(seed.group === undefined ? {} : { groupName: seed.group }),
      ...(seed.canary === true ? { canary: true } : {}),
      ...(seed.approvalPolicy === undefined ? {} : { approvalPolicy: seed.approvalPolicy }),
    },
  });
  appIds.set(name, row.id);
}

async function deployGroup(group: string, extra: Record<string, unknown> = {}, auth: [string, string] = ['Cookie', cookie]) {
  return request(app)
    .post('/api/deploys')
    .set(auth[0], auth[1])
    .send({ kind: 'deploy', group, sha: SHA, ...extra });
}

async function accepted(group: string): Promise<DeployAccepted> {
  const res = await deployGroup(group);
  expect(res.status).toBe(201);
  return res.body as DeployAccepted;
}

async function groupStatus(deployId: string): Promise<GroupDeployStatus> {
  const res = await request(app).get(`/api/groups/deploys/${deployId}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body as GroupDeployStatus;
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

const REQUESTER = { repo: 'matdemers1/foreman', branch: 'main', label: 'claude: group session' };

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "freeze", "approval", "backup_artifact", "outbox", "drift_event", "target_image", "step", "deploy_target", "deploy", "audit_event", "agent_nonce", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  appIds.clear();
  key = makeKey();
  const agent = await db.agent.create({ data: { publicKey: key.b64, fingerprint: key.fingerprint, confirmedAt: new Date() } });
  agentId = agent.id;
  app = createApp({ db, logger, config, bus: new Bus() });
  const user = await db.user.create({ data: { email: `deployer-${randomUUID()}@example.com`, displayName: 'deployer', role: 'deployer' } });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  cookie = `${SESSION_COOKIE}=${session.token}`;
});

afterAll(async () => {
  await db.$disconnect();
});

describe('group deploy: transactional locks, ordered deploy, stop at first failure (SHP-T-5.2, SHP-REQ-078)', () => {
  beforeEach(async () => {
    await seedApp('alpha', { group: 'trio' });
    await seedApp('bravo', { group: 'trio' });
    await seedApp('charlie', { group: 'trio' });
    await seedApp('solo');
  });

  it('doneWhen: a failing second member leaves the third untouched', async () => {
    const { deployId, state } = await accepted('trio');
    expect(state).toBe('locked');

    // Every member holds its lock from the start, in one deploy.
    const rows = await db.deployTarget.findMany({ where: { deployId }, include: { app: true }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => [r.app.name, r.state])).toEqual([
      ['alpha', 'locked'],
      ['bravo', 'locked'],
      ['charlie', 'locked'],
    ]);

    // One member at a time, in order.
    const first = targetOf(await poll());
    expect(first.app).toBe('alpha');
    expect(first.expectDigests).toBeUndefined();
    expect(await poll()).toBeNull();
    await report(first.targetId, 'succeeded', [{ service: 'server', digest: DIGEST_SERVER }]);

    const second = targetOf(await poll());
    expect(second.app).toBe('bravo');
    // No canary declared: no digest expectation is carried.
    expect(second.expectDigests).toBeUndefined();
    await report(second.targetId, 'failed', [], 'health_failed');

    // The third is cancelled, naming the member that stopped the group, and never dispatched.
    expect(await poll()).toBeNull();
    const third = await db.deployTarget.findFirstOrThrow({ where: { deployId, app: { name: 'charlie' } } });
    expect(third.state).toBe('cancelled');
    expect(third.dispatchedAt).toBeNull();
    expect(third.startedAt).toBeNull();
    expect(third.refusal).toMatchObject({ code: 'group_stopped' });
    expect((third.refusal as { message: string }).message).toContain('bravo');
    expect(await db.step.count({ where: { targetId: third.id } })).toBe(0);
    expect(await db.auditEvent.count({ where: { action: 'deploy.dispatched', entityId: deployId } })).toBe(2);

    const status = await groupStatus(deployId);
    expect(status).toMatchObject({ group: 'trio', canary: null, sha: SHA, state: 'failed' });
    expect(status.members.map((m) => [m.app, m.state])).toEqual([
      ['alpha', 'succeeded'],
      ['bravo', 'failed'],
      ['charlie', 'cancelled'],
    ]);
    expect(status.members[2]?.refusal?.code).toBe('group_stopped');

    // The failed and cancelled members' locks are free again.
    const again = await request(app).post('/api/deploys').set('Cookie', cookie).send({ kind: 'deploy', app: 'charlie', sha: SHA });
    expect(again.status).toBe(201);
  });

  it('a group whose members all succeed ends succeeded; the request is audited with its members', async () => {
    const { deployId } = await accepted('trio');
    for (const name of ['alpha', 'bravo', 'charlie']) {
      const t = targetOf(await poll());
      expect(t.app).toBe(name);
      await report(t.targetId, 'succeeded', [{ service: 'server', digest: DIGEST_SERVER }]);
    }
    expect(await poll()).toBeNull();
    expect((await groupStatus(deployId)).state).toBe('succeeded');
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'deploy.requested', entityId: deployId } });
    expect(audit.after).toMatchObject({ group: 'trio', members: ['alpha', 'bravo', 'charlie'], canary: null, sha: SHA });
    const deploy = await db.deploy.findUniqueOrThrow({ where: { id: deployId } });
    expect(deploy.groupName).toBe('trio');
  });

  it('every lock is taken in one transaction: a member held elsewhere refuses the whole group, naming the holder', async () => {
    const holder = await request(app).post('/api/deploys').set('Cookie', cookie).send({ kind: 'deploy', app: 'bravo', sha: SHA, requester: { ...REQUESTER, label: 'someone else' } });
    expect(holder.status).toBe(201);

    const res = await deployGroup('trio');
    expect(res.status).toBe(409);
    expect(err(res).code).toBe('locked');
    expect(err(res).message).toContain('bravo');
    expect(err(res).message).toContain('someone else');

    // Nothing was inserted: no group deploy, and alpha and charlie are free.
    expect(await db.deploy.count({ where: { groupName: 'trio' } })).toBe(0);
    expect(await db.deployTarget.count({ where: { app: { name: { in: ['alpha', 'charlie'] } } } })).toBe(0);
  });

  it('a re-dispatch of a lost poll response never hands out a later member early', async () => {
    await accepted('trio');
    const first = targetOf(await poll());
    await db.deployTarget.update({ where: { id: first.targetId }, data: { dispatchedAt: new Date(Date.now() - 3 * 60_000) } });
    const again = targetOf(await poll());
    expect(again.targetId).toBe(first.targetId);
    expect(await poll()).toBeNull();
  });

  it('a single-app deploy is dispatched as before, alongside a waiting group', async () => {
    await accepted('trio');
    const res = await request(app).post('/api/deploys').set('Cookie', cookie).send({ kind: 'deploy', app: 'solo', sha: SHA });
    expect(res.status).toBe(201);
    const apps = [targetOf(await poll()).app, targetOf(await poll()).app];
    expect(apps.sort()).toEqual(['alpha', 'solo']);
    expect(await poll()).toBeNull();
  });

  it('refuses an unknown group, a group dry run and a rollback of a group', async () => {
    const unknown = await deployGroup('nope');
    expect(err(unknown).code).toBe('not_found');
    const dry = await deployGroup('trio', { dryRun: true });
    expect(err(dry).code).toBe('invalid_request');
    const rollback = await request(app).post('/api/deploys').set('Cookie', cookie).send({ kind: 'rollback', group: 'trio', toDeployId: randomUUID() });
    expect(rollback.status).toBe(400);
    expect(await db.deploy.count()).toBe(0);
  });

  it('a frozen member refuses the whole group', async () => {
    const admin = await db.user.findFirstOrThrow();
    await db.freeze.create({ data: { appId: appIds.get('charlie') ?? '', reason: 'maintenance', byUserId: admin.id } });
    const res = await deployGroup('trio');
    expect(err(res).code).toBe('app_frozen');
    expect(err(res).message).toContain('charlie');
    expect(await db.deploy.count()).toBe(0);
  });

  it('a drifted member refuses the whole group', async () => {
    await db.app.update({ where: { name: 'bravo' }, data: { driftedAt: new Date() } });
    await db.driftEvent.create({ data: { appId: appIds.get('bravo') ?? '', observed: { server: DIGEST_WORKER }, recorded: { server: DIGEST_SERVER } } });
    const res = await deployGroup('trio');
    expect(err(res).code).toBe('drift_unresolved');
    expect(await db.deploy.count()).toBe(0);
  });

  it('a token must be scoped to every member, and a token request with an approval-required member is refused', async () => {
    const partial = await tokenFor(['alpha', 'bravo']);
    const out = await deployGroup('trio', { requester: REQUESTER }, ['Authorization', `Bearer ${partial}`]);
    expect(err(out).code).toBe('forbidden');

    await db.app.update({ where: { name: 'bravo' }, data: { approvalPolicy: 'required' } });
    const full = await tokenFor(['alpha', 'bravo', 'charlie']);
    const held = await deployGroup('trio', { requester: REQUESTER }, ['Authorization', `Bearer ${full}`]);
    expect(err(held).code).toBe('approval_required');
    expect(err(held).message).toContain('bravo');
    expect(await db.deploy.count()).toBe(0);

    // The console needs no approval.
    expect((await deployGroup('trio')).status).toBe(201);
  });

  it('lists groups with members in deploy order', async () => {
    const res = await request(app).get('/api/groups').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body as GroupSummary[]).toEqual([{ name: 'trio', canary: null, members: ['alpha', 'bravo', 'charlie'] }]);
  });
});

describe('canary promotion within a group deploy (SHP-T-5.3, SHP-REQ-079, SHP-D-047)', () => {
  beforeEach(async () => {
    // `foreman-board` sorts after `foreman`, so its being first is the canary's doing.
    await seedApp('foreman', { group: 'foreman' });
    await seedApp('foreman-board', { group: 'foreman', canary: true });
    await seedApp('foreman-mcp', { group: 'foreman', services: ['server', 'mcp'] });
  });

  it('doneWhen: the board soaks first; foreman receives identical digests', async () => {
    const { deployId } = await accepted('foreman');

    const canary = targetOf(await poll());
    expect(canary.app).toBe('foreman-board');
    expect(canary.expectDigests).toBeUndefined();
    // Nothing else moves while the canary deploys and soaks.
    expect(await poll()).toBeNull();
    await agentPost('/api/agent/progress', { targetId: canary.targetId, state: 'soaking', step: 'soak' });
    expect(await poll()).toBeNull();
    const board = [
      { service: 'server', digest: DIGEST_SERVER },
      { service: 'worker', digest: DIGEST_WORKER },
    ];
    await report(canary.targetId, 'succeeded', board);

    const foreman = targetOf(await poll());
    expect(foreman.app).toBe('foreman');
    expect(foreman.expectDigests).toEqual({ server: DIGEST_SERVER, worker: DIGEST_WORKER });
    await report(foreman.targetId, 'succeeded', board);

    // A member mapping a service the canary does not have gets no expectation for it.
    const mcp = targetOf(await poll());
    expect(mcp.app).toBe('foreman-mcp');
    expect(mcp.expectDigests).toEqual({ server: DIGEST_SERVER });
    await report(mcp.targetId, 'succeeded', [
      { service: 'server', digest: DIGEST_SERVER },
      { service: 'mcp', digest: DIGEST_MCP },
    ]);

    const recorded = async (targetId: string) =>
      (await db.targetImage.findMany({ where: { targetId }, orderBy: { service: 'asc' } })).map((i) => [i.service, i.digest]);
    expect(await recorded(foreman.targetId)).toEqual(await recorded(canary.targetId));

    const status = await groupStatus(deployId);
    expect(status).toMatchObject({ canary: 'foreman-board', state: 'succeeded' });
    expect(status.members.map((m) => m.app)).toEqual(['foreman-board', 'foreman', 'foreman-mcp']);
    // The canary's place in the group survives its result being recorded.
    const canaryRow = await db.deployTarget.findUniqueOrThrow({ where: { id: canary.targetId } });
    expect(canaryRow.result).toMatchObject({ group: { name: 'foreman', position: 0, canary: true } });
  });

  it('a canary that fails its soak stops the group before the rest are touched', async () => {
    const { deployId } = await accepted('foreman');
    const canary = targetOf(await poll());
    await agentPost('/api/agent/progress', { targetId: canary.targetId, state: 'soaking', step: 'soak' });
    await report(canary.targetId, 'rolled_back', [], 'health_failed');
    expect(await poll()).toBeNull();
    const rest = await db.deployTarget.findMany({ where: { deployId, id: { not: canary.targetId } } });
    expect(rest.map((r) => [r.state, r.dispatchedAt])).toEqual([
      ['cancelled', null],
      ['cancelled', null],
    ]);
    expect((await groupStatus(deployId)).state).toBe('rolled_back');
  });

  it('a later member refused digest_mismatch by the agent stops the group', async () => {
    const { deployId } = await accepted('foreman');
    const canary = targetOf(await poll());
    await report(canary.targetId, 'succeeded', [{ service: 'server', digest: DIGEST_SERVER }]);
    const foreman = targetOf(await poll());
    await report(foreman.targetId, 'refused', [], 'digest_mismatch');
    expect(await poll()).toBeNull();
    const mcp = await db.deployTarget.findFirstOrThrow({ where: { deployId, app: { name: 'foreman-mcp' } } });
    expect(mcp.state).toBe('cancelled');
    expect((mcp.refusal as { message: string }).message).toContain('foreman');
  });

  it('more than one canary refuses the group, naming them', async () => {
    await db.app.update({ where: { name: 'foreman' }, data: { canary: true } });
    const res = await deployGroup('foreman');
    expect(err(res).code).toBe('manifest_invalid');
    expect(err(res).message).toContain('foreman-board');
    expect(await db.deploy.count()).toBe(0);
  });
});
