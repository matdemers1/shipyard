import { describe, expect, it } from 'vitest';
import type { BuildSettings } from '@shipyard/schema';
import type { BuildKitPort, ExecFileFn, ExecResult } from '@shipyard/sequence';
import { createCacheManager } from '../src/cache.js';

/**
 * SHP-T-7.11: the agent's BuildKit cache manager, with a fake `docker` CLI and a fake
 * `BuildKitPort` — never a real Docker daemon.
 */

const SETTINGS: BuildSettings = { cpus: 2, memoryMb: 4096, cacheCapGb: 20 };
const CHANGED: BuildSettings = { cpus: 4, memoryMb: 8192, cacheCapGb: 50 };

function ok(stdout = ''): ExecResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function fakeExec(handler: (file: string, args: string[]) => ExecResult): ExecFileFn {
  return (file, args) => Promise.resolve(handler(file, args));
}

function fakeBuildkit(overrides: Partial<BuildKitPort> = {}): BuildKitPort & { pruneCalls: number[] } {
  const pruneCalls: number[] = [];
  const base: BuildKitPort & { pruneCalls: number[] } = {
    pruneCalls,
    solve: () => Promise.resolve({ exitCode: 0 }),
    prune: (keepStorageBytes) => {
      pruneCalls.push(keepStorageBytes);
      return Promise.resolve();
    },
    du: () => Promise.resolve({ bytes: 123 }),
  };
  return { ...base, ...overrides };
}

function fakeClock(now: Date) {
  return { now: () => now };
}

const log = { info: () => undefined, warn: () => undefined };

describe('createCacheManager applySettings', () => {
  it('calls docker update with the exact NanoCpus/Memory when limits are new', async () => {
    const calls: { file: string; args: string[] }[] = [];
    const exec = fakeExec((file, args) => {
      calls.push({ file, args });
      if (args[0] === 'ps') return ok('containerid123\n');
      return ok();
    });
    const buildkit = fakeBuildkit();
    const manager = createCacheManager({ buildkit, execFile: exec, log, clock: fakeClock(new Date()) });

    await manager.applySettings(SETTINGS);

    const update = calls.find((c) => c.args[0] === 'update');
    expect(update?.args).toEqual(['update', '--cpus', '2', '--memory', String(4096 * 1024 * 1024), '--memory-swap', String(4096 * 1024 * 1024), 'containerid123']);
  });

  it('does not call docker update again when the settings are unchanged', async () => {
    const calls: { file: string; args: string[] }[] = [];
    const exec = fakeExec((file, args) => {
      calls.push({ file, args });
      if (args[0] === 'ps') return ok('containerid123\n');
      return ok();
    });
    const buildkit = fakeBuildkit();
    const manager = createCacheManager({ buildkit, execFile: exec, log, clock: fakeClock(new Date()) });

    await manager.applySettings(SETTINGS);
    const afterFirst = calls.filter((c) => c.args[0] === 'update').length;
    await manager.applySettings(SETTINGS);
    const afterSecond = calls.filter((c) => c.args[0] === 'update').length;

    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(1);
  });

  it('calls docker update again when the settings changed', async () => {
    const calls: { file: string; args: string[] }[] = [];
    const exec = fakeExec((file, args) => {
      calls.push({ file, args });
      if (args[0] === 'ps') return ok('containerid123\n');
      return ok();
    });
    const buildkit = fakeBuildkit();
    const manager = createCacheManager({ buildkit, execFile: exec, log, clock: fakeClock(new Date()) });

    await manager.applySettings(SETTINGS);
    await manager.applySettings(CHANGED);

    const updates = calls.filter((c) => c.args[0] === 'update');
    expect(updates).toHaveLength(2);
    expect(updates[1]?.args).toContain('4');
  });

  it('never throws when no BuildKit container is found', async () => {
    const exec = fakeExec((_file, args) => (args[0] === 'ps' ? ok('') : ok()));
    const buildkit = fakeBuildkit();
    const manager = createCacheManager({ buildkit, execFile: exec, log, clock: fakeClock(new Date()) });
    await expect(manager.applySettings(SETTINGS)).resolves.toBeUndefined();
    expect(manager.snapshot()?.limitsApplied ?? null).toBeNull();
  });

  it('uses an explicit containerId and skips the docker ps lookup', async () => {
    const calls: { file: string; args: string[] }[] = [];
    const exec = fakeExec((file, args) => {
      calls.push({ file, args });
      return ok();
    });
    const buildkit = fakeBuildkit();
    const manager = createCacheManager({ buildkit, execFile: exec, containerId: 'explicit-id', log, clock: fakeClock(new Date()) });
    await manager.applySettings(SETTINGS);
    expect(calls.some((c) => c.args[0] === 'ps')).toBe(false);
    expect(calls[0]?.args.at(-1)).toBe('explicit-id');
  });
});

describe('createCacheManager garbage collection', () => {
  it('afterBuild prunes with the cap-in-bytes and records the size and time', async () => {
    const exec = fakeExec((_file, args) => (args[0] === 'ps' ? ok('cid\n') : ok()));
    const buildkit = fakeBuildkit();
    const now = new Date('2026-09-28T00:00:00.000Z');
    const manager = createCacheManager({ buildkit, execFile: exec, log, clock: fakeClock(now) });
    await manager.applySettings(SETTINGS);

    await manager.afterBuild();

    expect(buildkit.pruneCalls).toEqual([20 * 1024 ** 3]);
    const snap = manager.snapshot();
    expect(snap?.bytes).toBe(123);
    expect(snap?.capBytes).toBe(20 * 1024 ** 3);
    expect(snap?.lastGcAt).toBe(now.toISOString());
  });

  it('maybeDailyGc runs GC only once the interval has elapsed', async () => {
    const exec = fakeExec((_file, args) => (args[0] === 'ps' ? ok('cid\n') : ok()));
    const buildkit = fakeBuildkit();
    let now = new Date('2026-09-28T00:00:00.000Z');
    const manager = createCacheManager({ buildkit, execFile: exec, log, clock: { now: () => now }, gcIntervalMs: 1000 });
    await manager.applySettings(SETTINGS);
    await manager.afterBuild();
    expect(buildkit.pruneCalls).toHaveLength(1);

    now = new Date(now.getTime() + 500);
    await manager.maybeDailyGc();
    expect(buildkit.pruneCalls).toHaveLength(1);

    now = new Date(now.getTime() + 600);
    await manager.maybeDailyGc();
    expect(buildkit.pruneCalls).toHaveLength(2);
  });

  it('never throws when BuildKit prune fails', async () => {
    const exec = fakeExec((_file, args) => (args[0] === 'ps' ? ok('cid\n') : ok()));
    const buildkit = fakeBuildkit({
      prune: () => Promise.reject(new Error('buildctl unreachable')),
    });
    const manager = createCacheManager({ buildkit, execFile: exec, log, clock: fakeClock(new Date()) });
    await manager.applySettings(SETTINGS);
    await expect(manager.afterBuild()).resolves.toBeUndefined();
  });

  it('snapshot is undefined before any settings have been seen', () => {
    const buildkit = fakeBuildkit();
    const manager = createCacheManager({ buildkit, execFile: fakeExec(() => ok()), log, clock: fakeClock(new Date()) });
    expect(manager.snapshot()).toBeUndefined();
  });
});
