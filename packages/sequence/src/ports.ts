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
  /**
   * The run's page on github.com, its start, and — only once `status` is `completed` — its end
   * (SHP-T-13.4, SHP-ADR-007). Optional so existing object-literal fakes need not set them; the
   * adapter always sets them, `null` when GitHub did not say. They come from the run list the
   * commits poll already fetches, so they cost no extra GitHub call.
   */
  url?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

/** One job of a workflow run, as GitHub's jobs endpoint reports it (SHP-T-13.4, SHP-REQ-157). */
export interface WorkflowJob {
  id: number;
  name: string;
  /** `queued`, `in_progress`, `completed`, … */
  status: string;
  /** `success`, `failure`, `cancelled`, `skipped`, … or null until the job completes. */
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  url: string | null;
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
  /**
   * `GET /repos/{repo}/tarball/{sha}` (SHP-T-7.6, SHP-REQ-116): the exact 40-hex SHA's source as
   * GitHub's gzip tarball, streamed. Throws `RefusalError(invalid_request)` if `sha` is not
   * 40 lowercase hex, and `RefusalError(github_unreachable)` if GitHub has no tarball for it (an
   * unknown SHA/repo — a 404) or is otherwise unreachable.
   *
   * Optional so existing fakes of this port (constructed as object literals elsewhere) do not
   * have to implement it; a caller that needs it — `withBuildSource` — refuses with
   * `github_unreachable` when the configured port lacks it.
   */
  tarball?(repo: string, sha: string): Promise<ReadableStream<Uint8Array>>;
  /**
   * `GET /repos/{repo}/actions/runs/{runId}/jobs` (SHP-T-13.4, SHP-REQ-157): the jobs of one
   * workflow run, in GitHub's order. Called only when a person opens a commit page, never from a
   * poll (SHP-REQ-168). A 404 returns an empty list.
   *
   * Optional for the same reason as `tarball`: a caller that needs it — the run route — refuses
   * with `github_unreachable` when the configured port lacks it.
   */
  runJobs?(repo: string, runId: number): Promise<WorkflowJob[]>;
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

/**
 * Any OCI registry, for the tracked services of an adopted stack (SHP-ADR-010, SHP-REQ-194..196):
 * Docker Hub, GHCR, lscr.io or a private one. `image` is the stack manifest's untagged repository
 * (`postgres`, `lscr.io/linuxserver/sonarr`). Throws `RegistryError` — never a `RefusalError` —
 * when the registry cannot answer, so the candidate checker can report it as an error and the
 * update path can refuse `registry_unreachable` (fail closed).
 */
export interface StackRegistryPort {
  /** The manifest digest `image:tag` names now, or null when the registry has no such tag. */
  resolveDigest(image: string, tag: string): Promise<Digest | null>;
  /** Every tag of `image`, following `Link` pagination up to the adapter's page cap. */
  listTags(image: string): Promise<string[]>;
}

/** Why a registry could not answer. `rate_limited` carries how long it asked the caller to wait. */
export class RegistryError extends Error {
  constructor(
    readonly kind: 'unreachable' | 'rate_limited' | 'denied',
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
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

/** What the agent can observe about a Docker network (SHP-T-7.18). */
export interface BuildNetworkInfo {
  name: string;
  /** IPv4/IPv6 subnets from the network's IPAM config. */
  subnets: string[];
  internal: boolean;
  enableIPv6: boolean;
  /** The network's driver options (`com.docker.network.bridge.name`, …). */
  options: Record<string, string>;
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
  /**
   * The healthcheck's status from the container's inspect, `none` when it has no healthcheck. A
   * lifecycle action waits for `healthy` where there is one (SHP-REQ-184). Optional so existing
   * fakes need not set it; absent reads as no healthcheck.
   */
  health?: 'healthy' | 'unhealthy' | 'starting' | 'none';
}

// Container logs and redaction (SHP-ADR-011, SHP-REQ-189, SHP-REQ-190). Read-only Engine calls.

export interface ContainerLogsOptions {
  /** Lines from the end; at most `LOGS_MAX_TAIL`. */
  tail: number;
  /** ISO; only lines from then on. */
  since?: string;
  /** Keep the stream open for new lines until `signal` aborts. */
  follow: boolean;
  /** Aborting ends a followed stream: the iterator finishes without throwing. */
  signal?: AbortSignal;
}

/** One demultiplexed log line, its Docker timestamp split off. Not yet redacted. */
export interface ContainerLogLine {
  stream: 'stdout' | 'stderr';
  /** ISO, from Docker's `timestamps` prefix; null when the line carried none. */
  at: string | null;
  /** Without the timestamp and the line ending. */
  text: string;
  /**
   * True when the line was longer than the decoder holds and was cut: the next line of the same
   * stream continues it. A reader that redacts must carry the end of this piece into the next, so
   * a secret straddling the cut is still matched whole (SHP-REQ-190).
   */
  continues?: boolean;
}

/**
 * What the agent needs from a container's inspect to redact its logs, and nothing more: the Env
 * *values* (never their names, never sent or logged) and compose's project label, which finds
 * the manifest or stack whose env files apply.
 */
export interface ContainerRedactionFacts {
  envValues: string[];
  composeProject: string | null;
}

export interface HealthResponse {
  httpStatus: number;
  body: unknown;
}

// Host inventory reads (SHP-T-14.4, SHP-REQ-175..177). These are plain port types, mapped by the
// adapter from the Engine's list/inspect/df/stats answers. A container's environment, command,
// entrypoint and every label other than compose's project and service stop at the adapter: there
// is no field here that could carry them upstream (SHP-REQ-177).

export interface HostContainerRecord {
  /** The full 64-hex container ID. */
  id: string;
  /** Without Docker's leading slash. */
  name: string;
  /** The image reference the container was created with. */
  image: string;
  /** `sha256:…`: the image the container runs. */
  imageId: string;
  /** Docker's `State` (`running`, `exited`, …). */
  state: string;
  health: 'healthy' | 'unhealthy' | 'starting' | 'none';
  restartCount: number;
  /** ISO. */
  createdAt: string;
  /** ISO; null when it never started or the inspect failed. */
  startedAt: string | null;
  /** Compose's `project` and `service` labels, the only labels that cross this port. */
  compose: { project: string; service: string } | null;
  ports: { privatePort: number; publicPort: number | null; protocol: string; ip: string | null }[];
  mounts: { type: string; volume: string | null; source: string | null; destination: string; readOnly: boolean }[];
  /** IDs of the networks it is attached to, for counting a network's members. */
  networkIds: string[];
}

export interface HostVolumeRecord {
  name: string;
  driver: string;
  /** Compose's project label on the volume, the only label that crosses this port. */
  composeProject: string | null;
  createdAt: string | null;
}

export interface HostImageRecord {
  id: string;
  /** Without `<none>:<none>`. */
  repoTags: string[];
  /** Without `<none>@<none>`. */
  repoDigests: string[];
  sizeBytes: number;
  /** ISO. */
  createdAt: string;
}

export interface HostNetworkRecord {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  composeProject: string | null;
}

/** What `/system/df` says that the inventory needs: volume sizes and Docker's builder cache. */
export interface HostSystemDf {
  /** By volume name; null where Docker reports -1 (it could not compute it). */
  volumeSizes: Record<string, number | null>;
  builderCache: { bytes: number; reclaimableBytes: number };
}

/** One one-shot stats read. CPU is cumulative counters: a percentage needs two samples. */
export interface HostStatsSample {
  /** `cpu_stats.cpu_usage.total_usage`, nanoseconds. */
  cpuTotal: number;
  /** `cpu_stats.system_cpu_usage`, nanoseconds. */
  systemCpu: number;
  onlineCpus: number;
  /** Usage minus page cache (`inactive_file`, else `cache`), as `docker stats` shows it. */
  memoryBytes: number;
  /** Raw `memory_stats.limit`; null when absent. Docker reports host memory when there is no limit. */
  memoryLimitBytes: number | null;
}

/**
 * One record of the Engine's build cache, as `/system/df` lists it (SHP-REQ-205). Its description
 * (which can carry a build command) stops at the adapter: only what a prune decides on crosses.
 */
export interface BuildCacheRecord {
  id: string;
  sizeBytes: number;
  /** ISO; null when the Engine did not say. */
  createdAt: string | null;
  lastUsedAt: string | null;
  inUse: boolean;
}

export interface DockerRootSpace {
  path: string;
  totalBytes: number;
  freeBytes: number;
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
  /**
   * `docker load -i <tar>` semantics (SHP-T-7.18): loads an image tar BuildKit exported as
   * `type=docker`. Never throws on a non-zero exit; returns it.
   *
   * Optional so existing `DockerPort` fakes (object literals constructed elsewhere) do not have to
   * implement it; a caller that needs it — the integration stage — refuses clearly when the
   * configured port lacks it.
   */
  loadImage?(tarPath: string): Promise<ExecResult>;
  /**
   * A network inspect for the build-network preflight (SHP-T-7.18): the network's subnets, internal
   * and IPv6 flags, and driver options, or null on a 404 (the network does not exist).
   *
   * Optional for the same reason as `loadImage`; `verifyBuildNetwork` refuses clearly when absent.
   */
  inspectNetwork?(name: string): Promise<BuildNetworkInfo | null>;

  // Host inventory (SHP-T-14.4): read-only list/inspect/df/stats calls, every one optional for the
  // same reason as `loadImage`. The agent reports no inventory when the configured port lacks them.
  /** Every container Docker knows about, running or not (`all=1`). One that fails its inspect is degraded, not dropped. */
  hostContainers?(): Promise<HostContainerRecord[]>;
  hostVolumes?(): Promise<HostVolumeRecord[]>;
  /** `GET /system/df`: can take tens of seconds on a host with large volumes, so callers cache it. */
  systemDf?(): Promise<HostSystemDf>;
  hostImages?(): Promise<HostImageRecord[]>;
  hostNetworks?(): Promise<HostNetworkRecord[]>;
  /** One one-shot stats sample, or null when the container is gone or Docker returned none. */
  containerStats?(id: string): Promise<HostStatsSample | null>;
  /** Total and free bytes on the Docker root, through the same read-only helper as `freeBytes`. */
  dockerRootSpace?(): Promise<DockerRootSpace>;

  // Logs (SHP-T-15.3): read-only, optional for the same reason; the agent refuses a log read when
  // the configured port lacks either, rather than sending lines it cannot redact.
  /**
   * The container's logs, both streams, demultiplexed, oldest first (`timestamps: true`). Without
   * `follow` it ends after the tail; with it, when `signal` aborts or the container's log ends.
   */
  containerLogs?(id: string, options: ContainerLogsOptions): AsyncIterable<ContainerLogLine>;
  /** The container's Env values and compose project, or null when the Engine does not know the ID. */
  inspectEnv?(id: string): Promise<ContainerRedactionFacts | null>;

  /**
   * `docker pull <repo>@sha256:…` through the pinned CLI (SHP-REQ-197), so a stack update pulls
   * exactly the digest its track resolved to and nothing a tag might point at by then. Never throws
   * on a non-zero exit. Optional for the same reason as `loadImage`; a stack update refuses
   * without it.
   */
  pullImage?(reference: string): Promise<ExecResult>;

  // Volume maintenance and prune (SHP-ADR-012, SHP-T-17.2), optional for the same reason as
  // `loadImage`; a maintenance job refuses without them.
  /**
   * `docker <args…>` through the pinned CLI, argv only and never a shell (non-negotiable 1). The
   * maintenance engine is its only caller and builds every argv from fixed verbs and values it has
   * validated (a volume name, an image ID, a cache record ID). Never throws on a non-zero exit.
   */
  dockerCli?(args: string[], options?: { timeoutMs?: number }): Promise<ExecResult>;
  /**
   * From a container's inspect, what the agent needs about its own: the image it runs (the archive
   * helper's image) and its compose project label (the stack it must never stop). Null when the
   * Engine does not know the container.
   */
  containerIdentity?(id: string): Promise<{ imageId: string; composeProject: string | null } | null>;
  /** The Engine's build cache records (`/system/df`'s BuildCache). */
  buildCacheRecords?(): Promise<BuildCacheRecord[]>;
  /**
   * Removes one build cache record through the Engine's `POST /build/prune` with `all=true` (or the
   * Engine skips a record that is not dangling), its full ID anchored
   * (`id=^<id>$`: the Engine matches `id` as a regular expression, so a bare ID is a prefix).
   */
  pruneBuildCacheRecord?(id: string): Promise<void>;
}

// ─── BuildKit (SHP-T-7.7) ────────────────────────────────────────────────────

/** One build secret handed to BuildKit as a secret mount: an ID and a host file path, never a value. */
export interface BuildSecretMount {
  id: string;
  /** Absolute path of a 0600 file on the agent's host holding the value (SHP-REQ-125). */
  src: string;
}

export interface SolveRequest {
  /** The extracted source directory — BuildKit's `context` local. */
  contextDir: string;
  /** Absolute path of the Dockerfile. */
  dockerfile: string;
  /** The Dockerfile target to build. */
  target: string;
  secrets: BuildSecretMount[];
  /** Image labels (`--opt label:<k>=<v>`). */
  labels: Record<string, string>;
  /** When present, export the image and push it to `ref` (`<repo>:sha-<40hex>`); otherwise build only. */
  push?: { ref: string };
  /**
   * When present, export the image as a docker-loadable tar instead of pushing (SHP-T-7.18):
   * `--output type=docker,name=<name>,dest=<dest>`. Mutually exclusive with `push`.
   */
  dockerTar?: { name: string; dest: string };
}

export interface SolveResult {
  exitCode: number;
  /** The pushed image's manifest digest, parsed from BuildKit's metadata file. Only with `push`. */
  digest?: Digest;
}

/**
 * Rootless BuildKit (SHP-REQ-122): the only seam that runs `buildctl`. The daemon is reached at an
 * address (`unix://…` or `tcp://…`) and never through a Docker socket.
 */
export interface BuildKitPort {
  /** Runs one `buildctl build`. Never throws on a non-zero exit; returns it. */
  solve(req: SolveRequest, onLog?: (chunk: string) => void, signal?: AbortSignal): Promise<SolveResult>;
  /** Prunes the build cache down to `keepStorageBytes`. */
  prune(keepStorageBytes: number): Promise<void>;
  /** Total bytes of the build cache. */
  du(): Promise<{ bytes: number }>;
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
  /**
   * Takes an exclusive cross-process lock named after `path` (a `<path>.lock` guard file), waiting
   * for another holder, and returns its release (SHP-T-6.11). The ledger holds it around every
   * read-verify-append so two processes sharing one ledger file cannot both chain from a stale
   * tail. Optional so single-process in-memory fakes need not implement it; the real adapter does.
   */
  lock?(path: string): Promise<() => Promise<void>>;
}

/**
 * The binary file work a volume archive needs (SHP-REQ-201, SHP-ADR-012), beside `FsPort`'s text
 * files: owner-only directories and files, a durable rename, and a streamed SHA-256. The agent
 * computes the hash and size itself; it never trusts what a helper container says it wrote.
 */
export interface ArchiveFilesPort {
  /** `mkdir -p`; every directory it creates is mode 0700, and one that already existed is left as it is. */
  ensureDir(dir: string): Promise<void>;
  /** Creates an empty file, mode 0600; fails when it exists. */
  createEmpty(path: string): Promise<void>;
  /** fsyncs `tmp`, renames it over `final`, and fsyncs the directory, so the archive survives a crash. */
  commit(tmp: string, final: string): Promise<void>;
  /** The file's SHA-256 (lowercase hex) and size, or null when it does not exist. */
  digest(path: string): Promise<{ sha256: string; sizeBytes: number } | null>;
  /** Removes a file; a file already gone is not an error. */
  remove(path: string): Promise<void>;
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
