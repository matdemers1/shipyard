import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nodeFs } from '../../src/adapters/node.js';
import { appendBuildRecord, buildRecordPath, latestSucceededBuild } from '../../src/build/record.js';
import type { BuildRecord } from '../../src/build/record.js';

const SHA = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const DIGEST = `sha256:${'e'.repeat(64)}`;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'record-test-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function rec(over: Partial<BuildRecord>): BuildRecord {
  return { buildId: 'b1', app: 'toy', sha: SHA, state: 'succeeded', digests: { api: DIGEST }, at: '2026-09-28T00:00:00.000Z', ...over };
}

describe('build record', () => {
  it('appends JSONL and finds the latest succeeded build for app + sha', async () => {
    const fs = nodeFs();
    await appendBuildRecord(fs, root, rec({ buildId: 'b1' }));
    await appendBuildRecord(fs, root, rec({ buildId: 'b2', state: 'failed', digests: {} }));
    await appendBuildRecord(fs, root, rec({ buildId: 'b3' }));
    await appendBuildRecord(fs, root, rec({ buildId: 'b4', sha: OTHER }));

    expect((await latestSucceededBuild(fs, root, 'toy', SHA))?.buildId).toBe('b3');
    expect((await latestSucceededBuild(fs, root, 'toy', OTHER))?.buildId).toBe('b4');
    expect(await latestSucceededBuild(fs, root, 'toy', 'f'.repeat(40))).toBeNull();
    expect(await latestSucceededBuild(fs, root, 'nothing', SHA)).toBeNull();

    const text = await readFile(join(root, 'builds', 'toy.jsonl'), 'utf-8');
    expect(text.trim().split('\n')).toHaveLength(4);
    expect(Object.keys(JSON.parse(text.split('\n')[0] ?? '') as object).sort()).toEqual(['app', 'at', 'buildId', 'digests', 'sha', 'state']);
  });

  it('skips malformed lines without failing', async () => {
    const fs = nodeFs();
    await appendBuildRecord(fs, root, rec({ buildId: 'good' }));
    const path = join(root, 'builds', 'toy.jsonl');
    const good = await readFile(path, 'utf-8');
    await writeFile(
      path,
      good +
        ['{not json', 'null', '[]', JSON.stringify(rec({ buildId: 'bad-digest', digests: { api: 'sha256:x' } })), JSON.stringify({ ...rec({}), state: 'weird' }), ''].join('\n'),
    );
    expect((await latestSucceededBuild(fs, root, 'toy', SHA))?.buildId).toBe('good');
  });

  it('never stores fields other than the record, and rejects a path-traversing app name', async () => {
    const fs = nodeFs();
    await appendBuildRecord(fs, root, { ...rec({}), log: 'secret output' } as BuildRecord);
    expect(await readFile(join(root, 'builds', 'toy.jsonl'), 'utf-8')).not.toContain('secret output');
    expect(() => buildRecordPath(root, '../etc')).toThrow();
  });
});
