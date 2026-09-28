import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { refusal } from '@shipyard/schema';
import type { Digest } from '@shipyard/schema';

import { RefusalError } from '../ports.js';
import type { BuildKitPort, SolveRequest, SolveResult } from '../ports.js';
import { runArgv } from './docker.js';
import type { ExecFileFn } from './docker.js';

/**
 * BuildKit adapter (SHP-T-7.7). Every build goes through the `buildctl` client talking to a rootless
 * `buildkitd` at an explicit address (SHP-REQ-122) — a unix socket inside the BuildKit container's
 * shared volume, or a TCP address on the agent's network. The host's container-engine socket is never
 * mounted, referenced, or passed. Processes are spawned from argv arrays only, never a shell.
 *
 * Build-only (the test target): no `--output` flag at all. buildctl then solves the target and keeps
 * the result in its cache without exporting anything, which is exactly "build but do not push"
 * (SHP-REQ-120). A release target adds `--output type=image,name=<ref>,push=true` (SHP-REQ-127).
 *
 * Secrets are `--secret id=<id>,src=<path>` only — a path to a 0600 file, never a value
 * (SHP-REQ-125, SHP-REQ-126). Registry credentials come from `DOCKER_CONFIG` in the child's env,
 * never argv.
 *
 * `execFile` returns once the process exits, so `onLog` receives the output line by line after the
 * process ends rather than live.
 */

export interface BuildKitAdapterOptions {
  /** e.g. `unix:///run/buildkit/buildkitd.sock` or `tcp://buildkitd:1234`. */
  addr: string;
  /** Default `buildctl`. */
  buildctlBin?: string;
  execFile?: ExecFileFn;
  /** Where the per-solve metadata directory is created. Default `os.tmpdir()`. */
  tmpDir?: string;
  /** Directory holding a registry `config.json`; passed as `DOCKER_CONFIG` in the child's env. */
  dockerConfigDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Per-solve timeout. Default none. */
  timeoutMs?: number;
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** The exact `buildctl` argv for one solve (exported for tests). */
/**
 * What may appear inside BuildKit's comma-separated `--output` value: an image reference and tag,
 * nothing that could close the `name=` field and open another option (`,`, `=`, whitespace).
 * The manifest schema already refuses such a repository; this is the adapter's own check.
 */
const OUTPUT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/;

export function solveArgv(addr: string, req: SolveRequest, metadataFile: string): string[] {
  if (req.push !== undefined && !OUTPUT_REF_RE.test(req.push.ref)) {
    throw new RefusalError(
      refusal('invalid_request', `The image reference '${req.push.ref}' is not a plain repository:tag`, 'Fix the service image in the manifest.'),
    );
  }
  const argv = [
    '--addr',
    addr,
    'build',
    '--frontend',
    'dockerfile.v0',
    '--local',
    `context=${req.contextDir}`,
    '--local',
    `dockerfile=${dirname(req.dockerfile)}`,
    '--opt',
    `filename=${basename(req.dockerfile)}`,
    '--opt',
    `target=${req.target}`,
  ];
  for (const key of Object.keys(req.labels).sort()) {
    argv.push('--opt', `label:${key}=${req.labels[key] ?? ''}`);
  }
  for (const secret of req.secrets) {
    argv.push('--secret', `id=${secret.id},src=${secret.src}`);
  }
  argv.push('--metadata-file', metadataFile);
  if (req.push !== undefined) {
    argv.push('--output', `type=image,name=${req.push.ref},push=true`);
  }
  return argv;
}

/** `containerimage.digest` from a buildctl metadata file's JSON, or undefined when absent or malformed. */
export function parseMetadataDigest(text: string): Digest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const digest = (parsed as Record<string, unknown>)['containerimage.digest'];
  return typeof digest === 'string' && DIGEST_RE.test(digest) ? digest : undefined;
}

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

/** Bytes from the `Total:` line of `buildctl du` (e.g. `Total:  1.23GB`). Throws when absent. */
export function parseDuTotal(output: string): number {
  const match = /^Total:\s+([\d.]+)\s*([a-zA-Z]*)\s*$/m.exec(output);
  const value = Number(match?.[1]);
  const unit = UNITS[(match?.[2] ?? 'b').toLowerCase() || 'b'];
  if (match === null || !Number.isFinite(value) || unit === undefined) {
    throw new Error(`unexpected buildctl du output: ${JSON.stringify(output.slice(-200))}`);
  }
  return Math.round(value * unit);
}

function emitLines(text: string, onLog: (chunk: string) => void): void {
  for (const line of text.split('\n')) {
    if (line.length > 0) onLog(`${line}\n`);
  }
}

export function createBuildKitAdapter(options: BuildKitAdapterOptions): BuildKitPort {
  const bin = options.buildctlBin ?? 'buildctl';
  const execFile = options.execFile ?? runArgv;
  const root = options.tmpDir ?? tmpdir();

  const childEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
    delete env.BUILDKIT_HOST;
    if (options.dockerConfigDir !== undefined) env.DOCKER_CONFIG = options.dockerConfigDir;
    return env;
  };

  const run = (args: string[]) =>
    execFile(bin, args, options.timeoutMs === undefined ? { env: childEnv() } : { env: childEnv(), timeoutMs: options.timeoutMs });

  return {
    async solve(req, onLog, signal): Promise<SolveResult> {
      if (signal?.aborted === true) return { exitCode: 130 };
      const metaDir = await mkdtemp(join(root, 'shipyard-buildctl-'));
      try {
        const metadataFile = join(metaDir, 'meta.json');
        const result = await run(solveArgv(options.addr, req, metadataFile));
        if (onLog !== undefined) {
          emitLines(result.stdout, onLog);
          emitLines(result.stderr, onLog);
        }
        if (result.exitCode !== 0 || req.push === undefined) return { exitCode: result.exitCode };
        let text: string;
        try {
          text = await readFile(metadataFile, 'utf-8');
        } catch {
          return { exitCode: result.exitCode };
        }
        const digest = parseMetadataDigest(text);
        return digest === undefined ? { exitCode: result.exitCode } : { exitCode: result.exitCode, digest };
      } finally {
        await rm(metaDir, { recursive: true, force: true });
      }
    },

    async prune(keepStorageBytes) {
      // buildctl's --keep-storage is in MB.
      const mb = Math.max(0, Math.floor(keepStorageBytes / 1e6));
      const result = await run(['--addr', options.addr, 'prune', '--keep-storage', String(mb)]);
      if (result.exitCode !== 0) {
        throw new RefusalError(refusal('step_failed', `buildctl prune exited ${result.exitCode}: ${result.stderr.slice(-500)}`));
      }
    },

    async du() {
      const result = await run(['--addr', options.addr, 'du']);
      if (result.exitCode !== 0) {
        throw new RefusalError(refusal('step_failed', `buildctl du exited ${result.exitCode}: ${result.stderr.slice(-500)}`));
      }
      return { bytes: parseDuTotal(result.stdout) };
    },
  };
}
