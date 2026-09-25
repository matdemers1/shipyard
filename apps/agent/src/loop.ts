import { PollResponse, refusal, type Refusal, type StepJournal, type TargetProgress, type TargetResult } from '@shipyard/schema';
import type {
  DeployRequest,
  DeployResult,
  FsPort,
  JournalEntry,
  MachineContext,
  ProgressListener,
  RollbackRequest,
} from '@shipyard/sequence';
import { AgentRequestError, type AgentClient } from './client.js';

/**
 * The agent's work loop (SHP-T-2.4; SHP-REQ-040, SHP-REQ-021, SHP-D-041, SHP-D-081, SHP-D-002).
 *
 * The agent long-polls the server for at most 25 s at a time (each poll is its heartbeat), runs
 * any target it is given through the same engine the host CLI uses, and reports what happened.
 * The local journal is written first, always; the server hears about each step when it can be
 * reached. The server being unreachable mid-deploy never stops a deploy: the agent alone decides
 * a health-failure rollback, and the result is retried until the server takes it.
 */

export const POLL_PATH = '/api/agent/poll';
export const PROGRESS_PATH = '/api/agent/progress';
export const STEPS_PATH = '/api/agent/steps';
export const RESULT_PATH = '/api/agent/result';

/** The longest the server may hold a poll (SHP-REQ-040). */
export const POLL_WAIT_SECONDS = 25;
/** The HTTP timeout for a poll: the wait plus slack for the network. */
export const POLL_TIMEOUT_MS = 35_000;

export type PollTarget = NonNullable<PollResponse['target']>;

export interface LoopLog {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface Backoff {
  initialMs: number;
  maxMs: number;
}

/** 1 s, doubling, capped at 30 s. */
export const DEFAULT_BACKOFF: Backoff = { initialMs: 1_000, maxMs: 30_000 };

export function nextDelay(currentMs: number, backoff: Backoff = DEFAULT_BACKOFF): number {
  return Math.min(currentMs * 2, backoff.maxMs);
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Resolves after `ms`, or at once when `signal` aborts. Never rejects. */
export const abortableSleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** A 4xx other than a timeout or a rate limit: the server has decided, and retrying cannot help. */
export function isPermanent(err: unknown): boolean {
  return err instanceof AgentRequestError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── The poll loop ───────────────────────────────────────────────────────────

export interface LoopOptions {
  /** The client polls go through; its HTTP timeout should be `POLL_TIMEOUT_MS`. */
  client: AgentClient;
  runTarget: (target: PollTarget) => Promise<void>;
  log: LoopLog;
  /** Aborting stops the loop: after the current target, never in the middle of one. */
  signal: AbortSignal;
  sleep?: Sleep;
  backoff?: Backoff;
}

/**
 * Polls, runs what it is given, and polls again at once. A failed poll (network, 5xx, a refusal)
 * backs off 1 s → 30 s and tries again; a successful poll resets the backoff.
 */
export async function runLoop(opts: LoopOptions): Promise<void> {
  const sleep = opts.sleep ?? abortableSleep;
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  let delay = backoff.initialMs;
  // A function, not the property: the signal flips while a poll is in flight.
  const stopped = (): boolean => opts.signal.aborted;

  while (!stopped()) {
    let target: PollTarget | null;
    try {
      const body = await opts.client.request('POST', POLL_PATH, { waitSeconds: POLL_WAIT_SECONDS });
      target = PollResponse.parse(body).target;
      delay = backoff.initialMs;
    } catch (err) {
      if (stopped()) break;
      opts.log.warn({ err: message(err), retryInMs: delay }, 'poll failed; backing off');
      await sleep(delay, opts.signal);
      delay = nextDelay(delay, backoff);
      continue;
    }
    if (target === null) continue;
    try {
      await opts.runTarget(target);
    } catch (err) {
      // runTarget reports its own failures; this is a last resort so the loop never dies.
      opts.log.error({ err: message(err), targetId: target.targetId, deployId: target.deployId }, 'target runner threw');
    }
  }
  opts.log.info({}, 'agent loop stopped');
}

// ─── Targets taken but not yet reported ──────────────────────────────────────

export interface TargetRecord {
  targetId: string;
  deployId: string;
  app: string;
  /** Set once the engine finished; the result is kept here until the server takes it. */
  result?: TargetResult;
}

/**
 * The targets this agent took from a poll and has not yet reported, keyed by the server's target
 * ID. It lets a restart report every target it would otherwise have left dispatched forever:
 * an unreported result is sent, and a target with no result is reported `failed`/`interrupted`.
 */
export interface TargetStore {
  put(record: TargetRecord): Promise<void>;
  remove(targetId: string): Promise<void>;
  all(): Promise<TargetRecord[]>;
}

export function targetStorePath(dataRoot: string): string {
  return `${dataRoot}/agent/targets.json`;
}

/** A `TargetStore` in one JSON file, rewritten atomically; writes are serialised. */
export function fileTargetStore(fs: FsPort, path: string): TargetStore {
  let queue: Promise<unknown> = Promise.resolve();

  const read = async (): Promise<Record<string, TargetRecord>> => {
    if (!(await fs.exists(path))) return {};
    try {
      const parsed = JSON.parse(await fs.readFile(path)) as unknown;
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, TargetRecord>) : {};
    } catch {
      return {};
    }
  };
  const write = async (records: Record<string, TargetRecord>): Promise<void> => {
    const dir = path.slice(0, Math.max(0, path.lastIndexOf('/')));
    if (dir.length > 0) await fs.mkdirp(dir);
    await fs.writeFileAtomic(path, `${JSON.stringify(records, null, 2)}\n`);
  };
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn);
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    put: (record) =>
      serial(async () => {
        const records = await read();
        records[record.targetId] = record;
        await write(records);
      }),
    remove: (targetId) =>
      serial(async () => {
        const records = await read();
        if (!(targetId in records)) return;
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete records[targetId];
        await write(records);
      }),
    all: () => serial(async () => Object.values(await read())),
  };
}

export function memoryTargetStore(): TargetStore & { records: Map<string, TargetRecord> } {
  const records = new Map<string, TargetRecord>();
  return {
    records,
    put: (record) => {
      records.set(record.targetId, structuredClone(record));
      return Promise.resolve();
    },
    remove: (targetId) => {
      records.delete(targetId);
      return Promise.resolve();
    },
    all: () => Promise.resolve([...records.values()]),
  };
}

// ─── Mapping the engine's output onto the protocol ───────────────────────────

const TERMINAL = new Set(['succeeded', 'failed', 'rolled_back', 'refused', 'cancelled']);
const SHA_RE = /^[0-9a-f]{40}$/;
/** `StepJournal.output` is capped at 64 KiB. */
const MAX_OUTPUT = 65_536;

/** One journal line as the server's `StepJournal`. Null for the `deploy` bracket lines. */
export function toStepJournal(targetId: string, entry: JournalEntry): StepJournal | null {
  if (entry.step === 'deploy') return null;
  const argv = entry.argv !== undefined && entry.argv.length > 0 ? entry.argv : [entry.step];
  return {
    targetId,
    name: entry.step,
    argv,
    phase: entry.phase,
    ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
    ...(entry.output === undefined ? {} : { output: entry.output.slice(-MAX_OUTPUT) }),
  };
}

/** The backup artifact's size and time, from this deploy's `backup` end line. */
function backupFromJournal(entries: JournalEntry[], deployId: string, path: string): TargetResult['backupArtifact'] {
  const line = entries.findLast(
    (e) => e.deployId === deployId && e.step === 'backup' && e.phase === 'end' && e.detail?.['artifact'] === path,
  );
  const size = line?.detail?.['size'];
  return {
    path,
    size: typeof size === 'number' && Number.isInteger(size) && size >= 0 ? size : 0,
    createdAt: line?.at ?? new Date().toISOString(),
  };
}

/** The protocol's limit on a migration label's length. */
const MAX_MIGRATION_LABEL = 100;

/** The engine's `DeployResult` as the protocol's `TargetResult`. */
export function toTargetResult(target: PollTarget, result: DeployResult, journal: JournalEntry[] = []): TargetResult {
  let state: TargetResult['state'];
  if (TERMINAL.has(result.state)) state = result.state as TargetResult['state'];
  // A passing dry run stops at verify without a terminal state (SHP-REQ-050): that is its success.
  else if (target.dryRun && result.refusal === null) state = 'succeeded';
  else state = 'failed';

  const out: TargetResult = {
    targetId: target.targetId,
    state,
    images: result.images
      .filter((image) => SHA_RE.test(image.sha))
      // The migration label travels with the verified digest (SHP-D-057): the server's rollback
      // targets read it to list a release behind a contract migration as needing a restore.
      .map((image) => ({
        service: image.service,
        sha: image.sha,
        digest: image.digest,
        ...(image.migration === null ? {} : { migration: image.migration.slice(0, MAX_MIGRATION_LABEL) }),
      })),
    gates: result.gates.map((g) => ({ gate: g.gate, pass: g.pass, reason: g.reason })),
  };
  if (result.schemaRevision !== null && result.schemaRevision.length > 0) out.schemaRevision = result.schemaRevision;
  if (result.refusal !== null) out.refusal = result.refusal;
  else if (state === 'failed') out.refusal = refusal('step_failed', `The deploy ended in state ${result.state}.`);
  if (result.backupArtifact !== null) out.backupArtifact = backupFromJournal(journal, target.deployId, result.backupArtifact);
  return out;
}

function failedResult(targetId: string, why: Refusal, state: TargetResult['state'] = 'failed'): TargetResult {
  return { targetId, state, images: [], refusal: why };
}

// ─── Running one target ──────────────────────────────────────────────────────

/** The engine's two entry points, injectable for tests. */
export interface Engine {
  deploy(ctx: MachineContext, request: DeployRequest): Promise<DeployResult>;
  rollback(ctx: MachineContext, request: RollbackRequest): Promise<DeployResult>;
}

export interface TargetRunnerOptions {
  client: AgentClient;
  engine: Engine;
  /** A fresh machine context per target: manifests reloaded, the journal and ledger shared. */
  context: () => Promise<Omit<MachineContext, 'onProgress'>>;
  store: TargetStore;
  log: LoopLog;
  /** Aborting stops retrying the result; it stays in the store for the next start. */
  signal?: AbortSignal;
  sleep?: Sleep;
  backoff?: Backoff;
}

/**
 * Builds `runTarget`: record the target locally, run it through the engine with the server's
 * deploy ID (so ledger entries and rollbacks line up with the server's), stream progress and
 * journal lines to the server as it goes, then deliver the result until the server takes it.
 */
export function createTargetRunner(opts: TargetRunnerOptions): (target: PollTarget) => Promise<void> {
  const { client, engine, store, log } = opts;
  const sleep = opts.sleep ?? abortableSleep;
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;

  return async (target: PollTarget): Promise<void> => {
    const tlog = { deployId: target.deployId, targetId: target.targetId, app: target.app };
    log.info({ ...tlog, kind: target.kind, sha: target.sha, dryRun: target.dryRun }, 'target received');
    await store.put({ targetId: target.targetId, deployId: target.deployId, app: target.app });

    let ctx: Omit<MachineContext, 'onProgress'> | null = null;
    let cursor = 0;

    /** Sends journal lines since `cursor`, in order. Throws on the first transient failure. */
    const syncSteps = async (): Promise<void> => {
      if (ctx === null) return;
      const { entries } = await ctx.journal.pendingSync(cursor);
      for (const entry of entries) {
        const step = entry.deployId === target.deployId && entry.app === target.app ? toStepJournal(target.targetId, entry) : null;
        if (step !== null) {
          try {
            await client.request('POST', STEPS_PATH, step);
          } catch (err) {
            if (!isPermanent(err)) throw err;
            log.warn({ ...tlog, step: step.name, err: message(err) }, 'server refused a journal line; skipping it');
          }
        }
        cursor += 1;
      }
    };

    // Progress and step syncs run in order, off the engine's path: a slow or absent server never
    // holds a deploy up. A failed sync is retried with the next event and again at the end.
    let chain: Promise<void> = Promise.resolve();
    let syncWarned = false;
    const onProgress: ProgressListener = (event) => {
      const progress: TargetProgress = {
        targetId: target.targetId,
        state: event.state,
        ...(event.step === undefined ? {} : { step: event.step.slice(0, 100) }),
      };
      chain = chain
        .then(async () => {
          await client.request('POST', PROGRESS_PATH, progress).catch((err: unknown) => {
            if (isPermanent(err)) return;
            throw err;
          });
          await syncSteps();
        })
        .catch((err: unknown) => {
          if (!syncWarned) log.warn({ ...tlog, err: message(err) }, 'server unreachable mid-deploy; continuing and syncing later');
          syncWarned = true;
        });
    };

    let result: TargetResult;
    try {
      ctx = await opts.context();
      cursor = await ctx.journal.cursor();
      const machine: MachineContext = { ...ctx, onProgress };
      let deployResult: DeployResult;
      if (target.kind === 'deploy') {
        deployResult = await engine.deploy(machine, {
          deployId: target.deployId,
          kind: 'deploy',
          app: target.app,
          sha: target.sha,
          dryRun: target.dryRun,
          requesterLabel: target.requesterLabel ?? 'shipyard server',
        });
      } else if (target.kind === 'rollback' && target.toDeployId !== undefined) {
        deployResult = await engine.rollback(machine, {
          deployId: target.deployId,
          app: target.app,
          toDeployId: target.toDeployId,
          requesterLabel: target.requesterLabel ?? 'shipyard server',
          dryRun: target.dryRun,
        });
      } else {
        deployResult = {
          deployId: target.deployId,
          app: target.app,
          state: 'refused',
          sha: target.sha,
          images: [],
          schemaRevision: null,
          gates: [],
          refusal:
            target.kind === 'rollback'
              ? refusal('rollback_target_invalid', 'The rollback names no target deploy.')
              : refusal('invalid_request', `This agent does not run ${target.kind} targets yet.`),
          steps: [],
          backupArtifact: null,
        };
      }
      await chain;
      result = toTargetResult(target, deployResult, await ctx.journal.readAll());
    } catch (err) {
      await chain;
      log.error({ ...tlog, err: message(err) }, 'target failed before the engine could report');
      result = failedResult(target.targetId, refusal('step_failed', `The agent could not run this target: ${message(err)}`));
    }
    log.info({ ...tlog, state: result.state, refusal: result.refusal?.code }, 'target finished');

    await store.put({ targetId: target.targetId, deployId: target.deployId, app: target.app, result });
    await deliver(result, syncSteps);
  };

  /** Syncs the remaining journal lines, then the result; retries until taken, refused, or stopped. */
  async function deliver(result: TargetResult, syncSteps: () => Promise<void>): Promise<void> {
    let delay = backoff.initialMs;
    for (;;) {
      try {
        await syncSteps();
        await client.request('POST', RESULT_PATH, result);
        log.info({ targetId: result.targetId, state: result.state }, 'result reported');
        await store.remove(result.targetId);
        return;
      } catch (err) {
        if (isPermanent(err)) {
          // 409: the server already has a result for it. 404: it is not ours to report. Either way, done.
          log.warn({ targetId: result.targetId, err: message(err) }, 'server refused the result; dropping it');
          await store.remove(result.targetId);
          return;
        }
        if (opts.signal?.aborted === true) {
          log.warn({ targetId: result.targetId }, 'stopping with the result unreported; it is sent on the next start');
          return;
        }
        log.warn({ targetId: result.targetId, err: message(err), retryInMs: delay }, 'result not delivered; retrying');
        await sleep(delay, opts.signal);
        delay = nextDelay(delay, backoff);
      }
    }
  }
}

// ─── After a restart ─────────────────────────────────────────────────────────

export interface LeftoverOptions {
  client: AgentClient;
  store: TargetStore;
  log: LoopLog;
  /** The last step of each deploy restart recovery rolled back, by deploy ID. */
  recovered?: ReadonlyMap<string, string | undefined>;
  /** True while the app's lock is held by a live process: that target is still running. */
  isLive?: (app: string) => Promise<boolean>;
}

/**
 * Reports every target a previous run took and never reported (SHP-D-081): a kept result is sent
 * as it was; a target with none was interrupted, so it is reported `failed` with `interrupted`.
 * A target the server cannot be told about now stays in the store for the next start.
 */
export async function reportLeftovers(opts: LeftoverOptions): Promise<void> {
  for (const record of await opts.store.all()) {
    if (record.result === undefined && opts.isLive !== undefined && (await opts.isLive(record.app))) continue;
    const lastStep = opts.recovered?.get(record.deployId);
    const result =
      record.result ??
      failedResult(
        record.targetId,
        refusal(
          'interrupted',
          lastStep === undefined
            ? `The agent restarted while running this ${record.app} target.`
            : `The agent restarted during ${lastStep}; ${record.app} was restored to its last verified-good compose file.`,
        ),
      );
    try {
      await opts.client.request('POST', RESULT_PATH, result);
      opts.log.info({ targetId: record.targetId, deployId: record.deployId, state: result.state }, 'reported a target left from before the restart');
      await opts.store.remove(record.targetId);
    } catch (err) {
      if (isPermanent(err)) {
        await opts.store.remove(record.targetId);
        continue;
      }
      opts.log.warn({ targetId: record.targetId, err: message(err) }, 'could not report a leftover target; keeping it');
    }
  }
}
