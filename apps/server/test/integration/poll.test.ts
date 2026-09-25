import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintOf, signingString, type DeployAccepted, type PollResponse, type Refusal } from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { ServiceDeps } from '../../src/deps.js';
import { createDeploy, getDeployStatus, isRefusal, type DeployCaller } from '../../src/deploys/service.js';
import { Bus } from '../../src/events.js';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });

const SHA = 'c'.repeat(40);
const DIGEST_WEB = `sha256:${'a'.repeat(64)}`;
const DIGEST_WORKER = `sha256:${'b'.repeat(64)}`;

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

let bus: Bus;
let app: Express;
let deps: ServiceDeps;
let key: Key;
let agentId: string;
let otherKey: Key;
let caller: DeployCaller;

async function post(path: string, body: unknown, k: Key = key) {
  const text = JSON.stringify(body);
  return request(app).post(path).set(signed(k, path, text)).send(text);
}

async function poll(waitSeconds: number, k: Key = key): Promise<PollResponse> {
  const res = await post('/api/agent/poll', { waitSeconds }, k);
  expect(res.status).toBe(200);
  return res.body as PollResponse;
}

async function enrol(k: Key): Promise<string> {
  const row = await db.agent.create({ data: { publicKey: k.b64, fingerprint: k.fingerprint, confirmedAt: new Date() } });
  return row.id;
}

async function seedApp(name: string, owner: string, extra: { foremanProject?: string } = {}): Promise<string> {
  const row = await db.app.create({
    data: {
      name,
      agentId: owner,
      manifestYaml: `name: ${name}\n`,
      manifestSha256: '0'.repeat(64),
      reportedAt: new Date(),
      services: { web: { image: `ghcr.io/matdemers1/${name}` }, worker: { image: `ghcr.io/matdemers1/${name}-worker` } },
      ...(extra.foremanProject === undefined ? {} : { foremanProject: extra.foremanProject }),
    },
  });
  return row.id;
}

async function deploy(appName: string, dryRun = false): Promise<DeployAccepted> {
  const result = await createDeploy(deps, caller, { kind: 'deploy', app: appName, sha: SHA, dryRun }, { check: () => Promise.resolve(null) });
  if (isRefusal(result)) throw new Error(`deploy refused: ${result.message}`);
  return result;
}

function targetOf(r: PollResponse): NonNullable<PollResponse['target']> {
  if (r.target === null) throw new Error('expected a target');
  return r.target;
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "backup_artifact", "outbox", "drift_event", "target_image", "step", "deploy_target", "deploy", "audit_event", "agent_nonce", "api_token_app", "app", "agent", "session", "user" cascade',
  );
  key = makeKey();
  otherKey = makeKey();
  agentId = await enrol(key);
  const otherAgentId = await enrol(otherKey);
  await seedApp('web', agentId, { foremanProject: 'SHP' });
  await seedApp('api', agentId);
  await seedApp('elsewhere', otherAgentId);
  bus = new Bus();
  deps = { db, logger, config, bus };
  app = createApp({ db, logger, config, bus });
  const user = await db.user.create({ data: { email: `svc-${randomUUID()}@example.com`, displayName: 'svc', role: 'deployer' } });
  caller = {
    actor: { type: 'user', id: user.id, label: user.email },
    role: 'deployer',
    tokenApps: undefined,
    audit: () => Promise.resolve(),
  };
});

afterAll(async () => {
  await db.$disconnect();
});

describe('POST /api/agent/poll (SHP-REQ-040)', () => {
  it('with nothing queued, waits out waitSeconds and answers { target: null }', async () => {
    const started = Date.now();
    const res = await poll(1);
    const elapsed = Date.now() - started;
    expect(res).toEqual({ target: null });
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(5_000);
  });

  it('doneWhen: a queued deploy reaches a waiting poll within one second', async () => {
    const pending = poll(25);
    // Let the poll arrive and arm its wait before the deploy is queued.
    await new Promise((r) => setTimeout(r, 300));
    const queuedAt = Date.now();
    const accepted = await deploy('web');
    const res = await pending;
    const reachedAfter = Date.now() - queuedAt;

    const target = targetOf(res);
    expect(target).toMatchObject({ deployId: accepted.deployId, kind: 'deploy', app: 'web', sha: SHA, dryRun: false });
    expect(reachedAfter).toBeLessThan(1_000);
    const row = await db.deployTarget.findUniqueOrThrow({ where: { id: target.targetId } });
    expect(row.dispatchedAt).not.toBeNull();
    expect(await db.auditEvent.count({ where: { action: 'deploy.dispatched', actorAgentId: agentId } })).toBe(1);
  });

  it('answers at once when work is already queued, and never dispatches it twice', async () => {
    const accepted = await deploy('web');
    const first = targetOf(await poll(0));
    expect(first.deployId).toBe(accepted.deployId);
    expect(await poll(0)).toEqual({ target: null });
  });

  it('re-dispatches a target whose poll response was lost (dispatched, never started, 2 min)', async () => {
    await deploy('web');
    const first = targetOf(await poll(1));
    // The agent never saw it: nothing started. Fresh, it is not handed out again...
    expect((await poll(0)).target).toBeNull();
    // ...but two minutes on it is, so the app's lock cannot be held forever.
    await db.deployTarget.update({ where: { id: first.targetId }, data: { dispatchedAt: new Date(Date.now() - 3 * 60_000) } });
    expect(targetOf(await poll(1)).targetId).toBe(first.targetId);
  });

  it('two concurrent polls never take the same target (SKIP LOCKED)', async () => {
    await deploy('web');
    await deploy('api');
    await deploy('web', true);
    const results = await Promise.all(Array.from({ length: 6 }, () => poll(1)));
    const ids = results.flatMap((r) => (r.target === null ? [] : [r.target.targetId]));
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('a dry run is claimable while a real deploy of the same app holds the lock', async () => {
    const real = await deploy('web');
    const first = targetOf(await poll(0));
    expect(first.deployId).toBe(real.deployId);
    const dry = await deploy('web', true);
    expect(dry.state).toBe('queued');
    const second = targetOf(await poll(0));
    expect(second).toMatchObject({ deployId: dry.deployId, dryRun: true });
  });

  it("never hands out another agent's target", async () => {
    await createDeploy(deps, caller, { kind: 'deploy', app: 'elsewhere', sha: SHA }, { check: () => Promise.resolve(null) });
    expect(await poll(0)).toEqual({ target: null });
    const theirs = targetOf(await poll(0, otherKey));
    expect(theirs.app).toBe('elsewhere');
  });

  it('carries a rollback target deploy', async () => {
    const earlier = await deploy('web');
    await db.deployTarget.updateMany({ where: { deployId: earlier.deployId }, data: { state: 'succeeded', endedAt: new Date(), dispatchedAt: new Date() } });
    const rb = await createDeploy(deps, caller, { kind: 'rollback', app: 'web', toDeployId: earlier.deployId }, { check: () => Promise.resolve(null) });
    if (isRefusal(rb)) throw new Error(rb.message);
    const target = targetOf(await poll(0));
    expect(target).toMatchObject({ deployId: rb.deployId, kind: 'rollback', toDeployId: earlier.deployId, sha: SHA });
  });

  it('every poll is a heartbeat', async () => {
    expect((await db.agent.findUniqueOrThrow({ where: { id: agentId } })).lastHeartbeatAt).toBeNull();
    await poll(0);
    const first = (await db.agent.findUniqueOrThrow({ where: { id: agentId } })).lastHeartbeatAt;
    expect(first).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    await poll(0);
    const second = (await db.agent.findUniqueOrThrow({ where: { id: agentId } })).lastHeartbeatAt;
    expect(second?.getTime()).toBeGreaterThan(first?.getTime() ?? 0);
  });

  it('refuses an unsigned poll and an over-long wait', async () => {
    const unsigned = await request(app).post('/api/agent/poll').send({ waitSeconds: 1 });
    expect(unsigned.status).toBe(401);
    const tooLong = await post('/api/agent/poll', { waitSeconds: 26 });
    expect(tooLong.status).toBe(400);
  });
});

describe('progress, steps and result', () => {
  it('progress moves the state forward and the step, visible in the deploy status', async () => {
    const accepted = await deploy('web');
    const target = targetOf(await poll(0));

    const woke = bus.wait(`deploy:${accepted.deployId}`, 2_000);
    const p1 = await post('/api/agent/progress', { targetId: target.targetId, state: 'verifying', step: 'verify' });
    expect(p1.status).toBe(200);
    expect(await woke).toBe(true);
    let status = await getDeployStatus(db, accepted.deployId);
    expect(status).toMatchObject({ state: 'verifying', currentStep: 'verify' });

    await post('/api/agent/progress', { targetId: target.targetId, state: 'swapping', step: 'swap' });
    // A regression is ignored; the step still moves.
    await post('/api/agent/progress', { targetId: target.targetId, state: 'verifying', step: 'late' });
    status = await getDeployStatus(db, accepted.deployId);
    expect(status).toMatchObject({ state: 'swapping', currentStep: 'late' });
    const row = await db.deployTarget.findUniqueOrThrow({ where: { id: target.targetId } });
    expect(row.startedAt).not.toBeNull();
  });

  it("a dry run's progress moves only its step, never onto the lock", async () => {
    await deploy('web');
    targetOf(await poll(0));
    const dry = await deploy('web', true);
    const target = targetOf(await poll(0));
    const res = await post('/api/agent/progress', { targetId: target.targetId, state: 'verifying', step: 'verify' });
    expect(res.status).toBe(200);
    expect(await getDeployStatus(db, dry.deployId)).toMatchObject({ state: 'queued', currentStep: 'verify' });
  });

  it('steps are stored: start creates the row, end fills it with the last 50 lines', async () => {
    await deploy('web');
    const target = targetOf(await poll(0));
    const start = await post('/api/agent/steps', { targetId: target.targetId, name: 'migrate', argv: ['npm', 'run', 'migrate'], phase: 'start' });
    expect(start.status).toBe(200);
    const output = Array.from({ length: 80 }, (_, i) => `line ${String(i + 1)}`).join('\n');
    const end = await post('/api/agent/steps', {
      targetId: target.targetId,
      name: 'migrate',
      argv: ['npm', 'run', 'migrate'],
      phase: 'end',
      exitCode: 0,
      output,
    });
    expect(end.status).toBe(200);
    const steps = await db.step.findMany({ where: { targetId: target.targetId } });
    expect(steps).toHaveLength(1);
    const step = steps[0];
    expect(step).toMatchObject({ name: 'migrate', argv: ['npm', 'run', 'migrate'], exitCode: 0 });
    expect(step?.endedAt).not.toBeNull();
    const lines = step?.output?.split('\n') ?? [];
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe('line 31');
    expect(lines.at(-1)).toBe('line 80');
  });

  it('the result sets the terminal state, images, backup and outbox rows; a duplicate is 409', async () => {
    const accepted = await deploy('web');
    const target = targetOf(await poll(0));
    await post('/api/agent/progress', { targetId: target.targetId, state: 'soaking', step: 'soak' });

    const result = {
      targetId: target.targetId,
      state: 'succeeded',
      images: [
        { service: 'web', sha: SHA, digest: DIGEST_WEB },
        { service: 'worker', sha: SHA, digest: DIGEST_WORKER },
      ],
      schemaRevision: '20260924_init',
      gates: [{ gate: 'G5', pass: true, reason: 'ci.yml succeeded' }],
      backupArtifact: { path: '/data/backups/web/1.sql.gz', size: 1234, createdAt: new Date().toISOString() },
    };
    const res = await post('/api/agent/result', result);
    expect(res.status).toBe(200);

    const status = await getDeployStatus(db, accepted.deployId);
    expect(status).toMatchObject({
      state: 'succeeded',
      schemaRevision: '20260924_init',
      images: [
        { service: 'web', sha: SHA, digest: DIGEST_WEB },
        { service: 'worker', sha: SHA, digest: DIGEST_WORKER },
      ],
      gates: [{ gate: 'G5', pass: true, reason: 'ci.yml succeeded' }],
    });
    expect(status?.endedAt).not.toBeNull();
    const images = await db.targetImage.findMany({ where: { targetId: target.targetId }, orderBy: { service: 'asc' } });
    expect(images.map((i) => i.repo)).toEqual(['ghcr.io/matdemers1/web', 'ghcr.io/matdemers1/web-worker']);
    const backups = await db.backupArtifact.findMany({ where: { targetId: target.targetId } });
    expect(backups).toHaveLength(1);
    expect(backups[0]?.size).toBe(1234n);
    expect(await db.outbox.count({ where: { targetId: target.targetId } })).toBe(2);
    expect(await db.auditEvent.count({ where: { action: 'deploy.result', actorAgentId: agentId } })).toBe(1);

    const dup = await post('/api/agent/result', result);
    expect(dup.status).toBe(409);
    expect((dup.body as { error: Refusal }).error.code).toBe('conflict');
    const late = await post('/api/agent/progress', { targetId: target.targetId, state: 'soaking' });
    expect(late.status).toBe(409);

    // The lock is free: the next deploy of the app is accepted.
    await deploy('web');
  });

  it('a failed result carries its refusal; a dry run records no images and queues no outbox rows', async () => {
    const real = await deploy('web');
    const realTarget = targetOf(await poll(0));
    const refused = await post('/api/agent/result', {
      targetId: realTarget.targetId,
      state: 'refused',
      images: [],
      refusal: { code: 'ci_not_green', gate: 'G5', message: 'CI is red.', fix: 'Fix CI.' },
    });
    expect(refused.status).toBe(200);
    expect(await getDeployStatus(db, real.deployId)).toMatchObject({ state: 'refused', refusal: { code: 'ci_not_green' } });

    const dry = await deploy('web', true);
    const dryTarget = targetOf(await poll(0));
    const ok = await post('/api/agent/result', {
      targetId: dryTarget.targetId,
      state: 'succeeded',
      images: [{ service: 'web', sha: SHA, digest: DIGEST_WEB }],
      gates: [{ gate: 'G8', pass: true, reason: 'digests present' }],
    });
    expect(ok.status).toBe(200);
    expect(await getDeployStatus(db, dry.deployId)).toMatchObject({ state: 'succeeded', images: [], gates: [{ gate: 'G8', pass: true }] });
    expect(await db.outbox.count()).toBe(0);
  });

  it("another agent's target, or one never dispatched, is 404", async () => {
    await deploy('web');
    const mine = targetOf(await poll(0));
    const notYet = await deploy('api');
    const notYetTarget = await db.deployTarget.findFirstOrThrow({ where: { deployId: notYet.deployId } });

    const asOther = await post('/api/agent/progress', { targetId: mine.targetId, state: 'verifying' }, otherKey);
    expect(asOther.status).toBe(404);
    const resultAsOther = await post('/api/agent/result', { targetId: mine.targetId, state: 'failed', images: [] }, otherKey);
    expect(resultAsOther.status).toBe(404);
    const stepAsOther = await post('/api/agent/steps', { targetId: mine.targetId, name: 'x', argv: ['x'], phase: 'start' }, otherKey);
    expect(stepAsOther.status).toBe(404);
    const undispatched = await post('/api/agent/result', { targetId: notYetTarget.id, state: 'failed', images: [] });
    expect(undispatched.status).toBe(404);
    expect((await db.deployTarget.findUniqueOrThrow({ where: { id: mine.targetId } })).state).toBe('locked');
  });
});
