import {
  AppName,
  Sha40,
  parseManifestYaml,
  refusal,
  type BuildJob,
  type BuildProgress,
  type BuildResult,
  type BuildStage,
  type BuildState,
  type BuildTrigger,
  type Refusal,
} from '@shipyard/schema';
import { retiredRefusal } from '../apps/drift.js';
import type { Actor, AuditEventInput } from '../audit.js';
import type { Db, Prisma } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { isRefusal, isUniqueViolation } from '../deploys/service.js';

/**
 * The build queue (SHP-T-7.4): enqueue, strict FIFO dispatch one build at a time, progress and
 * results from the agent, cancel and rebuild. Used by the REST routes here and, later, by the
 * webhook (SHP-T-7.5), the agent poll (SHP-T-7.9), MCP (SHP-T-7.13) and auto-deploy (SHP-T-7.14).
 *
 * - Arrival order is `build.queue_seq` (SHP-REQ-137); `claimNextBuild` hands out the lowest queued
 *   one, and only while nothing is running (one at a time, SHP-REQ-129).
 * - At most one open build per (app, sha) is the partial unique index `build_one_open_per_app_sha`:
 *   a duplicate enqueue returns the open build instead of making a second one.
 * - Cancel on a queued build ends it at once; on a running build it sets `cancelRequestedAt`, and
 *   the agent learns it from its next progress report and stops at that stage boundary (SHP-REQ-143).
 * - Every request, rebuild and cancel writes an audit event (SHP-REQ-148).
 */

export { isRefusal } from '../deploys/service.js';

/** Builds that can still change. */
export const OPEN_BUILD_STATES: readonly BuildState[] = ['queued', 'running'];
/** Builds that are over. */
export const TERMINAL_BUILD_STATES: readonly BuildState[] = ['succeeded', 'failed', 'cancelled', 'refused'];

/** The order the agent runs stages in; stage lists are shown in this order. */
const STAGE_ORDER: readonly BuildStage[] = ['fetch', 'test', 'integration', 'build', 'push'];

/**
 * Serialises `claimNextBuild` across every server connection: "nothing is running, so take the
 * oldest queued" must be one decision, or two claimers could each start a different build.
 */
const CLAIM_LOCK_KEY = 7_004_137;

export function isTerminalBuild(state: BuildState): boolean {
  return TERMINAL_BUILD_STATES.includes(state);
}

/** Writes one audit event. Routes pass `req.audit`; background callers get `directAudit`. */
export type AuditWriter = (event: AuditEventInput) => Promise<void>;

/** Who asked for a build: the label is shown everywhere; the IDs link the row to its requester. */
export interface BuildRequester {
  label: string;
  userId?: string;
  tokenId?: string;
}

/** Who acts, and how to record it. `audit` defaults to a direct write attributed to `actor`. */
export interface BuildCaller {
  actor: Actor;
  audit?: AuditWriter;
}

/** The actor a requester stands for when no request carries one (webhook, reconcile). */
export function actorForRequester(requester: BuildRequester): Actor {
  if (requester.userId !== undefined) return { type: 'user', id: requester.userId, label: requester.label };
  if (requester.tokenId !== undefined) return { type: 'token', id: requester.tokenId, label: requester.label };
  return { type: 'system', label: requester.label };
}

/** An audit writer outside a request: straight to `audit_event`, attributed to `actor`. */
export function directAudit(db: Db, actor: Actor): AuditWriter {
  return async (event) => {
    const who = event.actor ?? actor;
    await db.auditEvent.create({
      data: {
        actorType: who.type,
        ...(who.type === 'user' && who.id !== undefined ? { actorUserId: who.id } : {}),
        ...(who.type === 'token' && who.id !== undefined ? { actorTokenId: who.id } : {}),
        ...(who.type === 'agent' && who.id !== undefined ? { actorAgentId: who.id } : {}),
        actorLabel: who.label,
        action: event.action,
        entityType: event.entityType,
        ...(event.entityId !== undefined ? { entityId: event.entityId } : {}),
        ...(event.before !== undefined ? { before: event.before as object } : {}),
        ...(event.after !== undefined ? { after: event.after as object } : {}),
      },
    });
  };
}

function writerFor(db: Db, caller: BuildCaller): AuditWriter {
  return caller.audit ?? directAudit(db, caller.actor);
}

// ─── Views ──────────────────────────────────────────────────────────────────

export interface BuildStageView {
  stage: BuildStage;
  state: 'running' | 'succeeded' | 'failed' | 'skipped';
  startedAt: string;
  endedAt: string | null;
}

export interface BuildSummary {
  buildId: string;
  app: string;
  sha: string;
  state: BuildState;
  trigger: BuildTrigger;
  /** Arrival order, as a decimal string (it is a bigint). */
  queueSeq: string;
  requesterLabel: string;
  rebuildOfId: string | null;
  failedStage: BuildStage | null;
  cancelRequestedAt: string | null;
  dispatchedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export interface BuildDetail extends BuildSummary {
  digests: Record<string, string>;
  refusal: Refusal | null;
  stages: BuildStageView[];
  /** The one auto-deploy this build requested, if any (SHP-REQ-138, SHP-REQ-150). */
  autoDeployId: string | null;
  /** Why an auto-deploy request was refused, if it was (SHP-REQ-139). */
  autoDeployRefusal: Refusal | null;
}

export interface BuildLogView {
  /** Monotonic; a stream resumes after the last one it saw (`Last-Event-ID`). */
  id: string;
  stage: BuildStage;
  chunk: string;
  at: string;
}

export interface BuildPage {
  items: BuildSummary[];
  /** Pass as `cursor` for the next (older) page; null on the last page. */
  nextCursor: string | null;
}

const SUMMARY_SELECT = {
  id: true,
  sha: true,
  state: true,
  trigger: true,
  queueSeq: true,
  requesterLabel: true,
  rebuildOfId: true,
  failedStage: true,
  cancelRequestedAt: true,
  dispatchedAt: true,
  startedAt: true,
  endedAt: true,
  createdAt: true,
  app: { select: { name: true } },
} satisfies Prisma.BuildSelect;

type SummaryRow = Prisma.BuildGetPayload<{ select: typeof SUMMARY_SELECT }>;

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

function toSummary(row: SummaryRow): BuildSummary {
  return {
    buildId: row.id,
    app: row.app.name,
    sha: row.sha,
    state: row.state,
    trigger: row.trigger,
    queueSeq: row.queueSeq.toString(),
    requesterLabel: row.requesterLabel,
    rebuildOfId: row.rebuildOfId,
    failedStage: row.failedStage,
    cancelRequestedAt: iso(row.cancelRequestedAt),
    dispatchedAt: iso(row.dispatchedAt),
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

function digestsOf(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** One build with its stages, or null. */
export async function getBuild(db: Db, buildId: string): Promise<BuildDetail | null> {
  const row = await db.build.findUnique({
    where: { id: buildId },
    select: {
      ...SUMMARY_SELECT,
      digests: true,
      refusal: true,
      autoDeployId: true,
      autoDeployRefusal: true,
      stages: { select: { stage: true, state: true, startedAt: true, endedAt: true } },
    },
  });
  if (row === null) return null;
  const stages = [...row.stages]
    .sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage))
    .map((s) => ({ stage: s.stage, state: s.state, startedAt: s.startedAt.toISOString(), endedAt: iso(s.endedAt) }));
  return {
    ...toSummary(row),
    digests: digestsOf(row.digests),
    refusal: isRefusal(row.refusal) ? row.refusal : null,
    autoDeployId: row.autoDeployId,
    autoDeployRefusal: isRefusal(row.autoDeployRefusal) ? row.autoDeployRefusal : null,
    stages,
  };
}

export interface ListBuildsOptions {
  limit: number;
  /** One app only. */
  app?: string;
  /** Restrict to these apps (a token's scope). */
  apps?: ReadonlySet<string>;
  /** A `nextCursor` from an earlier page. */
  cursor?: string;
}

/** Newest first by arrival. */
export async function listBuilds(db: Db, options: ListBuildsOptions): Promise<BuildPage> {
  const nameFilter: Prisma.StringFilter[] = [];
  if (options.app !== undefined) nameFilter.push({ equals: options.app });
  if (options.apps !== undefined) nameFilter.push({ in: [...options.apps] });
  const cursor = options.cursor !== undefined && /^\d{1,19}$/.test(options.cursor) ? BigInt(options.cursor) : undefined;
  const rows = await db.build.findMany({
    where: {
      ...(nameFilter.length > 0 ? { AND: nameFilter.map((f) => ({ app: { name: f } })) } : {}),
      ...(cursor !== undefined ? { queueSeq: { lt: cursor } } : {}),
    },
    select: SUMMARY_SELECT,
    orderBy: { queueSeq: 'desc' },
    take: options.limit + 1,
  });
  const page = rows.slice(0, options.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toSummary),
    nextCursor: rows.length > options.limit && last !== undefined ? last.queueSeq.toString() : null,
  };
}

/** A build's log chunks in order, after `afterId` when given. */
export async function getBuildLogs(db: Db, buildId: string, options: { afterId?: bigint } = {}): Promise<BuildLogView[]> {
  const rows = await db.buildLog.findMany({
    where: { buildId, ...(options.afterId !== undefined ? { id: { gt: options.afterId } } : {}) },
    orderBy: { id: 'asc' },
    select: { id: true, stage: true, chunk: true, at: true },
  });
  return rows.map((r) => ({ id: r.id.toString(), stage: r.stage, chunk: r.chunk, at: r.at.toISOString() }));
}

// ─── Enqueue ────────────────────────────────────────────────────────────────

export interface EnqueueBuildInput {
  app: string;
  sha: string;
  trigger: BuildTrigger;
  requester: BuildRequester;
  rebuildOfId?: string;
}

export interface EnqueuedBuild {
  buildId: string;
  state: BuildState;
  /** False when an open build of this app and SHA already existed and is returned instead. */
  created: boolean;
}

type InsertOutcome = { kind: 'created'; buildId: string } | { kind: 'open'; buildId: string; state: BuildState } | Refusal;

/** Validates and inserts; on a duplicate open build, names it. Writes no audit. */
async function insertBuild(deps: ServiceDeps, input: EnqueueBuildInput): Promise<{ appName: string; outcome: InsertOutcome }> {
  const { db } = deps;
  const name = AppName.safeParse(input.app);
  if (!name.success) {
    return { appName: input.app, outcome: refusal('invalid_request', 'app must be an app name.') };
  }
  const sha = Sha40.safeParse(input.sha);
  if (!sha.success) {
    return {
      appName: name.data,
      outcome: refusal('invalid_request', 'sha must be a full 40-character lowercase commit SHA.', 'Send the full commit SHA, not a short one.'),
    };
  }
  const app = await db.app.findUnique({ where: { name: name.data }, select: { id: true, name: true, manifestYaml: true, retiredAt: true } });
  if (app === null) {
    return { appName: name.data, outcome: refusal('unknown_app', `No app named ${name.data} has been reported by the agent.`) };
  }
  if (app.retiredAt !== null) return { appName: app.name, outcome: retiredRefusal(app.name, app.retiredAt) };
  let source: string;
  try {
    source = parseManifestYaml(app.manifestYaml).build?.source ?? 'github';
  } catch {
    return {
      appName: app.name,
      outcome: refusal('manifest_invalid', `The manifest for ${app.name} does not parse, so it cannot be built.`),
    };
  }
  if (source !== 'shipyard') {
    return {
      appName: app.name,
      outcome: refusal(
        'invalid_request',
        `${app.name} is not built by Shipyard: its images come from GitHub CI.`,
        `Set build.source: shipyard (with build.releaseTargets) in ${app.name}'s manifest on the host to have Shipyard build it.`,
      ),
    };
  }

  const data: Prisma.BuildUncheckedCreateInput = {
    appId: app.id,
    sha: sha.data,
    trigger: input.trigger,
    requesterLabel: input.requester.label,
    ...(input.requester.userId !== undefined ? { requesterUserId: input.requester.userId } : {}),
    ...(input.requester.tokenId !== undefined ? { requesterTokenId: input.requester.tokenId } : {}),
    ...(input.rebuildOfId !== undefined ? { rebuildOfId: input.rebuildOfId } : {}),
  };
  // Twice at most: if the open build ended between the failed insert and the lookup, insert again.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const row = await db.build.create({ data, select: { id: true } });
      return { appName: app.name, outcome: { kind: 'created', buildId: row.id } };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const open = await db.build.findFirst({
        where: { appId: app.id, sha: sha.data, state: { in: [...OPEN_BUILD_STATES] } },
        select: { id: true, state: true },
      });
      if (open !== null) return { appName: app.name, outcome: { kind: 'open', buildId: open.id, state: open.state } };
    }
  }
  return { appName: app.name, outcome: refusal('conflict', `A build of ${sha.data.slice(0, 7)} for ${app.name} is changing; retry.`) };
}

function publishQueued(deps: ServiceDeps, appName: string, buildId: string): void {
  deps.bus.publish(`build:${buildId}`);
  deps.bus.publish(`app:${appName}`);
  deps.bus.publish('work');
}

/**
 * Queues a build of `sha` for `app` (SHP-REQ-137). Idempotent: when an open (queued or running)
 * build of the same app and SHA exists, it is returned with `created: false`. Audited as
 * `build.request` either way (SHP-REQ-148).
 */
export async function enqueueBuild(
  deps: ServiceDeps,
  input: EnqueueBuildInput,
  caller: BuildCaller = { actor: actorForRequester(input.requester) },
): Promise<EnqueuedBuild | Refusal> {
  const { appName, outcome } = await insertBuild(deps, input);
  if (isRefusal(outcome)) return outcome;
  const created = outcome.kind === 'created';
  const state: BuildState = outcome.kind === 'created' ? 'queued' : outcome.state;
  await writerFor(deps.db, caller)({
    action: 'build.request',
    entityType: 'build',
    entityId: outcome.buildId,
    after: { app: appName, sha: input.sha, trigger: input.trigger, requester: input.requester.label, created, state },
  });
  if (created) {
    deps.logger.info({ buildId: outcome.buildId, app: appName, sha: input.sha, trigger: input.trigger }, 'build queued');
    publishQueued(deps, appName, outcome.buildId);
  }
  return { buildId: outcome.buildId, state, created };
}

/**
 * Queues a new build of the same app and SHA as `buildId`, trigger `rebuild` (SHP-REQ-143).
 * Refused with `conflict` when an open build of that SHA exists: the deployer pressed Rebuild,
 * and silently pointing at a different build would hide that nothing new was queued.
 */
export async function rebuild(
  deps: ServiceDeps,
  buildId: string,
  requester: BuildRequester,
  caller: BuildCaller = { actor: actorForRequester(requester) },
): Promise<EnqueuedBuild | Refusal> {
  const source = await deps.db.build.findUnique({ where: { id: buildId }, select: { id: true, sha: true, app: { select: { name: true } } } });
  if (source === null) return refusal('not_found', 'No such build.', 'List builds and use one of their IDs.');
  const { appName, outcome } = await insertBuild(deps, {
    app: source.app.name,
    sha: source.sha,
    trigger: 'rebuild',
    requester,
    rebuildOfId: source.id,
  });
  if (isRefusal(outcome)) return outcome;
  if (outcome.kind === 'open') {
    return refusal(
      'conflict',
      `A build of ${source.sha.slice(0, 7)} for ${appName} is already ${outcome.state}.`,
      `Wait for build ${outcome.buildId} to finish, or cancel it, then rebuild.`,
    );
  }
  await writerFor(deps.db, caller)({
    action: 'build.rebuild',
    entityType: 'build',
    entityId: outcome.buildId,
    after: { app: appName, sha: source.sha, rebuildOfId: source.id, requester: requester.label },
  });
  deps.logger.info({ buildId: outcome.buildId, rebuildOfId: source.id, app: appName }, 'rebuild queued');
  publishQueued(deps, appName, outcome.buildId);
  return { buildId: outcome.buildId, state: 'queued', created: true };
}

// ─── Cancel ─────────────────────────────────────────────────────────────────

export interface CancelOutcome {
  buildId: string;
  state: BuildState;
  /** True when the build was running: it stops at its next stage boundary. */
  cancelRequested: boolean;
}

/**
 * Cancels a build (SHP-REQ-143): a queued build ends `cancelled` at once; a running one gets
 * `cancelRequestedAt` and stops at its next stage boundary; a finished one is refused `conflict`.
 * Audited as `build.cancel`.
 */
export async function requestCancel(deps: ServiceDeps, buildId: string, caller: BuildCaller): Promise<CancelOutcome | Refusal> {
  const { db } = deps;
  const row = await db.build.findUnique({ where: { id: buildId }, select: { id: true, state: true, app: { select: { name: true } } } });
  if (row === null) return refusal('not_found', 'No such build.', 'List builds and use one of their IDs.');
  const now = new Date();

  let result: CancelOutcome;
  const queued = await db.build.updateMany({
    where: { id: buildId, state: 'queued' },
    data: { state: 'cancelled', cancelRequestedAt: now, endedAt: now },
  });
  if (queued.count === 1) {
    result = { buildId, state: 'cancelled', cancelRequested: false };
  } else {
    // Not queued (any more): a running build keeps its first cancel time.
    await db.build.updateMany({ where: { id: buildId, state: 'running', cancelRequestedAt: null }, data: { cancelRequestedAt: now } });
    const current = await db.build.findUniqueOrThrow({ where: { id: buildId }, select: { state: true } });
    if (current.state !== 'running') {
      return refusal('conflict', `Build ${buildId} has already ended (${current.state}).`, 'Nothing to cancel; rebuild it instead if you want another run.');
    }
    result = { buildId, state: 'running', cancelRequested: true };
  }

  await writerFor(db, caller)({
    action: 'build.cancel',
    entityType: 'build',
    entityId: buildId,
    before: { state: row.state },
    after: { state: result.state, cancelRequested: result.cancelRequested },
  });
  deps.logger.info({ buildId, app: row.app.name, state: result.state }, 'build cancel requested');
  deps.bus.publish(`build:${buildId}`);
  deps.bus.publish(`app:${row.app.name}`);
  if (result.state === 'cancelled') deps.bus.publish('work');
  return result;
}

// ─── Dispatch and reports (the agent's side) ────────────────────────────────

/**
 * Hands out the oldest queued build — only when no build is running (SHP-REQ-129, SHP-REQ-137) —
 * and marks it running. Null when something is running or nothing is queued. Safe to call from
 * several requests at once: a transaction-scoped advisory lock makes check-and-take one step.
 */
export async function claimNextBuild(deps: ServiceDeps): Promise<BuildJob | null> {
  const job = await deps.db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${String(CLAIM_LOCK_KEY)})`);
    const running = await tx.build.count({ where: { state: 'running' } });
    if (running > 0) return null;
    const next = await tx.build.findFirst({
      where: { state: 'queued' },
      orderBy: { queueSeq: 'asc' },
      select: { id: true, sha: true, requesterLabel: true, app: { select: { name: true } } },
    });
    if (next === null) return null;
    const now = new Date();
    await tx.build.update({ where: { id: next.id }, data: { state: 'running', dispatchedAt: now, startedAt: now } });
    return { buildId: next.id, app: next.app.name, sha: next.sha, requesterLabel: next.requesterLabel } satisfies BuildJob;
  });
  if (job !== null) {
    deps.logger.info({ buildId: job.buildId, app: job.app, sha: job.sha }, 'build dispatched');
    deps.bus.publish(`build:${job.buildId}`);
    deps.bus.publish(`app:${job.app}`);
  }
  return job;
}

export interface ProgressOutcome {
  /** False when the build is unknown or no longer running; nothing was recorded. */
  accepted: boolean;
  /** True when the agent should stop at this stage boundary (SHP-REQ-143). */
  cancel: boolean;
}

/**
 * Records a stage moving (and its already-redacted log chunk) for a running build, and tells the
 * agent whether a cancel was requested. Progress for a finished or unknown build is ignored.
 */
export async function recordBuildProgress(deps: ServiceDeps, progress: BuildProgress): Promise<ProgressOutcome> {
  const { db } = deps;
  const build = await db.build.findUnique({
    where: { id: progress.buildId },
    select: { state: true, cancelRequestedAt: true, sha: true, app: { select: { name: true } } },
  });
  if (build === null) return { accepted: false, cancel: true };
  if (build.state !== 'running') return { accepted: false, cancel: isTerminalBuild(build.state) };

  const at = new Date(progress.at);
  const endedAt = progress.state === 'running' ? null : at;
  await db.$transaction([
    db.buildStageRun.upsert({
      where: { buildId_stage: { buildId: progress.buildId, stage: progress.stage } },
      create: { buildId: progress.buildId, stage: progress.stage, state: progress.state, startedAt: at, endedAt },
      update: { state: progress.state, endedAt },
    }),
    ...(progress.log !== undefined && progress.log !== ''
      ? [db.buildLog.create({ data: { buildId: progress.buildId, stage: progress.stage, chunk: progress.log, at } })]
      : []),
  ]);
  deps.bus.publish(`build:${progress.buildId}`);
  if (progress.state !== 'running') {
    await runBuildHooks(deps, 'onStageEnd', {
      buildId: progress.buildId,
      app: build.app.name,
      sha: build.sha,
      stage: progress.stage,
      state: progress.state,
    });
  }
  return { accepted: true, cancel: build.cancelRequestedAt !== null };
}

export interface ResultOutcome {
  /** False when the build was already over (a replayed result) or unknown: nothing changed. */
  accepted: boolean;
  state: BuildState | null;
}

/**
 * Records a build's terminal result. Idempotent: a result for a build that has already ended
 * changes nothing. Publishes `work`, so the next queued build can be dispatched.
 */
export async function recordBuildResult(deps: ServiceDeps, result: BuildResult): Promise<ResultOutcome> {
  const { db } = deps;
  const row = await db.build.findUnique({
    where: { id: result.buildId },
    select: { state: true, sha: true, app: { select: { name: true } } },
  });
  if (row === null) return { accepted: false, state: null };
  // Only a claimed (running) build can end by a result: a queued one was never dispatched, and a
  // queued build that is cancelled ends through requestCancel, not here.
  const updated = await db.build.updateMany({
    where: { id: result.buildId, state: 'running' },
    data: {
      state: result.state,
      digests: result.digests,
      ...(result.refusal !== undefined ? { refusal: result.refusal } : {}),
      ...(result.failedStage !== undefined ? { failedStage: result.failedStage } : {}),
      endedAt: new Date(),
    },
  });
  if (updated.count === 0) return { accepted: false, state: row.state };
  deps.logger.info({ buildId: result.buildId, app: row.app.name, state: result.state }, 'build ended');
  deps.bus.publish(`build:${result.buildId}`);
  deps.bus.publish(`app:${row.app.name}`);
    deps.bus.publish('work');
  await runBuildHooks(deps, 'onResult', {
    buildId: result.buildId,
    app: row.app.name,
    sha: row.sha,
    state: result.state,
    digests: result.digests,
    ...(result.refusal !== undefined ? { refusal: result.refusal } : {}),
    ...(result.failedStage !== undefined ? { failedStage: result.failedStage } : {}),
  });
  return { accepted: true, state: result.state };
}

// ─── Hooks (SHP-P-7) ─────────────────────────────────────────────────────────
//
// What happens after a stage or a build ends — commit statuses and Foreman (SHP-T-7.15), the
// auto-deploy (SHP-T-7.14) — registers here instead of editing this file. Keyed by the Bus, which
// is one per app instance, so two apps in one test process never see each other's hooks. A hook
// runs after the row is committed; it is awaited, and its failure is logged, never thrown into the
// agent's report.

export interface BuildStageEndEvent {
  buildId: string;
  app: string;
  sha: string;
  stage: BuildProgress['stage'];
  state: Exclude<BuildProgress['state'], 'running'>;
}

export interface BuildResultEvent {
  buildId: string;
  app: string;
  sha: string;
  state: BuildResult['state'];
  digests: BuildResult['digests'];
  refusal?: NonNullable<BuildResult['refusal']>;
  failedStage?: NonNullable<BuildResult['failedStage']>;
}

export interface BuildHooks {
  onStageEnd?: (deps: ServiceDeps, event: BuildStageEndEvent) => Promise<void>;
  onResult?: (deps: ServiceDeps, event: BuildResultEvent) => Promise<void>;
}

const hooksByBus = new WeakMap<ServiceDeps['bus'], BuildHooks[]>();

/** Registers hooks for every build recorded through this app's Bus. Returns an unregister. */
export function addBuildHooks(bus: ServiceDeps['bus'], hooks: BuildHooks): () => void {
  const list = hooksByBus.get(bus) ?? [];
  list.push(hooks);
  hooksByBus.set(bus, list);
  return () => {
    const current = hooksByBus.get(bus) ?? [];
    hooksByBus.set(bus, current.filter((h) => h !== hooks));
  };
}

async function runBuildHooks<K extends keyof BuildHooks>(
  deps: ServiceDeps,
  kind: K,
  event: K extends 'onStageEnd' ? BuildStageEndEvent : BuildResultEvent,
): Promise<void> {
  for (const hooks of hooksByBus.get(deps.bus) ?? []) {
    const hook = hooks[kind] as ((d: ServiceDeps, e: typeof event) => Promise<void>) | undefined;
    if (hook === undefined) continue;
    try {
      await hook(deps, event);
    } catch (err) {
      deps.logger.error({ err, buildId: event.buildId, hook: kind }, 'build hook failed');
    }
  }
}
