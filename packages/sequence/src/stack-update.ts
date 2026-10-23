import { refusal } from '@shipyard/schema';
import type { Digest, Refusal, StackManifest, StackTrack, StackUpdateJob, StackUpdateResult, StackUpdateStep } from '@shipyard/schema';

import { normalizeImageRepository } from './adapters/oci.js';
import { STACK_UPDATE_STEP, stackUpdateStep } from './journal.js';
import type { Journal } from './journal.js';
import type { Ledger, StackImageRecord } from './ledger.js';
import { AppLock } from './machine.js';
import type { LoadedStacks } from './manifest.js';
import { RefusalError, RegistryError } from './ports.js';
import type { Clock, ComposeTarget, DockerPort, FsPort, Log, RunningContainer, StackRegistryPort } from './ports.js';
import { loadSecrets, redact } from './redact.js';
import { applyRewrite, currentImageValues, planRewrite, restoreFromHistory } from './rewrite.js';
import type { RewritePlanFile } from './rewrite.js';
import { compareVersions, parseTagVersion, pickSemverTag, SemverRangeError } from './semver.js';
import { runBackup } from './steps.js';

/**
 * Updating an adopted stack by digest (SHP-ADR-010; SHP-REQ-194..198). What reaches the host is a
 * stack name and, per tracked service, a `sha256:` digest — or, for a rollback, an earlier update's
 * ID. Everything else comes from the host: the stack manifest, its compose files, the registry the
 * agent asks itself, and the agent's own ledger.
 *
 * An update runs verify → backup (if the stack has one) → pull by digest → swap → check → soak, each
 * step journaled before it runs (SHP-D-029):
 *
 * - **verify** re-resolves each requested service's track now and refuses `digest_not_tracked`
 *   unless it resolves to exactly the requested digest (SHP-REQ-195), and `registry_unreachable`
 *   when the registry cannot answer — fail closed, no override (SHP-REQ-196). A semver track never
 *   goes backwards: a resolved tag below the one the image line names refuses `digest_not_tracked`.
 *   It reads the compose files once and plans the image-line rewrite from them, so a compose file
 *   Shipyard cannot safely rewrite refuses (`image_line_invalid`) before anything changes.
 * - **backup** runs the stack's backup step in its named service; `backup_failed` stops here.
 * - **pull** re-resolves each track first (the tag may have moved during the backup:
 *   `digest_not_tracked`), then is `docker pull repo@sha256:…`, never a tag, so what runs is what
 *   was verified.
 * - **swap** rewrites only the service's `image:` line to `repo:tag@sha256:…` (`repo@sha256:…` for
 *   a pinned service), atomically, keeping the previous file under the update's ID — against the
 *   content verify read: a file edited since is refused (`conflict`), never overwritten — then
 *   `compose up -d --no-deps --no-build --pull never <services>` with a timeout: only those
 *   services are recreated.
 * - **check** waits for each service to run the new digest and be healthy: `healthy` where its
 *   container has a healthcheck, and the stack's HTTP check (`health:`) when it names one.
 * - **soak** keeps checking for `soakSeconds`; a restart in between is a failure too.
 *
 * Success records a `stack-update` ledger entry (SHP-REQ-197). Any failure after the swap — a check,
 * the soak, or a throw from the journal, the lock, the Engine or the ledger — rolls back image-only:
 * the previous image lines come back and the services are recreated on the digests they ran
 * before, which are confirmed (SHP-REQ-198). When even the image lines cannot be put back, the
 * update's bracket stays open and restart recovery restores the kept file. A
 * rollback job takes its digests from a `stack-update` ledger entry and from nowhere else
 * (`rollback_target_invalid` otherwise), and runs the same pull/swap/check/soak path without a backup.
 */

export type DigestUpdatedStack = Extract<StackManifest, { updates: 'digest' }>;

export interface StackUpdatePorts {
  registry: StackRegistryPort;
  docker: DockerPort;
  fs: FsPort;
  clock: Clock;
  log: Log;
}

export interface StackUpdateContext {
  dataRoot: string;
  stacks: LoadedStacks;
  journal: Journal;
  ledger: Ledger;
  /** Where the previous compose files are kept, per update ID. */
  historyDir: string;
  /** Called as each step starts; the agent turns it into progress for the server. */
  onStep?: (step: StackUpdateStep) => void;
  /**
   * True while something else holds this stack on this host (a lifecycle action the agent is
   * running). A held deploy lock is seen through the lock itself; this is the in-process extra.
   */
  busy?: (stack: string) => boolean | Promise<boolean>;
  /**
   * Backs up the stack's volumes inside the update, after its own backup step and before the pull,
   * when its manifest says `volumeBackups.beforeUpdate` (SHP-ADR-012, SHP-REQ-201). Returns a
   * refusal when a backup failed, which fails the update before anything changed. The agent wires
   * it to `backupVolumesBeforeUpdate`; absent, such a stack's update fails closed.
   */
  backupVolumes?: (stack: string, updateId: string) => Promise<Refusal | null>;
  /** How long `check` (and a rollback's confirmation) may wait. Default 120 s. */
  healthTimeoutMs?: number;
  /** Poll interval during `check`. Default 2 s. */
  checkIntervalMs?: number;
  /** Poll interval during `soak`. Default 10 s. */
  soakIntervalMs?: number;
  /** Per-probe timeout for the HTTP check. Default 5 s. */
  probeTimeoutMs?: number;
  /** How long one `compose up` of the swap or the rollback may run before it is killed. Default 5 min. */
  composeTimeoutMs?: number;
  lockHeartbeatMs?: number;
  lockStaleMs?: number;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 120_000;
const DEFAULT_CHECK_INTERVAL_MS = 2_000;
const DEFAULT_SOAK_INTERVAL_MS = 10_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
export const STACK_COMPOSE_TIMEOUT_MS = 5 * 60_000;
const JOURNAL_OUTPUT_LINES = 50;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

// ─── Tracks and running digests ──────────────────────────────────────────────

export type TrackResolution =
  | { kind: 'pinned' }
  | { kind: 'resolved'; tag: string; digest: Digest }
  /** The registry answered, but the track names nothing: the tag is gone, or no tag is in range. */
  | { kind: 'missing'; why: string };

/**
 * What a service's track resolves to now (SHP-REQ-194). Throws `RegistryError` when the registry
 * cannot answer; a pinned service asks the registry nothing.
 */
export async function resolveTrack(registry: StackRegistryPort, image: string, track: StackTrack): Promise<TrackResolution> {
  if (track === 'pinned') return { kind: 'pinned' };
  let tag: string;
  if ('tag' in track) {
    tag = track.tag;
  } else {
    let picked: string | null;
    try {
      picked = pickSemverTag(await registry.listTags(image), track.semver);
    } catch (err) {
      if (err instanceof SemverRangeError) return { kind: 'missing', why: err.message };
      throw err;
    }
    if (picked === null) return { kind: 'missing', why: `no tag of ${image} is in the range ${track.semver}` };
    tag = picked;
  }
  const digest = await registry.resolveDigest(image, tag);
  if (digest === null) return { kind: 'missing', why: `${image}:${tag} does not exist in the registry` };
  return { kind: 'resolved', tag, digest };
}

/** True when `container` runs `repo@digest`, whichever spelling of the repository either uses. */
export function runsDigest(container: Pick<RunningContainer, 'repoDigests'>, repo: string, digest: string): boolean {
  const want = normalizeImageRepository(repo);
  return container.repoDigests.some((ref) => {
    const at = ref.lastIndexOf('@');
    return at > 0 && ref.slice(at + 1) === digest && normalizeImageRepository(ref.slice(0, at)) === want;
  });
}

/** The digest a running container of `repo` carries, or null. */
function digestOf(container: Pick<RunningContainer, 'repoDigests'>, repo: string): Digest | null {
  const want = normalizeImageRepository(repo);
  for (const ref of container.repoDigests) {
    const at = ref.lastIndexOf('@');
    if (at <= 0 || normalizeImageRepository(ref.slice(0, at)) !== want) continue;
    const digest = ref.slice(at + 1);
    if (DIGEST_RE.test(digest)) return digest;
  }
  return null;
}

/** service → the digest its running container carries for the service's image, or null (SHP-REQ-194). */
export async function stackRunningDigests(
  docker: DockerPort,
  compose: ComposeTarget,
  services: Record<string, { image: string }>,
): Promise<Record<string, Digest | null>> {
  const containers = await docker.containers(compose);
  const out: Record<string, Digest | null> = {};
  for (const [service, { image }] of Object.entries(services)) {
    const running = containers.filter((c) => c.service === service && c.state === 'running');
    out[service] = running.map((c) => digestOf(c, image)).find((d) => d !== null) ?? null;
  }
  return out;
}

/** `repo:tag@digest`, or `repo@digest` when there is no tag. */
export function stackImageReference(repo: string, tag: string | null, digest: string): string {
  return tag === null ? `${repo}@${digest}` : `${repo}:${tag}@${digest}`;
}

/** The tag of an image line's value (`repo[:tag][@digest]`; a registry port is not a tag), or null. */
export function tagOfReference(value: string): string | null {
  const at = value.indexOf('@');
  const named = at === -1 ? value : value.slice(0, at);
  const lastSlash = named.lastIndexOf('/');
  const colon = named.lastIndexOf(':');
  if (colon <= lastSlash) return null;
  const tag = named.slice(colon + 1);
  return TAG_RE.test(tag) ? tag : null;
}

/**
 * True when moving a semver-tracked service from the tag it runs to `toTag` would go backwards
 * (SHP-REQ-195): both tags name versions and the running one is higher. A tag that names no
 * version (`latest`) and a `{ tag }` track are never "backwards" — a moving tag's digest changes.
 */
export function wouldGoBackwards(track: StackTrack, fromTag: string | null, toTag: string): boolean {
  if (track === 'pinned' || !('semver' in track) || fromTag === null) return false;
  const from = parseTagVersion(fromTag);
  const to = parseTagVersion(toTag);
  return from !== null && to !== null && compareVersions(from, to) > 0;
}

/**
 * service → the tag its literal compose image line names now (`postgres:16.4@sha256:…` → `16.4`),
 * or null when the line has no tag or is not one literal line. Reads only the stack's own files.
 */
export async function stackImageTags(fs: Pick<FsPort, 'readFile'>, compose: ComposeTarget, services: string[]): Promise<Record<string, string | null>> {
  const files = await Promise.all(compose.files.map(async (path) => ({ path, text: await fs.readFile(path) })));
  const lines = currentImageValues(files, services);
  return Object.fromEntries(services.map((service) => [service, lines[service] === null || lines[service] === undefined ? null : tagOfReference(lines[service])]));
}

function sameRepository(current: string, mapped: string): boolean {
  return normalizeImageRepository(current) === normalizeImageRepository(mapped);
}

// ─── Health ──────────────────────────────────────────────────────────────────

interface Expectation {
  service: string;
  repo: string;
  /** The digest the service must run; null when only "running and healthy" can be asked. */
  digest: string | null;
}

type CheckOutcome = { ok: true } | { ok: false; definitive: boolean; why: string };

/**
 * One look: each service runs (on the expected digest), no container is `unhealthy` and every one
 * with a healthcheck is `healthy`, and the stack's HTTP check answers 2xx when it has one.
 */
async function checkOnce(docker: DockerPort, compose: ComposeTarget, stack: DigestUpdatedStack, expected: Expectation[], probeTimeoutMs: number): Promise<CheckOutcome> {
  for (const want of expected) {
    let containers: RunningContainer[];
    try {
      containers = await docker.containers(compose, want.service);
    } catch (err) {
      return { ok: false, definitive: false, why: `could not list ${want.service}'s containers: ${err instanceof Error ? err.message : String(err)}` };
    }
    const running = containers.filter((c) => c.state === 'running');
    if (running.length === 0) {
      const states = containers.map((c) => c.state).join(', ');
      return { ok: false, definitive: false, why: `${want.service} has no running container${states === '' ? '' : ` (${states})`}` };
    }
    for (const c of running) {
      if (want.digest !== null && !runsDigest(c, want.repo, want.digest)) {
        return { ok: false, definitive: false, why: `${want.service} runs ${c.repoDigests.join(', ') || 'no digest'}, not ${want.repo}@${want.digest}` };
      }
      if (c.health === 'unhealthy') return { ok: false, definitive: true, why: `${want.service}'s container healthcheck reports unhealthy` };
      if (c.health === 'starting') return { ok: false, definitive: false, why: `${want.service}'s container healthcheck is still starting` };
    }
  }
  if (stack.health !== undefined) {
    const { service, port, path } = stack.health;
    try {
      const res = await docker.probeHealth(compose, service, port, path, probeTimeoutMs);
      if (res.httpStatus < 200 || res.httpStatus > 299) return { ok: false, definitive: false, why: `GET ${path} on ${service}:${String(port)} answered HTTP ${String(res.httpStatus)}` };
    } catch (err) {
      return { ok: false, definitive: false, why: `GET ${path} on ${service}:${String(port)} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { ok: true };
}

interface Timings {
  healthTimeoutMs: number;
  checkIntervalMs: number;
  soakIntervalMs: number;
  probeTimeoutMs: number;
}

/** Polls `checkOnce` until it passes, is definitive, or the health timeout passes. */
async function waitHealthy(ports: StackUpdatePorts, compose: ComposeTarget, stack: DigestUpdatedStack, expected: Expectation[], t: Timings): Promise<CheckOutcome> {
  const deadline = ports.clock.now().getTime() + t.healthTimeoutMs;
  for (;;) {
    const outcome = await checkOnce(ports.docker, compose, stack, expected, t.probeTimeoutMs);
    if (outcome.ok || outcome.definitive || ports.clock.now().getTime() >= deadline) return outcome;
    await ports.clock.sleep(t.checkIntervalMs);
  }
}

interface Identity {
  id: string;
  startedAt: string | undefined;
  restartCount: number | undefined;
}

async function identities(docker: DockerPort, compose: ComposeTarget, services: string[]): Promise<Map<string, Identity[]>> {
  const containers = await docker.containers(compose);
  return new Map(
    services.map((service) => [
      service,
      containers.filter((c) => c.service === service && c.state === 'running').map((c) => ({ id: c.id, startedAt: c.startedAt, restartCount: c.restartCount })),
    ]),
  );
}

async function restarted(docker: DockerPort, compose: ComposeTarget, baseline: Map<string, Identity[]>): Promise<string | null> {
  const containers = await docker.containers(compose);
  for (const [service, before] of baseline) {
    for (const was of before) {
      const now = containers.find((c) => c.id === was.id);
      if (now === undefined) return `${service}'s container is gone`;
      if (now.state !== 'running') return `${service}'s container is ${now.state}`;
      if (now.startedAt !== was.startedAt || now.restartCount !== was.restartCount) return `${service}'s container restarted`;
    }
  }
  return null;
}

/** Keeps checking for `soakSeconds`; the first failure, or a restart between two ticks, ends it. */
async function soak(ports: StackUpdatePorts, compose: ComposeTarget, stack: DigestUpdatedStack, expected: Expectation[], t: Timings): Promise<CheckOutcome> {
  const end = ports.clock.now().getTime() + stack.soakSeconds * 1000;
  let baseline: Map<string, Identity[]>;
  try {
    baseline = await identities(
      ports.docker,
      compose,
      expected.map((e) => e.service),
    );
  } catch (err) {
    return { ok: false, definitive: true, why: `could not list containers when the soak began: ${err instanceof Error ? err.message : String(err)}` };
  }
  while (ports.clock.now().getTime() < end) {
    await ports.clock.sleep(Math.min(t.soakIntervalMs, Math.max(0, end - ports.clock.now().getTime())));
    const why = await restarted(ports.docker, compose, baseline).catch((err: unknown) => `could not list containers: ${err instanceof Error ? err.message : String(err)}`);
    if (why !== null) return { ok: false, definitive: true, why: `${why} during the soak` };
    const outcome = await checkOnce(ports.docker, compose, stack, expected, t.probeTimeoutMs);
    if (!outcome.ok) return outcome;
  }
  return { ok: true };
}

// ─── The run ─────────────────────────────────────────────────────────────────

function flagLike(value: string): boolean {
  return value.startsWith('-');
}

function lastLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Target extends StackImageRecord {
  reference: string;
}

function asImages(records: StackImageRecord[]): StackUpdateResult['images'] {
  return records.map((r) => ({ service: r.service, tag: r.tag, digest: r.digest }));
}

/** The compose arguments that recreate exactly these services from what the file names now. */
export function stackUpArgs(services: string[]): string[] {
  return ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', ...services];
}

/**
 * Where a run stands with the compose file, for its bracket: once the swap has written the file
 * and until a rollback has put the previous image lines back, the bracket is left open on any
 * failure, so restart recovery puts the previous file back (SHP-REQ-198, SHP-D-029).
 */
interface SwapState {
  swapped: boolean;
  restored: boolean;
}

/**
 * Runs one stack update or rollback job to its end and returns the result to report. Never throws:
 * an unexpected error is a `failed` result (or `refused`, before anything changed).
 */
export async function runStackUpdate(ports: StackUpdatePorts, ctx: StackUpdateContext, job: StackUpdateJob): Promise<StackUpdateResult> {
  const log = ports.log.child({ updateId: job.updateId, stack: job.stack });
  const refused = (why: Refusal): StackUpdateResult => {
    log.warn({ code: why.code }, why.message);
    return { updateId: job.updateId, state: 'refused', images: [], previous: [], refusal: why };
  };

  ctx.onStep?.('verifying');
  const loaded = ctx.stacks.get(job.stack);
  if (loaded === undefined) return refused(refusal('not_adopted', `No stack named ${job.stack} is adopted on this host.`));
  const stack = loaded.manifest;
  if (stack.updates !== 'digest') return refused(refusal('updates_disabled', `The stack ${job.stack} is adopted with updates: none.`));
  if (flagLike(stack.compose.project) || stack.compose.files.some(flagLike)) {
    return refused(refusal('invalid_request', `The stack ${job.stack} names a compose project or file beginning with "-"; Shipyard will not pass it to compose.`));
  }
  if (ctx.busy !== undefined && (await ctx.busy(job.stack))) {
    return refused(refusal('locked', `Something else is running on the stack ${job.stack} on this host; the ${job.kind} was not started.`));
  }

  const lock = await AppLock.acquire(
    ctx.dataRoot,
    job.stack,
    { pid: process.pid, deployId: job.updateId, requesterLabel: job.requesterLabel ?? 'shipyard server', sha: '', step: 'stack verify', at: ports.clock.now().toISOString() },
    {
      ...(ctx.lockHeartbeatMs === undefined ? {} : { heartbeatMs: ctx.lockHeartbeatMs }),
      ...(ctx.lockStaleMs === undefined ? {} : { staleMs: ctx.lockStaleMs }),
    },
  );
  if (!(lock instanceof AppLock)) return refused(lock);

  const compose: ComposeTarget = { files: stack.compose.files, project: stack.compose.project };
  try {
    const services = job.kind === 'update' ? Object.keys(job.digests) : [];
    try {
      // An earlier update left open with its compose file rewritten is restart recovery's to put
      // back; a new one written over it would be clobbered when that happens (SHP-REQ-198).
      const open = (await ctx.journal.unfinishedStackUpdates()).find((u) => u.stack === job.stack && u.updateId !== job.updateId);
      if (open !== undefined) {
        return refused(
          refusal(
            'conflict',
            `An earlier update of ${job.stack} (${open.updateId}) did not finish, and its previous compose file has not been put back yet; the ${job.kind} was not started.`,
            'Restart the agent: it puts the previous compose file back, then update again.',
          ),
        );
      }
      await ctx.ledger.refresh();
      // The bracket first: if it cannot be written, nothing runs (SHP-D-029).
      await ctx.journal.begin({
        deployId: job.updateId,
        app: job.stack,
        step: STACK_UPDATE_STEP,
        detail: { kind: job.kind, composeFiles: compose.files, project: compose.project, services, ...(job.kind === 'rollback' ? { toUpdateId: job.toUpdateId } : {}) },
      });
    } catch (err) {
      return refused(refusal('step_failed', `The stack ${job.kind} could not be journaled, so it was not run: ${message(err)}`));
    }

    const swap: SwapState = { swapped: false, restored: false };
    let result: StackUpdateResult;
    try {
      result = await updateLocked(ports, ctx, job, stack, compose, lock, log, swap);
    } catch (err) {
      log.error({ err: message(err) }, 'stack update crashed');
      result = { updateId: job.updateId, state: 'failed', images: [], previous: [], refusal: refusal('step_failed', `The stack ${job.kind} stopped: ${message(err)}`) };
    }
    if (result.state !== 'succeeded' && swap.swapped && !swap.restored) {
      // The compose file may still name the new image: the bracket stays open, and restart
      // recovery puts the previous file back from the history copy (SHP-REQ-198).
      log.error({ state: result.state }, 'stack update left its compose file rewritten; its bracket stays open for restart recovery');
      return result;
    }
    try {
      await ctx.journal.end({
        deployId: job.updateId,
        app: job.stack,
        step: STACK_UPDATE_STEP,
        detail: { kind: job.kind, state: result.state, ...(result.refusal === undefined ? {} : { code: result.refusal.code }) },
      });
    } catch (err) {
      // What happened still happened; an open bracket is closed by restart recovery.
      log.error({ err: message(err) }, 'could not close the stack update in the journal');
    }
    return result;
  } finally {
    await lock.release();
  }
}

async function updateLocked(
  ports: StackUpdatePorts,
  ctx: StackUpdateContext,
  job: StackUpdateJob,
  stack: DigestUpdatedStack,
  compose: ComposeTarget,
  lock: AppLock,
  log: Log,
  swap: SwapState,
): Promise<StackUpdateResult> {
  const { docker, fs } = ports;
  const journal = ctx.journal;
  const t: Timings = {
    healthTimeoutMs: ctx.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
    checkIntervalMs: ctx.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
    soakIntervalMs: ctx.soakIntervalMs ?? DEFAULT_SOAK_INTERVAL_MS,
    probeTimeoutMs: ctx.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  };
  const composeTimeoutMs = ctx.composeTimeoutMs ?? STACK_COMPOSE_TIMEOUT_MS;
  const entry = (step: string, extra: { argv?: string[]; exitCode?: number; output?: string; detail?: Record<string, unknown> } = {}) => ({
    deployId: job.updateId,
    app: job.stack,
    step: stackUpdateStep(step),
    ...extra,
  });
  const enter = async (step: StackUpdateStep, name: string): Promise<void> => {
    ctx.onStep?.(step);
    await lock.setStep(`stack ${name}`);
  };
  const updateId = job.updateId;
  const refusedResult = (why: Refusal): StackUpdateResult => {
    log.warn({ code: why.code }, why.message);
    return { updateId, state: 'refused', images: [], previous: [], refusal: why };
  };

  // ─── verify ────────────────────────────────────────────────────────────────
  await journal.begin(entry('verify'));
  const verified = await verify(ports, ctx, job, stack, compose);
  if ('refusal' in verified) {
    await journal.end(entry('verify', { detail: { refused: verified.refusal.code } }));
    return refusedResult(verified.refusal);
  }
  const { targets, previous, plan, lines } = verified;
  await journal.end(
    entry('verify', {
      detail: {
        images: targets.map(({ service, repo, tag, digest }) => ({ service, repo, tag, digest })),
        previous: previous.map(({ service, repo, tag, digest }) => ({ service, repo, tag, digest })),
      },
    }),
  );

  const secrets = await loadSecrets(fs, stack.envFiles).catch(() => new Map<string, string>());
  const services = targets.map((x) => x.service);
  let backupArtifact: StackUpdateResult['backupArtifact'];
  const failed = (why: Refusal): StackUpdateResult => {
    log.error({ code: why.code }, why.message);
    return { updateId, state: 'failed', images: asImages(previous), previous: asImages(previous), refusal: why, ...(backupArtifact === undefined ? {} : { backupArtifact }) };
  };

  // ─── backup ────────────────────────────────────────────────────────────────
  const backupStep = job.kind === 'update' ? stack.steps?.backup : undefined;
  if (backupStep !== undefined) {
    await enter('backing_up', 'backup');
    await journal.begin(entry('backup', { argv: backupStep.argv }));
    try {
      const backup = await runBackup({ docker, fs, clock: ports.clock }, compose, backupStep);
      backupArtifact = { path: backup.artifact.path, size: backup.artifact.size, createdAt: new Date(backup.artifact.mtimeMs).toISOString() };
      // Never its output (SHP-REQ-102): only where the artifact is.
      await journal.end(entry('backup', { exitCode: backup.exitCode, detail: { artifact: backup.artifact.path, size: backup.artifact.size } }));
    } catch (err) {
      const why = err instanceof RefusalError ? err.refusal : refusal('backup_failed', `The backup step failed: ${message(err)}`);
      await journal.end(entry('backup', { detail: { refused: why.code } }));
      return failed(why);
    }
  }

  // ─── volume backups (SHP-ADR-012: volumeBackups.beforeUpdate) ─────────────
  if (job.kind === 'update' && stack.volumeBackups?.beforeUpdate === true) {
    await enter('backing_up', 'volume backup');
    await journal.begin(entry('volume-backup'));
    let why: Refusal | null;
    try {
      why =
        ctx.backupVolumes === undefined
          ? refusal('backup_failed', 'This stack backs its volumes up before an update, and this agent cannot take volume backups; nothing was changed.')
          : await ctx.backupVolumes(job.stack, job.updateId);
    } catch (err) {
      why = refusal('backup_failed', `The volume backup failed: ${message(err)}`);
    }
    await journal.end(entry('volume-backup', { detail: why === null ? { ok: true } : { refused: why.code } }));
    if (why !== null) return failed(why.code === 'backup_failed' ? why : refusal('backup_failed', `The volume backup before the update failed: ${why.message}`));
  }

  // ─── pull ──────────────────────────────────────────────────────────────────
  await enter('pulling', 'pull');
  if (job.kind === 'update') {
    // Re-resolved right before the pull (SHP-REQ-195, SHP-REQ-196): a backup can take long enough
    // for the tag to move, and what is pulled must still be what the track names now.
    await journal.begin(entry('reverify'));
    const moved = await reverify(ports.registry, stack, targets);
    await journal.end(entry('reverify', { detail: moved === null ? { ok: true } : { refused: moved.code } }));
    if (moved !== null) return backupArtifact === undefined ? refusedResult(moved) : failed(moved);
  }
  for (const target of targets) {
    const ref = `${target.repo}@${target.digest}`;
    if (await isLocal(docker, target.repo, target.digest)) continue;
    const argv = ['docker', 'pull', ref];
    await journal.begin(entry('pull', { argv }));
    if (docker.pullImage === undefined) {
      await journal.end(entry('pull', { argv, detail: { refused: 'step_failed' } }));
      return failed(refusal('step_failed', "This agent's Docker adapter cannot pull an image by digest; nothing was changed."));
    }
    const pulled = await docker.pullImage(ref);
    const output = lastLines(redact(`${pulled.stdout}\n${pulled.stderr}`.trim(), secrets), JOURNAL_OUTPUT_LINES);
    await journal.end(entry('pull', { argv, exitCode: pulled.exitCode, output }));
    if (pulled.exitCode !== 0) return failed(refusal('step_failed', `docker pull ${ref} exited ${String(pulled.exitCode)}; nothing was changed.\n${output}`));
  }

  // ─── swap ──────────────────────────────────────────────────────────────────
  await enter('swapping', 'swap');
  const upArgs = stackUpArgs(services);
  await journal.begin(entry('swap', { argv: upArgs, detail: { historyId: updateId } }));
  try {
    // Written against the content verify planned from: a file edited since is refused, never
    // overwritten (`conflict`).
    await applyRewrite(fs, plan, { dir: ctx.historyDir, deployId: updateId }, { ifUnchanged: true });
  } catch (err) {
    // applyRewrite undoes a partial write before it throws: nothing changed.
    const why = err instanceof RefusalError ? err.refusal : refusal('step_failed', `The compose file could not be rewritten: ${message(err)}`);
    await journal.end(entry('swap', { detail: { refused: why.code, error: why.message } }));
    return failed(why);
  }
  swap.swapped = true;

  const rollBack = (why: Refusal): Promise<StackUpdateResult> =>
    rollBackImages(ports, ctx, { job, stack, compose, services, targets, previous, plan, lines, t, composeTimeoutMs, secrets, enter, entry, log, swap, ...(backupArtifact === undefined ? {} : { backupArtifact }) }, why);

  // Everything from here runs with the compose file rewritten: any throw — a journal or lock write,
  // the Engine, the ledger — rolls back image-only rather than leaving the new line in place
  // (SHP-REQ-198).
  const expected: Expectation[] = targets.map((x) => ({ service: x.service, repo: x.repo, digest: x.digest }));
  const afterSwap = async (): Promise<{ ok: true; result: StackUpdateResult } | { ok: false; why: Refusal }> => {
    const up = await docker.compose(compose, upArgs, { timeoutMs: composeTimeoutMs });
    const upOutput = lastLines(redact(`${up.stdout}\n${up.stderr}`.trim(), secrets), JOURNAL_OUTPUT_LINES);
    await journal.end(entry('swap', { argv: upArgs, exitCode: up.exitCode, output: upOutput }));
    if (up.exitCode !== 0) return { ok: false, why: refusal('step_failed', `compose up exited ${String(up.exitCode)}.\n${upOutput}`) };

    // ─── check ───────────────────────────────────────────────────────────────
    await enter('checking', 'check');
    await journal.begin(entry('check'));
    const checked = await waitHealthy(ports, compose, stack, expected, t);
    await journal.end(entry('check', { detail: checked.ok ? { ok: true } : { ok: false, why: checked.why } }));
    if (!checked.ok) return { ok: false, why: refusal('health_failed', `The ${job.kind} did not become healthy: ${checked.why}.`) };

    // ─── soak ────────────────────────────────────────────────────────────────
    await enter('soaking', 'soak');
    await journal.begin(entry('soak', { detail: { seconds: stack.soakSeconds } }));
    const soaked = await soak(ports, compose, stack, expected, t);
    await journal.end(entry('soak', { detail: soaked.ok ? { ok: true } : { ok: false, why: soaked.why } }));
    if (!soaked.ok) return { ok: false, why: refusal('health_failed', `The ${job.kind} failed its soak: ${soaked.why}.`) };

    // ─── record ──────────────────────────────────────────────────────────────
    // An update the ledger cannot record is not a success (SHP-REQ-197): a throw here rolls back.
    const images = targets.map(({ service, repo, tag, digest }) => ({ service, repo, tag, digest }));
    await ctx.ledger.append({
      kind: 'stack-update',
      app: job.stack,
      deployId: updateId,
      updateKind: job.kind,
      images,
      previous,
      backupArtifact: backupArtifact?.path ?? null,
      at: ports.clock.now().toISOString(),
    });
    log.info({ images }, `stack ${job.kind} succeeded`);
    return { ok: true, result: { updateId, state: 'succeeded', images: asImages(images), previous: asImages(previous), ...(backupArtifact === undefined ? {} : { backupArtifact }) } };
  };

  let outcome: Awaited<ReturnType<typeof afterSwap>>;
  try {
    outcome = await afterSwap();
  } catch (err) {
    outcome = { ok: false, why: refusal('step_failed', `The ${job.kind} stopped after the compose file was rewritten: ${message(err)}`) };
  }
  return outcome.ok ? outcome.result : rollBack(outcome.why);
}

/** Each update target's track, resolved again; a refusal when one moved or cannot be asked. */
async function reverify(registry: StackRegistryPort, stack: DigestUpdatedStack, targets: Target[]): Promise<Refusal | null> {
  for (const target of targets) {
    const tracked = stack.services[target.service];
    if (tracked === undefined) return refusal('digest_not_tracked', `${target.service} is no longer a tracked service of the stack ${stack.name}.`);
    let resolved: TrackResolution;
    try {
      resolved = await resolveTrack(registry, tracked.image, tracked.track);
    } catch (err) {
      if (err instanceof RegistryError) return refusal('registry_unreachable', `Could not resolve ${target.service}'s track again before the pull: ${err.message}. Nothing was changed.`);
      return refusal('registry_unreachable', `Could not resolve ${target.service}'s track again before the pull: ${message(err)}. Nothing was changed.`);
    }
    if (resolved.kind !== 'resolved' || resolved.digest !== target.digest) {
      const now = resolved.kind === 'resolved' ? `${resolved.digest} (${tracked.image}:${resolved.tag})` : resolved.kind === 'missing' ? `nothing (${resolved.why})` : 'pinned';
      return refusal('digest_not_tracked', `${target.service}'s track moved while the update ran: it resolves to ${now} now, not ${target.digest}. Nothing was changed.`);
    }
  }
  return null;
}

async function isLocal(docker: DockerPort, repo: string, digest: string): Promise<boolean> {
  try {
    const normal = normalizeImageRepository(repo);
    const images = await docker.images(normal);
    return images.some((image) => image.repoDigests.some((ref) => ref === `${normal}@${digest}` || ref === `${repo}@${digest}`));
  } catch {
    return false;
  }
}

type Verified =
  | {
      targets: Target[];
      previous: StackImageRecord[];
      plan: RewritePlanFile[];
      /** service → its image line's value before the swap, for an image-only rollback. */
      lines: Record<string, string | null>;
    }
  | { refusal: Refusal };

/**
 * Re-resolves (or, for a rollback, reads from the ledger) what to run, and plans the rewrite. Reads
 * the compose files once; the swap writes against exactly that content. Changes nothing.
 */
async function verify(ports: StackUpdatePorts, ctx: StackUpdateContext, job: StackUpdateJob, stack: DigestUpdatedStack, compose: ComposeTarget): Promise<Verified> {
  let files: { path: string; text: string }[];
  try {
    files = await Promise.all(compose.files.map(async (path) => ({ path, text: await ports.fs.readFile(path) })));
  } catch (err) {
    return { refusal: refusal('image_line_invalid', `The stack's compose files could not be read: ${message(err)}`) };
  }

  const targets: Target[] = [];
  if (job.kind === 'update') {
    const linesNow = currentImageValues(files, Object.keys(job.digests));
    for (const [service, requested] of Object.entries(job.digests)) {
      const tracked = stack.services[service];
      if (tracked === undefined) {
        return { refusal: refusal('digest_not_tracked', `${service} is not a tracked service of the stack ${job.stack}; only its tracked services are updated.`) };
      }
      let resolved: TrackResolution;
      try {
        resolved = await resolveTrack(ports.registry, tracked.image, tracked.track);
      } catch (err) {
        // Fail closed (SHP-REQ-196): no answer from the registry is never "probably fine".
        if (err instanceof RegistryError) return { refusal: refusal('registry_unreachable', `Could not resolve ${service}'s track: ${err.message}. Nothing was changed.`) };
        throw err;
      }
      if (resolved.kind === 'pinned') {
        return { refusal: refusal('digest_not_tracked', `${service} is pinned: its track never offers an update.`, 'Change its track in the stack manifest to follow a tag or a semver range.') };
      }
      if (resolved.kind === 'missing') return { refusal: refusal('digest_not_tracked', `${service}'s track resolves to nothing now: ${resolved.why}.`) };
      if (resolved.digest !== requested) {
        return {
          refusal: refusal('digest_not_tracked', `${service}'s track (${tracked.image}:${resolved.tag}) resolves to ${resolved.digest} now, not the requested ${requested}.`),
        };
      }
      // A semver track only moves forward (SHP-REQ-195): a range that now tops out below what runs
      // (a tag withdrawn, the range edited) is not an update.
      const line = linesNow[service];
      const runningTag = line === null || line === undefined ? null : tagOfReference(line);
      if (wouldGoBackwards(tracked.track, runningTag, resolved.tag)) {
        return {
          refusal: refusal(
            'digest_not_tracked',
            `${service} runs ${tracked.image}:${runningTag ?? ''}; its track resolves to ${resolved.tag}, which would go backwards. Nothing was changed.`,
            "Roll back to an earlier update instead, or widen the track's range.",
          ),
        };
      }
      targets.push({ service, repo: tracked.image, tag: resolved.tag, digest: resolved.digest, reference: stackImageReference(tracked.image, resolved.tag, resolved.digest) });
    }
  } else {
    // Only from the agent's own ledger (SHP-D-080, SHP-REQ-198): never digests from the request.
    const record = ctx.ledger.stackUpdate(job.stack, job.toUpdateId);
    if (record === null) {
      return { refusal: refusal('rollback_target_invalid', `The agent's ledger has no successful update ${job.toUpdateId} of the stack ${job.stack}.`, 'Choose an earlier update of this stack that succeeded on this host.') };
    }
    for (const image of record.images) {
      const tracked = stack.services[image.service];
      if (tracked === undefined || !sameRepository(image.repo, tracked.image)) {
        return {
          refusal: refusal('rollback_target_invalid', `Update ${job.toUpdateId} ran ${image.repo} for ${image.service}, which the stack manifest no longer tracks.`, 'Choose a later update, or restore the manifest entry first.'),
        };
      }
      targets.push({ service: image.service, repo: tracked.image, tag: image.tag, digest: image.digest, reference: stackImageReference(tracked.image, image.tag, image.digest) });
    }
  }

  let plan: RewritePlanFile[];
  try {
    plan = planRewrite(
      files,
      targets.map((x) => ({ service: x.service, repo: x.repo, reference: x.reference })),
      { sameRepository },
    );
  } catch (err) {
    if (err instanceof RefusalError) return { refusal: err.refusal };
    throw err;
  }

  // What runs now, recorded before anything changes: the result's `previous`, and what a failed
  // update is confirmed back on.
  const lines = currentImageValues(
    files,
    targets.map((x) => x.service),
  );
  const running = await stackRunningDigests(
    ports.docker,
    compose,
    Object.fromEntries(targets.map((x) => [x.service, { image: x.repo }])),
  );
  const previous: StackImageRecord[] = [];
  for (const x of targets) {
    const digest = running[x.service];
    if (digest === null || digest === undefined) continue;
    const line = lines[x.service];
    previous.push({ service: x.service, repo: x.repo, tag: line === null || line === undefined ? null : tagOfReference(line), digest });
  }
  return { targets, previous, plan, lines };
}

interface RollBackArgs {
  job: StackUpdateJob;
  stack: DigestUpdatedStack;
  compose: ComposeTarget;
  services: string[];
  targets: Target[];
  previous: StackImageRecord[];
  plan: RewritePlanFile[];
  lines: Record<string, string | null>;
  t: Timings;
  composeTimeoutMs: number;
  secrets: Map<string, string>;
  enter: (step: StackUpdateStep, name: string) => Promise<void>;
  entry: (step: string, extra?: { argv?: string[]; exitCode?: number; output?: string; detail?: Record<string, unknown> }) => {
    deployId: string;
    app: string;
    step: string;
  };
  log: Log;
  swap: SwapState;
  backupArtifact?: NonNullable<StackUpdateResult['backupArtifact']>;
}

/**
 * Puts each rewritten service's previous image line back, and nothing else (SHP-REQ-198). A file
 * still holding exactly what the swap wrote gets the content verify read back (it differs only in
 * those lines); a file edited since keeps the edit, and only the image lines are rewritten back.
 */
async function restoreImageLines(fs: FsPort, a: Pick<RollBackArgs, 'plan' | 'lines' | 'targets'>): Promise<string[]> {
  const restored: string[] = [];
  for (const file of a.plan) {
    const current = await fs.readFile(file.path);
    if (current === file.before) continue;
    if (current === file.after) {
      await fs.writeFileAtomic(file.path, file.before);
    } else {
      const mappings = file.changed.map((service) => {
        const value = a.lines[service];
        const repo = a.targets.find((x) => x.service === service)?.repo;
        if (value === null || value === undefined || repo === undefined) throw new Error(`the previous image line of ${service} is not known`);
        return { service, repo, reference: value };
      });
      const [back] = planRewrite([{ path: file.path, text: current }], mappings, { sameRepository });
      if (back !== undefined) await fs.writeFileAtomic(file.path, back.after);
    }
    restored.push(file.path);
  }
  return restored;
}

/**
 * Image-only rollback after the swap (SHP-REQ-198): each service's previous image line comes back,
 * the services are recreated from it, and the digests they ran before are confirmed running and
 * healthy again. Data is never touched; a backup taken first is kept and reported. Never throws: a
 * journal or lock write that fails here is logged, and the restore still runs — the open bracket
 * and the journaled swap are what restart recovery would act on anyway.
 */
async function rollBackImages(ports: StackUpdatePorts, ctx: StackUpdateContext, a: RollBackArgs, failure: Refusal): Promise<StackUpdateResult> {
  const { job, compose, services, previous, t } = a;
  a.log.error({ why: failure.message }, 'stack update failed after the swap; rolling back');
  const argv = stackUpArgs(services);
  try {
    await a.enter('rolling_back', 'rollback');
  } catch (err) {
    a.log.warn({ err: message(err) }, 'could not mark the rollback step on the lock; rolling back anyway');
  }
  try {
    await ctx.journal.begin(a.entry('rollback', { argv, detail: { historyId: job.updateId } }));
  } catch (err) {
    a.log.error({ err: message(err) }, 'could not journal the rollback; rolling back anyway');
  }
  const base = { updateId: job.updateId, previous: asImages(previous), ...(a.backupArtifact === undefined ? {} : { backupArtifact: a.backupArtifact }) };
  let why: string | null = null;
  let exitCode: number | undefined;
  let output = '';
  try {
    await restoreImageLines(ports.fs, a);
    a.swap.restored = true;
    const up = await ports.docker.compose(compose, argv, { timeoutMs: a.composeTimeoutMs });
    exitCode = up.exitCode;
    output = lastLines(redact(`${up.stdout}\n${up.stderr}`.trim(), a.secrets), JOURNAL_OUTPUT_LINES);
    if (up.exitCode !== 0) {
      why = `compose up exited ${String(up.exitCode)}`;
    } else {
      // Services that ran a digest before must run it again; any other is only asked to run healthy.
      const expected: Expectation[] = services.map((service) => {
        const before = previous.find((p) => p.service === service);
        return { service, repo: before?.repo ?? a.stack.services[service]?.image ?? '', digest: before?.digest ?? null };
      });
      const back = await waitHealthy(ports, compose, a.stack, expected, t);
      if (!back.ok) why = back.why;
    }
  } catch (err) {
    why = message(err);
  }
  try {
    await ctx.journal.end(
      a.entry('rollback', { argv, ...(exitCode === undefined ? {} : { exitCode }), ...(output === '' ? {} : { output }), detail: { confirmed: why === null, restored: a.swap.restored, ...(why === null ? {} : { why }) } }),
    );
  } catch (err) {
    a.log.error({ err: message(err) }, 'could not journal the end of the rollback');
  }
  if (why !== null) {
    a.log.error({ why }, 'stack rollback failed');
    return {
      ...base,
      state: 'failed',
      images: [],
      refusal: {
        ...failure,
        message: `${failure.message} Rolling back failed too: ${why}.`,
        fix: a.swap.restored
          ? 'Check the stack on the Host view; its previous image line was put back.'
          : `Check the stack on the Host view; its previous compose file could not be put back yet, and the agent puts it back when it next starts (a copy is kept under ${ctx.historyDir}/${job.updateId}).`,
      },
    };
  }
  return {
    ...base,
    state: 'rolled_back',
    images: asImages(previous),
    refusal: { ...failure, fix: 'The previous image line and digest were restored and are running; check the new image before updating again.' },
  };
}

// ─── Restart recovery ────────────────────────────────────────────────────────

export interface StackRecoveryResult {
  updateId: string;
  stack: string;
  lastStep: string | undefined;
  /** The compose files put back from the update's history copy. */
  restored: string[];
  /** True when the ledger shows the update succeeded before the agent stopped. */
  succeeded: boolean;
  error?: string;
}

/**
 * Never resumes a stack update forward (SHP-REQ-022's rule, applied to stacks): one the agent
 * stopped in the middle of has its previous compose file put back — when the swap had begun — and
 * its services recreated from it, and its bracket closed `failed`/interrupted. One the ledger shows
 * succeeded is only closed. One whose lock is still live is someone else's and left alone. A
 * `compose up` that exits non-zero (or runs past `composeTimeoutMs`) is the result's `error`.
 */
export async function recoverInterruptedStackUpdates(
  ports: { fs: FsPort; docker: DockerPort; log: Log },
  journal: Journal,
  opts: { historyDir: string; ledger?: Pick<Ledger, 'stackUpdate' | 'refresh'>; isLive?: (stack: string) => Promise<boolean>; composeTimeoutMs?: number },
): Promise<StackRecoveryResult[]> {
  const results: StackRecoveryResult[] = [];
  const composeTimeoutMs = opts.composeTimeoutMs ?? STACK_COMPOSE_TIMEOUT_MS;
  await opts.ledger?.refresh().catch(() => undefined);
  for (const u of await journal.unfinishedStackUpdates()) {
    if (opts.isLive !== undefined && (await opts.isLive(u.stack))) continue;
    const result: StackRecoveryResult = { updateId: u.updateId, stack: u.stack, lastStep: u.lastStep, restored: [], succeeded: false };
    try {
      if (opts.ledger !== undefined && opts.ledger.stackUpdate(u.stack, u.updateId) !== null) {
        result.succeeded = true;
      } else if (u.swapped && (await ports.fs.exists(`${opts.historyDir}/${u.updateId}/manifest.json`))) {
        result.restored = await restoreFromHistory(ports.fs, opts.historyDir, u.updateId);
        const files = u.detail?.['composeFiles'];
        const project = u.detail?.['project'];
        const services = u.detail?.['services'];
        if (Array.isArray(files) && files.every((f) => typeof f === 'string') && typeof project === 'string') {
          const list = Array.isArray(services) ? services.filter((s): s is string => typeof s === 'string' && !s.startsWith('-')) : [];
          const up = await ports.docker.compose({ files, project }, stackUpArgs(list), { timeoutMs: composeTimeoutMs });
          if (up.exitCode !== 0) throw new Error(`compose up exited ${String(up.exitCode)} after the previous compose file was put back`);
        }
      }
    } catch (err) {
      result.error = message(err);
      ports.log.error({ updateId: u.updateId, stack: u.stack, err: result.error }, 'stack update recovery failed');
    }
    await journal.end({
      deployId: u.updateId,
      app: u.stack,
      step: STACK_UPDATE_STEP,
      detail: { state: result.succeeded ? 'succeeded' : 'failed', interrupted: true, lastStep: u.lastStep, ...(result.error === undefined ? {} : { error: result.error }) },
    });
    results.push(result);
  }
  return results;
}
