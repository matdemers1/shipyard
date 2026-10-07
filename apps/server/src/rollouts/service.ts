import {
  refusal,
  type DeployTargetState,
  type Refusal,
  type RolloutAccepted,
  type RolloutPlan,
  type RolloutRequest,
  type RolloutStatus,
} from '@shipyard/schema';
import type { Db, Prisma } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { recordedRelease, type DbClient } from '../apps/drift.js';
import { assertNotFrozen } from '../freeze/service.js';
import {
  callerCanActOn,
  defaultDeployableCheck,
  getDeployStatus,
  isUniqueViolation,
  lockRefusal,
  MAX_WAIT_SECONDS,
  TERMINAL_STATES,
  type CreateDeployOptions,
  type DeployCaller,
} from '../deploys/service.js';

/**
 * Rollouts — "Roll all" (SHP-T-12.1; SHP-REQ-151, SHP-REQ-152, SHP-REQ-153).
 *
 * A rollout is one ordinary single-app deploy per app, each at its own SHA, tied together by a
 * `rollout` row and each deploy's `rollout_position`. It borrows the group deploy's rules
 * (`groups/service.ts`) without its one-SHA limit:
 *
 * - **Order.** The server decides it, whatever order the request names: apps of one group sit
 *   together with the group's canary first, otherwise by app name — and Shipyard's own app
 *   (`SELF_APP`) is always last, so the server's restart can never interrupt an app before it.
 * - **One transaction locks every member.** All the deploys are created in one transaction with
 *   their targets in `locked`, so the one-active-target index grants every lock or none; a held lock
 *   refuses the rollout naming its holder. Later members keep their locks while they wait, so nobody
 *   else deploys them halfway through.
 * - **One member at a time.** Dispatch (`agent/dispatch.ts`) hands out a member only once every
 *   earlier member of the rollout has succeeded — and success includes the soak (SHP-D-022).
 * - **Stop at the first failure.** A member ending in anything but `succeeded` cancels every later
 *   member still waiting with `rollout_stopped`, in the transaction that records its result
 *   (`stopRolloutAfter`); those apps are never dispatched or touched.
 *
 * Every member is an ordinary deploy, so its live page, record, timeline row, Foreman record and
 * rollback are exactly a single deploy's. The agent sees nothing new: it is handed one target at a
 * time, as ever, and re-verifies every gate itself.
 *
 * Choices made here, mirroring group deploys:
 * - A **frozen**, **drifted** or **unknown** member refuses the whole rollout; leave it out instead.
 * - A **token** request with an approval-required member is refused (`approval_required`); a
 *   console request needs none — confirming the sheet is the approval.
 * - There is no rollout dry run; dry-run an app on its own. Each member's gates still run on the
 *   agent before anything is touched.
 */

/** Which app is Shipyard's own server, from config (SHP-REQ-152). */
export interface RolloutOptions extends CreateDeployOptions {
  selfApp: string;
}

interface OrderInput {
  name: string;
  groupName: string | null;
  canary: boolean;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Members in rollout order: Shipyard's own app last; otherwise group-mates together (sorted by the
 * group's name, standing in for the app name) with the canary first, then by app name.
 */
export function orderRollout<T extends OrderInput>(members: readonly T[], selfApp: string): T[] {
  return [...members].sort((a, b) => {
    const aSelf = a.name === selfApp;
    const bSelf = b.name === selfApp;
    if (aSelf !== bSelf) return aSelf ? 1 : -1;
    const byCluster = compare(a.groupName ?? a.name, b.groupName ?? b.name);
    if (byCluster !== 0) return byCluster;
    if (a.canary !== b.canary) return a.canary ? -1 : 1;
    return compare(a.name, b.name);
  });
}

interface PlannedMember {
  id: string;
  name: string;
  sha: string;
  liveSha: string | null;
  self: boolean;
}

interface Plan {
  label: string;
  members: PlannedMember[];
}

/**
 * Every check a rollout needs before anything is written, for every member, and the order it would
 * ship in. Returns the refusal of the first member that fails one. `checkLocks` adds the lock
 * pre-check the plan sheet shows; the real lock is the insert itself.
 */
async function plan(
  deps: ServiceDeps,
  caller: DeployCaller,
  input: RolloutRequest,
  options: RolloutOptions,
  checkLocks: boolean,
): Promise<Plan | Refusal> {
  const { db } = deps;
  const check = options.check ?? defaultDeployableCheck;
  const actor = caller.actor;
  if (actor === undefined) return refusal('unauthenticated', 'You are not signed in.');

  // Authorisation first, for every member: a token must be scoped to all of them.
  for (const item of input.items) {
    const denied = callerCanActOn(caller, item.app);
    if (denied !== null) return denied;
  }

  let label: string;
  if (actor.type === 'token') {
    if (input.requester === undefined) {
      return refusal(
        'invalid_request',
        'A rollout requested with a token must name its requester.',
        'Send requester { label, repo, branch } — the label is shown to anyone this rollout locks out.',
      );
    }
    label = input.requester.label;
  } else {
    label = input.requester?.label ?? `${actor.label} (console)`;
  }

  const shaByApp = new Map(input.items.map((i) => [i.app, i.sha]));
  const rows = await db.app.findMany({
    where: { name: { in: [...shaByApp.keys()] }, retiredAt: null },
    select: { id: true, name: true, groupName: true, canary: true, approvalPolicy: true },
  });
  for (const item of input.items) {
    if (!rows.some((r) => r.name === item.app)) {
      return refusal('unknown_app', `No app named ${item.app} has been reported by the agent.`);
    }
  }

  const ordered = orderRollout(rows, options.selfApp);
  for (const row of ordered) {
    if (actor.type === 'token' && row.approvalPolicy === 'required') {
      return refusal(
        'approval_required',
        `${row.name} requires a deployer's approval, so it cannot be rolled out with a token.`,
        'Ask a deployer to roll it from the console, or leave it out of the rollout.',
      );
    }
    const frozen = await assertNotFrozen(db, row.name);
    if (frozen !== null) return frozen;
    const notDeployable = await check(db, row.name);
    if (notDeployable !== null) return notDeployable;
    if (checkLocks) {
      const locked = await lockRefusal(db, row.name, row.id);
      if (locked !== null) return locked;
    }
  }

  const members: PlannedMember[] = [];
  for (const row of ordered) {
    members.push({
      id: row.id,
      name: row.name,
      sha: shaByApp.get(row.name) ?? '',
      liveSha: (await recordedRelease(db, row.id))?.sha ?? null,
      self: row.name === options.selfApp,
    });
  }
  return { label, members };
}

/** What a rollout of these items would ship, in order, if it started now — or why it cannot. */
export async function planRollout(
  deps: ServiceDeps,
  caller: DeployCaller,
  input: RolloutRequest,
  options: RolloutOptions,
): Promise<RolloutPlan | Refusal> {
  const result = await plan(deps, caller, input, options, true);
  if ('code' in result) return result;
  return { members: result.members.map((m) => ({ app: m.name, sha: m.sha, liveSha: m.liveSha, self: m.self })) };
}

/** The requester label each member's deploy carries: who asked, and where it sits in the rollout. */
export function memberLabel(label: string, position: number, total: number): string {
  const suffix = ` · roll all ${String(position + 1)}/${String(total)}`;
  return `${label.slice(0, 200 - suffix.length)}${suffix}`;
}

/**
 * Accepts a rollout, or returns the refusal. Every check runs for every member before anything is
 * written; the rollout and all of its deploys are created in one transaction that takes every
 * member's lock or none.
 */
export async function createRollout(
  deps: ServiceDeps,
  caller: DeployCaller,
  input: RolloutRequest,
  options: RolloutOptions,
): Promise<RolloutAccepted | Refusal> {
  const { db, bus } = deps;
  const planned = await plan(deps, caller, input, options, false);
  if ('code' in planned) return planned;
  const { label, members } = planned;
  const actor = caller.actor;
  if (actor === undefined) return refusal('unauthenticated', 'You are not signed in.');

  const requesterFields = {
    ...(input.requester !== undefined ? { requesterRepo: input.requester.repo, requesterBranch: input.requester.branch } : {}),
    ...(actor.type === 'user' && actor.id !== undefined ? { requesterUser: { connect: { id: actor.id } } } : {}),
    ...(actor.type === 'token' && actor.id !== undefined ? { requesterToken: { connect: { id: actor.id } } } : {}),
  };

  let accepted: RolloutAccepted | undefined;
  for (let attempt = 0; attempt < 2 && accepted === undefined; attempt += 1) {
    try {
      accepted = await db.$transaction(async (tx) => {
        const rollout = await tx.rollout.create({ data: { requesterLabel: label }, select: { id: true } });
        const base = Date.now();
        const deployIds: string[] = [];
        for (const [position, member] of members.entries()) {
          const data: Prisma.DeployCreateInput = {
            kind: 'deploy',
            requestedSha: member.sha,
            dryRun: false,
            requesterLabel: memberLabel(label, position, members.length),
            rollout: { connect: { id: rollout.id } },
            rolloutPosition: position,
            ...requesterFields,
            targets: {
              create: {
                app: { connect: { id: member.id } },
                state: 'locked',
                // Dispatch walks runnable targets by created_at; rollout order is the tiebreak.
                createdAt: new Date(base + position),
              },
            },
          };
          const row = await tx.deploy.create({ data, select: { id: true } });
          deployIds.push(row.id);
        }
        return { rolloutId: rollout.id, deployIds };
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      for (const member of members) {
        const locked = await lockRefusal(db, member.name, member.id);
        if (locked !== null) return locked;
      }
    }
  }
  if (accepted === undefined) {
    return refusal('locked', 'An app in this rollout is being deployed by someone else.');
  }

  await caller.audit({
    action: 'rollout.requested',
    entityType: 'rollout',
    entityId: accepted.rolloutId,
    after: {
      members: members.map((m, i) => ({ app: m.name, sha: m.sha, deployId: accepted.deployIds[i] ?? null })),
      requester: { label, repo: input.requester?.repo ?? null, branch: input.requester?.branch ?? null },
    },
  });
  for (const [i, member] of members.entries()) {
    await caller.audit({
      action: 'deploy.requested',
      entityType: 'deploy',
      entityId: accepted.deployIds[i] ?? '',
      after: {
        app: member.name,
        kind: 'deploy',
        sha: member.sha,
        dryRun: false,
        state: 'locked',
        rollout: accepted.rolloutId,
        position: i,
        requester: { label, repo: input.requester?.repo ?? null, branch: input.requester?.branch ?? null },
      },
    });
  }
  bus.publish('work');
  return accepted;
}

/**
 * After a rollout member ended without succeeding: cancels every later member still waiting, with
 * `rollout_stopped` naming the member that stopped it. Run inside the transaction that records the
 * member's result. Returns the cancelled members' apps and deploy IDs.
 */
export async function stopRolloutAfter(
  tx: DbClient,
  stopped: { rolloutId: string; position: number; app: string; state: DeployTargetState },
): Promise<{ app: string; deployId: string }[]> {
  const later = await tx.deployTarget.findMany({
    where: {
      deploy: { rolloutId: stopped.rolloutId, rolloutPosition: { gt: stopped.position } },
      state: { notIn: [...TERMINAL_STATES] },
    },
    select: { id: true, deployId: true, app: { select: { name: true } } },
  });
  if (later.length === 0) return [];
  const why = refusal(
    'rollout_stopped',
    `The rollout stopped at ${stopped.app} (${stopped.state}); this app was not touched.`,
  );
  await tx.deployTarget.updateMany({
    where: { id: { in: later.map((t) => t.id) }, state: { notIn: [...TERMINAL_STATES] } },
    data: { state: 'cancelled', refusal: why, endedAt: new Date() },
  });
  return later.map((t) => ({ app: t.app.name, deployId: t.deployId }));
}

/** The first member not yet succeeded decides a rollout's overall state. */
export function rolloutState(members: readonly { state: DeployTargetState }[]): DeployTargetState {
  return members.find((m) => m.state !== 'succeeded')?.state ?? 'succeeded';
}

/** A rollout with every member's deploy status in order, or null if there is no such rollout. */
export async function getRolloutStatus(db: Db, rolloutId: string, selfApp: string): Promise<RolloutStatus | null> {
  const rollout = await db.rollout.findUnique({
    where: { id: rolloutId },
    select: {
      id: true,
      requesterLabel: true,
      createdAt: true,
      deploys: { select: { id: true, rolloutPosition: true }, orderBy: { rolloutPosition: 'asc' } },
    },
  });
  if (rollout === null) return null;
  const members: RolloutStatus['members'] = [];
  for (const deploy of rollout.deploys) {
    const status = await getDeployStatus(db, deploy.id);
    if (status === null) continue;
    members.push({ ...status, position: deploy.rolloutPosition ?? members.length, self: status.app === selfApp });
  }
  return {
    rolloutId: rollout.id,
    requesterLabel: rollout.requesterLabel,
    createdAt: rollout.createdAt.toISOString(),
    state: rolloutState(members),
    members,
  };
}

/** True once a rollout can change no further. */
export function rolloutDone(status: RolloutStatus): boolean {
  return status.members.every((m) => TERMINAL_STATES.includes(m.state));
}

/**
 * The rollout's status once any member changes, or after `waitSeconds` (capped at 90). The wait is
 * armed before the first read, so a publish in between is not lost.
 */
export async function waitForRolloutChange(
  deps: ServiceDeps,
  rolloutId: string,
  selfApp: string,
  waitSeconds: number,
  signal?: AbortSignal,
): Promise<RolloutStatus | null> {
  const seconds = Math.max(0, Math.min(MAX_WAIT_SECONDS, waitSeconds));
  if (seconds === 0) return getRolloutStatus(deps.db, rolloutId, selfApp);
  const stop = new AbortController();
  const combined = signal === undefined ? stop.signal : AbortSignal.any([signal, stop.signal]);
  const woken = deps.bus.wait(`rollout:${rolloutId}`, seconds * 1000, combined);
  try {
    const first = await getRolloutStatus(deps.db, rolloutId, selfApp);
    if (first === null || rolloutDone(first)) return first;
    await woken;
    if (signal?.aborted === true) return first;
    return await getRolloutStatus(deps.db, rolloutId, selfApp);
  } finally {
    stop.abort();
    await woken;
  }
}
