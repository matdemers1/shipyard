import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db.js';

/**
 * SHP-T-7.3: the build tables. The point is `build_one_open_per_app_sha` — a webhook delivery and the
 * reconcile loop racing on one push must enqueue it once (SHP-REQ-112, SHP-REQ-114) — and arrival
 * order through `queue_seq` (SHP-REQ-137).
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const sha = (c: string): string => c.repeat(40);

async function makeApp(name: string): Promise<string> {
  const agent = await db.agent.create({ data: { publicKey: 'base64-key', fingerprint: `fp-${randomUUID()}` } });
  const app = await db.app.create({
    data: { name, agentId: agent.id, manifestYaml: 'services: {}', manifestSha256: 'a'.repeat(64) },
  });
  return app.id;
}

function enqueue(appId: string, commit: string, trigger: 'webhook' | 'reconcile') {
  return db.build.create({ data: { appId, sha: commit, trigger, requesterLabel: `shipyard: ${trigger}` } });
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "build_log", "build_stage", "build", "deploy_target", "deploy", "app", "agent" cascade',
  );
});

afterAll(async () => {
  await db.$disconnect();
});

describe('build (SHP-T-7.3)', () => {
  it('two concurrent enqueues of one (app, sha) produce one queued build', async () => {
    const appId = await makeApp('toy');
    const results = await Promise.allSettled([enqueue(appId, sha('a'), 'webhook'), enqueue(appId, sha('a'), 'reconcile')]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && (rejected.reason as { code?: string }).code).toBe('P2002');
    expect(await db.build.count({ where: { appId, sha: sha('a'), state: 'queued' } })).toBe(1);
  });

  it('a running build still blocks a second open build of the same SHA', async () => {
    const appId = await makeApp('toy');
    const first = await enqueue(appId, sha('a'), 'webhook');
    await db.build.update({ where: { id: first.id }, data: { state: 'running', startedAt: new Date() } });
    await expect(enqueue(appId, sha('a'), 'reconcile')).rejects.toMatchObject({ code: 'P2002' });
  });

  it('a terminal build frees the SHA for a rebuild, and other SHAs and apps are independent', async () => {
    const appId = await makeApp('toy');
    const otherApp = await makeApp('other');
    const first = await enqueue(appId, sha('a'), 'webhook');
    await db.build.update({ where: { id: first.id }, data: { state: 'failed', endedAt: new Date() } });

    const rebuild = await db.build.create({
      data: { appId, sha: sha('a'), trigger: 'rebuild', requesterLabel: 'console', rebuildOfId: first.id },
    });
    await enqueue(appId, sha('b'), 'webhook');
    await enqueue(otherApp, sha('a'), 'webhook');

    expect(rebuild.rebuildOfId).toBe(first.id);
    expect(await db.build.count({ where: { state: 'queued' } })).toBe(3);
  });

  it('queue_seq follows arrival order', async () => {
    const appId = await makeApp('toy');
    const a = await enqueue(appId, sha('a'), 'webhook');
    const b = await enqueue(appId, sha('b'), 'webhook');
    const c = await enqueue(appId, sha('c'), 'webhook');

    const oldest = await db.build.findMany({ where: { state: 'queued' }, orderBy: { queueSeq: 'asc' }, select: { id: true } });
    expect(oldest.map((row) => row.id)).toEqual([a.id, b.id, c.id]);
  });

  it('stages are one row per (build, stage), and stages and logs go with their build', async () => {
    const appId = await makeApp('toy');
    const build = await enqueue(appId, sha('a'), 'webhook');
    await db.buildStageRun.create({ data: { buildId: build.id, stage: 'fetch', state: 'succeeded' } });
    await expect(db.buildStageRun.create({ data: { buildId: build.id, stage: 'fetch', state: 'running' } })).rejects.toMatchObject({
      code: 'P2002',
    });
    await db.buildLog.create({ data: { buildId: build.id, stage: 'fetch', chunk: 'fetched 12 files' } });

    await db.build.delete({ where: { id: build.id } });
    expect(await db.buildStageRun.count()).toBe(0);
    expect(await db.buildLog.count()).toBe(0);
  });
});
