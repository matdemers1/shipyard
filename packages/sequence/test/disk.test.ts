import type { Manifest } from '@shipyard/schema';
import { describe, expect, it } from 'vitest';

import { ensureFreeSpace, pruneAfterSuccess, pruneCandidates, type LocalImage } from '../src/disk.js';
import { evaluateGates } from '../src/gates.js';
import type { ComposeTarget, DockerPort, ExecResult, HealthResponse, Log, RunningContainer } from '../src/ports.js';
import type { GateFacts } from '../src/types.js';

/**
 * SHP-T-1.11: the free-space gate prunes only images Shipyard knows about — the manifest's mapped
 * repositories — before the `disk` gate ever gets to refuse.
 */

const GB = 1024 ** 3;

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    name: 'demo',
    repo: 'acme/demo',
    defaultBranch: 'main',
    workflow: '.github/workflows/image.yml',
    compose: { files: ['/opt/demo/compose.yaml'], project: 'demo' },
    services: { web: { image: 'ghcr.io/acme/demo/web' } },
    health: { service: 'web', port: 3000, path: '/health' },
    soakSeconds: 60,
    approval: 'none',
    diskFloorGb: 5,
    retainImages: 3,
    ...overrides,
  };
}

function target(): ComposeTarget {
  return { files: ['/opt/demo/compose.yaml'], project: 'demo' };
}

function image(id: string, created: number, repoDigests: string[] = [], repoTags: string[] = []): LocalImage {
  return { id, repoTags, repoDigests, created, size: 100 };
}

function noopLog(): Log {
  const log: Log = {
    info() {},
    warn() {},
    error() {},
    child() {
      return log;
    },
  };
  return log;
}

/** A fake DockerPort. `imagesByRepo` is keyed by the exact repo string passed to `images()`. */
function fakeDocker(opts: {
  freeBytesSequence: number[];
  imagesByRepo: Record<string, LocalImage[]>;
  running?: RunningContainer[];
  onRemove?: (id: string) => void | never;
}): DockerPort {
  const sequence = [...opts.freeBytesSequence];
  const removed: string[] = [];
  return {
    compose(_target: ComposeTarget, _args: string[]): Promise<ExecResult> {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    },
    containers(): Promise<RunningContainer[]> {
      return Promise.resolve(opts.running ?? []);
    },
    probeHealth(): Promise<HealthResponse> {
      return Promise.resolve({ httpStatus: 200, body: {} });
    },
    freeBytes(): Promise<number> {
      const next = sequence.length > 1 ? sequence.shift() : sequence[0];
      return Promise.resolve(next ?? 0);
    },
    images(imageRepo: string): Promise<LocalImage[]> {
      return Promise.resolve(opts.imagesByRepo[imageRepo] ?? []);
    },
    removeImage(id: string): Promise<void> {
      removed.push(id);
      opts.onRemove?.(id);
      return Promise.resolve();
    },
  };
}

describe('pruneCandidates', () => {
  it('excludes running images, keepDigests, and everything within the retained newest count', () => {
    const images = [
      image('img-1', 4, ['repo@sha256:1']),
      image('img-2', 3, ['repo@sha256:2']),
      image('img-3', 2, ['repo@sha256:3']),
      image('img-4', 1, ['repo@sha256:4']),
    ];
    const result = pruneCandidates(images, {
      keepDigests: new Set(['repo@sha256:2']),
      runningImageIds: new Set(['img-1']),
      retain: 1,
    });
    // Eligible after excluding running (img-1) and keepDigests (img-2): img-3, img-4.
    // Newest of those (img-3) is retained; img-4 is the only candidate, oldest-first.
    expect(result.map((i) => i.id)).toEqual(['img-4']);
  });

  it('applies the retain count over eligible images, oldest first', () => {
    const images = [image('a', 4), image('b', 3), image('c', 2), image('d', 1)];
    const result = pruneCandidates(images, { keepDigests: new Set(), runningImageIds: new Set(), retain: 2 });
    expect(result.map((i) => i.id)).toEqual(['d', 'c']);
  });

  it('never returns an image outside what it was given (no foreign-repo leakage)', () => {
    const images = [image('own-1', 1, ['acme/demo/web@sha256:1'])];
    const result = pruneCandidates(images, { keepDigests: new Set(), runningImageIds: new Set(), retain: 0 });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('own-1');
  });
});

describe('ensureFreeSpace', () => {
  it('does nothing when already above the floor', async () => {
    const docker = fakeDocker({ freeBytesSequence: [10 * GB], imagesByRepo: {} });
    const result = await ensureFreeSpace({ docker, log: noopLog() }, manifest(), target(), new Set());
    expect(result.freeBytes).toBe(10 * GB);
    expect(result.pruned).toEqual([]);
  });

  it('prunes Shipyard-known images oldest first, stopping as soon as the floor clears', async () => {
    const images = [
      image('new', 3, [], ['ghcr.io/acme/demo/web:sha-new']),
      image('mid', 2, [], ['ghcr.io/acme/demo/web:sha-mid']),
      image('old', 1, [], ['ghcr.io/acme/demo/web:sha-old']),
    ];
    // 3 GB free, floor 5 GB: below floor. Each removal frees 2 GB; after removing "old" alone we
    // clear the floor and must stop there, not touch "mid" or "new".
    const docker = fakeDocker({
      freeBytesSequence: [3 * GB, 5.5 * GB],
      imagesByRepo: { 'ghcr.io/acme/demo/web': images },
    });
    const result = await ensureFreeSpace(
      { docker, log: noopLog() },
      manifest({ diskFloorGb: 5, retainImages: 0 }),
      target(),
      new Set(),
    );
    expect(result.pruned).toEqual(['old']);
    expect(result.freeBytes).toBe(5.5 * GB);
  });

  it('never removes a running image, a ledger-kept digest, or a foreign repo image', async () => {
    const running: RunningContainer[] = [
      { id: 'c1', service: 'web', repoDigests: ['ghcr.io/acme/demo/web@sha256:running'], labels: {}, state: 'running', networks: [] },
    ];
    const images = [
      image('running-img', 4, ['ghcr.io/acme/demo/web@sha256:running']),
      image('kept-img', 3, ['ghcr.io/acme/demo/web@sha256:kept']),
      image('prunable', 1, ['ghcr.io/acme/demo/web@sha256:old']),
    ];
    const foreignImages = [image('foreign-img', 1, ['ghcr.io/other-app/api@sha256:foo'])];
    const docker = fakeDocker({
      freeBytesSequence: [1 * GB],
      imagesByRepo: {
        'ghcr.io/acme/demo/web': images,
        'ghcr.io/other-app/api': foreignImages,
      },
      running,
    });
    const result = await ensureFreeSpace(
      { docker, log: noopLog() },
      manifest({ diskFloorGb: 5, retainImages: 0 }),
      target(),
      new Set(['ghcr.io/acme/demo/web@sha256:kept']),
    );
    expect(result.pruned).toEqual(['prunable']);
  });

  it('feeds a low-disk result into evaluateGates as an insufficient_disk refusal (the doneWhen fixture)', async () => {
    // Even after pruning everything it is allowed to, free space stays below the floor.
    const images = [image('only', 1, [], ['ghcr.io/acme/demo/web:sha-only'])];
    const docker = fakeDocker({
      freeBytesSequence: [1 * GB, 1.2 * GB],
      imagesByRepo: { 'ghcr.io/acme/demo/web': images },
    });
    const m = manifest({ diskFloorGb: 5, retainImages: 0 });
    const { freeBytes } = await ensureFreeSpace({ docker, log: noopLog() }, m, target(), new Set());
    expect(freeBytes).toBeLessThan(m.diskFloorGb * GB);

    const facts: GateFacts = {
      kind: 'deploy',
      sha: 'c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff',
      manifest: m,
      live: { sha: null, running: {} },
      workflowRuns: [{ conclusion: 'success', status: 'completed' }],
      onDefaultBranch: { status: 'identical' },
      aheadOfLive: null,
      digests: { web: 'sha256:1111111111111111111111111111111111111111111111111111111111111111' },
      freeBytes,
    };
    const results = evaluateGates(facts);
    const disk = results.find((r) => r.gate === 'disk');
    expect(disk?.pass).toBe(false);
    expect(disk?.refusal?.code).toBe('insufficient_disk');
  });
});

describe('pruneAfterSuccess', () => {
  it('trims to the retained count regardless of free space', async () => {
    const images = [image('a', 4), image('b', 3), image('c', 2), image('d', 1)];
    const docker = fakeDocker({
      freeBytesSequence: [100 * GB],
      imagesByRepo: { 'ghcr.io/acme/demo/web': images },
    });
    const result = await pruneAfterSuccess({ docker, log: noopLog() }, manifest({ retainImages: 2 }), target(), new Set());
    expect(result.pruned.sort()).toEqual(['c', 'd']);
  });
});
