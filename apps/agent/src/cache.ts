import type { AgentBuildCache, BuildSettings } from '@shipyard/schema';
import {
  DEFAULT_GC_INTERVAL_MS,
  capBytes,
  dueForGc,
  limitsChanged,
  runArgv,
  toHostConfigLimits,
  type BuildKitPort,
  type ExecFileFn,
} from '@shipyard/sequence';

/**
 * The BuildKit container's CPU/memory limits and the cache's garbage collection (SHP-T-7.11;
 * SHP-REQ-131, SHP-REQ-132, SHP-REQ-133) — the only place in the agent that touches the BuildKit
 * sidecar's own container, as opposed to the BuildKit daemon it runs (`BuildKitPort`, buildctl).
 *
 * Limits go through the plain `docker` CLI (`docker ps` to find the container by its compose
 * labels, `docker update` to apply them) — argv arrays only, never dockerode and never a shell, the
 * same discipline every other Docker-touching call in this repo follows. Garbage collection goes
 * through `BuildKitPort.prune`/`du`, the same port every build uses.
 *
 * Never throws into the caller: every failure is logged and leaves the manager's state as it was,
 * so a poll or a finished build is never held up by a BuildKit or Docker problem.
 */

export interface CacheLog {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface CacheManagerOptions {
  buildkit: BuildKitPort;
  /** Default `docker`. */
  dockerBin?: string;
  execFile?: ExecFileFn;
  env?: NodeJS.ProcessEnv;
  dockerHost?: string;
  /**
   * The BuildKit sidecar's compose project/service labels (`docs/install/buildkit.compose.yml`),
   * or an explicit container ID/name (`BUILDKIT_CONTAINER`) that skips the label lookup entirely.
   */
  containerId?: string;
  composeProject?: string;
  composeService?: string;
  log: CacheLog;
  clock: { now(): Date };
  gcIntervalMs?: number;
}

export interface CacheManager {
  /** Applies `settings`' CPU/memory to the BuildKit container when they differ from what is applied. */
  applySettings(settings: BuildSettings): Promise<void>;
  /** Prunes the cache to the last-applied cap and refreshes the size; call after every build. */
  afterBuild(): Promise<void>;
  /** Runs GC only if a day (or `gcIntervalMs`) has passed since the last one. */
  maybeDailyGc(): Promise<void>;
  /** What the next `AgentReport` should carry, or undefined before any settings have ever been seen. */
  snapshot(): AgentBuildCache | undefined;
}

const DEFAULT_PROJECT = 'shipyard-buildkit';
const DEFAULT_SERVICE = 'buildkitd';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createCacheManager(opts: CacheManagerOptions): CacheManager {
  const bin = opts.dockerBin ?? 'docker';
  const exec = opts.execFile ?? runArgv;
  const project = opts.composeProject ?? DEFAULT_PROJECT;
  const service = opts.composeService ?? DEFAULT_SERVICE;
  const gcIntervalMs = opts.gcIntervalMs ?? DEFAULT_GC_INTERVAL_MS;

  const env = (): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...(opts.env ?? process.env) };
    if (opts.dockerHost !== undefined) e.DOCKER_HOST = opts.dockerHost;
    return e;
  };

  let appliedLimits: { cpus: number; memoryMb: number } | null = null;
  let capGb = 0;
  let bytes = 0;
  let lastGcAt: string | null = null;
  let everSeen = false;

  async function findContainerId(): Promise<string | null> {
    if (opts.containerId !== undefined) return opts.containerId;
    const result = await exec(
      bin,
      ['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`, '--filter', `label=com.docker.compose.service=${service}`],
      { env: env() },
    );
    if (result.exitCode !== 0) {
      opts.log.warn({ exitCode: result.exitCode, stderr: result.stderr.slice(-500) }, 'could not list the BuildKit container');
      return null;
    }
    const id = result.stdout.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
    return id ?? null;
  }

  async function applySettings(settings: BuildSettings): Promise<void> {
    everSeen = true;
    capGb = settings.cacheCapGb;
    if (!limitsChanged(appliedLimits, settings)) return;
    try {
      const id = await findContainerId();
      if (id === null) {
        opts.log.warn({}, 'no BuildKit container found by its compose labels; cannot apply CPU/memory limits');
        return;
      }
      const limits = toHostConfigLimits(settings);
      const result = await exec(
        bin,
        ['update', '--cpus', String(settings.cpus), '--memory', String(limits.Memory), '--memory-swap', String(limits.MemorySwap), id],
        { env: env() },
      );
      if (result.exitCode !== 0) {
        opts.log.warn({ exitCode: result.exitCode, stderr: result.stderr.slice(-500) }, 'docker update on the BuildKit container failed');
        return;
      }
      appliedLimits = { cpus: settings.cpus, memoryMb: settings.memoryMb };
      opts.log.info({ cpus: settings.cpus, memoryMb: settings.memoryMb }, 'applied BuildKit container CPU/memory limits');
    } catch (err) {
      opts.log.warn({ err: message(err) }, 'could not apply BuildKit container limits');
    }
  }

  async function runGc(): Promise<void> {
    try {
      await opts.buildkit.prune(capBytes(capGb));
      const du = await opts.buildkit.du();
      bytes = du.bytes;
      lastGcAt = opts.clock.now().toISOString();
    } catch (err) {
      opts.log.warn({ err: message(err) }, 'BuildKit cache garbage collection failed');
    }
  }

  return {
    applySettings,
    afterBuild: runGc,
    async maybeDailyGc() {
      if (dueForGc(lastGcAt === null ? null : new Date(lastGcAt), opts.clock.now(), gcIntervalMs)) await runGc();
    },
    snapshot() {
      if (!everSeen) return undefined;
      return { bytes, capBytes: capBytes(capGb), lastGcAt, limitsApplied: appliedLimits === null ? null : { ...appliedLimits } };
    },
  };
}
