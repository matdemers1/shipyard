import { chmod, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nodeFs, systemClock } from '../src/adapters/node.js';

describe('nodeFs', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'shipyard-fs-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writeFileAtomic leaves no temp file behind and the final content is exact', async () => {
    const fs = nodeFs();
    const target = join(dir, 'ledger.json');
    await fs.writeFileAtomic(target, 'first');
    await fs.writeFileAtomic(target, 'second');

    expect(await readFile(target, 'utf-8')).toBe('second');
    const entries = await readdir(dir);
    expect(entries).toEqual(['ledger.json']);
    expect(entries.some((name) => name.includes('shipyard-tmp'))).toBe(false);
  });

  it('writeFileAtomic preserves the original file mode', async () => {
    const fs = nodeFs();
    const target = join(dir, 'secret.env');
    await fs.writeFileAtomic(target, 'A=1');
    await chmod(target, 0o600);

    await fs.writeFileAtomic(target, 'A=2');

    const stats = await stat(target);
    expect(stats.mode & 0o777).toBe(0o600);
    expect(await readFile(target, 'utf-8')).toBe('A=2');
  });

  it('appendLine adds a newline-terminated line durably across calls', async () => {
    const fs = nodeFs();
    const target = join(dir, 'journal.ndjson');
    await fs.appendLine(target, '{"a":1}');
    await fs.appendLine(target, '{"a":2}');

    const content = await readFile(target, 'utf-8');
    expect(content).toBe('{"a":1}\n{"a":2}\n');
  });

  it('exists reflects presence and absence', async () => {
    const fs = nodeFs();
    const target = join(dir, 'maybe.txt');
    expect(await fs.exists(target)).toBe(false);
    await fs.writeFileAtomic(target, 'x');
    expect(await fs.exists(target)).toBe(true);
  });

  it('mkdirp creates nested directories', async () => {
    const fs = nodeFs();
    const nested = join(dir, 'a', 'b', 'c');
    await fs.mkdirp(nested);
    expect((await stat(nested)).isDirectory()).toBe(true);
  });

  it('list returns only regular files directly inside the directory, with size and mtime', async () => {
    const fs = nodeFs();
    await fs.writeFileAtomic(join(dir, 'one.txt'), 'hello');
    await fs.writeFileAtomic(join(dir, 'two.txt'), 'hi');
    await fs.mkdirp(join(dir, 'subdir'));
    await fs.writeFileAtomic(join(dir, 'subdir', 'nested.txt'), 'nope');

    const entries = await fs.list(dir);
    const names = entries.map((e) => e.path.split('/').pop()).sort();
    expect(names).toEqual(['one.txt', 'two.txt']);
    const one = entries.find((e) => e.path.endsWith('one.txt'));
    expect(one?.size).toBe(5);
    expect(typeof one?.mtimeMs).toBe('number');
  });
});

describe('systemClock', () => {
  it('now returns a Date close to the real clock', () => {
    const clock = systemClock();
    const before = Date.now();
    const now = clock.now().getTime();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it('sleep resolves after roughly the requested delay', async () => {
    const clock = systemClock();
    const start = Date.now();
    await clock.sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});
