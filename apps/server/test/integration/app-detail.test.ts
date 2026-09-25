import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintOf, signingString, type AgentReport } from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { assertDeployable, recordedRelease } from '../../src/apps/drift.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { generateToken } from '../../src/tokens/index.js';

/**
 * SHP-T-3.5: app detail's rollback targets (SHP-REQ-063, SHP-D-080) and drift resolution
 * (SHP-REQ-066, SHP-D-031, SHP-D-085).
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });

const digest = (c: string): string => `sha256:${c.repeat(64)}`;
const shaOf = (c: string): string => c.repeat(40);

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

function manifest(name: string): AgentReport['apps'][number]['manifest'] {
  return {
    name,
    repo: `matdemers1/${name}`,
    defaultBranch: 'main',
    workflow: 'ci.yml',
    compose: { files: [`/data/${name}/compose.yml`], project: name },
    services: { web: { image: `ghcr.io/matdemers1/${name}` } },
    health: { service: 'web', port: 8080, path: '/health' },
    soakSeconds: 30,
    approval: 'none',
    diskFloorGb: 5,
    retainImages: 3,
  };
}

let app: Express;
let key: Key;

async function report(running: Record<string, string | null>): Promise<void> {
  const path = '/api/agent/report';
  const body: AgentReport = {
    agentVersion: '0.1.0',
    composeVersion: '5.0.1',
    engineApiVersion: '1.51',
    patExpiresAt: null,
    apps: [{ manifest: manifest('web'), manifestSha256: 'a'.repeat(64), running }],
  };
  const text = JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString('base64url');
  const data = signingString({ method: 'POST', path, timestamp, nonce, body: Buffer.from(text, 'utf8') });
  const res = await request(app)
    .post(path)
    .set({
      'x-shipyard-key': key.fingerprint,
      'x-shipyard-timestamp': timestamp,
      'x-shipyard-nonce': nonce,
      'x-shipyard-signature': sign(null, Buffer.from(data, 'utf8'), key.privateKey).toString('base64'),
      'content-type': 'application/json',
    })
    .send(text);
  expect(res.status).toBe(200);
}

async function signIn(role: 'deployer' | 'viewer' = 'deployer'): Promise<{ userId: string; cookie: string; email: string }> {
  const email = `u-${randomUUID()}@example.com`;
  const user = await db.user.create({ data: { email, displayName: 'u', role } });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return { userId: user.id, cookie: `${SESSION_COOKIE}=${session.token}`, email };
}

async function tokenFor(userId: string): Promise<string> {
  const { token, hash, prefix } = generateToken();
  const web = await db.app.findUniqueOrThrow({ where: { name: 'web' } });
  await db.apiToken.create({ data: { userId, label: 'ci', tokenHash: hash, prefix, apps: { create: [{ appId: web.id }] } } });
  return token;
}

let clock = Date.parse('2026-09-01T00:00:00Z');

/** One succeeded release the agent deployed, each later than the last. */
async function release(
  c: string,
  options: { kind?: 'deploy' | 'rollback'; migration?: string; dryRun?: boolean } = {},
): Promise<string> {
  const web = await db.app.findUniqueOrThrow({ where: { name: 'web' } });
  clock += 60_000;
  const at = new Date(clock);
  const deploy = await db.deploy.create({
    data: {
      kind: options.kind ?? 'deploy',
      requestedSha: shaOf(c),
      requesterLabel: 'matt (console)',
      dryRun: options.dryRun ?? false,
      targets: {
        create: {
          appId: web.id,
          state: 'succeeded',
          dispatchedAt: at,
          startedAt: at,
          endedAt: at,
          schemaRevision: `rev-${c}`,
          images: {
            create: [
              {
                service: 'web',
                repo: 'ghcr.io/matdemers1/web',
                sha: shaOf(c),
                digest: digest(c),
                ...(options.migration !== undefined ? { migrationLabel: options.migration } : {}),
              },
            ],
          },
        },
      },
    },
    select: { id: true },
  });
  return deploy.id;
}

interface ReleaseBody {
  deployId: string;
  sha: string;
  images: { service: string; digest: string; migration: string | null }[];
  reason?: string;
}

interface DetailBody {
  liveSha: string | null;
  liveDeployId: string | null;
  schemaRevision: string | null;
  rollbackTargets: ReleaseBody[];
  needsRestore: ReleaseBody[];
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "approval", "outbox", "drift_event", "target_image", "step", "deploy_target", "deploy", "audit_event", "agent_nonce", "api_token_app", "api_token", "session", "user", "app", "agent" cascade',
  );
  key = makeKey();
  await db.agent.create({ data: { publicKey: key.b64, fingerprint: key.fingerprint, confirmedAt: new Date() } });
  app = createApp({ db, logger: pino({ enabled: false }), config });
  await report({ web: null });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('GET /api/apps/:app rollbackTargets', () => {
  it('offers at most four: never the live one, never older than the fifth-newest, never a dry run', async () => {
    const { cookie } = await signIn();
    for (const c of ['1', '2', '3', '4', '5', '6', '7']) await release(c);
    await release('8', { dryRun: true });
    await release('9', { kind: 'rollback' });

    const res = await request(app).get('/api/apps/web').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as DetailBody;
    // Newest first: 9 (live), 7, 6, 5, 4 are the ledger's window; 3, 2, 1 are older than the fifth.
    expect(body.liveSha).toBe(shaOf('9'));
    expect(body.schemaRevision).toBe('rev-9');
    expect(body.rollbackTargets.map((t) => t.sha)).toEqual([shaOf('7'), shaOf('6'), shaOf('5'), shaOf('4')]);
    expect(body.rollbackTargets.map((t) => t.deployId)).not.toContain(body.liveDeployId);
    expect(body.rollbackTargets[0]?.images).toEqual([{ service: 'web', sha: shaOf('7'), digest: digest('7'), migration: null }]);
    expect(body.needsRestore).toEqual([]);
  });

  it('moves a target with a later contract release into "needs restore"', async () => {
    const { cookie } = await signIn();
    await release('1');
    await release('2');
    await release('3', { migration: 'contract' });
    await release('4');

    const res = await request(app).get('/api/apps/web').set('Cookie', cookie);
    const body = res.body as DetailBody;
    // 4 is live; 3 is the contract release itself (nothing contract after it); 2 and 1 sit behind it.
    expect(body.rollbackTargets.map((t) => t.sha)).toEqual([shaOf('3')]);
    expect(body.needsRestore.map((t) => t.sha)).toEqual([shaOf('2'), shaOf('1')]);
    expect(body.needsRestore[0]?.reason).toMatch(/contract migration/);
  });

  it('offers nothing for an app with one release, or none', async () => {
    const { cookie } = await signIn();
    let body = (await request(app).get('/api/apps/web').set('Cookie', cookie)).body as DetailBody;
    expect(body.rollbackTargets).toEqual([]);
    expect(body.liveSha).toBeNull();
    await release('1');
    body = (await request(app).get('/api/apps/web').set('Cookie', cookie)).body as DetailBody;
    expect(body.rollbackTargets).toEqual([]);
  });
});

/** A recorded release of 1, then the agent sees 2 running: drift. */
async function drifted(): Promise<string> {
  const recorded = await release('1');
  await report({ web: digest('2') });
  const web = await db.app.findUniqueOrThrow({ where: { name: 'web' } });
  expect(web.driftedAt).not.toBeNull();
  expect((await assertDeployable(db, 'web'))?.code).toBe('drift_unresolved');
  return recorded;
}

describe('drift resolution', () => {
  it('shows the open event, observed against recorded per service', async () => {
    const { cookie } = await signIn('viewer');
    await drifted();
    const res = await request(app).get('/api/apps/web/drift').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as { open: { services: unknown[] } | null; resolved: unknown[] };
    expect(body.open?.services).toEqual([{ service: 'web', observed: digest('2'), recorded: digest('1'), differs: true }]);
    expect(body.resolved).toEqual([]);
  });

  it('refuses adopt-live without a reason, naming the field', async () => {
    const { cookie } = await signIn();
    await drifted();
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 'x'.repeat(201) }, { reason: 'two\nlines' }]) {
      const res = await request(app).post('/api/apps/web/drift/adopt').set('Cookie', cookie).send(body);
      expect(res.status).toBe(400);
      expect((res.body as { error: { code: string; message: string } }).error.message).toMatch(/reason/);
    }
    expect((await assertDeployable(db, 'web'))?.code).toBe('drift_unresolved');
  });

  it('adopts what is running with a reason: resolves the event, records the running digests, deploys pass again', async () => {
    const { cookie, userId, email } = await signIn();
    await drifted();
    const res = await request(app)
      .post('/api/apps/web/drift/adopt')
      .set('Cookie', cookie)
      .send({ reason: 'hotfix pulled by hand during the outage' });
    expect(res.status).toBe(201);

    const event = await db.driftEvent.findFirstOrThrow({ where: {} });
    expect(event.resolvedAt).not.toBeNull();
    expect(event.resolution).toBe('adopt_live');
    expect(event.reason).toBe('hotfix pulled by hand during the outage');
    expect(event.resolvedByUserId).toBe(userId);

    const web = await db.app.findUniqueOrThrow({ where: { name: 'web' } });
    const recorded = await recordedRelease(db, web.id);
    expect(recorded?.digests).toEqual({ web: digest('2') });
    expect(recorded?.sha).toBe('0'.repeat(40));
    const deploy = await db.deploy.findUniqueOrThrow({ where: { id: recorded?.deployId ?? '' } });
    expect(deploy.requesterLabel).toContain(`adopt-live by ${email}: hotfix pulled by hand during the outage`);
    expect(web.driftedAt).toBeNull();
    expect(await assertDeployable(db, 'web')).toBeNull();

    const audit = await db.auditEvent.findFirst({ where: { action: 'drift.adopted' } });
    expect(audit).not.toBeNull();

    // The adopt record is not a ledger release: it never becomes a rollback target.
    await release('3');
    const detail = (await request(app).get('/api/apps/web').set('Cookie', cookie)).body as DetailBody;
    expect(detail.rollbackTargets.map((t) => t.sha)).toEqual([shaOf('1')]);
  });

  it('redeploys the recorded release: a rollback to it is created and the event resolved', async () => {
    const { cookie } = await signIn();
    const recordedId = await drifted();
    const res = await request(app).post('/api/apps/web/drift/redeploy').set('Cookie', cookie).send({});
    expect(res.status).toBe(201);
    const { deployId, state } = res.body as { deployId: string; state: string };
    expect(state).toBe('locked');
    const target = await db.deployTarget.findFirstOrThrow({ where: { deployId }, include: { deploy: true } });
    expect(target.deploy.kind).toBe('rollback');
    expect(target.rollbackToDeployId).toBe(recordedId);
    expect(target.deploy.requestedSha).toBe(shaOf('1'));

    const event = await db.driftEvent.findFirstOrThrow({ where: {} });
    expect(event.resolution).toBe('redeploy_recorded');
    expect(event.resolvedAt).not.toBeNull();
    expect(await db.auditEvent.count({ where: { action: 'drift.redeployed' } })).toBe(1);
  });

  it('keeps the event open when the redeploy is refused (the lock is never bypassed)', async () => {
    const { cookie } = await signIn();
    await drifted();
    const web = await db.app.findUniqueOrThrow({ where: { name: 'web' } });
    const holder = await db.deploy.create({ data: { requestedSha: shaOf('5'), requesterLabel: 'someone else' } });
    await db.deployTarget.create({ data: { deployId: holder.id, appId: web.id, state: 'locked' } });

    const res = await request(app).post('/api/apps/web/drift/redeploy').set('Cookie', cookie).send({});
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('locked');
    const event = await db.driftEvent.findFirstOrThrow({ where: {} });
    expect(event.resolvedAt).toBeNull();
  });

  it('refuses a viewer and a token (403), and anonymous (401)', async () => {
    await drifted();
    const viewer = await signIn('viewer');
    const deployer = await signIn();
    const token = await tokenFor(deployer.userId);
    for (const path of ['/api/apps/web/drift/adopt', '/api/apps/web/drift/redeploy']) {
      const asViewer = await request(app).post(path).set('Cookie', viewer.cookie).send({ reason: 'because' });
      expect(asViewer.status).toBe(403);
      const asToken = await request(app).post(path).set('Authorization', `Bearer ${token}`).send({ reason: 'because' });
      expect(asToken.status).toBe(403);
      const anonymous = await request(app).post(path).send({ reason: 'because' });
      expect(anonymous.status).toBe(401);
    }
    const event = await db.driftEvent.findFirstOrThrow({ where: {} });
    expect(event.resolvedAt).toBeNull();
  });
});
