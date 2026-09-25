import type { DeployTargetState, Digest, Manifest, Refusal } from '@shipyard/schema';

/**
 * Shared engine types (SHP-P-1). The concrete modules own their logic; these shapes are how they
 * talk to each other, fixed up front so the modules can be built in parallel.
 */

/** OCI labels the engine reads from a verified image. */
export const LABEL_REVISION = 'org.opencontainers.image.revision';
/** `contract` marks a release whose migration breaks the previous image (SHP-D-057). */
export const LABEL_MIGRATION = 'dev.d3cloud.shipyard.migration';
/** The schema revision the release expects /health to report (optional). */
export const LABEL_SCHEMA = 'dev.d3cloud.shipyard.schema';
/** Comma-separated env variable names an image requires at runtime, read for G9 (SHP-REQ-082). */
export const LABEL_ENV = 'dev.d3cloud.shipyard.env';

export type DeployKind = 'deploy' | 'rollback';

/** What was asked for. The only request data that reaches the host: an app and a 40-hex SHA. */
export interface DeployRequest {
  deployId: string;
  kind: DeployKind;
  app: string;
  sha: string;
  dryRun: boolean;
  /** Free-text requester label, for logs and lock refusals only. */
  requesterLabel: string;
  /** A group promotion's expected digests per service (SHP-D-047); a mismatch refuses. */
  expectDigests?: Record<string, Digest>;
}

/** One service's image as verified. */
export interface VerifiedImage {
  service: string;
  /** Untagged repository, e.g. `ghcr.io/matdemers1/foreman/server`. */
  repo: string;
  sha: string;
  digest: Digest;
  /** `repo:sha-<sha>@<digest>` — the literal written to compose (SHP-D-026). */
  reference: string;
  labels: Record<string, string>;
  /** Value of `dev.d3cloud.shipyard.migration`, if any. */
  migration: string | null;
}

/** The live state of an app, as the engine reads it from Docker and the ledger. */
export interface LiveState {
  /** The SHA of the last ledger entry for this app, or null when never deployed by Shipyard. */
  sha: string | null;
  /** service → digest actually running now (null when not running). */
  running: Record<string, Digest | null>;
}

// ─── Gates (SHP-T-1.4) ───────────────────────────────────────────────────────

export type GateId = 'G5' | 'G6' | 'G7' | 'G8' | 'G9' | 'G10' | 'disk';

export interface GateResult {
  gate: GateId;
  pass: boolean;
  /** Short human reason, shown on the dry-run sheet. */
  reason: string;
  /** Present when `pass` is false. */
  refusal?: Refusal;
}

/**
 * Everything the gates decide on, gathered beforehand by the machine through the ports.
 * The evaluator is a pure function of this (golden decision tables, SHP-T-1.4).
 */
export interface GateFacts {
  kind: DeployKind;
  sha: string;
  manifest: Manifest;
  live: LiveState;
  /** Runs of the manifest's workflow for `sha`. Undefined for a rollback (G5 skipped). */
  workflowRuns?: { conclusion: string | null; status: string }[];
  /** compare(sha...defaultBranch). null = SHA unknown to GitHub. Undefined for rollback. */
  onDefaultBranch?: { status: 'ahead' | 'behind' | 'identical' | 'diverged' } | null;
  /** compare(liveSha...sha). null when there is no live SHA yet. Undefined for rollback. */
  aheadOfLive?: { status: 'ahead' | 'behind' | 'identical' | 'diverged' } | null;
  /** service → resolved digest for sha-<sha>, or null when the tag is missing. */
  digests: Record<string, Digest | null>;
  /** Env names present on the host (names only, never values). Undefined = not checked. */
  envNamesPresent?: string[];
  /**
   * Required env names declared per mapped service by its image's `dev.d3cloud.shipyard.env`
   * label (G9, SHP-REQ-082). service -> valid declared names. Undefined = not gathered (e.g. a
   * rollback, which never re-derives this from the deploy path).
   */
  declaredEnv?: Record<string, string[]>;
  /** Migration labels of ledger releases *after* the rollback target (rollback only, G10). */
  laterMigrationLabels?: (string | null)[];
  freeBytes: number;
}

// ─── Journal (SHP-T-1.9) & ledger (SHP-T-1.10) ───────────────────────────────

export interface JournalEntry {
  deployId: string;
  app: string;
  step: string;
  phase: 'start' | 'end';
  at: string;
  argv?: string[];
  exitCode?: number;
  /** Redacted, truncated (last 50 lines). Absent for backup/restore (SHP-D-082). */
  output?: string;
  /** Any structured detail the step wants recorded (e.g. the compose history path). */
  detail?: Record<string, unknown>;
}

export interface LedgerEntry {
  app: string;
  deployId: string;
  kind: DeployKind;
  sha: string;
  images: { service: string; repo: string; digest: Digest; migration: string | null }[];
  /** Absolute path of the backup artifact this deploy took, if any. */
  backupArtifact: string | null;
  at: string;
}

// ─── Machine (SHP-T-1.8) ─────────────────────────────────────────────────────

export interface StepRecord {
  name: string;
  state: DeployTargetState;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  output?: string;
}

export interface DeployResult {
  deployId: string;
  app: string;
  /** Terminal: succeeded | failed | rolled_back | refused | cancelled. */
  state: DeployTargetState;
  sha: string;
  images: VerifiedImage[];
  schemaRevision: string | null;
  gates: GateResult[];
  refusal: Refusal | null;
  steps: StepRecord[];
  backupArtifact: string | null;
}

/** Progress callback: the agent turns these into journal syncs; the CLI prints them. */
export type ProgressListener = (event: { deployId: string; state: DeployTargetState; step?: string; detail?: string }) => void;
