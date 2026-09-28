import { readFile, writeFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBuildKitAdapter, parseDuTotal, parseMetadataDigest, solveArgv } from '../src/adapters/buildkit.js';
import type { ExecFileFn } from '../src/adapters/docker.js';
import { RefusalError } from '../src/ports.js';
import type { ExecResult, SolveRequest } from '../src/ports.js';

const ADDR = 'unix:///run/buildkit/buildkitd.sock';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const DIGEST = `sha256:${'b'.repeat(64)}`;

interface Call {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** A recording fake execFile; `onRun` may write the metadata file like buildctl would. */
function recorder(onRun?: (args: string[]) => Promise<Partial<ExecResult>> | Partial<ExecResult>): { calls: Call[]; execFile: ExecFileFn } {
  const calls: Call[] = [];
  const execFile: ExecFileFn = async (file, args, opts) => {
    calls.push({ file, args: [...args], env: { ...opts.env } });
    const out = onRun ? await onRun(args) : {};
    return { exitCode: 0, stdout: '', stderr: '', ...out };
  };
  return { calls, execFile };
}

function metadataPath(args: string[]): string {
  const i = args.indexOf('--metadata-file');
  const p = args[i + 1];
  if (i === -1 || p === undefined) throw new Error('no --metadata-file');
  return p;
}

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'buildkit-test-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const baseReq: SolveRequest = {
  contextDir: '/scratch/src',
  dockerfile: '/scratch/src/docker/server.Dockerfile',
  target: 'release',
  secrets: [{ id: 'npm_token', src: '/scratch/secrets/npm_token' }],
  labels: { 'org.opencontainers.image.source': 'https://github.com/o/r', 'org.opencontainers.image.revision': SHA },
  push: { ref: `ghcr.io/o/r/server:sha-${SHA}` },
};

describe('solveArgv', () => {
  it('refuses a push ref that could open another --output option, before any argv is built', () => {
    for (const ref of ['ghcr.io/x,push=false:sha-' + 'a'.repeat(40), 'ghcr.io/x=y:sha-' + 'a'.repeat(40), 'ghcr.io/x y:tag', ',name=evil']) {
      expect(() => solveArgv(ADDR, { ...baseReq, push: { ref } }, '/m/meta.json'), ref).toThrow(RefusalError);
    }
  });

  it('builds the exact buildctl argv for a pushed release target', () => {
    expect(solveArgv(ADDR, baseReq, '/m/meta.json')).toEqual([
      '--addr',
      ADDR,
      'build',
      '--frontend',
      'dockerfile.v0',
      '--local',
      'context=/scratch/src',
      '--local',
      'dockerfile=/scratch/src/docker',
      '--opt',
      'filename=server.Dockerfile',
      '--opt',
      'target=release',
      '--opt',
      'label:org.opencontainers.image.revision=' + SHA,
      '--opt',
      'label:org.opencontainers.image.source=https://github.com/o/r',
      '--secret',
      'id=npm_token,src=/scratch/secrets/npm_token',
      '--metadata-file',
      '/m/meta.json',
      '--output',
      `type=image,name=ghcr.io/o/r/server:sha-${SHA},push=true`,
    ]);
  });

  it('has no --output at all for a build-only (test) solve', () => {
    const testReq: SolveRequest = { contextDir: baseReq.contextDir, dockerfile: baseReq.dockerfile, target: 'test', secrets: baseReq.secrets, labels: {} };
    const argv = solveArgv(ADDR, testReq, '/m/meta.json');
    expect(argv).not.toContain('--output');
    expect(argv.some((a) => a.includes('push=true'))).toBe(false);
  });
});

describe('createBuildKitAdapter.solve', () => {
  it('spawns buildctl from an argv array, parses the digest, and cleans the metadata dir', async () => {
    const { calls, execFile } = recorder(async (args) => {
      await writeFile(metadataPath(args), JSON.stringify({ 'containerimage.digest': DIGEST, 'image.name': 'x' }));
      return { stdout: 'line one\nline two\n', stderr: '#1 done\n' };
    });
    const adapter = createBuildKitAdapter({ addr: ADDR, execFile, tmpDir: tmp });
    const logs: string[] = [];
    const result = await adapter.solve(baseReq, (c) => logs.push(c));
    expect(result).toEqual({ exitCode: 0, digest: DIGEST });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe('buildctl');
    expect(calls[0]?.args[0]).toBe('--addr');
    expect(logs).toEqual(['line one\n', 'line two\n', '#1 done\n']);
    expect(await readdir(tmp)).toEqual([]);
  });

  it('returns no digest for malformed or missing metadata, and never reads it on failure', async () => {
    for (const content of ['not json', '{}', JSON.stringify({ 'containerimage.digest': 'sha256:short' }), 'null']) {
      const { execFile } = recorder(async (args) => {
        await writeFile(metadataPath(args), content);
        return {};
      });
      const result = await createBuildKitAdapter({ addr: ADDR, execFile, tmpDir: tmp }).solve(baseReq);
      expect(result).toEqual({ exitCode: 0 });
    }
    const missing = recorder();
    expect(await createBuildKitAdapter({ addr: ADDR, execFile: missing.execFile, tmpDir: tmp }).solve(baseReq)).toEqual({ exitCode: 0 });

    const failing = recorder(async (args) => {
      await writeFile(metadataPath(args), JSON.stringify({ 'containerimage.digest': DIGEST }));
      return { exitCode: 1 };
    });
    expect(await createBuildKitAdapter({ addr: ADDR, execFile: failing.execFile, tmpDir: tmp }).solve(baseReq)).toEqual({ exitCode: 1 });
  });

  it('passes DOCKER_CONFIG via env, never argv', async () => {
    const { calls, execFile } = recorder();
    await createBuildKitAdapter({ addr: ADDR, execFile, tmpDir: tmp, dockerConfigDir: '/data/agent/registry', env: { PATH: '/bin' } }).solve(baseReq);
    expect(calls[0]?.env.DOCKER_CONFIG).toBe('/data/agent/registry');
    expect(calls[0]?.args.join(' ')).not.toContain('/data/agent/registry');
    expect(calls[0]?.args.join(' ')).not.toMatch(/DOCKER_CONFIG|password|auth/i);
  });

  it('does not spawn when the signal is already aborted', async () => {
    const { calls, execFile } = recorder();
    const ac = new AbortController();
    ac.abort();
    const result = await createBuildKitAdapter({ addr: ADDR, execFile, tmpDir: tmp }).solve(baseReq, undefined, ac.signal);
    expect(result.exitCode).not.toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe('prune and du', () => {
  it('prune passes --keep-storage in MB; du parses the Total line', async () => {
    const { calls, execFile } = recorder((args) => (args.includes('du') ? { stdout: 'ID\tRECLAIMABLE\tSIZE\nabc\ttrue\t1.2MB\nShared:\t\t0B\nPrivate:\t\t1.5GB\nReclaimable:\t1.5GB\nTotal:\t\t1.5GB\n' } : {}));
    const adapter = createBuildKitAdapter({ addr: ADDR, execFile, tmpDir: tmp });
    await adapter.prune(5_000_000_000);
    expect(calls[0]?.args).toEqual(['--addr', ADDR, 'prune', '--keep-storage', '5000']);
    expect(await adapter.du()).toEqual({ bytes: 1_500_000_000 });
    expect(calls[1]?.args).toEqual(['--addr', ADDR, 'du']);
  });

  it('refuses step_failed on a non-zero exit', async () => {
    const { execFile } = recorder(() => ({ exitCode: 1, stderr: 'boom' }));
    const adapter = createBuildKitAdapter({ addr: ADDR, execFile, tmpDir: tmp });
    await expect(adapter.prune(0)).rejects.toBeInstanceOf(RefusalError);
    await expect(adapter.du()).rejects.toBeInstanceOf(RefusalError);
  });

  it('parseDuTotal handles units and rejects garbage', () => {
    expect(parseDuTotal('Total:\t0B\n')).toBe(0);
    expect(parseDuTotal('Total: 12.5kB')).toBe(12_500);
    expect(parseDuTotal('Total: 2GiB')).toBe(2 * 1024 ** 3);
    expect(() => parseDuTotal('nothing')).toThrow();
  });
});

describe('parseMetadataDigest', () => {
  it('accepts only a sha256 digest', () => {
    expect(parseMetadataDigest(JSON.stringify({ 'containerimage.digest': DIGEST }))).toBe(DIGEST);
    expect(parseMetadataDigest(JSON.stringify({ 'containerimage.digest': DIGEST.toUpperCase() }))).toBeUndefined();
    expect(parseMetadataDigest('[')).toBeUndefined();
  });
});

describe('SHP-REQ-122: no Docker socket', () => {
  it('the adapter module never references the Docker socket', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(here, '../src/adapters/buildkit.ts'), 'utf-8');
    expect(source).not.toContain('docker.sock');
    expect(source).not.toMatch(/dockerode/i);
  });
});
