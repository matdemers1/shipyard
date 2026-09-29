import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db.js';
import { pruneBuildLogs, startBuildLogPrune } from '../../src/jobs/build-log-prune.js';

/** SHP-REQ-141: build logs go 30 days after their build ends, and not a day before. */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const logger = pino({ enabled: false });
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-28T12:00:00Z');

let appId: string;
let n = 0;

async function buildWithLog(state: 'running' | 'succeeded' | 'failed', endedDaysAgo: number | null): Promise<string> {
  n += 1;
  const build = await db.build.create({
    data: {
      appId,
      sha: String(n % 10).repeat(40),
      trigger: 'webhook',
      requesterLabel: 'shipyard: webhook',
      state,
      startedAt: new Date(NOW.getTime() - 40 * DAY),
      ...(endedDaysAgo !== null ? { endedAt: new Date(NOW.getTime() - endedDaysAgo * DAY) } : {}),
      logs: { create: [{ stage: 'fetch', chunk: 'a' }, { stage: 'test', chunk: 'b' }] },
      stages: { create: [{ stage: 'fetch', state: 'succeeded' }] },
    },
  });
  return build.id;
}

beforeEach(async () => {
  await db.$executeRawUnsafe('truncate table "build_log", "build_stage", "build", "deploy_target", "deploy", "app", "agent" cascade');
  const agent = await db.agent.create({ data: { publicKey: 'k', fingerprint: `fp-${randomUUID()}` } });
  const app = await db.app.create({ data: { name: 'toy', agentId: agent.id, manifestYaml: 'name: toy\n', manifestSha256: '0'.repeat(64) } });
  appId = app.id;
});

afterAll(async () => {
  await db.$disconnect();
});

describe('pruneBuildLogs (SHP-REQ-141)', () => {
  it('prunes a build that ended 31 days ago and keeps one that ended 29 days ago', async () => {
    const old = await buildWithLog('succeeded', 31);
    const recent = await buildWithLog('failed', 29);

    expect(await pruneBuildLogs({ db, logger }, NOW)).toBe(2);
    expect(await db.buildLog.count({ where: { buildId: old } })).toBe(0);
    expect(await db.buildLog.count({ where: { buildId: recent } })).toBe(2);
    // Only the log text goes: the build and its stages stay.
    expect(await db.build.count({ where: { id: old } })).toBe(1);
    expect(await db.buildStageRun.count({ where: { buildId: old } })).toBe(1);
  });

  it('never prunes a build that has not ended, however old', async () => {
    const running = await buildWithLog('running', null);
    expect(await pruneBuildLogs({ db, logger }, NOW)).toBe(0);
    expect(await db.buildLog.count({ where: { buildId: running } })).toBe(2);
  });

  it('keeps a build ended exactly 30 days ago (strictly older only)', async () => {
    const edge = await buildWithLog('succeeded', 30);
    expect(await pruneBuildLogs({ db, logger }, NOW)).toBe(0);
    expect(await db.buildLog.count({ where: { buildId: edge } })).toBe(2);
  });

  it('startBuildLogPrune runs at once and stops cleanly', async () => {
    const ancient = await buildWithLog('succeeded', 400);
    const job = startBuildLogPrune({ db, logger }, 60_000);
    await job.stop();
    expect(await db.buildLog.count({ where: { buildId: ancient } })).toBe(0);
  });
});
