import { createHash } from 'node:crypto';

import type { LedgerEntry } from './types.js';
import type { FsPort } from './ports.js';

/**
 * Append-only digest ledger (SHP-T-1.10, SHP-REQ-023). Every digest set the agent verified and
 * deployed is recorded here as a hash-chained JSONL file, so a rollback can be checked against
 * what actually happened (SHP-REQ-051), a restore can be limited to backups the agent itself took
 * (SHP-REQ-085), and a compromised server can only ask for what this chain already allows
 * (SHP-D-080). The chain is verified in full on `open`; any break throws.
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

/** Anything the ledger chain holds: a release (deploy or rollback), a backup, or a restore. */
export type LedgerRecord = LedgerEntry | BackupRecord | RestoreRecord;

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

function validateRecord(entry: LedgerRecord): void {
  if (!entry.app || entry.app.length === 0) throw new LedgerEntryInvalidError('app must not be empty');
  if (!entry.deployId || entry.deployId.length === 0) throw new LedgerEntryInvalidError('deployId must not be empty');
  if (!entry.at || Number.isNaN(Date.parse(entry.at))) throw new LedgerEntryInvalidError(`invalid at: ${entry.at}`);
  if (entry.kind === 'backup') {
    if (!entry.backupArtifact.startsWith('/')) throw new LedgerEntryInvalidError(`backupArtifact must be an absolute path: ${entry.backupArtifact}`);
    if (entry.release !== null && entry.release.length === 0) throw new LedgerEntryInvalidError('release must be null or a deploy ID');
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

    if (!(await fs.exists(path))) {
      return new Ledger(fs, path, []);
    }

    const content = await fs.readFile(path);
    if (content.length === 0) return new Ledger(fs, path, []);

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

    return new Ledger(fs, path, lines);
  }

  /** Validates, chains and appends one entry; serialized against concurrent callers. */
  append(entry: LedgerRecord): Promise<void> {
    try {
      validateRecord(entry);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    const task = this.writeQueue.then(async () => {
      const last = this.lines.at(-1);
      const seq = (last?.seq ?? 0) + 1;
      const prev = last?.hash ?? GENESIS_HASH;
      const hash = computeHash(prev, seq, entry);
      const line: LedgerLine = { seq, prev, entry, hash };
      await this.fs.appendLine(this.path, JSON.stringify(line));
      this.lines.push(line);
    });
    // Keep the queue alive even if this append fails, so later appends still serialize correctly,
    // but let a failure of *this* append reject its own caller.
    this.writeQueue = task.catch(() => undefined);
    return task;
  }

  /** All release entries (deploys and rollbacks) for `app`, oldest first. Backups and restores are not releases. */
  entries(app: string): LedgerEntry[] {
    return this.lines.flatMap((l) => (l.entry.app === app && isRelease(l.entry) ? [l.entry] : []));
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
    return this.lines.flatMap((l) => (l.entry.app === app && l.entry.kind === 'restore' ? [l.entry] : []));
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
      if (entry.app !== app) continue;
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
