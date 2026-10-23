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

import { MAINTENANCE_STEP, maintenanceStep, type Journal } from './journal.js';
import type { Ledger, PrunePlanItem, VolumeArchiveRecord } from './ledger.js';
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
 * pulled and no manifest supplies an argv for it.
 *
 * - **Backup** (SHP-REQ-201): the owner must be an app or stack this agent manages and one of its
 *   compose project's containers must mount the volume — the agent re-checks; it never trusts the
 *   server's view. With `quiesce` the project is stopped first and started again in a `finally`,
 *   whatever happened. The helper writes `tar --zstd` of the volume (mounted read-only) to a temp
 *   name beside the archive; the agent fsyncs and renames it, hashes it itself, records it in its
 *   ledger (kind `volume-archive`, with the path only there) and trims the volume's archives to the
 *   owner's `retain` (SHP-REQ-206).
 * - **Restore** (SHP-REQ-202): only a live archive of this volume in this agent's ledger whose file
 *   still hashes to what was recorded. The project is stopped, a safety archive of what the volume
 *   holds now is taken (so a wrong restore can be undone), the volume is emptied and the archive
 *   extracted into it, and the project is started again in a `finally`.
 * - **Delete** (SHP-REQ-203): refused `volume_in_use` while any container — running or stopped —
 *   mounts the volume; otherwise `docker volume rm` without `-f`.
 * - **Prune** (SHP-REQ-205): a dry run lists dangling images, unused images older than the
 *   threshold and unused build cache older than the threshold — never volumes, networks or
 *   containers — and records that list in the ledger (kind `prune-plan`). A real prune loads the
 *   plan it names from this ledger (`dry_run_required` otherwise), re-checks each item now, and
 *   removes only what is still eligible, without `-f`.
 *
 * Every job is journaled before it acts (SHP-D-029): a `maintenance` bracket and one
 * `maintenance:<kind>:<step>` pair per step. After a restart, `recoverInterruptedMaintenance`
 * starts again a project a job had stopped — a stack is never left stopped because the agent
 * restarted — removes a temp archive and a helper container left behind, and the agent reports
 * the job failed. Backup and restore output is never stored or reported (non-negotiable 10): the
 * result's `output` is the agent's own account of what it did, redacted.
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
  /** Takes the owner's deploy lock. Default: `AppLock.acquire` under the data root. */
  lockOwner?: (owner: VolumeOwner, jobId: string) => Promise<MaintenanceLock | Refusal>;
  /** True while a deploy, stack update or action runs on this host: a real prune is refused `locked`. */
  busy?: () => boolean | Promise<boolean>;
  onStep?: (step: MaintenanceStep) => void;
  /** `compose stop` / `compose start`. Default 3 min. */
  composeTimeoutMs?: number;
  /** One helper run (an archive, an empty, an extract). Default 6 h. */
  helperTimeoutMs?: number;
  /** One `image rm`, `builder prune` or `volume rm`. Default 2 min. */
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

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  const found =
    owner.kind === 'app'
      ? ctx.apps.get(owner.name)?.manifest
      : ctx.stacks.get(owner.name)?.manifest;
  if (found === undefined) {
    return refusal('volume_not_owned', `No ${owner.kind === 'app' ? 'app manifest' : 'adopted stack'} named ${owner.name} on this host; the agent backs up and restores only volumes of apps and stacks it manages.`);
  }
  if (flagLike(found.compose.project) || found.compose.files.some(flagLike)) {
    return refusal('invalid_request', `The ${owner.kind} ${owner.name} names a compose project or file beginning with "-"; Shipyard will not pass it to compose.`);
  }
  return { owner, compose: { files: found.compose.files, project: found.compose.project }, settings: found.volumeBackups, envFiles: found.envFiles };
}

function checkVolumeName(volume: string): Refusal | null {
  return VOLUME_RE.test(volume) ? null : refusal('invalid_request', `${volume} is not a Docker volume name.`);
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
  return refusal(
    'volume_not_owned',
    `No container of the ${resolved.owner.kind} ${resolved.owner.name} (compose project ${resolved.compose.project}) mounts the volume ${volume}.`,
  );
}

// ─── The job's own account, journal and steps ───────────────────────────────

interface JobEnv {
  ports: MaintenancePorts;
  ctx: MaintenanceContext;
  jobId: string;
  kind: MaintenanceJob['kind'];
  /** The journal's `app` for this job: the owner, the volume or `prune`. */
  name: string;
  say: (line: string) => void;
}

function line(env: JobEnv, step: string, extra: { argv?: string[]; exitCode?: number; detail?: Record<string, unknown> } = {}) {
  return { deployId: env.jobId, app: env.name, step: maintenanceStep(env.kind, step), ...extra };
}

function step(env: JobEnv, s: MaintenanceStep): void {
  try {
    env.ctx.onStep?.(s);
  } catch (err) {
    env.ports.log.warn({ jobId: env.jobId, err: message(err) }, 'onStep threw; ignoring');
  }
}

function cli(env: JobEnv): NonNullable<DockerPort['dockerCli']> {
  const run = env.ports.docker.dockerCli?.bind(env.ports.docker);
  if (run === undefined) throw new Error("this agent's Docker adapter cannot run the docker CLI");
  return run;
}

/** `compose stop|start` of the owner's project, journaled; never throws. */
async function composeStep(env: JobEnv, which: 'stop' | 'start', compose: ComposeTarget, detail: Record<string, unknown> = {}): Promise<ExecResult> {
  const argv = [which];
  await env.ctx.journal.begin(line(env, which, { argv, detail: { project: compose.project, ...detail } }));
  let res: ExecResult;
  try {
    res = await env.ports.docker.compose(compose, argv, { timeoutMs: env.ctx.composeTimeoutMs ?? MAINTENANCE_COMPOSE_TIMEOUT_MS });
  } catch (err) {
    res = { exitCode: 1, stdout: '', stderr: message(err) };
  }
  await env.ctx.journal
    .end(line(env, which, { argv, exitCode: res.exitCode, detail: { project: compose.project, ...detail } }))
    .catch((err: unknown) => {
      env.ports.log.error({ jobId: env.jobId, err: message(err) }, `could not journal the end of compose ${which}`);
    });
  env.say(`compose ${which} of ${compose.project}: exit ${String(res.exitCode)}.`);
  return res;
}

/** Runs one helper container, journaled. On a timeout the container is removed by name. */
async function runHelper(env: JobEnv, stepName: string, argv: string[], detail: Record<string, unknown>): Promise<ExecResult> {
  const name = argv[argv.indexOf('--name') + 1] ?? '';
  await env.ctx.journal.begin(line(env, stepName, { argv: ['docker', ...argv], detail: { ...detail, helper: name } }));
  let res: ExecResult;
  try {
    res = await cli(env)(argv, { timeoutMs: env.ctx.helperTimeoutMs ?? MAINTENANCE_HELPER_TIMEOUT_MS });
  } catch (err) {
    res = { exitCode: 1, stdout: '', stderr: message(err) };
  }
  if (res.exitCode === TIMEOUT_EXIT_CODE && name !== '') {
    // The CLI was killed; the container may still be running. It is never left behind.
    await cli(env)(['rm', '--force', name], { timeoutMs: 60_000 }).catch(() => undefined);
  }
  // Never the helper's output (non-negotiable 10): only that it ran and how it exited.
  await env.ctx.journal.end(line(env, stepName, { argv: ['docker', ...argv], exitCode: res.exitCode, detail: { ...detail, helper: name } }));
  return res;
}

// ─── Archives ────────────────────────────────────────────────────────────────

/**
 * Takes one archive of `volume` with the helper and records it in the ledger (SHP-REQ-201). The
 * owner's containers are stopped or not by the caller. Never throws a failure of the archive itself:
 * it returns the refusal, having removed the temp file.
 */
async function takeArchive(
  env: JobEnv,
  args: { volume: string; owner: VolumeOwner | null; quiesced: boolean; imageId: string },
): Promise<{ record: VolumeArchiveRecord } | { refusal: Refusal }> {
  const { files, fs, clock } = env.ports;
  const root = env.ctx.backupRoot.replace(/\/+$/, '');
  const dir = volumeArchiveDir(root, args.volume);
  if (unsafeMountPath(dir)) {
    return { refusal: refusal('backup_failed', `The backup root ${root} cannot be bind-mounted (it must be absolute, with no ":" or ","); nothing was archived.`) };
  }
  const archiveId = randomUUID();
  const createdAt = clock.now();
  const stamp = archiveTimestamp(createdAt);
  let finalPath = `${dir}/${stamp}.tar.zst`;
  const tmpName = `.${stamp}-${archiveId}.tar.zst.tmp`;
  const tmp = `${dir}/${tmpName}`;
  const argv = backupHelperArgv({ name: helperName(env.jobId, `archive-${archiveId.slice(0, 8)}`), imageId: args.imageId, volume: args.volume, dir, tmpName });
  const detail = { volume: args.volume, tmp, archiveId };
  try {
    await files.ensureDir(root);
    await files.ensureDir(`${root}/volumes`);
    await files.ensureDir(dir);
    if (await fs.exists(finalPath)) finalPath = `${dir}/${stamp}-${archiveId.slice(0, 8)}.tar.zst`;
    // Created by the agent, 0600, before the helper writes into it: the archive is never readable
    // by anyone else, even for the moment it is being written.
    await files.createEmpty(tmp);
  } catch (err) {
    await files.remove(tmp).catch(() => undefined);
    return { refusal: refusal('backup_failed', `The archive file for ${args.volume} could not be created: ${message(err)}`) };
  }
  let res: ExecResult;
  try {
    res = await runHelper(env, 'archive', argv, detail);
  } catch (err) {
    await files.remove(tmp).catch(() => undefined);
    return { refusal: refusal('backup_failed', `The archive of ${args.volume} could not be journaled or run: ${message(err)}`) };
  }
  if (res.exitCode !== 0) {
    await files.remove(tmp).catch(() => undefined);
    env.say(`Archiving ${args.volume} failed: tar exited ${String(res.exitCode)}; the partial file was removed.`);
    return { refusal: refusal('backup_failed', `Archiving the volume ${args.volume} failed (tar exited ${String(res.exitCode)}); nothing was recorded.`) };
  }
  try {
    await files.commit(tmp, finalPath);
    const digest = await files.digest(finalPath);
    if (digest === null) throw new Error('the committed archive is missing');
    const record: VolumeArchiveRecord = {
      kind: 'volume-archive',
      archiveId,
      volume: args.volume,
      owner: args.owner,
      createdAt: createdAt.toISOString(),
      sizeBytes: digest.sizeBytes,
      sha256: digest.sha256,
      quiesced: args.quiesced,
      file: finalPath,
    };
    // Recorded the moment it exists, whatever the job does next (as a deploy's backup is, SHP-REQ-085).
    await env.ctx.ledger.append(record);
    env.say(`Archived ${args.volume} as ${archiveId} (${String(digest.sizeBytes)} bytes, sha256 ${digest.sha256}${args.quiesced ? ', containers stopped' : ''}).`);
    return { record };
  } catch (err) {
    await files.remove(tmp).catch(() => undefined);
    return { refusal: refusal('backup_failed', `The archive of ${args.volume} could not be kept: ${message(err)}`) };
  }
}

/**
 * Keeps the newest `keep` live archives of `volume` and removes the rest, oldest first, recording
 * each removal (SHP-REQ-206). A file outside the volume's archive directory is never unlinked.
 */
async function applyRetention(env: JobEnv, volume: string, keep: number): Promise<string[]> {
  step(env, 'retaining');
  await env.ctx.ledger.refresh();
  const live = [...env.ctx.ledger.volumeArchives(volume)].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const excess = live.slice(0, Math.max(0, live.length - Math.max(1, keep)));
  const removed: string[] = [];
  const dir = `${volumeArchiveDir(env.ctx.backupRoot, volume)}/`;
  for (const archive of excess) {
    await env.ctx.journal.begin(line(env, 'retain', { detail: { archiveId: archive.archiveId } }));
    if (archive.file.startsWith(dir) && !archive.file.includes('/../')) await env.ports.files.remove(archive.file);
    else env.ports.log.warn({ archiveId: archive.archiveId }, 'archive file is outside the backup root; not removing the file');
    await env.ctx.ledger.append({ kind: 'volume-archive-removed', archiveId: archive.archiveId, at: env.ports.clock.now().toISOString() });
    await env.ctx.journal.end(line(env, 'retain', { detail: { archiveId: archive.archiveId } }));
    removed.push(archive.archiveId);
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
async function backupQuiesced(env: JobEnv, args: { volume: string; resolved: ResolvedOwner; quiesce: boolean; imageId: string }): Promise<BackupOutcome> {
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
    const taken = await takeArchive(env, { volume, owner: resolved.owner, quiesced: quiesce, imageId });
    if ('refusal' in taken) outcome.refusal = taken.refusal;
    else outcome.record = taken.record;
    return outcome;
  } finally {
    if (stopped) {
      step(env, 'starting');
      const start = await composeStep(env, 'start', resolved.compose).catch((err: unknown): ExecResult => ({ exitCode: 1, stdout: '', stderr: message(err) }));
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

async function helperImageOrRefuse(ctx: MaintenanceContext): Promise<string> {
  let id: string;
  try {
    id = await ctx.helperImage();
  } catch (err) {
    throw new Refused(
      refusal(
        'step_failed',
        `The agent could not find its own image to run the archive helper: ${message(err)}`,
        'Run the agent in its container, as docs/install describes; it never pulls another image for this.',
      ),
    );
  }
  if (!IMAGE_ID_RE.test(id)) throw new Refused(refusal('step_failed', `The agent's own image ID ${id} is not a sha256 image ID.`));
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
    await env.ctx.journal.begin({ deployId: env.jobId, app: env.name, step: MAINTENANCE_STEP, detail: { kind: env.kind, ...detail } });
  } catch (err) {
    throw new Refused(refusal('step_failed', `The ${env.kind} could not be journaled, so it was not run: ${message(err)}`));
  }
}

async function closeBracket(env: JobEnv, result: MaintenanceResult): Promise<void> {
  await env.ctx.journal
    .end({ deployId: env.jobId, app: env.name, step: MAINTENANCE_STEP, detail: { kind: env.kind, state: result.state, ...(result.refusal === undefined ? {} : { code: result.refusal.code }) } })
    .catch((err: unknown) => {
      env.ports.log.error({ jobId: env.jobId, err: message(err) }, 'could not close the maintenance job in the journal');
    });
}

function composeDetail(resolved: ResolvedOwner): Record<string, unknown> {
  return { owner: resolved.owner, composeFiles: resolved.compose.files, project: resolved.compose.project };
}

async function runBackupJob(env: JobEnv, job: VolumeBackupJob): Promise<MaintenanceResult> {
  const { ctx, ports } = env;
  step(env, 'checking');
  const resolved = resolveOwner(ctx, job.owner);
  if ('code' in resolved) throw new Refused(resolved);
  const notMounted = await checkOwnerMounts(ports.docker, resolved, job.volume);
  if (notMounted !== null) throw new Refused(notMounted);
  const imageId = await helperImageOrRefuse(ctx);
  const lock = await takeLock(ctx, job.owner, job.jobId);
  try {
    await openBracket(env, { volume: job.volume, quiesce: job.quiesce, ...composeDetail(resolved) });
    let result: MaintenanceResult;
    try {
      const outcome = await backupQuiesced(env, { volume: job.volume, resolved, quiesce: job.quiesce, imageId });
      result = await backupResult(env, job.volume, resolved, outcome);
    } catch (err) {
      result = { jobId: job.jobId, state: 'failed', refusal: refusal('backup_failed', `The backup of ${job.volume} stopped: ${message(err)}`) };
    }
    await closeBracket(env, result);
    return result;
  } finally {
    await lock.release().catch(() => undefined);
  }
}

async function backupResult(env: JobEnv, volume: string, resolved: ResolvedOwner, outcome: BackupOutcome): Promise<MaintenanceResult> {
  const { jobId } = env;
  if (outcome.record === undefined) {
    const why = outcome.refusal ?? refusal('backup_failed', `The backup of ${volume} failed.`);
    return { jobId, state: 'failed', refusal: outcome.startFailed === true ? withStartFailure(why, resolved) : why };
  }
  const removedArchives = await applyRetention(env, volume, resolved.settings?.retain ?? DEFAULT_RETAIN);
  const archive = toVolumeArchive(outcome.record);
  if (outcome.startFailed === true) {
    return {
      jobId,
      state: 'failed',
      archive,
      removedArchives,
      refusal: refusal('step_failed', `The archive was taken, but compose start of ${resolved.compose.project} failed afterwards; its containers may still be stopped.`, `Start ${resolved.owner.name} from its page, then check its containers.`),
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

async function runRestoreJob(env: JobEnv, job: VolumeRestoreJob): Promise<MaintenanceResult> {
  const { ctx, ports } = env;
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
    throw new Refused(refusal('archive_not_found', `The archive ${job.archiveId} is recorded at a path that cannot be mounted.`));
  }
  const found = await ports.files.digest(archive.file);
  if (found === null) {
    throw new Refused(refusal('archive_not_found', `The file of archive ${job.archiveId} is no longer on the host.`));
  }
  if (found.sha256 !== archive.sha256 || found.sizeBytes !== archive.sizeBytes) {
    throw new Refused(
      refusal('archive_not_found', `The file of archive ${job.archiveId} has changed since it was taken (its sha256 no longer matches the ledger); it will not be restored.`),
    );
  }
  const imageId = await helperImageOrRefuse(ctx);
  const lock = await takeLock(ctx, job.owner, job.jobId);
  try {
    await openBracket(env, { volume: job.volume, archiveId: job.archiveId, ...composeDetail(resolved) });
    let result: MaintenanceResult;
    try {
      result = await restoreLocked(env, job, resolved, archive, imageId);
    } catch (err) {
      result = { jobId: job.jobId, state: 'failed', refusal: refusal('step_failed', `The restore of ${job.volume} stopped: ${message(err)}`) };
    }
    await closeBracket(env, result);
    return result;
  } finally {
    await lock.release().catch(() => undefined);
  }
}

async function restoreLocked(env: JobEnv, job: VolumeRestoreJob, resolved: ResolvedOwner, archive: VolumeArchiveRecord, imageId: string): Promise<MaintenanceResult> {
  const { jobId, volume } = job;
  let result: MaintenanceResult | undefined;
  let safetyId: string | undefined;
  try {
    step(env, 'stopping');
    const stop = await composeStep(env, 'stop', resolved.compose);
    if (stop.exitCode !== 0) {
      result = { jobId, state: 'failed', refusal: refusal('step_failed', `compose stop of ${resolved.compose.project} exited ${String(stop.exitCode)}; the volume was not touched.`) };
      return result;
    }

    // What the volume holds now, so a wrong restore can be undone (SHP-REQ-202).
    step(env, 'archiving');
    const safety = await takeArchive(env, { volume, owner: resolved.owner, quiesced: true, imageId });
    if ('refusal' in safety) {
      result = { jobId, state: 'failed', refusal: { ...safety.refusal, message: `The safety backup failed, so the volume was not touched: ${safety.refusal.message}` } };
      return result;
    }
    safetyId = safety.record.archiveId;
    env.say(`Safety archive of what ${volume} held before the restore: ${safetyId}.`);

    step(env, 'restoring');
    const wipe = await runHelper(env, 'empty', wipeHelperArgv({ name: helperName(jobId, 'empty'), imageId, volume }), { volume });
    if (wipe.exitCode !== 0) {
      result = {
        jobId,
        state: 'failed',
        refusal: refusal('step_failed', `Emptying ${volume} failed (exit ${String(wipe.exitCode)}); it may be partly emptied. Its contents before the restore are in archive ${safetyId}.`, `Restore archive ${safetyId} to put back what was there.`),
      };
      return result;
    }
    const extract = await runHelper(
      env,
      'extract',
      extractHelperArgv({ name: helperName(jobId, 'extract'), imageId, volume, dir: dirOf(archive.file), file: baseOf(archive.file) }),
      { volume, archiveId: archive.archiveId },
    );
    if (extract.exitCode !== 0) {
      result = {
        jobId,
        state: 'failed',
        refusal: refusal('step_failed', `Extracting archive ${archive.archiveId} into ${volume} failed (exit ${String(extract.exitCode)}); the volume may be partly restored. Its contents before the restore are in archive ${safetyId}.`, `Restore archive ${safetyId} to put back what was there.`),
      };
      return result;
    }
    env.say(`Restored ${volume} from archive ${archive.archiveId} (taken ${archive.createdAt}).`);
    result = { jobId, state: 'succeeded' };
    return result;
  } finally {
    // Always started again — whatever happened above (SHP-REQ-202).
    step(env, 'starting');
    const start = await composeStep(env, 'start', resolved.compose).catch((err: unknown): ExecResult => ({ exitCode: 1, stdout: '', stderr: message(err) }));
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

async function runDeleteJob(env: JobEnv, job: VolumeDeleteJob): Promise<MaintenanceResult> {
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
    await env.ctx.journal.begin(line(env, 'remove', { argv: ['docker', ...argv] }));
    const res = await cli(env)(argv, { timeoutMs: env.ctx.removeTimeoutMs ?? MAINTENANCE_REMOVE_TIMEOUT_MS });
    await env.ctx.journal.end(line(env, 'remove', { argv: ['docker', ...argv], exitCode: res.exitCode }));
    if (res.exitCode === 0) {
      env.say(`Deleted the volume ${job.volume}.`);
      result = { jobId: job.jobId, state: 'succeeded' };
    } else {
      env.say(`docker volume rm ${job.volume}: ${tail(res.stderr.trim(), 2_000)}`);
      result = { jobId: job.jobId, state: 'failed', refusal: refusal('step_failed', `docker volume rm ${job.volume} exited ${String(res.exitCode)}.`) };
    }
  } catch (err) {
    result = { jobId: job.jobId, state: 'failed', refusal: refusal('step_failed', `Deleting ${job.volume} stopped: ${message(err)}`) };
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
        out.push({ item: { ...base, ref: (img.repoTags[0] ?? img.repoDigests[0] ?? null)?.slice(0, 500) ?? null, reason: 'unused' }, repoTags: img.repoTags.filter((t) => !flagLike(t)) });
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

/** The removal argv for one still-eligible item: never `-f` on an image (SHP-REQ-205). */
export function pruneRemoveArgv(c: { item: Pick<PruneItem, 'kind' | 'id' | 'reason'>; repoTags: string[] }): string[] {
  if (c.item.kind === 'build-cache') return ['builder', 'prune', '--force', '--filter', `id=${c.item.id}`];
  if (c.item.reason === 'unused' && c.repoTags.length > 1) return ['image', 'rm', ...c.repoTags];
  return ['image', 'rm', c.item.id];
}

async function runPruneJob(env: JobEnv, job: PruneJob): Promise<MaintenanceResult> {
  const { ctx, ports } = env;
  if (!job.dryRun) {
    // A real prune only ever follows a dry run in this agent's own ledger (SHP-REQ-205).
    await ctx.ledger.refresh();
    const plan = job.fromDryRunId === undefined ? null : ctx.ledger.prunePlan(job.fromDryRunId);
    if (plan === null) throw new Refused(refusal('dry_run_required', `There is no prune dry run ${job.fromDryRunId ?? '(none named)'} in this agent's ledger.`));
    if (ctx.busy !== undefined && (await ctx.busy())) {
      throw new Refused(refusal('locked', 'A deploy, stack update or action is running on this host; nothing was pruned.', 'Prune again once it has finished.'));
    }
    return pruneFromPlan(env, job, plan.items);
  }

  step(env, 'listing');
  const found = await maintenancePruneCandidates(ports.docker, job, ports.clock.now());
  const items = found.map((c) => c.item);
  await ctx.ledger.append({ kind: 'prune-plan', jobId: job.jobId, items: items.map((i): PrunePlanItem => ({ ...i })), at: ports.clock.now().toISOString() });
  env.say(`Dry run: ${String(items.length)} item(s), ${String(sumBytes(items))} bytes reclaimable. Nothing was removed.`);
  return { jobId: job.jobId, state: 'succeeded', prune: { items, reclaimableBytes: sumBytes(items), reclaimedBytes: null } };
}

async function pruneFromPlan(env: JobEnv, job: PruneJob, planned: PrunePlanItem[]): Promise<MaintenanceResult> {
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
    const removed: PruneItem[] = [];
    const failures: string[] = [];
    for (const c of eligible) {
      const argv = pruneRemoveArgv(c);
      await env.ctx.journal.begin(line(env, 'remove', { argv: ['docker', ...argv], detail: { kind: c.item.kind, id: c.item.id } }));
      let res: ExecResult;
      try {
        res = await cli(env)(argv, { timeoutMs: env.ctx.removeTimeoutMs ?? MAINTENANCE_REMOVE_TIMEOUT_MS });
      } catch (err) {
        res = { exitCode: 1, stdout: '', stderr: message(err) };
      }
      await env.ctx.journal.end(line(env, 'remove', { argv: ['docker', ...argv], exitCode: res.exitCode, detail: { kind: c.item.kind, id: c.item.id } }));
      if (res.exitCode === 0) {
        removed.push(c.item);
      } else {
        failures.push(c.item.id);
        env.say(`Could not remove ${c.item.kind} ${c.item.id}: ${tail(res.stderr.trim(), 500)}`);
      }
    }
    const prune = { items: removed, reclaimableBytes: sumBytes(eligible.map((c) => c.item)), reclaimedBytes: sumBytes(removed) };
    env.say(`Removed ${String(removed.length)} item(s), ${String(prune.reclaimedBytes)} bytes.`);
    result =
      failures.length === 0
        ? { jobId: job.jobId, state: 'succeeded', prune }
        : { jobId: job.jobId, state: 'failed', prune, refusal: refusal('step_failed', `${String(failures.length)} item(s) could not be removed; the rest were.`) };
  } catch (err) {
    result = { jobId: job.jobId, state: 'failed', refusal: refusal('step_failed', `The prune stopped: ${message(err)}`) };
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
  const env: JobEnv = { ports: { ...ports, log }, ctx, jobId: job.jobId, kind: job.kind, name: journalName(job), say: (l) => lines.push(l) };

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
        result = await runBackupJob(env, job);
        break;
      case 'volume-restore':
        result = await runRestoreJob(env, job);
        break;
      case 'volume-delete':
        result = await runDeleteJob(env, job);
        break;
      case 'prune':
        result = await runPruneJob(env, job);
        break;
    }
  } catch (err) {
    if (err instanceof Refused) {
      log.warn({ code: err.refusal.code }, err.refusal.message);
      result = { jobId: job.jobId, state: 'refused', refusal: err.refusal };
    } else {
      log.error({ err: message(err) }, 'maintenance job failed');
      result = { jobId: job.jobId, state: 'failed', refusal: refusal('step_failed', `The agent could not run this ${job.kind}: ${message(err)}`) };
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
export async function backupVolumesBeforeUpdate(
  ports: MaintenancePorts,
  ctx: MaintenanceContext,
  args: { stack: string; updateId: string },
): Promise<{ refusal: Refusal | null; archives: string[] }> {
  const resolved = resolveOwner(ctx, { kind: 'stack', name: args.stack });
  if ('code' in resolved) return { refusal: resolved, archives: [] };
  const settings = resolved.settings;
  const list = await allContainers(ports.docker);
  if ('code' in list) return { refusal: list, archives: [] };
  const project = list.filter((c) => c.compose?.project === resolved.compose.project);
  const mounted = [...new Set(project.flatMap((c) => c.mounts.flatMap((m) => (m.type === 'volume' && m.volume !== null ? [m.volume] : []))))].sort();
  const volumes = settings?.volumes ?? mounted;
  const archives: string[] = [];
  let imageId: string;
  try {
    imageId = await helperImageOrRefuse(ctx);
  } catch (err) {
    return { refusal: err instanceof Refused ? err.refusal : refusal('backup_failed', message(err)), archives };
  }
  for (const volume of volumes) {
    const jobId = randomUUID();
    const env: JobEnv = { ports, ctx, jobId, kind: 'volume-backup', name: args.stack, say: (l) => {
        ports.log.info({ jobId, volume, updateId: args.updateId }, l);
      },
    };
    if (checkVolumeName(volume) !== null || !mounted.includes(volume)) {
      return { refusal: refusal('volume_not_owned', `No container of the stack ${args.stack} mounts the volume ${volume}; the update was not started.`), archives };
    }
    try {
      await openBracket(env, { volume, quiesce: settings?.quiesce ?? false, report: false, updateId: args.updateId, ...composeDetail(resolved) });
    } catch (err) {
      return { refusal: err instanceof Refused ? err.refusal : refusal('backup_failed', message(err)), archives };
    }
    let result: MaintenanceResult;
    try {
      const outcome = await backupQuiesced(env, { volume, resolved, quiesce: settings?.quiesce ?? false, imageId });
      result = await backupResult(env, volume, resolved, outcome);
    } catch (err) {
      result = { jobId, state: 'failed', refusal: refusal('backup_failed', `The backup of ${volume} stopped: ${message(err)}`) };
    }
    await closeBracket(env, result);
    if (result.archive !== undefined) archives.push(result.archive.archiveId);
    if (result.state !== 'succeeded') return { refusal: result.refusal ?? refusal('backup_failed', `The backup of ${volume} failed.`), archives };
  }
  return { refusal: null, archives };
}

// ─── After a restart ─────────────────────────────────────────────────────────

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
  /** Archives the interrupted job had already recorded (a restore's safety archive). */
  archives: string[];
}

function composeFromDetail(detail: Record<string, unknown> | undefined): ComposeTarget | null {
  const files = detail?.['composeFiles'];
  const project = detail?.['project'];
  if (!Array.isArray(files) || typeof project !== 'string' || project === '' || flagLike(project)) return null;
  if (files.length === 0 || !files.every((f): f is string => typeof f === 'string' && !flagLike(f))) return null;
  return { files, project };
}

/**
 * For every maintenance job a previous run left open (SHP-ADR-012): removes a helper container
 * still running and a temp archive left behind, and — when the job had stopped the owner's project
 * — starts it again, journaled, so a stack is never left stopped because the agent restarted.
 * Never resumes the job. The bracket stays open for the agent to close once it has told the server.
 */
export async function recoverInterruptedMaintenance(
  ports: Pick<MaintenancePorts, 'docker' | 'files' | 'log'>,
  journal: Pick<Journal, 'unfinishedMaintenance' | 'begin' | 'end'>,
  options: { composeTimeoutMs?: number } = {},
): Promise<MaintenanceRecovery[]> {
  const out: MaintenanceRecovery[] = [];
  for (const job of await journal.unfinishedMaintenance()) {
    const kind = typeof job.detail?.['kind'] === 'string' ? job.detail['kind'] : 'maintenance';
    const recovery: MaintenanceRecovery = {
      jobId: job.jobId,
      kind,
      name: job.name,
      lastStep: job.lastStep,
      report: job.detail?.['report'] !== false,
      restarted: false,
      startExitCode: null,
      archives: [],
    };
    for (const helper of job.helpers) {
      if (!helper.startsWith(MAINTENANCE_HELPER_PREFIX)) continue;
      await ports.docker.dockerCli?.(['rm', '--force', helper], { timeoutMs: 60_000 }).catch(() => undefined);
    }
    for (const tmp of job.tmpFiles) {
      if (!tmp.endsWith('.tmp')) continue;
      await ports.files.remove(tmp).catch((err: unknown) => {
        ports.log.warn({ jobId: job.jobId, err: message(err) }, 'could not remove a temp archive left by an interrupted job');
      });
    }
    recovery.archives = job.archives;
    const compose = composeFromDetail(job.detail);
    if (job.stopped && compose !== null) {
      const entry = { deployId: job.jobId, app: job.name, step: maintenanceStep(kind, 'start'), argv: ['start'], detail: { project: compose.project, recover: true } };
      let exitCode: number;
      try {
        await journal.begin(entry);
        const res = await ports.docker.compose(compose, ['start'], { timeoutMs: options.composeTimeoutMs ?? MAINTENANCE_COMPOSE_TIMEOUT_MS });
        exitCode = res.exitCode;
      } catch (err) {
        ports.log.error({ jobId: job.jobId, err: message(err) }, 'could not start the project an interrupted job had stopped');
        exitCode = 1;
      }
      await journal.end({ ...entry, exitCode }).catch(() => undefined);
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
  await journal.end({ deployId: recovery.jobId, app: recovery.name, step: MAINTENANCE_STEP, detail: { kind: recovery.kind, state: 'failed', interrupted: true } });
}
