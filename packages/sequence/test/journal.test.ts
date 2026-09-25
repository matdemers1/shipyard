import { describe, expect, it, vi } from 'vitest';

import { Journal, recoverInterrupted } from '../src/journal.js';
import type { RecoverPorts } from '../src/journal.js';
import type { Clock, ComposeTarget, DockerPort, ExecResult, FsPort, Log } from '../src/ports.js';

// ─── Fakes ────────────────────────────────────────────────────────────────────

function makeMemoryFs(initial: Record<string, string> = {}): FsPort & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    files,
    readFile(path: string) {
      const content = files.get(path);
      if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`));
      return Promise.resolve(content);
    },
    writeFileAtomic(path: string, content: string) {
      files.set(path, content);
      return Promise.resolve();
    },
    appendLine(path: string, line: string) {
      files.set(path, (files.get(path) ?? '') + line + '\n');
      return Promise.resolve();
    },
    exists(path: string) {
      return Promise.resolve(files.has(path));
    },
    mkdirp(_path: string) {
      return Promise.resolve();
    },
    list(_dir: string) {
      return Promise.resolve([]);
    },
  };
}

function makeClock(startIso = '2026-09-24T00:00:00.000Z'): Clock {
  let now = new Date(startIso);
  return {
    now: () => now,
    sleep: (_ms: number) => {
      now = new Date(now.getTime() + _ms);
      return Promise.resolve();
    },
  };
}

function makeLog(): { log: Log; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const log: Log = {
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: () => log,
  };
  return { log, warn };
}

function makeDocker(): { docker: DockerPort; compose: ReturnType<typeof vi.fn> } {
  const compose = vi.fn((_target: ComposeTarget, _args: string[]): Promise<ExecResult> =>
    Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
  );
  const docker: DockerPort = {
    compose,
    containers: vi.fn(() => Promise.resolve([])),
    probeHealth: vi.fn(() => Promise.resolve({ httpStatus: 200, body: {} })),
    freeBytes: vi.fn(() => Promise.resolve(1_000_000_000)),
    images: vi.fn(() => Promise.resolve([])),
    removeImage: vi.fn(() => Promise.resolve(undefined)),
  };
  return { docker, compose };
}

const START_DETAIL = { historyDeployId: 'dep-1', composeFiles: ['/opt/demo/compose.yaml'], project: 'demo' };

// ─── begin / end ordering ─────────────────────────────────────────────────────

describe('Journal.begin / Journal.end', () => {
  it('resolves only after the append has been written', async () => {
    const fs = makeMemoryFs();
    let resolveAppend: (() => void) | undefined;
    const delayed: FsPort = {
      ...fs,
      appendLine: (path: string, line: string) =>
        new Promise<void>((resolve) => {
          resolveAppend = () => {
            fs.files.set(path, (fs.files.get(path) ?? '') + line + '\n');
            resolve();
          };
        }),
    };
    const journal = new Journal(delayed, 'journal.jsonl', makeClock(), makeLog().log);

    let observedBeforeResolve = false;
    const beginPromise = journal.begin({ deployId: 'dep-1', app: 'demo', step: 'deploy', detail: START_DETAIL });
    // The append hasn't resolved yet: the caller (this test standing in for a step callback)
    // must not observe the write as having happened.
    queueMicrotask(() => {
      observedBeforeResolve = fs.files.get('journal.jsonl') === undefined;
      resolveAppend?.();
    });

    await beginPromise;
    expect(observedBeforeResolve).toBe(true);
    expect(fs.files.get('journal.jsonl')).toContain('"phase":"start"');
  });

  it('writes a JSONL line per call, start then end', async () => {
    const fs = makeMemoryFs();
    const journal = new Journal(fs, 'journal.jsonl', makeClock(), makeLog().log);

    await journal.begin({ deployId: 'dep-1', app: 'demo', step: 'deploy', detail: START_DETAIL });
    await journal.end({ deployId: 'dep-1', app: 'demo', step: 'deploy', detail: { state: 'succeeded' } });

    const entries = await journal.readAll();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ step: 'deploy', phase: 'start', deployId: 'dep-1' });
    expect(entries[1]).toMatchObject({ step: 'deploy', phase: 'end', deployId: 'dep-1' });
  });
});

// ─── readAll ──────────────────────────────────────────────────────────────────

describe('Journal.readAll', () => {
  it('returns an empty array when the journal file does not exist', async () => {
    const fs = makeMemoryFs();
    const journal = new Journal(fs, 'journal.jsonl', makeClock(), makeLog().log);
    expect(await journal.readAll()).toEqual([]);
  });

  it('ignores a torn last line and warns, without throwing', async () => {
    const fs = makeMemoryFs();
    const journal = new Journal(fs, 'journal.jsonl', makeClock(), makeLog().log);
    await journal.begin({ deployId: 'dep-1', app: 'demo', step: 'deploy', detail: START_DETAIL });
    // Simulate a crash mid-append: a partial JSON line with no trailing newline.
    fs.files.set('journal.jsonl', (fs.files.get('journal.jsonl') ?? '') + '{"deployId":"dep-1","step":"swap","phase":"sta');

    const { log, warn } = makeLog();
    const journal2 = new Journal(fs, 'journal.jsonl', makeClock(), log);
    const entries = await journal2.readAll();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.step).toBe('deploy');
    expect(warn).toHaveBeenCalled();
  });
});

// ─── pendingSync / cursor ─────────────────────────────────────────────────────

describe('Journal cursor / pendingSync', () => {
  it('reports entries appended since a given cursor', async () => {
    const fs = makeMemoryFs();
    const journal = new Journal(fs, 'journal.jsonl', makeClock(), makeLog().log);

    await journal.begin({ deployId: 'dep-1', app: 'demo', step: 'deploy', detail: START_DETAIL });
    const afterFirst = await journal.cursor();
    expect(afterFirst).toBe(1);

    await journal.begin({ deployId: 'dep-1', app: 'demo', step: 'swap' });
    await journal.end({ deployId: 'dep-1', app: 'demo', step: 'swap' });

    const { entries, cursor } = await journal.pendingSync(afterFirst);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ step: 'swap', phase: 'start' });
    expect(cursor).toBe(3);
  });
});

// ─── unfinished ───────────────────────────────────────────────────────────────

describe('Journal.unfinished', () => {
  it('finds a deploy interrupted mid-step and not a completed one', async () => {
    const fs = makeMemoryFs();
    const journal = new Journal(fs, 'journal.jsonl', makeClock(), makeLog().log);

    // dep-1: interrupted mid-swap.
    await journal.begin({ deployId: 'dep-1', app: 'demo', step: 'deploy', detail: START_DETAIL });
    await journal.begin({ deployId: 'dep-1', app: 'demo', step: 'backup' });
    await journal.end({ deployId: 'dep-1', app: 'demo', step: 'backup' });
    await journal.begin({ deployId: 'dep-1', app: 'demo', step: 'swap' });
    // (crash here, no end for swap, no end for deploy)

    // dep-2: completed cleanly.
    await journal.begin({ deployId: 'dep-2', app: 'other', step: 'deploy', detail: { composeFiles: ['/x.yaml'], project: 'other' } });
    await journal.begin({ deployId: 'dep-2', app: 'other', step: 'swap' });
    await journal.end({ deployId: 'dep-2', app: 'other', step: 'swap' });
    await journal.end({ deployId: 'dep-2', app: 'other', step: 'deploy', detail: { state: 'succeeded' } });

    const unfinished = await journal.unfinished();
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0]).toMatchObject({ deployId: 'dep-1', app: 'demo', lastStep: 'swap' });
    expect(unfinished[0]?.detail).toEqual(START_DETAIL);
  });
});

// ─── recoverInterrupted ────────────────────────────────────────────────────────

describe('recoverInterrupted', () => {
  async function primeInterrupted(
    fs: FsPort & { files: Map<string, string> },
    journal: Journal,
    deployId: string,
    app: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await journal.begin({ deployId, app, step: 'deploy', detail });
    await journal.begin({ deployId, app, step: 'swap' });
  }

  it('restores history and runs "up -d" with the recorded files and project, marking the deploy interrupted', async () => {
    const fs = makeMemoryFs({
      '/opt/demo/compose.yaml': 'services:\n  app:\n    image: repo:new\n',
      '/history/dep-1/manifest.json': JSON.stringify({
        deployId: 'dep-1',
        files: [{ original: '/opt/demo/compose.yaml', copy: '/history/dep-1/0-compose.yaml' }],
      }),
      '/history/dep-1/0-compose.yaml': 'services:\n  app:\n    image: repo:old\n',
    });
    const journal = new Journal(fs, 'journal.jsonl', makeClock(), makeLog().log);
    const detail = { historyDeployId: 'dep-1', composeFiles: ['/opt/demo/compose.yaml'], project: 'demo' };
    await primeInterrupted(fs, journal, 'dep-1', 'demo', detail);

    const { docker, compose } = makeDocker();
    const ports: RecoverPorts = { fs, docker, log: makeLog().log, clock: makeClock() };

    const results = await recoverInterrupted(ports, journal, { historyDir: '/history' });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ deployId: 'dep-1', app: 'demo', upExitCode: 0, lastStep: 'swap' });
    expect(results[0]?.restored).toEqual(['/opt/demo/compose.yaml']);
    expect(fs.files.get('/opt/demo/compose.yaml')).toBe('services:\n  app:\n    image: repo:old\n');

    expect(compose).toHaveBeenCalledWith(
      { files: ['/opt/demo/compose.yaml'], project: 'demo' },
      ['up', '-d', '--remove-orphans'],
    );

    const entries = await journal.readAll();
    const deployEnd = entries.find((e) => e.step === 'deploy' && e.phase === 'end');
    expect(deployEnd?.detail).toEqual({ state: 'failed', interrupted: true, lastStep: 'swap' });

    // No longer unfinished.
    expect(await journal.unfinished()).toEqual([]);
  });

  it('ends the deploy cleanly when there is no history (compose files were never rewritten)', async () => {
    const fs = makeMemoryFs({ '/opt/demo/compose.yaml': 'services:\n  app:\n    image: repo:new\n' });
    const journal = new Journal(fs, 'journal.jsonl', makeClock(), makeLog().log);
    const detail = { historyDeployId: 'dep-1', composeFiles: ['/opt/demo/compose.yaml'], project: 'demo' };
    await primeInterrupted(fs, journal, 'dep-1', 'demo', detail);

    const { docker, compose } = makeDocker();
    const ports: RecoverPorts = { fs, docker, log: makeLog().log, clock: makeClock() };

    const results = await recoverInterrupted(ports, journal, { historyDir: '/history' });

    expect(results).toHaveLength(1);
    expect(results[0]?.restored).toEqual([]);
    expect(results[0]?.upExitCode).toBe(0);
    expect(compose).toHaveBeenCalledTimes(1);

    const entries = await journal.readAll();
    const deployEnd = entries.find((e) => e.step === 'deploy' && e.phase === 'end');
    expect(deployEnd?.detail).toMatchObject({ state: 'failed', interrupted: true });
  });

  it('recovers the other app when one app\'s restore throws', async () => {
    const fs = makeMemoryFs({
      '/opt/demo/compose.yaml': 'services:\n  app:\n    image: repo:new\n',
      '/history/dep-bad/manifest.json': 'not json {{{',
      '/opt/other/compose.yaml': 'services:\n  app:\n    image: repo:new\n',
      '/history/dep-good/manifest.json': JSON.stringify({
        deployId: 'dep-good',
        files: [{ original: '/opt/other/compose.yaml', copy: '/history/dep-good/0-compose.yaml' }],
      }),
      '/history/dep-good/0-compose.yaml': 'services:\n  app:\n    image: repo:old\n',
    });
    const journal = new Journal(fs, 'journal.jsonl', makeClock(), makeLog().log);
    await primeInterrupted(fs, journal, 'dep-bad', 'demo', {
      historyDeployId: 'dep-bad',
      composeFiles: ['/opt/demo/compose.yaml'],
      project: 'demo',
    });
    await primeInterrupted(fs, journal, 'dep-good', 'other', {
      historyDeployId: 'dep-good',
      composeFiles: ['/opt/other/compose.yaml'],
      project: 'other',
    });

    const { docker } = makeDocker();
    const ports: RecoverPorts = { fs, docker, log: makeLog().log, clock: makeClock() };

    const results = await recoverInterrupted(ports, journal, { historyDir: '/history' });

    expect(results).toHaveLength(2);
    const bad = results.find((r) => r.deployId === 'dep-bad');
    const good = results.find((r) => r.deployId === 'dep-good');
    expect(bad?.error).toBeDefined();
    expect(good?.error).toBeUndefined();
    expect(good?.restored).toEqual(['/opt/other/compose.yaml']);
    expect(fs.files.get('/opt/other/compose.yaml')).toBe('services:\n  app:\n    image: repo:old\n');
  });

  it('is idempotent: a second run does not double-restore because the first ended the deploy', async () => {
    const fs = makeMemoryFs({
      '/opt/demo/compose.yaml': 'services:\n  app:\n    image: repo:new\n',
      '/history/dep-1/manifest.json': JSON.stringify({
        deployId: 'dep-1',
        files: [{ original: '/opt/demo/compose.yaml', copy: '/history/dep-1/0-compose.yaml' }],
      }),
      '/history/dep-1/0-compose.yaml': 'services:\n  app:\n    image: repo:old\n',
    });
    const journal = new Journal(fs, 'journal.jsonl', makeClock(), makeLog().log);
    const detail = { historyDeployId: 'dep-1', composeFiles: ['/opt/demo/compose.yaml'], project: 'demo' };
    await primeInterrupted(fs, journal, 'dep-1', 'demo', detail);

    const { docker, compose } = makeDocker();
    const ports: RecoverPorts = { fs, docker, log: makeLog().log, clock: makeClock() };

    const first = await recoverInterrupted(ports, journal, { historyDir: '/history' });
    expect(first).toHaveLength(1);

    const second = await recoverInterrupted(ports, journal, { historyDir: '/history' });
    expect(second).toHaveLength(0);
    expect(compose).toHaveBeenCalledTimes(1);
  });

  describe('a contract release (SHP-REQ-017) is never auto-rolled back on restart', () => {
    const HISTORY = {
      '/opt/demo/compose.yaml': 'services:\n  app:\n    image: repo:new\n',
      '/history/dep-1/manifest.json': JSON.stringify({
        deployId: 'dep-1',
        files: [{ original: '/opt/demo/compose.yaml', copy: '/history/dep-1/0-compose.yaml' }],
      }),
      '/history/dep-1/0-compose.yaml': 'services:\n  app:\n    image: repo:old\n',
    };
    const IMAGES = [{ service: 'app', repo: 'repo', digest: `sha256:${'2'.repeat(64)}`, migration: 'contract' }];

    it.each(['check', 'soak', 'swap', 'migrate'])('killed mid-%s: ends failed + interrupted + contract, leaves compose and containers alone', async (lastStep) => {
      const fs = makeMemoryFs(HISTORY);
      const journal = new Journal(fs, 'journal.jsonl', makeClock(), makeLog().log);
      await journal.begin({ deployId: 'dep-1', app: 'demo', step: 'deploy', detail: START_DETAIL });
      await journal.begin({ deployId: 'dep-1', app: 'demo', step: 'verify' });
      await journal.end({ deployId: 'dep-1', app: 'demo', step: 'verify', detail: { gates: [], contract: true, images: IMAGES } });
      await journal.begin({ deployId: 'dep-1', app: 'demo', step: lastStep });

      const [unfinished] = await journal.unfinished();
      expect(unfinished?.detail).toMatchObject({ ...START_DETAIL, contract: true, images: IMAGES });

      const { docker, compose } = makeDocker();
      const results = await recoverInterrupted({ fs, docker, log: makeLog().log, clock: makeClock() }, journal, { historyDir: '/history' });

      expect(results).toEqual([{ deployId: 'dep-1', app: 'demo', restored: [], upExitCode: null, lastStep, contract: true }]);
      expect(compose).not.toHaveBeenCalled();
      expect(fs.files.get('/opt/demo/compose.yaml')).toBe(HISTORY['/opt/demo/compose.yaml']);
      const entries = await journal.readAll();
      expect(entries.find((e) => e.step === 'deploy' && e.phase === 'end')?.detail).toEqual({ state: 'failed', interrupted: true, contract: true, lastStep });
      expect(entries.some((e) => e.step === 'recover')).toBe(false);
      expect(await journal.unfinished()).toEqual([]);
    });

    it('a verified non-contract release is still rolled back', async () => {
      const fs = makeMemoryFs(HISTORY);
      const journal = new Journal(fs, 'journal.jsonl', makeClock(), makeLog().log);
      await journal.begin({ deployId: 'dep-1', app: 'demo', step: 'deploy', detail: START_DETAIL });
      await journal.end({ deployId: 'dep-1', app: 'demo', step: 'verify', detail: { gates: [], contract: false, images: [{ ...IMAGES[0], migration: null }] } });
      await journal.begin({ deployId: 'dep-1', app: 'demo', step: 'soak' });

      const { docker, compose } = makeDocker();
      const [result] = await recoverInterrupted({ fs, docker, log: makeLog().log, clock: makeClock() }, journal, { historyDir: '/history' });

      expect(result).toMatchObject({ restored: ['/opt/demo/compose.yaml'], upExitCode: 0, lastStep: 'soak' });
      expect(result?.contract).toBeUndefined();
      expect(compose).toHaveBeenCalledTimes(1);
      expect(fs.files.get('/opt/demo/compose.yaml')).toBe('services:\n  app:\n    image: repo:old\n');
    });
  });
});
