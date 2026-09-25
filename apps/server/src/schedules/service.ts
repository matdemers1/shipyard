import {
  Refusal as RefusalSchema,
  SCHEDULE_MAX_AHEAD_MS,
  refusal,
  type Refusal,
  type ScheduleApprovalState,
  type ScheduleEntry,
  type ScheduleList,
  type ScheduleRequest,
} from '@shipyard/schema';
import type { Actor } from '../audit.js';
import type { Db, Prisma } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { assertDeployable } from '../apps/drift.js';
import { assertNotFrozen } from '../freeze/service.js';
import { callerCanActOn, isUniqueViolation, lockRefusal, type DeployCaller } from '../deploys/service.js';

/**
 * Scheduled deploys (SHP-T-5.4, SHP-REQ-080, SHP-REQ-081, SHP-D-039, SHP-D-051).
 *
 * A schedule is a Deploy (kind `deploy`, one specific SHA) plus a `schedule` row. Until it fires
 * its target waits in **`queued` on a non-dry-run deploy** — a state that is not in the lock's
 * partial unique index (so it holds nothing) and that `claimTarget` never hands out (it takes
 * `locked`, or `queued` only on a dry run). Nothing about a scheduled-but-unfired deploy is
 * visible to the agent.
 *
 * Approval is captured at scheduling (SHP-D-051). For an app whose manifest says
 * `approval: required`, a console user scheduling it *is* the approval — an `approval` row is
 * written already approved, by them. A token scheduling one writes the row undecided, with
 * `expiresAt` = the fire time; a deployer approves it from the console before then, or it is
 * refused when it fires. The hourly approval expiry skips scheduled deploys: the runner decides.
 *
 * At fire time (`fireDueSchedules`) the runner takes each due schedule by a conditional update on
 * `fired_at IS NULL`, committed in the same transaction as the target's outcome, so two server
 * processes never both fire one and a crash never strands one half-fired. It re-runs the server's
 * checks — approval captured, the agent has reported the app, no open drift (G3), not frozen (G2),
 * the lock (G4, by moving the target to `locked` and letting the unique index decide) — and on
 * success wakes the agent's poll. The agent then re-runs every forward gate (G5–G10) exactly as
 * for any deploy: a schedule overtaken by a newer live release is refused by its G7
 * (`not_ahead_of_live`), recorded on the target like any refusal. A server-side refusal is recorded
 * on the target the same way; either way the audit trail gets `schedule.refused`.
 */

/** How often the runner looks for due schedules. */
export const SCHEDULER_INTERVAL_MS = 15_000;

/** How far back the runner looks for agent refusals of fired schedules still to log. */
const RECONCILE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The runner's audit actor. */
export const SCHEDULER_ACTOR: Actor = { type: 'system', label: 'scheduler' };

/** A stored refusal, if it still parses as one. */
function storedRefusal(value: Prisma.JsonValue | null): Refusal | null {
  const parsed = RefusalSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_SUCH_SCHEDULE = refusal('not_found', 'No such schedule.', 'List the schedules and use one of their IDs.');

const ENTRY_SELECT = {
  id: true,
  deployId: true,
  fireAt: true,
  firedAt: true,
  cancelledAt: true,
  by: { select: { email: true } },
  deploy: {
    select: {
      requestedSha: true,
      requesterLabel: true,
      requesterRepo: true,
      requesterBranch: true,
      requesterTokenId: true,
      createdAt: true,
      requesterToken: { select: { label: true } },
      approval: { select: { approvedAt: true, deniedAt: true, expiredAt: true, decidedBy: { select: { email: true } } } },
      targets: { select: { state: true, refusal: true, app: { select: { name: true } } }, take: 1, orderBy: { createdAt: 'asc' } },
    },
  },
} satisfies Prisma.ScheduleSelect;

type EntryRow = Prisma.ScheduleGetPayload<{ select: typeof ENTRY_SELECT }>;

function approvalOf(row: EntryRow): ScheduleEntry['approval'] {
  const a = row.deploy.approval;
  if (a === null) return { state: 'not_required', by: null, at: null };
  const by = a.decidedBy?.email ?? null;
  let state: ScheduleApprovalState;
  let at: Date | null;
  if (a.approvedAt !== null) {
    state = 'approved';
    at = a.approvedAt;
  } else if (a.deniedAt !== null) {
    state = 'denied';
    at = a.deniedAt;
  } else if (a.expiredAt !== null) {
    state = 'expired';
    at = a.expiredAt;
  } else {
    state = 'awaiting';
    at = null;
  }
  return { state, by: state === 'expired' ? null : by, at: at?.toISOString() ?? null };
}

function toEntry(row: EntryRow): ScheduleEntry {
  const target = row.deploy.targets[0];
  const parsed = storedRefusal(target?.refusal ?? null);
  const tokenLabel = row.deploy.requesterToken?.label;
  return {
    id: row.id,
    deployId: row.deployId,
    app: target?.app.name ?? '',
    sha: row.deploy.requestedSha,
    fireAt: row.fireAt.toISOString(),
    firedAt: row.firedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    status: row.cancelledAt !== null ? 'cancelled' : row.firedAt !== null ? 'fired' : 'upcoming',
    by: tokenLabel === undefined ? row.by.email : `token ${tokenLabel}`,
    requester: { label: row.deploy.requesterLabel, repo: row.deploy.requesterRepo, branch: row.deploy.requesterBranch },
    approval: approvalOf(row),
    state: target?.state ?? 'queued',
    refusal: parsed,
    createdAt: row.deploy.createdAt.toISOString(),
  };
}

/** One schedule, as the list shows it. */
export async function getSchedule(db: Db, id: string): Promise<ScheduleEntry | null> {
  const row = await db.schedule.findUnique({ where: { id }, select: ENTRY_SELECT });
  return row === null ? null : toEntry(row);
}

export interface ListSchedulesOptions {
  /** Only these apps (a token's scope). */
  apps?: ReadonlySet<string>;
  /** How many fired or cancelled schedules to return. */
  pastLimit?: number;
}

/** Upcoming schedules, soonest first; and fired or cancelled ones, most recent first. */
export async function listSchedules(db: Db, options: ListSchedulesOptions = {}): Promise<ScheduleList> {
  const scope: Prisma.ScheduleWhereInput =
    options.apps === undefined ? {} : { deploy: { targets: { some: { app: { name: { in: [...options.apps] } } } } } };
  const [upcoming, past] = await Promise.all([
    db.schedule.findMany({
      where: { ...scope, firedAt: null, cancelledAt: null },
      orderBy: [{ fireAt: 'asc' }, { id: 'asc' }],
      select: ENTRY_SELECT,
    }),
    db.schedule.findMany({
      where: { ...scope, OR: [{ firedAt: { not: null } }, { cancelledAt: { not: null } }] },
      orderBy: [{ fireAt: 'desc' }, { id: 'desc' }],
      take: options.pastLimit ?? 50,
      select: ENTRY_SELECT,
    }),
  ]);
  return { upcoming: upcoming.map(toEntry), past: past.map(toEntry) };
}

/**
 * Schedules a deploy of `input.app` at `input.sha` for `input.fireAt`. Nothing is checked against
 * the gates now — they all re-run at fire time (SHP-D-039) — except who is asking, that the agent
 * has reported the app, and the time window. Approval is captured now (SHP-REQ-081).
 */
export async function createSchedule(
  deps: ServiceDeps,
  caller: DeployCaller,
  input: ScheduleRequest,
  now: Date = new Date(),
): Promise<ScheduleEntry | Refusal> {
  const { db } = deps;
  const denied = callerCanActOn(caller, input.app);
  if (denied !== null) return denied;
  const actor = caller.actor;
  if (actor?.id === undefined) return refusal('unauthenticated', 'You are not signed in.');

  const fireAt = new Date(input.fireAt);
  if (Number.isNaN(fireAt.getTime()) || fireAt.getTime() <= now.getTime()) {
    return refusal('invalid_request', 'A deploy can only be scheduled for a time in the future.', 'Pick a later date and time.');
  }
  if (fireAt.getTime() - now.getTime() > SCHEDULE_MAX_AHEAD_MS) {
    return refusal('invalid_request', 'A deploy can be scheduled at most 30 days ahead.', 'Pick a time within the next 30 days.');
  }

  let label: string;
  let byUserId: string;
  if (actor.type === 'token') {
    if (input.requester === undefined) {
      return refusal(
        'invalid_request',
        'A deploy scheduled with a token must name its requester.',
        'Send requester { label, repo, branch } — the label is shown to anyone this deploy locks out.',
      );
    }
    label = input.requester.label;
    const token = await db.apiToken.findUnique({ where: { id: actor.id }, select: { userId: true } });
    if (token === null) return refusal('unauthenticated', 'This token no longer exists.');
    byUserId = token.userId;
  } else {
    label = `${actor.label} (scheduled)`;
    byUserId = actor.id;
  }

  const app = await db.app.findUnique({ where: { name: input.app }, select: { id: true, reportedAt: true, approvalPolicy: true } });
  if (app === null || app.reportedAt === null) {
    return refusal('unknown_app', `The agent has not reported an app named ${input.app}.`);
  }

  // SHP-REQ-081: an approval-required app's schedule carries its approval from the start. A console
  // user's scheduling is the approval (as confirming the dry-run sheet is, for a deploy now); a
  // token's waits for a deployer, and must have it by the fire time.
  const required = app.approvalPolicy === 'required';
  const byUser = actor.type === 'user';
  const approval: Prisma.ApprovalCreateWithoutDeployInput | undefined = !required
    ? undefined
    : byUser
      ? { requestedAt: now, expiresAt: fireAt, approvedAt: now, decidedBy: { connect: { id: actor.id } } }
      : { requestedAt: now, expiresAt: fireAt };

  const created = await db.deploy.create({
    data: {
      kind: 'deploy',
      requestedSha: input.sha,
      dryRun: false,
      requesterLabel: label,
      ...(input.requester !== undefined && !byUser ? { requesterRepo: input.requester.repo, requesterBranch: input.requester.branch } : {}),
      ...(byUser ? { requesterUser: { connect: { id: actor.id } } } : { requesterToken: { connect: { id: actor.id } } }),
      // `queued` on a real deploy: off the lock, and never dispatched (see the module comment).
      targets: { create: { app: { connect: { id: app.id } }, state: 'queued' } },
      schedule: { create: { fireAt, by: { connect: { id: byUserId } } } },
      ...(approval === undefined ? {} : { approval: { create: approval } }),
    },
    select: { id: true, schedule: { select: { id: true } } },
  });
  const scheduleId = created.schedule?.id ?? '';

  await caller.audit({
    action: 'schedule.created',
    entityType: 'schedule',
    entityId: scheduleId,
    after: {
      deployId: created.id,
      app: input.app,
      sha: input.sha,
      fireAt: fireAt.toISOString(),
      requester: label,
      approval: !required ? 'not_required' : byUser ? 'approved' : 'awaiting',
    },
  });
  if (required && byUser) {
    await caller.audit({
      action: 'schedule.approved',
      entityType: 'schedule',
      entityId: scheduleId,
      after: { deployId: created.id, app: input.app, sha: input.sha, fireAt: fireAt.toISOString(), at: 'scheduling' },
    });
  }
  deps.bus.publish(`deploy:${created.id}`);
  const entry = await getSchedule(db, scheduleId);
  if (entry === null) throw new Error(`schedule ${scheduleId} vanished after it was created`);
  return entry;
}

/**
 * Cancels an unfired schedule: a signed-in deployer, operator or admin may cancel any; a token only
 * the ones it made. The target moves to `cancelled`; a still-pending approval can no longer be given.
 */
export async function cancelSchedule(deps: ServiceDeps, caller: DeployCaller, id: string): Promise<ScheduleEntry | Refusal> {
  const { db } = deps;
  if (!UUID_RE.test(id)) return NO_SUCH_SCHEDULE;
  const row = await db.schedule.findUnique({
    where: { id },
    select: {
      id: true,
      deployId: true,
      fireAt: true,
      deploy: { select: { requestedSha: true, requesterTokenId: true, targets: { select: { id: true, app: { select: { name: true } } }, take: 1 } } },
    },
  });
  const target = row?.deploy.targets[0];
  if (row === null || target === undefined) return NO_SUCH_SCHEDULE;
  const appName = target.app.name;
  // A token never learns about a schedule outside its scope.
  if (caller.actor?.type === 'token' && caller.tokenApps?.has(appName) !== true) return NO_SUCH_SCHEDULE;
  const denied = callerCanActOn(caller, appName);
  if (denied !== null) return denied;
  if (caller.actor?.type === 'token' && row.deploy.requesterTokenId !== caller.actor.id) {
    return refusal('forbidden', 'A token may cancel only the schedules it made.', 'Ask a deployer to cancel it from the console.');
  }

  const now = new Date();
  const ok = await db.$transaction(async (tx) => {
    const marked = await tx.schedule.updateMany({ where: { id, firedAt: null, cancelledAt: null }, data: { cancelledAt: now } });
    if (marked.count === 0) return false;
    await tx.deployTarget.updateMany({ where: { id: target.id, state: 'queued' }, data: { state: 'cancelled', endedAt: now } });
    await tx.approval.updateMany({
      where: { deployId: row.deployId, approvedAt: null, deniedAt: null, expiredAt: null },
      data: { expiredAt: now },
    });
    return true;
  });
  if (!ok) return refusal('conflict', 'This schedule has already fired or been cancelled.', 'Refresh the schedules to see what happened to it.');

  await caller.audit({
    action: 'schedule.cancelled',
    entityType: 'schedule',
    entityId: id,
    before: { status: 'upcoming' },
    after: { deployId: row.deployId, app: appName, sha: row.deploy.requestedSha, fireAt: row.fireAt.toISOString(), status: 'cancelled' },
  });
  deps.bus.publish(`deploy:${row.deployId}`);
  const entry = await getSchedule(db, id);
  return entry ?? NO_SUCH_SCHEDULE;
}

// ── Fire time ───────────────────────────────────────────────────────────

export type FireOutcome = { scheduleId: string; deployId: string; result: 'fired' } | { scheduleId: string; deployId: string; result: 'refused'; refusal: Refusal };

async function auditSystem(tx: Prisma.TransactionClient, action: string, scheduleId: string, after: object): Promise<void> {
  await tx.auditEvent.create({
    data: {
      actorType: SCHEDULER_ACTOR.type,
      actorLabel: SCHEDULER_ACTOR.label,
      action,
      entityType: 'schedule',
      entityId: scheduleId,
      after,
    },
  });
}

interface DueRow {
  id: string;
  deployId: string;
  fireAt: Date;
  kind: 'deploy' | 'rollback' | 'restore';
  sha: string;
  targetId: string;
  appId: string;
  appName: string;
  approvalPending: boolean;
}

/**
 * Records a fire-time refusal: the schedule is taken (only if nobody has), the target refused with
 * the reason, a pending approval expired, and `schedule.refused` audited — one transaction.
 */
async function refuse(deps: ServiceDeps, row: DueRow, why: Refusal, now: Date): Promise<boolean> {
  return deps.db.$transaction(async (tx) => {
    const taken = await tx.schedule.updateMany({ where: { id: row.id, firedAt: null, cancelledAt: null }, data: { firedAt: now } });
    if (taken.count === 0) return false;
    await tx.deployTarget.updateMany({
      where: { id: row.targetId, state: 'queued' },
      data: { state: 'refused', refusal: why, endedAt: now },
    });
    if (row.approvalPending) {
      await tx.approval.updateMany({ where: { deployId: row.deployId, approvedAt: null, deniedAt: null, expiredAt: null }, data: { expiredAt: now } });
      await tx.deploy.update({ where: { id: row.deployId }, data: { expiredAt: now } });
    }
    await auditSystem(tx, 'schedule.refused', row.id, {
      deployId: row.deployId,
      app: row.appName,
      sha: row.sha,
      fireAt: row.fireAt.toISOString(),
      by: 'server',
      refusal: why,
    });
    return true;
  });
}

class RacedError extends Error {}

/** Fires one due schedule, or records why it could not. Null when another process took it first. */
async function fireOne(deps: ServiceDeps, row: DueRow, now: Date): Promise<FireOutcome | null> {
  const { db, bus, logger } = deps;
  const refused = async (why: Refusal): Promise<FireOutcome | null> => {
    const done = await refuse(deps, row, why, now);
    if (!done) return null;
    logger.info({ deployId: row.deployId, scheduleId: row.id, app: row.appName, code: why.code }, 'scheduled deploy refused');
    bus.publish(`deploy:${row.deployId}`);
    bus.publish(`app:${row.appName}`);
    return { scheduleId: row.id, deployId: row.deployId, result: 'refused', refusal: why };
  };

  // SHP-REQ-081: the approval had to be captured before now; it is never asked for at fire time.
  if (row.approvalPending) {
    return refused(
      refusal(
        'approval_required',
        `${row.appName} requires approval, and none was given before this deploy's scheduled time.`,
        'Schedule it again and have a deployer approve it before it fires.',
      ),
    );
  }
  // SHP-REQ-080: every server-side gate again, as of now.
  const blocked = (await assertDeployable(db, row.appName)) ?? (row.kind === 'deploy' ? await assertNotFrozen(db, row.appName, now) : null);
  if (blocked !== null) return refused(blocked);

  try {
    const fired = await db.$transaction(async (tx) => {
      const taken = await tx.schedule.updateMany({ where: { id: row.id, firedAt: null, cancelledAt: null }, data: { firedAt: now } });
      if (taken.count === 0) return false;
      // The unique index decides the lock (G4), exactly as for a deploy requested now.
      const moved = await tx.deployTarget.updateMany({ where: { id: row.targetId, state: 'queued' }, data: { state: 'locked' } });
      if (moved.count === 0) throw new RacedError();
      await auditSystem(tx, 'schedule.fired', row.id, {
        deployId: row.deployId,
        app: row.appName,
        sha: row.sha,
        fireAt: row.fireAt.toISOString(),
        state: 'locked',
      });
      return true;
    });
    if (!fired) return null;
  } catch (err) {
    if (err instanceof RacedError) {
      return refused(refusal('conflict', 'The scheduled deploy was no longer waiting when it fired.', 'Schedule it again.'));
    }
    if (!isUniqueViolation(err)) throw err;
    const locked =
      (await lockRefusal(db, row.appName, row.appId)) ??
      refusal('locked', `${row.appName} was being deployed by someone else when this schedule fired.`);
    return refused(locked);
  }

  logger.info({ deployId: row.deployId, scheduleId: row.id, app: row.appName }, 'scheduled deploy fired');
  bus.publish('work');
  bus.publish(`deploy:${row.deployId}`);
  bus.publish(`app:${row.appName}`);
  return { scheduleId: row.id, deployId: row.deployId, result: 'fired' };
}

/**
 * Fires every schedule due as of `now` (fire time reached, not fired, not cancelled), oldest
 * first, then logs any agent refusal of a recently fired one. Returns what it did.
 */
export async function fireDueSchedules(deps: ServiceDeps, now: Date = new Date()): Promise<FireOutcome[]> {
  const due = await deps.db.schedule.findMany({
    where: { fireAt: { lte: now }, firedAt: null, cancelledAt: null },
    orderBy: [{ fireAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      deployId: true,
      fireAt: true,
      deploy: {
        select: {
          kind: true,
          requestedSha: true,
          approval: { select: { approvedAt: true } },
          targets: { select: { id: true, app: { select: { id: true, name: true } } }, take: 1 },
        },
      },
    },
  });
  const outcomes: FireOutcome[] = [];
  for (const s of due) {
    const target = s.deploy.targets[0];
    if (target === undefined) continue;
    const outcome = await fireOne(
      deps,
      {
        id: s.id,
        deployId: s.deployId,
        fireAt: s.fireAt,
        kind: s.deploy.kind,
        sha: s.deploy.requestedSha,
        targetId: target.id,
        appId: target.app.id,
        appName: target.app.name,
        approvalPending: s.deploy.approval !== null && s.deploy.approval.approvedAt === null,
      },
      now,
    );
    if (outcome !== null) outcomes.push(outcome);
  }
  await logAgentRefusals(deps, now);
  return outcomes;
}

/**
 * A fired schedule the agent then refused (G5–G10 — an overtaken schedule's G7, say) is recorded
 * on its target by the agent's result like any refusal; this adds the `schedule.refused` line to
 * the audit trail, once, so every refused schedule is logged the same way. Returns the schedule IDs
 * it logged.
 */
export async function logAgentRefusals(deps: ServiceDeps, now: Date = new Date()): Promise<string[]> {
  const { db } = deps;
  const refused = await db.schedule.findMany({
    where: {
      firedAt: { gte: new Date(now.getTime() - RECONCILE_WINDOW_MS) },
      deploy: { targets: { some: { state: 'refused' } } },
    },
    select: {
      id: true,
      deployId: true,
      fireAt: true,
      deploy: { select: { requestedSha: true, targets: { select: { refusal: true, app: { select: { name: true } } }, take: 1 } } },
    },
  });
  if (refused.length === 0) return [];
  const logged = await db.auditEvent.findMany({
    where: { action: 'schedule.refused', entityType: 'schedule', entityId: { in: refused.map((r) => r.id) } },
    select: { entityId: true },
  });
  const seen = new Set(logged.map((l) => l.entityId));
  const wrote: string[] = [];
  for (const r of refused) {
    if (seen.has(r.id)) continue;
    const target = r.deploy.targets[0];
    await db.$transaction(async (tx) => {
      await auditSystem(tx, 'schedule.refused', r.id, {
        deployId: r.deployId,
        app: target?.app.name ?? '',
        sha: r.deploy.requestedSha,
        fireAt: r.fireAt.toISOString(),
        by: 'agent',
        refusal: storedRefusal(target?.refusal ?? null),
      });
    });
    wrote.push(r.id);
  }
  if (wrote.length > 0) deps.logger.info({ scheduleIds: wrote }, 'agent refusals of scheduled deploys logged');
  return wrote;
}
