import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import express, { type Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintOf, signingString, type AgentReport } from '@shipyard/schema';
import type { GitHubPort } from '@shipyard/sequence';
import { agentRouter } from '../../src/agent/index.js';
import { appsRouter } from '../../src/apps/index.js';
import { commitsRouter } from '../../src/apps/commits.js';
import { auditContext } from '../../src/audit.js';
import { SESSION_COOKIE, authenticate, createSession } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { errorHandler } from '../../src/errors.js';
import { Bus } from '../../src/events.js';
import { generateToken } from '../../src/tokens/index.js';

/**
 * `GET /api/apps/:app/commits` (SHP-T-3.2, SHP-REQ-056, SHP-REQ-059, SHP-REQ-087). Built as its
 * own small app (`agentRouter` to seed apps, `appsRouter` for `App`-not-found parity, then
 * `commitsRouter` with a fake `GitHubPort`) rather than the full `createApp`, since the router's
 * name and mount point are fixed but the GitHub adapter is injected only here.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const SHA_LIVE = 'a'.repeat(40);
const SHA_MID = 'b'.repeat(40);
const SHA_HEAD = 'c'.repeat(40);

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
    approval: 'required',
    diskFloorGb: 5,
    retainImages: 3,
    group: 'core',
  };
}

class FakeGitHub implements GitHubPort {
  compareResult: Awaited<ReturnType<GitHubPort['compare']>> = null;
  runsByHeadSha = new Map<string, Parameters<GitHubPort['workflowRuns']> extends never ? never : Awaited<ReturnType<GitHubPort['workflowRuns']>>>();
  compareError: Error | null = null;

  compare(_repo: string, _base: string, _head: string): ReturnType<GitHubPort['compare']> {
    if (this.compareError !== null) return Promise.reject(this.compareError);
    return Promise.resolve(this.compareResult);
  }

  workflowRuns(_repo: string, _workflow: string, headSha: string): ReturnType<GitHubPort['workflowRuns']> {
    if (this.compareError !== null) return Promise.reject(this.compareError);
    return Promise.resolve(this.runsByHeadSha.get(headSha) ?? []);
  }
}

function run(id: number, headSha: string, conclusion: string | null, status = 'completed'): Awaited<ReturnType<GitHubPort['workflowRuns']>>[number] {
  return { id, headSha, path: '.github/workflows/ci.yml', status, conclusion, event: 'push', headBranch: 'main' };
}

let app: Express;
let key: Key;
let github: FakeGitHub;

async function reportApps(apps: AgentReport['apps']): Promise<void> {
  const path = '/api/agent/report';
  const body: AgentReport = { agentVersion: '0.1.0', composeVersion: '5.0.1', engineApiVersion: '1.51', patExpiresAt: null, apps };
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

async function signIn(): Promise<{ userId: string; cookie: string }> {
  const user = await db.user.create({ data: { email: `u-${randomUUID()}@example.com`, displayName: 'u', role: 'deployer' } });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return { userId: user.id, cookie: `${SESSION_COOKIE}=${session.token}` };
}

async function tokenFor(userId: string, apps: string[]): Promise<string> {
  const { token, hash, prefix } = generateToken();
  const rows = await db.app.findMany({ where: { name: { in: apps } }, select: { id: true } });
  await db.apiToken.create({
    data: { userId, label: 'ci', tokenHash: hash, prefix, apps: { create: rows.map((r) => ({ appId: r.id })) } },
  });
  return token;
}

async function recordRelease(appName: string, sha: string): Promise<void> {
  const row = await db.app.findUniqueOrThrow({ where: { name: appName } });
  const deploy = await db.deploy.create({ data: { requestedSha: sha, requesterLabel: 'user matthew' } });
  await db.deployTarget.create({
    data: {
      deployId: deploy.id,
      appId: row.id,
      state: 'succeeded',
      endedAt: new Date(),
      images: { create: [{ service: 'web', repo: 'ghcr.io/matdemers1/web', sha, digest: `sha256:${'d'.repeat(64)}` }] },
    },
  });
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "drift_event", "target_image", "step", "deploy_target", "deploy", "audit_event", "agent_nonce", "api_token_app", "api_token", "session", "user", "app", "agent" cascade',
  );
  key = makeKey();
  await db.agent.create({ data: { publicKey: key.b64, fingerprint: key.fingerprint, confirmedAt: new Date() } });

  github = new FakeGitHub();
  const logger = pino({ enabled: false });
  const authDeps = { db, logger, config, oidc: null };
  const serviceDeps = { db, logger, config, bus: new Bus() };

  app = express();
  app.disable('x-powered-by');
  app.use(express.json({ verify: (req, _res, buf) => ((req as { rawBody?: Buffer }).rawBody = buf) }));
  app.use(auditContext(db, logger));
  app.use(authenticate(authDeps));
  app.use('/api/agent', agentRouter(serviceDeps));
  app.use('/api/apps', commitsRouter(serviceDeps, { github }));
  app.use('/api/apps', appsRouter(serviceDeps));
  app.use(errorHandler(logger));

  await reportApps([{ manifest: manifest('web'), manifestSha256: 'a'.repeat(64), running: { web: `sha256:${'d'.repeat(64)}` } }]);
});

afterAll(async () => {
  await db.$disconnect();
});

describe('GET /api/apps/:app/commits', () => {
  it('refuses an anonymous request', async () => {
    const res = await request(app).get('/api/apps/web/commits');
    expect(res.status).toBe(401);
  });

  it('404s an unknown app', async () => {
    const { cookie } = await signIn();
    const res = await request(app).get('/api/apps/nope/commits').set('Cookie', cookie);
    expect(res.status).toBe(404);
  });

  it('reports commits waiting with CI state, task IDs, and the newest green SHA', async () => {
    await recordRelease('web', SHA_LIVE);
    github.compareResult = {
      status: 'ahead',
      aheadBy: 2,
      behindBy: 0,
      commits: [
        { sha: SHA_MID, message: 'SHP-T-3.2: add commits endpoint\n\nbody text' },
        { sha: SHA_HEAD, message: 'fix typo (no task id)' },
      ],
    };
    github.runsByHeadSha.set(SHA_MID, [run(1, SHA_MID, 'success')]);
    github.runsByHeadSha.set(SHA_HEAD, [run(2, SHA_HEAD, null, 'in_progress')]);

    const { cookie } = await signIn();
    const res = await request(app).get('/api/apps/web/commits').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      live: SHA_LIVE,
      head: SHA_HEAD,
      newestGreen: SHA_MID,
      source: 'github',
      commits: [
        { sha: SHA_MID, ci: 'success', taskIds: ['SHP-T-3.2'] },
        { sha: SHA_HEAD, ci: 'pending', taskIds: [] },
      ],
    });
  });

  it('reports failure CI state', async () => {
    await recordRelease('web', SHA_LIVE);
    github.compareResult = {
      status: 'ahead',
      aheadBy: 1,
      behindBy: 0,
      commits: [{ sha: SHA_HEAD, message: 'break the build' }],
    };
    github.runsByHeadSha.set(SHA_HEAD, [run(1, SHA_HEAD, 'failure')]);

    const { cookie } = await signIn();
    const res = await request(app).get('/api/apps/web/commits').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ newestGreen: null, commits: [{ sha: SHA_HEAD, ci: 'failure' }] });
  });

  it('answers unavailable, never a 500, when GitHub is unreachable', async () => {
    await recordRelease('web', SHA_LIVE);
    const { RefusalError } = await import('@shipyard/sequence');
    github.compareError = new RefusalError({ code: 'github_unreachable', gate: 'none', message: 'GitHub is unreachable', fix: 'Retry.' });

    const { cookie } = await signIn();
    const res = await request(app).get('/api/apps/web/commits').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'unavailable', commits: [] });
  });

  it('refuses a token outside its scope', async () => {
    const { userId } = await signIn();
    await db.app.create({
      data: {
        name: 'other',
        agentId: (await db.agent.findFirstOrThrow()).id,
        manifestYaml: JSON.stringify(manifest('other')),
        manifestSha256: 'z'.repeat(64),
        repo: 'matdemers1/other',
        defaultBranch: 'main',
      },
    });
    const token = await tokenFor(userId, ['web']);
    const res = await request(app).get('/api/apps/other/commits').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);

    const inScope = await request(app).get('/api/apps/web/commits').set('Authorization', `Bearer ${token}`);
    expect(inScope.status).toBe(200);
  });
});
