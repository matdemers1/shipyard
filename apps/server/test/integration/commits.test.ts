import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import express, { type Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprintOf, signingString, type AgentReport } from '@shipyard/schema';
import type { GitHubPort, WorkflowJob } from '@shipyard/sequence/github';
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
  jobsByRunId = new Map<number, WorkflowJob[]>();
  jobsError: Error | null = null;
  calls = { compare: 0, workflowRuns: 0, runJobs: 0 };

  runJobs(_repo: string, runId: number): Promise<WorkflowJob[]> {
    this.calls.runJobs += 1;
    if (this.jobsError !== null) return Promise.reject(this.jobsError);
    return Promise.resolve(this.jobsByRunId.get(runId) ?? []);
  }

  compare(_repo: string, _base: string, _head: string): ReturnType<GitHubPort['compare']> {
    this.calls.compare += 1;
    if (this.compareError !== null) return Promise.reject(this.compareError);
    return Promise.resolve(this.compareResult);
  }

  workflowRuns(_repo: string, _workflow: string, headSha: string): ReturnType<GitHubPort['workflowRuns']> {
    this.calls.workflowRuns += 1;
    if (this.compareError !== null) return Promise.reject(this.compareError);
    return Promise.resolve(this.runsByHeadSha.get(headSha) ?? []);
  }
}

function run(id: number, headSha: string, conclusion: string | null, status = 'completed'): Awaited<ReturnType<GitHubPort['workflowRuns']>>[number] {
  return {
    id,
    headSha,
    path: '.github/workflows/ci.yml',
    status,
    conclusion,
    event: 'push',
    headBranch: 'main',
    url: `https://github.com/matdemers1/web/actions/runs/${String(id)}`,
    startedAt: '2026-10-05T10:00:00Z',
    completedAt: status === 'completed' ? '2026-10-05T10:04:30Z' : null,
  };
}

function job(id: number, name: string, status: string, conclusion: string | null, started: string | null, completed: string | null): WorkflowJob {
  return { id, name, status, conclusion, startedAt: started, completedAt: completed, url: `https://github.com/matdemers1/web/actions/runs/1/job/${String(id)}` };
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
      ahead: 2,
      newestGreen: SHA_MID,
      source: 'github',
      buildSource: 'github',
      commits: [
        { sha: SHA_MID, ci: 'success', taskIds: ['SHP-T-3.2'] },
        { sha: SHA_HEAD, ci: 'pending', taskIds: [] },
      ],
    });
  });

  it('a second request within the TTL is served whole from the cache: no GitHub call at all', async () => {
    await recordRelease('web', SHA_LIVE);
    github.compareResult = {
      status: 'ahead',
      aheadBy: 2,
      behindBy: 0,
      commits: [
        { sha: SHA_MID, message: 'one' },
        { sha: SHA_HEAD, message: 'two' },
      ],
    };
    const { cookie } = await signIn();
    const first = await request(app).get('/api/apps/web/commits').set('Cookie', cookie);
    expect(first.status).toBe(200);
    const afterFirst = { ...github.calls };
    expect(afterFirst.workflowRuns).toBeGreaterThan(0);
    const second = await request(app).get('/api/apps/web/commits').set('Cookie', cookie);
    expect(second.body).toEqual(first.body);
    expect(github.calls).toEqual(afterFirst);
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
    const { RefusalError } = await import('@shipyard/sequence/github');
    github.compareError = new RefusalError({ code: 'github_unreachable', gate: 'none', message: 'GitHub is unreachable', fix: 'Retry.' });

    const { cookie } = await signIn();
    const res = await request(app).get('/api/apps/web/commits').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'unavailable', commits: [] });
  });

  it('with ?to=, ranges live..to instead of live..HEAD (SHP-REQ-087)', async () => {
    await recordRelease('web', SHA_LIVE);
    github.compareResult = {
      status: 'ahead',
      aheadBy: 1,
      behindBy: 0,
      commits: [{ sha: SHA_MID, message: 'SHP-T-5.8: changelog helper' }],
    };
    github.runsByHeadSha.set(SHA_MID, [run(1, SHA_MID, 'success')]);

    const { cookie } = await signIn();
    const res = await request(app).get(`/api/apps/web/commits?to=${SHA_MID}`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      live: SHA_LIVE,
      head: SHA_MID,
      source: 'github',
      commits: [{ sha: SHA_MID, taskIds: ['SHP-T-5.8'] }],
    });
  });

  it('refuses a malformed ?to=', async () => {
    await recordRelease('web', SHA_LIVE);
    const { cookie } = await signIn();
    const res = await request(app).get('/api/apps/web/commits?to=not-a-sha').set('Cookie', cookie);
    expect(res.status).toBe(400);
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

describe('GET /api/apps/:app/commits for a build: shipyard app (SHP-T-3.11)', () => {
  beforeEach(async () => {
    await reportApps([
      { manifest: manifest('web'), manifestSha256: 'a'.repeat(64), running: { web: `sha256:${'d'.repeat(64)}` } },
      {
        manifest: { ...manifest('built'), build: { source: 'shipyard', releaseTargets: { web: 'release' } } },
        manifestSha256: 'b'.repeat(64),
        running: { web: `sha256:${'d'.repeat(64)}` },
      },
    ]);
    await recordRelease('built', SHA_LIVE);
    github.compareResult = {
      status: 'ahead',
      aheadBy: 2,
      behindBy: 0,
      commits: [
        { sha: SHA_MID, message: 'mid' },
        { sha: SHA_HEAD, message: 'head' },
      ],
    };
    // A green GitHub run must not make a Shipyard-built SHA deployable.
    github.runsByHeadSha.set(SHA_HEAD, [run(9, SHA_HEAD, 'success')]);
  });

  async function build(sha: string, state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'refused') {
    const row = await db.app.findUniqueOrThrow({ where: { name: 'built' } });
    return db.build.create({ data: { appId: row.id, sha, state, trigger: 'webhook', requesterLabel: 'shipyard: webhook' } });
  }

  it("takes each commit's state from its latest Shipyard build, never from GitHub runs", async () => {
    await build(SHA_MID, 'failed');
    const rebuilt = await build(SHA_MID, 'succeeded');
    const running = await build(SHA_HEAD, 'running');
    const { cookie } = await signIn();
    const res = await request(app).get('/api/apps/built/commits').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      buildSource: 'shipyard',
      newestGreen: SHA_MID,
      commits: [
        { sha: SHA_MID, ci: 'success', buildId: rebuilt.id },
        { sha: SHA_HEAD, ci: 'pending', buildId: running.id },
      ],
    });
    expect(github.calls.workflowRuns).toBe(0);
  });

  it('a commit with no build, or only a cancelled one, has nothing to deploy', async () => {
    await build(SHA_HEAD, 'cancelled');
    const { cookie } = await signIn();
    const res = await request(app).get('/api/apps/built/commits').set('Cookie', cookie);
    expect(res.body).toMatchObject({
      buildSource: 'shipyard',
      newestGreen: null,
      commits: [{ sha: SHA_MID, ci: 'none' }, { sha: SHA_HEAD, ci: 'none' }],
    });
    expect((res.body as { commits: Record<string, unknown>[] }).commits[0]).not.toHaveProperty('buildId');
  });
});

describe('commits response carries the run (SHP-T-13.4, SHP-ADR-007)', () => {
  it('has run {id,url,startedAt,completedAt,conclusion} per commit, null where no push run exists', async () => {
    await recordRelease('web', SHA_LIVE);
    github.compareResult = {
      status: 'ahead',
      aheadBy: 3,
      behindBy: 0,
      commits: [
        { sha: SHA_MID, message: 'mid' },
        { sha: SHA_HEAD, message: 'head' },
        { sha: 'd'.repeat(40), message: 'no run yet' },
      ],
    };
    github.runsByHeadSha.set(SHA_MID, [run(11, SHA_MID, 'success')]);
    github.runsByHeadSha.set(SHA_HEAD, [run(12, SHA_HEAD, null, 'in_progress')]);

    const { cookie } = await signIn();
    const res = await request(app).get('/api/apps/web/commits').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const commits = (res.body as { commits: Record<string, unknown>[] }).commits;
    expect(commits[0]).toMatchObject({
      sha: SHA_MID,
      ci: 'success',
      run: {
        id: 11,
        url: 'https://github.com/matdemers1/web/actions/runs/11',
        startedAt: '2026-10-05T10:00:00Z',
        completedAt: '2026-10-05T10:04:30Z',
        conclusion: 'success',
      },
    });
    // The key set is exactly the five the contract names, and the old fields are still there.
    expect(Object.keys(commits[0]?.['run'] as object).sort()).toEqual(['completedAt', 'conclusion', 'id', 'startedAt', 'url']);
    expect(Object.keys(commits[0] ?? {}).sort()).toEqual(['ci', 'message', 'run', 'sha', 'taskIds']);
    expect(commits[1]).toMatchObject({ ci: 'pending', run: { id: 12, completedAt: null, conclusion: null } });
    expect(commits[2]).toMatchObject({ ci: 'none', run: null });
  });

  it('a build: shipyard app has run null on every commit', async () => {
    await reportApps([
      {
        manifest: { ...manifest('built'), build: { source: 'shipyard', releaseTargets: { web: 'release' } } },
        manifestSha256: 'b'.repeat(64),
        running: { web: `sha256:${'d'.repeat(64)}` },
      },
    ]);
    await recordRelease('built', SHA_LIVE);
    github.compareResult = { status: 'ahead', aheadBy: 1, behindBy: 0, commits: [{ sha: SHA_MID, message: 'mid' }] };
    const { cookie } = await signIn();
    const res = await request(app).get('/api/apps/built/commits').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ buildSource: 'shipyard', commits: [{ sha: SHA_MID, run: null }] });
  });

  it('the poll never fetches jobs, and spends the same GitHub calls per refresh as before: one compare, one workflowRuns per commit', async () => {
    await recordRelease('web', SHA_LIVE);
    github.compareResult = {
      status: 'ahead',
      aheadBy: 2,
      behindBy: 0,
      commits: [
        { sha: SHA_MID, message: 'one' },
        { sha: SHA_HEAD, message: 'two' },
      ],
    };
    github.runsByHeadSha.set(SHA_MID, [run(11, SHA_MID, 'success')]);
    github.runsByHeadSha.set(SHA_HEAD, [run(12, SHA_HEAD, 'failure')]);
    const { cookie } = await signIn();
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/api/apps/web/commits').set('Cookie', cookie);
      expect(res.status).toBe(200);
    }
    // Three polls inside the 60 s cache: the first costs 1 compare + 2 runs lookups, the rest cost nothing.
    expect(github.calls).toEqual({ compare: 1, workflowRuns: 2, runJobs: 0 });
  });
});

describe('GET /api/apps/:app/commits/:sha/run (SHP-T-13.4, SHP-REQ-157, SHP-REQ-168)', () => {
  const jobs = [
    job(101, 'lint', 'completed', 'success', '2026-10-05T10:00:05Z', '2026-10-05T10:00:50Z'),
    job(102, 'test', 'completed', 'failure', '2026-10-05T10:00:05Z', '2026-10-05T10:03:05Z'),
    job(103, 'images', 'completed', 'skipped', null, null),
    job(104, 'e2e', 'completed', 'cancelled', '2026-10-05T10:00:06Z', '2026-10-05T10:00:09Z'),
    job(105, 'docs', 'in_progress', null, '2026-10-05T10:00:07Z', null),
    job(106, 'deploy', 'queued', null, null, null),
  ];

  it('returns the jobs from GitHub once, then from cache: runJobs is called exactly once for a completed run', async () => {
    github.runsByHeadSha.set(SHA_MID, [run(11, SHA_MID, 'failure')]);
    github.jobsByRunId.set(11, jobs);
    const { cookie } = await signIn();

    const first = await request(app).get(`/api/apps/web/commits/${SHA_MID}/run`).set('Cookie', cookie);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      run: {
        id: 11,
        url: 'https://github.com/matdemers1/web/actions/runs/11',
        status: 'completed',
        conclusion: 'failure',
        startedAt: '2026-10-05T10:00:00Z',
        completedAt: '2026-10-05T10:04:30Z',
      },
      jobs: [
        { id: 101, name: 'lint', state: 'success', startedAt: '2026-10-05T10:00:05Z', completedAt: '2026-10-05T10:00:50Z', durationMs: 45_000, url: jobs[0]?.url },
        { id: 102, name: 'test', state: 'failure', startedAt: '2026-10-05T10:00:05Z', completedAt: '2026-10-05T10:03:05Z', durationMs: 180_000, url: jobs[1]?.url },
        { id: 103, name: 'images', state: 'skipped', startedAt: null, completedAt: null, durationMs: null, url: jobs[2]?.url },
        { id: 104, name: 'e2e', state: 'cancelled', startedAt: '2026-10-05T10:00:06Z', completedAt: '2026-10-05T10:00:09Z', durationMs: 3000, url: jobs[3]?.url },
        { id: 105, name: 'docs', state: 'running', startedAt: '2026-10-05T10:00:07Z', completedAt: null, durationMs: null, url: jobs[4]?.url },
        { id: 106, name: 'deploy', state: 'queued', startedAt: null, completedAt: null, durationMs: null, url: jobs[5]?.url },
      ],
    });
    expect(github.calls.runJobs).toBe(1);

    const second = await request(app).get(`/api/apps/web/commits/${SHA_MID}/run`).set('Cookie', cookie);
    expect(second.body).toEqual(first.body);
    expect(github.calls.runJobs).toBe(1);
  });

  it('an in-progress run is cached only briefly: the jobs are asked for again once the short TTL passes', async () => {
    github.runsByHeadSha.set(SHA_HEAD, [run(12, SHA_HEAD, null, 'in_progress')]);
    github.jobsByRunId.set(12, [job(201, 'test', 'in_progress', null, '2026-10-05T10:00:05Z', null)]);
    const { cookie } = await signIn();
    const spy = vi.spyOn(Date, 'now');
    try {
      const t0 = 1_800_000_000_000;
      spy.mockReturnValue(t0);
      await request(app).get(`/api/apps/web/commits/${SHA_HEAD}/run`).set('Cookie', cookie);
      spy.mockReturnValue(t0 + 5_000);
      await request(app).get(`/api/apps/web/commits/${SHA_HEAD}/run`).set('Cookie', cookie);
      expect(github.calls.runJobs).toBe(1);
      spy.mockReturnValue(t0 + 20_000);
      await request(app).get(`/api/apps/web/commits/${SHA_HEAD}/run`).set('Cookie', cookie);
      expect(github.calls.runJobs).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('opening the run page never disturbs the commits poll, and the poll never calls runJobs', async () => {
    await recordRelease('web', SHA_LIVE);
    github.compareResult = { status: 'ahead', aheadBy: 1, behindBy: 0, commits: [{ sha: SHA_MID, message: 'one' }] };
    github.runsByHeadSha.set(SHA_MID, [run(11, SHA_MID, 'success')]);
    const { cookie } = await signIn();
    await request(app).get('/api/apps/web/commits').set('Cookie', cookie);
    expect(github.calls.runJobs).toBe(0);
    await request(app).get(`/api/apps/web/commits/${SHA_MID}/run`).set('Cookie', cookie);
    expect(github.calls.runJobs).toBe(1);
  });

  it('answers run null and no jobs for a commit with no push run, without asking for jobs', async () => {
    const { cookie } = await signIn();
    const res = await request(app).get(`/api/apps/web/commits/${SHA_MID}/run`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ run: null, jobs: [] });
    expect(github.calls.runJobs).toBe(0);
  });

  it('refuses a malformed sha (not 40 lowercase hex) without calling GitHub', async () => {
    const { cookie } = await signIn();
    for (const bad of ['not-a-sha', 'abc123', SHA_MID.toUpperCase(), `${SHA_MID}0`]) {
      const res = await request(app).get(`/api/apps/web/commits/${bad}/run`).set('Cookie', cookie);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: { code: 'invalid_request', gate: 'none' } });
    }
    expect(github.calls).toEqual({ compare: 0, workflowRuns: 0, runJobs: 0 });
  });

  it('404s an unknown app, and an app outside the token scope', async () => {
    const { userId, cookie } = await signIn();
    const res = await request(app).get(`/api/apps/nope/commits/${SHA_MID}/run`).set('Cookie', cookie);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: 'not_found' } });

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
    const scoped = await request(app).get(`/api/apps/other/commits/${SHA_MID}/run`).set('Authorization', `Bearer ${token}`);
    expect(scoped.status).toBe(404);
  });

  it('refuses an anonymous request', async () => {
    const res = await request(app).get(`/api/apps/web/commits/${SHA_MID}/run`);
    expect(res.status).toBe(401);
  });

  it('refuses invalid_request for a build: shipyard app, which has no workflow run', async () => {
    await reportApps([
      {
        manifest: { ...manifest('built'), build: { source: 'shipyard', releaseTargets: { web: 'release' } } },
        manifestSha256: 'b'.repeat(64),
        running: { web: `sha256:${'d'.repeat(64)}` },
      },
    ]);
    const { cookie } = await signIn();
    const res = await request(app).get(`/api/apps/built/commits/${SHA_MID}/run`).set('Cookie', cookie);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'invalid_request', gate: 'none' } });
    expect(github.calls).toEqual({ compare: 0, workflowRuns: 0, runJobs: 0 });
  });

  it('fails closed with github_unreachable (503) when GitHub cannot be reached, and caches nothing from the failure', async () => {
    const { RefusalError } = await import('@shipyard/sequence/github');
    github.runsByHeadSha.set(SHA_MID, [run(11, SHA_MID, 'success')]);
    github.jobsByRunId.set(11, [job(101, 'lint', 'completed', 'success', '2026-10-05T10:00:05Z', '2026-10-05T10:00:50Z')]);
    github.jobsError = new RefusalError({ code: 'github_unreachable', gate: 'none', message: 'GitHub is unreachable', fix: 'Retry.' });
    const { cookie } = await signIn();
    const down = await request(app).get(`/api/apps/web/commits/${SHA_MID}/run`).set('Cookie', cookie);
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ error: { code: 'github_unreachable', gate: 'none' } });

    github.jobsError = null;
    const up = await request(app).get(`/api/apps/web/commits/${SHA_MID}/run`).set('Cookie', cookie);
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ jobs: [{ id: 101, state: 'success' }] });
  });
});
