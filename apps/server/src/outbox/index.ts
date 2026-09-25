import { z } from 'zod';
import { createGitHubAdapter, type GitHubPort } from '@shipyard/sequence/github';
import type { ServiceDeps } from '../deps.js';
import type { Db } from '../db.js';
import { tasksFor, type ChangelogRef } from './tasks.js';

/**
 * The Foreman outbox (SHP-T-2.9). A deploy target that succeeds and whose app names a Foreman
 * project gets one outbox row per image (SHP-REQ-048); a background drain loop posts each row to
 * Foreman with exponential backoff capped at 15 minutes and no retry limit (SHP-REQ-049). Foreman
 * being down never fails a deploy (SHP-D-033) — enqueueing only ever writes rows, it never calls
 * out, and posting happens entirely off the deploy path.
 *
 * SHP-T-5.9/SHP-REQ-088: a successful *deploy* (not a rollback or a restore — neither ships new
 * code, so neither cites anything) also names which Foreman tasks it shipped. Computing that list
 * needs GitHub, so it is never done at enqueue time; `changelog` on the payload is the reference
 * the drain needs to compute it lazily, off the deploy path, and `tasks` is filled in (and
 * persisted) the first time the drain succeeds at it.
 */

const ChangelogRefSchema = z.object({
  repo: z.string(),
  defaultBranch: z.string(),
  base: z.string().nullable(),
  head: z.string(),
});

const OutboxPayload = z.object({
  project: z.string(),
  environment: z.string(),
  image: z.string(),
  imageSha: z.string(),
  schemaRevision: z.string().optional(),
  deployedAt: z.string(),
  note: z.string(),
  /** Foreman task IDs this deploy shipped, once computed — never sent until it is. */
  tasks: z.array(z.string()).optional(),
  /** Internal only: how to compute `tasks` lazily in the drain. Never sent to Foreman. */
  changelog: ChangelogRefSchema.optional(),
});
type OutboxPayload = z.infer<typeof OutboxPayload>;

const ForemanListResponse = z.looseObject({
  items: z.array(z.looseObject({ note: z.string().optional() })),
});

/** How many outbox rows a single `drainOnce` claims at once. */
const BATCH_SIZE = 25;
/** How long a claimed row is "leased" for: if the process dies mid-post, it is retried after this. */
const LEASE_MS = 2 * 60 * 1000;
/** SHP-REQ-049: base delay before the first cap kicks in. */
const BACKOFF_BASE_MS = 30_000;
/** SHP-REQ-049: the cap — no retry ever waits longer than this. */
const BACKOFF_CAP_MS = 15 * 60 * 1000;
/** How often `startOutbox`'s loop drains. */
const DRAIN_INTERVAL_MS = 10_000;
/** `lastError` is stored for operators to read, not to reconstruct a stack trace. */
const MAX_ERROR_LENGTH = 500;

/**
 * The SHA that was live when `target` succeeded: the newest other successful, non-dry-run target of
 * the same app that ended before it (a deploy or a rollback — either way, what was running). Null
 * for an app's first release, which cites nothing.
 */
async function previousReleaseSha(db: Db, target: { id: string; appId: string; endedAt: Date | null }): Promise<string | null> {
  const previous = await db.deployTarget.findFirst({
    where: {
      appId: target.appId,
      id: { not: target.id },
      state: 'succeeded',
      deploy: { dryRun: false },
      ...(target.endedAt === null ? {} : { endedAt: { lt: target.endedAt } }),
    },
    orderBy: [{ endedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    select: { images: { select: { sha: true }, take: 1 } },
  });
  return previous?.images[0]?.sha ?? null;
}

/**
 * Inserts one outbox row per image on `targetId`'s deploy target, idempotent by
 * `<targetId>:<service>` (SHP-REQ-048). An app with no `foremanProject` gets no rows
 * (SHP-D-062). Returns the number of rows actually inserted (0 when they already existed, or
 * when there was nothing to record).
 */
export async function enqueueDeployment(db: Db, targetId: string): Promise<number> {
  const target = await db.deployTarget.findUniqueOrThrow({
    where: { id: targetId },
    include: { images: true, app: true, deploy: true },
  });

  if (target.app.foremanProject === null) return 0;
  if (target.images.length === 0) return 0;

  const project = target.app.foremanProject;
  const environment = target.app.foremanEnvironment ?? 'production';
  const deployedAt = (target.endedAt ?? new Date()).toISOString();

  // A rollback or a restore ships nothing new — the code at HEAD does not change, so there is
  // nothing to cite (SHP-REQ-088 is about what shipped). Only a plain `deploy`, with a prior
  // release recorded and the app's repo known, gets a changelog reference at all.
  const base = target.deploy.kind === 'deploy' ? (target.liveShaBefore ?? (await previousReleaseSha(db, target))) : null;
  const changelogRef: ChangelogRef | null =
    base !== null && target.app.repo !== null && target.app.defaultBranch !== null
      ? { repo: target.app.repo, defaultBranch: target.app.defaultBranch, base, head: target.deploy.requestedSha }
      : null;

  const rows = target.images.map((image) => {
    const idempotencyKey = `${targetId}:${image.service}`;
    const payload: OutboxPayload = {
      project,
      environment,
      image: `${image.repo}:sha-${image.sha}`,
      imageSha: image.digest,
      deployedAt,
      note: `shipyard ${idempotencyKey} deploy ${target.deployId}`,
      ...(target.schemaRevision === null ? {} : { schemaRevision: target.schemaRevision }),
      ...(changelogRef === null ? {} : { changelog: changelogRef }),
    };
    return { targetId, idempotencyKey, payload };
  });

  const result = await db.outbox.createMany({ data: rows, skipDuplicates: true });
  return result.count;
}

/** Exponential backoff with a 15-minute cap and ±10% jitter (SHP-REQ-049). No retry limit: this
 * never throws or returns a non-finite value, however large `attempts` gets. */
export function computeBackoffMs(attempts: number, random: () => number = Math.random): number {
  const growth = BACKOFF_BASE_MS * Math.pow(2, attempts);
  const capped = Math.min(BACKOFF_CAP_MS, growth);
  const jitter = 0.9 + random() * 0.2;
  return Math.round(capped * jitter);
}

function truncateError(message: string, secret?: string): string {
  const redacted = secret !== undefined && secret.length > 0 ? message.split(secret).join('[redacted]') : message;
  return redacted.length > MAX_ERROR_LENGTH ? redacted.slice(0, MAX_ERROR_LENGTH) : redacted;
}

interface ForemanCreds {
  url: string;
  token: string;
}

// A config object is warned about at most once per process (or per test's `deps.config`), so a
// long outage does not spam the log.
const warnedMissingConfig = new WeakSet<object>();

function foremanCreds(deps: ServiceDeps): ForemanCreds | null {
  const { FOREMAN_URL, FOREMAN_TOKEN } = deps.config;
  if (FOREMAN_URL === undefined || FOREMAN_TOKEN === undefined) {
    if (!warnedMissingConfig.has(deps.config)) {
      warnedMissingConfig.add(deps.config);
      deps.logger.warn('FOREMAN_URL/FOREMAN_TOKEN not configured; outbox rows will stay queued');
    }
    return null;
  }
  return { url: FOREMAN_URL, token: FOREMAN_TOKEN };
}

type FetchFn = typeof fetch;

/** True when Foreman already has a deployment recorded with this idempotency key in its `note`
 * (the lost-response case: our earlier POST landed but we never saw the 201). */
async function alreadyDelivered(
  fetchImpl: FetchFn,
  creds: ForemanCreds,
  project: string,
  idempotencyKey: string,
): Promise<boolean> {
  const res = await fetchImpl(`${creds.url}/api/projects/${encodeURIComponent(project)}/deployments`, {
    headers: { authorization: `Bearer ${creds.token}` },
  });
  if (!res.ok) return false;
  const body: unknown = await res.json();
  const parsed = ForemanListResponse.safeParse(body);
  if (!parsed.success) return false;
  // The note is `shipyard <key> deploy <id>`: compare the key token exactly. A substring match
  // would let `t1:web` find the note of `t1:web2` and mark an image delivered that never was.
  return parsed.data.items.some((item) => {
    const words = (item.note ?? '').split(/\s+/);
    return words[0] === 'shipyard' && words[1] === idempotencyKey;
  });
}

interface PostResult {
  ok: boolean;
  status: number;
  bodyText: string;
}

/** Only the fields Foreman's contract accepts — `changelog` is an internal reference and never
 * leaves this process. */
function postBody(payload: OutboxPayload): Record<string, unknown> {
  return {
    environment: payload.environment,
    image: payload.image,
    imageSha: payload.imageSha,
    deployedAt: payload.deployedAt,
    note: payload.note,
    ...(payload.schemaRevision === undefined ? {} : { schemaRevision: payload.schemaRevision }),
    ...(payload.tasks === undefined ? {} : { tasks: payload.tasks }),
  };
}

async function postDeployment(fetchImpl: FetchFn, creds: ForemanCreds, payload: OutboxPayload): Promise<PostResult> {
  const res = await fetchImpl(`${creds.url}/api/projects/${encodeURIComponent(payload.project)}/deployments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${creds.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(postBody(payload)),
  });
  const bodyText = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, bodyText };
}

interface ClaimedRow {
  id: string;
  idempotencyKey: string;
  payload: unknown;
  attempts: number;
}

async function processRow(
  deps: ServiceDeps,
  row: ClaimedRow,
  creds: ForemanCreds,
  fetchImpl: FetchFn,
  now: Date,
  github: GitHubPort,
  taskCache: Map<string, Promise<string[]>>,
): Promise<void> {
  const parsedPayload = OutboxPayload.safeParse(row.payload);
  if (!parsedPayload.success) {
    // A malformed payload can never succeed; keep it visible without hammering Foreman.
    await deps.db.outbox.update({
      where: { id: row.id },
      data: {
        attempts: row.attempts + 1,
        nextAt: new Date(now.getTime() + BACKOFF_CAP_MS),
        lastError: truncateError(`invalid outbox payload: ${parsedPayload.error.message}`),
      },
    });
    return;
  }
  let payload = parsedPayload.data;

  try {
    // SHP-T-5.9: compute `tasks` the first time this row is processed with a changelog
    // reference and no `tasks` yet — a GitHub outage here lands in the same catch as a Foreman
    // outage, so it delays this post (existing backoff) rather than failing anything. Once
    // computed, it is persisted onto the row's payload so a later retry never refetches.
    if (payload.changelog !== undefined && payload.tasks === undefined) {
      const tasks = await tasksFor(github, payload.changelog, payload.project, taskCache);
      payload = { ...payload, tasks };
      await deps.db.outbox.update({ where: { id: row.id }, data: { payload } });
    }

    if (row.attempts > 0) {
      const seen = await alreadyDelivered(fetchImpl, creds, payload.project, row.idempotencyKey);
      if (seen) {
        await deps.db.outbox.update({ where: { id: row.id }, data: { deliveredAt: now } });
        return;
      }
    }

    const result = await postDeployment(fetchImpl, creds, payload);
    if (result.ok) {
      await deps.db.outbox.update({ where: { id: row.id }, data: { deliveredAt: now } });
      return;
    }

    if (result.status >= 400 && result.status < 500) {
      deps.logger.error(
        { idempotencyKey: row.idempotencyKey, status: result.status },
        'foreman rejected outbox deployment post',
      );
    }

    const attempts = row.attempts + 1;
    await deps.db.outbox.update({
      where: { id: row.id },
      data: {
        attempts,
        nextAt: new Date(now.getTime() + computeBackoffMs(attempts)),
        lastError: truncateError(`HTTP ${String(result.status)}: ${result.bodyText}`, creds.token),
      },
    });
  } catch (err) {
    const attempts = row.attempts + 1;
    const message = err instanceof Error ? err.message : String(err);
    await deps.db.outbox.update({
      where: { id: row.id },
      data: {
        attempts,
        nextAt: new Date(now.getTime() + computeBackoffMs(attempts)),
        lastError: truncateError(message, creds.token),
      },
    });
  }
}

export interface DrainOptions {
  fetch?: FetchFn;
  now?: Date;
  /** Overrides the GitHub adapter used to compute `tasks` (SHP-T-5.9) — tests inject a fake. */
  github?: GitHubPort;
}

/**
 * Claims due, undelivered rows under `FOR UPDATE SKIP LOCKED` (safe under concurrent drains: each
 * row is claimed by at most one caller) and posts each to Foreman. Missing Foreman config leaves
 * rows queued untouched. Returns how many rows this call processed.
 */
export async function drainOnce(deps: ServiceDeps, opts: DrainOptions = {}): Promise<{ processed: number }> {
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? new Date();
  const github =
    opts.github ?? createGitHubAdapter(deps.config.GITHUB_TOKEN_SERVER === undefined ? {} : { token: deps.config.GITHUB_TOKEN_SERVER });
  // Shared across every row this call claims, so two images on the same target (same base..head)
  // make one GitHub call instead of one per image.
  const taskCache = new Map<string, Promise<string[]>>();

  const creds = foremanCreds(deps);
  if (creds === null) return { processed: 0 };

  const claimedIds = await deps.db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "outbox"
      WHERE "delivered_at" IS NULL AND "next_at" <= ${now}
      ORDER BY "next_at"
      LIMIT ${BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    `;
    const ids = locked.map((row) => row.id);
    if (ids.length > 0) {
      // Lease the rows so a crash mid-post retries after LEASE_MS rather than never.
      await tx.outbox.updateMany({
        where: { id: { in: ids } },
        data: { nextAt: new Date(now.getTime() + LEASE_MS) },
      });
    }
    return ids;
  });

  if (claimedIds.length === 0) return { processed: 0 };

  const rows = await deps.db.outbox.findMany({
    where: { id: { in: claimedIds } },
    select: { id: true, idempotencyKey: true, payload: true, attempts: true },
  });

  for (const row of rows) {
    await processRow(deps, row, creds, fetchImpl, now, github, taskCache);
  }

  return { processed: rows.length };
}

/** For the console's outbox badge (SHP-REQ-095). */
export async function outboxStats(db: Db): Promise<{ unsent: number; oldestUnsentAt: Date | null }> {
  const [unsent, oldest] = await Promise.all([
    db.outbox.count({ where: { deliveredAt: null } }),
    db.outbox.findFirst({
      where: { deliveredAt: null },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);
  return { unsent, oldestUnsentAt: oldest?.createdAt ?? null };
}

/** The drain loop started from `src/index.ts`: drains every ten seconds until `stop()`, which
 * waits for any in-flight drain before resolving. */
export function startOutbox(deps: ServiceDeps): { stop(): Promise<void> } {
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = (): void => {
    inFlight = drainOnce(deps)
      .then(() => undefined)
      .catch((err: unknown) => {
        deps.logger.error({ err }, 'outbox drain failed');
      });
  };

  const timer = setInterval(tick, DRAIN_INTERVAL_MS);
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
