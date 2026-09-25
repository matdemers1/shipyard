import { refusal, type DeployAccepted, type Refusal } from '@shipyard/schema';
import type { Actor, AuditEventInput } from '../audit.js';
import type { Role } from '../auth/scope.js';
import type { ServiceDeps } from '../deps.js';
import { callerCanActOn, isUniqueViolation, lockRefusal, type DeployCaller } from '../deploys/service.js';
import { assertDeployable } from '../apps/drift.js';
import { assertNotFrozen } from '../freeze/service.js';

/**
 * Approvals (SHP-T-3.6). A token-requested deploy of an app whose manifest says
 * `approval: required` waits in `awaiting_approval` — off the lock — until a deployer approves or
 * denies it from the console (SHP-REQ-060, SHP-D-015). Approval is console-only, never an MCP
 * tool (SHP-D-072). Unanswered after an hour, it expires and must be requested again
 * (SHP-REQ-061, SHP-D-048).
 */

/** How often `startApprovalExpiry` sweeps. */
export const EXPIRY_INTERVAL_MS = 30_000;

export const EXPIRED_MESSAGE = 'approval expired after one hour; request the deploy again';

function expiredRefusal(): Refusal {
  return refusal('approval_required', EXPIRED_MESSAGE, 'Request the deploy again, and ask a deployer to approve it within the hour.');
}

/** Who is deciding: the console user, with the request's audit writer. */
export interface Decider {
  actor: Actor | undefined;
  role: Role | undefined;
  audit: (event: AuditEventInput) => Promise<void>;
}

/** Only a signed-in deployer, operator or admin may decide; never a token (SHP-D-072). */
function assertCanDecide(decider: Decider, appName: string): Refusal | null {
  const actor = decider.actor;
  if (actor === undefined) return refusal('unauthenticated', 'You are not signed in.');
  if (actor.type !== 'user') {
    return refusal('forbidden', 'Approvals are given in the console, not with a token.', 'Sign in to the console as a deployer and approve it there.');
  }
  const caller: DeployCaller = { actor, role: decider.role, tokenApps: undefined, audit: decider.audit };
  return callerCanActOn(caller, appName);
}

/**
 * Expires every undecided approval whose hour is up (as of `now`): the approval gets
 * `expiredAt`, its target moves to `cancelled` with an `approval_required` refusal, and anyone
 * following the deploy is woken. Returns the expired deploy IDs.
 */
export async function expireApprovals(deps: ServiceDeps, now: Date = new Date()): Promise<string[]> {
  const { db, bus } = deps;
  const due = await db.approval.findMany({
    // A scheduled deploy's approval runs until its fire time, and the scheduler decides what an
    // unapproved one becomes then (SHP-REQ-081): this sweep never touches one.
    where: { expiresAt: { lte: now }, approvedAt: null, deniedAt: null, expiredAt: null, deploy: { schedule: { is: null } } },
    select: { id: true, deployId: true },
  });
  const expired: string[] = [];
  for (const row of due) {
    const done = await db.$transaction(async (tx) => {
      // Conditional on still being undecided, so a concurrent approve or deny wins cleanly.
      const marked = await tx.approval.updateMany({
        where: { id: row.id, approvedAt: null, deniedAt: null, expiredAt: null },
        data: { expiredAt: now },
      });
      if (marked.count === 0) return false;
      await tx.deploy.update({ where: { id: row.deployId }, data: { expiredAt: now } });
      await tx.deployTarget.updateMany({
        where: { deployId: row.deployId, state: 'awaiting_approval' },
        data: { state: 'cancelled', refusal: expiredRefusal(), endedAt: now },
      });
      return true;
    });
    if (done) {
      expired.push(row.deployId);
      bus.publish(`deploy:${row.deployId}`);
    }
  }
  if (expired.length > 0) deps.logger.info({ deployIds: expired }, 'approvals expired');
  return expired;
}

/** Runs `expireApprovals` every 30 s until `stop()`, which waits for a sweep in flight. */
export function startApprovalExpiry(deps: ServiceDeps, intervalMs = EXPIRY_INTERVAL_MS): { stop(): Promise<void> } {
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = (): void => {
    inFlight = expireApprovals(deps)
      .then(() => undefined)
      .catch((err: unknown) => {
        deps.logger.error({ err }, 'approval expiry failed');
      });
  };

  const timer = setInterval(tick, intervalMs);
  tick();

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}

const NO_SUCH_APPROVAL = refusal('not_found', 'No deploy awaiting approval has that ID.', 'List pending approvals and use one of their deploy IDs.');

/** The pending approval for `deployId` with its app, or a refusal naming why it cannot be decided. */
async function loadPending(deps: ServiceDeps, deployId: string) {
  // Lazily expire first: an approval past its hour can never be approved (SHP-REQ-061).
  await expireApprovals(deps);
  const row = await deps.db.approval.findUnique({
    where: { deployId },
    select: {
      id: true,
      approvedAt: true,
      deniedAt: true,
      expiredAt: true,
      deploy: {
        select: {
          kind: true,
          requestedSha: true,
          schedule: { select: { id: true, fireAt: true, firedAt: true, cancelledAt: true } },
          targets: { select: { id: true, state: true, app: { select: { id: true, name: true } } } },
        },
      },
    },
  });
  const target = row?.deploy.targets[0];
  if (row === null || target === undefined) return NO_SUCH_APPROVAL;
  const schedule = row.deploy.schedule;
  if (schedule !== null && row.expiredAt !== null) {
    return refusal('approval_required', 'This scheduled deploy was not approved before its time.', 'Schedule it again, and approve it before it fires.');
  }
  if (row.expiredAt !== null) return expiredRefusal();
  if (row.approvedAt !== null) return refusal('conflict', 'This deploy has already been approved.');
  if (row.deniedAt !== null) return refusal('conflict', 'This deploy has already been denied.');
  if (schedule !== null) {
    // A scheduled deploy waits in `queued` until it fires (SHP-T-5.4); approval is captured before then.
    if (schedule.firedAt !== null || schedule.cancelledAt !== null || target.state !== 'queued') {
      return refusal('conflict', 'This scheduled deploy has already fired or been cancelled.');
    }
    return { approvalId: row.id, sha: row.deploy.requestedSha, kind: row.deploy.kind, target, schedule };
  }
  if (target.state !== 'awaiting_approval') return refusal('conflict', `This deploy is ${target.state}, not awaiting approval.`);
  return { approvalId: row.id, sha: row.deploy.requestedSha, kind: row.deploy.kind, target, schedule: null };
}

/**
 * Approves a held deploy: in one transaction the approval is decided and the target moves to
 * `locked`, where the agent's poll picks it up. If another deploy holds the app, the unique index
 * refuses, the transaction rolls back, and the deploy stays awaiting approval.
 */
export async function approveDeploy(deps: ServiceDeps, decider: Decider, deployId: string): Promise<DeployAccepted | Refusal> {
  const pending = await loadPending(deps, deployId);
  if ('code' in pending) return pending;
  const denied = assertCanDecide(decider, pending.target.app.name);
  if (denied !== null) return denied;
  if (pending.schedule !== null) return approveScheduled(deps, decider, deployId, { ...pending, schedule: pending.schedule });
  // The server's pre-checks (unknown app, drift) apply when a held deploy is released, not only
  // when it was requested: drift can open during the hour it waits (SHP-REQ-054).
  const blocked = await assertDeployable(deps.db, pending.target.app.name);
  if (blocked !== null) return blocked;
  // Same for a freeze set after the deploy was requested (SHP-REQ-077, SHP-D-049): a held rollback
  // is still approvable, only a held deploy is refused.
  if (pending.kind === 'deploy') {
    const frozen = await assertNotFrozen(deps.db, pending.target.app.name);
    if (frozen !== null) return frozen;
  }
  const userId = decider.actor?.id;

  let outcome: 'ok' | 'raced';
  try {
    outcome = await deps.db.$transaction(async (tx) => {
      const now = new Date();
      const marked = await tx.approval.updateMany({
        where: { id: pending.approvalId, approvedAt: null, deniedAt: null, expiredAt: null, expiresAt: { gt: now } },
        data: { approvedAt: now, ...(userId !== undefined ? { decidedByUserId: userId } : {}) },
      });
      if (marked.count === 0) return 'raced';
      const moved = await tx.deployTarget.updateMany({
        where: { id: pending.target.id, state: 'awaiting_approval' },
        data: { state: 'locked' },
      });
      if (moved.count === 0) throw new RacedError();
      return 'ok';
    });
  } catch (err) {
    if (err instanceof RacedError) {
      outcome = 'raced';
    } else if (isUniqueViolation(err)) {
      const locked = await lockRefusal(deps.db, pending.target.app.name, pending.target.app.id);
      return (
        locked ?? refusal('locked', `${pending.target.app.name} is being deployed by someone else.`, 'Approve it again once that deploy finishes.')
      );
    } else {
      throw err;
    }
  }
  if (outcome === 'raced') return refusal('conflict', 'This deploy was decided or expired while you were approving it.');

  await decider.audit({
    action: 'deploy.approved',
    entityType: 'deploy',
    entityId: deployId,
    before: { state: 'awaiting_approval' },
    after: { app: pending.target.app.name, sha: pending.sha, state: 'locked' },
  });
  deps.bus.publish('work');
  deps.bus.publish(`deploy:${deployId}`);
  return { deployId, state: 'locked' };
}

class RacedError extends Error {}

/**
 * Approves a token-scheduled deploy of an approval-required app (SHP-REQ-081, SHP-D-051): the
 * approval is recorded and the deploy stays `queued` until its time. Nothing else is checked now —
 * every gate re-runs when it fires, and no second approval is asked for then.
 */
async function approveScheduled(
  deps: ServiceDeps,
  decider: Decider,
  deployId: string,
  pending: { approvalId: string; sha: string; target: { app: { name: string } }; schedule: { id: string; fireAt: Date } },
): Promise<DeployAccepted | Refusal> {
  const userId = decider.actor?.id;
  const now = new Date();
  const marked = await deps.db.approval.updateMany({
    where: { id: pending.approvalId, approvedAt: null, deniedAt: null, expiredAt: null, expiresAt: { gt: now } },
    data: { approvedAt: now, ...(userId !== undefined ? { decidedByUserId: userId } : {}) },
  });
  if (marked.count === 0) return refusal('conflict', 'This scheduled deploy was decided, or reached its time, while you were approving it.');
  await decider.audit({
    action: 'schedule.approved',
    entityType: 'schedule',
    entityId: pending.schedule.id,
    before: { approval: 'awaiting' },
    after: { deployId, app: pending.target.app.name, sha: pending.sha, fireAt: pending.schedule.fireAt.toISOString(), approval: 'approved' },
  });
  deps.bus.publish(`deploy:${deployId}`);
  return { deployId, state: 'queued' };
}

/** Denies a held deploy: the target is cancelled with an `approval_required` refusal naming who denied it. */
export async function denyDeploy(deps: ServiceDeps, decider: Decider, deployId: string): Promise<DeployAccepted | Refusal> {
  const pending = await loadPending(deps, deployId);
  if ('code' in pending) return pending;
  const denied = assertCanDecide(decider, pending.target.app.name);
  if (denied !== null) return denied;
  // The server's pre-checks (unknown app, drift) apply when a held deploy is released, not only
  // when it was requested: drift can open during the hour it waits (SHP-REQ-054).
  const blocked = await assertDeployable(deps.db, pending.target.app.name);
  if (blocked !== null) return blocked;
  const userId = decider.actor?.id;
  const label = decider.actor?.label ?? 'a deployer';

  const ok = await deps.db.$transaction(async (tx) => {
    const now = new Date();
    const marked = await tx.approval.updateMany({
      where: { id: pending.approvalId, approvedAt: null, deniedAt: null, expiredAt: null },
      data: { deniedAt: now, ...(userId !== undefined ? { decidedByUserId: userId } : {}) },
    });
    if (marked.count === 0) return false;
    // A denied schedule is cancelled with it: it will never fire.
    if (pending.schedule !== null) {
      await tx.schedule.updateMany({ where: { id: pending.schedule.id, firedAt: null, cancelledAt: null }, data: { cancelledAt: now } });
    }
    await tx.deployTarget.updateMany({
      where: { id: pending.target.id, state: pending.schedule === null ? 'awaiting_approval' : 'queued' },
      data: {
        state: 'cancelled',
        endedAt: now,
        refusal: refusal('approval_required', `denied by ${label}`, 'Ask a deployer why, then request the deploy again if it should go out.'),
      },
    });
    return true;
  });
  if (!ok) return refusal('conflict', 'This deploy was decided or expired while you were denying it.');

  await decider.audit({
    action: 'deploy.denied',
    entityType: 'deploy',
    entityId: deployId,
    before: { state: pending.target.state },
    after: {
      app: pending.target.app.name,
      sha: pending.sha,
      state: 'cancelled',
      ...(pending.schedule === null ? {} : { scheduleId: pending.schedule.id }),
    },
  });
  deps.bus.publish(`deploy:${deployId}`);
  return { deployId, state: 'cancelled' };
}

/** A deploy waiting for approval, for the home banner (SHP-D-071). */
export interface PendingApproval {
  deployId: string;
  kind: 'deploy' | 'rollback' | 'restore';
  app: string;
  sha: string;
  requester: { label: string; repo: string | null; branch: string | null };
  requestedAt: string;
  expiresAt: string;
  /** For a scheduled deploy (SHP-T-5.4): when it fires. Approval must be given before then. */
  fireAt: string | null;
}

/** Undecided, unexpired approvals, oldest first. */
export async function listPendingApprovals(deps: ServiceDeps, now: Date = new Date()): Promise<PendingApproval[]> {
  const rows = await deps.db.approval.findMany({
    where: {
      approvedAt: null,
      deniedAt: null,
      expiredAt: null,
      expiresAt: { gt: now },
      // A scheduled deploy's approval is pending only while the schedule is still upcoming.
      OR: [{ deploy: { schedule: { is: null } } }, { deploy: { schedule: { is: { firedAt: null, cancelledAt: null } } } }],
    },
    orderBy: { requestedAt: 'asc' },
    select: {
      deployId: true,
      requestedAt: true,
      expiresAt: true,
      deploy: {
        select: {
          kind: true,
          requestedSha: true,
          requesterLabel: true,
          requesterRepo: true,
          requesterBranch: true,
          schedule: { select: { fireAt: true } },
          targets: { select: { app: { select: { name: true } } }, take: 1 },
        },
      },
    },
  });
  return rows.map((r) => ({
    deployId: r.deployId,
    kind: r.deploy.kind,
    app: r.deploy.targets[0]?.app.name ?? '',
    sha: r.deploy.requestedSha,
    requester: { label: r.deploy.requesterLabel, repo: r.deploy.requesterRepo, branch: r.deploy.requesterBranch },
    requestedAt: r.requestedAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    fireAt: r.deploy.schedule?.fireAt.toISOString() ?? null,
  }));
}
