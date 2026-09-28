import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Manifest, refusal } from '@shipyard/schema';
import { describe, expect, it, vi } from 'vitest';
import * as tar from 'tar';

import { withBuildSource } from '../../src/build/source.js';
import { RefusalError } from '../../src/ports.js';
import type { Comparison, GitHubPort } from '../../src/ports.js';

const REPO = 'matdemers1/shipyard';
const SHA = 'a'.repeat(40);
const SHA7 = SHA.slice(0, 7);
const TOP_DIR = `matdemers1-shipyard-${SHA7}`;

function manifest(): Manifest {
  return Manifest.parse({
    name: 'toy',
    repo: REPO,
    workflow: 'ci.yml',
    compose: { files: ['/data/toy/compose.yml'], project: 'toy' },
    services: { app: { image: 'ghcr.io/matdemers1/shipyard/toy' } },
    health: { service: 'app', port: 3000, path: '/health' },
  });
}

function fakeGitHub(overrides: Partial<GitHubPort> = {}): GitHubPort {
  return {
    workflowRuns: vi.fn(() => Promise.resolve([])),
    compare: vi.fn(() => Promise.resolve(null)),
    ...overrides,
  };
}

function comparison(status: Comparison['status']): Comparison {
  return { status, aheadBy: 0, behindBy: 0, commits: [] };
}

function streamFromBuffer(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}

/** Builds a real, safe gzip tarball (via the `tar` package) with the usual GitHub top-level dir. */
async function buildSafeArchive(files: Record<string, string>): Promise<Buffer> {
  const src = await mkdtemp(join(tmpdir(), 'source-test-src-'));
  try {
    const top = join(src, TOP_DIR);
    await import('node:fs/promises').then((fs) => fs.mkdir(top, { recursive: true }));
    const fs = await import('node:fs/promises');
    for (const [name, content] of Object.entries(files)) {
      const full = join(top, name);
      await fs.mkdir(join(full, '..'), { recursive: true });
      await fs.writeFile(full, content);
    }
    const chunks: Buffer[] = [];
    const packStream = tar.create({ cwd: src, gzip: true }, [TOP_DIR]);
    for await (const chunk of packStream as AsyncIterable<Buffer>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally {
    await rm(src, { recursive: true, force: true });
  }
}

// ─── Hand-crafted ustar archives, for entries `tar.c` would refuse to write ──────────────────────

function ustarHeader(opts: { name: string; type: '0' | '1' | '2' | '5'; linkname?: string; size: number }): Buffer {
  const header = Buffer.alloc(512);
  const writeStr = (offset: number, len: number, value: string) => {
    header.write(value, offset, len, 'utf8');
  };
  const writeOctal = (offset: number, len: number, value: number) => {
    const s = value.toString(8).padStart(len - 1, '0');
    header.write(s, offset, len - 1, 'utf8');
    header[offset + len - 1] = 0;
  };
  writeStr(0, 100, opts.name);
  writeOctal(100, 8, 0o644);
  writeOctal(108, 8, 0);
  writeOctal(116, 8, 0);
  writeOctal(124, 12, opts.size);
  writeOctal(136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156); // checksum field spaces for computation
  header[156] = opts.type.charCodeAt(0);
  writeStr(157, 100, opts.linkname ?? '');
  writeStr(257, 6, 'ustar');
  header[263] = 0;
  writeStr(263, 2, '00');
  writeStr(265, 32, 'root');
  writeStr(297, 32, 'root');

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i] ?? 0;
  const checksum = sum.toString(8).padStart(6, '0');
  header.write(`${checksum}\0 `, 148, 8, 'utf8');
  return header;
}

function padTo512(buf: Buffer): Buffer {
  const rem = buf.length % 512;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(512 - rem)]);
}

/** A raw ustar archive with one entry, gzipped. `type`: '0' file, '1' hardlink, '2' symlink, '5' dir. */
function craftArchive(entry: { name: string; type: '0' | '1' | '2' | '5'; linkname?: string; content?: string }): Buffer {
  const data = Buffer.from(entry.content ?? '');
  const header = ustarHeader({
    name: entry.name,
    type: entry.type,
    ...(entry.linkname === undefined ? {} : { linkname: entry.linkname }),
    size: entry.type === '0' ? data.length : 0,
  });
  const dataBlock = entry.type === '0' ? padTo512(data) : Buffer.alloc(0);
  const eof = Buffer.alloc(1024);
  const raw = Buffer.concat([header, dataBlock, eof]);
  return gzipSync(raw);
}

async function expectRefusal(promise: Promise<unknown>): Promise<RefusalError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(RefusalError);
    return err as RefusalError;
  }
  throw new Error('expected a RefusalError but the promise resolved');
}

async function withScratchRoot<T>(fn: (scratchRoot: string) => Promise<T>): Promise<T> {
  const scratchRoot = await mkdtemp(join(tmpdir(), 'source-test-root-'));
  try {
    return await fn(scratchRoot);
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

describe('withBuildSource — SHP-REQ-149 unknown app', () => {
  it('refuses before any GitHub call', async () => {
    await withScratchRoot(async (scratchRoot) => {
      const compare = vi.fn(() => Promise.resolve(null));
      const tarball = vi.fn();
      const github = fakeGitHub({ compare, tarball });
      const err = await expectRefusal(
        withBuildSource({ manifests: new Map(), app: 'ghost', sha: SHA, github, scratchRoot }, () => Promise.resolve(undefined)),
      );
      expect(err.refusal.code).toBe('unknown_app');
      expect(compare).not.toHaveBeenCalled();
      expect(tarball).not.toHaveBeenCalled();
    });
  });
});

describe('withBuildSource — SHP-REQ-115 on-branch gate', () => {
  it.each(['behind', 'diverged'] as const)('refuses when compare reports %s', async (status) => {
    await withScratchRoot(async (scratchRoot) => {
      const tarball = vi.fn();
      const github = fakeGitHub({ compare: () => Promise.resolve(comparison(status)), tarball });
      const manifests = new Map([['toy', manifest()]]);
      const err = await expectRefusal(withBuildSource({ manifests, app: 'toy', sha: SHA, github, scratchRoot }, () => Promise.resolve(undefined)));
      expect(err.refusal.code).toBe('not_on_default_branch');
      expect(tarball).not.toHaveBeenCalled();
    });
  });

  it('refuses when compare returns null (unknown SHA)', async () => {
    await withScratchRoot(async (scratchRoot) => {
      const tarball = vi.fn();
      const github = fakeGitHub({ compare: () => Promise.resolve(null), tarball });
      const manifests = new Map([['toy', manifest()]]);
      const err = await expectRefusal(withBuildSource({ manifests, app: 'toy', sha: SHA, github, scratchRoot }, () => Promise.resolve(undefined)));
      expect(err.refusal.code).toBe('not_on_default_branch');
      expect(tarball).not.toHaveBeenCalled();
    });
  });

  it.each(['ahead', 'identical'] as const)('accepts when compare reports %s', async (status) => {
    await withScratchRoot(async (scratchRoot) => {
      const archive = await buildSafeArchive({ 'Dockerfile': 'FROM scratch\n' });
      const github = fakeGitHub({
        compare: () => Promise.resolve(comparison(status)),
        tarball: () => Promise.resolve(streamFromBuffer(archive)),
      });
      const manifests = new Map([['toy', manifest()]]);
      const result = await withBuildSource({ manifests, app: 'toy', sha: SHA, github, scratchRoot }, async (dir) => {
        const content = await readFile(join(dir, 'Dockerfile'), 'utf8');
        return content;
      });
      expect(result).toContain('FROM scratch');
    });
  });

  it('propagates a github_unreachable refusal thrown by the port unchanged', async () => {
    await withScratchRoot(async (scratchRoot) => {
      const thrown = new RefusalError(refusal('github_unreachable', 'GitHub is unreachable: boom'));
      const tarball = vi.fn();
      const github = fakeGitHub({
        compare: () => Promise.reject(thrown),
        tarball,
      });
      const manifests = new Map([['toy', manifest()]]);
      const err = await expectRefusal(withBuildSource({ manifests, app: 'toy', sha: SHA, github, scratchRoot }, () => Promise.resolve(undefined)));
      expect(err).toBe(thrown);
      expect(tarball).not.toHaveBeenCalled();
    });
  });
});

describe('withBuildSource — extraction safety (SHP-REQ-116)', () => {
  it('strips the top-level <owner>-<repo>-<sha7>/ directory', async () => {
    await withScratchRoot(async (scratchRoot) => {
      const archive = await buildSafeArchive({ 'Dockerfile': 'FROM scratch\n', 'src/app.ts': 'export {};\n' });
      const github = fakeGitHub({
        compare: () => Promise.resolve(comparison('ahead')),
        tarball: () => Promise.resolve(streamFromBuffer(archive)),
      });
      const manifests = new Map([['toy', manifest()]]);
      await withBuildSource({ manifests, app: 'toy', sha: SHA, github, scratchRoot }, async (dir) => {
        expect(await readFile(join(dir, 'Dockerfile'), 'utf8')).toContain('FROM scratch');
        expect(await readFile(join(dir, 'src/app.ts'), 'utf8')).toContain('export');
      });
    });
  });

  it('rejects a `../` path-traversal entry', async () => {
    await withScratchRoot(async (scratchRoot) => {
      const archive = craftArchive({ name: `${TOP_DIR}/../../evil.txt`, type: '0', content: 'pwned' });
      const github = fakeGitHub({
        compare: () => Promise.resolve(comparison('ahead')),
        tarball: () => Promise.resolve(streamFromBuffer(archive)),
      });
      const manifests = new Map([['toy', manifest()]]);
      const err = await expectRefusal(withBuildSource({ manifests, app: 'toy', sha: SHA, github, scratchRoot }, () => Promise.resolve(undefined)));
      expect(err.refusal.code).toBe('github_unreachable');
      expect(err.refusal.message.toLowerCase()).toContain('unsafe');
      expect(await readdir(scratchRoot)).toEqual([]);
    });
  });

  it('rejects an absolute-path entry', async () => {
    await withScratchRoot(async (scratchRoot) => {
      const archive = craftArchive({ name: '/etc/evil.txt', type: '0', content: 'pwned' });
      const github = fakeGitHub({
        compare: () => Promise.resolve(comparison('ahead')),
        tarball: () => Promise.resolve(streamFromBuffer(archive)),
      });
      const manifests = new Map([['toy', manifest()]]);
      const err = await expectRefusal(withBuildSource({ manifests, app: 'toy', sha: SHA, github, scratchRoot }, () => Promise.resolve(undefined)));
      expect(err.refusal.code).toBe('github_unreachable');
      expect(await readdir(scratchRoot)).toEqual([]);
    });
  });

  it('rejects a symlink whose target escapes with `../../etc/passwd`', async () => {
    await withScratchRoot(async (scratchRoot) => {
      const archive = craftArchive({ name: `${TOP_DIR}/link`, type: '2', linkname: '../../etc/passwd' });
      const github = fakeGitHub({
        compare: () => Promise.resolve(comparison('ahead')),
        tarball: () => Promise.resolve(streamFromBuffer(archive)),
      });
      const manifests = new Map([['toy', manifest()]]);
      const err = await expectRefusal(withBuildSource({ manifests, app: 'toy', sha: SHA, github, scratchRoot }, () => Promise.resolve(undefined)));
      expect(err.refusal.code).toBe('github_unreachable');
      expect(await readdir(scratchRoot)).toEqual([]);
    });
  });

  it('rejects a symlink whose target is absolute (`/etc/passwd`)', async () => {
    await withScratchRoot(async (scratchRoot) => {
      const archive = craftArchive({ name: `${TOP_DIR}/link`, type: '2', linkname: '/etc/passwd' });
      const github = fakeGitHub({
        compare: () => Promise.resolve(comparison('ahead')),
        tarball: () => Promise.resolve(streamFromBuffer(archive)),
      });
      const manifests = new Map([['toy', manifest()]]);
      const err = await expectRefusal(withBuildSource({ manifests, app: 'toy', sha: SHA, github, scratchRoot }, () => Promise.resolve(undefined)));
      expect(err.refusal.code).toBe('github_unreachable');
      expect(await readdir(scratchRoot)).toEqual([]);
    });
  });

  it('rejects a hardlink whose target escapes the scratch directory', async () => {
    await withScratchRoot(async (scratchRoot) => {
      const archive = craftArchive({ name: `${TOP_DIR}/link`, type: '1', linkname: '../../etc/passwd' });
      const github = fakeGitHub({
        compare: () => Promise.resolve(comparison('ahead')),
        tarball: () => Promise.resolve(streamFromBuffer(archive)),
      });
      const manifests = new Map([['toy', manifest()]]);
      const err = await expectRefusal(withBuildSource({ manifests, app: 'toy', sha: SHA, github, scratchRoot }, () => Promise.resolve(undefined)));
      expect(err.refusal.code).toBe('github_unreachable');
      expect(await readdir(scratchRoot)).toEqual([]);
    });
  });
});

describe('withBuildSource — scratch directory cleanup', () => {
  it('removes the scratch directory after success', async () => {
    await withScratchRoot(async (scratchRoot) => {
      const archive = await buildSafeArchive({ 'Dockerfile': 'FROM scratch\n' });
      const github = fakeGitHub({
        compare: () => Promise.resolve(comparison('ahead')),
        tarball: () => Promise.resolve(streamFromBuffer(archive)),
      });
      const manifests = new Map([['toy', manifest()]]);
      await withBuildSource({ manifests, app: 'toy', sha: SHA, github, scratchRoot }, () => Promise.resolve(undefined));
      expect(await readdir(scratchRoot)).toEqual([]);
    });
  });

  it('removes the scratch directory after `use` throws', async () => {
    await withScratchRoot(async (scratchRoot) => {
      const archive = await buildSafeArchive({ 'Dockerfile': 'FROM scratch\n' });
      const github = fakeGitHub({
        compare: () => Promise.resolve(comparison('ahead')),
        tarball: () => Promise.resolve(streamFromBuffer(archive)),
      });
      const manifests = new Map([['toy', manifest()]]);
      await expect(
        withBuildSource({ manifests, app: 'toy', sha: SHA, github, scratchRoot }, () => {
          throw new Error('use blew up');
        }),
      ).rejects.toThrow('use blew up');
      expect(await readdir(scratchRoot)).toEqual([]);
    });
  });

  it('removes the scratch directory after an unsafe archive', async () => {
    await withScratchRoot(async (scratchRoot) => {
      const archive = craftArchive({ name: '/etc/evil.txt', type: '0', content: 'pwned' });
      const github = fakeGitHub({
        compare: () => Promise.resolve(comparison('ahead')),
        tarball: () => Promise.resolve(streamFromBuffer(archive)),
      });
      const manifests = new Map([['toy', manifest()]]);
      await expectRefusal(withBuildSource({ manifests, app: 'toy', sha: SHA, github, scratchRoot }, () => Promise.resolve(undefined)));
      expect(await readdir(scratchRoot)).toEqual([]);
    });
  });

  it('removes the scratch directory after a stream error mid-extraction', async () => {
    await withScratchRoot(async (scratchRoot) => {
      const partial = gzipSync(Buffer.from('not a complete tar stream'));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(partial.subarray(0, Math.max(1, partial.length - 2))));
          controller.error(new Error('connection reset'));
        },
      });
      const github = fakeGitHub({
        compare: () => Promise.resolve(comparison('ahead')),
        tarball: () => Promise.resolve(stream),
      });
      const manifests = new Map([['toy', manifest()]]);
      const err = await expectRefusal(withBuildSource({ manifests, app: 'toy', sha: SHA, github, scratchRoot }, () => Promise.resolve(undefined)));
      expect(err.refusal.code).toBe('github_unreachable');
      expect(await readdir(scratchRoot)).toEqual([]);
    });
  });
});

describe('withBuildSource — never invokes git', () => {
  it('the module source contains no child_process import', async () => {
    const source = await readFile(new URL('../../src/build/source.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/child_process/);
    expect(source).not.toMatch(/\bgit\b\s*\(/);
  });
});
