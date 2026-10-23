import { randomUUID } from 'node:crypto';

import {
  refusal,
  type MaintenanceJob,
  type MaintenanceResult,
  type MaintenanceStep,
  type PruneItem,
  type Refusal,
  type VolumeBackupSettings,
  type VolumeOwner,
} from '@shipyard/schema';

import { MAINTENANCE_STEP, maintenanceStep, type Journal, type UnfinishedMaintenance } from './journal.js';
import type { Ledger, PrunePlanItem, VolumeArchiveRecord, VolumeOwnerRecord } from './ledger.js';
import { AppLock } from './machine.js';
import type { LoadedManifests, LoadedStacks } from './manifest.js';
import type { ArchiveFilesPort, Clock, ComposeTarget, DockerPort, ExecResult, FsPort, HostContainerRecord, Log } from './ports.js';
import { createRedactor, loadRedactionValues } from './redact.js';

/**
 * Volume backups, restores, orphan deletes and prunes (SHP-ADR-012, SHP-T-17.2; SHP-REQ-201,
 * SHP-REQ-202, SHP-REQ-203, SHP-REQ-205, SHP-REQ-206). The engine; `apps/agent` only wires it to
 * the poll loop.
 *
 * What reaches the host is a volume name, an app or stack name the host's own manifests define,
 * and a UUID this agent resolves in its own ledger — never a command and never a path
 * (non-negotiables 1, 2 and 7). Every Docker call is an argv built here from fixed verbs; the
 * helper is the agent's **own** image, run with no network and a read-only root, so nothing is
 * pulled and no manifest supplies an argv for it. No refusal message carries a host path: an
 * error is named by its code (ENOSPC, EACCES), since a refusal reaches API tokens over MCP.
 *
 * - **Backup** (SHP-REQ-201): the owner must be an app or stack this agent manages and one of its
 *   compose project's containers must mount the volume — the agent re-checks; it never trusts the
 *   server's view. With `quiesce` the project is stopped first and started again in a `finally`,
 *   whatever happened — and refused outright for the agent's own compose project, since stopping
 *   it would stop the agent before the `finally`. The helper writes `tar --zstd` of the volume
 *   (mounted read-only) to a temp name beside the archive; the agent fsyncs and renames it, hashes
 *   it itself, records it in its ledger (kind `volume-archive`, the path only there) and trims the
 *   volume's archives to the owner's `retain` (SHP-REQ-206) — a retention error never fails a
 *   good backup.
 * - **Restore** (SHP-REQ-202): only a live archive of this volume in this agent's ledger whose file
 *   still hashes to what was recorded, and never of the agent's own stack. The project is stopped;
 *   a running container that still mounts the volume (another project, a plain run) refuses it
 *   `volume_in_use`. A safety archive of what the volume holds now is taken, the volume is emptied
 *   and the archive extracted. If emptying or extracting fails, the safety archive is put back the
 *   same way; if that fails too, the project is **left stopped** so nothing writes to a
 *   half-restored volume. Otherwise the project is started again.
 * - **Delete** (SHP-REQ-203): refused `volume_in_use` while any container — running or stopped —
 *   mounts the volume; otherwise `docker volume rm` without `-f`.
 * - **Prune** (SHP-REQ-205): a dry run lists dangling images, unused images older than the
 *   threshold and unused build cache older than the threshold — never volumes, networks or
 *   containers — and records that list in the ledger (kind `prune-plan`). A real prune loads the
 *   plan it names from this ledger (`dry_run_required` otherwise), re-checks each item now, removes
 *   only what is still eligible, without `-f`, and reports as reclaimed only what is measurably
 *   gone afterwards.
 *
 * Every job is journaled before it acts (SHP-D-029): a `maintenance` bracket and one
 * `maintenance:<kind>:<step>` pair per step. After a restart, `recoverInterruptedMaintenance`
 * removes temp archives and helper containers left behind, adopts an archive that was committed
 * but never recorded, puts a half-restored volume back from its safety archive, and starts again a
 * project a job had stopped — a stack is never left stopped because the agent restarted, unless
 * its volume could not be put back. Backup and restore output is never stored or reported
 * (non-negotiable 10): the result's `output` is the agent's own account of what it did, redacted.
 */

export interface MaintenancePorts {
  docker: DockerPort;
  fs: FsPort;
  files: ArchiveFilesPort;
  clock: Clock;
  log: Log;
}

/** A lock held for a job's duration. */
export interface MaintenanceLock {
  release(): Promise<void>;
}

export interface MaintenanceContext {
  dataRoot: string;
  /** `<backup root>`; archives go to `<backup root>/volumes/<volume>/<timestamp>.tar.zst`. Absolute. */
  backupRoot: string;
  apps: LoadedManifests;
  stacks: LoadedStacks;
  journal: Pick<Journal, 'begin' | 'end'>;
  ledger: Pick<Ledger, 'refresh' | 'append' | 'volumeArchives' | 'volumeArchive' | 'prunePlan'>;
  /** The agent's own image ID (`sha256:…`), the only image the helper runs. Throws when unknown. */
  helperImage: () => Promise<string>;
  /**
   * The compose project of the agent's own container, or null when it runs in none. A restore, or
   * a quiesced backup, of that project is refused: stopping it would stop the agent itself.
   * Absent: no project is the agent's own (it runs outside a container).
   */
  ownProject?: () => Promise<string | null>;
  /** Takes the owner's deploy lock. Default: `AppLock.acquire` under the data root. */
  lockOwner?: (owner: VolumeOwner, jobId: string) => Promise<MaintenanceLock | Refusal>;
  /** True while a deploy, stack update or action runs on this host: a real prune is refused `locked`. */
  busy?: () => boolean | Promise<boolean>;
  onStep?: (step: MaintenanceStep) => void;
  /** `compose stop` / `compose start`. Default 3 min. */
  composeTimeoutMs?: number;
  /** One helper run (an archive, an empty, an extract). Default 6 h. */
  helperTimeoutMs?: number;
  /** One `image rm`, cache record prune or `volume rm`. Default 2 min. */
  removeTimeoutMs?: number;
}

export const MAINTENANCE_COMPOSE_TIMEOUT_MS = 180_000;
export const MAINTENANCE_HELPER_TIMEOUT_MS = 6 * 60 * 60_000;
export const MAINTENANCE_REMOVE_TIMEOUT_MS = 120_000;
/** Archives kept per volume when the owner's manifest does not say (SHP-REQ-206). */
export const DEFAULT_RETAIN = 7;
/** `MaintenanceResult.output` is capped at 64 KiB; the end of the account is what explains a failure. */
export const MAX_MAINTENANCE_OUTPUT = 65_536;
/** At most this many items in one prune list (the schema's cap). */
export const MAX_PRUNE_ITEMS = 5_000;
/** Every helper container is named with this prefix and the job, so recovery can remove one left running. */
export const MAINTENANCE_HELPER_PREFIX = 'shipyard-maintenance-';

const VOLUME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;
const CACHE_ID_RE = /^[a-z0-9]{1,64}$/;
const TIMEOUT_EXIT_CODE = 124;
const ARCHIVE_SUFFIX = '.tar.zst';
/** Container states that still hold a volume after the owner's project is stopped. */
const HOLDING_STATES: ReadonlySet<string> = new Set(['running', 'restarting', 'paused']);
const TMP_SUFFIX = '.tmp';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Replaces every absolute path in `text` with `…`. */
export function stripPaths(text: string): string {
  return text.replace(/(^|[\s'"`(=:,[])\/[^\s'"`),\]]*/g, '$1…');
}

/**
 * An error as a refusal or the output may carry it: its errno code (ENOSPC, EACCES) when it has
 * one, otherwise its message with every path taken out. Never a host path (SHP-T-17.2).
 */
export function safeError(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
  if (code !== undefined && /^E[A-Z0-9_]+$/.test(code)) return code;
  return stripPaths(message(err));
}

/** A name that Docker would read as a flag must never reach it (non-negotiable 1). */
function flagLike(value: string): boolean {
  return value.startsWith('-');
}

/** A path that cannot be bind-mounted safely with `-v src:dst`. */
function unsafeMountPath(path: string): boolean {
  return !path.startsWith('/') || /[:,\n]/.test(path);
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

function dirOf(path: string): string {
  return path.slice(0, Math.max(1, path.lastIndexOf('/')));
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** `YYYYMMDDTHHMMSSZ` in UTC: the archive's file name (SHP-REQ-201). */
export function archiveTimestamp(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

/** `<backup root>/volumes/<volume>`. */
export function volumeArchiveDir(backupRoot: string, volume: string): string {
  return `${backupRoot.replace(/\/+$/, '')}/volumes/${volume}`;
}

/** The helper container's name for one run of a job. */
export function helperName(jobId: string, purpose: string): string {
  return `${MAINTENANCE_HELPER_PREFIX}${jobId}-${purpose}`;
}

/** The fixed part of every helper run: no network, a read-only root, removed on exit. */
function helperRun(name: string): string[] {
  return ['run', '--rm', '--name', name, '--network', 'none', '--read-only'];
}

/**
 * `docker run … --entrypoint tar -v <volume>:/volume:ro -v <dir>:/out <image> --zstd … -cpf /out/<tmp> -C /volume .`
 * — the volume read-only, only the archive's own directory writable (SHP-REQ-201).
 */
export function backupHelperArgv(o: { name: string; imageId: string; volume: string; dir: string; tmpName: string }): string[] {
  return [
    ...helperRun(o.name),
    '--entrypoint',
    'tar',
    '-v',
    `${o.volume}:/volume:ro`,
    '-v',
    `${o.dir}:/out`,
    o.imageId,
    '--zstd',
    '--numeric-owner',
    '-cpf',
    `/out/${o.tmpName}`,
    '-C',
    '/volume',
    '.',
  ];
}

/** `docker run … --entrypoint find -v <volume>:/volume <image> /volume -mindepth 1 -delete`: empties the volume before a restore. */
export function wipeHelperArgv(o: { name: string; imageId: string; volume: string }): string[] {
  return [...helperRun(o.name), '--entrypoint', 'find', '-v', `${o.volume}:/volume`, o.imageId, '/volume', '-mindepth', '1', '-delete'];
}

/** `docker run … --entrypoint tar -v <volume>:/volume -v <dir>:/in:ro <image> --zstd … -xpf /in/<file> -C /volume` (SHP-REQ-202). */
export function extractHelperArgv(o: { name: string; imageId: string; volume: string; dir: string; file: string }): string[] {
  return [
    ...helperRun(o.name),
    '--entrypoint',
    'tar',
    '-v',
    `${o.volume}:/volume`,
    '-v',
    `${o.dir}:/in:ro`,
    o.imageId,
    '--zstd',
    '--numeric-owner',
    '-xpf',
    `/in/${o.file}`,
    '-C',
    '/volume',
  ];
}

// ─── Owner and volume checks ─────────────────────────────────────────────────

interface ResolvedOwner {
  owner: VolumeOwner;
  compose: ComposeTarget;
  settings: VolumeBackupSettings | undefined;
  envFiles: string[] | undefined;
}

/** The app or stack from the host's own manifests only (SHP-D-059); anything else is not ours. */
function resolveOwner(ctx: MaintenanceContext, owner: VolumeOwner): ResolvedOwner | Refusal {
  const found = owner.kind === 'app' ? ctx.apps.get(owner.name)?.manifest : ctx.stacks.get(owner.name)?.manifest;
  if (found === undefined) {
    return refusal(
      'volume_not_owned',
      `No ${owner.kind === 'app' ? 'app manifest' : 'adopted stack'} named ${owner.name} on this host; the agent backs up and restores only volumes of apps and stacks it manages.`,
    );
  }
  if (flagLike(found.compose.project) || found.compose.files.some(flagLike)) {
    return refusal('invalid_request', `The ${owner.kind} ${owner.name} names a compose project or file beginning with "-"; Shipyard will not pass it to compose.`);
  }
  return { owner, compose: { files: found.compose.files, project: found.compose.project }, settings: found.volumeBackups, envFiles: found.envFiles };
}

function checkVolumeName(volume: string): Refusal | null {
  return VOLUME_RE.test(volume) ? null : refusal('invalid_request', 'That is not a Docker volume name.');
}

function mounts(c: HostContainerRecord, volume: string): boolean {
  return c.mounts.some((m) => m.type === 'volume' && m.volume === volume);
}

/** Every container, running or stopped (`all=1`), from the Engine. */
async function allContainers(docker: DockerPort): Promise<HostContainerRecord[] | Refusal> {
  if (docker.hostContainers === undefined) return refusal('step_failed', "This agent's Docker adapter cannot list containers; nothing was done.");
  return docker.hostContainers();
}

/** The agent re-checks that the owner's compose project mounts the volume (SHP-REQ-201). */
async function checkOwnerMounts(docker: DockerPort, resolved: ResolvedOwner, volume: string): Promise<Refusal | null> {
  const list = await allContainers(docker);
  if ('code' in list) return list;
  const owners = list.filter((c) => c.compose?.project === resolved.compose.project && mounts(c, volume));
  if (owners.length > 0) return null;
  return refusal('volume_not_owned', `No container of the ${resolved.owner.kind} ${resolved.owner.name} (compose project ${resolved.compose.project}) mounts the volume ${volume}.`);
}

/**
 * Refuses a job that would `compose stop` the agent's own stack: the agent would stop itself and
 * its `finally` would never start the stack again. A backup without quiesce stays allowed.
 */
async function refuseOwnStack(ctx: MaintenanceContext, resolved: ResolvedOwner, what: string): Promise<Refusal | null> {
  if (ctx.ownProject === undefined) return null;
  let own: string | null;
  try {
    own = await ctx.ownProject();
  } catch (err) {
    return refusal('step_failed', `The agent could not tell whether ${resolved.owner.name} is its own stack (${safeError(err)}), so it stopped nothing.`);
  }
  if (own === null || own !== resolved.compose.project) return null;
  return refusal(
    'locked',
    `${resolved.owner.name} runs in compose project ${own}, the stack Shipyard's own agent runs in. Shipyard cannot stop its own stack, so it will not ${what}.`,
    'Back the volume up without quiesce, or restore it by hand on the host with the stack stopped.',
  );
}

// ─── The job's own account, journal and steps ───────────────────────────────

interface JobEnv {
  ports: MaintenancePorts;
  journal: Pick<Journal, 'begin' | 'end'>;
  jobId: string;
  kind: string;
  /** The journal's `app` for this job: the owner, the volume or `prune`. */
  name: string;
  say: (line: string) => void;
  onStep?: ((step: MaintenanceStep) => void) | undefined;
  composeTimeoutMs: number;
  helperTimeoutMs: number;
}

function jobEnv(ports: MaintenancePorts, ctx: MaintenanceContext, o: { jobId: string; kind: string; name: string; say: (line: string) => void }): JobEnv {
  return {
    ports,
    journal: ctx.journal,
    ...o,
    onStep: ctx.onStep,
    composeTimeoutMs: ctx.composeTimeoutMs ?? MAINTENANCE_COMPOSE_TIMEOUT_MS,
    helperTimeoutMs: ctx.helperTimeoutMs ?? MAINTENANCE_HELPER_TIMEOUT_MS,
  };
}

function line(env: JobEnv, step: string, extra: { argv?: string[]; exitCode?: number; detail?: Record<string, unknown> } = {}) {
  return { deployId: env.jobId, app: env.name, step: maintenanceStep(env.kind, step), ...extra };
}

function step(env: JobEnv, s: MaintenanceStep): void {
  try {
    env.onStep?.(s);
  } catch (err) {
    env.ports.log.warn({ jobId: env.jobId, err: message(err) }, 'onStep threw; ignoring');
  }
}

function cli(docker: DockerPort): NonNullable<DockerPort['dockerCli']> {
  const run = docker.dockerCli?.bind(docker);
  if (run === undefined) throw new Error("this agent's Docker adapter cannot run the docker CLI");
  return run;
}

/** `compose stop|start` of the owner's project, journaled; never throws past the journal's begin. */
async function composeStep(env: JobEnv, which: 'stop' | 'start', compose: ComposeTarget, detail: Record<string, unknown> = {}): Promise<ExecResult> {
  const argv = [which];
  await env.journal.begin(line(env, which, { argv, detail: { project: compose.project, ...detail } }));
  let res: ExecResult;
  try {
    res = await env.ports.docker.compose(compose, argv, { timeoutMs: env.composeTimeoutMs });
  } catch (err) {
    res = { exitCode: 1, stdout: '', stderr: safeError(err) };
  }
  await env.journal.end(line(env, which, { argv, exitCode: res.exitCode, detail: { project: compose.project, ...detail } })).catch((err: unknown) => {
    env.ports.log.error({ jobId: env.jobId, err: message(err) }, `could not journal the end of compose ${which}`);
  });
  env.say(`compose ${which} of ${compose.project}: exit ${String(res.exitCode)}.`);
  return res;
}

/** Runs one helper container, journaled. On a timeout the container is removed by name. */
async function runHelper(env: JobEnv, stepName: string, argv: string[], detail: Record<string, unknown>, beforeRun?: () => void): Promise<ExecResult> {
  const name = argv[argv.indexOf('--name') + 1] ?? '';
  await env.journal.begin(line(env, stepName, { argv: ['docker', ...argv], detail: { ...detail, helper: name } }));
  // Journaled; from here on the helper may change what it touches.
  beforeRun?.();
  let res: ExecResult;
  try {
    res = await cli(env.ports.docker)(argv, { timeoutMs: env.helperTimeoutMs });
  } catch (err) {
    res = { exitCode: 1, stdout: '', stderr: safeError(err) };
  }
  if (res.exitCode === TIMEOUT_EXIT_CODE && name !== '') {
    // The CLI was killed; the container may still be running. It is never left behind.
    await cli(env.ports.docker)(['rm', '--force', name], { timeoutMs: 60_000 }).catch(() => undefined);
  }
  // Never the helper's output (non-negotiable 10): only that it ran and how it exited.
  await env.journal.end(line(env, stepName, { argv: ['docker', ...argv], exitCode: res.exitCode, detail: { ...detail, helper: name } }));
  return res;
}

// ─── Archives ────────────────────────────────────────────────────────────────

/**
 * Takes one archive of `volume` with the helper and records it in the ledger (SHP-REQ-201). The
 * owner's containers are stopped or not by the caller. Never throws a failure of the archive itself:
 * it returns the refusal, having removed whatever file it made.
 */
async function takeArchive(
  env: JobEnv,
  ctx: MaintenanceContext,
  args: { volume: string; owner: VolumeOwner | null; quiesced: boolean; imageId: string },
): Promise<{ record: VolumeArchiveRecord } | { refusal: Refusal }> {
  const { files, fs, clock } = env.ports;
  const { volume } = args;
  const root = ctx.backupRoot.replace(/\/+$/, '');
  const dir = volumeArchiveDir(root, volume);
  if (unsafeMountPath(dir)) {
    return { refusal: refusal('backup_failed', `The backup root cannot be bind-mounted (it must be absolute, with no ":" or ","); ${volume} was not archived.`) };
  }
  const archiveId = randomUUID();
  const createdAt = clock.now();
  const stamp = archiveTimestamp(createdAt);
  let finalPath = `${dir}/${stamp}${ARCHIVE_SUFFIX}`;
  try {
    // Only the directories made here are 0700; the backup root itself is the operator's.
    await files.ensureDir(dir);
    if (await fs.exists(finalPath)) finalPath = `${dir}/${stamp}-${archiveId.slice(0, 8)}${ARCHIVE_SUFFIX}`;
  } catch (err) {
    return { refusal: refusal('backup_failed', `The archive directory for ${volume} could not be made (${safeError(err)}); nothing was archived.`) };
  }
  const tmpName = `.${stamp}-${archiveId}${ARCHIVE_SUFFIX}${TMP_SUFFIX}`;
  const tmp = `${dir}/${tmpName}`;
  const helper = helperName(env.jobId, `archive-${archiveId.slice(0, 8)}`);
  const argv = backupHelperArgv({ name: helper, imageId: args.imageId, volume, dir, tmpName });
  const detail = { volume, tmp, final: finalPath, archiveId, helper };

  // Journaled before the temp file exists (SHP-D-029); recovery removes one a crash leaves.
  try {
    await env.journal.begin(line(env, 'archive', { argv: ['docker', ...argv], detail }));
  } catch (err) {
    return { refusal: refusal('backup_failed', `The archive of ${volume} could not be journaled (${safeError(err)}), so it was not taken.`) };
  }
  let res: ExecResult;
  let createFailed: string | null = null;
  try {
    // Created by the agent, 0600, before the helper writes into it: the archive is never readable
    // by anyone else, even while it is being written.
    await files.createEmpty(tmp);
  } catch (err) {
    createFailed = safeError(err);
  }
  if (createFailed !== null) {
    res = { exitCode: 1, stdout: '', stderr: createFailed };
  } else {
    try {
      res = await cli(env.ports.docker)(argv, { timeoutMs: env.helperTimeoutMs });
    } catch (err) {
      res = { exitCode: 1, stdout: '', stderr: safeError(err) };
    }
    if (res.exitCode === TIMEOUT_EXIT_CODE) await cli(env.ports.docker)(['rm', '--force', helper], { timeoutMs: 60_000 }).catch(() => undefined);
  }
  // Never the helper's output (non-negotiable 10).
  await env.journal.end(line(env, 'archive', { argv: ['docker', ...argv], exitCode: res.exitCode, detail })).catch((err: unknown) => {
    env.ports.log.error({ jobId: env.jobId, err: message(err) }, 'could not journal the end of the archive');
  });
  if (res.exitCode !== 0) {
    await files.remove(tmp).catch(() => undefined);
    const why = createFailed === null ? `tar exited ${String(res.exitCode)}` : `the archive file could not be created: ${createFailed}`;
    env.say(`Archiving ${volume} failed (${why}); the partial file was removed.`);
    return { refusal: refusal('backup_failed', `Archiving the volume ${volume} failed (${why}); nothing was recorded.`) };
  }
  try {
    await files.commit(tmp, finalPath);
    const digest = await files.digest(finalPath);
    if (digest === null) throw new Error('the committed archive is missing');
    const record: VolumeArchiveRecord = {
      kind: 'volume-archive',
      archiveId,
      volume,
      owner: args.owner,
      createdAt: createdAt.toISOString(),
      sizeBytes: digest.sizeBytes,
      sha256: digest.sha256,
      quiesced: args.quiesced,
      file: finalPath,
    };
    // Recorded the moment it exists, whatever the job does next (as a deploy's backup is, SHP-REQ-085).
    await ctx.ledger.append(record);
    env.say(`Archived ${volume} as ${archiveId} (${String(digest.sizeBytes)} bytes, sha256 ${digest.sha256}${args.quiesced ? ', containers stopped' : ''}).`);
    return { record };
  } catch (err) {
    // Nothing unrecorded is left behind: a finished job never leaves an archive the ledger lacks.
    await files.remove(tmp).catch(() => undefined);
    await files.remove(finalPath).catch(() => undefined);
    return { refusal: refusal('backup_failed', `The archive of ${volume} could not be kept (${safeError(err)}); nothing was recorded.`) };
  }
}

/**
 * Keeps the newest `keep` live archives of `volume` and removes the rest, oldest first, recording
 * each removal (SHP-REQ-206). A file outside the volume's archive directory is never unlinked. An
 * error stops the trimming and is said in the output; it never fails the backup that ran it.
 */
async function applyRetention(env: JobEnv, ctx: MaintenanceContext, volume: string, keep: number): Promise<string[]> {
  step(env, 'retaining');
  const removed: string[] = [];
  try {
    await ctx.ledger.refresh();
    const live = [...ctx.ledger.volumeArchives(volume)].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const excess = live.slice(0, Math.max(0, live.length - Math.max(1, keep)));
    const dir = `${volumeArchiveDir(ctx.backupRoot, volume)}/`;
    for (const archive of excess) {
      await env.journal.begin(line(env, 'retain', { detail: { archiveId: archive.archiveId } }));
      if (archive.file.startsWith(dir) && !archive.file.includes('/../')) await env.ports.files.remove(archive.file);
      else env.ports.log.warn({ archiveId: archive.archiveId }, 'archive file is outside the backup root; not removing the file');
      await ctx.ledger.append({ kind: 'volume-archive-removed', archiveId: archive.archiveId, at: env.ports.clock.now().toISOString() });
      await env.journal.end(line(env, 'retain', { detail: { archiveId: archive.archiveId } }));
      removed.push(archive.archiveId);
    }
  } catch (err) {
    env.ports.log.warn({ jobId: env.jobId, err: message(err) }, 'retention failed; the backup stands');
    env.say(`Retention could not finish (${safeError(err)}); older archives of ${volume} were kept. The backup itself succeeded.`);
  }
  if (removed.length > 0) env.say(`Retention (${String(keep)} per volume) removed ${String(removed.length)} older archive(s) of ${volume}.`);
  return removed;
}

interface BackupOutcome {
  record?: VolumeArchiveRecord;
  refusal?: Refusal;
  /** The project was stopped and did not start again. */
  startFailed?: boolean;
}

/** Stop (if quiescing) → archive → start again in a `finally`, even when the archive failed. */
async function backupQuiesced(env: JobEnv, ctx: MaintenanceContext, args: { volume: string; resolved: ResolvedOwner; quiesce: boolean; imageId: string }): Promise<BackupOutcome> {
  const { volume, resolved, quiesce, imageId } = args;
  const outcome: BackupOutcome = {};
  let stopped = false;
  try {
    if (quiesce) {
      step(env, 'stopping');
      // Marked before compose runs: a stop that fails half-way still leaves something to start.
      stopped = true;
      const stop = await composeStep(env, 'stop', resolved.compose);
      if (stop.exitCode !== 0) {
        outcome.refusal = refusal('backup_failed', `compose stop of ${resolved.compose.project} exited ${String(stop.exitCode)}; nothing was archived.`);
        return outcome;
      }
    }
    step(env, 'archiving');
    const taken = await takeArchive(env, ctx, { volume, owner: resolved.owner, quiesced: quiesce, imageId });
    if ('refusal' in taken) outcome.refusal = taken.refusal;
    else outcome.record = taken.record;
    return outcome;
  } finally {
    if (stopped) {
      step(env, 'starting');
      const start = await composeStep(env, 'start', resolved.compose).catch((err: unknown): ExecResult => ({ exitCode: 1, stdout: '', stderr: safeError(err) }));
      if (start.exitCode !== 0) outcome.startFailed = true;
    }
  }
}

// ─── The jobs ────────────────────────────────────────────────────────────────

type VolumeBackupJob = Extract<MaintenanceJob, { kind: 'volume-backup' }>;
type VolumeRestoreJob = Extract<MaintenanceJob, { kind: 'volume-restore' }>;
type VolumeDeleteJob = Extract<MaintenanceJob, { kind: 'volume-delete' }>;
type PruneJob = Extract<MaintenanceJob, { kind: 'prune' }>;

class Refused extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message);
  }
}

async function helperImageOrRefuse(helperImage: () => Promise<string>): Promise<string> {
  let id: string;
  try {
    id = await helperImage();
  } catch (err) {
    throw new Refused(
      refusal(
        'step_failed',
        `The agent could not find its own image to run the archive helper (${safeError(err)}).`,
        'Run the agent in its container, as docs/install describes; it never pulls another image for this.',
      ),
    );
  }
  if (!IMAGE_ID_RE.test(id)) throw new Refused(refusal('step_failed', "The agent's own image ID is not a sha256 image ID."));
  return id;
}

async function takeLock(ctx: MaintenanceContext, owner: VolumeOwner, jobId: string): Promise<MaintenanceLock> {
  const held =
    ctx.lockOwner !== undefined
      ? await ctx.lockOwner(owner, jobId)
      : await AppLock.acquire(ctx.dataRoot, owner.name, { pid: process.pid, deployId: jobId, requesterLabel: 'shipyard maintenance', sha: '', step: 'maintenance', at: new Date().toISOString() });
  if ('code' in held) throw new Refused(held);
  return held;
}

/** The bracket first: if it cannot be written, nothing runs (SHP-D-029). */
async function openBracket(env: JobEnv, detail: Record<string, unknown>): Promise<void> {
  try {
    await env.journal.begin({ deployId: env.jobId, app: env.name, step: MAINTENANCE_STEP, detail: { kind: env.kind, ...detail } });
  } catch (err) {
    throw new Refused(refusal('step_failed', `The ${env.kind} could not be journaled (${safeError(err)}), so it was not run.`));
  }
}

async function closeBracket(env: JobEnv, result: MaintenanceResult, extra: Record<string, unknown> = {}): Promise<void> {
  await env.journal
    .end({
      deployId: env.jobId,
      app: env.name,
      step: MAINTENANCE_STEP,
      detail: { kind: env.kind, state: result.state, ...(result.refusal === undefined ? {} : { code: result.refusal.code }), ...extra },
    })
    .catch((err: unknown) => {
      env.ports.log.error({ jobId: env.jobId, err: message(err) }, 'could not close the maintenance job in the journal');
    });
}

function composeDetail(resolved: ResolvedOwner): Record<string, unknown> {
  return { owner: resolved.owner, composeFiles: resolved.compose.files, project: resolved.compose.project };
}

async function runBackupJob(env: JobEnv, ctx: MaintenanceContext, job: VolumeBackupJob): Promise<MaintenanceResult> {
  step(env, 'checking');
  const resolved = resolveOwner(ctx, job.owner);
  if ('code' in resolved) throw new Refused(resolved);
  const notMounted = await checkOwnerMounts(env.ports.docker, resolved, job.volume);
  if (notMounted !== null) throw new Refused(notMounted);
  if (job.quiesce) {
    const own = await refuseOwnStack(ctx, resolved, 'stop it for a backup');
    if (own !== null) throw new Refused(own);
  }
  const imageId = await helperImageOrRefuse(ctx.helperImage);
  const lock = await takeLock(ctx, job.owner, job.jobId);
  try {
    await openBracket(env, { volume: job.volume, quiesce: job.quiesce, ...composeDetail(resolved) });
    let result: MaintenanceResult;
    try {
      const outcome = await backupQuiesced(env, ctx, { volume: job.volume, resolved, quiesce: job.quiesce, imageId });
      result = await backupResult(env, ctx, job.volume, resolved, outcome);
    } catch (err) {
      result = { jobId: job.jobId, state: 'failed', refusal: refusal('backup_failed', `The backup of ${job.volume} stopped (${safeError(err)}).`) };
    }
    await closeBracket(env, result);
    return result;
  } finally {
    await lock.release().catch(() => undefined);
  }
}

async function backupResult(env: JobEnv, ctx: MaintenanceContext, volume: string, resolved: ResolvedOwner, outcome: BackupOutcome): Promise<MaintenanceResult> {
  const { jobId } = env;
  if (outcome.record === undefined) {
    const why = outcome.refusal ?? refusal('backup_failed', `The backup of ${volume} failed.`);
    return { jobId, state: 'failed', refusal: outcome.startFailed === true ? withStartFailure(why, resolved) : why };
  }
  const removedArchives = await applyRetention(env, ctx, volume, resolved.settings?.retain ?? DEFAULT_RETAIN);
  const archive = toVolumeArchive(outcome.record);
  if (outcome.startFailed === true) {
    return {
      jobId,
      state: 'failed',
      archive,
      removedArchives,
      refusal: refusal(
        'step_failed',
        `The archive was taken, but compose start of ${resolved.compose.project} failed afterwards; its containers may still be stopped.`,
        `Start ${resolved.owner.name} from its page, then check its containers.`,
      ),
    };
  }
  return { jobId, state: 'succeeded', archive, removedArchives };
}

function withStartFailure(why: Refusal, resolved: ResolvedOwner): Refusal {
  return { ...why, message: `${why.message} compose start of ${resolved.compose.project} failed afterwards too; its containers may still be stopped.` };
}

/** What leaves the agent: everything but the file path (SHP-D-080). */
export function toVolumeArchive(record: VolumeArchiveRecord): NonNullable<MaintenanceResult['archive']> {
  return {
    archiveId: record.archiveId,
    volume: record.volume,
    owner: record.owner === null ? null : { kind: record.owner.kind, name: record.owner.name },
    createdAt: record.createdAt,
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
    quiesced: record.quiesced,
  };
}

/** Empties `volume` and extracts `archive` into it: the two helper runs of a restore. True when both exited 0. */
async function emptyAndExtract(
  env: JobEnv,
  o: { volume: string; archive: VolumeArchiveRecord; imageId: string; prefix: '' | 'safety-'; purpose: string; onWipe?: () => void },
): Promise<{ ok: boolean; failed?: string }> {
  const { volume, archive, imageId } = o;
  const wipe = await runHelper(env, `${o.prefix}empty`, wipeHelperArgv({ name: helperName(env.jobId, `${o.purpose}empty`), imageId, volume }), { volume }, o.onWipe);
  if (wipe.exitCode !== 0) return { ok: false, failed: `emptying the volume exited ${String(wipe.exitCode)}` };
  const extract = await runHelper(
    env,
    `${o.prefix}extract`,
    extractHelperArgv({ name: helperName(env.jobId, `${o.purpose}extract`), imageId, volume, dir: dirOf(archive.file), file: baseOf(archive.file) }),
    { volume, archiveId: archive.archiveId },
  );
  if (extract.exitCode !== 0) return { ok: false, failed: `extracting archive ${archive.archiveId} exited ${String(extract.exitCode)}` };
  return { ok: true };
}

/** The archive's file still hashes to what the ledger recorded. */
async function archiveIntact(files: ArchiveFilesPort, archive: VolumeArchiveRecord): Promise<boolean> {
  if (unsafeMountPath(dirOf(archive.file))) return false;
  const found = await files.digest(archive.file).catch(() => null);
  return found !== null && found.sha256 === archive.sha256 && found.sizeBytes === archive.sizeBytes;
}

async function runRestoreJob(env: JobEnv, ctx: MaintenanceContext, job: VolumeRestoreJob): Promise<MaintenanceResult> {
  const { ports } = env;
  step(env, 'checking');
  const resolved = resolveOwner(ctx, job.owner);
  if ('code' in resolved) throw new Refused(resolved);
  const notMounted = await checkOwnerMounts(ports.docker, resolved, job.volume);
  if (notMounted !== null) throw new Refused(notMounted);

  // Only from this agent's own ledger, and only a live archive of this volume (SHP-REQ-202, SHP-D-080).
  await ctx.ledger.refresh();
  const archive = ctx.ledger.volumeArchive(job.archiveId);
  if (archive === null || archive.volume !== job.volume) {
    throw new Refused(refusal('archive_not_found', `There is no archive ${job.archiveId} of the volume ${job.volume} in this agent's ledger.`));
  }
  if (unsafeMountPath(dirOf(archive.file))) {
    throw new Refused(refusal('archive_not_found', `The archive ${job.archiveId} is recorded at a location that cannot be mounted.`));
  }
  const found = await ports.files.digest(archive.file);
  if (found === null) throw new Refused(refusal('archive_not_found', `The file of archive ${job.archiveId} is no longer on the host.`));
  if (found.sha256 !== archive.sha256 || found.sizeBytes !== archive.sizeBytes) {
    throw new Refused(refusal('archive_not_found', `The file of archive ${job.archiveId} has changed since it was taken (its sha256 no longer matches the ledger); it will not be restored.`));
  }
  const own = await refuseOwnStack(ctx, resolved, 'restore a volume of it');
  if (own !== null) throw new Refused(own);
  const imageId = await helperImageOrRefuse(ctx.helperImage);
  const lock = await takeLock(ctx, job.owner, job.jobId);
  try {
    await openBracket(env, { volume: job.volume, archiveId: job.archiveId, ...composeDetail(resolved) });
    let result: MaintenanceResult;
    try {
      result = await restoreLocked(env, ctx, job, resolved, archive, imageId);
    } catch (err) {
      result = { jobId: job.jobId, state: 'failed', refusal: refusal('step_failed', `The restore of ${job.volume} stopped (${safeError(err)}).`) };
    }
    await closeBracket(env, result);
    return result;
  } finally {
    await lock.release().catch(() => undefined);
  }
}

/** A restore that left its volume half-restored and could not put it back: the stack stays stopped. */
function leftStoppedResult(jobId: string, volume: string, resolved: ResolvedOwner, safetyId: string | null, why: string): MaintenanceResult {
  const safety = safetyId === null ? 'its safety archive' : `safety archive ${safetyId}`;
  return {
    jobId,
    state: 'failed',
    refusal: refusal(
      'step_failed',
      `Restoring ${volume} failed (${why}). The stack ${resolved.owner.name} was left stopped so nothing writes to a half-restored volume; what the volume held before is in ${safety}.`,
      `Restore ${safety} (what the volume held before) by hand, then start ${resolved.owner.name}.`,
    ),
  };
}

async function restoreLocked(env: JobEnv, ctx: MaintenanceContext, job: VolumeRestoreJob, resolved: ResolvedOwner, archive: VolumeArchiveRecord, imageId: string): Promise<MaintenanceResult> {
  const { jobId, volume } = job;
  let result: MaintenanceResult | undefined;
  // Set only when the volume may be half-restored and could not be put back: nothing must write to it.
  let leaveStopped = false;
  // True from the moment the restore begins emptying the volume until an extract has finished.
  // An object, so a write from the wipe's callback is seen by the checks below.
  const volumeState = { dirty: false };
  let safetyId: string | null = null;
  try {
    step(env, 'stopping');
    const stop = await composeStep(env, 'stop', resolved.compose);
    if (stop.exitCode !== 0) {
      result = { jobId, state: 'failed', refusal: refusal('step_failed', `compose stop of ${resolved.compose.project} exited ${String(stop.exitCode)}; the volume was not touched.`) };
      return result;
    }

    // With the owner stopped, nothing else may still be using the volume (SHP-REQ-202).
    const list = await allContainers(env.ports.docker);
    if ('code' in list) {
      result = { jobId, state: 'failed', refusal: list };
      return result;
    }
    // Running, restarting or paused all hold the volume; only a stopped container does not.
    const users = list.filter((c) => HOLDING_STATES.has(c.state) && mounts(c, volume));
    if (users.length > 0) {
      result = {
        jobId,
        state: 'refused',
        refusal: refusal(
          'volume_in_use',
          `The volume ${volume} is still mounted by ${users.map((c) => `${c.name} (${c.state})`).join(', ')}; it was not restored.`,
          'Stop the other containers that mount it, then restore again.',
        ),
      };
      return result;
    }

    // What the volume holds now, so a wrong restore can be undone (SHP-REQ-202).
    step(env, 'archiving');
    const safety = await takeArchive(env, ctx, { volume, owner: resolved.owner, quiesced: true, imageId });
    if ('refusal' in safety) {
      result = { jobId, state: 'failed', refusal: { ...safety.refusal, message: `The safety backup failed, so the volume was not touched: ${safety.refusal.message}` } };
      return result;
    }
    safetyId = safety.record.archiveId;
    env.say(`Safety archive of what ${volume} held before the restore: ${safetyId}.`);

    step(env, 'restoring');
    // From the moment the wipe begins the volume may be half-restored: anything but a successful
    // extract — a returned failure or a throw (a journal append on a full disk) — goes through the
    // safety put-back, and nothing starts the stack unless that left the volume whole.
    let failedWhy: string;
    try {
      const restored = await emptyAndExtract(env, {
        volume,
        archive,
        imageId,
        prefix: '',
        purpose: '',
        onWipe: () => {
          volumeState.dirty = true;
        },
      });
      if (restored.ok) {
        volumeState.dirty = false;
        env.say(`Restored ${volume} from archive ${archive.archiveId} (taken ${archive.createdAt}).`);
        result = { jobId, state: 'succeeded' };
        return result;
      }
      failedWhy = restored.failed ?? 'unknown';
    } catch (err) {
      failedWhy = safeError(err);
    }
    if (!volumeState.dirty) {
      // The wipe was never run (its journal line could not be written): the volume is as it was.
      result = { jobId, state: 'failed', refusal: refusal('step_failed', `The restore of ${volume} could not begin (${failedWhy}); the volume was not touched.`) };
      return result;
    }

    // Put back what was there before, the same way.
    env.say(`The restore failed (${failedWhy}); putting back safety archive ${safetyId}.`);
    let back: { ok: boolean; failed?: string };
    try {
      back = await emptyAndExtract(env, { volume, archive: safety.record, imageId, prefix: 'safety-', purpose: 'safety-' });
    } catch (err) {
      back = { ok: false, failed: safeError(err) };
    }
    if (back.ok) {
      volumeState.dirty = false;
      result = {
        jobId,
        state: 'failed',
        refusal: refusal(
          'step_failed',
          `Restoring ${volume} from archive ${archive.archiveId} failed (${failedWhy}); its previous contents were put back from safety archive ${safetyId} and the stack was started again.`,
          'Check the archive and the host, then restore again.',
        ),
      };
      return result;
    }
    leaveStopped = true;
    result = leftStoppedResult(jobId, volume, resolved, safetyId, `${failedWhy}, and putting back safety archive ${safetyId} failed too (${back.failed ?? 'unknown'})`);
    return result;
  } catch (err) {
    // Anything that escaped above. With the volume half-restored: fail closed, never start it.
    if (volumeState.dirty) {
      leaveStopped = true;
      result = leftStoppedResult(jobId, volume, resolved, safetyId, `the restore stopped part-way: ${safeError(err)}`);
    } else {
      result = { jobId, state: 'failed', refusal: refusal('step_failed', `The restore of ${volume} stopped before the volume was touched (${safeError(err)}).`) };
    }
    return result;
  } finally {
    if (!leaveStopped) {
      // Started again whatever happened above — unless its volume could not be put back.
      step(env, 'starting');
      const start = await composeStep(env, 'start', resolved.compose).catch((err: unknown): ExecResult => ({ exitCode: 1, stdout: '', stderr: safeError(err) }));
      if (start.exitCode !== 0 && result !== undefined) {
        const startMsg = `compose start of ${resolved.compose.project} failed afterwards; its containers may still be stopped.`;
        if (result.state === 'succeeded') {
          result.state = 'failed';
          result.refusal = refusal('step_failed', `The volume was restored, but ${startMsg}`, `Start ${resolved.owner.name} from its page, then check its containers.`);
        } else if (result.refusal !== undefined) {
          result.refusal = { ...result.refusal, message: `${result.refusal.message} ${startMsg}` };
        }
      }
    }
  }
}

async function runDeleteJob(env: JobEnv, ctx: MaintenanceContext, job: VolumeDeleteJob): Promise<MaintenanceResult> {
  const { ports } = env;
  step(env, 'checking');
  // Every container, running or stopped, re-checked here (SHP-REQ-203).
  const list = await allContainers(ports.docker);
  if ('code' in list) throw new Refused(list);
  const users = list.filter((c) => mounts(c, job.volume));
  if (users.length > 0) {
    const names = users.map((c) => `${c.name} (${c.state})`).join(', ');
    throw new Refused(refusal('volume_in_use', `The volume ${job.volume} is mounted by ${names}; it was not deleted.`));
  }
  await openBracket(env, { volume: job.volume });
  let result: MaintenanceResult;
  try {
    step(env, 'deleting');
    const argv = ['volume', 'rm', job.volume];
    await env.journal.begin(line(env, 'remove', { argv: ['docker', ...argv] }));
    const res = await cli(ports.docker)(argv, { timeoutMs: ctx.removeTimeoutMs ?? MAINTENANCE_REMOVE_TIMEOUT_MS });
    await env.journal.end(line(env, 'remove', { argv: ['docker', ...argv], exitCode: res.exitCode }));
    if (res.exitCode === 0) {
      env.say(`Deleted the volume ${job.volume}.`);
      result = { jobId: job.jobId, state: 'succeeded' };
    } else {
      env.say(`docker volume rm ${job.volume}: ${stripPaths(tail(res.stderr.trim(), 2_000))}`);
      result = { jobId: job.jobId, state: 'failed', refusal: refusal('step_failed', `docker volume rm ${job.volume} exited ${String(res.exitCode)}.`) };
    }
  } catch (err) {
    result = { jobId: job.jobId, state: 'failed', refusal: refusal('step_failed', `Deleting ${job.volume} stopped (${safeError(err)}).`) };
  }
  await closeBracket(env, result);
  return result;
}

// ─── Prune ───────────────────────────────────────────────────────────────────

export interface PruneCandidate {
  item: PruneItem;
  /** An unused image's tags: one with several is removed by them, since `image rm <id>` refuses it. */
  repoTags: string[];
}

function olderThan(iso: string | null, hours: number, now: Date): boolean {
  if (iso === null) return false;
  const at = Date.parse(iso);
  return !Number.isNaN(at) && now.getTime() - at > hours * 3_600_000;
}

function itemKey(kind: string, id: string): string {
  return `${kind}\u0000${id}`;
}

/**
 * What a prune with these settings would remove now (SHP-REQ-205): images no container — running
 * or stopped — uses that are dangling (no tag and no digest) or, when asked, older than the
 * threshold; and build cache records not in use, created and last used before the threshold.
 * Never a volume, a network or a container.
 */
export async function maintenancePruneCandidates(docker: DockerPort, job: Pick<PruneJob, 'images' | 'buildCache'>, now: Date): Promise<PruneCandidate[]> {
  const out: PruneCandidate[] = [];
  const wantImages = job.images.dangling || job.images.unusedOlderThanHours !== null;
  if (wantImages) {
    if (docker.hostImages === undefined || docker.hostContainers === undefined) throw new Error("this agent's Docker adapter cannot list images and containers");
    const [images, containers] = await Promise.all([docker.hostImages(), docker.hostContainers()]);
    const used = new Set(containers.map((c) => c.imageId));
    for (const img of images) {
      if (used.has(img.id) || !IMAGE_ID_RE.test(img.id)) continue;
      // A digest reference (a stack's previous image, pulled by digest) is a reference: not dangling.
      const dangling = img.repoTags.length === 0 && img.repoDigests.length === 0;
      const base = { kind: 'image' as const, id: img.id, sizeBytes: Math.max(0, Math.round(img.sizeBytes)), createdAt: img.createdAt };
      if (job.images.dangling && dangling) {
        out.push({ item: { ...base, ref: null, reason: 'dangling' }, repoTags: [] });
      } else if (job.images.unusedOlderThanHours !== null && olderThan(img.createdAt, job.images.unusedOlderThanHours, now)) {
        out.push({
          item: { ...base, ref: (img.repoTags[0] ?? img.repoDigests[0] ?? null)?.slice(0, 500) ?? null, reason: 'unused' },
          repoTags: img.repoTags.filter((t) => !flagLike(t)),
        });
      }
    }
  }
  const hours = job.buildCache.olderThanHours;
  if (hours !== null) {
    if (docker.buildCacheRecords === undefined) throw new Error("this agent's Docker adapter cannot list the build cache");
    for (const rec of await docker.buildCacheRecords()) {
      if (rec.inUse || !CACHE_ID_RE.test(rec.id)) continue;
      const created = rec.createdAt;
      const lastUsed = rec.lastUsedAt ?? rec.createdAt;
      if (!olderThan(created, hours, now) || !olderThan(lastUsed, hours, now)) continue;
      out.push({ item: { kind: 'build-cache', id: rec.id, ref: null, sizeBytes: Math.max(0, Math.round(rec.sizeBytes)), createdAt: created, reason: 'old-cache' }, repoTags: [] });
    }
  }
  return out.slice(0, MAX_PRUNE_ITEMS);
}

function sumBytes(items: { sizeBytes: number }[]): number {
  return items.reduce((n, i) => n + i.sizeBytes, 0);
}

/** The removal argv for one still-eligible image: never `-f` (SHP-REQ-205). */
export function pruneRemoveArgv(c: { item: Pick<PruneItem, 'kind' | 'id' | 'reason'>; repoTags: string[] }): string[] {
  if (c.item.reason === 'unused' && c.repoTags.length > 1) return ['image', 'rm', ...c.repoTags];
  return ['image', 'rm', c.item.id];
}

/** What is still on the host after the removals: image and cache record IDs. */
async function presentNow(docker: DockerPort, kinds: { images: boolean; cache: boolean }): Promise<Set<string>> {
  const present = new Set<string>();
  if (kinds.images && docker.hostImages !== undefined) for (const img of await docker.hostImages()) present.add(itemKey('image', img.id));
  if (kinds.cache && docker.buildCacheRecords !== undefined) for (const rec of await docker.buildCacheRecords()) present.add(itemKey('build-cache', rec.id));
  return present;
}

async function runPruneJob(env: JobEnv, ctx: MaintenanceContext, job: PruneJob): Promise<MaintenanceResult> {
  const { ports } = env;
  if (!job.dryRun) {
    // A real prune only ever follows a dry run in this agent's own ledger (SHP-REQ-205).
    await ctx.ledger.refresh();
    const plan = job.fromDryRunId === undefined ? null : ctx.ledger.prunePlan(job.fromDryRunId);
    if (plan === null) throw new Refused(refusal('dry_run_required', `There is no prune dry run ${job.fromDryRunId ?? '(none named)'} in this agent's ledger.`));
    if (ctx.busy !== undefined && (await ctx.busy())) {
      throw new Refused(refusal('locked', 'A deploy, stack update or action is running on this host; nothing was pruned.', 'Prune again once it has finished.'));
    }
    return pruneFromPlan(env, ctx, job, plan.items);
  }

  step(env, 'listing');
  const found = await maintenancePruneCandidates(ports.docker, job, ports.clock.now());
  const items = found.map((c) => c.item);
  await ctx.ledger.append({ kind: 'prune-plan', jobId: job.jobId, items: items.map((i): PrunePlanItem => ({ ...i })), at: ports.clock.now().toISOString() });
  env.say(`Dry run: ${String(items.length)} item(s), ${String(sumBytes(items))} bytes reclaimable. Nothing was removed.`);
  return { jobId: job.jobId, state: 'succeeded', prune: { items, reclaimableBytes: sumBytes(items), reclaimedBytes: null } };
}

async function pruneFromPlan(env: JobEnv, ctx: MaintenanceContext, job: PruneJob, planned: PrunePlanItem[]): Promise<MaintenanceResult> {
  const { ports } = env;
  await openBracket(env, { fromDryRunId: job.fromDryRunId });
  let result: MaintenanceResult;
  try {
    step(env, 'listing');
    const now = new Map((await maintenancePruneCandidates(ports.docker, job, ports.clock.now())).map((c) => [itemKey(c.item.kind, c.item.id), c]));
    const eligible = planned.flatMap((p) => {
      const current = now.get(itemKey(p.kind, p.id));
      return current === undefined ? [] : [current];
    });
    const skipped = planned.length - eligible.length;
    if (skipped > 0) env.say(`${String(skipped)} item(s) of the dry run are no longer eligible (in use, re-tagged or gone) and were left alone.`);

    step(env, 'pruning');
    const timeoutMs = ctx.removeTimeoutMs ?? MAINTENANCE_REMOVE_TIMEOUT_MS;
    for (const c of eligible) {
      const isCache = c.item.kind === 'build-cache';
      // A cache record goes through the Engine's /build/prune with its full ID anchored, never a prefix.
      // The journal says what really runs: an Engine call for a cache record, the CLI for an image.
      const argv = isCache ? ['engine', 'POST', '/build/prune', 'all=true', `id=^${c.item.id}$`] : ['docker', ...pruneRemoveArgv(c)];
      await env.journal.begin(line(env, 'remove', { argv, detail: { kind: c.item.kind, id: c.item.id } }));
      let exitCode = 0;
      let why = '';
      try {
        if (isCache) {
          if (ports.docker.pruneBuildCacheRecord === undefined) throw new Error("this agent's Docker adapter cannot prune a build cache record");
          await ports.docker.pruneBuildCacheRecord(c.item.id);
        } else {
          const res = await cli(ports.docker)(pruneRemoveArgv(c), { timeoutMs });
          exitCode = res.exitCode;
          why = res.stderr.trim();
        }
      } catch (err) {
        exitCode = 1;
        why = safeError(err);
      }
      await env.journal.end(line(env, 'remove', { argv, exitCode, detail: { kind: c.item.kind, id: c.item.id } }));
      if (exitCode !== 0) env.say(`Could not remove ${c.item.kind} ${c.item.id}: ${stripPaths(tail(why, 500))}`);
    }

    // What was reclaimed is what is measurably gone now, not what was planned.
    const present = await presentNow(ports.docker, { images: eligible.some((c) => c.item.kind === 'image'), cache: eligible.some((c) => c.item.kind === 'build-cache') });
    const removed = eligible.filter((c) => !present.has(itemKey(c.item.kind, c.item.id))).map((c) => c.item);
    const stayed = eligible.length - removed.length;
    const prune = { items: removed, reclaimableBytes: sumBytes(eligible.map((c) => c.item)), reclaimedBytes: sumBytes(removed) };
    env.say(`Removed ${String(removed.length)} item(s), ${String(prune.reclaimedBytes)} bytes.`);
    result =
      stayed === 0
        ? { jobId: job.jobId, state: 'succeeded', prune }
        : { jobId: job.jobId, state: 'failed', prune, refusal: refusal('step_failed', `${String(stayed)} item(s) are still on the host after the prune; the rest were removed.`) };
  } catch (err) {
    result = { jobId: job.jobId, state: 'failed', refusal: refusal('step_failed', `The prune stopped (${safeError(err)}).`) };
  }
  await closeBracket(env, result);
  return result;
}

// ─── Entry ───────────────────────────────────────────────────────────────────

function journalName(job: MaintenanceJob): string {
  if (job.kind === 'prune') return 'prune';
  if (job.kind === 'volume-delete') return job.volume;
  return job.owner.name;
}

/**
 * Runs one maintenance job to its result (SHP-ADR-012). Never throws: a refusal before anything
 * was touched is `refused`; anything after is `failed`. `output` is the agent's own account,
 * redacted against the owner's env files and capped at 64 KiB.
 */
export async function runMaintenance(ports: MaintenancePorts, ctx: MaintenanceContext, job: MaintenanceJob): Promise<MaintenanceResult> {
  const log = ports.log.child({ jobId: job.jobId, kind: job.kind });
  const lines: string[] = [];
  const env = jobEnv({ ...ports, log }, ctx, { jobId: job.jobId, kind: job.kind, name: journalName(job), say: (l) => lines.push(l) });

  let secrets: string[] = [];
  let result: MaintenanceResult;
  try {
    if (job.kind !== 'prune') {
      const bad = checkVolumeName(job.volume);
      if (bad !== null) throw new Refused(bad);
    }
    if (job.kind === 'volume-backup' || job.kind === 'volume-restore') {
      const owner = resolveOwner(ctx, job.owner);
      if (!('code' in owner)) secrets = await loadRedactionValues(ports.fs, owner.envFiles).catch(() => []);
    }
    switch (job.kind) {
      case 'volume-backup':
        result = await runBackupJob(env, ctx, job);
        break;
      case 'volume-restore':
        result = await runRestoreJob(env, ctx, job);
        break;
      case 'volume-delete':
        result = await runDeleteJob(env, ctx, job);
        break;
      case 'prune':
        result = await runPruneJob(env, ctx, job);
        break;
    }
  } catch (err) {
    if (err instanceof Refused) {
      log.warn({ code: err.refusal.code }, err.refusal.message);
      result = { jobId: job.jobId, state: 'refused', refusal: err.refusal };
    } else {
      log.error({ err: message(err) }, 'maintenance job failed');
      result = { jobId: job.jobId, state: 'failed', refusal: refusal('step_failed', `The agent could not run this ${job.kind} (${safeError(err)}).`) };
    }
  }
  const text = tail(createRedactor(secrets)(lines.join('\n')), MAX_MAINTENANCE_OUTPUT);
  if (text.length > 0) result.output = text;
  return result;
}

// ─── Before a stack update (SHP-ADR-012: `volumeBackups.beforeUpdate`) ──────

/**
 * Backs up a stack's volumes inside a stack update that already holds the stack's lock: the
 * manifest's listed volumes, or every named volume the project's containers mount. Each is its own
 * journaled job (not reported to the server) with the stack's `quiesce` and `retain`. Returns the
 * first refusal, or null when every volume was archived.
 */
export async function backupVolumesBeforeUpdate(ports: MaintenancePorts, ctx: MaintenanceContext, args: { stack: string; updateId: string }): Promise<{ refusal: Refusal | null; archives: string[] }> {
  const resolved = resolveOwner(ctx, { kind: 'stack', name: args.stack });
  if ('code' in resolved) return { refusal: resolved, archives: [] };
  const settings = resolved.settings;
  const quiesce = settings?.quiesce ?? false;
  const list = await allContainers(ports.docker);
  if ('code' in list) return { refusal: list, archives: [] };
  const project = list.filter((c) => c.compose?.project === resolved.compose.project);
  const mounted = [...new Set(project.flatMap((c) => c.mounts.flatMap((m) => (m.type === 'volume' && m.volume !== null ? [m.volume] : []))))].sort();
  const volumes = settings?.volumes ?? mounted;
  const archives: string[] = [];
  if (quiesce) {
    const own = await refuseOwnStack(ctx, resolved, 'stop it for a backup');
    if (own !== null) return { refusal: own, archives };
  }
  let imageId: string;
  try {
    imageId = await helperImageOrRefuse(ctx.helperImage);
  } catch (err) {
    return { refusal: err instanceof Refused ? err.refusal : refusal('backup_failed', safeError(err)), archives };
  }
  for (const volume of volumes) {
    const jobId = randomUUID();
    const env = jobEnv(ports, ctx, {
      jobId,
      kind: 'volume-backup',
      name: args.stack,
      say: (l) => {
        ports.log.info({ jobId, volume, updateId: args.updateId }, l);
      },
    });
    if (checkVolumeName(volume) !== null || !mounted.includes(volume)) {
      return { refusal: refusal('volume_not_owned', `No container of the stack ${args.stack} mounts the volume ${volume}; the update was not started.`), archives };
    }
    try {
      await openBracket(env, { volume, quiesce, report: false, updateId: args.updateId, ...composeDetail(resolved) });
    } catch (err) {
      return { refusal: err instanceof Refused ? err.refusal : refusal('backup_failed', safeError(err)), archives };
    }
    let result: MaintenanceResult;
    try {
      const outcome = await backupQuiesced(env, ctx, { volume, resolved, quiesce, imageId });
      result = await backupResult(env, ctx, volume, resolved, outcome);
    } catch (err) {
      result = { jobId, state: 'failed', refusal: refusal('backup_failed', `The backup of ${volume} stopped (${safeError(err)}).`) };
    }
    await closeBracket(env, result);
    if (result.archive !== undefined) archives.push(result.archive.archiveId);
    if (result.state !== 'succeeded') return { refusal: result.refusal ?? refusal('backup_failed', `The backup of ${volume} failed.`), archives };
  }
  return { refusal: null, archives };
}

// ─── After a restart ─────────────────────────────────────────────────────────

export interface MaintenanceRecoveryContext {
  backupRoot: string;
  ledger: Pick<Ledger, 'refresh' | 'append' | 'volumeArchives' | 'volumeArchive' | 'volumeArchiveRecorded' | 'hasVolumeArchives'>;
  /** The agent's own image ID, to put back a half-restored volume. */
  helperImage: () => Promise<string>;
  composeTimeoutMs?: number;
  helperTimeoutMs?: number;
}

export interface MaintenanceRecovery {
  jobId: string;
  kind: string;
  /** The owner's, the volume's or `prune`. */
  name: string;
  lastStep: string | undefined;
  /** Whether the server is told: a backup inside a stack update is not a job it knows. */
  report: boolean;
  /** True when the job had stopped the owner's project and recovery started it again. */
  restarted: boolean;
  /** The restart's exit code; null when none was needed. */
  startExitCode: number | null;
  /** Archives the interrupted job had recorded, or that recovery adopted (a restore's safety archive). */
  archives: string[];
  /** An interrupted restore's volume was put back from its safety archive. */
  restoredFromSafety: boolean;
  /**
   * An interrupted restore's volume may be half-restored and could not be put back: the project was
   * left stopped so nothing writes to it.
   */
  leftStopped: boolean;
  /** The safety archive of an interrupted restore, when it had one. */
  safetyArchiveId: string | null;
}

function composeFromDetail(detail: Record<string, unknown> | undefined): ComposeTarget | null {
  const files = detail?.['composeFiles'];
  const project = detail?.['project'];
  if (!Array.isArray(files) || typeof project !== 'string' || project === '' || flagLike(project)) return null;
  if (files.length === 0 || !files.every((f): f is string => typeof f === 'string' && !flagLike(f))) return null;
  return { files, project };
}

function ownerFromDetail(detail: Record<string, unknown> | undefined): VolumeOwnerRecord | null {
  const owner = detail?.['owner'];
  if (typeof owner !== 'object' || owner === null) return null;
  const { kind, name } = owner as Record<string, unknown>;
  return (kind === 'app' || kind === 'stack') && typeof name === 'string' && name !== '' ? { kind, name } : null;
}

/**
 * Archives an interrupted job committed but never recorded are adopted into the ledger when the
 * journal says which volume and owner they belong to (SHP-T-17.2); then every `.tmp` under
 * `<backup root>/volumes/*` and every archive file the ledger does not hold live is removed.
 */
async function sweepBackupRoot(ports: Pick<MaintenancePorts, 'fs' | 'files' | 'log'>, ctx: MaintenanceRecoveryContext, jobs: UnfinishedMaintenance[]): Promise<Map<string, string[]>> {
  const adopted = new Map<string, string[]>();
  const root = ctx.backupRoot.replace(/\/+$/, '');
  await ctx.ledger.refresh();
  // Judged before any adoption: a ledger that never recorded an archive (lost, replaced, empty)
  // must never be the reason every archive on disk is deleted.
  const ledgerKnowsArchives = ctx.ledger.hasVolumeArchives();
  for (const job of jobs) {
    const volume = job.detail?.['volume'];
    const owner = ownerFromDetail(job.detail);
    for (const a of job.archives) {
      if (a.file === null || ctx.ledger.volumeArchiveRecorded(a.archiveId)) continue;
      if (typeof volume !== 'string' || !VOLUME_RE.test(volume) || owner === null || !a.file.startsWith(`${volumeArchiveDir(root, volume)}/`) || a.file.includes('/../')) continue;
      const digest = await ports.files.digest(a.file).catch(() => null);
      if (digest === null) continue;
      await ctx.ledger.append({
        kind: 'volume-archive',
        archiveId: a.archiveId,
        volume,
        owner,
        createdAt: a.at,
        sizeBytes: digest.sizeBytes,
        sha256: digest.sha256,
        quiesced: job.detail?.['kind'] === 'volume-restore' || job.detail?.['quiesce'] === true,
        file: a.file,
      });
      adopted.set(job.jobId, [...(adopted.get(job.jobId) ?? []), a.archiveId]);
      ports.log.warn({ jobId: job.jobId, archiveId: a.archiveId }, 'adopted an archive an interrupted job had written but not recorded');
    }
  }
  let found: { path: string }[];
  try {
    found = await ports.fs.list(`${root}/volumes`, { recursive: true });
  } catch {
    return adopted;
  }
  const live = new Set(ctx.ledger.volumeArchives().map((a) => a.file));
  let keptUnknown = 0;
  for (const { path } of found) {
    const rel = path.slice(`${root}/volumes/`.length);
    // Only files directly in a volume's directory.
    if (!path.startsWith(`${root}/volumes/`) || rel.split('/').length !== 2) continue;
    const unrecorded = path.endsWith(ARCHIVE_SUFFIX) && !live.has(path);
    if (unrecorded && !ledgerKnowsArchives) {
      keptUnknown += 1;
      continue;
    }
    const stray = path.endsWith(TMP_SUFFIX) || unrecorded;
    if (!stray) continue;
    await ports.files.remove(path).catch((err: unknown) => {
      ports.log.warn({ err: safeError(err) }, 'could not remove a stray archive file');
    });
  }
  if (keptUnknown > 0) {
    ports.log.warn({ files: keptUnknown }, 'the ledger has no volume archives but the backup root holds archive files; leaving them all in place');
  }
  return adopted;
}

/**
 * For every maintenance job a previous run left open (SHP-ADR-012): removes a helper container
 * still running, temp archives and archive files the ledger does not hold (adopting one the
 * journal can place), puts a volume an interrupted restore had begun emptying or extracting back
 * from its safety archive, and — when the job had stopped the owner's project — starts it again,
 * journaled. If a half-restored volume cannot be put back, the project is left stopped. Never
 * resumes the job. The bracket stays open for the agent to close once it has told the server.
 */
export async function recoverInterruptedMaintenance(
  ports: Pick<MaintenancePorts, 'docker' | 'fs' | 'files' | 'log'>,
  journal: Pick<Journal, 'unfinishedMaintenance' | 'begin' | 'end'>,
  ctx: MaintenanceRecoveryContext,
): Promise<MaintenanceRecovery[]> {
  const jobs = await journal.unfinishedMaintenance();
  for (const job of jobs) {
    for (const helper of job.helpers) {
      if (!helper.startsWith(MAINTENANCE_HELPER_PREFIX)) continue;
      await ports.docker.dockerCli?.(['rm', '--force', helper], { timeoutMs: 60_000 }).catch(() => undefined);
    }
  }
  let adopted = new Map<string, string[]>();
  try {
    adopted = await sweepBackupRoot(ports, ctx, jobs);
  } catch (err) {
    ports.log.error({ err: safeError(err) }, 'could not sweep the backup root');
  }

  const out: MaintenanceRecovery[] = [];
  for (const job of jobs) {
    const kind = typeof job.detail?.['kind'] === 'string' ? job.detail['kind'] : 'maintenance';
    const archiveIds = [...new Set([...job.archives.map((a) => a.archiveId), ...(adopted.get(job.jobId) ?? [])])];
    const recovery: MaintenanceRecovery = {
      jobId: job.jobId,
      kind,
      name: job.name,
      lastStep: job.lastStep,
      report: job.detail?.['report'] !== false,
      restarted: false,
      startExitCode: null,
      archives: archiveIds,
      restoredFromSafety: false,
      leftStopped: false,
      safetyArchiveId: kind === 'volume-restore' ? (archiveIds.at(-1) ?? null) : null,
    };
    const env: JobEnv = {
      ports: { ...ports, clock: { now: () => new Date(), sleep: () => Promise.resolve() } },
      journal,
      jobId: job.jobId,
      kind,
      name: job.name,
      say: (l) => {
        ports.log.warn({ jobId: job.jobId }, l);
      },
      composeTimeoutMs: ctx.composeTimeoutMs ?? MAINTENANCE_COMPOSE_TIMEOUT_MS,
      helperTimeoutMs: ctx.helperTimeoutMs ?? MAINTENANCE_HELPER_TIMEOUT_MS,
    };

    if (kind === 'volume-restore' && job.dataDirty) {
      // The volume may be half-emptied or half-extracted: put back what it held before, or leave
      // the stack stopped so nothing writes to it.
      const volume = job.detail?.['volume'];
      const safety = recovery.safetyArchiveId === null ? null : ctx.ledger.volumeArchive(recovery.safetyArchiveId);
      let ok = false;
      try {
        if (typeof volume === 'string' && VOLUME_RE.test(volume) && safety !== null && safety.volume === volume && (await archiveIntact(ports.files, safety))) {
          const imageId = await helperImageOrRefuse(ctx.helperImage);
          ok = (await emptyAndExtract(env, { volume, archive: safety, imageId, prefix: 'safety-', purpose: 'recover-' })).ok;
        }
      } catch (err) {
        ports.log.error({ jobId: job.jobId, err: err instanceof Refused ? err.refusal.message : safeError(err) }, 'could not put back the safety archive of an interrupted restore');
      }
      if (!ok) {
        recovery.leftStopped = true;
        ports.log.error({ jobId: job.jobId, safetyArchiveId: recovery.safetyArchiveId }, 'an interrupted restore could not be put back; its stack is left stopped');
        out.push(recovery);
        continue;
      }
      recovery.restoredFromSafety = true;
    }

    const compose = composeFromDetail(job.detail);
    if (job.stopped && compose !== null) {
      let exitCode: number;
      try {
        exitCode = (await composeStep(env, 'start', compose, { recover: true })).exitCode;
      } catch (err) {
        ports.log.error({ jobId: job.jobId, err: safeError(err) }, 'could not start the project an interrupted job had stopped');
        exitCode = 1;
      }
      recovery.restarted = true;
      recovery.startExitCode = exitCode;
      ports.log.warn({ jobId: job.jobId, project: compose.project, exitCode }, 'started again the project an interrupted maintenance job had stopped');
    }
    out.push(recovery);
  }
  return out;
}

/** Closes an interrupted job's bracket once the server has been told (or need not be). */
export async function closeInterruptedMaintenance(journal: Pick<Journal, 'end'>, recovery: MaintenanceRecovery): Promise<void> {
  await journal.end({
    deployId: recovery.jobId,
    app: recovery.name,
    step: MAINTENANCE_STEP,
    detail: { kind: recovery.kind, state: 'failed', interrupted: true, leftStopped: recovery.leftStopped },
  });
}
