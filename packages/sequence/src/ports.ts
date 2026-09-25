import type { Digest, Manifest, Refusal } from '@shipyard/schema';

/**
 * The deploy engine's seams (SHP-P-1). Everything that touches the world — GitHub, GHCR, Docker,
 * the disk, the clock — sits behind one of these interfaces, so the state machine and the gates are
 * pure enough to test with fakes, and the agent and the host CLI drive the same code (SHP-D-012).
 *
 * Adapters live in `src/adapters/`; the engine never imports an adapter directly.
 */

/** A refusal thrown out of an adapter or gate; the machine turns it into the deploy's result. */
export class RefusalError extends Error {
  constructor(readonly refusal: Refusal) {
    super(`${refusal.code}: ${refusal.message}`);
    this.name = 'RefusalError';
  }
}

// ─── GitHub (SHP-T-1.2) ──────────────────────────────────────────────────────

export interface WorkflowRun {
  id: number;
  headSha: string;
  /** Workflow file path as GitHub reports it, e.g. `.github/workflows/ci.yml`. */
  path: string;
  status: string;
  /** `success`, `failure`, `cancelled`, … or null while running. */
  conclusion: string | null;
  event: string;
  headBranch: string | null;
}

export type CompareStatus = 'ahead' | 'behind' | 'identical' | 'diverged';

export interface Comparison {
  status: CompareStatus;
  aheadBy: number;
  behindBy: number;
  /** Commits in base..head, oldest first. */
  commits: { sha: string; message: string }[];
}

/**
 * Read-only GitHub access. Every method throws `RefusalError(github_unreachable)` on a network
 * error, a 5xx, or a rate limit: forward gates fail closed (SHP-D-086).
 */
export interface GitHubPort {
  /** Runs of the named workflow file (e.g. `ci.yml`) for exactly this head SHA, newest first. */
  workflowRuns(repo: string, workflow: string, headSha: string): Promise<WorkflowRun[]>;
  /** `GET /repos/{repo}/compare/{base}...{head}`. A 404 (unknown SHA) returns null. */
  compare(repo: string, base: string, head: string): Promise<Comparison | null>;
}

// ─── Registry (SHP-T-1.3) ────────────────────────────────────────────────────

export interface ImageConfig {
  digest: Digest;
  labels: Record<string, string>;
}

/**
 * Anonymous registry access for public images (SHP-D-043). Throws `RefusalError(ghcr_unreachable)`
 * when the registry cannot be reached.
 */
export interface RegistryPort {
  /** The manifest digest for `repo:tag` (the `Docker-Content-Digest` header), or null if absent. */
  resolveDigest(imageRepo: string, tag: string): Promise<Digest | null>;
  /** The image config's labels for a digest (for amd64 when the digest is an index). */
  imageConfig(imageRepo: string, digest: Digest): Promise<ImageConfig>;
}

// ─── Docker (SHP-T-1.6) ──────────────────────────────────────────────────────

export interface ComposeTarget {
  files: string[];
  project: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunningContainer {
  id: string;
  service: string;
  /** `repo@sha256:…` entries from the image's RepoDigests. */
  repoDigests: string[];
  /** The image's labels (from the image, not the container). */
  labels: Record<string, string>;
  state: string;
  networks: string[];
  /** When the container last started (ISO). A change between two looks means it restarted. */
  startedAt?: string;
  /** Docker's restart count for the container. */
  restartCount?: number;
}

export interface HealthResponse {
  httpStatus: number;
  body: unknown;
}

/**
 * Docker access. Compose operations go through the pinned `docker compose` v5 CLI and **every**
 * invocation carries explicit `-f` and `-p` (SHP-T-1.6); dockerode is for inspect and networks only.
 * Arguments are argv arrays, never a shell string.
 */
export interface DockerPort {
  /** `docker compose -f … -p … <args>`. Never throws on a non-zero exit; returns it. */
  compose(target: ComposeTarget, args: string[], options?: { timeoutMs?: number }): Promise<ExecResult>;
  /** Containers of the compose project, optionally one service. */
  containers(target: ComposeTarget, service?: string): Promise<RunningContainer[]>;
  /**
   * GET `http://<service>:<port><path>` over the app's own network (SHP-D-056), leaving no network
   * attached afterwards. Resolves with the response, or rejects on a connection error or timeout.
   */
  probeHealth(target: ComposeTarget, service: string, port: number, path: string, timeoutMs: number): Promise<HealthResponse>;
  /** Free bytes on the Docker root filesystem. */
  freeBytes(): Promise<number>;
  /** Local image references (`repo@digest` / `repo:tag`) for a repository, with sizes and creation. */
  images(imageRepo: string): Promise<{ id: string; repoTags: string[]; repoDigests: string[]; created: number; size: number }[]>;
  removeImage(id: string): Promise<void>;
}

// ─── Filesystem & clock ──────────────────────────────────────────────────────

export interface FsPort {
  readFile(path: string): Promise<string>;
  /** Atomic: write a temp file beside the target, fsync, rename (SHP-D-020). */
  writeFileAtomic(path: string, content: string): Promise<void>;
  appendLine(path: string, line: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
  /**
   * Files inside a directory, with size and mtime in epoch ms: directly inside it, or with
   * `recursive`, at any depth (backup artifacts some apps nest by date).
   */
  list(dir: string, options?: { recursive?: boolean }): Promise<{ path: string; size: number; mtimeMs: number }[]>;
}

export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

// ─── Logging ─────────────────────────────────────────────────────────────────

/** A pino-compatible subset. Every deploy line carries the deploy ID (SHP-REQ-007). */
export interface Log {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  child(bindings: object): Log;
}

// ─── What the machine needs, together ────────────────────────────────────────

export interface SequencePorts {
  github: GitHubPort;
  registry: RegistryPort;
  docker: DockerPort;
  fs: FsPort;
  clock: Clock;
  log: Log;
}

export type { Manifest };
