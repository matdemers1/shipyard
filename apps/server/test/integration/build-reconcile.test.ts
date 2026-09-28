import { randomUUID } from 'node:crypto';
import pino from 'pino';
import type { BuildState } from '@shipyard/schema';
import type { GitHubPort } from '@shipyard/sequence/github';
import { RefusalError } from '@shipyard/sequence/github';
import { refusal } from '@shipyard/schema';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { ServiceDeps } from '../../src/deps.js';
import { Bus } from '../../src/events.js';
import { reconcileBuilds, startBuildReconcile } from '../../src/jobs/build-reconcile.js';

/**
 * SHP-T-7.5, SHP-REQ-114: the reconcile loop queues a default-branch head of a `build: shipyard`
 * app that has no build at all, and leaves alone a head that has one in any state.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });
const sha = (c: string): string => c.repeat(40);

let deps: ServiceDeps;

function manifest(name: string, source: 'shipyard' | 'github'): string {
  return JSON.stringify({
    name,
    repo: `matdemers1/${name}`,
    workflow: 'ci.yml',
    compose: { files: [`/data/${name}/compose.yml`], project: name },
    services: { web: { image: `ghcr.io/matdemers1/${name}` } },
    health: { service: 'web', port: 8080, path: '/health' },
    build: source === 'shipyard' ? { source: 'shipyard', releaseTargets: { web: 'release' } } : { source: 'github' },
  });
}

async function seedApp(name: string, source: 'shipyard' | 'github' = 'shipyard'): Promise<string> {
  const agent = await db.agent.create({ data: { publicKey: 'k', fingerprint: `fp-${randomUUID()}` } });
  const row = await db.app.create({
    data: {
      name,
      agentId: agent.id,
      repo: `matdemers1/${name}`,
      defaultBranch: 'main',
      manifestYaml: manifest(name, source),
      manifestSha256: '0'.repeat(64),
      reportedAt: new Date(),
    },
  });
  return row.id;
}

/** A fake GitHub: `heads` maps repo → branch tip; a repo in `failing` throws github_unreachable. */
function fakeGitHub(heads: Record<string, string>, failing: string[] = []): Pick<GitHubPort, 'compare'> & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    compare(repo, base, head) {
      calls.push(`${repo} ${base}...${head}`);
      if (failing.includes(repo)) return Promise.reject(new RefusalError(refusal('github_unreachable', 'down')));
      const tip = heads[repo];
      if (tip === undefined) return Promise.resolve(null);
      return Promise.resolve({ status: 'identical', aheadBy: 0, behindBy: 0, commits: [{ sha: tip, message: 'tip' }] });
    },
  };
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "build_log", "build_stage", "build", "audit_event", "app", "agent" cascade',
  );
  deps = { db, logger, config, bus: new Bus() };
});

afterAll(async () => {
  await db.$disconnect();
});

describe('reconcileBuilds', () => {
  it('queues a default-branch head that has no build, as trigger reconcile', async () => {
    await seedApp('toy');
    const github = fakeGitHub({ 'matdemers1/toy': sha('a') });
    const results = await reconcileBuilds(deps, { github });
    expect(github.calls).toEqual(['matdemers1/toy main...main']);
    expect(results).toMatchObject([{ app: 'toy', head: sha('a'), outcome: 'queued' }]);
    const rows = await db.build.findMany({ select: { sha: true, state: true, trigger: true, requesterLabel: true } });
    expect(rows).toEqual([{ sha: sha('a'), state: 'queued', trigger: 'reconcile', requesterLabel: 'shipyard: reconcile' }]);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'build.request' } });
    expect(audit).toMatchObject({ actorType: 'system', actorLabel: 'shipyard: reconcile' });

    // A second pass finds the build it just queued and does nothing.
    const again = await reconcileBuilds(deps, { github });
    expect(again).toMatchObject([{ app: 'toy', outcome: 'already_built' }]);
    expect(await db.build.count()).toBe(1);
  });

  it.each<BuildState>(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'refused'])(
    'does not queue a head that already has a %s build',
    async (state) => {
      const appId = await seedApp('toy');
      await db.build.create({
        data: { appId, sha: sha('b'), state, trigger: 'webhook', requesterLabel: 'github: push', ...(state === 'queued' || state === 'running' ? {} : { endedAt: new Date() }) },
      });
      const results = await reconcileBuilds(deps, { github: fakeGitHub({ 'matdemers1/toy': sha('b') }) });
      expect(results).toMatchObject([{ app: 'toy', outcome: 'already_built' }]);
      expect(await db.build.count()).toBe(1);
    },
  );

  it('queues a newer head even when an older one was built', async () => {
    const appId = await seedApp('toy');
    await db.build.create({ data: { appId, sha: sha('b'), state: 'succeeded', trigger: 'webhook', requesterLabel: 'x', endedAt: new Date() } });
    const results = await reconcileBuilds(deps, { github: fakeGitHub({ 'matdemers1/toy': sha('c') }) });
    expect(results).toMatchObject([{ app: 'toy', head: sha('c'), outcome: 'queued' }]);
    expect(await db.build.count()).toBe(2);
  });

  it('skips a build: github app without asking GitHub', async () => {
    await seedApp('ci', 'github');
    const github = fakeGitHub({ 'matdemers1/ci': sha('a') });
    expect(await reconcileBuilds(deps, { github })).toEqual([]);
    expect(github.calls).toEqual([]);
    expect(await db.build.count()).toBe(0);
  });

  it("one app's GitHub failure does not stop the others", async () => {
    await seedApp('alpha');
    await seedApp('beta');
    await seedApp('gamma');
    const github = fakeGitHub({ 'matdemers1/alpha': sha('a'), 'matdemers1/gamma': sha('c') }, ['matdemers1/beta']);
    const results = await reconcileBuilds(deps, { github });
    expect(results.map((r) => [r.app, r.outcome])).toEqual([
      ['alpha', 'queued'],
      ['beta', 'github_unreachable'],
      ['gamma', 'queued'],
    ]);
    const shas = (await db.build.findMany({ select: { sha: true }, orderBy: { sha: 'asc' } })).map((r) => r.sha);
    expect(shas).toEqual([sha('a'), sha('c')]);
  });

  it('an unknown branch (no head) queues nothing', async () => {
    await seedApp('toy');
    expect(await reconcileBuilds(deps, { github: fakeGitHub({}) })).toMatchObject([{ app: 'toy', outcome: 'no_head' }]);
    expect(await db.build.count()).toBe(0);
  });
});

describe('startBuildReconcile', () => {
  it('runs a pass at start and stops cleanly', async () => {
    await seedApp('toy');
    const loop = startBuildReconcile(deps, { github: fakeGitHub({ 'matdemers1/toy': sha('d') }), intervalMs: 60_000 });
    await loop.stop();
    expect(await db.build.count()).toBe(1);
  });
});
