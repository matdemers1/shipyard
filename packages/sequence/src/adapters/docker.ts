import { spawn } from 'node:child_process';

import Dockerode from 'dockerode';

import type { ComposeTarget, DockerPort, ExecResult, HealthResponse, RunningContainer } from '../ports.js';

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
}

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

function sleep(ms: number): Promise<'timeout'> {
  return new Promise((r) => {
    setTimeout(() => {
      r('timeout');
    }, ms).unref();
  });
}

// ─── The adapter ─────────────────────────────────────────────────────────────

export function createDockerAdapter(options: DockerAdapterOptions = {}): DockerPort {
  const docker = options.docker ?? dockerodeFor(options.dockerHost);
  const composeBin = options.composeBin ?? 'docker';
  const probeImage = options.probeImage ?? 'busybox:1.37';
  const execFile = options.execFile ?? runArgv;
  const fetchImpl = options.fetch ?? fetch;
  const graceMs = options.probeStartupGraceMs ?? 10_000;
  const warn = options.warn ?? ((): void => undefined);

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
      const info = (await docker.info()) as { DockerRootDir?: string };
      const root = info.DockerRootDir;
      if (root === undefined || root === '') throw new Error('docker info reports no DockerRootDir');
      const mount = '/shipyard-docker-root';
      const run = await runHelper(
        ['df', '-Pk', mount],
        { NetworkMode: 'none', Binds: [`${root}:${mount}:ro`] },
        30_000,
      );
      if (run.exitCode !== 0) throw new Error(`df on ${root} failed (${run.exitCode}): ${run.stderr.trim()}`);
      return parseDfAvailableBytes(run.stdout);
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
  };
}
