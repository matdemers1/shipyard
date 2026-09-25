import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintOf, signingString, type AgentReport } from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { assertDeployable } from '../../src/apps/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { Bus } from '../../src/events.js';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl });

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

function signed(key: Key, method: string, path: string, body: string): Record<string, string> {
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString('base64url');
  const data = signingString({ method, path, timestamp, nonce, body: Buffer.from(body, 'utf8') });
  return {
    'x-shipyard-key': key.fingerprint,
    'x-shipyard-timestamp': timestamp,
    'x-shipyard-nonce': nonce,
    'x-shipyard-signature': sign(null, Buffer.from(data, 'utf8'), key.privateKey).toString('base64'),
  };
}

const PATH = '/api/agent/report';
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_DB = `sha256:${'d'.repeat(64)}`;
const SHA = '1'.repeat(40);

function manifest(name: string, extra: Record<string, unknown> = {}): AgentReport['apps'][number]['manifest'] {
  return {
    name,
    repo: `matdemers1/${name}`,
    defaultBranch: 'main',
    workflow: 'ci.yml',
    compose: { files: [`/data/${name}/compose.yml`], project: name },
    services: { web: { image: `ghcr.io/matdemers1/${name}` }, worker: { image: `ghcr.io/matdemers1/${name}-worker` } },
    health: { service: 'web', port: 8080, path: '/health' },
    soakSeconds: 60,
    approval: 'none',
    diskFloorGb: 5,
    retainImages: 3,
    ...extra,
  };
}

function report(apps: AgentReport['apps'], agentVersion = '0.1.0'): AgentReport {
  return { agentVersion, composeVersion: '5.0.1', engineApiVersion: '1.51', patExpiresAt: null, apps };
}

let key: Key;
let agentId: string;
let bus: Bus;
let app: Express;

async function send(body: AgentReport, k: Key = key) {
  const text = JSON.stringify(body);
  return request(app).post(PATH).set(signed(k, 'POST', PATH, text)).set('content-type', 'application/json').send(text);
}

/** A succeeded deploy of `appName` whose recorded web image is `digest`. */
async function seedSucceeded(appName: string, digest: string): Promise<void> {
  const row = await db.app.findUniqueOrThrow({ where: { name: appName } });
  const deploy = await db.deploy.create({ data: { requestedSha: SHA, requesterLabel: 'user matthew' } });
  await db.deployTarget.create({
    data: {
      deployId: deploy.id,
      appId: row.id,
      state: 'succeeded',
      endedAt: new Date(),
      images: {
        create: [
          { service: 'web', repo: `ghcr.io/matdemers1/${appName}`, sha: SHA, digest },
          { service: 'worker', repo: `ghcr.io/matdemers1/${appName}-worker`, sha: SHA, digest: DIGEST_DB },
        ],
      },
    },
  });
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "drift_event", "target_image", "step", "deploy_target", "deploy", "audit_event", "agent_nonce", "api_token_app", "app", "agent" cascade',
  );
  key = makeKey();
  agentId = (await db.agent.create({ data: { publicKey: key.b64, fingerprint: key.fingerprint, confirmedAt: new Date() } })).id;
  bus = new Bus();
  app = createApp({ db, logger: pino({ enabled: false }), config, bus });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('POST /api/agent/report', () => {
  it('creates app rows from a signed report, and updates the agent', async () => {
    const woke = bus.wait('app:web', 5_000);
    const res = await send(report([{ manifest: manifest('web', { group: 'core', canary: true, foreman: { project: 'SHP', environment: 'production' } }), manifestSha256: 'a'.repeat(64), running: { web: DIGEST_A, worker: null } }]));
    expect(res.status).toBe(200);
    expect(await woke).toBe(true);

    const row = await db.app.findUniqueOrThrow({ where: { name: 'web' } });
    expect(row).toMatchObject({
      agentId,
      manifestSha256: 'a'.repeat(64),
      repo: 'matdemers1/web',
      defaultBranch: 'main',
      soakSeconds: 60,
      approvalPolicy: 'none',
      foremanProject: 'SHP',
      foremanEnvironment: 'production',
      groupName: 'core',
      canary: true,
      runningDigests: { web: DIGEST_A, worker: null },
      driftedAt: null,
    });
    expect(row.reportedAt).not.toBeNull();
    expect(JSON.parse(row.manifestYaml)).toMatchObject({ name: 'web', workflow: 'ci.yml' });

    const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(agent).toMatchObject({ agentVersion: '0.1.0', composeVersion: '5.0.1', engineApiVersion: '1.51' });
    expect(agent.lastHeartbeatAt).not.toBeNull();

    const audit = await db.auditEvent.findMany({ where: { action: 'agent.report' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorAgentId).toBe(agentId);
  });

  it('updates the rows on a second report, and leaves an unreported app alone', async () => {
    await send(report([
      { manifest: manifest('web'), manifestSha256: 'a'.repeat(64), running: { web: DIGEST_A } },
      { manifest: manifest('api'), manifestSha256: 'c'.repeat(64), running: { web: DIGEST_A } },
    ]));
    const apiBefore = await db.app.findUniqueOrThrow({ where: { name: 'api' } });

    const res = await send(report([{ manifest: manifest('web', { soakSeconds: 120, approval: 'required' }), manifestSha256: 'b'.repeat(64), running: { web: DIGEST_B } }], '0.2.0'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: ['web'], created: [] });

    const web = await db.app.findUniqueOrThrow({ where: { name: 'web' } });
    expect(web).toMatchObject({ manifestSha256: 'b'.repeat(64), soakSeconds: 120, approvalPolicy: 'required', runningDigests: { web: DIGEST_B } });
    const apiAfter = await db.app.findUniqueOrThrow({ where: { name: 'api' } });
    expect(apiAfter).toEqual(apiBefore);
    expect(await db.app.count()).toBe(2);
    expect((await db.agent.findUniqueOrThrow({ where: { id: agentId } })).agentVersion).toBe('0.2.0');
  });

  it('refuses an unsigned report with 401 and writes nothing', async () => {
    const text = JSON.stringify(report([{ manifest: manifest('web'), manifestSha256: 'a'.repeat(64), running: {} }]));
    const res = await request(app).post(PATH).set('content-type', 'application/json').send(text);
    expect(res.status).toBe(401);
    expect(await db.app.count()).toBe(0);
  });

  it('refuses a report from an unconfirmed agent', async () => {
    const other = makeKey();
    await db.agent.create({ data: { publicKey: other.b64, fingerprint: other.fingerprint } });
    const res = await send(report([{ manifest: manifest('web'), manifestSha256: 'a'.repeat(64), running: {} }]), other);
    expect(res.status).toBe(403);
    expect(await db.app.count()).toBe(0);
  });

  it('refuses an invalid report', async () => {
    const bad = { ...report([]), apps: [{ manifest: { name: 'web' }, manifestSha256: 'x', running: {} }] } as unknown as AgentReport;
    const res = await send(bad);
    expect(res.status).toBe(400);
    expect(await db.app.count()).toBe(0);
  });
});

describe('drift', () => {
  it('flags an app whose running digest differs from its recorded release, once', async () => {
    await send(report([{ manifest: manifest('web'), manifestSha256: 'a'.repeat(64), running: { web: DIGEST_A, worker: DIGEST_DB } }]));
    await seedSucceeded('web', DIGEST_A);
    expect(await assertDeployable(db, 'web')).toBeNull();

    // Same digests again: no drift.
    await send(report([{ manifest: manifest('web'), manifestSha256: 'a'.repeat(64), running: { web: DIGEST_A, worker: DIGEST_DB } }]));
    expect(await db.driftEvent.count()).toBe(0);

    // Someone changed it over SSH: the next report flags it.
    const res = await send(report([{ manifest: manifest('web'), manifestSha256: 'a'.repeat(64), running: { web: DIGEST_B, worker: DIGEST_DB } }]));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ drifted: ['web'] });
    const row = await db.app.findUniqueOrThrow({ where: { name: 'web' } });
    expect(row.driftedAt).not.toBeNull();
    const events = await db.driftEvent.findMany({ where: { appId: row.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      observed: { web: DIGEST_B, worker: DIGEST_DB },
      recorded: { web: DIGEST_A, worker: DIGEST_DB },
      resolvedAt: null,
    });

    const refused = await assertDeployable(db, 'web');
    expect(refused).toMatchObject({ code: 'drift_unresolved', gate: 'G3' });

    // Reporting B again does not open a second event; nor does going back to A close it.
    await send(report([{ manifest: manifest('web'), manifestSha256: 'a'.repeat(64), running: { web: DIGEST_B, worker: DIGEST_DB } }]));
    await send(report([{ manifest: manifest('web'), manifestSha256: 'a'.repeat(64), running: { web: DIGEST_A, worker: DIGEST_DB } }]));
    expect(await db.driftEvent.count()).toBe(1);
    expect((await assertDeployable(db, 'web'))?.code).toBe('drift_unresolved');
  });

  it('does not flag an app Shipyard has never deployed, or a stopped service', async () => {
    await send(report([{ manifest: manifest('fresh'), manifestSha256: 'a'.repeat(64), running: { web: DIGEST_B } }]));
    expect(await db.driftEvent.count()).toBe(0);
    expect(await assertDeployable(db, 'fresh')).toBeNull();

    await seedSucceeded('fresh', DIGEST_A);
    await send(report([{ manifest: manifest('fresh'), manifestSha256: 'a'.repeat(64), running: { web: null, worker: DIGEST_DB } }]));
    expect(await db.driftEvent.count()).toBe(0);
  });

  it('does not flag an app mid-deploy', async () => {
    await send(report([{ manifest: manifest('web'), manifestSha256: 'a'.repeat(64), running: { web: DIGEST_A } }]));
    await seedSucceeded('web', DIGEST_A);
    const row = await db.app.findUniqueOrThrow({ where: { name: 'web' } });
    const deploy = await db.deploy.create({ data: { requestedSha: '2'.repeat(40), requesterLabel: 'user matthew' } });
    await db.deployTarget.create({ data: { deployId: deploy.id, appId: row.id, state: 'swapping' } });
    await send(report([{ manifest: manifest('web'), manifestSha256: 'a'.repeat(64), running: { web: DIGEST_B } }]));
    expect(await db.driftEvent.count()).toBe(0);
  });

  it('refuses an app the agent has not reported as unknown_app', async () => {
    expect(await assertDeployable(db, 'ghost')).toMatchObject({ code: 'unknown_app' });
  });
});

describe('only the report writes app rows (SHP-REQ-104)', () => {
  it('refuses a report naming an app another agent owns, and leaves the app with its owner', async () => {
    const entry = { manifest: manifest('web'), manifestSha256: 'a'.repeat(64), running: { web: DIGEST_A, worker: null } };
    expect((await send(report([entry]))).status).toBe(200);
    const other = makeKey();
    await db.agent.create({ data: { publicKey: other.b64, fingerprint: other.fingerprint, confirmedAt: new Date() } });
    const res = await send(report([{ ...entry, manifestSha256: 'c'.repeat(64) }]), other);
    expect(res.status).toBe(200);
    expect((res.body as { refused: string[] }).refused).toEqual(['web']);
    const row = await db.app.findUniqueOrThrow({ where: { name: 'web' } });
    expect(row.agentId).toBe(agentId);
    expect(row.manifestSha256).toBe('a'.repeat(64));
  });

  it('finds no app create/upsert/update outside src/apps/report.ts and src/apps/drift.ts', async () => {
    const root = join(import.meta.dirname, '../../src');
    const allowed = new Set(['apps/report.ts', 'apps/drift.ts']);
    const writes = /\.app\s*\.\s*(create|createMany|createManyAndReturn|upsert|update|updateMany|updateManyAndReturn|delete|deleteMany)\s*\(/;
    const offenders: string[] = [];
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
      const file = join(entry.parentPath, entry.name);
      const rel = relative(root, file).split('\\').join('/');
      if (rel.startsWith('generated/') || allowed.has(rel)) continue;
      const text = await readFile(file, 'utf8');
      // Whole-file, whitespace-collapsed, so a call chain split across lines still matches; and
      // raw SQL that names the app table counts as a write too.
      const flat = text.replace(/\s+/g, ' ');
      if (writes.test(flat)) offenders.push(`${rel}: ORM write to app`);
      if (/\$(executeRaw|executeRawUnsafe|queryRaw|queryRawUnsafe)\b[^;]*\b(insert\s+into|update|delete\s+from)\s+"?app"?\b/i.test(flat)) {
        offenders.push(`${rel}: raw SQL write to app`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
