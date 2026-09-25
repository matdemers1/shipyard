import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintOf, signingString, type AgentReport } from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { assertDeployable } from '../../src/apps/drift.js';
import { IMPORTED_REQUESTER_LABEL } from '../../src/apps/report.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { Bus } from '../../src/events.js';

/**
 * SHP-T-6.10, SHP-REQ-111: the agent reports its ledger's releases, and the server records the ones
 * it does not hold — a deploy made on the host with the CLI becomes the live release and a rollback
 * target, idempotently, only for the reporting agent's own apps, and never as a Foreman row.
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
    // Foreman is configured: an import must still never enqueue an outbox row.
    foreman: { project: 'SHP', environment: 'production' },
  };
}

type Release = NonNullable<AgentReport['releases']>[number];

function ledgerRelease(c: string, at: string, overrides: Partial<Release> = {}): Release {
  return {
    deployId: randomUUID(),
    app: 'web',
    kind: 'deploy',
    sha: shaOf(c),
    images: [{ service: 'web', repo: 'ghcr.io/matdemers1/web', digest: digest(c), migration: 'none' }],
    at,
    ...overrides,
  };
}

let app: Express;
let agentKey: Key;
let otherKey: Key;
let bus: Bus;
const logger = pino({ enabled: false });

async function agentPost(k: Key, path: string, body: unknown) {
  const text = JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString('base64url');
  const data = signingString({ method: 'POST', path, timestamp, nonce, body: Buffer.from(text, 'utf8') });
  return request(app)
    .post(path)
    .set({
      'x-shipyard-key': k.fingerprint,
      'x-shipyard-timestamp': timestamp,
      'x-shipyard-nonce': nonce,
      'x-shipyard-signature': sign(null, Buffer.from(data, 'utf8'), k.privateKey).toString('base64'),
      'content-type': 'application/json',
    })
    .send(text);
}

async function report(running: Record<string, string | null>, releases?: Release[], options: { key?: Key; apps?: string[] } = {}) {
  const body: AgentReport = {
    agentVersion: '0.1.0',
    composeVersion: '5.0.1',
    engineApiVersion: '1.51',
    patExpiresAt: null,
    apps: (options.apps ?? ['web']).map((name) => ({ manifest: manifest(name), manifestSha256: 'a'.repeat(64), running })),
    ...(releases === undefined ? {} : { releases }),
  };
  const res = await agentPost(options.key ?? agentKey, '/api/agent/report', body);
  expect(res.status).toBe(200);
  return res.body as { imported: string[]; refused: string[] };
}

/** A release the server dispatched and the agent completed: the ledger carries this deploy's own ID. */
async function serverRelease(c: string, at: string): Promise<string> {
  const web = await db.app.findUniqueOrThrow({ where: { name: 'web' } });
  const when = new Date(at);
  const deploy = await db.deploy.create({
    data: {
      requestedSha: shaOf(c),
      requesterLabel: 'matt (console)',
      targets: {
        create: {
          appId: web.id,
          state: 'succeeded',
          dispatchedAt: when,
          startedAt: when,
          endedAt: when,
          images: { create: [{ service: 'web', repo: 'ghcr.io/matdemers1/web', sha: shaOf(c), digest: digest(c) }] },
        },
      },
    },
    select: { id: true },
  });
  return deploy.id;
}

async function signIn(): Promise<string> {
  const user = await db.user.create({ data: { email: `u-${randomUUID()}@example.com`, displayName: 'u', role: 'deployer' } });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return `${SESSION_COOKIE}=${session.token}`;
}

interface DetailBody {
  liveSha: string | null;
  liveDeployId: string | null;
  rollbackTargets: { deployId: string; sha: string; requester: string }[];
}

async function detail(cookie: string, name = 'web'): Promise<DetailBody> {
  const res = await request(app).get(`/api/apps/${name}`).set('cookie', cookie);
  expect(res.status).toBe(200);
  return res.body as DetailBody;
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "approval", "outbox", "drift_event", "target_image", "step", "deploy_target", "deploy", "audit_event", "agent_nonce", "api_token_app", "api_token", "session", "user", "app", "agent" cascade',
  );
  agentKey = makeKey();
  otherKey = makeKey();
  await db.agent.create({ data: { publicKey: agentKey.b64, fingerprint: agentKey.fingerprint, confirmedAt: new Date() } });
  await db.agent.create({ data: { publicKey: otherKey.b64, fingerprint: otherKey.fingerprint, confirmedAt: new Date() } });
  bus = new Bus();
  app = createApp({ db, logger, config, bus });
  await report({ web: null });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('ledger sync (SHP-REQ-111)', () => {
  it('records a CLI-style ledger release as live, keeps the server release as a rollback target, and never duplicates', async () => {
    const cookie = await signIn();
    const serverId = await serverRelease('1', '2026-09-24T10:00:00.000Z');
    const cli = ledgerRelease('2', '2026-09-25T14:03:11.402Z');
    const serverInLedger = ledgerRelease('1', '2026-09-24T10:00:00.000Z', { deployId: serverId });

    const first = await report({ web: digest('2') }, [serverInLedger, cli]);
    expect(first.imported).toEqual([cli.deployId]);

    const body = await detail(cookie);
    expect(body.liveSha).toBe(shaOf('2'));
    expect(body.liveDeployId).toBe(cli.deployId);
    expect(body.rollbackTargets.map((t) => t.deployId)).toEqual([serverId]);

    const target = await db.deployTarget.findFirstOrThrow({
      where: { deployId: cli.deployId },
      include: { deploy: true, images: true },
    });
    expect(target).toMatchObject({ state: 'succeeded', rollbackToDeployId: null });
    expect(target.dispatchedAt?.toISOString()).toBe(cli.at);
    expect(target.endedAt?.toISOString()).toBe(cli.at);
    expect(target.deploy).toMatchObject({ kind: 'deploy', requestedSha: shaOf('2'), requesterLabel: IMPORTED_REQUESTER_LABEL, dryRun: false });
    expect(target.images).toMatchObject([{ service: 'web', repo: 'ghcr.io/matdemers1/web', sha: shaOf('2'), digest: digest('2'), migrationLabel: 'none' }]);

    // Drift sees the imported release as recorded: nothing drifted, forward deploys allowed.
    expect((await db.app.findUniqueOrThrow({ where: { name: 'web' } })).driftedAt).toBeNull();
    expect(await db.driftEvent.count()).toBe(0);
    expect(await assertDeployable(db, 'web')).toBeNull();

    const audits = await db.auditEvent.findMany({ where: { action: 'deploy.imported' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityType: 'deploy', entityId: cli.deployId, actorType: 'agent' });

    // Re-reporting creates nothing.
    const again = await report({ web: digest('2') }, [serverInLedger, cli]);
    expect(again.imported).toEqual([]);
    expect(await db.deploy.count()).toBe(2);
    expect(await db.deployTarget.count()).toBe(2);
    expect(await db.auditEvent.count({ where: { action: 'deploy.imported' } })).toBe(1);

    // Never posted to Foreman.
    expect(await db.outbox.count()).toBe(0);
  });

  it('closes drift the CLI deploy opened once the release that explains it is imported', async () => {
    await serverRelease('1', '2026-09-24T10:00:00.000Z');
    // An agent without ledger sync reported what the CLI put live: drift.
    await report({ web: digest('2') });
    expect((await assertDeployable(db, 'web'))?.code).toBe('drift_unresolved');

    const cli = ledgerRelease('2', '2026-09-25T14:03:11.402Z');
    await report({ web: digest('2') }, [cli]);
    expect(await assertDeployable(db, 'web')).toBeNull();
    const event = await db.driftEvent.findFirstOrThrow();
    expect(event.resolvedAt).not.toBeNull();
    expect(event.resolution).toBeNull();
    expect(event.reason).toContain(cli.deployId);
  });

  it('an older imported release is a rollback target, not the live one', async () => {
    const cookie = await signIn();
    const serverId = await serverRelease('3', '2026-09-25T12:00:00.000Z');
    const older = ledgerRelease('2', '2026-09-24T12:00:00.000Z', { kind: 'rollback' });
    await report({ web: digest('3') }, [older]);
    const body = await detail(cookie);
    expect(body.liveDeployId).toBe(serverId);
    expect(body.rollbackTargets.map((t) => t.deployId)).toEqual([older.deployId]);
    expect(body.rollbackTargets[0]?.requester).toBe(IMPORTED_REQUESTER_LABEL);
  });

  it("ignores another agent's app, and releases for an app the report does not name", async () => {
    // "web" belongs to the first agent; the other agent reports it with a release.
    const foreign = ledgerRelease('5', '2026-09-25T15:00:00.000Z');
    const res = await report({ web: digest('5') }, [foreign], { key: otherKey });
    expect(res.refused).toEqual(['web']);
    expect(res.imported).toEqual([]);

    // The owning agent reports only "web", with a release naming "api", which it does not report.
    const stray = ledgerRelease('6', '2026-09-25T15:00:00.000Z', { app: 'api' });
    const own = await report({ web: null }, [stray]);
    expect(own.imported).toEqual([]);
    expect(await db.deploy.count()).toBe(0);
  });

  it('skips a ledger deploy ID that is not a UUID', async () => {
    const odd = ledgerRelease('7', '2026-09-25T15:00:00.000Z', { deployId: 'cli-20260925-1' });
    const res = await report({ web: digest('7') }, [odd]);
    expect(res.imported).toEqual([]);
    expect(await db.deploy.count()).toBe(0);
  });
});
