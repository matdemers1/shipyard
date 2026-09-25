import type { Request } from 'express';
import {
  ACTIVE_STATES,
  Refusal as RefusalSchema,
  refusal,
  type DeployAccepted,
  type DeployRequest,
  type DeployStatus,
  type DeployTargetState,
  type Refusal,
} from '@shipyard/schema';
import type { Actor, AuditEventInput } from '../audit.js';
import { assertCanActOn, type Role } from '../auth/scope.js';
import type { Db, Prisma } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { assertDeployable } from '../apps/drift.js';

/**
 * Deploy requests, dry runs and status (SHP-T-2.5). The server pre-checks only G1 (authorisation),
 * G3 (drift), G4 (the lock) and "the agent has reported this app"; the agent evaluates the real
 * gates (G5–G10) when it takes the target from its poll (SHP-D-004).
 *
 * The lock is the partial unique index `deploy_target_one_active_per_app` (SHP-D-061,
 * SHP-REQ-038): a deploy inserts its target straight into `locked`, and a second active target
 * for the same app is rejected by Postgres. Contention is refused at once, naming the holder
 * (SHP-D-045, SHP-REQ-039) — never queued.
 */

/** Terminal target states: a status wait returns at once for these. */
export const TERMINAL_STATES: readonly DeployTargetState[] = ['succeeded', 'failed', 'rolled_back', 'refused', 'cancelled'];

/** The longest `GET /deploys/:id?wait=` or `shipyard_deploy_status` wait. */
export const MAX_WAIT_SECONDS = 90;

/**
 * Null when `appName` may be deployed as far as the server can tell (the agent has reported it,
 * and it has no unresolved drift); otherwise the refusal. SHP-T-2.3's `assertDeployable` in
 * `src/apps/drift.ts` has this shape and replaces the local default once merged.
 */
export type DeployableCheck = (db: Db, appName: string) => Promise<Refusal | null>;

/** The agent's report is the only source of apps; drift blocks forward deploys (SHP-T-2.3). */
export const defaultDeployableCheck: DeployableCheck = (db, appName) => assertDeployable(db, appName);

/** Who is asking: what `authenticate` put on the request, plus the request's audit writer. */
export interface DeployCaller {
  actor: Actor | undefined;
  role: Role | undefined;
  tokenApps: ReadonlySet<string> | undefined;
  audit: (event: AuditEventInput) => Promise<void>;
}

export function callerFromRequest(req: Request): DeployCaller {
  return {
    actor: req.actor,
    role: req.role,
    tokenApps: req.tokenApps,
    audit: (event) => req.audit(event),
  };
}

/** `assertCanActOn` reads only the actor, role and token scope. */
export function callerCanActOn(caller: DeployCaller, appName: string): Refusal | null {
  const shim = { actor: caller.actor, role: caller.role, tokenApps: caller.tokenApps } as unknown as Request;
  return assertCanActOn(shim, appName);
}

export interface CreateDeployOptions {
  check?: DeployableCheck;
}

/** True for a Refusal, false for a DeployAccepted. */
export function isRefusal(v: unknown): v is Refusal {
  return RefusalSchema.safeParse(v).success;
}

/** Postgres 23505 on the one-active-target index, however the driver adapter surfaces it. */
export function isUniqueViolation(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (typeof cur === 'object' && cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown; meta?: unknown };
    if (e.code === 'P2002' || e.code === '23505') return true;
    if (typeof e.message === 'string' && e.message.includes('deploy_target_one_active_per_app')) return true;
    const meta = e.meta as { driverAdapterError?: { cause?: { kind?: unknown; originalCode?: unknown } } } | undefined;
    const cause = meta?.driverAdapterError?.cause;
    if (cause?.kind === 'UniqueConstraintViolation' || cause?.originalCode === '23505') return true;
    cur = e.cause;
  }
  return false;
}

/** How long a deploy waits for a deployer's approval before it expires (SHP-D-048, SHP-REQ-061). */
export const APPROVAL_TTL_MS = 60 * 60 * 1000;

/** The refusal naming the holder of `appName`'s lock, or null if nobody holds it now. */
export async function lockRefusal(db: Db, appName: string, appId: string): Promise<Refusal | null> {
  const holder = await db.deployTarget.findFirst({
    where: { appId, state: { in: [...ACTIVE_STATES] } },
    select: { state: true, currentStep: true, deployId: true, deploy: { select: { requesterLabel: true, requestedSha: true } } },
  });
  if (holder === null) return null;
  const sha7 = holder.deploy.requestedSha.slice(0, 7);
  return refusal(
    'locked',
    `${appName} is being deployed by ${holder.deploy.requesterLabel}: ${sha7} at step ${holder.currentStep ?? holder.state}.`,
    `Wait for deploy ${holder.deployId} to finish, then request again; Shipyard does not queue deploys.`,
  );
}

/**
 * Accepts a single-app deploy, rollback or dry run, or returns the refusal. A real deploy's
 * target is inserted in `locked` (holding the app); a dry run's in `queued`, which never locks
 * (SHP-REQ-050). Either way the agent's poll picks it up after `bus.publish('work')`.
 */
export async function createDeploy(
  deps: ServiceDeps,
  caller: DeployCaller,
  input: DeployRequest,
  options: CreateDeployOptions = {},
): Promise<DeployAccepted | Refusal> {
  const { db, bus } = deps;
  const check = options.check ?? defaultDeployableCheck;

  if (input.group !== undefined || input.app === undefined) {
    return refusal('invalid_request', 'Group deploys arrive in Phase 5.', 'Deploy each app on its own for now.');
  }
  const appName = input.app;

  const denied = callerCanActOn(caller, appName);
  if (denied !== null) return denied;
  const actor = caller.actor;
  if (actor === undefined) return refusal('unauthenticated', 'You are not signed in.');

  if (input.kind === 'restore') {
    return refusal('invalid_request', 'Restores are not requested through this endpoint.');
  }

  // Who asked, for the lock refusal and the audit trail. A token (MCP) must say who it acts for.
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
  } else {
    label = input.requester?.label ?? `${actor.label} (console)`;
  }

  const notDeployable = await check(db, appName);
  if (notDeployable !== null) return notDeployable;

  const app = await db.app.findUnique({ where: { name: appName }, select: { id: true, approvalPolicy: true } });
  if (app === null) return refusal('unknown_app', `No app named ${appName} has been reported by the agent.`);

  let sha: string;
  let rollbackToDeployId: string | undefined;
  if (input.kind === 'rollback') {
    const toDeployId = input.toDeployId ?? '';
    const earlier = await db.deployTarget.findFirst({
      where: { deployId: toDeployId, appId: app.id, state: 'succeeded', deploy: { dryRun: false } },
      select: { deploy: { select: { requestedSha: true } } },
    });
    if (earlier === null) {
      return refusal(
        'rollback_target_invalid',
        `Deploy ${toDeployId} is not an earlier successful deploy of ${appName}.`,
      );
    }
    sha = earlier.deploy.requestedSha;
    rollbackToDeployId = toDeployId;
  } else {
    sha = input.sha ?? '';
  }

  const dryRun = input.dryRun === true;
  // An agent-requested (token) deploy or rollback of an approval-required app is held, without the
  // lock, until a deployer approves it from the console (SHP-REQ-060, SHP-D-015). A deployer's own
  // console request needs none: confirming the dry-run sheet is the approval.
  const held = !dryRun && actor.type === 'token' && app.approvalPolicy === 'required';
  const state: DeployTargetState = dryRun ? 'queued' : held ? 'awaiting_approval' : 'locked';
  const data: Prisma.DeployCreateInput = {
    kind: input.kind,
    requestedSha: sha,
    dryRun,
    requesterLabel: label,
    ...(input.requester !== undefined ? { requesterRepo: input.requester.repo, requesterBranch: input.requester.branch } : {}),
    ...(actor.type === 'user' && actor.id !== undefined ? { requesterUser: { connect: { id: actor.id } } } : {}),
    ...(actor.type === 'token' && actor.id !== undefined ? { requesterToken: { connect: { id: actor.id } } } : {}),
    targets: {
      create: {
        app: { connect: { id: app.id } },
        state,
        ...(rollbackToDeployId !== undefined ? { rollbackToDeployId } : {}),
      },
    },
    ...(held ? { approval: { create: { expiresAt: new Date(Date.now() + APPROVAL_TTL_MS) } } } : {}),
  };

  let deployId: string | undefined;
  // Twice at most: if the holder finished between our insert and the lookup, try once more.
  for (let attempt = 0; attempt < 2 && deployId === undefined; attempt += 1) {
    try {
      // A nested create is one statement batch in one transaction: the Deploy never exists
      // without its target, and the index decides who holds the lock.
      const row = await db.deploy.create({ data, select: { id: true } });
      deployId = row.id;
    } catch (err) {
      if (dryRun || held || !isUniqueViolation(err)) throw err;
      const locked = await lockRefusal(db, appName, app.id);
      if (locked !== null) return locked;
    }
  }
  if (deployId === undefined) {
    return refusal('locked', `${appName} is being deployed by someone else.`);
  }

  await caller.audit({
    action: 'deploy.requested',
    entityType: 'deploy',
    entityId: deployId,
    after: {
      app: appName,
      kind: input.kind,
      sha,
      dryRun,
      state,
      requester: { label, repo: input.requester?.repo ?? null, branch: input.requester?.branch ?? null },
      ...(rollbackToDeployId !== undefined ? { rollbackToDeployId } : {}),
    },
  });
  if (held) {
    // Nothing for the agent yet; wake anyone already following the deploy (and the home banner).
    bus.publish(`deploy:${deployId}`);
  } else {
    bus.publish('work');
  }
  return { deployId, state };
}

const STATUS_SELECT = {
  state: true,
  currentStep: true,
  schemaRevision: true,
  refusal: true,
  result: true,
  endedAt: true,
  app: { select: { name: true } },
  images: { select: { service: true, sha: true, digest: true }, orderBy: { service: 'asc' } },
  deploy: {
    select: {
      id: true,
      kind: true,
      requestedSha: true,
      dryRun: true,
      requesterLabel: true,
      requesterRepo: true,
      requesterBranch: true,
      createdAt: true,
    },
  },
} satisfies Prisma.DeployTargetSelect;

type StatusRow = Prisma.DeployTargetGetPayload<{ select: typeof STATUS_SELECT }>;

interface GateResult {
  gate: string;
  pass: boolean;
  reason: string;
}

function readGates(result: Prisma.JsonValue | null): GateResult[] {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return [];
  const gates = (result as { gates?: unknown }).gates;
  if (!Array.isArray(gates)) return [];
  return gates.filter(
    (g): g is GateResult =>
      typeof g === 'object' &&
      g !== null &&
      typeof (g as GateResult).gate === 'string' &&
      typeof (g as GateResult).pass === 'boolean' &&
      typeof (g as GateResult).reason === 'string',
  ).map((g) => ({ gate: g.gate, pass: g.pass, reason: g.reason }));
}

function toStatus(row: StatusRow): DeployStatus {
  const parsedRefusal = RefusalSchema.safeParse(row.refusal);
  return {
    deployId: row.deploy.id,
    kind: row.deploy.kind,
    app: row.app.name,
    sha: row.deploy.requestedSha,
    dryRun: row.deploy.dryRun,
    state: row.state,
    currentStep: row.currentStep,
    requester: { label: row.deploy.requesterLabel, repo: row.deploy.requesterRepo, branch: row.deploy.requesterBranch },
    images: row.images.map((i) => ({ service: i.service, sha: i.sha, digest: i.digest })),
    schemaRevision: row.schemaRevision,
    refusal: parsedRefusal.success ? parsedRefusal.data : null,
    gates: readGates(row.result),
    createdAt: row.deploy.createdAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

/** A deploy's status (its single target, for a single-app deploy), or null if there is none. */
export async function getDeployStatus(db: Db, deployId: string): Promise<DeployStatus | null> {
  const row = await db.deployTarget.findFirst({
    where: { deployId },
    select: STATUS_SELECT,
    orderBy: { createdAt: 'asc' },
  });
  return row === null ? null : toStatus(row);
}

export interface ListDeploysOptions {
  /** Only this app. */
  app?: string;
  /** Only these apps (a token's scope). */
  apps?: ReadonlySet<string>;
  limit: number;
}

/** Deploy targets, newest first. */
export async function listDeploys(db: Db, options: ListDeploysOptions): Promise<DeployStatus[]> {
  const names: string[] | undefined =
    options.apps === undefined
      ? options.app === undefined
        ? undefined
        : [options.app]
      : [...options.apps].filter((n) => options.app === undefined || n === options.app);
  const rows = await db.deployTarget.findMany({
    where: names === undefined ? {} : { app: { name: { in: names } } },
    select: STATUS_SELECT,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: options.limit,
  });
  return rows.map(toStatus);
}

export function isTerminal(state: DeployTargetState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * The deploy's status once it changes, or after `waitSeconds` (capped at 90), whichever is
 * first. Returns at once for a terminal deploy or a zero wait. The wait is armed before the first
 * read, so a publish between the read and the wait is not lost.
 */
export async function waitForChange(
  deps: ServiceDeps,
  deployId: string,
  waitSeconds: number,
  signal?: AbortSignal,
): Promise<DeployStatus | null> {
  const seconds = Math.max(0, Math.min(MAX_WAIT_SECONDS, waitSeconds));
  if (seconds === 0) return getDeployStatus(deps.db, deployId);

  const stop = new AbortController();
  const combined = signal === undefined ? stop.signal : AbortSignal.any([signal, stop.signal]);
  const woken = deps.bus.wait(`deploy:${deployId}`, seconds * 1000, combined);
  try {
    const first = await getDeployStatus(deps.db, deployId);
    if (first === null || isTerminal(first.state)) return first;
    await woken;
    if (signal?.aborted === true) return first;
    return await getDeployStatus(deps.db, deployId);
  } finally {
    stop.abort();
    await woken;
  }
}
