import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import Dockerode from 'dockerode';

import type {
  BuildCacheRecord,
  BuildNetworkInfo,
  ComposeTarget,
  ContainerLogLine,
  ContainerRedactionFacts,
  DockerPort,
  DockerRootSpace,
  ExecResult,
  HealthResponse,
  HostContainerRecord,
  HostImageRecord,
  HostNetworkRecord,
  HostStatsSample,
  HostSystemDf,
  HostVolumeRecord,
  RunningContainer,
} from '../ports.js';

/**
 * Docker adapter (SHP-T-1.6). Compose goes through the pinned `docker compose` v5 CLI, and every
 * invocation carries explicit `-f` and `-p` (SHP-REQ-027) — there is no code path that builds a
 * compose argv without them. Everything else (inspect, networks, the probe and `df` helper
 * containers) goes through dockerode. Processes are spawned from argv arrays only, never a shell
 * (SHP-REQ-020).
 *
 * The health probe joins the app's own network for the check and leaves it afterwards
 * (SHP-REQ-024): inside a container the agent connects itself to the network and disconnects in a
 * `finally`; outside one it runs a throwaway busybox `wget` on that network and removes it.
 */

/** Output kept per stream; the tail is what matters when a compose step fails. */
export const OUTPUT_CAP_BYTES = 1024 * 1024;
/** Exit code reported when a compose invocation is killed for running past its timeout. */
export const TIMEOUT_EXIT_CODE = 124;

export type ExecFileFn = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<ExecResult>;

export interface DockerAdapterOptions {
  docker?: Dockerode;
  /** e.g. `tcp://127.0.0.1:2375` or `unix:///var/run/docker.sock`; passed to compose as DOCKER_HOST. */
  dockerHost?: string;
  /** The Docker CLI that hosts the compose plugin. Default `docker`. */
  composeBin?: string;
  env?: NodeJS.ProcessEnv;
  /** The agent's own container ID when it runs in a container; selects the network-join probe. */
  selfContainerId?: string;
  /** Helper image for the probe container and `df`. Default `busybox:1.37`. */
  probeImage?: string;
  execFile?: ExecFileFn;
  fetch?: typeof fetch;
  /** Slack on top of the probe timeout for creating and starting the helper container. Default 10s. */
  probeStartupGraceMs?: number;
  /** Called when a non-fatal problem is swallowed (an image in use, or already gone). */
  warn?: (message: string, detail: Record<string, unknown>) => void;
  /** Per-call limit on the inventory's inspect and stats reads (SHP-T-14.4). Default 5s. */
  hostCallTimeoutMs?: number;
}

/** How many inspect or stats reads the inventory has in flight at once. */
export const HOST_READ_CONCURRENCY = 8;

// ─── Process runner ──────────────────────────────────────────────────────────

/** Keeps the last `cap` bytes written to it. */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.cap && this.chunks.length > 0) {
      const head = this.chunks[0];
      if (head === undefined) break;
      const excess = this.size - this.cap;
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size -= excess;
      }
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/**
 * Runs `file args…` without a shell. Captures the tail of stdout/stderr (1 MiB each), kills the
 * process on timeout (SIGTERM, then SIGKILL after 5s) and reports exit code 124. Never rejects:
 * a spawn failure (e.g. ENOENT) is exit code 127 with the error on stderr.
 */
export function runArgv(
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs?: number; capBytes?: number },
): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    const cap = options.capBytes ?? OUTPUT_CAP_BYTES;
    const stdout = new TailBuffer(cap);
    const stderr = new TailBuffer(cap);
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolvePromise({ exitCode, stdout: stdout.toString(), stderr: stderr.toString() });
    };

    const child = spawn(file, args, { env: options.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on('error', (err) => {
      stderr.push(Buffer.from(`${err.message}\n`));
      finish(127);
    });
    child.on('close', (code, signal) => {
      if (timedOut) finish(TIMEOUT_EXIT_CODE);
      else finish(code ?? (signal === null ? 1 : 128));
    });

    if (options.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          child.kill('SIGKILL');
        }, 5_000);
        killTimer.unref();
      }, options.timeoutMs);
    }
  });
}

// ─── Parsers (exported for tests) ────────────────────────────────────────────

/** The compose argv: `compose -f <file>… -p <project> <args…>`. Throws when files or project is empty. */
export function composeArgv(target: ComposeTarget, args: string[]): string[] {
  assertTarget(target);
  return ['compose', ...target.files.flatMap((f) => ['-f', f]), '-p', target.project, ...args];
}

function assertTarget(target: ComposeTarget): void {
  if (target.files.length === 0 || target.files.some((f) => f.trim() === '')) {
    throw new Error('compose target must name at least one compose file (-f)');
  }
  if (target.project.trim() === '') {
    throw new Error('compose target must name a project (-p)');
  }
}

/** Busybox `wget -S` prints response headers on stderr; the last status line wins (redirects). */
export function parseWgetStatus(stderr: string): number | null {
  const matches = [...stderr.matchAll(/HTTP\/[\d.]+ (\d{3})/g)];
  const last = matches.at(-1)?.[1];
  return last === undefined ? null : Number(last);
}

/** Available bytes from POSIX `df -Pk <path>` output (the data row's 4th column, in KiB). */
export function parseDfAvailableBytes(output: string): number {
  const lines = output
    .trim()
    .split('\n')
    .filter((l) => l.trim() !== '');
  const row = lines.at(-1);
  if (lines.length < 2 || row === undefined) throw new Error(`unexpected df output: ${JSON.stringify(output)}`);
  // Count from the right: a filesystem name may contain spaces, the mount point here does not.
  const fields = row.trim().split(/\s+/);
  const available = Number(fields.at(-3));
  if (fields.length < 6 || !Number.isFinite(available) || available < 0) {
    throw new Error(`unexpected df row: ${JSON.stringify(row)}`);
  }
  return available * 1024;
}

/**
 * Total and available bytes from POSIX `df -Pk <path>` output (columns 2 and 4 of the data row,
 * in KiB). Counts from the right for the same reason as `parseDfAvailableBytes`.
 */
export function parseDfSpace(output: string): { totalBytes: number; availableBytes: number } {
  const lines = output
    .trim()
    .split('\n')
    .filter((l) => l.trim() !== '');
  const row = lines.at(-1);
  if (lines.length < 2 || row === undefined) throw new Error(`unexpected df output: ${JSON.stringify(output)}`);
  const fields = row.trim().split(/\s+/);
  const total = Number(fields.at(-5));
  const available = Number(fields.at(-3));
  if (fields.length < 6 || !Number.isFinite(total) || !Number.isFinite(available) || total < 0 || available < 0) {
    throw new Error(`unexpected df row: ${JSON.stringify(row)}`);
  }
  return { totalBytes: total * 1024, availableBytes: available * 1024 };
}

/** Splits Docker's multiplexed (non-TTY) log stream into stdout and stderr. */
export function demuxDockerStream(buf: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const stream = buf.readUInt8(offset);
    const size = buf.readUInt32BE(offset + 4);
    const payload = buf.subarray(offset + 8, offset + 8 + size);
    if (stream === 2) err.push(payload);
    else out.push(payload);
    offset += 8 + size;
  }
  return { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
}

/**
 * A line with no newline is cut here, so one endless line cannot hold the agent's memory. Large on
 * purpose: lines are redacted whole after this, and only a line longer than this is ever cut before
 * redaction (the piece is then flagged `continues`, and the reader carries its end over).
 */
export const MAX_LOG_LINE_CHARS = 1024 * 1024;

const LOG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2}) /;

/**
 * Splits Docker's `timestamps: true` prefix (RFC 3339 with nanoseconds) off a log line. The time
 * is kept to the millisecond, which is what an ISO date carries; a line without one keeps its text.
 */
export function splitLogTimestamp(line: string): { at: string | null; text: string } {
  const m = LOG_TIMESTAMP.exec(line);
  if (m === null) return { at: null, text: line };
  const ms = Date.parse(`${m[1] ?? ''}${(m[2] ?? '').slice(0, 4)}${m[3] ?? ''}`);
  if (Number.isNaN(ms)) return { at: null, text: line };
  return { at: new Date(ms).toISOString(), text: line.slice(m[0].length) };
}

/**
 * Turns the bytes of a container's log stream into lines as they arrive (SHP-T-15.3). A non-TTY
 * container's stream is multiplexed — 8-byte frame headers naming stdout or stderr — and a frame,
 * a UTF-8 character or a line may be split across any two chunks; a TTY container's is raw stdout.
 */
export class DockerLogDecoder {
  private pending: Buffer = Buffer.alloc(0);
  private readonly decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  private readonly partial = { stdout: '', stderr: '' };
  /** The last piece of this stream was a forced cut: the next one has no timestamp of its own. */
  private readonly continuing = { stdout: false, stderr: false };

  constructor(private readonly tty: boolean) {}

  push(chunk: Buffer): ContainerLogLine[] {
    const out: ContainerLogLine[] = [];
    if (this.tty) {
      this.feed('stdout', chunk, out);
      return out;
    }
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    let offset = 0;
    while (offset + 8 <= this.pending.length) {
      const size = this.pending.readUInt32BE(offset + 4);
      if (offset + 8 + size > this.pending.length) break;
      const stream = this.pending.readUInt8(offset) === 2 ? 'stderr' : 'stdout';
      this.feed(stream, this.pending.subarray(offset + 8, offset + 8 + size), out);
      offset += 8 + size;
    }
    this.pending = this.pending.subarray(offset);
    return out;
  }

  /** The stream ended: whatever is left of a line is a line. */
  end(): ContainerLogLine[] {
    const out: ContainerLogLine[] = [];
    for (const stream of ['stdout', 'stderr'] as const) {
      const rest = this.partial[stream] + this.decoders[stream].end();
      this.partial[stream] = '';
      if (rest.length > 0) out.push(this.line(stream, rest));
    }
    return out;
  }

  private feed(stream: 'stdout' | 'stderr', bytes: Buffer, out: ContainerLogLine[]): void {
    let text = this.partial[stream] + this.decoders[stream].write(bytes);
    for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n')) {
      out.push(this.line(stream, text.slice(0, nl)));
      text = text.slice(nl + 1);
    }
    while (text.length > MAX_LOG_LINE_CHARS) {
      out.push(this.line(stream, text.slice(0, MAX_LOG_LINE_CHARS), true));
      text = text.slice(MAX_LOG_LINE_CHARS);
    }
    this.partial[stream] = text;
  }

  private line(stream: 'stdout' | 'stderr', raw: string, cut = false): ContainerLogLine {
    const continuation = this.continuing[stream];
    this.continuing[stream] = cut;
    if (cut) {
      const { at, text } = continuation ? { at: null, text: raw } : splitLogTimestamp(raw);
      return { stream, at, text, continues: true };
    }
    const body = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const { at, text } = continuation ? { at: null, text: body } : splitLogTimestamp(body);
    return { stream, at, text };
  }
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function statusCodeOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'statusCode' in err && typeof err.statusCode === 'number') {
    return err.statusCode;
  }
  return undefined;
}

function dockerodeFor(dockerHost: string | undefined): Dockerode {
  if (dockerHost === undefined) return new Dockerode();
  const url = new URL(dockerHost);
  if (url.protocol === 'unix:') return new Dockerode({ socketPath: url.pathname });
  return new Dockerode({ host: url.hostname, port: Number(url.port || '2375'), protocol: 'http' });
}

/** The compose labels are the only labels the inventory reads (SHP-REQ-177). */
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';

/**
 * What the Engine really sends for the fields the inventory reads. Its JSON omits or nulls many of
 * them (a container with no ports has `Ports: null`; an unpublished port has no `PublicPort`;
 * `Internal` is absent on old networks), which dockerode's types claim are always present.
 */
type RawContainer = Omit<Dockerode.ContainerInfo, 'Labels' | 'Ports' | 'Mounts' | 'NetworkSettings' | 'Status'> & {
  Labels?: Record<string, string> | null;
  Status?: string;
  Ports?: (Omit<Dockerode.Port, 'IP' | 'PublicPort'> & { IP?: string; PublicPort?: number })[] | null;
  Mounts?: (Omit<Dockerode.ContainerInfo['Mounts'][number], 'Name'> & { Name?: string })[] | null;
  NetworkSettings?: { Networks?: Record<string, { NetworkID?: string }> | null } | null;
};
type RawLabelled = { Labels?: Record<string, string> | null };

/** `docker ps`'s Status text carries the healthcheck result when the image has one. */
export function healthFromStatus(status: string | undefined): HostContainerRecord['health'] {
  if (status === undefined) return 'none';
  if (status.includes('(unhealthy)')) return 'unhealthy';
  if (status.includes('(healthy)')) return 'healthy';
  if (status.includes('(health: starting)')) return 'starting';
  return 'none';
}

function healthFromInspect(status: unknown): HostContainerRecord['health'] | undefined {
  return status === 'healthy' || status === 'unhealthy' || status === 'starting' ? status : status === 'none' ? 'none' : undefined;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  // Docker writes the zero time for "never".
  return Number.isNaN(ms) || ms < 0 || value.startsWith('0001-') ? null : new Date(ms).toISOString();
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep the input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} timed out after ${String(ms)}ms`));
    }, ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<'timeout'> {
  return new Promise((r) => {
    setTimeout(() => {
      r('timeout');
    }, ms).unref();
  });
}

// ─── The adapter ─────────────────────────────────────────────────────────────

/**
 * The concrete adapter always implements `loadImage` and `inspectNetwork` (SHP-T-7.18) — they are
 * optional only on `DockerPort` itself, for object-literal fakes elsewhere that predate them.
 */
export function createDockerAdapter(
  options: DockerAdapterOptions = {},
): DockerPort &
  Required<
    Pick<DockerPort, 'loadImage' | 'inspectNetwork' | 'hostContainers' | 'hostVolumes' | 'systemDf' | 'hostImages' | 'hostNetworks' | 'containerStats' | 'dockerRootSpace'>
  > &
  Required<Pick<DockerPort, 'containerLogs' | 'inspectEnv' | 'pullImage'>> &
  Required<Pick<DockerPort, 'dockerCli' | 'containerIdentity' | 'buildCacheRecords' | 'pruneBuildCacheRecord'>> {
  const docker = options.docker ?? dockerodeFor(options.dockerHost);
  const composeBin = options.composeBin ?? 'docker';
  const probeImage = options.probeImage ?? 'busybox:1.37';
  const execFile = options.execFile ?? runArgv;
  const fetchImpl = options.fetch ?? fetch;
  const graceMs = options.probeStartupGraceMs ?? 10_000;
  const warn = options.warn ?? ((): void => undefined);
  const hostCallTimeoutMs = options.hostCallTimeoutMs ?? 5_000;

  const composeEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
    if (options.dockerHost !== undefined) {
      env.DOCKER_HOST = options.dockerHost;
      delete env.DOCKER_CONTEXT;
    }
    return env;
  };

  const ensureImage = async (image: string): Promise<void> => {
    try {
      await docker.getImage(image).inspect();
      return;
    } catch (err) {
      if (statusCodeOf(err) !== 404) throw err;
    }
    const stream = await docker.pull(image);
    await new Promise<void>((res, rej) => {
      docker.modem.followProgress(stream, (err: Error | null) => {
        if (err === null) res();
        else rej(err);
      });
    });
  };

  /**
   * Runs a throwaway helper container to completion and returns its exit code and output. The
   * container is always force-removed before this returns, whether it finished, failed or timed out.
   */
  const runHelper = async (
    cmd: string[],
    hostConfig: Dockerode.HostConfig,
    timeoutMs: number,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    await ensureImage(probeImage);
    const container = await docker.createContainer({
      Image: probeImage,
      Cmd: cmd,
      Tty: false,
      AttachStdout: false,
      AttachStderr: false,
      Labels: { 'dev.d3cloud.shipyard.helper': 'true' },
      HostConfig: { ...hostConfig, AutoRemove: false },
    });
    try {
      await container.start();
      const waited = await Promise.race([
        container.wait() as Promise<{ StatusCode: number }>,
        sleep(timeoutMs),
      ]);
      if (waited === 'timeout') throw new Error(`helper container timed out after ${timeoutMs}ms`);
      const logs = await container.logs({ stdout: true, stderr: true, follow: false });
      return { exitCode: waited.StatusCode, ...demuxDockerStream(Buffer.from(logs)) };
    } finally {
      await container.remove({ force: true });
    }
  };

  /** `df -Pk` on the Docker root, through the read-only helper `freeBytes` has always used. */
  const dfDockerRoot = async (): Promise<{ root: string; output: string }> => {
    const info = (await docker.info()) as { DockerRootDir?: string };
    const root = info.DockerRootDir;
    if (root === undefined || root === '') throw new Error('docker info reports no DockerRootDir');
    const mount = '/shipyard-docker-root';
    const run = await runHelper(['df', '-Pk', mount], { NetworkMode: 'none', Binds: [`${root}:${mount}:ro`] }, 30_000);
    if (run.exitCode !== 0) throw new Error(`df on ${root} failed (${String(run.exitCode)}): ${run.stderr.trim()}`);
    return { root, output: run.stdout };
  };

  const containers = async (target: ComposeTarget, service?: string): Promise<RunningContainer[]> => {
    assertTarget(target);
    const label = [`com.docker.compose.project=${target.project}`];
    if (service !== undefined) label.push(`com.docker.compose.service=${service}`);
    const list = await docker.listContainers({ all: true, filters: { label } });
    return Promise.all(
      list.map(async (c) => {
        const image = await docker.getImage(c.ImageID).inspect();
        const found: RunningContainer = {
          id: c.Id,
          service: c.Labels['com.docker.compose.service'] ?? '',
          repoDigests: image.RepoDigests,
          labels: image.Config.Labels,
          state: c.State,
          networks: Object.keys(c.NetworkSettings.Networks),
        };
        // When it last started and how often Docker restarted it: soak compares these between
        // ticks, so a crash and a restart in between is seen. A container removed since the list
        // simply has neither.
        try {
          const info = await docker.getContainer(c.Id).inspect();
          if (typeof info.State.StartedAt === 'string' && info.State.StartedAt !== '') found.startedAt = info.State.StartedAt;
          if (typeof info.RestartCount === 'number') found.restartCount = info.RestartCount;
          // A lifecycle action waits for `healthy` where the container has a healthcheck (SHP-REQ-184).
          found.health = healthFromInspect(info.State.Health?.Status) ?? 'none';
        } catch (err) {
          if (statusCodeOf(err) !== 404) throw err;
        }
        return found;
      }),
    );
  };

  const serviceNetworks = async (target: ComposeTarget, service: string): Promise<string[]> => {
    const found = await containers(target, service);
    const networks = [...new Set(found.flatMap((c) => c.networks))];
    if (networks.length === 0) {
      throw new Error(`no network found for service ${service} in project ${target.project}`);
    }
    return networks;
  };

  /** In a container: join the service's network, fetch, and always leave what this call joined. */
  const probeFromContainer = async (
    selfId: string,
    networks: string[],
    url: string,
    timeoutMs: number,
  ): Promise<HealthResponse> => {
    const self = await docker.getContainer(selfId).inspect();
    const selfNetworks = Object.keys(self.NetworkSettings.Networks);
    const connected: string[] = [];
    try {
      if (!networks.some((n) => selfNetworks.includes(n))) {
        const network = networks[0] ?? '';
        await docker.getNetwork(network).connect({ Container: selfId });
        connected.push(network);
      }
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      return { httpStatus: res.status, body: parseBody(text) };
    } finally {
      for (const network of connected) {
        await docker.getNetwork(network).disconnect({ Container: selfId, Force: true });
      }
    }
  };

  /** Not in a container: a throwaway busybox `wget` on the service's network. */
  const probeWithHelper = async (network: string, url: string, timeoutMs: number): Promise<HealthResponse> => {
    const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
    const run = await runHelper(
      ['wget', '-q', '-S', '-O', '-', '-T', String(secs), url],
      { NetworkMode: network },
      timeoutMs + graceMs,
    );
    const status = parseWgetStatus(run.stderr);
    if (status === null) {
      throw new Error(`health probe of ${url} got no HTTP response: ${run.stderr.trim().slice(-500)}`);
    }
    return { httpStatus: status, body: parseBody(run.stdout) };
  };

  return {
    async compose(target, args, opts) {
      const argv = composeArgv(target, args);
      const runOpts: { env: NodeJS.ProcessEnv; timeoutMs?: number } = { env: composeEnv() };
      if (opts?.timeoutMs !== undefined) runOpts.timeoutMs = opts.timeoutMs;
      return execFile(composeBin, argv, runOpts);
    },

    containers,

    async probeHealth(target, service, port, path, timeoutMs) {
      const networks = await serviceNetworks(target, service);
      const url = `http://${service}:${port}${path.startsWith('/') ? path : `/${path}`}`;
      if (options.selfContainerId !== undefined && options.selfContainerId !== '') {
        return probeFromContainer(options.selfContainerId, networks, url, timeoutMs);
      }
      return probeWithHelper(networks[0] ?? '', url, timeoutMs);
    },

    async freeBytes() {
      return parseDfAvailableBytes((await dfDockerRoot()).output);
    },

    async images(imageRepo) {
      const byReference = await docker.listImages({ filters: { reference: [imageRepo] } });
      const all = await docker.listImages();
      const prefix = `${imageRepo}@sha256:`;
      const merged = new Map<string, Dockerode.ImageInfo>();
      for (const img of byReference) merged.set(img.Id, img);
      for (const img of all) {
        if ((img.RepoDigests ?? []).some((d) => d.startsWith(prefix))) merged.set(img.Id, img);
      }
      return [...merged.values()].map((img) => ({
        id: img.Id,
        repoTags: (img.RepoTags ?? []).filter((t) => t !== '<none>:<none>'),
        repoDigests: (img.RepoDigests ?? []).filter((d) => d !== '<none>@<none>'),
        created: img.Created,
        size: img.Size,
      }));
    },

    async removeImage(id) {
      try {
        await docker.getImage(id).remove();
      } catch (err) {
        const status = statusCodeOf(err);
        if (status === 409) {
          warn('image in use; not removed', { id });
          return;
        }
        if (status === 404) {
          warn('image already gone', { id });
          return;
        }
        throw err;
      }
    },

    // `docker load -i <tar>` via the pinned CLI (SHP-T-7.18): its port signature mirrors `compose` —
    // an ExecResult that never throws on a non-zero exit — which the CLI gives directly; dockerode's
    // `loadImage` instead resolves a raw response stream with no exit code to report.
    async loadImage(tarPath) {
      return execFile(composeBin, ['load', '-i', tarPath], { env: composeEnv() });
    },

    // A stack update's pull by digest (SHP-REQ-197): the CLI, so it uses the same DOCKER_CONFIG
    // credentials as compose, and an argv with exactly one reference.
    async pullImage(reference) {
      if (reference.startsWith('-') || !/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(reference)) {
        return { exitCode: 2, stdout: '', stderr: `refusing to pull ${reference}: not a repo@sha256 reference` };
      }
      return execFile(composeBin, ['pull', '--quiet', reference], { env: composeEnv(), timeoutMs: 600_000 });
    },

    // Volume maintenance (SHP-ADR-012, SHP-T-17.2): the helper run, `volume rm`, `image rm` and
    // `builder prune` go through the pinned CLI as argv; the reads below are inspect/df only.
    async dockerCli(args, opts) {
      const runOpts: { env: NodeJS.ProcessEnv; timeoutMs?: number } = { env: composeEnv() };
      if (opts?.timeoutMs !== undefined) runOpts.timeoutMs = opts.timeoutMs;
      return execFile(composeBin, args, runOpts);
    },

    async containerIdentity(id) {
      try {
        const info = await docker.getContainer(id).inspect();
        if (typeof info.Image !== 'string' || info.Image === '') return null;
        const labels = (info.Config.Labels as Record<string, string> | null | undefined) ?? {};
        return { imageId: info.Image, composeProject: nonEmpty(labels[COMPOSE_PROJECT_LABEL]) };
      } catch (err) {
        if (statusCodeOf(err) === 404) return null;
        throw err;
      }
    },

    async buildCacheRecords(): Promise<BuildCacheRecord[]> {
      const df = (await docker.df()) as {
        BuildCache?: { ID?: string; Size?: number; CreatedAt?: string | null; LastUsedAt?: string | null; InUse?: boolean }[] | null;
      };
      return (df.BuildCache ?? []).flatMap((entry) =>
        typeof entry.ID !== 'string' || entry.ID === ''
          ? []
          : [
              {
                id: entry.ID,
                sizeBytes: typeof entry.Size === 'number' && entry.Size > 0 ? entry.Size : 0,
                createdAt: isoOrNull(entry.CreatedAt),
                lastUsedAt: isoOrNull(entry.LastUsedAt),
                inUse: entry.InUse === true,
              },
            ],
      );
    },

    async pruneBuildCacheRecord(id) {
      if (!/^[a-z0-9]{1,64}$/.test(id)) throw new Error('not a build cache record ID');
      // The Engine turns an `id` filter into BuildKit's `id~=` (a regular expression): anchored, it
      // matches this record only, never every record whose ID starts with it.
      // Dialled directly: dockerode's own `pruneBuilder` drops its options, which would prune every
      // unused record — never acceptable here.
      await new Promise<void>((resolveDial, rejectDial) => {
        docker.modem.dial(
          {
            path: '/build/prune?',
            method: 'POST',
            options: { filters: { id: [`^${id}$`] } },
            statusCodes: { 200: true, 400: 'bad parameter', 500: 'server error' },
          },
          (err: unknown) => {
            if (err === null || err === undefined) resolveDial();
            else rejectDial(err instanceof Error ? err : new Error('build cache prune failed'));
          },
        );
      });
    },

    async inspectNetwork(name): Promise<BuildNetworkInfo | null> {
      try {
        const info = await docker.getNetwork(name).inspect();
        const config = info.IPAM?.Config ?? [];
        return {
          name: info.Name,
          subnets: config.map((c) => c.Subnet).filter((s): s is string => typeof s === 'string'),
          internal: info.Internal,
          enableIPv6: info.EnableIPv6,
          options: info.Options ?? {},
        };
      } catch (err) {
        if (statusCodeOf(err) === 404) return null;
        throw err;
      }
    },

    // ─── Host inventory (SHP-T-14.4): list, inspect, df and stats reads only ───────────────────
    // Each mapper below names the fields it takes. Env, Cmd, Entrypoint and Labels are never read
    // except compose's two (SHP-REQ-177), so nothing upstream can leak them.

    async hostContainers(): Promise<HostContainerRecord[]> {
      const list = (await docker.listContainers({ all: true })) as unknown as RawContainer[];
      const records = await mapLimit(list, HOST_READ_CONCURRENCY, async (c): Promise<HostContainerRecord | null> => {
        let restartCount = 0;
        let startedAt: string | null = null;
        let health = healthFromStatus(c.Status);
        try {
          const info = await withTimeout(docker.getContainer(c.Id).inspect(), hostCallTimeoutMs, `inspect ${c.Id.slice(0, 12)}`);
          restartCount = typeof info.RestartCount === 'number' ? info.RestartCount : 0;
          startedAt = isoOrNull(info.State.StartedAt);
          health = healthFromInspect(info.State.Health?.Status) ?? health;
        } catch (err) {
          // Removed since the list: it is no longer a container. Anything else degrades this one.
          if (statusCodeOf(err) === 404) return null;
          warn('container inspect failed; reporting it without restart count', { id: c.Id.slice(0, 12), err: err instanceof Error ? err.message : String(err) });
        }
        const project = nonEmpty(c.Labels?.[COMPOSE_PROJECT_LABEL]);
        const service = nonEmpty(c.Labels?.[COMPOSE_SERVICE_LABEL]);
        const seenPorts = new Set<string>();
        const portList: HostContainerRecord['ports'] = [];
        for (const p of c.Ports ?? []) {
          // Drops exact repeats; a port published on both address families stays as two entries.
          const key = `${p.IP ?? ''}|${String(p.PrivatePort)}|${String(p.PublicPort ?? '')}|${p.Type}`;
          if (seenPorts.has(key)) continue;
          seenPorts.add(key);
          portList.push({
            privatePort: p.PrivatePort,
            publicPort: typeof p.PublicPort === 'number' ? p.PublicPort : null,
            protocol: p.Type,
            ip: nonEmpty(p.IP),
          });
        }
        return {
          id: c.Id,
          name: ((c.Names as string[] | undefined)?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''),
          image: c.Image,
          imageId: c.ImageID,
          state: c.State,
          health,
          restartCount,
          createdAt: new Date(c.Created * 1000).toISOString(),
          startedAt,
          compose: project !== null && service !== null ? { project, service } : null,
          ports: portList,
          mounts: (c.Mounts ?? []).map((m) => ({
            type: m.Type,
            volume: m.Type === 'volume' ? nonEmpty(m.Name) : null,
            source: m.Type === 'bind' ? nonEmpty(m.Source) : null,
            destination: m.Destination,
            readOnly: !m.RW,
          })),
          networkIds: Object.values(c.NetworkSettings?.Networks ?? {}).flatMap((n) => (n.NetworkID === undefined || n.NetworkID === '' ? [] : [n.NetworkID])),
        };
      });
      return records.filter((r): r is HostContainerRecord => r !== null);
    },

    async hostVolumes(): Promise<HostVolumeRecord[]> {
      const { Volumes } = (await docker.listVolumes()) as { Volumes?: (Omit<Dockerode.VolumeInspectInfo, 'Labels'> & RawLabelled)[] | null };
      return (Volumes ?? []).map((v) => ({
        name: v.Name,
        driver: v.Driver,
        composeProject: nonEmpty(v.Labels?.[COMPOSE_PROJECT_LABEL]),
        // The Engine's volume JSON has CreatedAt; dockerode's types predate it.
        createdAt: isoOrNull((v as { CreatedAt?: unknown }).CreatedAt),
      }));
    },

    async systemDf(): Promise<HostSystemDf> {
      const df = (await docker.df()) as {
        Volumes?: { Name: string; UsageData?: { Size?: number } | null }[] | null;
        BuildCache?: { Size?: number; InUse?: boolean }[] | null;
      };
      const volumeSizes: Record<string, number | null> = {};
      for (const v of df.Volumes ?? []) {
        const size = v.UsageData?.Size;
        volumeSizes[v.Name] = typeof size === 'number' && size >= 0 ? size : null;
      }
      let bytes = 0;
      let reclaimableBytes = 0;
      for (const entry of df.BuildCache ?? []) {
        const size = typeof entry.Size === 'number' && entry.Size > 0 ? entry.Size : 0;
        bytes += size;
        if (entry.InUse !== true) reclaimableBytes += size;
      }
      return { volumeSizes, builderCache: { bytes, reclaimableBytes } };
    },

    async hostImages(): Promise<HostImageRecord[]> {
      const list = await docker.listImages();
      return list.map((img) => ({
        id: img.Id,
        repoTags: (img.RepoTags ?? []).filter((t) => t !== '<none>:<none>'),
        repoDigests: (img.RepoDigests ?? []).filter((d) => d !== '<none>@<none>'),
        sizeBytes: Math.max(0, img.Size),
        createdAt: new Date(img.Created * 1000).toISOString(),
      }));
    },

    async hostNetworks(): Promise<HostNetworkRecord[]> {
      const list = (await docker.listNetworks()) as (Omit<Dockerode.NetworkInspectInfo, 'Internal'> & RawLabelled & { Internal?: boolean })[];
      return list.map((n) => ({
        id: n.Id,
        name: n.Name,
        driver: n.Driver,
        scope: n.Scope,
        internal: n.Internal ?? false,
        composeProject: nonEmpty(n.Labels?.[COMPOSE_PROJECT_LABEL]),
      }));
    },

    async containerStats(id): Promise<HostStatsSample | null> {
      let stats: Dockerode.ContainerStats;
      try {
        stats = await withTimeout(docker.getContainer(id).stats({ stream: false, 'one-shot': true }), hostCallTimeoutMs, `stats ${id.slice(0, 12)}`);
      } catch (err) {
        if (statusCodeOf(err) === 404) return null;
        throw err;
      }
      const cpu = stats.cpu_stats as { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number } | undefined;
      const memory = stats.memory_stats as { usage?: number; limit?: number; stats?: { inactive_file?: number; cache?: number } } | undefined;
      const total = cpu?.cpu_usage?.total_usage;
      const system = cpu?.system_cpu_usage;
      const usage = memory?.usage;
      if (typeof total !== 'number' || typeof system !== 'number' || typeof usage !== 'number') return null;
      // `docker stats` shows usage without reclaimable page cache: inactive_file on cgroup v2, cache on v1.
      const cache = memory?.stats?.inactive_file ?? memory?.stats?.cache;
      const working = typeof cache === 'number' && cache <= usage ? usage - cache : usage;
      return {
        cpuTotal: total,
        systemCpu: system,
        onlineCpus: typeof cpu?.online_cpus === 'number' && cpu.online_cpus > 0 ? cpu.online_cpus : 1,
        memoryBytes: working,
        memoryLimitBytes: typeof memory?.limit === 'number' && memory.limit > 0 ? memory.limit : null,
      };
    },

    async dockerRootSpace(): Promise<DockerRootSpace> {
      const { root, output } = await dfDockerRoot();
      const space = parseDfSpace(output);
      return { path: root, totalBytes: space.totalBytes, freeBytes: space.availableBytes };
    },

    // ─── Logs (SHP-T-15.3, SHP-ADR-011): read-only, like everything dockerode does here ─────────

    async *containerLogs(id, opts): AsyncGenerator<ContainerLogLine> {
      const container = docker.getContainer(id);
      const info = await container.inspect();
      const decoder = new DockerLogDecoder(info.Config.Tty);
      const sinceMs = opts.since === undefined ? Number.NaN : Date.parse(opts.since);
      const params = {
        stdout: true,
        stderr: true,
        timestamps: true,
        tail: opts.tail,
        ...(Number.isNaN(sinceMs) ? {} : { since: Math.floor(sinceMs / 1000) }),
      };
      if (!opts.follow) {
        const buf = await container.logs({ ...params, follow: false });
        yield* decoder.push(Buffer.from(buf));
        yield* decoder.end();
        return;
      }
      // A function, not the property: the signal flips while the stream is read.
      const aborted = (): boolean => opts.signal?.aborted === true;
      if (aborted()) return;
      const stream = await container.logs({ ...params, follow: true });
      const destroy = (): void => {
        (stream as { destroy?: () => void }).destroy?.();
      };
      opts.signal?.addEventListener('abort', destroy, { once: true });
      try {
        for await (const chunk of stream) {
          yield* decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        yield* decoder.end();
      } catch (err) {
        // Destroying the stream on abort ends the iteration with a premature-close error.
        if (!aborted()) throw err;
      } finally {
        opts.signal?.removeEventListener('abort', destroy);
        destroy();
      }
    },

    async inspectEnv(id): Promise<ContainerRedactionFacts | null> {
      let info: Dockerode.ContainerInspectInfo;
      try {
        info = await docker.getContainer(id).inspect();
      } catch (err) {
        if (statusCodeOf(err) === 404) return null;
        throw err;
      }
      const env = (info.Config.Env as string[] | null | undefined) ?? [];
      const labels = (info.Config.Labels as Record<string, string> | null | undefined) ?? {};
      return {
        // Values only: everything after the first `=`. Names are never needed to redact.
        envValues: env.flatMap((entry) => {
          const eq = entry.indexOf('=');
          return eq === -1 || eq === entry.length - 1 ? [] : [entry.slice(eq + 1)];
        }),
        composeProject: nonEmpty(labels[COMPOSE_PROJECT_LABEL]),
      };
    },
  };
}
