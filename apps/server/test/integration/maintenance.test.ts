import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentReport,
  HostContainer,
  HostInventory,
  HostVolume,
  MaintenanceJob,
  MaintenancePage,
  MaintenanceStatus,
  Manifest,
  PollResponse,
  Refusal,
  StackManifest,
  VolumeArchive,
} from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { issueNativeSession } from '../../src/auth/native-sessions.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db, type Prisma } from '../../src/db.js';
import type { ServiceDeps } from '../../src/deps.js';
import { lockRefusal } from '../../src/deploys/service.js';
import { Bus } from '../../src/events.js';
import {
  MAINTENANCE_STALE_MS,
  NIGHTLY_REQUESTER_LABEL,
  mirrorVolumeArchives,
  nightlyBackups,
  sweepStaleMaintenance,
  waitForMaintenance,
  type MaintenanceNeedsYou,
} from '../../src/maintenance/service.js';
import { agentPost, container, enrol, hex64, issueToken, makeKey, poll, signIn, type Key } from './agent-work-fixtures.js';

/**
 * SHP-T-17.3: volume backups, restores and deletes, and prune (SHP-ADR-012; SHP-REQ-201,
 * SHP-REQ-202, SHP-REQ-203, SHP-REQ-204, SHP-REQ-205). A backup by a deployer or a scoped token is
 * queued, handed only to a poll advertising `maintenance`, one job at a time, and its result
 * mirrors the archive; a restore or delete is an admin's, in the console, with a fresh step-up and
 * the name typed back — never a token — and a restore locks its owner both ways; a real prune
 * follows a succeeded dry run of the same agent from the last hour; a silent job fails after
 * fifteen minutes; nightly backups are queued once a day per the manifests; the report mirrors and
 * retires archives; Needs you shows failed backups and low disk; everything is audited.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });

let bus: Bus;
let app: Express;
let deps: ServiceDeps;
let key: Key;
let agentId: string;
let webId: string;

function appManifest(name: string, volumeBackups?: Manifest['volumeBackups']): Manifest {
  return {
    name,
    repo: `matdemers1/${name}`,
    defaultBranch: 'main',
    workflow: 'ci.yml',
    compose: { files: [`/DATA/apps/${name}/docker-compose.yml`], project: name },
    services: { server: { image: `ghcr.io/matdemers1/${name}/server` } },
    health: { service: 'server', path: '/health', port: 3000 },
    soakSeconds: 60,
    approval: 'none',
    diskFloorGb: 5,
    retainImages: 3,
    ...(volumeBackups === undefined ? {} : { volumeBackups }),
  };
}

function stackManifest(name: string, volumeBackups?: StackManifest['volumeBackups']): StackManifest {
  return {
    kind: 'stack',
    name,
    compose: { files: [`/DATA/AppData/${name}/docker-compose.yml`], project: name },
    updates: 'none',
    ...(volumeBackups === undefined ? {} : { volumeBackups }),
  };
}

async function seedOwners(webBackups?: Manifest['volumeBackups'], forgejoBackups?: StackManifest['volumeBackups']): Promise<void> {
  const web = await db.app.create({
    data: { name: 'web', agentId, manifestYaml: JSON.stringify(appManifest('web', webBackups)), manifestSha256: '0'.repeat(64), reportedAt: new Date() },
  });
  webId = web.id;
  await db.stack.create({
    data: {
      name: 'forgejo',
      agentId,
      manifestJson: JSON.stringify(stackManifest('forgejo', forgejoBackups)),
      manifestSha256: '0'.repeat(64),
      composeProject: 'forgejo',
      reportedAt: new Date(),
    },
  });
}

function volume(name: string, mountedBy: string[]): HostVolume {
  return { name, driver: 'local', sizeBytes: 1000, mountedBy, composeProject: null, orphan: mountedBy.length === 0, createdAt: null };
}

const CONTAINERS: HostContainer[] = [
  container('web-server-1', { compose: { project: 'web', service: 'server' }, tier: 'shipped', app: 'web' }),
  container('forgejo-server-1', { compose: { project: 'forgejo', service: 'server' }, tier: 'operated', app: 'forgejo' }),
  container('plex-1', { compose: { project: 'plex', service: 'plex' } }),
];

const VOLUMES: HostVolume[] = [
  volume('web_data', ['web-server-1']),
  volume('web_cache', ['web-server-1']),
  volume('forgejo_data', ['forgejo-server-1']),
  volume('plex_config', ['plex-1']),
  volume('old_stuff', []),
];

async function seedSnapshot(forAgent: string, disk: HostInventory['disk'] = { dataRoot: { path: '/DATA', freeBytes: 50, totalBytes: 100 }, dockerRoot: null }): Promise<void> {
  const inventory: HostInventory = {
    sampledAt: '2026-10-22T12:00:00.000Z',
    containers: CONTAINERS,
    volumes: VOLUMES,
    images: [],
    networks: [],
    builderCache: { bytes: 0, reclaimableBytes: 0 },
    disk,
  };
  const now = new Date();
  await db.hostSnapshot.upsert({
    where: { agentId: forAgent },
    create: { agentId: forAgent, inventory: JSON.parse(JSON.stringify(inventory)) as Prisma.InputJsonValue, sampledAt: now, reportedAt: now },
    update: { inventory: JSON.parse(JSON.stringify(inventory)) as Prisma.InputJsonValue },
  });
}

function err(res: { body: unknown }): Refusal {
  return (res.body as { error: Refusal }).error;
}

type Auth = { cookie: string } | { token: string } | { bearer: string };

function authed(req: request.Test, auth: Auth): request.Test {
  if ('cookie' in auth) return req.set('Cookie', auth.cookie);
  return req.set('Authorization', `Bearer ${'token' in auth ? auth.token : auth.bearer}`);
}

async function post(auth: Auth, path: string, body: unknown = {}) {
  return authed(request(app).post(path), auth).send(body as object);
}

async function get(auth: Auth, path: string) {
  return authed(request(app).get(path), auth);
}

function jobOf(r: PollResponse): MaintenanceJob | undefined {
  return 'maintenance' in r ? r.maintenance : undefined;
}

async function stepUp(userId: string, at: Date = new Date()): Promise<void> {
  await db.session.updateMany({ where: { userId }, data: { stepUpAt: at } });
}

/** A signed-in admin who stepped up just now. */
async function steppedUpAdmin(): Promise<{ cookie: string; userId: string; email: string }> {
  const admin = await signIn(db, 'admin');
  await stepUp(admin.userId);
  return admin;
}

function archive(volumeName: string, extra: Partial<VolumeArchive> = {}): VolumeArchive {
  return {
    archiveId: randomUUID(),
    volume: volumeName,
    owner: { kind: 'app', name: 'web' },
    createdAt: '2026-10-22T03:00:00.000Z',
    sizeBytes: 4096,
    sha256: hex64(randomUUID()),
    quiesced: false,
    ...extra,
  };
}

async function seedArchive(a: VolumeArchive, forAgent: string = agentId, retiredAt: Date | null = null): Promise<void> {
  await db.volumeArchive.create({
    data: {
      archiveId: a.archiveId,
      agentId: forAgent,
      volume: a.volume,
      ownerKind: a.owner?.kind ?? null,
      ownerName: a.owner?.name ?? null,
      createdAt: new Date(a.createdAt),
      sizeBytes: BigInt(a.sizeBytes),
      sha256: a.sha256,
      quiesced: a.quiesced,
      seenAt: new Date(),
      retiredAt,
    },
  });
}

/** Runs one job through the agent: claim it, then report `state` with `extra`. */
async function runJob(state: 'succeeded' | 'failed' | 'refused', extra: Record<string, unknown> = {}): Promise<MaintenanceJob> {
  const job = jobOf(await poll(app, key, ['maintenance']));
  if (job === undefined) throw new Error('no job was handed out');
  const res = await agentPost(app, key, `/api/agent/maintenance/${job.jobId}/result`, { jobId: job.jobId, state, ...extra });
  expect(res.status).toBe(200);
  return job;
}

async function auditActions(entityId: string): Promise<string[]> {
  return (await db.auditEvent.findMany({ where: { entityId }, orderBy: { at: 'asc' } })).map((a) => a.action);
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "maintenance_job", "volume_archive", "stack_update", "action", "api_token_stack", "stack", "host_sample", "host_snapshot", "target_image", "step", "outbox", "deploy_target", "deploy", "audit_event", "agent_nonce", "api_token_app", "api_token", "native_refresh", "app", "agent", "session", "user" cascade',
  );
  key = makeKey();
  agentId = await enrol(db, key);
  await seedOwners();
  await seedSnapshot(agentId);
  bus = new Bus();
  deps = { db, logger, config, bus };
  app = createApp({ db, logger, config, bus });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('POST /api/volumes/:volume/backup (SHP-REQ-201)', () => {
  it('a deployer backs up an owned volume: queued → claimed only with maintenance → progress → result → archive row, all audited', async () => {
    await poll(app, key, ['maintenance']);
    const { cookie, email, userId } = await signIn(db, 'deployer');
    const res = await post({ cookie }, '/api/volumes/web_data/backup');
    expect(res.status).toBe(202);
    const status = res.body as MaintenanceStatus;
    expect(status).toMatchObject({
      kind: 'volume-backup',
      state: 'queued',
      volume: 'web_data',
      owner: { kind: 'app', name: 'web' },
      requester: { kind: 'user', label: `${email} (console)` },
      archive: null,
      refusal: null,
    });
    expect(await db.maintenanceJob.findUniqueOrThrow({ where: { id: status.id } })).toMatchObject({ agentId, requesterUserId: userId, requesterKind: 'user' });

    // An agent that does not advertise maintenance is never handed it.
    expect(jobOf(await poll(app, key, ['actions', 'stack-updates', 'logs']))).toBeUndefined();
    expect((await db.maintenanceJob.findUniqueOrThrow({ where: { id: status.id } })).state).toBe('queued');

    const job = jobOf(await poll(app, key, ['maintenance']));
    expect(job).toEqual({ jobId: status.id, kind: 'volume-backup', volume: 'web_data', owner: { kind: 'app', name: 'web' }, quiesce: false });

    const path = (p: string) => `/api/agent/maintenance/${status.id}/${p}`;
    const progress = await agentPost(app, key, path('progress'), { jobId: status.id, step: 'archiving' });
    expect(progress.status).toBe(200);
    expect(progress.body).toMatchObject({ state: 'running', step: 'archiving' });

    const taken = archive('web_data');
    const old = archive('web_data', { createdAt: '2026-10-01T03:00:00.000Z' });
    await seedArchive(old);
    const result = await agentPost(app, key, path('result'), { jobId: status.id, state: 'succeeded', archive: taken, removedArchives: [old.archiveId], output: 'archived 4096 bytes' });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ state: 'succeeded', archive: taken, removedArchives: [old.archiveId], output: 'archived 4096 bytes' });

    const row = await db.volumeArchive.findUniqueOrThrow({ where: { archiveId: taken.archiveId } });
    expect(row).toMatchObject({ agentId, volume: 'web_data', ownerKind: 'app', ownerName: 'web', sizeBytes: 4096n, retiredAt: null });
    expect((await db.volumeArchive.findUniqueOrThrow({ where: { archiveId: old.archiveId } })).retiredAt).not.toBeNull();
    const listed = await get({ cookie }, '/api/volumes/web_data/archives');
    expect(listed.body).toEqual({ archives: [taken] });

    expect(await auditActions(status.id)).toEqual(['maintenance.request', 'maintenance.dispatched', 'maintenance.progress', 'maintenance.result']);
    const progressAudit = await db.auditEvent.findFirstOrThrow({ where: { entityId: status.id, action: 'maintenance.progress' } });
    expect(progressAudit.after).toEqual({ state: 'running', step: 'archiving' });

    // Exactly once.
    expect((await agentPost(app, key, path('result'), { jobId: status.id, state: 'failed' })).status).toBe(409);
    expect((await agentPost(app, key, path('progress'), { jobId: status.id, step: 'retaining' })).status).toBe(409);
  });

  it('a token scoped to the owner may back up; a token for another app may not; a viewer may not', async () => {
    await poll(app, key, ['maintenance']);
    const { cookie } = await signIn(db, 'deployer');
    const scoped = await issueToken(app, cookie, ['web']);
    const ok = await post({ token: scoped.token }, '/api/volumes/web_data/backup');
    expect(ok.status).toBe(202);
    expect(ok.body).toMatchObject({ requester: { kind: 'token', label: 'token claude' } });
    expect((await db.maintenanceJob.findFirstOrThrow()).requesterTokenId).toBe(scoped.id);

    const other = await issueToken(app, cookie, ['forgejo']);
    const refused = await post({ token: other.token }, '/api/volumes/web_data/backup');
    expect(refused.status).toBe(403);
    expect(err(refused).code).toBe('forbidden');
    // A stack-scoped token backs up the stack's volume, quiesced or not as its manifest says.
    expect((await post({ token: other.token }, '/api/volumes/forgejo_data/backup')).body).toMatchObject({ owner: { kind: 'stack', name: 'forgejo' } });

    const viewer = await signIn(db, 'viewer');
    expect(err(await post({ cookie: viewer.cookie }, '/api/volumes/web_data/backup')).code).toBe('forbidden');
    expect(await db.maintenanceJob.count()).toBe(2);
  });

  it('refuses an Observed or orphan volume (volume_not_owned), an unknown one, and a bad name', async () => {
    await poll(app, key, ['maintenance']);
    const { cookie } = await signIn(db, 'deployer');
    const observed = await post({ cookie }, '/api/volumes/plex_config/backup');
    expect(observed.status).toBe(409);
    expect(err(observed).code).toBe('volume_not_owned');
    expect(err(await post({ cookie }, '/api/volumes/old_stuff/backup')).code).toBe('volume_not_owned');
    expect(err(await post({ cookie }, '/api/volumes/ghost/backup')).code).toBe('not_found');
    expect(err(await post({ cookie }, '/api/volumes/-rf/backup')).code).toBe('invalid_request');
    expect(err(await post({ cookie }, '/api/volumes/web_data/backup', { path: '/etc' })).code).toBe('invalid_request');
    expect(await db.maintenanceJob.count()).toBe(0);
  });

  it('refuses when the agent is not polling, or never advertised maintenance', async () => {
    const { cookie } = await signIn(db, 'deployer');
    expect(err(await post({ cookie }, '/api/volumes/web_data/backup')).code).toBe('agent_offline');
    await poll(app, key, ['actions', 'stack-updates']);
    const old = await post({ cookie }, '/api/volumes/web_data/backup');
    expect(err(old).code).toBe('agent_too_old');
    expect(err(old).message).toContain('back up');
    expect(await db.maintenanceJob.count()).toBe(0);
  });
});

describe('POST /api/volumes/:volume/restore (SHP-REQ-202, SHP-REQ-204)', () => {
  it('refuses a token outright (console only), a deployer, an admin without or with a stale step-up — each attempt audited', async () => {
    await poll(app, key, ['maintenance']);
    const a = archive('web_data');
    await seedArchive(a);
    const body = { archiveId: a.archiveId, confirmVolume: 'web_data' };

    const admin = await signIn(db, 'admin');
    const token = await issueToken(app, admin.cookie, ['web']);
    const byToken = await post({ token: token.token }, '/api/volumes/web_data/restore', body);
    expect(byToken.status).toBe(403);
    expect(err(byToken)).toMatchObject({ code: 'forbidden' });
    expect(err(byToken).message).toContain('console-only');

    const deployer = await signIn(db, 'deployer');
    await stepUp(deployer.userId);
    expect(err(await post({ cookie: deployer.cookie }, '/api/volumes/web_data/restore', body)).code).toBe('forbidden');

    const none = await post({ cookie: admin.cookie }, '/api/volumes/web_data/restore', body);
    expect(none.status).toBe(403);
    expect(err(none).code).toBe('step_up_required');
    expect((none.body as { maxAgeSeconds: number }).maxAgeSeconds).toBe(600);

    await stepUp(admin.userId, new Date(Date.now() - 11 * 60_000));
    expect(err(await post({ cookie: admin.cookie }, '/api/volumes/web_data/restore', body)).code).toBe('step_up_required');
    expect(await db.maintenanceJob.count()).toBe(0);

    const refusals = await db.auditEvent.findMany({ where: { action: 'maintenance.refused', entityId: 'web_data' }, orderBy: { at: 'asc' } });
    expect(refusals.map((r) => [r.actorType, (r.after as { code: string }).code])).toEqual([
      ['token', 'forbidden'],
      ['user', 'forbidden'],
      ['user', 'step_up_required'],
      ['user', 'step_up_required'],
    ]);
    expect(refusals[0]?.actorTokenId).toBe(token.id);
    expect(refusals[1]?.actorUserId).toBe(deployer.userId);
  });

  it('asks a native session for a fresh step-up too', async () => {
    await poll(app, key, ['maintenance']);
    const a = archive('web_data');
    await seedArchive(a);
    const admin = await signIn(db, 'admin');
    const native = await issueNativeSession(db, { userId: admin.userId, method: 'password', device: { name: 'iPhone', platform: 'ios' }, now: new Date() });
    const body = { archiveId: a.archiveId, confirmVolume: 'web_data' };
    // A native client is answered in problem+json, Shipyard's code alongside.
    const stale = await post({ bearer: native.accessToken }, '/api/volumes/web_data/restore', body);
    expect(stale.status).toBe(403);
    expect((stale.body as { code: string }).code).toBe('step_up_required');
    await db.session.update({ where: { id: native.sessionId }, data: { stepUpAt: new Date() } });
    expect((await post({ bearer: native.accessToken }, '/api/volumes/web_data/restore', body)).status).toBe(202);
  });

  it('refuses a mistyped name, an unknown, retired, other-volume or other-agent archive, and an unowned volume', async () => {
    await poll(app, key, ['maintenance']);
    const admin = await steppedUpAdmin();
    const a = archive('web_data');
    await seedArchive(a);
    const mistyped = await post({ cookie: admin.cookie }, '/api/volumes/web_data/restore', { archiveId: a.archiveId, confirmVolume: 'web-data' });
    expect(mistyped.status).toBe(400);
    expect(err(mistyped).code).toBe('confirmation_mismatch');

    const unknown = await post({ cookie: admin.cookie }, '/api/volumes/web_data/restore', { archiveId: randomUUID(), confirmVolume: 'web_data' });
    expect(unknown.status).toBe(404);
    expect(err(unknown).code).toBe('archive_not_found');

    const retired = archive('web_data');
    await seedArchive(retired, agentId, new Date());
    expect(err(await post({ cookie: admin.cookie }, '/api/volumes/web_data/restore', { archiveId: retired.archiveId, confirmVolume: 'web_data' })).code).toBe('archive_not_found');

    const ofCache = archive('web_cache');
    await seedArchive(ofCache);
    expect(err(await post({ cookie: admin.cookie }, '/api/volumes/web_data/restore', { archiveId: ofCache.archiveId, confirmVolume: 'web_data' })).code).toBe('archive_not_found');

    const stranger = makeKey();
    const strangerId = await enrol(db, stranger);
    const elsewhere = archive('web_data');
    await seedArchive(elsewhere, strangerId);
    expect(err(await post({ cookie: admin.cookie }, '/api/volumes/web_data/restore', { archiveId: elsewhere.archiveId, confirmVolume: 'web_data' })).code).toBe('archive_not_found');

    const plex = archive('plex_config', { owner: null });
    await seedArchive(plex);
    expect(err(await post({ cookie: admin.cookie }, '/api/volumes/plex_config/restore', { archiveId: plex.archiveId, confirmVolume: 'plex_config' })).code).toBe('volume_not_owned');
    expect(await db.maintenanceJob.count()).toBe(0);
  });

  it('refuses while a deploy, a stack update or an action is in flight on the owner (locked)', async () => {
    await poll(app, key, ['maintenance']);
    const admin = await steppedUpAdmin();
    const a = archive('web_data');
    await seedArchive(a);
    const f = archive('forgejo_data', { owner: { kind: 'stack', name: 'forgejo' } });
    await seedArchive(f);

    const deploy = await db.deploy.create({ data: { requestedSha: 'a'.repeat(40), requesterLabel: 'someone deploying' } });
    const target = await db.deployTarget.create({ data: { deployId: deploy.id, appId: webId, state: 'locked' } });
    const deploying = await post({ cookie: admin.cookie }, '/api/volumes/web_data/restore', { archiveId: a.archiveId, confirmVolume: 'web_data' });
    expect(deploying.status).toBe(409);
    expect(err(deploying).code).toBe('locked');
    expect(err(deploying).message).toContain('someone deploying');
    await db.deployTarget.update({ where: { id: target.id }, data: { state: 'succeeded', endedAt: new Date() } });

    await db.action.create({ data: { targetKind: 'app', targetName: 'web', agentId, verb: 'restart', state: 'running', requesterLabel: 'someone restarting' } });
    expect(err(await post({ cookie: admin.cookie }, '/api/volumes/web_data/restore', { archiveId: a.archiveId, confirmVolume: 'web_data' })).message).toContain('someone restarting');

    const stack = await db.stack.findUniqueOrThrow({ where: { name: 'forgejo' } });
    await db.stackUpdate.create({ data: { stackId: stack.id, stackName: 'forgejo', agentId, state: 'queued', requesterLabel: 'someone updating' } });
    const updating = await post({ cookie: admin.cookie }, '/api/volumes/forgejo_data/restore', { archiveId: f.archiveId, confirmVolume: 'forgejo_data' });
    expect(err(updating).code).toBe('locked');
    expect(err(updating).message).toContain('someone updating');
    expect(await db.maintenanceJob.count()).toBe(0);
  });

  it('restores from the ledger, and holds the owner: deploys, actions and stack updates are refused locked meanwhile', async () => {
    await poll(app, key, ['maintenance', 'actions']);
    const admin = await steppedUpAdmin();
    const a = archive('web_data');
    await seedArchive(a);
    const res = await post({ cookie: admin.cookie }, '/api/volumes/web_data/restore', { archiveId: a.archiveId, confirmVolume: 'web_data' });
    expect(res.status).toBe(202);
    const status = res.body as MaintenanceStatus;
    expect(status).toMatchObject({ kind: 'volume-restore', state: 'queued', volume: 'web_data', owner: { kind: 'app', name: 'web' }, requester: { kind: 'user', label: `${admin.email} (console)` } });

    const locked = await lockRefusal(db, 'web', webId);
    expect(locked?.code).toBe('locked');
    expect(locked?.message).toContain(status.id);
    const action = await post({ cookie: admin.cookie }, '/api/actions', { target: { kind: 'app', name: 'web' }, verb: 'restart' });
    expect(err(action).code).toBe('locked');

    const job = jobOf(await poll(app, key, ['maintenance', 'actions']));
    expect(job).toEqual({ jobId: status.id, kind: 'volume-restore', volume: 'web_data', owner: { kind: 'app', name: 'web' }, archiveId: a.archiveId });
    expect(await auditActions(status.id)).toEqual(['maintenance.request', 'maintenance.dispatched']);
    // A second restore of the same owner is refused while this one holds it.
    expect(err(await post({ cookie: admin.cookie }, '/api/volumes/web_data/restore', { archiveId: a.archiveId, confirmVolume: 'web_data' })).code).toBe('locked');
  });

  it('a stack restore holds the stack: a stack action is refused, and a queued one is not dispatched while it runs', async () => {
    await poll(app, key, ['maintenance', 'actions']);
    const admin = await steppedUpAdmin();
    const f = archive('forgejo_data', { owner: { kind: 'stack', name: 'forgejo' } });
    await seedArchive(f);
    const queuedAction = await db.action.create({ data: { targetKind: 'stack', targetName: 'forgejo', agentId, verb: 'restart', requesterLabel: 'earlier' } });
    // The action queued first holds the stack, so the restore is refused…
    expect(err(await post({ cookie: admin.cookie }, '/api/volumes/forgejo_data/restore', { archiveId: f.archiveId, confirmVolume: 'forgejo_data' })).code).toBe('locked');
    await db.action.update({ where: { id: queuedAction.id }, data: { state: 'succeeded', endedAt: new Date() } });
    const restore = (await post({ cookie: admin.cookie }, '/api/volumes/forgejo_data/restore', { archiveId: f.archiveId, confirmVolume: 'forgejo_data' })).body as MaintenanceStatus;
    expect(jobOf(await poll(app, key, ['maintenance']))?.jobId).toBe(restore.id);
    expect(err(await post({ cookie: admin.cookie }, '/api/actions', { target: { kind: 'stack', name: 'forgejo' }, verb: 'restart' })).code).toBe('locked');
    // …and one slipped in behind its back is not handed out until it ends.
    const late = await db.action.create({ data: { targetKind: 'stack', targetName: 'forgejo', agentId, verb: 'restart', requesterLabel: 'late' } });
    expect('action' in (await poll(app, key, ['actions']))).toBe(false);
    await agentPost(app, key, `/api/agent/maintenance/${restore.id}/result`, { jobId: restore.id, state: 'succeeded' });
    const freed = await poll(app, key, ['actions']);
    expect('action' in freed ? freed.action.actionId : undefined).toBe(late.id);
  });
});

describe('volume delete (SHP-REQ-203)', () => {
  it('refuses a mounted volume (volume_in_use), a token and a missing step-up; deletes an orphan', async () => {
    await poll(app, key, ['maintenance']);
    const admin = await steppedUpAdmin();
    const inUse = await post({ cookie: admin.cookie }, '/api/volumes/web_data/delete', { confirmVolume: 'web_data' });
    expect(inUse.status).toBe(409);
    expect(err(inUse).code).toBe('volume_in_use');
    expect(err(inUse).message).toContain('web-server-1');
    expect(err(await post({ cookie: admin.cookie }, '/api/volumes/plex_config/delete', { confirmVolume: 'plex_config' })).code).toBe('volume_in_use');
    expect(err(await post({ cookie: admin.cookie }, '/api/volumes/old_stuff/delete', { confirmVolume: 'old-stuff' })).code).toBe('confirmation_mismatch');

    const token = await issueToken(app, admin.cookie, ['web']);
    expect(err(await post({ token: token.token }, '/api/volumes/old_stuff/delete', { confirmVolume: 'old_stuff' })).code).toBe('forbidden');
    const fresh = await signIn(db, 'admin');
    expect(err(await post({ cookie: fresh.cookie }, '/api/volumes/old_stuff/delete', { confirmVolume: 'old_stuff' })).code).toBe('step_up_required');

    const res = await post({ cookie: admin.cookie }, '/api/volumes/old_stuff/delete', { confirmVolume: 'old_stuff' });
    expect(res.status).toBe(202);
    const status = res.body as MaintenanceStatus;
    expect(status).toMatchObject({ kind: 'volume-delete', state: 'queued', volume: 'old_stuff', owner: null });
    expect(jobOf(await poll(app, key, ['maintenance']))).toEqual({ jobId: status.id, kind: 'volume-delete', volume: 'old_stuff' });

    // The DELETE form says the same.
    expect(err(await authed(request(app).delete('/api/volumes/web_data'), { cookie: admin.cookie }).send({ confirmVolume: 'web_data' })).code).toBe('volume_in_use');
    expect(await db.auditEvent.count({ where: { action: 'maintenance.refused', entityId: 'old_stuff' } })).toBe(3);
  });
});

describe('POST /api/prune (SHP-REQ-205)', () => {
  const ITEM = { kind: 'image', id: `sha256:${'a'.repeat(64)}`, ref: 'old:1', sizeBytes: 100, createdAt: null, reason: 'dangling' } as const;

  it('a dry run lists, then a prune from it carries its ID and criteria; any token may', async () => {
    await poll(app, key, ['maintenance']);
    const { cookie } = await signIn(db, 'deployer');
    const token = await issueToken(app, cookie, ['web']);
    const dry = await post({ token: token.token }, '/api/prune', { images: { dangling: true, unusedOlderThanHours: null } });
    expect(dry.status).toBe(202);
    const dryStatus = dry.body as MaintenanceStatus;
    expect(dryStatus).toMatchObject({ kind: 'prune', volume: null, owner: null, state: 'queued' });
    const job = await runJob('succeeded', { prune: { items: [ITEM], reclaimableBytes: 100, reclaimedBytes: null } });
    expect(job).toEqual({ jobId: dryStatus.id, kind: 'prune', dryRun: true, images: { dangling: true, unusedOlderThanHours: null }, buildCache: { olderThanHours: 168 } });
    expect((await get({ cookie }, `/api/maintenance/${dryStatus.id}`)).body).toMatchObject({ state: 'succeeded', prune: { items: [ITEM], reclaimableBytes: 100 } });

    const real = await post({ cookie }, '/api/prune', { dryRun: false, fromDryRunId: dryStatus.id, images: { dangling: false, unusedOlderThanHours: 24 } });
    expect(real.status).toBe(202);
    const realJob = jobOf(await poll(app, key, ['maintenance']));
    // The dry run's criteria, not the request's: the agent removes only what that list holds.
    expect(realJob).toEqual({
      jobId: (real.body as MaintenanceStatus).id,
      kind: 'prune',
      dryRun: false,
      fromDryRunId: dryStatus.id,
      images: { dangling: true, unusedOlderThanHours: null },
      buildCache: { olderThanHours: 168 },
    });
    expect((await db.maintenanceJob.findUniqueOrThrow({ where: { id: (real.body as MaintenanceStatus).id } })).dryRunOf).toBe(dryStatus.id);
  });

  it('refuses a prune without a succeeded dry run of this agent from the last hour (dry_run_required)', async () => {
    await poll(app, key, ['maintenance']);
    const { cookie } = await signIn(db, 'deployer');
    expect(err(await post({ cookie }, '/api/prune', { dryRun: false })).code).toBe('invalid_request');
    const none = await post({ cookie }, '/api/prune', { dryRun: false, fromDryRunId: randomUUID() });
    expect(none.status).toBe(409);
    expect(err(none).code).toBe('dry_run_required');

    const dryJob = (id: string) => ({ jobId: id, kind: 'prune', dryRun: true, images: { dangling: true, unusedOlderThanHours: 168 }, buildCache: { olderThanHours: 168 } });
    const seedDry = async (forAgent: string, state: 'succeeded' | 'failed' | 'queued', finishedAt: Date | null): Promise<string> => {
      const id = randomUUID();
      await db.maintenanceJob.create({ data: { id, agentId: forAgent, kind: 'prune', state, job: dryJob(id), requesterKind: 'user', requesterLabel: 'seed', finishedAt } });
      return id;
    };
    const stranger = makeKey();
    const strangerId = await enrol(db, stranger);
    const theirs = await seedDry(strangerId, 'succeeded', new Date());
    expect(err(await post({ cookie }, '/api/prune', { dryRun: false, fromDryRunId: theirs })).code).toBe('dry_run_required');
    const expired = await seedDry(agentId, 'succeeded', new Date(Date.now() - 61 * 60_000));
    expect(err(await post({ cookie }, '/api/prune', { dryRun: false, fromDryRunId: expired })).code).toBe('dry_run_required');
    const failed = await seedDry(agentId, 'failed', new Date());
    expect(err(await post({ cookie }, '/api/prune', { dryRun: false, fromDryRunId: failed })).code).toBe('dry_run_required');
    const backup = await post({ cookie }, '/api/volumes/web_data/backup');
    expect(err(await post({ cookie }, '/api/prune', { dryRun: false, fromDryRunId: (backup.body as MaintenanceStatus).id })).code).toBe('dry_run_required');
    expect(await db.maintenanceJob.count({ where: { kind: 'prune', dryRunOf: { not: null } } })).toBe(0);

    const fresh = await seedDry(agentId, 'succeeded', new Date(Date.now() - 59 * 60_000));
    expect((await post({ cookie }, '/api/prune', { dryRun: false, fromDryRunId: fresh })).status).toBe(202);

    const viewer = await signIn(db, 'viewer');
    expect(err(await post({ cookie: viewer.cookie }, '/api/prune', {})).code).toBe('forbidden');
  });
});

describe('dispatch, results and the stale sweep', () => {
  it('hands out one job at a time per agent, oldest first', async () => {
    await poll(app, key, ['maintenance']);
    const { cookie } = await signIn(db, 'deployer');
    const first = (await post({ cookie }, '/api/volumes/web_data/backup')).body as MaintenanceStatus;
    const second = (await post({ cookie }, '/api/volumes/forgejo_data/backup')).body as MaintenanceStatus;
    expect(jobOf(await poll(app, key, ['maintenance']))?.jobId).toBe(first.id);
    expect(jobOf(await poll(app, key, ['maintenance']))).toBeUndefined();
    await agentPost(app, key, `/api/agent/maintenance/${first.id}/result`, { jobId: first.id, state: 'failed' });
    expect(jobOf(await poll(app, key, ['maintenance']))?.jobId).toBe(second.id);
    const failed = await get({ cookie }, `/api/maintenance/${first.id}`);
    expect(failed.body).toMatchObject({ state: 'failed', refusal: { code: 'step_failed' } });
  });

  it('accepts progress and results only from the agent it was dispatched to', async () => {
    await poll(app, key, ['maintenance']);
    const { cookie } = await signIn(db, 'deployer');
    const queued = (await post({ cookie }, '/api/volumes/web_data/backup')).body as MaintenanceStatus;
    const path = (p: string) => `/api/agent/maintenance/${queued.id}/${p}`;
    expect((await agentPost(app, key, path('progress'), { jobId: queued.id, step: 'archiving' })).status).toBe(404);
    await poll(app, key, ['maintenance']);
    const stranger = makeKey();
    await enrol(db, stranger);
    expect((await agentPost(app, stranger, path('progress'), { jobId: queued.id, step: 'archiving' })).status).toBe(404);
    expect((await agentPost(app, stranger, path('result'), { jobId: queued.id, state: 'succeeded' })).status).toBe(404);
    expect((await agentPost(app, key, path('result'), { jobId: randomUUID(), state: 'succeeded' })).status).toBe(404);
    expect((await db.maintenanceJob.findUniqueOrThrow({ where: { id: queued.id } })).state).toBe('dispatched');
  });

  it('fails a job with no word from the agent for fifteen minutes (agent_offline), audited maintenance.expired', async () => {
    await poll(app, key, ['maintenance']);
    const { cookie } = await signIn(db, 'deployer');
    const queued = (await post({ cookie }, '/api/volumes/web_data/backup')).body as MaintenanceStatus;
    await poll(app, key, ['maintenance']);
    expect(await sweepStaleMaintenance(deps, new Date(Date.now() + MAINTENANCE_STALE_MS - 60_000))).toEqual([]);
    expect(await sweepStaleMaintenance(deps, new Date(Date.now() + MAINTENANCE_STALE_MS + 60_000))).toEqual([queued.id]);
    const after = await get({ cookie }, `/api/maintenance/${queued.id}`);
    expect(after.body).toMatchObject({ state: 'failed', refusal: { code: 'agent_offline' } });
    const expired = await db.auditEvent.findFirstOrThrow({ where: { action: 'maintenance.expired', entityId: queued.id } });
    expect(expired.actorType).toBe('system');
    expect((await agentPost(app, key, `/api/agent/maintenance/${queued.id}/result`, { jobId: queued.id, state: 'succeeded' })).status).toBe(409);
  });

  it('GET /api/maintenance lists newest first, scoped for a token; GET /:id waits for the end', async () => {
    await poll(app, key, ['maintenance']);
    const { cookie } = await signIn(db, 'deployer');
    const web = (await post({ cookie }, '/api/volumes/web_data/backup')).body as MaintenanceStatus;
    const forgejo = (await post({ cookie }, '/api/volumes/forgejo_data/backup')).body as MaintenanceStatus;
    const prune = (await post({ cookie }, '/api/prune', {})).body as MaintenanceStatus;
    const all = (await get({ cookie }, '/api/maintenance')).body as MaintenancePage;
    expect(all.items.map((i) => i.id)).toEqual([prune.id, forgejo.id, web.id]);
    const paged = (await get({ cookie }, '/api/maintenance?limit=2')).body as MaintenancePage;
    expect(paged.items).toHaveLength(2);
    expect(((await get({ cookie }, `/api/maintenance?cursor=${paged.nextCursor ?? ''}`)).body as MaintenancePage).items.map((i) => i.id)).toEqual([web.id]);

    const token = await issueToken(app, cookie, ['web']);
    const scoped = (await get({ token: token.token }, '/api/maintenance')).body as MaintenancePage;
    expect(scoped.items.map((i) => i.id)).toEqual([prune.id, web.id]);
    expect((await get({ token: token.token }, `/api/maintenance/${forgejo.id}`)).status).toBe(403);
    expect((await get({ cookie }, `/api/maintenance/${randomUUID()}`)).status).toBe(404);

    await poll(app, key, ['maintenance']);
    const waiting = get({ token: token.token }, `/api/maintenance/${web.id}?wait=5`).then((r) => r);
    const waited = waitForMaintenance(deps, web.id, 5000);
    await new Promise((r) => setTimeout(r, 100));
    await agentPost(app, key, `/api/agent/maintenance/${web.id}/result`, { jobId: web.id, state: 'succeeded', archive: archive('web_data') });
    expect((await waiting).body).toMatchObject({ id: web.id, state: 'succeeded' });
    expect(await waited).toMatchObject({ state: 'succeeded' });
  });
});

describe('nightly backups (SHP-REQ-201)', () => {
  it('queues once a day at the hour, as the system, per the manifests; skips one in flight and respects volumes', async () => {
    await db.app.deleteMany();
    await db.stack.deleteMany();
    await seedOwners({ volumes: ['web_data'], retain: 7, quiesce: false, nightly: true, beforeUpdate: false }, { retain: 3, quiesce: true, nightly: true, beforeUpdate: false });
    const runner = nightlyBackups(deps, 3);
    expect(await runner.tick(new Date(2026, 9, 23, 2, 59))).toBeNull();
    const first = await runner.tick(new Date(2026, 9, 23, 3, 5));
    expect(first).toHaveLength(2);
    const rows = await db.maintenanceJob.findMany({ orderBy: { volume: 'asc' } });
    expect(rows.map((r) => [r.volume, r.requesterKind, r.requesterLabel, (r.job as { quiesce: boolean }).quiesce])).toEqual([
      ['forgejo_data', 'system', NIGHTLY_REQUESTER_LABEL, true],
      ['web_data', 'system', NIGHTLY_REQUESTER_LABEL, false],
    ]);
    // web_cache is not in web's list.
    expect(rows.some((r) => r.volume === 'web_cache')).toBe(false);
    const audits = await db.auditEvent.findMany({ where: { action: 'maintenance.request' } });
    expect(audits.map((a) => a.actorType)).toEqual(['system', 'system']);

    // Once a day: not again this hour, nor after a restart within it.
    expect(await runner.tick(new Date(2026, 9, 23, 3, 30))).toBeNull();
    expect(await nightlyBackups(deps, 3).tick(new Date(2026, 9, 23, 3, 40))).toEqual([]);

    // The next night, a volume whose backup is still queued from before is skipped.
    await db.maintenanceJob.updateMany({ where: { volume: 'forgejo_data' }, data: { state: 'succeeded', finishedAt: new Date() } });
    expect(await runner.tick(new Date(2026, 9, 24, 3, 1))).toHaveLength(1);
    expect(await db.maintenanceJob.count({ where: { volume: 'forgejo_data' } })).toBe(2);
    expect(await db.maintenanceJob.count({ where: { volume: 'web_data' } })).toBe(1);
  });
});

describe('the report mirrors the agent ledger', () => {
  it('upserts the archives listed and retires the ones a later report no longer lists', async () => {
    const report = (volumeArchives?: VolumeArchive[]): AgentReport => ({
      agentVersion: '0.17.0',
      composeVersion: '5.0.1',
      engineApiVersion: '1.51',
      patExpiresAt: null,
      apps: [],
      ...(volumeArchives === undefined ? {} : { volumeArchives }),
    });
    const a = archive('web_data');
    const b = archive('forgejo_data', { owner: { kind: 'stack', name: 'forgejo' }, quiesced: true });
    const first = await agentPost(app, key, '/api/agent/report', report([a, b]));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ volumeArchives: { added: [a.archiveId, b.archiveId], retired: [] } });
    expect(await db.volumeArchive.count({ where: { retiredAt: null } })).toBe(2);
    expect(await db.auditEvent.count({ where: { action: 'agent.report' } })).toBe(1);

    // Absent: the mirror stands.
    await agentPost(app, key, '/api/agent/report', report());
    expect(await db.volumeArchive.count({ where: { retiredAt: null } })).toBe(2);

    const second = await agentPost(app, key, '/api/agent/report', report([b]));
    expect(second.body).toMatchObject({ volumeArchives: { added: [], retired: [a.archiveId] } });
    expect((await db.volumeArchive.findUniqueOrThrow({ where: { archiveId: a.archiveId } })).retiredAt).not.toBeNull();
    const { cookie } = await signIn(db, 'viewer');
    expect((await get({ cookie }, '/api/volumes/web_data/archives')).body).toEqual({ archives: [] });
    expect((await get({ cookie }, '/api/volumes/forgejo_data/archives')).body).toEqual({ archives: [b] });

    // An archive ID another agent already reported stays that agent's.
    const stranger = makeKey();
    const strangerId = await enrol(db, stranger);
    expect(await mirrorVolumeArchives(deps, strangerId, [b])).toEqual({ added: [], retired: [] });
    expect((await db.volumeArchive.findUniqueOrThrow({ where: { archiveId: b.archiveId } })).agentId).toBe(agentId);
  });
});

describe('GET /api/maintenance/needs-you', () => {
  it("shows each volume's latest backup when it failed, until one succeeds, and filesystems at least 90% full", async () => {
    await seedSnapshot(agentId, { dataRoot: { path: '/DATA', freeBytes: 5, totalBytes: 100 }, dockerRoot: { path: '/var/lib/docker', freeBytes: 40, totalBytes: 100 } });
    await poll(app, key, ['maintenance']);
    const { cookie } = await signIn(db, 'deployer');
    const web = (await post({ cookie }, '/api/volumes/web_data/backup')).body as MaintenanceStatus;
    await runJob('failed', { refusal: { code: 'step_failed', gate: 'none', message: 'tar failed', fix: 'Look at the volume.' } });
    const forgejo = (await post({ cookie }, '/api/volumes/forgejo_data/backup')).body as MaintenanceStatus;
    await runJob('refused');

    const needs = (await get({ cookie }, '/api/maintenance/needs-you')).body as MaintenanceNeedsYou;
    expect(needs.failedBackups.map((s) => s.id)).toEqual([forgejo.id, web.id]);
    expect(needs.failedBackups[1]?.refusal?.message).toBe('tar failed');
    expect(needs.lowDisk).toEqual([{ mount: '/DATA', usedPercent: 95, freeBytes: 5 }]);

    await post({ cookie }, '/api/volumes/web_data/backup');
    await runJob('succeeded', { archive: archive('web_data') });
    const after = (await get({ cookie }, '/api/maintenance/needs-you')).body as MaintenanceNeedsYou;
    expect(after.failedBackups.map((s) => s.id)).toEqual([forgejo.id]);

    const token = await issueToken(app, cookie, ['web']);
    expect((await get({ token: token.token }, '/api/maintenance/needs-you')).status).toBe(403);
  });
});
