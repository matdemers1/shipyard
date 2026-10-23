import { createHash } from 'node:crypto';

import type { LedgerEntry } from './types.js';
import type { FsPort } from './ports.js';

/**
 * Append-only digest ledger (SHP-T-1.10, SHP-REQ-023). Every digest set the agent verified and
 * deployed is recorded here as a hash-chained JSONL file, so a rollback can be checked against
 * what actually happened (SHP-REQ-051), a restore can be limited to backups the agent itself took
 * (SHP-REQ-085), and a compromised server can only ask for what this chain already allows
 * (SHP-D-080). The chain is verified in full on `open`; any break throws.
 *
 * One file, several processes (SHP-T-6.11): the agent and a host `shipyard-run` share it. Every
 * append takes the FsPort's cross-process lock, re-reads and verifies the file, and chains onto its
 * true tail; `refresh()` adopts other writers' lines for the synchronous readers.
 */

const GENESIS_HASH = '0'.repeat(64);

/**
 * A backup a deploy (or a restore) took, recorded the moment it was taken — whatever that deploy
 * does next (SHP-REQ-085). A contract release that fails its check never reaches the ledger as a
 * release, but the backup it took first is exactly the one a guided restore needs.
 */
export interface BackupRecord {
  kind: 'backup';
  app: string;
  /** The deploy (or restore) that took it. */
  deployId: string;
  /** Absolute host path of the artifact. */
  backupArtifact: string;
  /**
   * The ledger release whose images were running when the backup was taken — the code that matches
   * this data, which a restore of it runs. Null when what ran was not a release in this ledger.
   */
  release: string | null;
  at: string;
}

/**
 * A completed guided restore (SHP-T-5.6, SHP-D-038). Not a release: when the restore also put a
 * different release's images back, that is recorded beside it as a `rollback` entry with the same
 * deploy ID, so `last`, `recent` and the rollback candidates keep describing releases only.
 */
export interface RestoreRecord {
  kind: 'restore';
  app: string;
  /** The restore's own ID. */
  deployId: string;
  /** The deploy whose backup was restored. */
  backupOf: string;
  /** The artifact restored (absolute host path). */
  restoredFrom: string;
  /** The ledger release running after the restore. */
  release: string;
  sha: string;
  images: LedgerEntry['images'];
  /** The safety backup taken just before restoring, if any. */
  backupArtifact: string | null;
  at: string;
}

/** One service's image in a stack update record: the line written was `repo:tag@digest` (`repo@digest` when tag is null). */
export interface StackImageRecord {
  service: string;
  /** The stack manifest's untagged repository. */
  repo: string;
  tag: string | null;
  digest: string;
}

/**
 * A stack update or rollback that succeeded (SHP-ADR-010, SHP-REQ-197, SHP-REQ-198), keyed by the
 * stack's name in `app`. Its own kind, so no app reader — `entries`, `last`, `recent`, rollback
 * candidates, backups, pruning — ever reads it as an app release: they all select by kind. A stack
 * rollback takes its digests from these records and from nowhere else (SHP-D-080).
 */
export interface StackUpdateRecord {
  kind: 'stack-update';
  /** The stack's name. */
  app: string;
  /** The server's update ID. */
  deployId: string;
  /** `update` (to what the track resolved) or `rollback` (to an earlier record's images). */
  updateKind: 'update' | 'rollback';
  images: StackImageRecord[];
  /** What ran before, for the record; a rollback never reads this. */
  previous: StackImageRecord[];
  /** The backup the update took first, when the stack has a backup step. */
  backupArtifact: string | null;
  at: string;
}

/** The app or stack a volume belonged to when it was archived (SHP-REQ-201). */
export interface VolumeOwnerRecord {
  kind: 'app' | 'stack';
  name: string;
}

/**
 * A volume archive the agent took (SHP-REQ-201, SHP-ADR-012). Its own kind with no `app`, so no
 * app reader — releases, backups, restores, stack updates, pruning — can mistake it for one of
 * theirs. `file` is the archive's absolute path; it lives only in this ledger and never leaves the
 * agent: a restore names `archiveId` and the agent resolves the file here (SHP-REQ-202, SHP-D-080).
 */
export interface VolumeArchiveRecord {
  kind: 'volume-archive';
  archiveId: string;
  volume: string;
  owner: VolumeOwnerRecord | null;
  createdAt: string;
  sizeBytes: number;
  sha256: string;
  quiesced: boolean;
  file: string;
}

/** A volume archive the retention limit (SHP-REQ-206) removed: it is no longer live. */
export interface VolumeArchiveRemovedRecord {
  kind: 'volume-archive-removed';
  archiveId: string;
  at: string;
}

/** One image or build cache record a prune dry run listed (SHP-REQ-205). */
export interface PrunePlanItem {
  kind: 'image' | 'build-cache';
  id: string;
  ref: string | null;
  sizeBytes: number;
  createdAt: string | null;
  reason: 'dangling' | 'unused' | 'old-cache';
}

/**
 * A prune dry run's list (SHP-REQ-205): a real prune removes only items of a plan in this ledger
 * that are still eligible when it runs. Its own kind, never read by an app reader.
 */
export interface PrunePlanRecord {
  kind: 'prune-plan';
  jobId: string;
  items: PrunePlanItem[];
  at: string;
}

/** What only maintenance writes (SHP-ADR-012); none of these has an `app`. */
export type MaintenanceLedgerRecord = VolumeArchiveRecord | VolumeArchiveRemovedRecord | PrunePlanRecord;

/** The records that belong to an app or stack by name. */
export type AppLedgerRecord = LedgerEntry | BackupRecord | RestoreRecord | StackUpdateRecord;

/** Anything the ledger chain holds: a release (deploy or rollback), a backup, a restore, a stack update, or a maintenance record. */
export type LedgerRecord = AppLedgerRecord | MaintenanceLedgerRecord;

/** One physical line of the ledger file. */
interface LedgerLine {
  seq: number;
  prev: string;
  entry: LedgerRecord;
  hash: string;
}

/** How long one completed restore blocks the next restore of the same app (SHP-REQ-084). */
export const RESTORE_LIMIT_MS = 24 * 60 * 60 * 1000;

function isRelease(entry: LedgerRecord): entry is LedgerEntry {
  return entry.kind === 'deploy' || entry.kind === 'rollback';
}

function isMaintenance(entry: LedgerRecord): entry is MaintenanceLedgerRecord {
  return entry.kind === 'volume-archive' || entry.kind === 'volume-archive-removed' || entry.kind === 'prune-plan';
}

/** The app or stack a record belongs to; null for a maintenance record, which belongs to none. */
function appOf(entry: LedgerRecord): string | null {
  return isMaintenance(entry) ? null : entry.app;
}

export class LedgerTamperedError extends Error {
  constructor(line: number, reason: string) {
    super(`ledger tampered at line ${line}: ${reason}`);
    this.name = 'LedgerTamperedError';
  }
}

export class LedgerEntryInvalidError extends Error {
  constructor(reason: string) {
    super(`invalid ledger entry: ${reason}`);
    this.name = 'LedgerEntryInvalidError';
  }
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SHA40_RE = /^[0-9a-f]{40}$/;

/** Recursively sorts object keys so the hashed JSON representation is stable. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys) out[key] = canonicalize(record[key]);
    return out;
  }
  return value;
}

function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function computeHash(prev: string, seq: number, entry: LedgerRecord): string {
  const payload = `${prev}\n${canonicalJSON({ seq, entry })}`;
  return createHash('sha256').update(payload).digest('hex');
}

function validateImages(images: LedgerEntry['images']): void {
  if (!Array.isArray(images) || images.length === 0) throw new LedgerEntryInvalidError('images must be non-empty');
  for (const image of images) {
    if (!image.service || image.service.length === 0) throw new LedgerEntryInvalidError('image.service must not be empty');
    if (!image.repo || image.repo.length === 0) throw new LedgerEntryInvalidError('image.repo must not be empty');
    if (!DIGEST_RE.test(image.digest)) throw new LedgerEntryInvalidError(`invalid digest: ${image.digest}`);
  }
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const VOLUME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;

function validateAt(at: string): void {
  if (!at || Number.isNaN(Date.parse(at))) throw new LedgerEntryInvalidError(`invalid at: ${at}`);
}

function validateMaintenance(entry: MaintenanceLedgerRecord): void {
  if (entry.kind === 'volume-archive') {
    if (!entry.archiveId) throw new LedgerEntryInvalidError('archiveId must not be empty');
    if (!VOLUME_RE.test(entry.volume)) throw new LedgerEntryInvalidError(`invalid volume: ${entry.volume}`);
    const ownerKind: string | null = entry.owner === null ? null : entry.owner.kind;
    if (entry.owner !== null && (!entry.owner.name || (ownerKind !== 'app' && ownerKind !== 'stack'))) {
      throw new LedgerEntryInvalidError('owner must be null or { kind: app|stack, name }');
    }
    validateAt(entry.createdAt);
    if (!Number.isInteger(entry.sizeBytes) || entry.sizeBytes < 0) throw new LedgerEntryInvalidError(`invalid sizeBytes: ${String(entry.sizeBytes)}`);
    if (!SHA256_HEX_RE.test(entry.sha256)) throw new LedgerEntryInvalidError(`invalid sha256: ${entry.sha256}`);
    if (!entry.file.startsWith('/')) throw new LedgerEntryInvalidError(`file must be an absolute path: ${entry.file}`);
    return;
  }
  if (entry.kind === 'volume-archive-removed') {
    if (!entry.archiveId) throw new LedgerEntryInvalidError('archiveId must not be empty');
    validateAt(entry.at);
    return;
  }
  if (!entry.jobId) throw new LedgerEntryInvalidError('jobId must not be empty');
  if (!Array.isArray(entry.items)) throw new LedgerEntryInvalidError('items must be an array');
  for (const item of entry.items) {
    const itemKind: string = item.kind;
    if ((itemKind !== 'image' && itemKind !== 'build-cache') || !item.id) throw new LedgerEntryInvalidError('a prune item names its kind and id');
  }
  validateAt(entry.at);
}

function validateRecord(entry: LedgerRecord): void {
  if (isMaintenance(entry)) {
    validateMaintenance(entry);
    return;
  }
  if (!entry.app || entry.app.length === 0) throw new LedgerEntryInvalidError('app must not be empty');
  if (!entry.deployId || entry.deployId.length === 0) throw new LedgerEntryInvalidError('deployId must not be empty');
  if (!entry.at || Number.isNaN(Date.parse(entry.at))) throw new LedgerEntryInvalidError(`invalid at: ${entry.at}`);
  if (entry.kind === 'backup') {
    if (!entry.backupArtifact.startsWith('/')) throw new LedgerEntryInvalidError(`backupArtifact must be an absolute path: ${entry.backupArtifact}`);
    if (entry.release !== null && entry.release.length === 0) throw new LedgerEntryInvalidError('release must be null or a deploy ID');
    return;
  }
  if (entry.kind === 'stack-update') {
    const updateKind: string = entry.updateKind;
    if (updateKind !== 'update' && updateKind !== 'rollback') throw new LedgerEntryInvalidError(`invalid stack updateKind: ${updateKind}`);
    if (!Array.isArray(entry.images) || entry.images.length === 0) throw new LedgerEntryInvalidError('images must be non-empty');
    for (const image of [...entry.images, ...entry.previous]) {
      if (!image.service || !image.repo) throw new LedgerEntryInvalidError('a stack image names its service and repo');
      if (!DIGEST_RE.test(image.digest)) throw new LedgerEntryInvalidError(`invalid digest: ${image.digest}`);
      if (image.tag !== null && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(image.tag)) throw new LedgerEntryInvalidError(`invalid tag: ${image.tag}`);
    }
    if (entry.backupArtifact !== null && !entry.backupArtifact.startsWith('/')) throw new LedgerEntryInvalidError(`backupArtifact must be an absolute path: ${entry.backupArtifact}`);
    return;
  }
  if (entry.kind === 'restore') {
    if (!entry.backupOf || !entry.restoredFrom || !entry.release) throw new LedgerEntryInvalidError('a restore names backupOf, restoredFrom and release');
    if (!SHA40_RE.test(entry.sha)) throw new LedgerEntryInvalidError(`sha must be 40 lowercase hex characters: ${entry.sha}`);
    validateImages(entry.images);
    return;
  }
  validateEntry(entry);
}

function validateEntry(entry: LedgerEntry): void {
  if (!entry.app || entry.app.length === 0) throw new LedgerEntryInvalidError('app must not be empty');
  if (!entry.deployId || entry.deployId.length === 0) throw new LedgerEntryInvalidError('deployId must not be empty');
  const kind: string = entry.kind;
  if (kind !== 'deploy' && kind !== 'rollback') throw new LedgerEntryInvalidError(`invalid kind: ${kind}`);
  if (!SHA40_RE.test(entry.sha)) throw new LedgerEntryInvalidError(`sha must be 40 lowercase hex characters: ${entry.sha}`);
  if (!Array.isArray(entry.images) || entry.images.length === 0) throw new LedgerEntryInvalidError('images must be non-empty');
  for (const image of entry.images) {
    if (!image.service || image.service.length === 0) throw new LedgerEntryInvalidError('image.service must not be empty');
    if (!image.repo || image.repo.length === 0) throw new LedgerEntryInvalidError('image.repo must not be empty');
    if (!DIGEST_RE.test(image.digest)) throw new LedgerEntryInvalidError(`invalid digest: ${image.digest}`);
  }
  if (!entry.at || Number.isNaN(Date.parse(entry.at))) throw new LedgerEntryInvalidError(`invalid at: ${entry.at}`);
}

function parseLine(raw: string, lineNumber: number, isFinal: boolean): LedgerLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const suffix = isFinal ? ' (torn final line: append was not followed by a clean fsync)' : '';
    throw new LedgerTamperedError(lineNumber, `line does not parse as JSON${suffix}: ${(err as Error).message}`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).seq !== 'number' ||
    typeof (parsed as Record<string, unknown>).prev !== 'string' ||
    typeof (parsed as Record<string, unknown>).hash !== 'string' ||
    typeof (parsed as Record<string, unknown>).entry !== 'object' ||
    (parsed as Record<string, unknown>).entry === null
  ) {
    throw new LedgerTamperedError(lineNumber, 'line is missing required fields (seq, prev, entry, hash)');
  }
  return parsed as LedgerLine;
}

/** Reads and verifies the whole chain at `path`. A missing or empty file is an empty ledger. */
async function readVerified(fs: FsPort, path: string): Promise<LedgerLine[]> {
  if (!(await fs.exists(path))) return [];
  const content = await fs.readFile(path);
  if (content.length === 0) return [];

  const endsWithNewline = content.endsWith('\n');
  const rawLines = content.split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === ''));

  const lines: LedgerLine[] = [];
  let prevHash = GENESIS_HASH;

  for (let i = 0; i < rawLines.length; i++) {
    const lineNumber = i + 1;
    const isFinal = i === rawLines.length - 1;
    const raw = rawLines[i] ?? '';

    if (isFinal && !endsWithNewline) {
      throw new LedgerTamperedError(lineNumber, 'torn final line: no trailing newline, ledger writes are append-then-fsync');
    }

    const line = parseLine(raw, lineNumber, isFinal);

    if (line.seq !== lineNumber) {
      throw new LedgerTamperedError(lineNumber, `seq ${line.seq} is not contiguous (expected ${lineNumber})`);
    }
    if (line.prev !== prevHash) {
      throw new LedgerTamperedError(lineNumber, `prev ${line.prev} does not match the previous line's hash ${prevHash}`);
    }
    const expectedHash = computeHash(line.prev, line.seq, line.entry);
    if (line.hash !== expectedHash) {
      throw new LedgerTamperedError(lineNumber, `hash does not match its recomputed value (entry or seq/prev was edited)`);
    }

    lines.push(line);
    prevHash = line.hash;
  }
  return lines;
}

/** Backup artifact recorded for a deploy, for restore-eligibility checks (SHP-REQ-085). */
export interface BackupArtifactRecord {
  app: string;
  deployId: string;
  backupArtifact: string;
  at: string;
  /** The ledger release that matches this backup's data (see `BackupRecord.release`), or null. */
  release: string | null;
}

export class Ledger {
  private readonly fs: FsPort;
  private readonly path: string;
  private lines: LedgerLine[];
  /** Serializes appends so concurrent callers can't fork the chain. */
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(fs: FsPort, path: string, lines: LedgerLine[]) {
    this.fs = fs;
    this.path = path;
    this.lines = lines;
  }

  /** Reads the ledger at `path` and verifies the whole chain. A missing file is an empty ledger. */
  static async open(fs: FsPort, path: string): Promise<Ledger> {
    const dir = path.slice(0, Math.max(0, path.lastIndexOf('/')));
    if (dir.length > 0) await fs.mkdirp(dir);
    const ledger = new Ledger(fs, path, []);
    // Under the cross-process lock, so a line another process is appending is never read torn.
    await ledger.locked(async () => {
      ledger.lines = await readVerified(fs, path);
    });
    return ledger;
  }

  /**
   * Runs `fn` serialised within this process (the write queue) and, when the FsPort offers one,
   * holding the cross-process lock on the ledger file (SHP-T-6.11).
   */
  private locked(fn: () => Promise<void>): Promise<void> {
    const task = this.writeQueue.then(async () => {
      const release = this.fs.lock === undefined ? null : await this.fs.lock(this.path);
      try {
        await fn();
      } finally {
        await release?.();
      }
    });
    // Keep the queue alive even if this task fails, so later ones still serialize correctly, but
    // let a failure of *this* task reject its own caller.
    this.writeQueue = task.catch(() => undefined);
    return task;
  }

  /**
   * Re-reads the file and adopts lines another process appended since this instance last looked,
   * after verifying the whole chain and that every line this instance already holds is still there,
   * unchanged. Throws `LedgerTamperedError` otherwise, leaving what it held in place. Must run under
   * the lock.
   */
  private async adoptTail(): Promise<void> {
    const onDisk = await readVerified(this.fs, this.path);
    if (onDisk.length < this.lines.length) {
      throw new LedgerTamperedError(onDisk.length + 1, `the file holds ${onDisk.length} lines but ${this.lines.length} were read before: it was truncated`);
    }
    const tip = this.lines.at(-1);
    if (tip !== undefined && onDisk[tip.seq - 1]?.hash !== tip.hash) {
      throw new LedgerTamperedError(tip.seq, 'the line read before at this seq has changed on disk');
    }
    this.lines = onDisk;
  }

  /**
   * Adopts what other processes (the agent and a host CLI share one ledger file) appended since
   * this instance last read it. The engine calls it before every decision it takes from the ledger —
   * at the start of a deploy, rollback or restore and again once the app lock is held — and the
   * agent before it reports; the synchronous readers below answer from what was last adopted.
   */
  refresh(): Promise<void> {
    return this.locked(() => this.adoptTail());
  }

  /**
   * Validates, chains and appends one entry. Under the cross-process lock it first adopts any
   * lines another process appended (refusing, and writing nothing, when they do not verify), so the
   * new line always chains onto the file's true tail.
   */
  append(entry: LedgerRecord): Promise<void> {
    try {
      validateRecord(entry);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return this.locked(async () => {
      await this.adoptTail();
      const last = this.lines.at(-1);
      const seq = (last?.seq ?? 0) + 1;
      const prev = last?.hash ?? GENESIS_HASH;
      const hash = computeHash(prev, seq, entry);
      const line: LedgerLine = { seq, prev, entry, hash };
      await this.fs.appendLine(this.path, JSON.stringify(line));
      this.lines.push(line);
    });
  }

  /** All release entries (deploys and rollbacks) for `app`, oldest first. Backups and restores are not releases. */
  entries(app: string): LedgerEntry[] {
    return this.lines.flatMap((l) => (isRelease(l.entry) && l.entry.app === app ? [l.entry] : []));
  }

  /** Succeeded stack updates and rollbacks of `stack`, oldest first (SHP-REQ-198). */
  stackUpdates(stack: string): StackUpdateRecord[] {
    return this.lines.flatMap((l) => (l.entry.kind === 'stack-update' && l.entry.app === stack ? [l.entry] : []));
  }

  /** The succeeded stack update (or rollback) `updateId` of `stack`, or null: a stack rollback's only source. */
  stackUpdate(stack: string, updateId: string): StackUpdateRecord | null {
    return this.stackUpdates(stack).findLast((e) => e.deployId === updateId) ?? null;
  }

  /** Records a backup the moment it is taken (SHP-REQ-085). */
  recordBackup(record: Omit<BackupRecord, 'kind'>): Promise<void> {
    return this.append({ kind: 'backup', ...record });
  }

  /**
   * The release running now, as far as this ledger can vouch for it: the last release, when every
   * one of its images is the digest `running` reports for its service. Null otherwise — nothing
   * recorded yet, or something other than the recorded release is running (a failed contract
   * release left in place, or drift).
   */
  releaseRunning(app: string, running: Record<string, string | null>): string | null {
    const last = this.last(app);
    if (last === null) return null;
    return last.images.every((image) => running[image.service] === image.digest) ? last.deployId : null;
  }

  /** Completed restores of `app`, oldest first. */
  restores(app: string): RestoreRecord[] {
    return this.lines.flatMap((l) => (l.entry.kind === 'restore' && l.entry.app === app ? [l.entry] : []));
  }

  /** The last restore of `app` that completed within `RESTORE_LIMIT_MS` of `now`, or null (SHP-REQ-084). */
  restoreWithinLimit(app: string, now: Date): RestoreRecord | null {
    const last = this.restores(app).at(-1);
    if (last === undefined) return null;
    return now.getTime() - Date.parse(last.at) < RESTORE_LIMIT_MS ? last : null;
  }

  /** The most recent entry for `app`, or null when there is none. */
  last(app: string): LedgerEntry | null {
    const entries = this.entries(app);
    return entries.at(-1) ?? null;
  }

  /** Up to `n` most recent entries for `app`, newest first — rollback candidates. */
  recent(app: string, n = 5): LedgerEntry[] {
    const entries = this.entries(app);
    return entries.slice(Math.max(0, entries.length - n)).reverse();
  }

  /** True when `deployId` names one of the last five entries for `app`, excluding the current live one. */
  isRollbackTarget(app: string, deployId: string): boolean {
    const recent = this.recent(app, 5);
    const [live, ...candidates] = recent;
    if (live && live.deployId === deployId) return false;
    return candidates.some((e) => e.deployId === deployId);
  }

  /** Entries for `app` recorded after the one identified by `deployId`, oldest first. */
  laterThan(app: string, deployId: string): LedgerEntry[] {
    const entries = this.entries(app);
    const index = entries.findIndex((e) => e.deployId === deployId);
    if (index === -1) return [];
    return entries.slice(index + 1);
  }

  /**
   * Backup artifacts this ledger recorded for `app`, oldest first — the only ones restore may use.
   * A backup record carries its own release; a release entry that names a backup with no record of
   * its own (written before backups were recorded as they were taken) matches the release before it.
   */
  backupArtifacts(app: string): BackupArtifactRecord[] {
    const out: BackupArtifactRecord[] = [];
    const recorded = new Set<string>();
    let previousRelease: string | null = null;
    for (const { entry } of this.lines) {
      if (appOf(entry) !== app) continue;
      if (entry.kind === 'backup') {
        recorded.add(`${entry.deployId}\u0000${entry.backupArtifact}`);
        out.push({ app, deployId: entry.deployId, backupArtifact: entry.backupArtifact, at: entry.at, release: entry.release });
      } else if (isRelease(entry)) {
        if (entry.backupArtifact !== null && !recorded.has(`${entry.deployId}\u0000${entry.backupArtifact}`)) {
          out.push({ app, deployId: entry.deployId, backupArtifact: entry.backupArtifact, at: entry.at, release: previousRelease });
        }
        previousRelease = entry.deployId;
      }
    }
    return out;
  }

  // ─── Volume archives and prune plans (SHP-ADR-012) ──────────────────────────

  /**
   * The live volume archives — recorded and not since removed by retention — oldest first,
   * optionally for one volume (SHP-REQ-201, SHP-REQ-206). The report's `volumeArchives` and a
   * restore's choice both come from here.
   */
  volumeArchives(volume?: string): VolumeArchiveRecord[] {
    const removed = new Set<string>();
    for (const { entry } of this.lines) if (entry.kind === 'volume-archive-removed') removed.add(entry.archiveId);
    return this.lines.flatMap(({ entry }) =>
      entry.kind === 'volume-archive' && !removed.has(entry.archiveId) && (volume === undefined || entry.volume === volume) ? [entry] : [],
    );
  }

  /** The live archive `archiveId`, or null: a restore's only source (SHP-REQ-202, SHP-D-080). */
  volumeArchive(archiveId: string): VolumeArchiveRecord | null {
    return this.volumeArchives().find((a) => a.archiveId === archiveId) ?? null;
  }

  /** The prune dry run `jobId` recorded, or null (SHP-REQ-205). */
  prunePlan(jobId: string): PrunePlanRecord | null {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const entry = this.lines[i]?.entry;
      if (entry?.kind === 'prune-plan' && entry.jobId === jobId) return entry;
    }
    return null;
  }

  /** Every digest this ledger has ever recorded for `app`, for image pruning. */
  knownDigests(app: string): Set<string> {
    const digests = new Set<string>();
    for (const entry of this.entries(app)) {
      for (const image of entry.images) digests.add(image.digest);
    }
    return digests;
  }

  /**
   * `repo@digest` strings — Docker's own RepoDigests format (SHP-T-5.7; see `disk.ts`, `check.ts`) —
   * for the newest `n` distinct verified *releases* for `app` (SHP-REQ-086). A release is
   * identified by its exact set of image digests, so a rollback entry that re-verifies an earlier
   * release counts as that release being recent again rather than a new one; it does not push the
   * retained count to `n + 1`. Always retains at least one release.
   */
  retainedDigests(app: string, n: number): Set<string> {
    const keep = Math.max(1, n);
    const entries = this.entries(app);
    const repoDigests = new Set<string>();
    const seenReleases: string[] = [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const candidate = entries[i];
      if (!candidate) continue;
      const key = candidate.images
        .map((image) => image.digest)
        .toSorted()
        .join('\u0000');
      if (!seenReleases.includes(key)) {
        if (seenReleases.length >= keep) continue;
        seenReleases.push(key);
      }
      for (const image of candidate.images) repoDigests.add(`${image.repo}@${image.digest}`);
    }
    return repoDigests;
  }
}
