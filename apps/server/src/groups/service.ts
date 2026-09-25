import {
  refusal,
  type DeployAccepted,
  type DeployRequest,
  type DeployStatus,
  type DeployTargetState,
  type GroupDeployStatus,
  type GroupSummary,
  type Refusal,
} from '@shipyard/schema';
import type { Db, Prisma } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import type { DbClient } from '../apps/drift.js';
import { assertNotFrozen } from '../freeze/service.js';
import {
  callerCanActOn,
  defaultDeployableCheck,
  getDeployStatuses,
  isUniqueViolation,
  lockRefusal,
  TERMINAL_STATES,
  type CreateDeployOptions,
  type DeployCaller,
} from '../deploys/service.js';

/**
 * Group deploys (SHP-T-5.2, SHP-T-5.3; SHP-REQ-078, SHP-REQ-079, SHP-D-047).
 *
 * - **Members** are the apps whose reported manifest names the group. The canary, if one is
 *   declared, is shipped first; the rest follow by app name. More than one canary is refused.
 * - **One transaction locks every member.** Every member's target is inserted in `locked` by one
 *   nested create, so the one-active-target index either grants all the locks or none: if any
 *   member is held by another deploy, nothing is inserted and the refusal names that holder.
 * - **One member at a time.** Each target's `created_at` is the request time plus its position in
 *   milliseconds, and dispatch (`agent/dispatch.ts`) hands out a group member only when every
 *   earlier member of the same deploy has succeeded. Later members keep holding their locks while
 *   they wait, so nobody else can deploy them between the canary and the promotion.
 * - **Stop at the first failure.** When a member ends in anything but `succeeded`, every later
 *   member still waiting is cancelled with `group_stopped` naming it (`stopGroupAfter`), in the
 *   same transaction that records the result: those apps are never dispatched, never touched.
 * - **Canary promotion.** Once the canary has succeeded — its soak is part of success in the
 *   engine — each later member is dispatched with `expectDigests`: the canary's recorded digests
 *   for the services the member maps, matched by service name. The agent refuses
 *   `digest_mismatch` if GHCR now resolves anything else for the SHA, so the rest get the bits the
 *   canary soaked. A member service the canary does not map carries no expectation.
 *
 * Choices the brief left open, made here:
 * - A group **dry run** is refused (`invalid_request`); dry-run each member on its own.
 * - A **token** request for a group with an approval-required member is refused
 *   (`approval_required`, naming the member) rather than held; a console request needs none.
 * - A **frozen** or **drifted** member refuses the whole group.
 */

/** What each member's target carries in `result.group` from creation, and keeps after its result. */
export interface GroupMeta {
  name: string;
  /** 0-based position in deploy order. */
  position: number;
  /** True for the group's canary (always position 0). */
  canary: boolean;
}

export function readGroupMeta(result: Prisma.JsonValue | null | undefined): GroupMeta | null {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const group = (result as { group?: unknown }).group;
  if (typeof group !== 'object' || group === null) return null;
  const g = group as { name?: unknown; position?: unknown; canary?: unknown };
  if (typeof g.name !== 'string' || typeof g.position !== 'number' || typeof g.canary !== 'boolean') return null;
  return { name: g.name, position: g.position, canary: g.canary };
}

interface MemberRow {
  id: string;
  name: string;
  canary: boolean;
  approvalPolicy: string | null;
}

/** Members in deploy order: the canary first, then by app name. */
export function orderMembers<T extends { name: string; canary: boolean }>(members: readonly T[]): T[] {
  return [...members].sort((a, b) => {
    if (a.canary !== b.canary) return a.canary ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

async function membersOf(db: Db, group: string): Promise<MemberRow[]> {
  const rows = await db.app.findMany({
    where: { groupName: group },
    select: { id: true, name: true, canary: true, approvalPolicy: true },
  });
  return orderMembers(rows);
}

/** Every group the agent has reported, with its members in deploy order. */
export async function listGroups(db: Db): Promise<GroupSummary[]> {
  const rows = await db.app.findMany({
    where: { groupName: { not: null } },
    select: { name: true, canary: true, groupName: true },
  });
  const byGroup = new Map<string, { name: string; canary: boolean }[]>();
  for (const row of rows) {
    if (row.groupName === null) continue;
    const list = byGroup.get(row.groupName) ?? [];
    list.push({ name: row.name, canary: row.canary });
    byGroup.set(row.groupName, list);
  }
  return [...byGroup.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, members]) => {
      const ordered = orderMembers(members);
      const canaries = ordered.filter((m) => m.canary);
      return { name, canary: canaries.length === 1 ? (canaries[0]?.name ?? null) : null, members: ordered.map((m) => m.name) };
    });
}

/**
 * Accepts a group deploy, or returns the refusal. Every check runs for every member before anything
 * is written; the insert is one transaction that takes every member's lock or none.
 */
export async function createGroupDeploy(
  deps: ServiceDeps,
  caller: DeployCaller,
  input: DeployRequest,
  options: CreateDeployOptions = {},
): Promise<DeployAccepted | Refusal> {
  const { db, bus } = deps;
  const check = options.check ?? defaultDeployableCheck;
  const group = input.group ?? '';

  if (input.kind !== 'deploy' || input.sha === undefined) {
    return refusal('invalid_request', 'A group can only be deployed forward, at a SHA.', 'Roll back or restore each app on its own.');
  }
  if (input.dryRun === true) {
    return refusal('invalid_request', 'Group dry runs are not supported.', 'Dry-run each member of the group on its own.');
  }
  const sha = input.sha;

  const actor = caller.actor;
  if (actor === undefined) return refusal('unauthenticated', 'You are not signed in.');

  const members = await membersOf(db, group);
  if (members.length === 0) {
    return refusal('not_found', `No app reported by the agent belongs to group ${group}.`, "Check the group name in the members' manifests.");
  }
  const canaries = members.filter((m) => m.canary);
  if (canaries.length > 1) {
    return refusal(
      'manifest_invalid',
      `Group ${group} declares more than one canary: ${canaries.map((m) => m.name).join(', ')}.`,
      'Mark exactly one member of the group as its canary, or none.',
    );
  }
  const canary = canaries[0]?.name ?? null;

  // Authorisation first, for every member: a token must be scoped to the whole group.
  for (const member of members) {
    const denied = callerCanActOn(caller, member.name);
    if (denied !== null) return denied;
  }

  let label: string;
  if (actor.type === 'token') {
    if (input.requester === undefined) {
      return refusal(
        'invalid_request',
        'A deploy requested with a token must name its requester.',
        'Send requester { label, repo, branch } — the label is shown to anyone this deploy locks out.',
      );
    }
    label = input.requester.label;
    // A token request is not held for approval as a group: it is refused, naming the member.
    const needsApproval = members.find((m) => m.approvalPolicy === 'required');
    if (needsApproval !== undefined) {
      return refusal(
        'approval_required',
        `${needsApproval.name} in group ${group} requires a deployer's approval, so the group cannot be deployed with a token.`,
        'Ask a deployer to deploy the group from the console.',
      );
    }
  } else {
    label = input.requester?.label ?? `${actor.label} (console)`;
  }

  for (const member of members) {
    const frozen = await assertNotFrozen(db, member.name);
    if (frozen !== null) return frozen;
    const notDeployable = await check(db, member.name);
    if (notDeployable !== null) return notDeployable;
  }

  const base = Date.now();
  const data: Prisma.DeployCreateInput = {
    kind: 'deploy',
    requestedSha: sha,
    dryRun: false,
    groupName: group,
    requesterLabel: label,
    ...(input.requester !== undefined ? { requesterRepo: input.requester.repo, requesterBranch: input.requester.branch } : {}),
    ...(actor.type === 'user' && actor.id !== undefined ? { requesterUser: { connect: { id: actor.id } } } : {}),
    ...(actor.type === 'token' && actor.id !== undefined ? { requesterToken: { connect: { id: actor.id } } } : {}),
    targets: {
      create: members.map((member, position) => {
        const meta: GroupMeta = { name: group, position, canary: member.name === canary };
        return {
          app: { connect: { id: member.id } },
          state: 'locked' as const,
          // Deploy order is creation order: dispatch walks a deploy's targets by created_at.
          createdAt: new Date(base + position),
          result: { group: { ...meta } },
        };
      }),
    },
  };

  let deployId: string | undefined;
  for (let attempt = 0; attempt < 2 && deployId === undefined; attempt += 1) {
    try {
      // One nested create, one transaction: every member's lock is taken, or none is.
      const row = await db.deploy.create({ data, select: { id: true } });
      deployId = row.id;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      for (const member of members) {
        const locked = await lockRefusal(db, member.name, member.id);
        if (locked !== null) return locked;
      }
    }
  }
  if (deployId === undefined) {
    return refusal('locked', `A member of group ${group} is being deployed by someone else.`);
  }

  await caller.audit({
    action: 'deploy.requested',
    entityType: 'deploy',
    entityId: deployId,
    after: {
      group,
      members: members.map((m) => m.name),
      canary,
      kind: 'deploy',
      sha,
      dryRun: false,
      state: 'locked',
      requester: { label, repo: input.requester?.repo ?? null, branch: input.requester?.branch ?? null },
    },
  });
  bus.publish('work');
  return { deployId, state: 'locked' };
}

/**
 * After a group member ended without succeeding: cancels every later member still waiting, with
 * `group_stopped` naming the member that stopped the group. Run inside the transaction that records
 * the member's result. Returns the names of the members cancelled.
 */
export async function stopGroupAfter(
  tx: DbClient,
  stopped: { deployId: string; targetId: string; app: string; state: DeployTargetState },
): Promise<string[]> {
  const targets = await tx.deployTarget.findMany({
    where: { deployId: stopped.deployId },
    select: { id: true, state: true, createdAt: true, app: { select: { name: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const at = targets.findIndex((t) => t.id === stopped.targetId);
  if (at < 0) return [];
  const later = targets.slice(at + 1).filter((t) => !TERMINAL_STATES.includes(t.state));
  if (later.length === 0) return [];
  const why = refusal(
    'group_stopped',
    `The group deploy stopped at ${stopped.app} (${stopped.state}); this member was not touched.`,
  );
  const now = new Date();
  await tx.deployTarget.updateMany({
    where: { id: { in: later.map((t) => t.id) }, state: { notIn: [...TERMINAL_STATES] } },
    data: { state: 'cancelled', refusal: why, endedAt: now },
  });
  return later.map((t) => t.app.name);
}

/**
 * The digests a group member must match (SHP-REQ-079): the canary's recorded digests, by service
 * name, for the services this member maps. Undefined for anything but a later member of a group
 * deploy whose canary has succeeded.
 */
export async function expectedDigestsFor(db: DbClient, targetId: string): Promise<Record<string, string> | undefined> {
  const row = await db.deployTarget.findUnique({
    where: { id: targetId },
    select: { deployId: true, result: true, app: { select: { services: true } }, deploy: { select: { groupName: true, dryRun: true } } },
  });
  if (row === null || row.deploy.groupName === null || row.deploy.dryRun) return undefined;
  const self = readGroupMeta(row.result);
  if (self === null || self.canary) return undefined;

  const first = await db.deployTarget.findFirst({
    where: { deployId: row.deployId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, state: true, result: true, images: { select: { service: true, digest: true } } },
  });
  if (first === null || first.id === targetId || first.state !== 'succeeded') return undefined;
  if (readGroupMeta(first.result)?.canary !== true) return undefined;

  const services = row.app.services;
  const mapped =
    typeof services === 'object' && services !== null && !Array.isArray(services) ? new Set(Object.keys(services)) : null;
  const expect: Record<string, string> = {};
  for (const image of first.images) {
    if (mapped === null || mapped.has(image.service)) expect[image.service] = image.digest;
  }
  return Object.keys(expect).length === 0 ? undefined : expect;
}

/** The first member not yet succeeded decides a group's overall state. */
export function groupState(members: readonly { state: DeployTargetState }[]): DeployTargetState {
  const pending = members.find((m) => m.state !== 'succeeded');
  return pending?.state ?? 'succeeded';
}

/** A group deploy's status with every member in deploy order, or null if `deployId` is not a group deploy. */
export async function getGroupDeployStatus(db: Db, deployId: string): Promise<GroupDeployStatus | null> {
  const deploy = await db.deploy.findUnique({ where: { id: deployId }, select: { groupName: true, requestedSha: true } });
  if (deploy === null || deploy.groupName === null) return null;
  const rows = await db.deployTarget.findMany({
    where: { deployId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { result: true, app: { select: { name: true } } },
  });
  const members: DeployStatus[] = await getDeployStatuses(db, deployId);
  const canaryRow = rows.find((r) => readGroupMeta(r.result)?.canary === true);
  return {
    deployId,
    group: deploy.groupName,
    sha: deploy.requestedSha,
    canary: canaryRow?.app.name ?? null,
    state: groupState(members),
    members,
  };
}

/** True once a group deploy can change no further. */
export function groupDone(status: GroupDeployStatus): boolean {
  return status.members.every((m) => TERMINAL_STATES.includes(m.state));
}

/**
 * The group deploy's status once it changes, or after `waitSeconds` (capped at 90). The wait is
 * armed before the first read, so a publish in between is not lost.
 */
export async function waitForGroupChange(
  deps: ServiceDeps,
  deployId: string,
  waitSeconds: number,
  signal?: AbortSignal,
): Promise<GroupDeployStatus | null> {
  const seconds = Math.max(0, Math.min(90, waitSeconds));
  if (seconds === 0) return getGroupDeployStatus(deps.db, deployId);
  const stop = new AbortController();
  const combined = signal === undefined ? stop.signal : AbortSignal.any([signal, stop.signal]);
  const woken = deps.bus.wait(`deploy:${deployId}`, seconds * 1000, combined);
  try {
    const first = await getGroupDeployStatus(deps.db, deployId);
    if (first === null || groupDone(first)) return first;
    await woken;
    if (signal?.aborted === true) return first;
    return await getGroupDeployStatus(deps.db, deployId);
  } finally {
    stop.abort();
    await woken;
  }
}
