import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tryGuard } from '../src/guard.js';

describe('tryGuard (SHP-T-6.11)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'shp-guard-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a live holder stays fresh however long it holds: a second taker is refused after staleMs', async () => {
    const guard = join(dir, 'x.lock');
    const release = await tryGuard(guard, 300);
    expect(release).not.toBe('busy');
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await tryGuard(guard, 300)).toBe('busy');
    if (release !== 'busy') await release();
    await expect(stat(guard)).rejects.toThrow();
  });

  it("release never deletes another holder's guard", async () => {
    const guard = join(dir, 'y.lock');
    const release = await tryGuard(guard, 30_000);
    if (release === 'busy') throw new Error('expected the guard');
    // Someone else's guard replaced ours (e.g. cleared as stale while we were frozen).
    await writeFile(guard, '{"token":"theirs"}');
    await release();
    expect(await readFile(guard, 'utf8')).toBe('{"token":"theirs"}');
  });
});
