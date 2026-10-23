import {
  ACTIVE_STATES,
  Refusal as RefusalSchema,
  refusal,
  type ActionJob,
  type ActionPage,
  type ActionProgress,
  type ActionRequest,
  type ActionResult,
  type ActionState,
  type ActionStatus,
  type Refusal,
} from '@shipyard/schema';
import { capabilityRefusal } from '../agent/capabilities.js';
import { STATE_CHANGING_ROLES } from '../auth/scope.js';
import { directAudit } from '../builds/service.js';
import { Prisma, type Db } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { lockRefusal, type DeployCaller } from '../deploys/service.js';
import { decodeCursor, encodeCursor } from '../deploys/timeline.js';
import { snapshotContainers } from '../host/index.js';

/**
 * Lifecycle actions, server side (SHP-ADR-010; SHP-REQ-184, SHP-REQ-185, SHP-REQ-186, SHP-REQ-188).
 *
 * The server never touches Docker: it checks who is asking and what they name, records the action
 * `queued`, and hands it to the owning agent's long poll once that agent advertises `actions`. The
 * agent re-checks the target against its own manifests before it runs compose, reports `running`,
 * then a result. What reaches the host is a manifest name, a verb from a fixed enum and a compose
 * service name — never a command (non-negotiable 1).
 *
 * Refused here, before anything is queued:
 * - a viewer, or a token's owner who is one (`forbidden`, SHP-REQ-184 — deployer and above);
 * - a `stop` from an API token (`forbidden`, SHP-REQ-188 — stopping is a person's act);
 * - a token whose scope does not name the target (`forbidden`);
 * - a name that is only an Observed compose project in the host snapshot (`not_adopted`,
 *   SHP-REQ-185), or that nothing reports (`unknown_app`);
 * - an app whose deploy holds its lock (`locked`, naming the holder, SHP-REQ-186), or a stack an
 *   update or rollback is queued for or running on (`locked`, naming it and its requester,
 *   SHP-T-16.3) — the lock runs both ways with `POST /api/stacks/:name/updates`;
 * - an owning agent that is not polling (`agent_offline`) or never advertised `actions`
 *   (`agent_too_old`), so nothing waits forever for a poll that will never take it.
 */

/** A dispatched action with no result after this long is failed (`action_failed`). */
export const ACTION_STALE_MS = 2 * 60_000;
/** The longest `waitForAction`. */
export const MAX_ACTION_WAIT_MS = 90_000;
/** What `requesterLabel` is cut to: the agent's job allows no more (ActionJob). */
export const REQUESTER_LABEL_MAX = 200;

export const TERMINAL_ACTION_STATES: readonly ActionState[] = ['succeeded', 'failed', 'refused', 'cancelled'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACTION_SELECT = {
  id: true,
  targetKind: true,
  targetName: true,
  agentId: true,
  service: true,
  verb: true,
  state: true,
  requesterLabel: true,
  output: true,
  refusal: true,
  dispatchedAt: true,
  startedAt: true,
  endedAt: true,
  createdAt: true,
} satisfies Prisma.ActionSelect;

type ActionRow = Prisma.ActionGetPayload<{ select: typeof ACTION_SELECT }>;

/** The REST/MCP view of an action row. */
export function toActionStatus(row: ActionRow): ActionStatus {
  const stored = RefusalSchema.safeParse(row.refusal);
  return {
    id: row.id,
    target: { kind: row.targetKind, name: row.targetName },
    verb: row.verb,
    service: row.service,
    state: row.state,
    requesterLabel: row.requesterLabel,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    refusal: stored.success ? stored.data : null,
    output: row.output,
  };
}

export function isActionTerminal(state: ActionState): boolean {
  return TERMINAL_ACTION_STATES.includes(state);
}

/**
 * Who the action is recorded as requested by: the user's email "(console)" or the token's label,
 * with the caller's own `requester.label` in front when it gives one — the label a person locked
 * out of a deploy, or reading Activity, sees. Cut to `REQUESTER_LABEL_MAX`.
 */
export function actionRequesterLabel(actor: { type: string; label: string }, requesterLabel?: string): string {
  const base = actor.type === 'token' ? actor.label : `${actor.label} (console)`;
  const label = requesterLabel === undefined ? base : `${requesterLabel} (${base})`;
  return label.slice(0, REQUESTER_LABEL_MAX);
}

/**
 * Whether a token's scope names this target: an app through its apps, an adopted stack through its
 * stacks. A stack never shares an app's name (the report refuses one that would), so a scope name
 * is unambiguous; checking the kind as well keeps it so even if a name were reused later.
 */
export function tokenScopeCovers(caller: Pick<DeployCaller, 'tokenApps' | 'tokenStacks'>, target: ActionRequest['target']): boolean {
  return target.kind === 'app' ? caller.tokenApps?.has(target.name) === true : caller.tokenStacks?.has(target.name) === true;
}

/** Null when the caller may request a lifecycle action of `verb` on `target`; otherwise the refusal. */
export function actionPermissionRefusal(
  caller: Pick<DeployCaller, 'actor' | 'role' | 'tokenApps' | 'tokenStacks'>,
  verb: ActionRequest['verb'],
  target: ActionRequest['target'],
): Refusal | null {
  const name = target.name;
  const actor = caller.actor;
  if (actor === undefined) return refusal('unauthenticated', 'You are not signed in.');
  if (actor.type !== 'user' && actor.type !== 'token') return refusal('forbidden', `A ${actor.type} actor cannot run lifecycle actions.`);
  if (caller.role === undefined || !STATE_CHANGING_ROLES.includes(caller.role)) {
    return refusal('forbidden', 'The viewer role cannot start, stop, restart or recreate anything.', 'Ask an admin for the deployer role.');
  }
  // SHP-REQ-188: a session over MCP may restart or recreate, but a stop takes a service down until
  // someone starts it again — a person decides that, in the console.
  if (actor.type === 'token' && verb === 'stop') {
    return refusal('forbidden', 'An API token cannot stop a service.', 'Stop it from the console.');
  }
  if (actor.type === 'token' && !tokenScopeCovers(caller, target)) {
    return refusal('forbidden', `This token is not scoped to ${name}.`, `Use a token issued for ${name}, or issue a new one that names it.`);
  }
  return null;
}

interface ResolvedTarget {
  agentId: string;
  appId: string | null;
}

/** The app or stack the agent reports under `name`, or the refusal that says why there is none. */
async function resolveTarget(db: Db, target: ActionRequest['target']): Promise<ResolvedTarget | Refusal> {
  const { kind, name } = target;
  if (kind === 'app') {
    const app = await db.app.findFirst({ where: { name, retiredAt: null }, select: { id: true, agentId: true } });
    if (app !== null) return { agentId: app.agentId, appId: app.id };
  } else {
    const stack = await db.stack.findFirst({ where: { name, retiredAt: null }, select: { agentId: true } });
    if (stack !== null) return { agentId: stack.agentId, appId: null };
  }
  const other =
    kind === 'app'
      ? await db.stack.findFirst({ where: { name, retiredAt: null }, select: { id: true } })
      : await db.app.findFirst({ where: { name, retiredAt: null }, select: { id: true } });
  if (other !== null) {
    const actual = kind === 'app' ? 'stack' : 'app';
    return refusal('unknown_app', `${name} is an adopted ${actual}, not ${kind === 'app' ? 'an app' : 'a stack'}.`, `Send target.kind "${actual}".`);
  }
  // SHP-REQ-185: a compose project Shipyard only observes is never a target. Saying so (rather
  // than "unknown") tells the caller what would make it one.
  const observed = (await snapshotContainers(db)).some((c) => c.container.compose?.project === name);
  if (observed) return refusal('not_adopted', `${name} is a compose project Shipyard only observes.`);
  return refusal('unknown_app', `No app or adopted stack named ${name} has been reported by the agent.`);
}

/** The states of a stack update that hold its stack (stack_update_one_active_per_stack). */
const STACK_UPDATE_HOLDING = ['queued', 'dispatched', 'running'] as const;

/** `locked` while an update or rollback of the stack is queued, dispatched or running (SHP-T-16.3). */
export async function stackUpdateLockRefusal(db: Db, stackName: string): Promise<Refusal | null> {
  const holder = await db.stackUpdate.findFirst({
    where: { stackName, state: { in: [...STACK_UPDATE_HOLDING] } },
    select: { id: true, kind: true, state: true, step: true, requesterLabel: true },
  });
  if (holder === null) return null;
  const what = holder.kind === 'rollback' ? 'rolled back' : 'updated';
  return refusal(
    'locked',
    `${stackName} is being ${what} by ${holder.requesterLabel}: ${holder.step ?? holder.state} (stack update ${holder.id}).`,
    `Wait for stack update ${holder.id} to finish, then request again.`,
  );
}

/**
 * Queues a lifecycle action, or returns why not. On success the action is `queued`, audited as
 * `action.request`, and the owning agent's waiting poll is woken.
 */
export async function requestAction(deps: ServiceDeps, caller: DeployCaller, input: ActionRequest): Promise<ActionStatus | Refusal> {
  const { db, bus } = deps;
  const denied = actionPermissionRefusal(caller, input.verb, input.target);
  if (denied !== null) return denied;
  const actor = caller.actor;
  if (actor === undefined) return refusal('unauthenticated', 'You are not signed in.');

  const target = await resolveTarget(db, input.target);
  if ('code' in target) return target;
  if (target.appId !== null) {
    const locked = await lockRefusal(db, input.target.name, target.appId);
    if (locked !== null) return locked;
  } else {
    const locked = await stackUpdateLockRefusal(db, input.target.name);
    if (locked !== null) return locked;
  }
  const cannot = capabilityRefusal(bus, target.agentId, 'actions');
  if (cannot !== null) return cannot;

  const requesterLabel = actionRequesterLabel(actor, input.requester?.label);
  const row = await db.action.create({
    data: {
      targetKind: input.target.kind,
      targetName: input.target.name,
      agentId: target.agentId,
      verb: input.verb,
      service: input.service ?? null,
      requesterLabel,
      ...(actor.type === 'user' && actor.id !== undefined ? { requesterUserId: actor.id } : {}),
      ...(actor.type === 'token' && actor.id !== undefined ? { requesterTokenId: actor.id } : {}),
    },
    select: ACTION_SELECT,
  });
  await caller.audit({
    action: 'action.request',
    entityType: 'action',
    entityId: row.id,
    after: {
      target: input.target,
      verb: input.verb,
      service: input.service ?? null,
      requester: requesterLabel,
      ...(input.requester === undefined ? {} : { requesterRepo: input.requester.repo, requesterBranch: input.requester.branch }),
      state: row.state,
    },
  });
  deps.logger.info({ actionId: row.id, target: input.target, verb: input.verb, service: input.service ?? null }, 'lifecycle action queued');
  bus.publish('work');
  bus.publish(`action:${row.id}`);
  return toActionStatus(row);
}

/** The action, or null when there is no such action. */
export async function getAction(db: Db, id: string): Promise<ActionStatus | null> {
  if (!UUID_RE.test(id)) return null;
  const row = await db.action.findUnique({ where: { id }, select: ACTION_SELECT });
  return row === null ? null : toActionStatus(row);
}

/**
 * The action once it reaches a terminal state, or as it stands after `timeoutMs` (capped at
 * `MAX_ACTION_WAIT_MS`), whichever is first. Null when there is no such action. The wait is armed
 * before each read, so a publish between the read and the wait is not lost.
 */
export async function waitForAction(deps: ServiceDeps, id: string, timeoutMs: number, signal?: AbortSignal): Promise<ActionStatus | null> {
  const deadline = Date.now() + Math.max(0, Math.min(MAX_ACTION_WAIT_MS, timeoutMs));
  // A function, so the check after an await is not narrowed by the one before it.
  const aborted = (): boolean => signal?.aborted === true;
  for (;;) {
    await sweepStaleActions(deps);
    const stop = new AbortController();
    const remaining = deadline - Date.now();
    const combined = signal === undefined ? stop.signal : AbortSignal.any([signal, stop.signal]);
    const woken = remaining > 0 ? deps.bus.wait(`action:${id}`, remaining, combined) : null;
    try {
      const status = await getAction(deps.db, id);
      if (status === null || isActionTerminal(status.state) || woken === null || aborted()) return status;
      await woken;
      if (aborted() || Date.now() >= deadline) return await getAction(deps.db, id);
    } finally {
      stop.abort();
      if (woken !== null) await woken;
    }
  }
}

export interface ListActionsOptions {
  limit: number;
  cursor?: string;
  /** A token's scope: only the app targets and stack targets it names. Both or neither. */
  scope?: { apps: ReadonlySet<string>; stacks: ReadonlySet<string> };
}

/** Actions newest first, a page at a time (Activity's source, `GET /api/actions`). */
export async function listActions(db: Db, options: ListActionsOptions): Promise<ActionPage> {
  const where: Prisma.ActionWhereInput = {};
  const and: Prisma.ActionWhereInput[] = [];
  if (options.scope !== undefined) {
    and.push({
      OR: [
        { targetKind: 'app', targetName: { in: [...options.scope.apps] } },
        { targetKind: 'stack', targetName: { in: [...options.scope.stacks] } },
      ],
    });
  }
  if (options.cursor !== undefined) {
    const cur = decodeCursor(options.cursor);
    if (cur !== null) and.push({ OR: [{ createdAt: { lt: cur.createdAt } }, { createdAt: cur.createdAt, id: { lt: cur.id } }] });
  }
  if (and.length > 0) where.AND = and;
  const rows = await db.action.findMany({ where, select: ACTION_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: options.limit + 1 });
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    items: page.map(toActionStatus),
    nextCursor: rows.length > options.limit && last !== undefined ? encodeCursor(last.createdAt, last.id) : null,
  };
}

// ─── Dispatch (the agent's long poll) ──────────────────────────────────────

/**
 * Claims the oldest queued action for `agentId` (`queued → dispatched`) in one statement: `FOR
 * UPDATE SKIP LOCKED` means two concurrent polls never take the same one. An action on an app whose
 * deploy took the lock after the action was queued waits for that deploy to end (SHP-REQ-186); an
 * action on a stack waits the same way for an update or rollback of it (SHP-T-16.3).
 */
export async function claimAction(db: Db, agentId: string): Promise<ActionJob | null> {
  const active = [...ACTIVE_STATES];
  const rows = await db.$queryRaw<{ id: string }[]>`
    update "action" set "state" = 'dispatched', "dispatched_at" = now(), "updated_at" = now()
    where "id" = (
      select a."id" from "action" a
      where a."agent_id" = ${agentId}::uuid
        and a."state" = 'queued'
        and (a."target_kind" <> 'app' or not exists (
              select 1 from "deploy_target" t
              join "app" ap on ap."id" = t."app_id"
              where ap."name" = a."target_name"
                and t."state"::text in (${Prisma.join(active)})))
        and (a."target_kind" <> 'stack' or not exists (
              select 1 from "stack_update" u
              where u."stack_name" = a."target_name"
                and u."state"::text in (${Prisma.join([...STACK_UPDATE_HOLDING])})))
      order by a."created_at", a."id"
      for update of a skip locked
      limit 1
    )
    returning "id"::text as "id"`;
  const id = rows[0]?.id;
  if (id === undefined) return null;
  const row = await db.action.findUniqueOrThrow({ where: { id }, select: ACTION_SELECT });
  return {
    actionId: row.id,
    target: { kind: row.targetKind, name: row.targetName },
    verb: row.verb,
    ...(row.service === null ? {} : { service: row.service }),
    requesterLabel: row.requesterLabel.slice(0, REQUESTER_LABEL_MAX),
  };
}

/** Puts a claimed action back, for a poll whose client went away before it could be answered. */
export async function releaseAction(db: Db, id: string): Promise<void> {
  await db.action.updateMany({ where: { id, state: 'dispatched' }, data: { state: 'queued', dispatchedAt: null } });
}

/** The action, if it exists, was dispatched, and belongs to `agentId`. */
export async function ownAction(db: Db, agentId: string, id: string): Promise<ActionRow | null> {
  if (!UUID_RE.test(id)) return null;
  const row = await db.action.findUnique({ where: { id }, select: ACTION_SELECT });
  if (row?.agentId !== agentId || row.dispatchedAt === null) return null;
  return row;
}

export type RecordOutcome = { accepted: true; status: ActionStatus } | { accepted: false; status: ActionStatus };

/** `dispatched → running`. Idempotent while running; refused (not accepted) once it has ended. */
export async function recordActionProgress(deps: ServiceDeps, row: ActionRow, _body: ActionProgress): Promise<RecordOutcome> {
  const { db, bus } = deps;
  if (isActionTerminal(row.state)) return { accepted: false, status: toActionStatus(row) };
  if (row.state === 'dispatched') {
    await db.action.updateMany({ where: { id: row.id, state: 'dispatched' }, data: { state: 'running', startedAt: new Date() } });
  }
  const after = await db.action.findUniqueOrThrow({ where: { id: row.id }, select: ACTION_SELECT });
  bus.publish(`action:${row.id}`);
  return { accepted: true, status: toActionStatus(after) };
}

/** The terminal result, exactly once: a late or duplicate result is not accepted. */
export async function recordActionResult(deps: ServiceDeps, row: ActionRow, body: ActionResult): Promise<RecordOutcome> {
  const { db, bus } = deps;
  const now = new Date();
  // A failure always carries a refusal, so the console has a next step to show.
  const why =
    body.refusal ??
    (body.state === 'failed'
      ? refusal('action_failed', `compose ${row.verb} failed for ${row.targetName}${row.service === null ? '' : ` (${row.service})`}.`)
      : undefined);
  const updated = await db.action.updateMany({
    where: { id: row.id, state: { in: ['dispatched', 'running'] } },
    data: {
      state: body.state,
      endedAt: now,
      ...(row.startedAt === null ? { startedAt: now } : {}),
      ...(body.output === undefined ? {} : { output: body.output }),
      ...(why === undefined ? {} : { refusal: why }),
    },
  });
  const after = await db.action.findUniqueOrThrow({ where: { id: row.id }, select: ACTION_SELECT });
  if (updated.count === 0) return { accepted: false, status: toActionStatus(after) };
  bus.publish(`action:${row.id}`);
  return { accepted: true, status: toActionStatus(after) };
}

const STALE_ACTOR = { type: 'system', label: 'shipyard: stale action sweep' } as const;

/**
 * Fails every action dispatched (or running) for over `ACTION_STALE_MS` with no result:
 * `action_failed`, "the agent did not report back". Audited `action.failed` as the system. One
 * indexed query when nothing is stale. Returns the IDs.
 */
export async function sweepStaleActions(deps: Pick<ServiceDeps, 'db' | 'bus' | 'logger'>, now: Date = new Date()): Promise<string[]> {
  const { db, bus, logger } = deps;
  const cutoff = new Date(now.getTime() - ACTION_STALE_MS);
  const stale = await db.action.findMany({
    where: {
      state: { in: ['dispatched', 'running'] },
      OR: [{ startedAt: null, dispatchedAt: { lt: cutoff } }, { startedAt: { lt: cutoff } }],
    },
    select: { id: true, state: true, targetName: true, verb: true },
  });
  const failed: string[] = [];
  for (const row of stale) {
    const why = refusal('action_failed', `The agent did not report back on this ${row.verb} of ${row.targetName}.`, 'Check the agent is running and can reach the server, then look at the container before retrying.');
    const updated = await db.action.updateMany({
      where: { id: row.id, state: { in: ['dispatched', 'running'] } },
      data: { state: 'failed', refusal: why, endedAt: now },
    });
    if (updated.count === 0) continue;
    failed.push(row.id);
    await directAudit(db, STALE_ACTOR)({
      action: 'action.failed',
      entityType: 'action',
      entityId: row.id,
      before: { state: row.state },
      after: { state: 'failed', refusal: 'action_failed', target: row.targetName, verb: row.verb },
    });
    logger.warn({ actionId: row.id, target: row.targetName, verb: row.verb }, 'lifecycle action failed: the agent did not report back');
    bus.publish(`action:${row.id}`);
  }
  return failed;
}
