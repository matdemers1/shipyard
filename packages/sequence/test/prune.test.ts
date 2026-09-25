import type { Manifest } from '@shipyard/schema';
import { describe, expect, it } from 'vitest';

import { pruneAfterSuccess, type LocalImage } from '../src/disk.js';
import { Ledger } from '../src/ledger.js';
import type { ComposeTarget, DockerPort, ExecResult, FsPort, HealthResponse, Log, RunningContainer } from '../src/ports.js';
import type { LedgerEntry } from '../src/types.js';

/**
 * SHP-T-5.7: end-to-end proof that `pruneAfterSuccess`, fed `Ledger.retainedDigests`, actually
 * retains the manifest's `retainImages` count and nothing more (SHP-REQ-086). `disk.test.ts` and
 * `ledger.test.ts` cover the two halves in isolation; this file wires them together the way
 * `machine.ts` does at the real call site.
 */

const REPO = 'ghcr.io/acme/demo/web';
const GB = 1024 ** 3;

function digest(n: number): string {
  return `sha256:${String(n).repeat(64).slice(0, 64)}`;
}

function memoryFs(): FsPort {
  const files = new Map<string, string>();
  return {
    readFile: (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return Promise.resolve(content);
    },
    writeFileAtomic: (path, content) => {
      files.set(path, content);
      return Promise.resolve();
    },
    appendLine: (path, line) => {
      files.set(path, `${files.get(path) ?? ''}${line}\n`);
      return Promise.resolve();
    },
    exists: (path) => Promise.resolve(files.has(path)),
    mkdirp: () => Promise.resolve(),
    list: () => Promise.resolve([]),
  };
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

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    name: 'demo',
    repo: 'acme/demo',
    defaultBranch: 'main',
    workflow: '.github/workflows/image.yml',
    compose: { files: ['/opt/demo/compose.yaml'], project: 'demo' },
    services: { web: { image: REPO } },
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

function image(id: string, created: number, digestValue: string): LocalImage {
  return { id, repoTags: [], repoDigests: [`${REPO}@${digestValue}`], created, size: 100 };
}

function fakeDocker(opts: { imagesByRepo: Record<string, LocalImage[]>; running?: RunningContainer[]; requestedRepos: string[] }): DockerPort {
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
      return Promise.resolve(100 * GB);
    },
    images(repo: string): Promise<LocalImage[]> {
      opts.requestedRepos.push(repo);
      return Promise.resolve(opts.imagesByRepo[repo] ?? []);
    },
    removeImage(): Promise<void> {
      return Promise.resolve();
    },
  };
}

async function ledgerWithReleases(entries: Partial<LedgerEntry>[]): Promise<Ledger> {
  const ledger = await Ledger.open(memoryFs(), '/data/agent/ledger.jsonl');
  for (const [i, overrides] of entries.entries()) {
    await ledger.append({
      app: 'demo',
      deployId: `dep-${String(i + 1)}`,
      kind: 'deploy',
      sha: 'a'.repeat(40),
      images: [{ service: 'web', repo: REPO, digest: digest(i + 1), migration: null }],
      backupArtifact: null,
      at: '2026-09-25T00:00:00.000Z',
      ...overrides,
    });
  }
  return ledger;
}

describe('pruneAfterSuccess wired to Ledger.retainedDigests (doneWhen: retain-3 leaves three digests)', () => {
  it('with 5 verified releases and retainImages 3, after a success exactly the 3 newest releases\' images remain', async () => {
    const ledger = await ledgerWithReleases([{}, {}, {}, {}, {}]);
    const images = [1, 2, 3, 4, 5].map((n) => image(`img-${String(n)}`, n, digest(n)));
    const requestedRepos: string[] = [];
    const docker = fakeDocker({ imagesByRepo: { [REPO]: images }, requestedRepos });

    const keepDigests = ledger.retainedDigests('demo', 3);
    const { pruned } = await pruneAfterSuccess({ docker, log: noopLog() }, manifest({ retainImages: 3 }), target(), keepDigests);

    expect(pruned.sort()).toEqual(['img-1', 'img-2']);
    const remaining = images.filter((img) => !pruned.includes(img.id));
    expect(remaining.map((img) => img.repoDigests[0])).toEqual(
      expect.arrayContaining([`${REPO}@${digest(3)}`, `${REPO}@${digest(4)}`, `${REPO}@${digest(5)}`]),
    );
    expect(remaining).toHaveLength(3);
  });

  it('never prunes a running image, even one from an old release', async () => {
    const ledger = await ledgerWithReleases([{}, {}, {}, {}, {}]);
    const images = [1, 2, 3, 4, 5].map((n) => image(`img-${String(n)}`, n, digest(n)));
    const running: RunningContainer[] = [{ id: 'c1', service: 'web', repoDigests: [`${REPO}@${digest(1)}`], labels: {}, state: 'running', networks: [] }];
    const docker = fakeDocker({ imagesByRepo: { [REPO]: images }, running, requestedRepos: [] });

    // retainImages 3 would normally keep only releases 3-5, but release 1's image is running.
    const keepDigests = ledger.retainedDigests('demo', 3);
    const { pruned } = await pruneAfterSuccess({ docker, log: noopLog() }, manifest({ retainImages: 3 }), target(), keepDigests);

    expect(pruned).not.toContain('img-1');
    expect(pruned.sort()).toEqual(['img-2']);
  });

  it('leaves other repositories untouched — only the manifest\'s mapped repo is ever queried', async () => {
    const ledger = await ledgerWithReleases([{}, {}]);
    const images = [1, 2].map((n) => image(`img-${String(n)}`, n, digest(n)));
    const requestedRepos: string[] = [];
    const docker = fakeDocker({
      imagesByRepo: { [REPO]: images, 'ghcr.io/other-app/api': [image('foreign', 1, digest(99))] },
      requestedRepos,
    });

    const keepDigests = ledger.retainedDigests('demo', 1);
    const { pruned } = await pruneAfterSuccess({ docker, log: noopLog() }, manifest({ retainImages: 1 }), target(), keepDigests);

    expect(pruned).toEqual(['img-1']);
    expect(requestedRepos).toEqual([REPO]);
  });

  it('a rollback entry re-verifying an older release keeps that release counted as recent', async () => {
    const ledger = await ledgerWithReleases([{}, {}, {}, {}]);
    // Roll back to release 2's exact images.
    await ledger.append({
      app: 'demo',
      deployId: 'dep-rollback',
      kind: 'rollback',
      sha: 'a'.repeat(40),
      images: [{ service: 'web', repo: REPO, digest: digest(2), migration: null }],
      backupArtifact: null,
      at: '2026-09-25T01:00:00.000Z',
    });
    const images = [1, 2, 3, 4].map((n) => image(`img-${String(n)}`, n, digest(n)));
    const requestedRepos: string[] = [];
    const docker = fakeDocker({ imagesByRepo: { [REPO]: images }, requestedRepos });

    // Newest-2 distinct releases after the rollback are release 2 (via dep-rollback) and release 4.
    const keepDigests = ledger.retainedDigests('demo', 2);
    const { pruned } = await pruneAfterSuccess({ docker, log: noopLog() }, manifest({ retainImages: 2 }), target(), keepDigests);

    expect(pruned.sort()).toEqual(['img-1', 'img-3']);
  });
});
