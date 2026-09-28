import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { handleBuildResult, registerAutoDeploy } from '../../src/builds/autodeploy.js';
import { claimNextBuild, enqueueBuild, getBuild, isRefusal, recordBuildResult, type BuildDetail } from '../../src/builds/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { ServiceDeps } from '../../src/deps.js';
import { setFreeze } from '../../src/freeze/service.js';
import { Bus } from '../../src/events.js';

/**
 * SHP-T-7.14: opt-in auto-deploy on a green build. `autoDeploy: true` (SHP-REQ-138) requests one
 * deploy through the normal sequence, labelled "shipyard: auto-deploy"; a lock, a freeze, a
 * pending approval or any other refusal is recorded on the build, never retried (SHP-REQ-139); at
 * most one auto-deploy is ever requested per build, even under a replayed result or a genuine race
 * (SHP-REQ-150).
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });
const sha = (c: string): string => c.repeat(40);
const DIGEST = `sha256:${'d'.repeat(64)}`;
const LABEL = 'shipyard: auto-deploy';

let bus: Bus;
let deps: ServiceDeps;

function manifest(name: string, opts: { autoDeploy?: boolean; approval?: 'none' | 'required'; source?: 'shipyard' | 'github' } = {}): string {
  const source = opts.source ?? 'shipyard';
  return JSON.stringify({
    name,
    repo: `matdemers1/${name}`,
    workflow: 'ci.yml',
    compose: { files: [`/data/${name}/compose.yml`], project: name },
    services: { web: { image: `ghcr.io/matdemers1/${name}` } },
    health: { service: 'web', port: 8080, path: '/health' },
    approval: opts.approval ?? 'none',
    ...(source === 'shipyard' ? { build: { source: 'shipyard', releaseTargets: { web: 'release' } } } : {}),
    ...(opts.autoDeploy !== undefined ? { autoDeploy: opts.autoDeploy } : {}),
  });
}

async function seedApp(
  name: string,
  opts: { autoDeploy?: boolean; approval?: 'none' | 'required'; source?: 'shipyard' | 'github' } = {},
): Promise<void> {
  const agent = await db.agent.create({ data: { publicKey: 'k', fingerprint: `fp-${randomUUID()}` } });
  await db.app.create({
    data: {
      name,
      agentId: agent.id,
      manifestYaml: manifest(name, opts),
      manifestSha256: '0'.repeat(64),
      reportedAt: new Date(),
      approvalPolicy: opts.approval ?? 'none',
    },
  });
}

const SYSTEM = { label: 'shipyard: webhook' };

/** Enqueues, claims and succeeds a build in one go; returns its ID. */
async function greenBuild(appName: string, commit: string): Promise<string> {
  const q = await enqueueBuild(deps, { app: appName, sha: commit, trigger: 'webhook', requester: SYSTEM });
  if (isRefusal(q)) throw new Error(`enqueue refused: ${q.message}`);
  await claimNextBuild(deps);
  const r = await recordBuildResult(deps, { buildId: q.buildId, state: 'succeeded', digests: { web: DIGEST } });
  expect(r.accepted).toBe(true);
  return q.buildId;
}

async function detail(buildId: string): Promise<BuildDetail> {
  const d = await getBuild(db, buildId);
  if (d === null) throw new Error('build vanished');
  return d;
}

async function fakeUser(role: 'admin' | 'deployer'): Promise<{ userId: string }> {
  const user = await db.user.create({ data: { email: `${role}-${randomUUID()}@example.com`, displayName: role, role } });
  return { userId: user.id };
}

const noopAudit = (): Promise<void> => Promise.resolve();

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "build_log", "build_stage", "build", "approval", "freeze", "target_image", "step", "outbox", "drift_event", "deploy_target", "deploy", "audit_event", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  bus = new Bus();
  deps = { db, logger, config, bus };
});

afterAll(async () => {
  await db.$disconnect();
});

describe('autoDeploy false', () => {
  it('requests nothing', async () => {
    await seedApp('toy', { autoDeploy: false });
    const unregister = registerAutoDeploy(deps);
    const buildId = await greenBuild('toy', sha('a'));
    unregister();
    expect(await db.deploy.count()).toBe(0);
    const d = await detail(buildId);
    expect(d.autoDeployId).toBeNull();
    expect(d.autoDeployRefusal).toBeNull();
  });
});

describe('autoDeploy true', () => {
  it('requests exactly one deploy labelled "shipyard: auto-deploy" and links it on the build', async () => {
    await seedApp('toy', { autoDeploy: true });
    const unregister = registerAutoDeploy(deps);
    const buildId = await greenBuild('toy', sha('a'));
    unregister();

    expect(await db.deploy.count()).toBe(1);
    const deploy = await db.deploy.findFirstOrThrow();
    expect(deploy.requesterLabel).toBe(LABEL);
    expect(deploy.requestedSha).toBe(sha('a'));

    const d = await detail(buildId);
    expect(d.autoDeployId).toBe(deploy.id);
    expect(d.autoDeployRefusal).toBeNull();

    const target = await db.deployTarget.findFirstOrThrow({ where: { deployId: deploy.id } });
    expect(target.state).toBe('locked');

    const auditRow = await db.auditEvent.findFirstOrThrow({ where: { entityId: deploy.id, action: 'deploy.requested' } });
    expect(auditRow.actorLabel).toBe(LABEL);
  });

  it('requests nothing for a failed build', async () => {
    await seedApp('toy', { autoDeploy: true });
    const unregister = registerAutoDeploy(deps);
    const q = await enqueueBuild(deps, { app: 'toy', sha: sha('a'), trigger: 'webhook', requester: SYSTEM });
    if (isRefusal(q)) throw new Error('unexpected refusal');
    await claimNextBuild(deps);
    await recordBuildResult(deps, { buildId: q.buildId, state: 'failed', digests: {}, failedStage: 'test' });
    unregister();

    expect(await db.deploy.count()).toBe(0);
    const d = await detail(q.buildId);
    expect(d.autoDeployId).toBeNull();
    expect(d.autoDeployRefusal).toBeNull();
  });

  it('a frozen app records the refusal and requests no deploy', async () => {
    await seedApp('toy', { autoDeploy: true });
    const { userId } = await fakeUser('admin');
    const frozen = await setFreeze(db, { actor: { type: 'user', id: userId, label: 'admin' }, role: 'admin', audit: noopAudit }, 'toy', {
      reason: 'maintenance',
    });
    expect(isRefusal(frozen)).toBe(false);

    const unregister = registerAutoDeploy(deps);
    const buildId = await greenBuild('toy', sha('a'));
    unregister();

    expect(await db.deploy.count()).toBe(0);
    const d = await detail(buildId);
    expect(d.autoDeployId).toBeNull();
    expect(d.autoDeployRefusal).toMatchObject({ code: 'app_frozen' });
  });

  it('a locked app records the refusal, and never requests again once the lock clears', async () => {
    await seedApp('toy', { autoDeploy: true });
    const app = await db.app.findUniqueOrThrow({ where: { name: 'toy' } });
    const holdingDeploy = await db.deploy.create({
      data: {
        kind: 'deploy',
        requestedSha: sha('z'),
        dryRun: false,
        requesterLabel: 'someone else',
        targets: { create: { appId: app.id, state: 'locked' } },
      },
      select: { id: true },
    });

    const unregister = registerAutoDeploy(deps);
    const buildId = await greenBuild('toy', sha('a'));

    expect(await db.deploy.count()).toBe(1);
    const d1 = await detail(buildId);
    expect(d1.autoDeployId).toBeNull();
    expect(d1.autoDeployRefusal).toMatchObject({ code: 'locked' });

    // The lock clears — a plain state change, no new build result, so nothing re-triggers the
    // hook; auto-deploy must not retry on a timer either.
    await db.deployTarget.updateMany({ where: { deployId: holdingDeploy.id }, data: { state: 'succeeded', endedAt: new Date() } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    unregister();

    expect(await db.deploy.count()).toBe(1);
    const d2 = await detail(buildId);
    expect(d2.autoDeployId).toBeNull();
    expect(d2.autoDeployRefusal).toMatchObject({ code: 'locked' });
  });

  it('an approval-required app gets a linked awaiting_approval deploy', async () => {
    await seedApp('toy', { autoDeploy: true, approval: 'required' });
    const unregister = registerAutoDeploy(deps);
    const buildId = await greenBuild('toy', sha('a'));
    unregister();

    // createDeploy holds an approval-required, token-requested deploy rather than refusing it
    // (SHP-D-015): the deploy exists, awaiting a human, and the build links to it.
    const deploy = await db.deploy.findFirstOrThrow();
    const target = await db.deployTarget.findFirstOrThrow({ where: { deployId: deploy.id } });
    expect(target.state).toBe('awaiting_approval');
    expect(deploy.requesterLabel).toBe(LABEL);

    const d = await detail(buildId);
    expect(d.autoDeployId).toBe(deploy.id);
    expect(d.autoDeployRefusal).toBeNull();
  });

  it('a pending approval already on the app is refused, not stacked, by the next auto-deploy', async () => {
    await seedApp('toy', { autoDeploy: true, approval: 'required' });
    const app = await db.app.findUniqueOrThrow({ where: { name: 'toy' } });
    await db.deploy.create({
      data: {
        kind: 'deploy',
        requestedSha: sha('z'),
        dryRun: false,
        requesterLabel: 'earlier auto-deploy',
        targets: { create: { appId: app.id, state: 'awaiting_approval' } },
      },
    });

    const unregister = registerAutoDeploy(deps);
    const buildId = await greenBuild('toy', sha('a'));
    unregister();

    // Only the pre-existing approval exists; auto-deploy did not create a second one.
    expect(await db.deploy.count()).toBe(1);
    const d = await detail(buildId);
    expect(d.autoDeployId).toBeNull();
    expect(d.autoDeployRefusal).toMatchObject({ code: 'approval_required' });
  });

  it('a replayed build result still requests exactly one deploy', async () => {
    await seedApp('toy', { autoDeploy: true });
    const unregister = registerAutoDeploy(deps);
    const q = await enqueueBuild(deps, { app: 'toy', sha: sha('a'), trigger: 'webhook', requester: SYSTEM });
    if (isRefusal(q)) throw new Error('unexpected refusal');
    await claimNextBuild(deps);
    const first = await recordBuildResult(deps, { buildId: q.buildId, state: 'succeeded', digests: { web: DIGEST } });
    expect(first.accepted).toBe(true);
    // A replay of the same terminal result: recordBuildResult itself never re-accepts it, so the
    // hook never even runs a second time.
    const second = await recordBuildResult(deps, { buildId: q.buildId, state: 'succeeded', digests: { web: DIGEST } });
    expect(second.accepted).toBe(false);
    unregister();

    expect(await db.deploy.count()).toBe(1);
    const d = await detail(q.buildId);
    expect(d.autoDeployId).not.toBeNull();
  });

  it('two concurrent hook invocations for the same build request exactly one deploy', async () => {
    await seedApp('toy', { autoDeploy: true });
    const q = await enqueueBuild(deps, { app: 'toy', sha: sha('a'), trigger: 'webhook', requester: SYSTEM });
    if (isRefusal(q)) throw new Error('unexpected refusal');
    await claimNextBuild(deps);
    await recordBuildResult(deps, { buildId: q.buildId, state: 'succeeded', digests: { web: DIGEST } });

    const event = { buildId: q.buildId, app: 'toy', sha: sha('a'), state: 'succeeded' as const, digests: { web: DIGEST } };
    await Promise.all([handleBuildResult(deps, event), handleBuildResult(deps, event)]);

    expect(await db.deploy.count()).toBe(1);
    const d = await detail(q.buildId);
    expect(d.autoDeployId).not.toBeNull();
  });
});
