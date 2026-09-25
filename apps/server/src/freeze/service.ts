import { refusal, type Freeze as FreezeDto, type FreezeInfo, type FreezeRequest, type Refusal } from '@shipyard/schema';
import type { Actor, AuditEventInput } from '../audit.js';
import { STATE_CHANGING_ROLES, type Role } from '../auth/scope.js';
import type { Db } from '../db.js';

/**
 * Freeze (SHP-T-5.1, SHP-REQ-077, SHP-D-049): while an app is frozen the server refuses new
 * deploys with the freeze reason, but a rollback or restore of the same app is still allowed. Set
 * and cleared only by a signed-in deployer, operator or admin — never a token (the same shape as
 * drift resolution and approvals, SHP-D-072).
 */

/** Who is freezing or clearing: the console user, with the request's audit writer. */
export interface FreezeCaller {
  actor: Actor | undefined;
  role: Role | undefined;
  audit: (event: AuditEventInput) => Promise<void>;
}

/** Only a signed-in deployer, operator or admin may freeze or clear (never a token, never a viewer). */
export function assertCanFreeze(caller: FreezeCaller): Refusal | null {
  const actor = caller.actor;
  if (actor === undefined) return refusal('unauthenticated', 'You are not signed in.');
  if (actor.type !== 'user') {
    return refusal('forbidden', 'Freezing is done in the console, not with a token.', 'Sign in to the console as a deployer and freeze it there.');
  }
  if (caller.role === undefined || !STATE_CHANGING_ROLES.includes(caller.role)) {
    return refusal('forbidden', 'The viewer role cannot freeze or clear a freeze.', 'Ask an admin for the deployer role.');
  }
  return null;
}

interface FreezeRow {
  id: string;
  appId: string;
  reason: string;
  from: Date;
  until: Date | null;
  clearedAt: Date | null;
  by: { email: string };
}

const FREEZE_SELECT = {
  id: true,
  appId: true,
  reason: true,
  from: true,
  until: true,
  clearedAt: true,
  by: { select: { email: true } },
} as const;

function toDto(appName: string, row: FreezeRow): FreezeDto {
  return {
    id: row.id,
    app: appName,
    reason: row.reason,
    by: row.by.email,
    from: row.from.toISOString(),
    until: row.until?.toISOString() ?? null,
    clearedAt: row.clearedAt?.toISOString() ?? null,
  };
}

function toInfo(row: FreezeRow): FreezeInfo {
  return {
    reason: row.reason,
    by: row.by.email,
    from: row.from.toISOString(),
    until: row.until?.toISOString() ?? null,
  };
}

/** An active freeze: not cleared, and either open-ended or not yet past `until`. */
export async function activeFreezeRow(db: Db, appId: string, now: Date = new Date()): Promise<FreezeRow | null> {
  return db.freeze.findFirst({
    where: { appId, clearedAt: null, OR: [{ until: null }, { until: { gt: now } }] },
    orderBy: { from: 'desc' },
    select: FREEZE_SELECT,
  });
}

/** The active freeze on `appName`, for the app detail response, or null if it is not frozen. */
export async function activeFreezeInfo(db: Db, appId: string, now: Date = new Date()): Promise<FreezeInfo | null> {
  const row = await activeFreezeRow(db, appId, now);
  return row === null ? null : toInfo(row);
}

/**
 * Refuses `app_frozen` (G2) with the freeze reason if `appName` is actively frozen; null
 * otherwise (an unknown app included — that is reported by the drift pre-check, which runs
 * alongside this one). Used by the deploy pre-check for a real deploy (and its dry run — a dry
 * run reports what a real deploy would do, so it reports the freeze refusal too); never for a
 * rollback or restore.
 */
export async function assertNotFrozen(db: Db, appName: string, now: Date = new Date()): Promise<Refusal | null> {
  const app = await db.app.findUnique({ where: { name: appName }, select: { id: true } });
  if (app === null) return null;
  const row = await activeFreezeRow(db, app.id, now);
  if (row === null) return null;
  const since = row.from.toISOString();
  return refusal(
    'app_frozen',
    `${appName} is frozen: ${row.reason} (since ${since}, by ${row.by.email}).`,
    'Unfreeze it first; rollbacks and restores are still allowed.',
  );
}

const notFrozen = (appName: string): Refusal =>
  refusal('not_found', `${appName} is not frozen.`, 'Nothing to clear.');

const alreadyFrozen = (appName: string): Refusal =>
  refusal('conflict', `${appName} is already frozen.`, 'Clear the existing freeze before setting a new one.');

function untilInPast(): Refusal {
  return refusal('invalid_request', 'until must be in the future.', 'Send an ISO datetime later than now, or omit it for an open-ended freeze.');
}

/** Sets a freeze on `appName`, or the refusal: `unknown_app`, `conflict` if already frozen. */
export async function setFreeze(
  db: Db,
  caller: FreezeCaller,
  appName: string,
  input: FreezeRequest,
): Promise<FreezeDto | Refusal> {
  const denied = assertCanFreeze(caller);
  if (denied !== null) return denied;
  const actor = caller.actor;
  if (actor?.id === undefined) return refusal('unauthenticated', 'You are not signed in.');

  const now = new Date();
  const until = input.until !== undefined ? new Date(input.until) : null;
  if (until !== null && until.getTime() <= now.getTime()) return untilInPast();

  const app = await db.app.findUnique({ where: { name: appName }, select: { id: true } });
  if (app === null) return refusal('unknown_app', `No app named ${appName} has been reported by the agent.`);

  const existing = await activeFreezeRow(db, app.id, now);
  if (existing !== null) return alreadyFrozen(appName);

  const row = await db.freeze.create({
    data: {
      appId: app.id,
      reason: input.reason,
      byUserId: actor.id,
      from: now,
      ...(until !== null ? { until } : {}),
    },
    select: FREEZE_SELECT,
  });

  await caller.audit({
    action: 'app.frozen',
    entityType: 'app',
    entityId: app.id,
    after: { app: appName, reason: input.reason, until: until?.toISOString() ?? null },
  });

  return toDto(appName, row);
}

/** Clears the active freeze on `appName`, or the refusal: `unknown_app`, `not_found` if not frozen. */
export async function clearFreeze(db: Db, caller: FreezeCaller, appName: string): Promise<FreezeDto | Refusal> {
  const denied = assertCanFreeze(caller);
  if (denied !== null) return denied;

  const app = await db.app.findUnique({ where: { name: appName }, select: { id: true } });
  if (app === null) return refusal('unknown_app', `No app named ${appName} has been reported by the agent.`);

  const now = new Date();
  const existing = await activeFreezeRow(db, app.id, now);
  if (existing === null) return notFrozen(appName);

  const cleared = await db.freeze.updateMany({ where: { id: existing.id, clearedAt: null }, data: { clearedAt: now } });
  if (cleared.count === 0) return notFrozen(appName);

  const row = await db.freeze.findUniqueOrThrow({ where: { id: existing.id }, select: FREEZE_SELECT });

  await caller.audit({
    action: 'app.unfrozen',
    entityType: 'app',
    entityId: app.id,
    before: { app: appName, reason: existing.reason },
    after: { app: appName, clearedAt: now.toISOString() },
  });

  return toDto(appName, row);
}
