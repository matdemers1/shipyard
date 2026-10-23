import { z } from 'zod';
import {
  AgentStackService,
  Digest,
  Refusal as RefusalSchema,
  StackManifest,
  StackUpdateJob,
  StackUpdateResult,
  StackUpdateStep,
  refusal,
  type Refusal,
  type StackRollbackRequest,
  type StackTrack,
  type StackUpdatePage,
  type StackUpdateProgress,
  type StackUpdateRequest,
  type StackUpdateState,
  type StackUpdateStatus,
} from '@shipyard/schema';
import { actionRequesterLabel } from '../actions/service.js';
import { capabilityRefusal } from '../agent/capabilities.js';
import type { Decider } from '../approvals/service.js';
import { STATE_CHANGING_ROLES } from '../auth/scope.js';
import { directAudit } from '../builds/service.js';
import type { Db, Prisma } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { isUniqueViolation, type DeployCaller } from '../deploys/service.js';
import { decodeCursor, encodeCursor } from '../deploys/timeline.js';
import { snapshotContainers } from '../host/index.js';
import { restoreLockRefusal } from '../maintenance/lock.js';
import { notifyStackAwaitingApproval } from '../push/notify.js';

/**
 * Stack updates, server side (SHP-ADR-010; SHP-REQ-195, SHP-REQ-199, SHP-REQ-200).
 *
 * An adopted stack whose manifest says `updates: digest` may be moved to new image digests, one
 * service at a time on the host. The server never touches Docker: it checks who is asking and what
 * they name, records the update — `queued`, or `awaiting_approval` when the stack's approval policy
 * holds it — and hands it to the owning agent's long poll once that agent advertises
 * `stack-updates`. What reaches the host is a stack name the host's own manifest defines and, per
 * tracked service, a `sha256:` digest; the agent re-resolves each track and refuses a digest it does
 * not resolve to now (`digest_not_tracked`, SHP-REQ-195). A rollback names an earlier update of the
 * same stack, and the agent takes the digests from its own ledger, never from the request
 * (non-negotiable 7).
 *
 * Every update is kept with who asked, the digests before and after, and the outcome (SHP-REQ-200).
 *
 * Refused here, before anything is recorded:
 * - a viewer, or a token's owner who is one, or a token whose scope does not name the stack
 *   (`forbidden` — deployer and above, tokens within scope);
 * - a name that is an app, an Observed compose project (`not_adopted`) or nothing (`unknown_app`);
 * - a stack adopted with `updates: none` (`updates_disabled`);
 * - a service that is not tracked, or is pinned (`digest_not_tracked`), or no candidate to move to;
 * - a stack another update or rollback, or a lifecycle action, is already working on (`locked`);
 * - an owning agent that is not polling (`agent_offline`) or never advertised `stack-updates`
 *   (`agent_too_old`), so nothing waits forever for a poll that will never take it;
 * - for a rollback, a target that is not an earlier succeeded update of this stack
 *   (`rollback_target_invalid`).
 */

/** A dispatched update with no word from the agent for this long (plus the stack's soak) is failed. */
export const STACK_UPDATE_STALE_MS = 30 * 60_000;
/** The longest `waitForStackUpdate`. */
export const MAX_STACK_UPDATE_WAIT_MS = 90_000;
/** A held update or rollback unanswered for this long expires, like a held deploy (SHP-REQ-061). */
export const STACK_APPROVAL_TTL_MS = 60 * 60_000;
export const STACK_APPROVAL_EXPIRED_MESSAGE = 'approval expired after one hour; request the update again';
/** What `requesterLabel` is cut to: the agent's job allows no more (StackUpdateJob). */
export const STACK_REQUESTER_LABEL_MAX = 200;

/**
 * The states that hold a stack: at most one update or rollback in one of them per stack, enforced by
 * the `stack_update_one_active_per_stack` partial unique index (keep the two in sync by hand). An
 * update awaiting approval holds nothing, like a held deploy.
 */
export const ACTIVE_STACK_UPDATE_STATES = ['queued', 'dispatched', 'running'] as const satisfies readonly StackUpdateState[];
export const TERMINAL_STACK_UPDATE_STATES: readonly StackUpdateState[] = ['succeeded', 'failed', 'rolled_back', 'refused', 'denied', 'cancelled'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DigestMap = z.record(z.string(), Digest);
const StackImages = StackUpdateResult.shape.images;
const ServicesMirror = z.record(z.string(), AgentStackService);

type DigestManifest = Extract<StackManifest, { updates: 'digest' }>;

export const STACK_UPDATE_SELECT = {
  id: true,
  stackId: true,
  stackName: true,
  agentId: true,
  kind: true,
  state: true,
  step: true,
  digests: true,
  toUpdateId: true,
  images: true,
  previous: true,
  soakSeconds: true,
  requesterLabel: true,
  decidedByLabel: true,
  refusal: true,
  dispatchedAt: true,
  startedAt: true,
  endedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.StackUpdateSelect;

export type StackUpdateRow = Prisma.StackUpdateGetPayload<{ select: typeof STACK_UPDATE_SELECT }>;

/** The REST/MCP view of a stack update row. */
export function toStackUpdateStatus(row: StackUpdateRow): StackUpdateStatus {
  const stored = RefusalSchema.safeParse(row.refusal);
  const step = StackUpdateStep.safeParse(row.step);
  const digests = DigestMap.safeParse(row.digests);
  const images = StackImages.safeParse(row.images);
  const previous = StackImages.safeParse(row.previous);
  return {
    id: row.id,
    stack: row.stackName,
    kind: row.kind,
    state: row.state,
    step: step.success ? step.data : null,
    digests: digests.success ? digests.data : null,
    images: images.success ? images.data : [],
    previous: previous.success ? previous.data : [],
    toUpdateId: row.toUpdateId,
    requesterLabel: row.requesterLabel,
    // A denial names who denied it in the refusal; approvedBy is only for an approval.
    approvedBy: row.state === 'denied' ? null : row.decidedByLabel,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    refusal: stored.success ? stored.data : null,
  };
}

export function isStackUpdateTerminal(state: StackUpdateState): boolean {
  return TERMINAL_STACK_UPDATE_STATES.includes(state);
}

/** Null when the caller may update (or roll back) `stack`; otherwise the refusal. */
export function stackUpdatePermissionRefusal(caller: Pick<DeployCaller, 'actor' | 'role' | 'tokenStacks'>, stack: string): Refusal | null {
  const actor = caller.actor;
  if (actor === undefined) return refusal('unauthenticated', 'You are not signed in.');
  if (actor.type !== 'user' && actor.type !== 'token') return refusal('forbidden', `A ${actor.type} actor cannot update a stack.`);
  if (caller.role === undefined || !STATE_CHANGING_ROLES.includes(caller.role)) {
    return refusal('forbidden', 'The viewer role cannot update or roll back a stack.', 'Ask an admin for the deployer role.');
  }
  if (actor.type === 'token' && caller.tokenStacks?.has(stack) !== true) {
    return refusal('forbidden', `This token is not scoped to ${stack}.`, `Use a token issued for ${stack}, or issue a new one that names it.`);
  }
  return null;
}

/** Whether the stack's approval policy holds a request from this kind of actor (SHP-REQ-199). */
export function approvalHolds(policy: DigestManifest['approval'], actorType: 'user' | 'token'): boolean {
  if (policy === 'always') return true;
  if (policy === 'never') return false;
  return actorType === 'token';
}

interface ResolvedStack {
  id: string;
  name: string;
  agentId: string;
  manifest: DigestManifest;
  services: z.infer<typeof ServicesMirror>;
}

/** The manifest a stack row carries, or null when it does not parse (an older mirror, a test seed). */
export function parseStackManifest(json: string): StackManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = StackManifest.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The tracked services the agent last reported for a stack; empty when it reported none. */
export function parseServicesMirror(json: Prisma.JsonValue | null): z.infer<typeof ServicesMirror> {
  const parsed = ServicesMirror.safeParse(json);
  return parsed.success ? parsed.data : {};
}

/** The adopted, digest-updated stack the agent reports under `name`, or the refusal saying why not. */
async function resolveStack(db: Db, name: string): Promise<ResolvedStack | Refusal> {
  const row = await db.stack.findFirst({
    where: { name, retiredAt: null },
    select: { id: true, name: true, agentId: true, manifestJson: true, services: true },
  });
  if (row === null) {
    const app = await db.app.findFirst({ where: { name, retiredAt: null }, select: { id: true } });
    if (app !== null) return refusal('unknown_app', `${name} is a Deployed app, not an adopted stack.`, 'Deploy a SHA of it instead.');
    const observed = (await snapshotContainers(db)).some((c) => c.container.compose?.project === name);
    if (observed) return refusal('not_adopted', `${name} is a compose project Shipyard only observes.`);
    return refusal('unknown_app', `No adopted stack named ${name} has been reported by the agent.`);
  }
  const manifest = parseStackManifest(row.manifestJson);
  if (manifest?.updates !== 'digest') {
    return refusal('updates_disabled', `${name} is adopted with updates: none; Shipyard only starts, stops, restarts and recreates it.`);
  }
  return { id: row.id, name: row.name, agentId: row.agentId, manifest, services: parseServicesMirror(row.services) };
}

function isPinned(track: StackTrack): boolean {
  return track === 'pinned';
}

/**
 * The digests to ask for: the caller's, each for a tracked, unpinned service; or, without any, the
 * candidates the agent last reported (SHP-REQ-195 — the agent re-checks each one when it runs).
 */
export function digestsFor(
  stack: Pick<ResolvedStack, 'name' | 'manifest' | 'services'>,
  requested: StackUpdateRequest['digests'],
): { digests: Record<string, string> } | { refusal: Refusal } {
  const tracked = stack.manifest.services;
  const names = Object.keys(tracked).sort();
  if (requested !== undefined) {
    const entries = Object.entries(requested);
    if (entries.length === 0) {
      return { refusal: refusal('invalid_request', 'digests names no service.', 'Leave digests out to update to the reported candidates, or name at least one service.') };
    }
    for (const [service] of entries) {
      // Own keys only: the names come from the request, and `constructor` or `toString` must not
      // resolve to something on Object.prototype and pass for a tracked service (SHP-REQ-195).
      const spec = Object.hasOwn(tracked, service) ? tracked[service] : undefined;
      if (spec === undefined) {
        return {
          refusal: refusal('digest_not_tracked', `${service} is not a tracked service of ${stack.name}.`, `Name only services the stack's manifest tracks: ${names.join(', ')}.`),
        };
      }
      if (isPinned(spec.track)) {
        return {
          refusal: refusal('digest_not_tracked', `${service} of ${stack.name} is pinned; Shipyard never moves it.`, "Change its track in the stack's manifest on the host to update it here."),
        };
      }
    }
    return { digests: Object.fromEntries(entries) };
  }
  const digests: Record<string, string> = {};
  for (const service of names) {
    const spec = tracked[service];
    const candidate = (Object.hasOwn(stack.services, service) ? stack.services[service]?.candidate : null) ?? null;
    if (spec !== undefined && !isPinned(spec.track) && candidate !== null) digests[service] = candidate.digest;
  }
  if (Object.keys(digests).length === 0) {
    return {
      refusal: refusal('conflict', `${stack.name} has no update candidate: every tracked service runs what its track resolves to.`, 'Wait for the agent to report a candidate, then request again.'),
    };
  }
  return { digests };
}

/** `locked` while another update or rollback of the stack is active, or a lifecycle action on it is. */
export async function stackLockRefusal(db: Db, stack: { id: string; name: string }): Promise<Refusal | null> {
  const holder = await db.stackUpdate.findFirst({
    where: { stackId: stack.id, state: { in: [...ACTIVE_STACK_UPDATE_STATES] } },
    select: { id: true, kind: true, state: true, step: true, requesterLabel: true },
  });
  if (holder !== null) {
    const what = holder.kind === 'rollback' ? 'rolled back' : 'updated';
    return refusal(
      'locked',
      `${stack.name} is being ${what} by ${holder.requesterLabel}: ${holder.step ?? holder.state}.`,
      `Wait for stack update ${holder.id} to finish, then request again; Shipyard does not queue stack updates.`,
    );
  }
  const action = await db.action.findFirst({
    where: { targetKind: 'stack', targetName: stack.name, state: { in: ['queued', 'dispatched', 'running'] } },
    select: { id: true, verb: true, requesterLabel: true },
  });
  if (action !== null) {
    return refusal('locked', `${stack.name} has a ${action.verb} by ${action.requesterLabel} in progress.`, `Wait for action ${action.id} to finish, then request again.`);
  }
  // SHP-T-17.3: a volume restore of the stack holds it too (SHP-REQ-202).
  return restoreLockRefusal(db, { kind: 'stack', name: stack.name });
}

interface QueueInput {
  kind: 'update' | 'rollback';
  digests?: Record<string, string>;
  toUpdateId?: string;
  requester?: StackUpdateRequest['requester'];
}

/** Records a checked update or rollback: queued, or held for approval by the stack's policy. */
async function queueStackUpdate(deps: ServiceDeps, caller: DeployCaller, stack: ResolvedStack, input: QueueInput): Promise<StackUpdateStatus | Refusal> {
  const { db, bus } = deps;
  const actor = caller.actor;
  if (actor === undefined || (actor.type !== 'user' && actor.type !== 'token')) return refusal('unauthenticated', 'You are not signed in.');

  const locked = await stackLockRefusal(db, stack);
  if (locked !== null) return locked;
  const cannot = capabilityRefusal(bus, stack.agentId, 'stack-updates');
  if (cannot !== null) return cannot;

  // SHP-REQ-199: `tokens` (the default) holds a token's request, `always` every request.
  const held = approvalHolds(stack.manifest.approval, actor.type);
  const requesterLabel = actionRequesterLabel(actor, input.requester?.label).slice(0, STACK_REQUESTER_LABEL_MAX);
  let row: StackUpdateRow;
  try {
    row = await db.stackUpdate.create({
      data: {
        stackId: stack.id,
        stackName: stack.name,
        agentId: stack.agentId,
        kind: input.kind,
        state: held ? 'awaiting_approval' : 'queued',
        ...(input.digests === undefined ? {} : { digests: input.digests }),
        ...(input.toUpdateId === undefined ? {} : { toUpdateId: input.toUpdateId }),
        soakSeconds: stack.manifest.soakSeconds,
        requesterLabel,
        requesterRepo: input.requester?.repo ?? null,
        requesterBranch: input.requester?.branch ?? null,
        ...(held ? { heldAt: new Date() } : {}),
        ...(actor.type === 'user' && actor.id !== undefined ? { requesterUserId: actor.id } : {}),
        ...(actor.type === 'token' && actor.id !== undefined ? { requesterTokenId: actor.id } : {}),
      },
      select: STACK_UPDATE_SELECT,
    });
  } catch (err) {
    // Two requests raced past the check: the partial unique index lets one through.
    if (!isUniqueViolation(err)) throw err;
    return (await stackLockRefusal(db, stack)) ?? refusal('locked', `${stack.name} is being updated by someone else.`, 'Wait for that update to finish, then request again.');
  }

  await caller.audit({
    action: 'stack_update.request',
    entityType: 'stack_update',
    entityId: row.id,
    after: {
      stack: stack.name,
      kind: input.kind,
      ...(input.digests === undefined ? {} : { digests: input.digests }),
      ...(input.toUpdateId === undefined ? {} : { toUpdateId: input.toUpdateId }),
      requester: { label: requesterLabel, repo: input.requester?.repo ?? null, branch: input.requester?.branch ?? null },
      approval: stack.manifest.approval,
      state: row.state,
    },
  });
  deps.logger.info({ stackUpdateId: row.id, stack: stack.name, kind: input.kind, state: row.state }, held ? 'stack update held for approval' : 'stack update queued');
  bus.publish(`stack-update:${row.id}`);
  if (held) {
    // The phones of whoever may approve it — after the answer, never instead of it (SHP-T-11.5).
    void notifyStackAwaitingApproval(deps, { updateId: row.id, stack: stack.name, kind: input.kind }).catch((error: unknown) => {
      deps.logger.warn({ err: error instanceof Error ? error.message : String(error), stackUpdateId: row.id }, 'stack approval push failed');
    });
  } else {
    bus.publish('work');
  }
  return toStackUpdateStatus(row);
}

/**
 * Requests an update of `stackName` to the digests asked for, or to the candidates the agent last
 * reported (SHP-REQ-195). On success it is `queued` (the owning agent's poll is woken) or
 * `awaiting_approval`, and audited as `stack_update.request`. The MCP tool calls this.
 */
export async function requestStackUpdate(deps: ServiceDeps, caller: DeployCaller, stackName: string, input: StackUpdateRequest): Promise<StackUpdateStatus | Refusal> {
  const denied = stackUpdatePermissionRefusal(caller, stackName);
  if (denied !== null) return denied;
  const stack = await resolveStack(deps.db, stackName);
  if ('code' in stack) return stack;
  const chosen = digestsFor(stack, input.digests);
  if ('refusal' in chosen) return chosen.refusal;
  return queueStackUpdate(deps, caller, stack, { kind: 'update', digests: chosen.digests, ...(input.requester === undefined ? {} : { requester: input.requester }) });
}

/**
 * Requests a rollback of `stackName` to an earlier succeeded update of it; the agent takes the
 * digests from its own ledger (non-negotiable 7). The same roles, scope, lock and approval policy
 * as an update.
 */
export async function requestStackRollback(deps: ServiceDeps, caller: DeployCaller, stackName: string, input: StackRollbackRequest): Promise<StackUpdateStatus | Refusal> {
  const denied = stackUpdatePermissionRefusal(caller, stackName);
  if (denied !== null) return denied;
  const stack = await resolveStack(deps.db, stackName);
  if ('code' in stack) return stack;
  const invalid = refusal(
    'rollback_target_invalid',
    `${input.toUpdateId} is not an earlier successful update of ${stackName}.`,
    `Choose an earlier succeeded update from GET /api/stacks/${stackName}/updates.`,
  );
  const target = await deps.db.stackUpdate.findUnique({ where: { id: input.toUpdateId }, select: { id: true, stackId: true, state: true, createdAt: true } });
  if (target?.stackId !== stack.id || target.state !== 'succeeded') return invalid;
  // What runs now is the newest success: rolling back to it would change nothing.
  const newest = await deps.db.stackUpdate.findFirst({
    where: { stackId: stack.id, state: 'succeeded' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
  if (newest?.id === target.id) {
    return refusal('rollback_target_invalid', `${input.toUpdateId} is what ${stackName} runs now.`, 'Choose an earlier succeeded update to roll back to.');
  }
  return queueStackUpdate(deps, caller, stack, { kind: 'rollback', toUpdateId: target.id, ...(input.requester === undefined ? {} : { requester: input.requester }) });
}

// ─── Approval (SHP-REQ-199) ──────────────────────────────────────────────

/** Only a signed-in deployer, operator or admin decides; never a token (SHP-D-072). */
function deciderRefusal(decider: Decider): Refusal | null {
  const actor = decider.actor;
  if (actor === undefined) return refusal('unauthenticated', 'You are not signed in.');
  if (actor.type !== 'user') {
    return refusal('forbidden', 'Approvals are given in the console, not with a token.', 'Sign in to the console as a deployer and approve it there.');
  }
  if (decider.role === undefined || !STATE_CHANGING_ROLES.includes(decider.role)) {
    return refusal('forbidden', 'The viewer role cannot approve or deny a stack update.', 'Ask an admin for the deployer role.');
  }
  return null;
}

const NO_SUCH_HELD = refusal('not_found', 'No stack update awaiting approval has that ID.', 'List what needs you and use one of its stack update IDs.');

/**
 * The held update, or why it cannot be decided. Lazily expires first, so one past its hour can never
 * be approved (SHP-REQ-061), and refuses one whose stack is no longer the adopted stack it was
 * requested for — retired, or not the row that name is adopted as now.
 */
async function loadHeld(deps: Pick<ServiceDeps, 'db' | 'bus' | 'logger'>, id: string): Promise<StackUpdateRow | Refusal> {
  const { db } = deps;
  if (!UUID_RE.test(id)) return NO_SUCH_HELD;
  await expireHeldStackUpdates(deps);
  const row = await db.stackUpdate.findUnique({ where: { id }, select: STACK_UPDATE_SELECT });
  if (row === null) return NO_SUCH_HELD;
  if (row.state === 'cancelled') {
    const stored = RefusalSchema.safeParse(row.refusal);
    if (stored.success) return stored.data;
  }
  if (row.state !== 'awaiting_approval') return refusal('conflict', `This stack update is ${row.state}, not awaiting approval.`);
  const adopted = await db.stack.findFirst({ where: { name: row.stackName, retiredAt: null }, select: { id: true } });
  if (adopted?.id !== row.stackId) {
    return refusal(
      'conflict',
      `${row.stackName} is no longer adopted as the stack this update was requested for.`,
      'Request the update again against the stack as it is adopted now; this one expires on its own.',
    );
  }
  return row;
}

const EXPIRY_ACTOR = { type: 'system', label: 'shipyard: stack approval expiry' } as const;

/**
 * Expires every held update or rollback whose hour is up (as of `now`), like `expireApprovals` does
 * for deploys (SHP-REQ-061): it ends `cancelled` with an `approval_required` refusal saying so,
 * audited `stack_update.expired` as the system, and anyone waiting on it is woken. Returns the IDs.
 */
export async function expireHeldStackUpdates(deps: Pick<ServiceDeps, 'db' | 'bus' | 'logger'>, now: Date = new Date()): Promise<string[]> {
  const { db, bus, logger } = deps;
  const due = await db.stackUpdate.findMany({
    where: { state: 'awaiting_approval', heldAt: { lte: new Date(now.getTime() - STACK_APPROVAL_TTL_MS) } },
    select: { id: true, stackName: true, kind: true },
  });
  const expired: string[] = [];
  for (const row of due) {
    // Conditional on still being held, so a concurrent approve or deny wins cleanly.
    const marked = await db.stackUpdate.updateMany({
      where: { id: row.id, state: 'awaiting_approval' },
      data: {
        state: 'cancelled',
        endedAt: now,
        refusal: refusal('approval_required', STACK_APPROVAL_EXPIRED_MESSAGE, 'Request the update again, and ask a deployer to approve it within the hour.'),
      },
    });
    if (marked.count === 0) continue;
    expired.push(row.id);
    await directAudit(db, EXPIRY_ACTOR)({
      action: 'stack_update.expired',
      entityType: 'stack_update',
      entityId: row.id,
      before: { state: 'awaiting_approval' },
      after: { state: 'cancelled', refusal: 'approval_required', stack: row.stackName, kind: row.kind },
    });
    bus.publish(`stack-update:${row.id}`);
  }
  if (expired.length > 0) logger.info({ stackUpdateIds: expired }, 'stack update approvals expired');
  return expired;
}

/**
 * Approves a held update or rollback: it moves to `queued`, where the agent's poll picks it up.
 * The request-time checks run again — the stack may have been un-adopted, locked by someone else,
 * or its agent gone while it waited.
 */
export async function approveStackUpdate(deps: ServiceDeps, decider: Decider, id: string): Promise<StackUpdateStatus | Refusal> {
  const { db, bus } = deps;
  const denied = deciderRefusal(decider);
  if (denied !== null) return denied;
  const row = await loadHeld(deps, id);
  if ('code' in row) return row;
  const stack = await resolveStack(db, row.stackName);
  if ('code' in stack) return stack;
  const locked = await stackLockRefusal(db, stack);
  if (locked !== null) return locked;
  const cannot = capabilityRefusal(bus, row.agentId, 'stack-updates');
  if (cannot !== null) return cannot;

  const label = decider.actor?.label ?? 'a deployer';
  const userId = decider.actor?.id;
  let moved: number;
  try {
    const result = await db.stackUpdate.updateMany({
      where: { id: row.id, state: 'awaiting_approval' },
      data: { state: 'queued', decidedAt: new Date(), decidedByLabel: label, ...(userId === undefined ? {} : { decidedByUserId: userId }) },
    });
    moved = result.count;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return (await stackLockRefusal(db, stack)) ?? refusal('locked', `${stack.name} is being updated by someone else.`, 'Approve it again once that update finishes.');
  }
  if (moved === 0) return refusal('conflict', 'This stack update was decided while you were approving it.');

  await decider.audit({
    action: 'stack_update.approved',
    entityType: 'stack_update',
    entityId: row.id,
    before: { state: 'awaiting_approval' },
    after: { stack: row.stackName, kind: row.kind, state: 'queued' },
  });
  deps.logger.info({ stackUpdateId: row.id, stack: row.stackName }, 'stack update approved');
  bus.publish('work');
  bus.publish(`stack-update:${row.id}`);
  return toStackUpdateStatus(await db.stackUpdate.findUniqueOrThrow({ where: { id: row.id }, select: STACK_UPDATE_SELECT }));
}

/** Denies a held update or rollback: it ends `denied`, with an `approval_required` refusal naming who. */
export async function denyStackUpdate(deps: ServiceDeps, decider: Decider, id: string): Promise<StackUpdateStatus | Refusal> {
  const { db, bus } = deps;
  const denied = deciderRefusal(decider);
  if (denied !== null) return denied;
  const row = await loadHeld(deps, id);
  if ('code' in row) return row;
  const label = decider.actor?.label ?? 'a deployer';
  const userId = decider.actor?.id;
  const now = new Date();
  const result = await db.stackUpdate.updateMany({
    where: { id: row.id, state: 'awaiting_approval' },
    data: {
      state: 'denied',
      endedAt: now,
      decidedAt: now,
      decidedByLabel: label,
      ...(userId === undefined ? {} : { decidedByUserId: userId }),
      refusal: refusal('approval_required', `denied by ${label}`, 'Ask a deployer why, then request the update again if it should go out.'),
    },
  });
  if (result.count === 0) return refusal('conflict', 'This stack update was decided while you were denying it.');
  await decider.audit({
    action: 'stack_update.denied',
    entityType: 'stack_update',
    entityId: row.id,
    before: { state: 'awaiting_approval' },
    after: { stack: row.stackName, kind: row.kind, state: 'denied' },
  });
  deps.logger.info({ stackUpdateId: row.id, stack: row.stackName }, 'stack update denied');
  bus.publish(`stack-update:${row.id}`);
  return toStackUpdateStatus(await db.stackUpdate.findUniqueOrThrow({ where: { id: row.id }, select: STACK_UPDATE_SELECT }));
}

// ─── Reading ─────────────────────────────────────────────────────────────

/** The stack update, or null when there is no such update. */
export async function getStackUpdate(db: Db, id: string): Promise<StackUpdateStatus | null> {
  if (!UUID_RE.test(id)) return null;
  const row = await db.stackUpdate.findUnique({ where: { id }, select: STACK_UPDATE_SELECT });
  return row === null ? null : toStackUpdateStatus(row);
}

/**
 * The stack update once it reaches a terminal state, or as it stands after `timeoutMs` (capped at
 * `MAX_STACK_UPDATE_WAIT_MS`), whichever is first. Null when there is no such update. The wait is
 * armed before each read, so a publish between the read and the wait is not lost.
 */
export async function waitForStackUpdate(deps: ServiceDeps, id: string, timeoutMs: number, signal?: AbortSignal): Promise<StackUpdateStatus | null> {
  const deadline = Date.now() + Math.max(0, Math.min(MAX_STACK_UPDATE_WAIT_MS, timeoutMs));
  const aborted = (): boolean => signal?.aborted === true;
  for (;;) {
    await sweepStaleStackUpdates(deps);
    const stop = new AbortController();
    const remaining = deadline - Date.now();
    const combined = signal === undefined ? stop.signal : AbortSignal.any([signal, stop.signal]);
    const woken = remaining > 0 ? deps.bus.wait(`stack-update:${id}`, remaining, combined) : null;
    try {
      const status = await getStackUpdate(deps.db, id);
      if (status === null || isStackUpdateTerminal(status.state) || woken === null || aborted()) return status;
      await woken;
      if (aborted() || Date.now() >= deadline) return await getStackUpdate(deps.db, id);
    } finally {
      stop.abort();
      if (woken !== null) await woken;
    }
  }
}

export interface ListStackUpdatesOptions {
  limit: number;
  cursor?: string;
  /** One stack's history (by its row ID). */
  stackId?: string;
  /** A token's scope: only the stacks it names. */
  scope?: ReadonlySet<string>;
}

/** Stack updates newest first, a page at a time: a stack's history, or Activity's source across stacks. */
export async function listStackUpdates(db: Db, options: ListStackUpdatesOptions): Promise<StackUpdatePage> {
  const and: Prisma.StackUpdateWhereInput[] = [];
  if (options.stackId !== undefined) and.push({ stackId: options.stackId });
  if (options.scope !== undefined) and.push({ stackName: { in: [...options.scope] } });
  if (options.cursor !== undefined) {
    const cur = decodeCursor(options.cursor);
    if (cur !== null) and.push({ OR: [{ createdAt: { lt: cur.createdAt } }, { createdAt: cur.createdAt, id: { lt: cur.id } }] });
  }
  const rows = await db.stackUpdate.findMany({
    where: and.length > 0 ? { AND: and } : {},
    select: STACK_UPDATE_SELECT,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: options.limit + 1,
  });
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    items: page.map(toStackUpdateStatus),
    nextCursor: rows.length > options.limit && last !== undefined ? encodeCursor(last.createdAt, last.id) : null,
  };
}

/** What waits on a person: held updates (oldest first), and each stack's newest failure not since fixed. */
export interface StackNeedsYou {
  approvals: StackUpdateStatus[];
  failed: StackUpdateStatus[];
}

/**
 * Needs you (SHP-ADR-006): every update or rollback held for approval, and per adopted stack the
 * newest update that failed or was rolled back — until a later one of that stack succeeds.
 */
export async function stackNeedsYou(db: Db, scope?: ReadonlySet<string>): Promise<StackNeedsYou> {
  const inScope: Prisma.StackUpdateWhereInput = scope === undefined ? {} : { stackName: { in: [...scope] } };
  const held = await db.stackUpdate.findMany({
    where: { state: 'awaiting_approval', stack: { retiredAt: null }, ...inScope },
    select: STACK_UPDATE_SELECT,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const outcomes = await db.stackUpdate.findMany({
    where: { state: { in: ['succeeded', 'failed', 'rolled_back'] }, stack: { retiredAt: null }, ...inScope },
    select: STACK_UPDATE_SELECT,
    orderBy: [{ stackId: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
    distinct: ['stackId'],
  });
  const failed = outcomes
    .filter((row) => row.state === 'failed' || row.state === 'rolled_back')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return { approvals: held.map(toStackUpdateStatus), failed: failed.map(toStackUpdateStatus) };
}

/** One tracked service of a stack, for the console. */
export interface StackServiceView {
  service: string;
  image: string;
  track: StackTrack;
  running: string | null;
  candidate: { tag: string; digest: string } | null;
  checkedAt: string | null;
  error: string | null;
}

/** An adopted stack as `GET /api/stacks` shows it. */
export interface StackView {
  name: string;
  composeProject: string;
  updates: 'none' | 'digest';
  approval: DigestManifest['approval'] | null;
  soakSeconds: number | null;
  /**
   * The manifest's backup step, so the console can name it in What happens. Only the service and the
   * first two argv words (the program and its subcommand), never the rest of the argv or artifactsDir.
   */
  backup: { service: string; argv: string[] } | null;
  services: StackServiceView[];
  reportedAt: string;
  /** The update or rollback queued, awaiting approval or running now, if any. */
  activeUpdate: StackUpdateStatus | null;
  /** The newest one that ended. */
  lastUpdate: StackUpdateStatus | null;
}

/** Every mirrored, unretired stack with its tracked services and candidates (a token: only its own). */
export async function listStacks(db: Db, scope?: ReadonlySet<string>): Promise<StackView[]> {
  const rows = await db.stack.findMany({
    where: { retiredAt: null, ...(scope === undefined ? {} : { name: { in: [...scope] } }) },
    select: { id: true, name: true, composeProject: true, manifestJson: true, services: true, reportedAt: true },
    orderBy: { name: 'asc' },
  });
  const ids = rows.map((r) => r.id);
  const active = await db.stackUpdate.findMany({
    where: { stackId: { in: ids }, state: { in: [...ACTIVE_STACK_UPDATE_STATES, 'awaiting_approval'] } },
    select: STACK_UPDATE_SELECT,
    orderBy: [{ stackId: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
    distinct: ['stackId'],
  });
  const ended = await db.stackUpdate.findMany({
    where: { stackId: { in: ids }, state: { in: [...TERMINAL_STACK_UPDATE_STATES] } },
    select: STACK_UPDATE_SELECT,
    orderBy: [{ stackId: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
    distinct: ['stackId'],
  });
  const activeBy = new Map(active.map((r) => [r.stackId, r]));
  const endedBy = new Map(ended.map((r) => [r.stackId, r]));
  return rows.map((row) => {
    const manifest = parseStackManifest(row.manifestJson);
    const mirror = parseServicesMirror(row.services);
    const digest = manifest?.updates === 'digest' ? manifest : null;
    const services: StackServiceView[] =
      digest === null
        ? []
        : Object.keys(digest.services)
            .sort()
            .flatMap((service) => {
              const spec = digest.services[service];
              if (spec === undefined) return [];
              const seen = mirror[service];
              return [
                {
                  service,
                  image: spec.image,
                  track: spec.track,
                  running: seen?.running ?? null,
                  candidate: seen?.candidate ?? null,
                  checkedAt: seen?.checkedAt ?? null,
                  error: seen?.error ?? null,
                },
              ];
            });
    const activeRow = activeBy.get(row.id);
    const endedRow = endedBy.get(row.id);
    return {
      name: row.name,
      composeProject: row.composeProject,
      updates: digest === null ? 'none' : 'digest',
      approval: digest?.approval ?? null,
      soakSeconds: digest?.soakSeconds ?? null,
      backup: digest?.steps?.backup === undefined ? null : { service: digest.steps.backup.service, argv: digest.steps.backup.argv.slice(0, 2) },
      services,
      reportedAt: row.reportedAt.toISOString(),
      activeUpdate: activeRow === undefined ? null : toStackUpdateStatus(activeRow),
      lastUpdate: endedRow === undefined ? null : toStackUpdateStatus(endedRow),
    };
  });
}

// ─── Dispatch (the agent's long poll) ──────────────────────────────────────

/**
 * Claims the oldest queued update for `agentId` (`queued → dispatched`) in one statement: `FOR
 * UPDATE SKIP LOCKED` means two concurrent polls never take the same one. One queued behind a
 * lifecycle action already running on that stack waits for the action to end.
 */
export async function claimStackUpdate(deps: Pick<ServiceDeps, 'db' | 'logger'>, agentId: string): Promise<StackUpdateJob | null> {
  const { db } = deps;
  const rows = await db.$queryRaw<{ id: string }[]>`
    update "stack_update" set "state" = 'dispatched', "dispatched_at" = now(), "updated_at" = now()
    where "id" = (
      select u."id" from "stack_update" u
      where u."agent_id" = ${agentId}::uuid
        and u."state" = 'queued'
        and not exists (
              select 1 from "action" a
              where a."target_kind" = 'stack'
                and a."target_name" = u."stack_name"
                and a."state" in ('dispatched', 'running'))
        and not exists (
              select 1 from "maintenance_job" m
              where m."kind" = 'volume-restore'
                and m."owner_kind" = 'stack'
                and m."owner_name" = u."stack_name"
                and m."state" in ('dispatched', 'running'))
      order by u."created_at", u."id"
      for update of u skip locked
      limit 1
    )
    returning "id"::text as "id"`;
  const id = rows[0]?.id;
  if (id === undefined) return null;
  const row = await db.stackUpdate.findUniqueOrThrow({ where: { id }, select: STACK_UPDATE_SELECT });
  const requesterLabel = row.requesterLabel.slice(0, STACK_REQUESTER_LABEL_MAX);
  const job = StackUpdateJob.safeParse(
    row.kind === 'rollback'
      ? { updateId: row.id, kind: 'rollback', stack: row.stackName, toUpdateId: row.toUpdateId, requesterLabel }
      : { updateId: row.id, kind: 'update', stack: row.stackName, digests: row.digests, requesterLabel },
  );
  if (job.success) return job.data;
  // Never handed out malformed: what the agent receives is validated like everything it sends.
  deps.logger.error({ stackUpdateId: row.id }, 'stored stack update does not make a valid job; failed');
  await db.stackUpdate.updateMany({
    where: { id: row.id, state: 'dispatched' },
    data: { state: 'failed', endedAt: new Date(), refusal: refusal('invalid_request', 'This stack update could not be handed to the agent.', 'Request the update again.') },
  });
  return null;
}

/** Puts a claimed update back, for a poll whose client went away before it could be answered. */
export async function releaseStackUpdate(db: Db, id: string): Promise<void> {
  await db.stackUpdate.updateMany({ where: { id, state: 'dispatched' }, data: { state: 'queued', dispatchedAt: null } });
}

/** The update, if it exists, was dispatched, and belongs to `agentId`. */
export async function ownStackUpdate(db: Db, agentId: string, id: string): Promise<StackUpdateRow | null> {
  if (!UUID_RE.test(id)) return null;
  const row = await db.stackUpdate.findUnique({ where: { id }, select: STACK_UPDATE_SELECT });
  if (row?.agentId !== agentId || row.dispatchedAt === null) return null;
  return row;
}

export type StackRecordOutcome = { accepted: boolean; status: StackUpdateStatus };

/** `dispatched → running`, with the step. Refused (not accepted) once it has ended. */
export async function recordStackUpdateProgress(deps: ServiceDeps, row: StackUpdateRow, body: StackUpdateProgress): Promise<StackRecordOutcome> {
  const { db, bus } = deps;
  if (isStackUpdateTerminal(row.state)) return { accepted: false, status: toStackUpdateStatus(row) };
  const updated = await db.stackUpdate.updateMany({
    where: { id: row.id, state: { in: ['dispatched', 'running'] } },
    // Every accepted report is a sign of life: updated_at moves, which the stale sweep reads.
    data: { state: 'running', step: body.step, ...(row.startedAt === null ? { startedAt: new Date() } : {}) },
  });
  const after = await db.stackUpdate.findUniqueOrThrow({ where: { id: row.id }, select: STACK_UPDATE_SELECT });
  if (updated.count === 0) return { accepted: false, status: toStackUpdateStatus(after) };
  bus.publish(`stack-update:${row.id}`);
  return { accepted: true, status: toStackUpdateStatus(after) };
}

/**
 * The terminal result, exactly once: a late or duplicate result is not accepted. Stores what runs
 * now and what ran before (SHP-REQ-200); a rollback's digests become what it restored.
 */
export async function recordStackUpdateResult(deps: ServiceDeps, row: StackUpdateRow, body: StackUpdateResult): Promise<StackRecordOutcome> {
  const { db, bus } = deps;
  const now = new Date();
  // A failure always carries a refusal, so the console has a next step to show.
  const why =
    body.refusal ??
    (body.state === 'rolled_back'
      ? refusal('health_failed', `The update of ${row.stackName} did not pass its health check and soak; the previous images were restored.`)
      : body.state === 'failed'
        ? refusal('step_failed', `The ${row.kind === 'rollback' ? 'rollback' : 'update'} of ${row.stackName} failed on the host.`)
        : body.state === 'refused'
          ? refusal('conflict', `The agent refused the ${row.kind === 'rollback' ? 'rollback' : 'update'} of ${row.stackName}.`)
          : undefined);
  const restored = row.kind === 'rollback' && body.state === 'succeeded' ? Object.fromEntries(body.images.map((i) => [i.service, i.digest])) : undefined;
  const updated = await db.stackUpdate.updateMany({
    where: { id: row.id, state: { in: ['dispatched', 'running'] } },
    data: {
      state: body.state,
      endedAt: now,
      ...(row.startedAt === null ? { startedAt: now } : {}),
      images: body.images,
      previous: body.previous,
      ...(restored === undefined ? {} : { digests: restored }),
      ...(why === undefined ? {} : { refusal: why }),
      ...(body.backupArtifact === undefined ? {} : { backupArtifact: body.backupArtifact }),
    },
  });
  const after = await db.stackUpdate.findUniqueOrThrow({ where: { id: row.id }, select: STACK_UPDATE_SELECT });
  if (updated.count === 0) return { accepted: false, status: toStackUpdateStatus(after) };
  bus.publish(`stack-update:${row.id}`);
  return { accepted: true, status: toStackUpdateStatus(after) };
}

const STALE_ACTOR = { type: 'system', label: 'shipyard: stale stack update sweep' } as const;

/**
 * Fails every update dispatched (or running) with no word from the agent for `STACK_UPDATE_STALE_MS`
 * plus the stack's soak: `agent_offline`, "the agent did not report back". Audited
 * `stack_update.failed` as the system. One indexed query when nothing is stale. Returns the IDs.
 */
export async function sweepStaleStackUpdates(deps: Pick<ServiceDeps, 'db' | 'bus' | 'logger'>, now: Date = new Date()): Promise<string[]> {
  const { db, bus, logger } = deps;
  const cutoff = new Date(now.getTime() - STACK_UPDATE_STALE_MS);
  const candidates = await db.stackUpdate.findMany({
    where: { state: { in: ['dispatched', 'running'] }, updatedAt: { lt: cutoff } },
    select: { id: true, state: true, kind: true, stackName: true, soakSeconds: true, updatedAt: true },
  });
  const failed: string[] = [];
  for (const row of candidates) {
    if (row.updatedAt.getTime() + row.soakSeconds * 1000 >= cutoff.getTime()) continue;
    const what = row.kind === 'rollback' ? 'rollback' : 'update';
    const why = refusal(
      'agent_offline',
      `The agent did not report back on this ${what} of ${row.stackName}.`,
      "Check the agent is running and can reach the server, then look at the stack's containers before retrying.",
    );
    const updated = await db.stackUpdate.updateMany({
      where: { id: row.id, state: { in: ['dispatched', 'running'] } },
      data: { state: 'failed', refusal: why, endedAt: now },
    });
    if (updated.count === 0) continue;
    failed.push(row.id);
    await directAudit(db, STALE_ACTOR)({
      action: 'stack_update.failed',
      entityType: 'stack_update',
      entityId: row.id,
      before: { state: row.state },
      after: { state: 'failed', refusal: 'agent_offline', stack: row.stackName, kind: row.kind },
    });
    logger.warn({ stackUpdateId: row.id, stack: row.stackName }, 'stack update failed: the agent did not report back');
    bus.publish(`stack-update:${row.id}`);
  }
  return failed;
}
