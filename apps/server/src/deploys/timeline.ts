import { Refusal as RefusalSchema, type DeployKind, type DeployTargetState } from '@shipyard/schema';
import type { Db, Prisma } from '../db.js';
import { TERMINAL_STATES } from './service.js';

/**
 * The timeline (S8, SHP-REQ-062) and a deploy's Foreman post state (S6). Both read the same rows
 * `deploys/service.ts` writes; this file only reads.
 */

/** `outcome=` on the timeline: every terminal state, plus `active` for every non-terminal one. */
export type TimelineOutcome = 'succeeded' | 'failed' | 'rolled_back' | 'refused' | 'cancelled' | 'active';

const ALL_OUTCOMES: readonly TimelineOutcome[] = ['succeeded', 'failed', 'rolled_back', 'refused', 'cancelled', 'active'];

export function isTimelineOutcome(v: unknown): v is TimelineOutcome {
  return typeof v === 'string' && (ALL_OUTCOMES as readonly string[]).includes(v);
}

export interface TimelineItem {
  deployId: string;
  kind: DeployKind;
  app: string;
  sha: string;
  dryRun: boolean;
  state: DeployTargetState;
  requesterLabel: string;
  createdAt: string;
  endedAt: string | null;
  refusalCode: string | null;
}

export interface TimelinePage {
  items: TimelineItem[];
  nextCursor: string | null;
}

export interface TimelineOptions {
  /** A single app, already validated. */
  app?: string;
  /** A token's scoped apps; when set, results are limited to their intersection with `app`. */
  apps?: ReadonlySet<string>;
  /** Case-insensitive substring of the requester label. */
  requester?: string;
  outcome?: TimelineOutcome;
  kind?: DeployKind;
  /** Dry runs are excluded unless this is true (SHP-T-3.7). */
  dryRun?: boolean;
  cursor?: string;
  limit: number;
}

interface Cursor {
  createdAt: Date;
  id: string;
}

/** Opaque outside this module: base64 of `<ISO createdAt>|<id>`. */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

/** Null for anything that does not decode to a valid timestamp and id — treated as "no cursor". */
export function decodeCursor(raw: string): Cursor | null {
  let text: string;
  try {
    text = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const sep = text.indexOf('|');
  if (sep < 0) return null;
  const iso = text.slice(0, sep);
  const id = text.slice(sep + 1);
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || id === '') return null;
  return { createdAt, id };
}

const TIMELINE_SELECT = {
  id: true,
  appId: true,
  state: true,
  refusal: true,
  endedAt: true,
  createdAt: true,
  app: { select: { name: true } },
  deploy: {
    select: { id: true, kind: true, requestedSha: true, dryRun: true, requesterLabel: true, createdAt: true },
  },
} satisfies Prisma.DeployTargetSelect;

type TimelineRow = Prisma.DeployTargetGetPayload<{ select: typeof TIMELINE_SELECT }>;

function toItem(row: TimelineRow): TimelineItem {
  const parsedRefusal = RefusalSchema.safeParse(row.refusal);
  return {
    deployId: row.deploy.id,
    kind: row.deploy.kind,
    app: row.app.name,
    sha: row.deploy.requestedSha,
    dryRun: row.deploy.dryRun,
    state: row.state,
    requesterLabel: row.deploy.requesterLabel,
    createdAt: row.createdAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    refusalCode: parsedRefusal.success ? parsedRefusal.data.code : null,
  };
}

/**
 * Deploy targets, newest first, filtered and keyset-paginated on `(createdAt, id)` descending
 * (SHP-REQ-062). A malformed or stale cursor is treated as the start, never an error, so infinite
 * scroll never gets stuck.
 */
export async function listTimeline(db: Db, options: TimelineOptions): Promise<TimelinePage> {
  const where: Prisma.DeployTargetWhereInput = {};
  const and: Prisma.DeployTargetWhereInput[] = [];

  const names: string[] | undefined =
    options.apps === undefined
      ? options.app === undefined
        ? undefined
        : [options.app]
      : [...options.apps].filter((n) => options.app === undefined || n === options.app);
  if (names !== undefined) where.app = { name: { in: names } };

  if (options.requester !== undefined && options.requester !== '') {
    where.deploy = { requesterLabel: { contains: options.requester, mode: 'insensitive' } };
  }

  if (options.kind !== undefined) {
    where.deploy = { ...(where.deploy as object | undefined), kind: options.kind };
  }

  if (options.dryRun !== true) {
    where.deploy = { ...(where.deploy as object | undefined), dryRun: false };
  }

  if (options.outcome !== undefined) {
    where.state = options.outcome === 'active' ? { notIn: [...TERMINAL_STATES] } : options.outcome;
  }

  if (options.cursor !== undefined) {
    const cur = decodeCursor(options.cursor);
    if (cur !== null) {
      and.push({
        OR: [{ createdAt: { lt: cur.createdAt } }, { createdAt: cur.createdAt, id: { lt: cur.id } }],
      });
    }
  }
  if (and.length > 0) where.AND = and;

  const rows = await db.deployTarget.findMany({
    where,
    select: TIMELINE_SELECT,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: options.limit,
  });

  const last = rows.at(-1);
  const nextCursor = rows.length === options.limit && last !== undefined ? encodeCursor(last.createdAt, last.id) : null;

  return { items: rows.map(toItem), nextCursor };
}

// ─── Deploy record's Foreman posts (S6) ────────────────────────────────────

/** How long an unsent outbox row is shown as "stuck" (matches the outbox badge, SHP-REQ-095). */
const STUCK_AFTER_MS = 60 * 60 * 1000;

export interface ForemanPost {
  service: string;
  idempotencyKey: string;
  delivered: boolean;
  attempts: number;
  lastError: string | null;
  nextAt: string;
}

export interface ForemanStatus {
  posts: ForemanPost[];
  stuck: boolean;
}

/**
 * A deploy target's Foreman outbox rows, one per image, by the idempotency key
 * `enqueueDeployment` writes (`<targetId>:<service>`). Empty when the app has no Foreman mapping
 * (no rows were ever enqueued) — never an error.
 */
export async function foremanStatus(db: Db, deployId: string, now: Date = new Date()): Promise<ForemanStatus | null> {
  const target = await db.deployTarget.findFirst({
    where: { deployId },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  if (target === null) return null;

  // Rows only exist when `enqueueDeployment` wrote them (an app with a Foreman mapping): no rows
  // is exactly "no Foreman mapping", not an error.
  const rows = await db.outbox.findMany({
    where: { targetId: target.id },
    select: { idempotencyKey: true, attempts: true, lastError: true, nextAt: true, deliveredAt: true, createdAt: true },
    orderBy: { idempotencyKey: 'asc' },
  });

  let stuck = false;
  const posts: ForemanPost[] = rows.map((row) => {
    const delivered = row.deliveredAt !== null;
    if (!delivered && now.getTime() - row.createdAt.getTime() > STUCK_AFTER_MS) stuck = true;
    // The idempotency key is `<targetId>:<service>`; the service is everything after the prefix.
    const service = row.idempotencyKey.startsWith(`${target.id}:`) ? row.idempotencyKey.slice(target.id.length + 1) : row.idempotencyKey;
    return {
      service,
      idempotencyKey: row.idempotencyKey,
      delivered,
      attempts: row.attempts,
      lastError: row.lastError,
      nextAt: row.nextAt.toISOString(),
    };
  });

  return { posts, stuck };
}
