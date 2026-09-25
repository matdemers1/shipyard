import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hashPassword, type Db } from './db.js';
import { FIXTURE_FILE, INVITE_TOKEN, STATE_DIR, USERS } from './env.js';

/**
 * The baseline world every console-e2e test starts from: one of each thing a screen can show.
 *
 * Written straight through the server's Prisma client, the way the agent's reports and the server's
 * own services would have left it — the console cannot tell the difference, and a scenario costs a
 * few inserts rather than a real Docker host. `seedBaseline` returns the IDs a test navigates to;
 * global setup writes them to `.state/fixture.json` and `fixture()` reads them back.
 */

// ── Tables ────────────────────────────────────────────────────────────────

/** Every table, children before parents (TRUNCATE … CASCADE does not care, but a reader might). */
const ALL_TABLES = [
  'outbox',
  'step',
  'target_image',
  'backup_artifact',
  'schedule',
  'approval',
  'deploy_target',
  'deploy',
  'drift_event',
  'freeze',
  'api_token_app',
  'api_token',
  'app',
  'agent_nonce',
  'agent',
  'audit_event',
  'invite',
  // Settings → D3 Auth (SHP-REQ-110). The server holds the live client in memory: a spec that saves
  // one also clears it through the API (harness/d3auth.ts), which is what swaps the client back.
  'setting',
  'session',
  'identity',
  'user',
] as const;

/** Everything except who can sign in: a scenario can start from nothing without signing in again. */
const APP_DATA_TABLES = ALL_TABLES.filter((t) => t !== 'user' && t !== 'session' && t !== 'identity');

function truncate(tables: readonly string[]): string {
  return `TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`;
}

/** Empties the whole database, users and sessions included. */
export async function wipeAll(db: Db): Promise<void> {
  await db.$executeRawUnsafe(truncate(ALL_TABLES));
}

/**
 * Empties everything but users, identities and sessions — so the signed-in `storageState` files stay
 * valid. For a scenario that needs a world different from the baseline (no agent, no apps …).
 */
export async function wipeAppData(db: Db): Promise<void> {
  await db.$executeRawUnsafe(truncate(APP_DATA_TABLES));
}

// ── Small builders ────────────────────────────────────────────────────────

/** A deterministic 40-hex commit SHA, distinct per `n`. */
export function sha(n: number): string {
  return createHash('sha1').update(`console-e2e commit ${String(n)}`).digest('hex');
}

/** A deterministic `sha256:<64hex>` image digest, distinct per `label`. */
export function digest(label: string): string {
  return `sha256:${createHash('sha256').update(`console-e2e image ${label}`).digest('hex')}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function ago(ms: number, now: number = Date.now()): Date {
  return new Date(now - ms);
}

export function ahead(ms: number, now: number = Date.now()): Date {
  return new Date(now + ms);
}

export { MINUTE, HOUR, DAY };

interface AppSpec {
  name: string;
  services: string[];
  approval?: 'none' | 'required';
  group?: string;
  canary?: boolean;
  foremanProject?: string;
  soakSeconds?: number;
}

function servicesFor(spec: AppSpec): Record<string, { image: string }> {
  return Object.fromEntries(spec.services.map((s) => [s, { image: `ghcr.io/matdemers1/${spec.name}/${s}` }]));
}

/** The canonical-JSON manifest the agent's report stores. */
function manifestFor(spec: AppSpec): Record<string, unknown> {
  const services = servicesFor(spec);
  return {
    name: spec.name,
    repo: `matdemers1/${spec.name}`,
    defaultBranch: 'main',
    workflow: 'ci.yml',
    compose: { project: spec.name, files: [`/srv/${spec.name}/docker-compose.yml`] },
    services,
    health: { url: `http://127.0.0.1:8080/health`, schema: 'schemaRevision' },
    soakSeconds: spec.soakSeconds ?? 60,
    approval: spec.approval ?? 'none',
    ...(spec.foremanProject === undefined ? {} : { foreman: { project: spec.foremanProject, environment: 'production' } }),
    ...(spec.group === undefined ? {} : { group: spec.group }),
    ...(spec.canary === undefined ? {} : { canary: spec.canary }),
    diskFloorGb: 5,
    retainImages: 3,
  };
}

/** Creates an app as the agent's report would have mirrored it, running `running` (service → digest). */
export async function createApp(
  db: Db,
  agentId: string,
  spec: AppSpec,
  running: Record<string, string | null>,
  extra: { driftedAt?: Date } = {},
): Promise<string> {
  const manifest = manifestFor(spec);
  const json = JSON.stringify(manifest);
  const row = await db.app.create({
    data: {
      name: spec.name,
      agentId,
      manifestYaml: json,
      manifestSha256: createHash('sha256').update(json).digest('hex'),
      repo: `matdemers1/${spec.name}`,
      defaultBranch: 'main',
      services: servicesFor(spec),
      soakSeconds: spec.soakSeconds ?? 60,
      approvalPolicy: spec.approval ?? 'none',
      foremanProject: spec.foremanProject ?? null,
      foremanEnvironment: spec.foremanProject === undefined ? null : 'production',
      groupName: spec.group ?? null,
      canary: spec.canary ?? false,
      reportedAt: new Date(),
      runningDigests: running,
      driftedAt: extra.driftedAt ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

interface StepSpec {
  name: string;
  argv: string[];
  exitCode: number | null;
  output?: string;
}

interface DeploySpec {
  appId: string;
  appName: string;
  services: string[];
  sha: string;
  kind?: 'deploy' | 'rollback' | 'restore';
  state: 'succeeded' | 'failed' | 'rolled_back' | 'refused' | 'awaiting_approval' | 'soaking' | 'queued' | 'cancelled';
  endedAt: Date | null;
  requesterLabel: string;
  requesterUserId?: string;
  requesterTokenId?: string;
  requesterRepo?: string;
  requesterBranch?: string;
  dryRun?: boolean;
  steps?: StepSpec[];
  refusal?: { code: string; gate: string; message: string; fix: string };
  currentStep?: string;
  schemaRevision?: string;
  migration?: 'expand' | 'contract' | 'none';
  /** Write `target_image` rows (every real release does; a refused or held deploy does not). */
  images?: boolean;
  rollbackToDeployId?: string;
  groupName?: string;
}

export interface CreatedDeploy {
  deployId: string;
  targetId: string;
}

/** The gate list a finished deploy's result carries, all passing unless `failAt` names one. */
function gatesFor(failAt?: string, reason?: string): { gate: string; pass: boolean; reason: string }[] {
  const all = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11'];
  const out: { gate: string; pass: boolean; reason: string }[] = [];
  for (const gate of all) {
    if (gate === failAt) {
      out.push({ gate, pass: false, reason: reason ?? 'failed' });
      break;
    }
    out.push({ gate, pass: true, reason: 'ok' });
  }
  return out;
}

/** A deploy, its one target, its images and its journaled steps. */
export async function createDeploy(db: Db, spec: DeploySpec): Promise<CreatedDeploy> {
  const endedAt = spec.endedAt;
  const startedAt = endedAt === null ? ago(4 * MINUTE) : new Date(endedAt.getTime() - 3 * MINUTE);
  const createdAt = new Date(startedAt.getTime() - 20_000);
  const dispatched = spec.state !== 'awaiting_approval' && spec.state !== 'queued' && spec.state !== 'refused';
  const images = spec.images ?? (spec.state !== 'refused' && spec.state !== 'awaiting_approval' && spec.state !== 'queued');
  const failGate = spec.refusal?.gate.startsWith('G') === true ? spec.refusal.gate : undefined;

  const deploy = await db.deploy.create({
    data: {
      kind: spec.kind ?? 'deploy',
      requestedSha: spec.sha,
      dryRun: spec.dryRun ?? false,
      requesterLabel: spec.requesterLabel,
      requesterRepo: spec.requesterRepo ?? null,
      requesterBranch: spec.requesterBranch ?? null,
      requesterUserId: spec.requesterUserId ?? null,
      requesterTokenId: spec.requesterTokenId ?? null,
      groupName: spec.groupName ?? null,
      createdAt,
      targets: {
        create: {
          appId: spec.appId,
          state: spec.state,
          result: {
            gates: gatesFor(failGate, spec.refusal?.message),
            images: spec.services.map((s) => ({
              service: s,
              sha: spec.sha,
              digest: digest(`${spec.appName}/${s}@${spec.sha}`),
              migration: spec.migration ?? 'none',
            })),
          },
          ...(spec.refusal === undefined ? {} : { refusal: spec.refusal }),
          schemaRevision: spec.schemaRevision ?? null,
          currentStep: spec.currentStep ?? null,
          dispatchedAt: dispatched ? startedAt : null,
          rollbackToDeployId: spec.rollbackToDeployId ?? null,
          startedAt: dispatched ? startedAt : null,
          endedAt,
          createdAt,
        },
      },
    },
    select: { id: true, targets: { select: { id: true } } },
  });
  const targetId = deploy.targets[0]?.id;
  if (targetId === undefined) throw new Error('deploy created without its target');

  if (images) {
    await db.targetImage.createMany({
      data: spec.services.map((s) => ({
        targetId,
        service: s,
        repo: `ghcr.io/matdemers1/${spec.appName}/${s}`,
        sha: spec.sha,
        digest: digest(`${spec.appName}/${s}@${spec.sha}`),
        migrationLabel: spec.migration ?? 'none',
      })),
    });
  }

  let at = startedAt.getTime();
  for (const step of spec.steps ?? []) {
    const stepStart = new Date(at);
    at += 15_000;
    await db.step.create({
      data: {
        targetId,
        name: step.name,
        argv: step.argv,
        startedAt: stepStart,
        endedAt: step.exitCode === null ? null : new Date(at),
        exitCode: step.exitCode,
        output: step.output ?? null,
      },
    });
  }
  return { deployId: deploy.id, targetId };
}

/** The steps a successful deploy journals, from verify to soak. */
function happySteps(app: string, sha7: string): StepSpec[] {
  return [
    { name: 'verify', argv: ['verify'], exitCode: 0, output: `CI green for ${sha7}; on main; ahead of live; digests present` },
    { name: 'backup', argv: ['docker', 'compose', '-p', app, 'run', '--rm', 'backup'], exitCode: 0, output: 'dump written' },
    { name: 'pull', argv: ['docker', 'compose', '-p', app, 'pull'], exitCode: 0, output: 'Pulled' },
    { name: 'swap', argv: ['docker', 'compose', '-p', app, 'up', '-d', '--no-deps'], exitCode: 0, output: 'Recreated' },
    { name: 'check', argv: ['check'], exitCode: 0, output: 'digest, revision label and /health schema match' },
    { name: 'soak', argv: ['soak'], exitCode: 0, output: 'healthy for 60s' },
  ];
}

// ── The baseline ──────────────────────────────────────────────────────────

export interface Fixture {
  users: { admin: string; viewer: string; deployer: string };
  agentId: string;
  apps: {
    /** Deploy history: releases, a rolled-back and a refused deploy, backups, a schedule. */
    history: string;
    /** Never deployed through Shipyard. */
    neverDeployed: string;
    /** Running digests differ from the recorded release, unresolved. */
    drifted: string;
    /** Frozen until cleared. */
    frozen: string;
    /** Approval-required, with a deploy waiting on approval. */
    approval: string;
    /** A group's canary, with a deploy in progress. */
    canary: string;
    /** The group's other member. */
    groupMember: string;
  };
  group: string;
  deploys: {
    /** Succeeded, with images, steps and an outbox row. */
    succeeded: string;
    /** Rolled back after a failed check. */
    rolledBack: string;
    /** Refused at a gate. */
    refused: string;
    /** In progress (soaking). */
    inProgress: string;
    /** Held for approval. */
    awaitingApproval: string;
  };
  inviteToken: string;
}

export interface SeededUsers {
  admin: string;
  viewer: string;
  deployer: string;
}

/** Wipes the database and writes the baseline: users, then the world. Returns the IDs tests use. */
export async function seedBaseline(db: Db, now: number = Date.now()): Promise<Fixture> {
  await wipeAll(db);
  return seedWorld(db, await seedUsers(db, now), now);
}

/**
 * Puts the baseline world back — every app, deploy, token, invite and agent — but keeps the users
 * and their sessions, so the signed-in `storageState` files stay valid. For a test that changed or
 * wiped the world (`wipeAppData`) and must leave it as the next test expects. Rewrites the fixture
 * file: the deploy IDs are new.
 */
export async function reseedWorld(db: Db, now: number = Date.now()): Promise<Fixture> {
  await wipeAppData(db);
  const find = async (email: string): Promise<string> => (await db.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id;
  const users: SeededUsers = {
    admin: await find(USERS.admin.email),
    viewer: await find(USERS.viewer.email),
    deployer: await find(DEPLOYER_EMAIL),
  };
  const fx = await seedWorld(db, users, now);
  writeFixture(fx);
  return fx;
}

const DEPLOYER_EMAIL = 'deployer@shipyard.test';

/** An admin and a viewer who sign in, a deployer to list, and a disabled account. */
export async function seedUsers(db: Db, now: number = Date.now()): Promise<SeededUsers> {
  const [adminHash, viewerHash, otherHash] = await Promise.all([
    hashPassword(USERS.admin.password),
    hashPassword(USERS.viewer.password),
    hashPassword('console-e2e-unused-password'),
  ]);
  const admin = await db.user.create({
    data: {
      email: USERS.admin.email,
      displayName: USERS.admin.displayName,
      passwordHash: adminHash,
      totpSecret: USERS.admin.totpSecret,
      totpEnabledAt: ago(30 * DAY, now),
      role: 'admin',
      createdAt: ago(30 * DAY, now),
    },
  });
  const viewer = await db.user.create({
    data: {
      email: USERS.viewer.email,
      displayName: USERS.viewer.displayName,
      passwordHash: viewerHash,
      totpSecret: USERS.viewer.totpSecret,
      totpEnabledAt: ago(10 * DAY, now),
      role: 'viewer',
      createdAt: ago(10 * DAY, now),
    },
  });
  const deployer = await db.user.create({
    data: {
      email: DEPLOYER_EMAIL,
      displayName: 'Dee Deployer',
      passwordHash: otherHash,
      totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      totpEnabledAt: ago(8 * DAY, now),
      role: 'deployer',
    },
  });
  await db.user.create({
    data: {
      email: 'former@shipyard.test',
      displayName: 'Former Colleague',
      passwordHash: otherHash,
      role: 'deployer',
      disabledAt: ago(2 * DAY, now),
    },
  });
  await db.identity.create({
    data: { userId: admin.id, issuer: 'https://auth.d3cloud.io', subject: 'e2e-admin-sub', emailAtLink: USERS.admin.email, lastUsedAt: ago(DAY, now) },
  });
  return { admin: admin.id, viewer: viewer.id, deployer: deployer.id };
}

/** Everything but the users: agents, apps and their history, tokens, invites, outbox, audit. */
export async function seedWorld(db: Db, users: SeededUsers, now: number = Date.now()): Promise<Fixture> {
  const admin = { id: users.admin };

  // Agents: one confirmed and heartbeating, one enrolled and awaiting confirmation.
  const agent = await db.agent.create({
    data: {
      publicKey: 'MCowBQYDK2VwAyEAconsoleE2eConfirmedAgentPublicKey0000000000=',
      fingerprint: 'SHA256:c0ns0le-e2e-c0nf1rmed-agent-f1ngerpr1nt',
      enrolledAt: ago(20 * DAY, now),
      confirmedAt: ago(20 * DAY, now),
      confirmedByUserId: admin.id,
      lastHeartbeatAt: new Date(now),
      agentVersion: '0.6.0',
      composeVersion: '5.0.2',
      engineApiVersion: '1.51',
      // Inside the 30-day warning window (SHP-REQ-106).
      patExpiresAt: ahead(20 * DAY, now),
    },
  });
  await db.agent.create({
    data: {
      publicKey: 'MCowBQYDK2VwAyEAconsoleE2ePendingAgentPublicKey000000000000=',
      fingerprint: 'SHA256:c0ns0le-e2e-pend1ng-agent-f1ngerpr1nt',
      enrolledAt: ago(10 * MINUTE, now),
    },
  });

  // A scoped API token (it requested the held deploy) and a revoked one.
  const token = await db.apiToken.create({
    data: {
      userId: admin.id,
      label: 'matdemers1/d3-auth',
      tokenHash: createHash('sha256').update('console-e2e token one').digest('hex'),
      prefix: 'shp_c0nsole1',
      lastUsedAt: ago(2 * HOUR, now),
      lastUsedIp: '203.0.113.7',
    },
  });
  const revoked = await db.apiToken.create({
    data: {
      userId: admin.id,
      label: 'matdemers1/old-repo',
      tokenHash: createHash('sha256').update('console-e2e token two').digest('hex'),
      prefix: 'shp_c0nsole2',
      revokedAt: ago(3 * DAY, now),
    },
  });

  // ── Apps ──
  const history = { name: 'bindery', services: ['server', 'worker'], foremanProject: 'BND' } satisfies AppSpec;
  const neverDeployed = { name: 'someday-vault', services: ['server'] } satisfies AppSpec;
  const drifted = { name: 'foreman', services: ['server'], foremanProject: 'FRM' } satisfies AppSpec;
  const frozen = { name: 'sceptrefall', services: ['server'] } satisfies AppSpec;
  const approval = { name: 'd3auth', services: ['server'], approval: 'required', foremanProject: 'AUTH' } satisfies AppSpec;
  const canary = { name: 'www', services: ['web'], group: 'sites', canary: true } satisfies AppSpec;
  const groupMember = { name: 'docs', services: ['web'], group: 'sites' } satisfies AppSpec;

  const live = (spec: AppSpec, n: number): Record<string, string> =>
    Object.fromEntries(spec.services.map((s) => [s, digest(`${spec.name}/${s}@${sha(n)}`)]));

  const historyId = await createApp(db, agent.id, history, live(history, 4));
  await createApp(db, agent.id, neverDeployed, { server: digest('someday-vault/server@hand') });
  const driftedId = await createApp(db, agent.id, drifted, { server: digest('foreman/server@hand-pulled') }, { driftedAt: ago(3 * HOUR, now) });
  const frozenId = await createApp(db, agent.id, frozen, live(frozen, 31));
  const approvalId = await createApp(db, agent.id, approval, live(approval, 41));
  const canaryId = await createApp(db, agent.id, canary, live(canary, 51));
  const memberId = await createApp(db, agent.id, groupMember, live(groupMember, 61));
  await db.apiTokenApp.createMany({
    data: [
      { tokenId: token.id, appId: approvalId },
      { tokenId: revoked.id, appId: historyId },
    ],
  });

  const base = (spec: AppSpec, id: string) => ({ appId: id, appName: spec.name, services: spec.services });

  // bindery: three releases, a rollback after a failed check, a refusal, backups, a schedule.
  const r1 = await createDeploy(db, {
    ...base(history, historyId),
    sha: sha(1),
    state: 'succeeded',
    endedAt: ago(10 * DAY, now),
    requesterLabel: USERS.admin.displayName,
    requesterUserId: admin.id,
    schemaRevision: '20260901_init',
    steps: happySteps('bindery', sha(1).slice(0, 7)),
  });
  const r2 = await createDeploy(db, {
    ...base(history, historyId),
    sha: sha(2),
    state: 'succeeded',
    endedAt: ago(5 * DAY, now),
    requesterLabel: 'claude: matdemers1/bindery ship P16',
    requesterTokenId: token.id,
    requesterRepo: 'matdemers1/bindery',
    requesterBranch: 'main',
    schemaRevision: '20260915_vault',
    migration: 'expand',
    steps: happySteps('bindery', sha(2).slice(0, 7)),
  });
  const rolledBack = await createDeploy(db, {
    ...base(history, historyId),
    sha: sha(3),
    state: 'rolled_back',
    endedAt: ago(3 * DAY, now),
    requesterLabel: USERS.admin.displayName,
    requesterUserId: admin.id,
    refusal: {
      code: 'health_failed',
      gate: 'none',
      message: '/health answered 503 for 30s after the swap.',
      fix: 'Read the server logs for the failed release; the previous images are running again.',
    },
    steps: [
      ...happySteps('bindery', sha(3).slice(0, 7)).slice(0, 4),
      { name: 'check', argv: ['check'], exitCode: 1, output: '/health: 503 Service Unavailable (30 attempts)' },
      { name: 'rollback', argv: ['docker', 'compose', '-p', 'bindery', 'up', '-d', '--no-deps'], exitCode: 0, output: 'Recreated with previous digests' },
    ],
  });
  const refused = await createDeploy(db, {
    ...base(history, historyId),
    sha: sha(5),
    state: 'refused',
    endedAt: ago(2 * DAY, now),
    requesterLabel: 'claude: matdemers1/bindery fix search',
    requesterTokenId: token.id,
    requesterRepo: 'matdemers1/bindery',
    requesterBranch: 'fix/search',
    refusal: {
      code: 'ci_not_green',
      gate: 'G5',
      message: `The image workflow for ${sha(5).slice(0, 7)} has not succeeded (it is failure).`,
      fix: 'Wait for the image workflow to succeed for this SHA.',
    },
  });
  const r4 = await createDeploy(db, {
    ...base(history, historyId),
    sha: sha(4),
    state: 'succeeded',
    endedAt: ago(1 * DAY, now),
    requesterLabel: USERS.admin.displayName,
    requesterUserId: admin.id,
    schemaRevision: '20260920_signal',
    steps: happySteps('bindery', sha(4).slice(0, 7)),
  });
  await db.backupArtifact.createMany({
    data: [
      { appId: historyId, targetId: r1.targetId, path: '/srv/backups/bindery/2026-09-15.dump', size: 48_234_112n, createdAt: ago(10 * DAY + 3 * MINUTE, now) },
      { appId: historyId, targetId: r2.targetId, path: '/srv/backups/bindery/2026-09-20.dump', size: 51_002_880n, createdAt: ago(5 * DAY + 3 * MINUTE, now) },
      { appId: historyId, targetId: r4.targetId, path: '/srv/backups/bindery/2026-09-24.dump', size: 53_771_264n, createdAt: ago(DAY + 3 * MINUTE, now) },
    ],
  });
  // A dry run in the history, as the dry-run sheet leaves one.
  await createDeploy(db, {
    ...base(history, historyId),
    sha: sha(6),
    state: 'succeeded',
    dryRun: true,
    images: false,
    endedAt: ago(6 * HOUR, now),
    requesterLabel: USERS.admin.displayName,
    requesterUserId: admin.id,
  });

  // A schedule to come, and one that fired.
  const scheduled = await createDeploy(db, {
    ...base(history, historyId),
    sha: sha(7),
    state: 'queued',
    endedAt: null,
    requesterLabel: USERS.admin.displayName,
    requesterUserId: admin.id,
  });
  await db.schedule.create({ data: { deployId: scheduled.deployId, fireAt: ahead(2 * DAY, now), byUserId: admin.id } });
  await db.schedule.create({ data: { deployId: r4.deployId, fireAt: ago(DAY + 4 * MINUTE, now), firedAt: ago(DAY + 4 * MINUTE, now), byUserId: admin.id } });

  // foreman: a recorded release, then someone pulled by hand — drift, open; and one resolved earlier.
  await createDeploy(db, {
    ...base(drifted, driftedId),
    sha: sha(21),
    state: 'succeeded',
    endedAt: ago(4 * DAY, now),
    requesterLabel: USERS.admin.displayName,
    requesterUserId: admin.id,
    steps: happySteps('foreman', sha(21).slice(0, 7)),
  });
  await db.driftEvent.create({
    data: {
      appId: driftedId,
      observed: { server: digest('foreman/server@hand-pulled') },
      recorded: { server: digest(`foreman/server@${sha(21)}`) },
      detectedAt: ago(3 * HOUR, now),
    },
  });
  await db.driftEvent.create({
    data: {
      appId: driftedId,
      observed: { server: digest('foreman/server@hotfix') },
      recorded: { server: digest(`foreman/server@${sha(20)}`) },
      detectedAt: ago(9 * DAY, now),
      resolvedAt: ago(9 * DAY - HOUR, now),
      resolution: 'adopt_live',
      reason: 'Hotfix pulled by hand during the outage; it is the right image.',
      resolvedByUserId: admin.id,
    },
  });

  // sceptrefall: a release, frozen with a reason until a set time.
  await createDeploy(db, {
    ...base(frozen, frozenId),
    sha: sha(31),
    state: 'succeeded',
    endedAt: ago(6 * DAY, now),
    requesterLabel: USERS.admin.displayName,
    requesterUserId: admin.id,
  });
  await db.freeze.create({
    data: { appId: frozenId, reason: 'Season finale this weekend: no deploys.', byUserId: admin.id, from: ago(HOUR, now), until: ahead(3 * DAY, now) },
  });

  // d3auth: a release whose Foreman post is stuck, and a token's deploy waiting on approval.
  const authRelease = await createDeploy(db, {
    ...base(approval, approvalId),
    sha: sha(41),
    state: 'succeeded',
    endedAt: ago(3 * HOUR, now),
    requesterLabel: USERS.admin.displayName,
    requesterUserId: admin.id,
    steps: happySteps('d3auth', sha(41).slice(0, 7)),
  });
  const held = await createDeploy(db, {
    ...base(approval, approvalId),
    sha: sha(42),
    state: 'awaiting_approval',
    endedAt: null,
    requesterLabel: 'claude: matdemers1/d3-auth passkey fix',
    requesterTokenId: token.id,
    requesterRepo: 'matdemers1/d3-auth',
    requesterBranch: 'main',
  });
  await db.approval.create({ data: { deployId: held.deployId, requestedAt: ago(10 * MINUTE, now), expiresAt: ahead(50 * MINUTE, now) } });

  // www (the canary of "sites"): a release, then a deploy in progress, soaking.
  await createDeploy(db, {
    ...base(canary, canaryId),
    sha: sha(51),
    state: 'succeeded',
    endedAt: ago(2 * DAY, now),
    requesterLabel: USERS.admin.displayName,
    requesterUserId: admin.id,
  });
  const inProgress = await createDeploy(db, {
    ...base(canary, canaryId),
    sha: sha(52),
    state: 'soaking',
    endedAt: null,
    currentStep: 'soak',
    requesterLabel: 'claude: matdemers1/d3cloud-www hero copy',
    requesterTokenId: token.id,
    requesterRepo: 'matdemers1/d3cloud-www',
    requesterBranch: 'main',
    steps: [...happySteps('www', sha(52).slice(0, 7)).slice(0, 5), { name: 'soak', argv: ['soak'], exitCode: null }],
  });
  await createDeploy(db, {
    ...base(groupMember, memberId),
    sha: sha(61),
    state: 'succeeded',
    endedAt: ago(2 * DAY, now),
    requesterLabel: USERS.admin.displayName,
    requesterUserId: admin.id,
  });

  // Foreman outbox: bindery's latest post delivered; d3auth's stuck for over an hour.
  await db.outbox.create({
    data: {
      targetId: r4.targetId,
      idempotencyKey: `${r4.targetId}:server`,
      payload: { project: 'BND', environment: 'production', image: `ghcr.io/matdemers1/bindery/server:sha-${sha(4)}`, imageSha: digest('x'), deployedAt: ago(DAY, now).toISOString(), note: 'shipyard' },
      attempts: 1,
      deliveredAt: ago(DAY - MINUTE, now),
      createdAt: ago(DAY, now),
    },
  });
  await db.outbox.create({
    data: {
      targetId: authRelease.targetId,
      idempotencyKey: `${authRelease.targetId}:server`,
      payload: { project: 'AUTH', environment: 'production', image: `ghcr.io/matdemers1/d3auth/server:sha-${sha(41)}`, imageSha: digest('y'), deployedAt: ago(3 * HOUR, now).toISOString(), note: 'shipyard' },
      attempts: 6,
      // Far enough out that the outbox worker does not pick it up during the run.
      nextAt: ahead(DAY, now),
      lastError: 'Foreman answered 502 Bad Gateway',
      createdAt: ago(3 * HOUR, now),
    },
  });

  // Pending invites: one live (its link is the acceptance screen), one expired.
  await db.invite.create({
    data: {
      email: 'newcomer@shipyard.test',
      role: 'deployer',
      tokenHash: createHash('sha256').update(INVITE_TOKEN).digest('hex'),
      invitedById: admin.id,
      createdAt: ago(HOUR, now),
      expiresAt: ahead(6 * DAY, now),
    },
  });
  await db.invite.create({
    data: {
      email: 'late@shipyard.test',
      role: 'viewer',
      tokenHash: createHash('sha256').update('console-e2e expired invite').digest('hex'),
      invitedById: admin.id,
      createdAt: ago(9 * DAY, now),
      expiresAt: ago(2 * DAY, now),
    },
  });

  // Shipyard's own nightly backup and drill (the System screen reads these audit events).
  await db.auditEvent.createMany({
    data: [
      {
        actorType: 'system',
        actorLabel: 'backup',
        action: 'system.backup',
        entityType: 'system',
        at: ago(5 * HOUR, now),
        after: { ok: true, file: 'shipyard-2026-09-25T03-00-00Z.dump', bytes: 1_482_752, durationMs: 2_310 },
      },
      {
        actorType: 'system',
        actorLabel: 'backup',
        action: 'system.drill',
        entityType: 'system',
        at: ago(5 * HOUR - 2 * MINUTE, now),
        after: { ok: true, file: 'shipyard-2026-09-25T03-00-00Z.dump', durationMs: 8_904 },
      },
    ],
  });

  return {
    users,
    agentId: agent.id,
    apps: {
      history: history.name,
      neverDeployed: neverDeployed.name,
      drifted: drifted.name,
      frozen: frozen.name,
      approval: approval.name,
      canary: canary.name,
      groupMember: groupMember.name,
    },
    group: 'sites',
    deploys: {
      succeeded: r4.deployId,
      rolledBack: rolledBack.deployId,
      refused: refused.deployId,
      inProgress: inProgress.deployId,
      awaitingApproval: held.deployId,
    },
    inviteToken: INVITE_TOKEN,
  };
}

// ── The fixture file ──────────────────────────────────────────────────────

export function writeFixture(fixture: Fixture): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(FIXTURE_FILE, `${JSON.stringify(fixture, null, 2)}\n`);
}

/** The IDs global setup seeded. Throws when setup has not run. */
export function fixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE_FILE, 'utf8')) as Fixture;
}
