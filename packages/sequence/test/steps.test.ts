import { describe, expect, it } from 'vitest';

import { runBackup, runExec, runMigrate } from '../src/steps.js';
import { RefusalError } from '../src/ports.js';
import type { Clock, ComposeTarget, DockerPort, ExecResult, FsPort } from '../src/ports.js';

const TARGET: ComposeTarget = { files: ['/opt/demo/compose.yaml'], project: 'demo' };

function fakeClock(nowMs: number): Clock {
  return { now: () => new Date(nowMs), sleep: () => Promise.resolve() };
}

interface FakeDockerOptions {
  execResult?: ExecResult;
  runResult?: ExecResult;
}

function fakeDocker(opts: FakeDockerOptions = {}): { docker: DockerPort; calls: { args: string[] }[] } {
  const calls: { args: string[] }[] = [];
  const docker: DockerPort = {
    compose: (_target, args) => {
      calls.push({ args });
      const result = args[0] === 'run' ? opts.runResult : opts.execResult;
      return Promise.resolve(result ?? { exitCode: 0, stdout: '', stderr: '' });
    },
    containers: () => Promise.resolve([]),
    probeHealth: () => Promise.reject(new Error('not implemented')),
    freeBytes: () => Promise.resolve(0),
    images: () => Promise.resolve([]),
    removeImage: () => Promise.resolve(),
  };
  return { docker, calls };
}

interface FakeFile {
  path: string;
  size: number;
  mtimeMs: number;
}

/** `before` is what the directory held before the step ran; `files` is what it holds after. */
function fakeFs(files: FakeFile[] = [], before: FakeFile[] = []): { fs: FsPort; written: { path: string; content: string }[] } {
  const written: { path: string; content: string }[] = [];
  let listed = 0;
  const fs: FsPort = {
    readFile: () => Promise.reject(new Error('not implemented')),
    writeFileAtomic: (path, content) => {
      written.push({ path, content });
      return Promise.resolve();
    },
    appendLine: () => Promise.resolve(),
    exists: () => Promise.resolve(true),
    mkdirp: () => Promise.resolve(),
    list: (_dir, options) => {
      if (options?.recursive !== true) return Promise.reject(new Error('backup artifacts must be listed recursively'));
      return Promise.resolve(listed++ === 0 ? before : files);
    },
  };
  return { fs, written };
}

describe('runBackup', () => {
  it('treats an artifacts directory the first backup creates as empty beforehand', async () => {
    const { docker } = fakeDocker();
    const fresh = { path: '/backups/predeploy/bundles/2026/09/25/new.tar.gz', size: 10, mtimeMs: 1000 };
    let calls = 0;
    const fs: FsPort = {
      readFile: () => Promise.reject(new Error('not implemented')),
      writeFileAtomic: () => Promise.resolve(),
      appendLine: () => Promise.resolve(),
      exists: () => Promise.resolve(true),
      mkdirp: () => Promise.resolve(),
      list: () => (calls++ === 0 ? Promise.reject(Object.assign(new Error('ENOENT: no such directory'), { code: 'ENOENT' })) : Promise.resolve([fresh])),
    };
    const result = await runBackup({ docker, fs, clock: fakeClock(1000) }, TARGET, { service: 'db', argv: ['backup'], artifactsDir: '/backups/predeploy' });
    expect(result.artifact.path).toBe(fresh.path);
  });

  it('finds an artifact nested by date, and not an unchanged nested file', async () => {
    const { docker } = fakeDocker();
    const old = { path: '/backups/bundles/2026/09/24/old.tar.gz', size: 10, mtimeMs: 500 };
    const fresh = { path: '/backups/bundles/2026/09/25/new.tar.gz', size: 10, mtimeMs: 1000 };
    const { fs } = fakeFs([old, fresh], [old]);
    const result = await runBackup({ docker, fs, clock: fakeClock(1000) }, TARGET, { service: 'db', argv: ['backup'], artifactsDir: '/backups' });
    expect(result.artifact.path).toBe(fresh.path);
  });


  it('never takes a file that existed before the step, even one with a future-skewed mtime', async () => {
    const { docker } = fakeDocker();
    const stale = { path: '/backups/stale.tar', size: 100, mtimeMs: 50_000_000 };
    const { fs } = fakeFs([stale], [stale]);
    await expect(
      runBackup({ docker, fs, clock: fakeClock(1000) }, TARGET, { service: 'db', argv: ['backup'], artifactsDir: '/backups' }),
    ).rejects.toThrow(RefusalError);
  });

  it('never takes a new file whose mtime lies beyond the step', async () => {
    const { docker } = fakeDocker();
    const { fs } = fakeFs([{ path: '/backups/future.tar', size: 100, mtimeMs: 50_000_000 }]);
    await expect(
      runBackup({ docker, fs, clock: fakeClock(1000) }, TARGET, { service: 'db', argv: ['backup'], artifactsDir: '/backups' }),
    ).rejects.toThrow(RefusalError);
  });

  it('records the newest non-empty file created since the step began, and never stores output', async () => {
    const secretOutput = { exitCode: 0, stdout: 'DB_PASSWORD=hunter2 dumped', stderr: '' };
    const { docker, calls } = fakeDocker({ execResult: secretOutput });
    const { fs } = fakeFs([
      { path: '/backups/old.tar', size: 100, mtimeMs: 500 },
      { path: '/backups/new.tar', size: 200, mtimeMs: 2000 },
    ]);
    const clock = fakeClock(1000);

    const result = await runBackup(
      { docker, fs, clock },
      TARGET,
      { service: 'db', argv: ['pg_dump'], artifactsDir: '/backups' },
    );

    expect(result.artifact.path).toBe('/backups/new.tar');
    expect(result).not.toHaveProperty('output');
    expect(calls[0]?.args).toEqual(['exec', '-T', 'db', 'pg_dump']);
  });

  it('picks the newest of several new files', async () => {
    const { docker } = fakeDocker();
    const { fs } = fakeFs([
      { path: '/backups/a.tar', size: 10, mtimeMs: 1200 },
      { path: '/backups/b.tar', size: 10, mtimeMs: 1900 },
      { path: '/backups/c.tar', size: 10, mtimeMs: 1500 },
    ]);
    const clock = fakeClock(1000);

    const result = await runBackup({ docker, fs, clock }, TARGET, { service: 'db', argv: ['dump'], artifactsDir: '/backups' });
    expect(result.artifact.path).toBe('/backups/b.tar');
  });

  it('fails when only an old file exists', async () => {
    const { docker } = fakeDocker();
    const { fs } = fakeFs([{ path: '/backups/old.tar', size: 100, mtimeMs: 500 }]);
    const clock = fakeClock(5000);

    await expect(runBackup({ docker, fs, clock }, TARGET, { service: 'db', argv: ['dump'], artifactsDir: '/backups' })).rejects.toThrow(RefusalError);
  });

  it('fails when the new file is empty', async () => {
    const { docker } = fakeDocker();
    const { fs } = fakeFs([{ path: '/backups/empty.tar', size: 0, mtimeMs: 2000 }]);
    const clock = fakeClock(1000);

    await expect(runBackup({ docker, fs, clock }, TARGET, { service: 'db', argv: ['dump'], artifactsDir: '/backups' })).rejects.toThrow(RefusalError);
  });

  it('fails on a non-zero exit, and the refusal message carries no step output', async () => {
    const { docker } = fakeDocker({ execResult: { exitCode: 1, stdout: 'DB_PASSWORD=hunter2', stderr: 'boom' } });
    const { fs } = fakeFs([{ path: '/backups/new.tar', size: 100, mtimeMs: 2000 }]);
    const clock = fakeClock(1000);

    await expect(runBackup({ docker, fs, clock }, TARGET, { service: 'db', argv: ['dump'], artifactsDir: '/backups' })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(RefusalError);
      const refusalError = error as RefusalError;
      expect(refusalError.refusal.code).toBe('backup_failed');
      expect(refusalError.message).not.toContain('hunter2');
      expect(refusalError.message).not.toContain('boom');
      return true;
    });
  });
});

describe('runMigrate', () => {
  it('redacts an env value printed by the step and stores the rest of the output', async () => {
    const { docker, calls } = fakeDocker({ runResult: { exitCode: 0, stdout: 'connecting with hunter2', stderr: '' } });
    const { fs, written } = fakeFs();
    const clock = fakeClock(1000);
    const secrets = new Map([['DB_PASSWORD', 'hunter2']]);

    const result = await runMigrate(
      { docker, fs, clock },
      TARGET,
      { service: 'web', argv: ['migrate'] },
      [{ service: 'web', reference: 'ghcr.io/acme/demo/web:sha-abc@sha256:deadbeef' }],
      '/work',
      secrets,
    );

    expect(result.output).toContain('«redacted:DB_PASSWORD»');
    expect(result.output).not.toContain('hunter2');

    const runCall = calls.find((c) => c.args[0] === 'run');
    expect(runCall?.args).toEqual(['run', '--rm', '--no-deps', '-T', 'web', 'migrate']);

    const overrideWrite = written[0];
    expect(overrideWrite?.path.startsWith('/work/')).toBe(true);
    expect(overrideWrite?.content).toContain('web:');
    expect(overrideWrite?.content).toContain('ghcr.io/acme/demo/web:sha-abc@sha256:deadbeef');
  });

  it('runs against the target files plus the override, never a shell string', async () => {
    const { docker, calls } = fakeDocker();
    const { fs } = fakeFs();
    const clock = fakeClock(1000);

    await runMigrate({ docker, fs, clock }, TARGET, { service: 'web', argv: ['migrate', '--yes'] }, [], '/work', new Map());

    const runCall = calls.find((c) => c.args[0] === 'run');
    expect(runCall?.args).toEqual(['run', '--rm', '--no-deps', '-T', 'web', 'migrate', '--yes']);
  });

  it('refuses on a non-zero exit and keeps the deploy from swapping', async () => {
    const { docker } = fakeDocker({ runResult: { exitCode: 1, stdout: 'connecting with hunter2', stderr: 'migration error' } });
    const { fs } = fakeFs();
    const clock = fakeClock(1000);
    const secrets = new Map([['DB_PASSWORD', 'hunter2']]);

    await expect(runMigrate({ docker, fs, clock }, TARGET, { service: 'web', argv: ['migrate'] }, [], '/work', secrets)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(RefusalError);
      const refusalError = error as RefusalError;
      expect(refusalError.refusal.code).toBe('migrate_failed');
      expect(refusalError.message).toContain('«redacted:DB_PASSWORD»');
      expect(refusalError.message).not.toContain('hunter2');
      expect(refusalError.message).toContain('migration error');
      return true;
    });
  });
});

describe('runExec', () => {
  it('redacts output and reports the args passed to compose', async () => {
    const { docker, calls } = fakeDocker({ execResult: { exitCode: 0, stdout: 'token abc123def', stderr: '' } });
    const { fs } = fakeFs();
    const secrets = new Map([['API_KEY', 'abc123def']]);

    const result = await runExec({ docker, fs, clock: fakeClock(0) }, TARGET, { service: 'web', argv: ['notify'] }, secrets);

    expect(result.output).toContain('«redacted:API_KEY»');
    expect(calls[0]?.args).toEqual(['exec', '-T', 'web', 'notify']);
  });

  it('refuses on a non-zero exit', async () => {
    const { docker } = fakeDocker({ execResult: { exitCode: 2, stdout: '', stderr: 'nope' } });
    const { fs } = fakeFs();

    await expect(runExec({ docker, fs, clock: fakeClock(0) }, TARGET, { service: 'web', argv: ['notify'] }, new Map())).rejects.toThrow(RefusalError);
  });
});
