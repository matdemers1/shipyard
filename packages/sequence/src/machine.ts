import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';

import { refusal } from '@shipyard/schema';
import type { DeployTargetState, Manifest, Refusal } from '@shipyard/schema';
import { stringify as stringifyYaml } from 'yaml';

import { checkOnce } from './check.js';
import type { CheckOutcome } from './check.js';
import { pruneAfterSuccess } from './disk.js';
import { composeTargetOf, resolveDeployTarget } from './facts.js';
import type { ResolvedTarget } from './facts.js';
import type { Journal } from './journal.js';
import type { Ledger } from './ledger.js';
import type { LoadedManifests } from './manifest.js';
import { RefusalError } from './ports.js';
import type { ComposeTarget, Log, RunningContainer, SequencePorts } from './ports.js';
import { loadSecrets, redact } from './redact.js';
import { applyRewrite, planRewrite, restoreFromHistory } from './rewrite.js';
import { runBackup, runMigrate } from './steps.js';
import type { DeployRequest, DeployResult, GateResult, JournalEntry, LiveState, ProgressListener, StepRecord, VerifiedImage } from './types.js';

/**
 * The deploy state machine (SHP-T-1.8). Every deploy runs verify → backup → migrate → pull → swap
 * → check → soak (SHP-REQ-012), each step journaled before it runs (SHP-REQ-021). A failed check or
 * soak rolls back image-only — the previous compose file and the previous images (SHP-REQ-016) —
 * unless the release carries the contract migration label, when it stops and keeps its backup
 * (SHP-REQ-017). A dry run evaluates every gate and changes nothing (SHP-REQ-050).
 */

// ─── Transitions ─────────────────────────────────────────────────────────────

/** The only legal moves. Anything else is a programming error and throws. */
export const TRANSITIONS: Readonly<Record<DeployTargetState, readonly DeployTargetState[]>> = {
  queued: ['verifying'],
  awaiting_approval: [],
  locked: [],
  verifying: ['refused', 'backing_up', 'migrating', 'pulling'],
  backing_up: ['migrating', 'pulling', 'failed'],
  migrating: ['pulling', 'failed'],
  pulling: ['swapping', 'failed'],
  swapping: ['checking', 'rolling_back', 'failed'],
  checking: ['soaking', 'rolling_back', 'failed'],
  soaking: ['succeeded', 'rolling_back', 'failed'],
  rolling_back: ['rolled_back', 'failed'],
  succeeded: [],
  failed: [],
  rolled_back: [],
  refused: [],
  cancelled: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: DeployTargetState,
    readonly to: DeployTargetState,
  ) {
    super(`illegal deploy state transition ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: DeployTargetState, to: DeployTargetState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Returns `to`, or throws `IllegalTransitionError` when the move is not in the table. */
export function transition(from: DeployTargetState, to: DeployTargetState): DeployTargetState {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return to;
}

// ─── Context ─────────────────────────────────────────────────────────────────

export interface MachineContext {
  dataRoot: string;
  manifests: LoadedManifests;
  journal: Journal;
  ledger: Ledger;
  /** Scratch directory for override compose files; never the stack's own directory. */
  workDir: string;
  /** Where the previous compose files are kept per deploy (SHP-REQ-013). */
  historyDir: string;
  /** How long `check` (and a rollback's confirmation) may poll. Default 120 s. */
  healthTimeoutMs?: number;
  /** Poll interval during `check`. Default 2 s. */
  checkIntervalMs?: number;
  /** Poll interval during `soak`. Default 10 s. */
  soakIntervalMs?: number;
  /** Per-probe timeout for /health. Default 5 s. */
  probeTimeoutMs?: number;
  onProgress?: ProgressListener;
  /** Overrides how env names present on the host are found (names only). */
  envNamesProvider?: (manifest: Manifest) => Promise<string[]>;
  /** How often the lock's heartbeat is refreshed. Default 10 s. */
  lockHeartbeatMs?: number;
  /** A lock whose heartbeat is older than this is stale. Default 60 s. */
  lockStaleMs?: number;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 120_000;
const DEFAULT_CHECK_INTERVAL_MS = 2_000;
const DEFAULT_SOAK_INTERVAL_MS = 10_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

// ─── Host-CLI lock ───────────────────────────────────────────────────────────

interface LockContent {
  pid: number;
  deployId: string;
  requesterLabel: string;
  sha: string;
  step: string;
  at: string;
  /** Random per acquisition: who holds this lock file, independent of pid (a container's PID 1). */
  token: string;
  /** Refreshed every `heartbeatMs` while the holder runs. Older than `staleMs` means stale. */
  heartbeatAt: string;
}

export type LockHolder = Omit<LockContent, 'token' | 'heartbeatAt'>;

export interface LockOptions {
  /** How often the holder refreshes `heartbeatAt`. Default 10 s. */
  heartbeatMs?: number;
  /** A lock whose heartbeat is older than this is stale and may be taken over. Default 60 s. */
  staleMs?: number;
  /** Epoch ms. Default `Date.now`. */
  now?: () => number;
}

export const LOCK_HEARTBEAT_MS = 10_000;
export const LOCK_STALE_MS = 60_000;
/**
 * The takeover guard is held for a read and a rename, milliseconds; one older than this was left
 * by a process that died holding it.
 */
export const LOCK_GUARD_STALE_MS = 30_000;

export function lockPath(dataRoot: string, app: string): string {
  return `${dataRoot}/agent/locks/${app}.lock`;
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function tempName(path: string): string {
  return `${path}.${randomBytes(6).toString('hex')}.tmp`;
}

async function readRaw(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (errCode(err) === 'ENOENT') return null;
    throw err;
  }
}

function parseLock(raw: string): Partial<LockContent> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    // Written whole before it is linked or renamed into place, so never half-written by a live
    // holder: an unparsable lock has no heartbeat and is stale.
    return {};
  }
}

function isStale(holder: Partial<LockContent>, now: number, staleMs: number): boolean {
  const beat = Date.parse(typeof holder.heartbeatAt === 'string' ? holder.heartbeatAt : '');
  return !Number.isFinite(beat) || now - beat > staleMs;
}

/**
 * Runs `fn` holding `<lock>.guard`, the one mutex every rewrite of an *existing* lock file goes
 * through: a takeover, a heartbeat, a step update and a release. Created with link(2), so exactly
 * one process holds it. Returns 'busy' when another process holds it.
 */
async function withGuard<T>(path: string, fn: () => Promise<T>): Promise<T | 'busy'> {
  const guard = `${path}.guard`;
  const tmp = tempName(guard);
  await writeFile(tmp, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
  try {
    let held = false;
    for (let attempt = 0; attempt < 2 && !held; attempt++) {
      try {
        await link(tmp, guard);
        held = true;
      } catch (err) {
        if (errCode(err) !== 'EEXIST') throw err;
        const info = await stat(guard).catch(() => null);
        if (info !== null && Date.now() - info.mtimeMs <= LOCK_GUARD_STALE_MS) return 'busy';
        // Left by a process that died holding it (or just released): clear it and try once more.
        if (info !== null) await unlink(guard).catch(() => undefined);
      }
    }
    if (!held) return 'busy';
    try {
      return await fn();
    } finally {
      await unlink(guard).catch(() => undefined);
    }
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

/**
 * An exclusive per-app lock file for the host CLI and the agent (SHP-REQ-032's holder names).
 *
 * - **Acquire**: the content is written to a private temp file and hard-linked into place, which
 *   fails with EEXIST exactly like an O_EXCL create but never exposes a half-written lock.
 * - **Liveness is a heartbeat**, not a pid: the holder refreshes `heartbeatAt` every 10 s, and a
 *   lock whose heartbeat is older than 60 s is stale. A pid says nothing in a container, where a
 *   restarted agent is PID 1 again.
 * - **Takeover is compare-and-swap**: under the guard, the lock file is re-read, and a fresh temp
 *   lock is renamed over it only if its content is byte-for-byte the stale content judged stale.
 *   Two takers cannot both win: the guard admits one, and the loser's re-read no longer matches.
 */
export class AppLock {
  private timer: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private released = false;

  private constructor(
    private readonly path: string,
    private content: LockContent,
    private readonly now: () => number,
  ) {}

  static async acquire(dataRoot: string, app: string, holder: LockHolder, options: LockOptions = {}): Promise<AppLock | Refusal> {
    const now = options.now ?? Date.now;
    const staleMs = options.staleMs ?? LOCK_STALE_MS;
    const heartbeatMs = options.heartbeatMs ?? LOCK_HEARTBEAT_MS;
    const path = lockPath(dataRoot, app);
    await mkdir(`${dataRoot}/agent/locks`, { recursive: true });
    const content: LockContent = { ...holder, token: randomBytes(16).toString('hex'), heartbeatAt: new Date(now()).toISOString() };
    const tmp = tempName(path);
    await writeFile(tmp, JSON.stringify(content), { flag: 'wx' });
    const won = (): AppLock => {
      const lock = new AppLock(path, content, now);
      lock.startHeartbeat(heartbeatMs);
      return lock;
    };
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await link(tmp, path);
          return won();
        } catch (err) {
          if (errCode(err) !== 'EEXIST') throw err;
        }
        const seen = await readRaw(path);
        if (seen === null) continue; // released in between: try the link again
        const current = parseLock(seen);
        if (!isStale(current, now(), staleMs)) {
          return refusal(
            'locked',
            `${app} is locked by ${current.requesterLabel ?? 'unknown'} deploying ${(current.sha ?? '').slice(0, 7)} (step ${current.step ?? 'unknown'}, deploy ${current.deployId ?? 'unknown'}).`,
          );
        }
        const swapped = await withGuard(path, async () => {
          if ((await readRaw(path)) !== seen) return false;
          await rename(tmp, path);
          return true;
        });
        if (swapped === 'busy') return refusal('locked', `${app} is locked: another process is taking over its stale lock.`);
        if (swapped) return won();
        // The content changed after it was judged stale (a heartbeat, or another taker won): look again.
      }
      return refusal('locked', `${app} is locked and the lock could not be taken over.`);
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }

  private startHeartbeat(heartbeatMs: number): void {
    this.timer = setInterval(() => {
      void this.rewrite({}).catch(() => undefined);
    }, heartbeatMs);
    this.timer.unref();
  }

  /**
   * Rewrites the lock with a fresh heartbeat (and `patch`), only while it is still this holder's.
   * Serialized within the process; across processes, by the guard.
   */
  private rewrite(patch: Partial<LockContent>, attempts = 1): Promise<void> {
    const next = this.queue.then(async () => {
      if (this.released) return;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const done = await withGuard(this.path, async () => {
          const current = await readRaw(this.path);
          if (current === null || parseLock(current).token !== this.content.token) return; // lost it
          this.content = { ...this.content, ...patch, heartbeatAt: new Date(this.now()).toISOString() };
          const tmp = tempName(this.path);
          try {
            await writeFile(tmp, JSON.stringify(this.content), { flag: 'wx' });
            await rename(tmp, this.path);
          } catch {
            await unlink(tmp).catch(() => undefined);
          }
        });
        if (done !== 'busy') return;
        await new Promise((r) => setTimeout(r, 20));
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Best-effort: records the current step (and a heartbeat) so a refused requester can see it. */
  async setStep(step: string): Promise<void> {
    await this.rewrite({ step }, 5).catch(() => undefined);
  }

  /** Test seam: refresh the heartbeat now. */
  async heartbeat(): Promise<void> {
    await this.rewrite({}, 5);
  }

  async release(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    const done = this.queue.then(async () => {
      if (this.released) return;
      this.released = true;
      for (let attempt = 0; attempt < 50; attempt++) {
        const result = await withGuard(this.path, async () => {
          const current = await readRaw(this.path);
          if (current !== null && parseLock(current).token === this.content.token) await unlink(this.path).catch(() => undefined);
        });
        if (result !== 'busy') return;
        await new Promise((r) => setTimeout(r, 20));
      }
      // The guard stayed busy: leave the lock; its heartbeat stops, so it goes stale in staleMs.
    });
    this.queue = done.catch(() => undefined);
    await done;
  }
}

// ─── Test-only pause (kill-mid-swap e2e) ─────────────────────────────────────

/**
 * With NODE_ENV=test and SHIPYARD_TEST_PAUSE_AFTER=<point>, prints a marker and never resumes, so
 * a test can SIGKILL the process at a known point. Inert in every other environment.
 */
async function testPause(point: string): Promise<void> {
  if (process.env.NODE_ENV !== 'test' || process.env.SHIPYARD_TEST_PAUSE_AFTER !== point) return;
  process.stdout.write(`SHIPYARD_TEST_PAUSED ${point}\n`);
  await new Promise<never>(() => {
    setInterval(() => undefined, 60_000);
  });
}

// ─── The run ─────────────────────────────────────────────────────────────────

class StepFailure extends Error {
  constructor(readonly refusal: Refusal) {
    super(`${refusal.code}: ${refusal.message}`);
  }
}

function asRefusal(err: unknown, code: 'step_failed' | 'backup_failed' | 'migrate_failed', what: string): Refusal {
  if (err instanceof RefusalError) return err.refusal;
  if (err instanceof StepFailure) return err.refusal;
  const message = err instanceof Error ? err.message : String(err);
  return refusal(code, `${what}: ${message}`);
}

/** One deploy's mutable bookkeeping: state, step records, journal and progress. */
class Run {
  state: DeployTargetState = 'queued';
  readonly steps: StepRecord[] = [];
  lock: AppLock | null = null;

  constructor(
    private readonly ports: SequencePorts,
    private readonly ctx: MachineContext,
    readonly request: DeployRequest,
    readonly log: Log,
    /** False for a dry run: nothing is journaled. */
    private readonly journaled: boolean,
  ) {}

  async move(to: DeployTargetState, step?: string): Promise<void> {
    this.state = transition(this.state, to);
    this.log.info({ state: to, step }, `deploy ${to}`);
    this.ctx.onProgress?.({ deployId: this.request.deployId, state: to, ...(step === undefined ? {} : { step }) });
    if (this.lock !== null) await this.lock.setStep(step ?? to);
  }

  private entry(step: string, extra: Partial<JournalEntry> = {}): Omit<JournalEntry, 'phase' | 'at'> {
    return { deployId: this.request.deployId, app: this.request.app, step, ...extra };
  }

  async begin(step: string, extra: Partial<JournalEntry> = {}): Promise<StepRecord> {
    if (this.journaled) await this.ctx.journal.begin(this.entry(step, extra));
    const record: StepRecord = { name: step, state: this.state, startedAt: this.ports.clock.now().toISOString() };
    this.steps.push(record);
    return record;
  }

  async end(record: StepRecord, extra: Partial<JournalEntry> = {}): Promise<void> {
    record.endedAt = this.ports.clock.now().toISOString();
    if (extra.exitCode !== undefined) record.exitCode = extra.exitCode;
    if (extra.output !== undefined) record.output = extra.output;
    if (this.journaled) await this.ctx.journal.end(this.entry(record.name, extra));
  }
}

interface Outcome {
  state: DeployTargetState;
  images: VerifiedImage[];
  gates: GateResult[];
  refusal: Refusal | null;
  schemaRevision: string | null;
  backupArtifact: string | null;
}

function result(run: Run, outcome: Outcome): DeployResult {
  return {
    deployId: run.request.deployId,
    app: run.request.app,
    state: outcome.state,
    sha: run.request.sha,
    images: outcome.images,
    schemaRevision: outcome.schemaRevision,
    gates: outcome.gates,
    refusal: outcome.refusal,
    steps: run.steps,
    backupArtifact: outcome.backupArtifact,
  };
}

/**
 * Runs one forward deploy of `request.sha` for `request.app`. Only `app` and `sha` (and the
 * deploy ID, requester label and dry-run flag) are read from the request; everything else comes
 * from the host's manifest.
 */
export async function runDeploy(ports: SequencePorts, ctx: MachineContext, request: DeployRequest): Promise<DeployResult> {
  const log = ports.log.child({ deployId: request.deployId, app: request.app });
  const loaded = ctx.manifests.get(request.app);
  const run = new Run(ports, ctx, request, log, !request.dryRun && loaded !== undefined);
  const empty: Outcome = { state: 'refused', images: [], gates: [], refusal: null, schemaRevision: null, backupArtifact: null };

  await run.move('verifying', 'verify');
  if (loaded === undefined) {
    await run.move('refused');
    return result(run, { ...empty, refusal: refusal('unknown_app', `No manifest on this host for app "${request.app}".`) });
  }
  const manifest = loaded.manifest;
  const target = composeTargetOf(manifest);

  if (request.dryRun) {
    const resolved = await resolveDeployTarget(ports, ctx.ledger, manifest, request.sha, {
      dryRun: true,
      envNamesProvider: ctx.envNamesProvider,
    });
    if (resolved.refusal !== null) {
      await run.move('refused');
      return result(run, { ...empty, gates: resolved.gates, refusal: resolved.refusal });
    }
    // A passing dry run stops at verify: nothing is locked, journaled or written (SHP-REQ-050).
    return result(run, { ...empty, state: 'verifying', gates: resolved.gates, images: resolved.images });
  }

  const acquired = await AppLock.acquire(
    ctx.dataRoot,
    request.app,
    {
      pid: process.pid,
      deployId: request.deployId,
      requesterLabel: request.requesterLabel,
      sha: request.sha,
      step: 'verify',
      at: ports.clock.now().toISOString(),
    },
    {
      ...(ctx.lockHeartbeatMs === undefined ? {} : { heartbeatMs: ctx.lockHeartbeatMs }),
      ...(ctx.lockStaleMs === undefined ? {} : { staleMs: ctx.lockStaleMs }),
    },
  );
  if (!(acquired instanceof AppLock)) {
    await run.move('refused');
    return result(run, { ...empty, refusal: acquired });
  }
  run.lock = acquired;

  try {
    await ctx.journal.begin({
      deployId: request.deployId,
      app: request.app,
      step: 'deploy',
      detail: { historyDeployId: request.deployId, composeFiles: target.files, project: target.project, sha: request.sha, kind: request.kind },
    });
    let outcome: Outcome;
    try {
      outcome = await deployLocked(ports, ctx, run, manifest, target);
    } catch (err) {
      // An unexpected error (not a refusal): record the deploy as failed rather than leave it open.
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message, state: run.state }, 'deploy crashed');
      if (canTransition(run.state, 'failed')) await run.move('failed');
      else if (canTransition(run.state, 'refused')) await run.move('refused');
      outcome = { ...empty, state: run.state, refusal: refusal('step_failed', `Deploy stopped at ${run.state}: ${message}`) };
    }
    await ctx.journal.end({
      deployId: request.deployId,
      app: request.app,
      step: 'deploy',
      detail: { state: outcome.state, ...(outcome.refusal === null ? {} : { code: outcome.refusal.code }) },
    });
    return result(run, outcome);
  } finally {
    await acquired.release();
  }
}

async function deployLocked(ports: SequencePorts, ctx: MachineContext, run: Run, manifest: Manifest, target: ComposeTarget): Promise<Outcome> {
  const verifyRecord = await run.begin('verify');
  let resolved: ResolvedTarget;
  try {
    resolved = await resolveDeployTarget(ports, ctx.ledger, manifest, run.request.sha, {
      dryRun: false,
      envNamesProvider: ctx.envNamesProvider,
    });
  } catch (err) {
    const refused = asRefusal(err, 'step_failed', 'Verify failed');
    await run.end(verifyRecord, { detail: { refused: refused.code } });
    await run.move('refused');
    return { state: 'refused', images: [], gates: [], refusal: refused, schemaRevision: null, backupArtifact: null };
  }
  // The verified release, recorded before anything changes: restart recovery reads `contract`
  // from here and never auto-rolls back a contract release (SHP-REQ-017, SHP-REQ-022).
  await run.end(verifyRecord, {
    detail: {
      gates: resolved.gates.map((g) => ({ gate: g.gate, pass: g.pass })),
      ...(resolved.refusal === null
        ? {
            contract: resolved.images.some((image) => image.migration === 'contract'),
            images: resolved.images.map((image) => ({ service: image.service, repo: image.repo, digest: image.digest, migration: image.migration })),
          }
        : { refused: resolved.refusal.code }),
    },
  });
  if (resolved.refusal !== null) {
    await run.move('refused');
    return { state: 'refused', images: [], gates: resolved.gates, refusal: resolved.refusal, schemaRevision: null, backupArtifact: null };
  }
  return executeTarget(ports, ctx, run, manifest, target, resolved.images, resolved.live, resolved.gates);
}

/**
 * Everything after verify, for images already verified. A rollback (Phase 2) resolves its images
 * from the ledger and joins here.
 */
async function executeTarget(
  ports: SequencePorts,
  ctx: MachineContext,
  run: Run,
  manifest: Manifest,
  target: ComposeTarget,
  images: VerifiedImage[],
  live: LiveState,
  gates: GateResult[],
): Promise<Outcome> {
  const { docker, fs } = ports;
  const services = images.map((image) => image.service);
  const deployId = run.request.deployId;
  let backupArtifact: string | null = null;
  const base = { images, gates, schemaRevision: null as string | null };
  const failBeforeSwap = async (refused: Refusal): Promise<Outcome> => {
    run.log.error({ code: refused.code, state: run.state }, refused.message);
    await run.move('failed');
    return { ...base, state: 'failed', refusal: refused, backupArtifact };
  };

  const secrets = await loadSecrets(fs, manifest.envFiles).catch(() => new Map<string, string>());

  // ─── backup ────────────────────────────────────────────────────────────────
  const backupStep = manifest.steps?.backup;
  if (backupStep !== undefined) {
    await run.move('backing_up', 'backup');
    const record = await run.begin('backup', { argv: backupStep.argv });
    try {
      const backup = await runBackup(ports, target, backupStep);
      backupArtifact = backup.artifact.path;
      await run.end(record, { exitCode: backup.exitCode, detail: { artifact: backup.artifact.path, size: backup.artifact.size } });
    } catch (err) {
      const refused = asRefusal(err, 'backup_failed', 'Backup failed');
      await run.end(record, { detail: { refused: refused.code } });
      return failBeforeSwap(refused);
    }
  }

  // ─── migrate ───────────────────────────────────────────────────────────────
  const migrateStep = manifest.steps?.migrate;
  if (migrateStep !== undefined) {
    await run.move('migrating', 'migrate');
    const record = await run.begin('migrate', { argv: migrateStep.argv });
    try {
      await fs.mkdirp(ctx.workDir);
      const migrated = await runMigrate(
        ports,
        target,
        migrateStep,
        images.map((image) => ({ service: image.service, reference: image.reference })),
        ctx.workDir,
        secrets,
      );
      await run.end(record, { exitCode: migrated.exitCode, output: migrated.output });
    } catch (err) {
      const refused = asRefusal(err, 'migrate_failed', 'Migrate failed');
      await run.end(record, { detail: { refused: refused.code } });
      return failBeforeSwap(refused);
    }
  }

  // ─── pull ──────────────────────────────────────────────────────────────────
  await run.move('pulling', 'pull');
  {
    const args = ['pull', ...services];
    const record = await run.begin('pull', { argv: args });
    try {
      await fs.mkdirp(ctx.workDir);
      const overridePath = `${ctx.workDir}/${deployId}.pull-override.yaml`;
      const override: Record<string, { image: string }> = {};
      for (const image of images) override[image.service] = { image: image.reference };
      await fs.writeFileAtomic(overridePath, stringifyYaml({ services: override }));
      let pulled;
      try {
        pulled = await docker.compose({ files: [...target.files, overridePath], project: target.project }, args);
      } finally {
        await unlink(overridePath).catch(() => undefined);
      }
      const output = redact(`${pulled.stdout}\n${pulled.stderr}`, secrets);
      await run.end(record, { exitCode: pulled.exitCode, output });
      if (pulled.exitCode !== 0) {
        return await failBeforeSwap(refusal('step_failed', `compose pull exited ${pulled.exitCode}.\n${output}`));
      }
    } catch (err) {
      const refused = asRefusal(err, 'step_failed', 'Pull failed');
      await run.end(record, { detail: { refused: refused.code } });
      return failBeforeSwap(refused);
    }
  }

  // ─── swap ──────────────────────────────────────────────────────────────────
  await run.move('swapping', 'swap');
  const swapRecord = await run.begin('swap', { detail: { historyDeployId: deployId } });
  try {
    const files = await Promise.all(target.files.map(async (path) => ({ path, text: await fs.readFile(path) })));
    const plan = planRewrite(
      files,
      images.map((image) => ({ service: image.service, repo: image.repo, reference: image.reference })),
    );
    await applyRewrite(fs, plan, { dir: ctx.historyDir, deployId });
  } catch (err) {
    // Nothing was written (planRewrite refuses before any write; applyRewrite undoes a partial one).
    const refused = asRefusal(err, 'step_failed', 'Compose rewrite failed');
    await run.end(swapRecord, { detail: { refused: refused.code } });
    return failBeforeSwap(refused);
  }
  await testPause('swap-rewrite');

  const upArgs = ['up', '-d', '--no-deps', ...services];
  const up = await docker.compose(target, upArgs);
  const upOutput = redact(`${up.stdout}\n${up.stderr}`, secrets);
  await run.end(swapRecord, { argv: upArgs, exitCode: up.exitCode, output: upOutput });
  if (up.exitCode !== 0) {
    return afterSwapFailure(ports, ctx, run, target, images, live, base, backupArtifact, refusal('step_failed', `compose up exited ${up.exitCode}.\n${upOutput}`));
  }

  // ─── check ─────────────────────────────────────────────────────────────────
  await run.move('checking', 'check');
  const checkRecord = await run.begin('check');
  const checked = await pollCheck(ports, ctx, manifest, target, images);
  await run.end(checkRecord, { detail: checked.ok ? { schema: checked.schema } : { refused: checked.refusal.code } });
  if (!checked.ok) {
    return afterSwapFailure(ports, ctx, run, target, images, live, base, backupArtifact, checked.refusal);
  }

  // ─── soak ──────────────────────────────────────────────────────────────────
  await run.move('soaking', 'soak');
  const soakRecord = await run.begin('soak', { detail: { seconds: manifest.soakSeconds } });
  const soaked = await soak(ports, ctx, manifest, target, images);
  await run.end(soakRecord, { detail: soaked.ok ? { schema: soaked.schema } : { refused: soaked.refusal.code } });
  if (!soaked.ok) {
    return afterSwapFailure(ports, ctx, run, target, images, live, base, backupArtifact, soaked.refusal);
  }
  const schemaRevision = soaked.schema;

  // ─── success ───────────────────────────────────────────────────────────────
  await ctx.ledger.append({
    app: manifest.name,
    deployId,
    kind: run.request.kind,
    sha: run.request.sha,
    images: images.map((image) => ({ service: image.service, repo: image.repo, digest: image.digest, migration: image.migration })),
    backupArtifact,
    at: ports.clock.now().toISOString(),
  });
  try {
    await pruneAfterSuccess(ports, manifest, target, ctx.ledger.knownDigests(manifest.name));
  } catch (err) {
    run.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'pruning after a successful deploy failed');
  }
  await run.move('succeeded');
  return { ...base, state: 'succeeded', schemaRevision, refusal: null, backupArtifact };
}

async function pollCheck(
  ports: SequencePorts,
  ctx: MachineContext,
  manifest: Manifest,
  target: ComposeTarget,
  images: VerifiedImage[],
): Promise<CheckOutcome> {
  const timeoutMs = ctx.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const intervalMs = ctx.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const probeTimeoutMs = ctx.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const deadline = ports.clock.now().getTime() + timeoutMs;
  for (;;) {
    const outcome = await checkOnce(ports.docker, target, manifest, images, { probeTimeoutMs });
    if (outcome.ok || outcome.definitive || ports.clock.now().getTime() >= deadline) return outcome;
    await ports.clock.sleep(intervalMs);
  }
}

interface ContainerIdentity {
  id: string;
  startedAt: string | undefined;
  restartCount: number | undefined;
}

/** service → the identity of each of its running containers now. */
async function identities(docker: SequencePorts['docker'], target: ComposeTarget, images: VerifiedImage[]): Promise<Map<string, ContainerIdentity[]>> {
  const containers = await docker.containers(target);
  const out = new Map<string, ContainerIdentity[]>();
  for (const image of images) {
    out.set(
      image.service,
      containers
        .filter((c) => c.service === image.service && c.state === 'running')
        .map((c) => ({ id: c.id, startedAt: c.startedAt, restartCount: c.restartCount })),
    );
  }
  return out;
}

/**
 * A container that was running at the start of soak and is now gone, not running, or started again
 * (a new StartedAt or RestartCount) crashed between two ticks, however healthy it answers now.
 */
async function restartDuringSoak(
  docker: SequencePorts['docker'],
  target: ComposeTarget,
  baseline: Map<string, ContainerIdentity[]>,
): Promise<Refusal | null> {
  const containers = await docker.containers(target);
  for (const [service, before] of baseline) {
    for (const was of before) {
      const now = containers.find((c) => c.id === was.id);
      const why =
        now === undefined
          ? 'its container is gone'
          : now.state !== 'running'
            ? `its container is ${now.state}`
            : now.startedAt !== was.startedAt
              ? `its container started again at ${now.startedAt ?? '(unknown)'}`
              : now.restartCount !== was.restartCount
                ? `its restart count went from ${String(was.restartCount)} to ${String(now.restartCount)}`
                : null;
      if (why !== null) return refusal('health_failed', `Service "${service}" restarted during soak: ${why}.`);
    }
  }
  return null;
}

/**
 * Keeps checking for the manifest's soak duration (SHP-REQ-025); the first failure ends it. Each
 * tick also compares every container against the one that started the soak, so a crash and a
 * restart between two ticks is a failure too, not a blind spot.
 */
async function soak(
  ports: SequencePorts,
  ctx: MachineContext,
  manifest: Manifest,
  target: ComposeTarget,
  images: VerifiedImage[],
): Promise<CheckOutcome> {
  const intervalMs = ctx.soakIntervalMs ?? DEFAULT_SOAK_INTERVAL_MS;
  const probeTimeoutMs = ctx.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const end = ports.clock.now().getTime() + manifest.soakSeconds * 1000;
  const baseline = await identities(ports.docker, target, images).catch(() => new Map<string, ContainerIdentity[]>());
  for (const [service, running] of baseline) {
    // Checked a moment ago, so this is a crash in between: soak has nothing to watch.
    if (running.length === 0) {
      return { ok: false, definitive: true, refusal: refusal('health_failed', `Service "${service}" had no running container when soak began.`) };
    }
  }
  let last: CheckOutcome | null = null;
  while (ports.clock.now().getTime() < end) {
    await ports.clock.sleep(Math.min(intervalMs, Math.max(0, end - ports.clock.now().getTime())));
    const restarted = await restartDuringSoak(ports.docker, target, baseline).catch(() => null);
    if (restarted !== null) return { ok: false, definitive: true, refusal: restarted };
    last = await checkOnce(ports.docker, target, manifest, images, { probeTimeoutMs });
    if (!last.ok) return last;
  }
  return last ?? (await checkOnce(ports.docker, target, manifest, images, { probeTimeoutMs }));
}

/**
 * After the compose file was rewritten: a contract release stops where it is and keeps its backup
 * (SHP-REQ-017); anything else rolls back image-only to the previous compose file (SHP-REQ-016).
 */
async function afterSwapFailure(
  ports: SequencePorts,
  ctx: MachineContext,
  run: Run,
  target: ComposeTarget,
  images: VerifiedImage[],
  live: LiveState,
  base: { images: VerifiedImage[]; gates: GateResult[]; schemaRevision: string | null },
  backupArtifact: string | null,
  failure: Refusal,
): Promise<Outcome> {
  run.log.error({ code: failure.code, state: run.state }, failure.message);
  const services = images.map((image) => image.service);

  if (images.some((image) => image.migration === 'contract')) {
    run.log.error({ backupArtifact }, 'contract release failed: not rolling back; the backup is kept');
    await run.move('failed');
    return {
      ...base,
      state: 'failed',
      backupArtifact,
      refusal: {
        ...failure,
        message: `${failure.message} The release carries the contract migration label, so it was not rolled back${backupArtifact === null ? '' : `; the backup ${backupArtifact} is kept`}.`,
        fix: 'A contract migration cannot be undone by an image swap: fix forward, or restore the kept backup.',
      },
    };
  }

  await run.move('rolling_back', 'rollback');
  const record = await run.begin('rollback', { detail: { historyDeployId: run.request.deployId } });
  // Services that ran a digest before come back to it; a service that ran nothing (a first deploy)
  // is stopped and removed, so no image that failed its check keeps running (SHP-REQ-016).
  const previous: [string, string][] = [];
  const fresh: string[] = [];
  for (const service of services) {
    const digest = live.running[service];
    if (digest === null || digest === undefined) fresh.push(service);
    else previous.push([service, digest]);
  }
  const upArgs = ['up', '-d', '--no-deps', ...previous.map(([service]) => service)];
  const rmArgs = ['rm', '-s', '-f', ...fresh];
  const argv = previous.length > 0 ? upArgs : rmArgs;
  try {
    const restored = await restoreFromHistory(ports.fs, ctx.historyDir, run.request.deployId);
    let why: string | null = null;
    let rmExitCode: number | null = null;
    let upExitCode: number | null = null;
    let confirmed = false;
    if (fresh.length > 0) {
      const rm = await ports.docker.compose(target, rmArgs);
      rmExitCode = rm.exitCode;
      if (rm.exitCode !== 0) why = `compose rm exited ${rm.exitCode} removing ${fresh.join(', ')}, which had no previous release`;
    }
    if (previous.length > 0) {
      const up = await ports.docker.compose(target, upArgs);
      upExitCode = up.exitCode;
      if (up.exitCode !== 0) why ??= `compose up exited ${up.exitCode}`;
      else {
        confirmed = await confirmPrevious(ports, ctx, target, images, previous);
        if (!confirmed) why ??= 'the previous digests did not come back';
      }
    }
    const exitCode = upExitCode ?? rmExitCode;
    await run.end(record, {
      argv,
      ...(exitCode === null ? {} : { exitCode }),
      detail: { restored, confirmed, removed: fresh, ...(rmExitCode === null ? {} : { rmExitCode }) },
    });
    if (why !== null) {
      run.log.error({ why }, 'rollback failed');
      await run.move('failed');
      return { ...base, state: 'failed', backupArtifact, refusal: { ...failure, message: `${failure.message} Rollback failed: ${why}.` } };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await run.end(record, { argv, detail: { error: message } });
    await run.move('failed');
    return { ...base, state: 'failed', backupArtifact, refusal: { ...failure, message: `${failure.message} Rollback failed: ${message}.` } };
  }
  await run.move('rolled_back');
  const note = fresh.length > 0 ? ` ${fresh.join(', ')} had no previous release, so ${fresh.length === 1 ? 'it was' : 'they were'} stopped and removed.` : '';
  return { ...base, state: 'rolled_back', backupArtifact, refusal: { ...failure, message: `${failure.message}${note}` } };
}

/**
 * Polls until every service that had a digest before is running that digest again: any of the
 * running image's RepoDigests for the repository counts, not only the first.
 */
async function confirmPrevious(
  ports: SequencePorts,
  ctx: MachineContext,
  target: ComposeTarget,
  images: VerifiedImage[],
  previous: [string, string][],
): Promise<boolean> {
  const timeoutMs = ctx.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const intervalMs = ctx.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const deadline = ports.clock.now().getTime() + timeoutMs;
  const repoOf = new Map(images.map((image) => [image.service, image.repo]));
  for (;;) {
    const containers = await ports.docker.containers(target).catch((): RunningContainer[] => []);
    const back = previous.every(([service, digest]) => {
      const expected = `${repoOf.get(service) ?? ''}@${digest}`;
      const running = containers.filter((c) => c.service === service && c.state === 'running');
      return running.length > 0 && running.every((c) => c.repoDigests.includes(expected));
    });
    if (back) return true;
    if (ports.clock.now().getTime() >= deadline) return false;
    await ports.clock.sleep(intervalMs);
  }
}
