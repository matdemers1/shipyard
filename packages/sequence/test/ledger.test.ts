import { describe, expect, it } from 'vitest';

import { Ledger, LedgerEntryInvalidError, LedgerTamperedError } from '../src/ledger.js';
import type { LedgerEntry } from '../src/types.js';
import type { FsPort } from '../src/ports.js';

/** In-memory FsPort fake with an append-then-fsync appendLine, mirroring the real adapter's contract. */
function memoryFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const fs: FsPort = {
    readFile: (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return Promise.resolve(content);
    },
    writeFileAtomic: (path: string, content: string) => {
      files.set(path, content);
      return Promise.resolve();
    },
    appendLine: (path: string, line: string) => {
      const existing = files.get(path) ?? '';
      files.set(path, `${existing}${line}\n`);
      return Promise.resolve();
    },
    exists: (path: string) => Promise.resolve(files.has(path)),
    mkdirp: () => Promise.resolve(),
    list: () => Promise.resolve([]),
  };
  return { fs, files };
}

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    app: 'bindery',
    deployId: 'dep-1',
    kind: 'deploy',
    sha: 'a'.repeat(40),
    images: [{ service: 'server', repo: 'ghcr.io/matdemers1/bindery/server', digest: `sha256:${'b'.repeat(64)}`, migration: null }],
    backupArtifact: null,
    at: '2026-09-24T00:00:00.000Z',
    ...overrides,
  };
}

const PATH = '/data/agent/ledger.jsonl';

describe('Ledger.open', () => {
  it('treats a missing file as an empty ledger and creates the dir', async () => {
    const { fs } = memoryFs();
    const ledger = await Ledger.open(fs, PATH);
    expect(ledger.entries('bindery')).toEqual([]);
    expect(ledger.last('bindery')).toBeNull();
  });

  it('round-trips: append, reopen, verify', async () => {
    const { fs } = memoryFs();
    const ledger = await Ledger.open(fs, PATH);
    await ledger.append(entry({ deployId: 'dep-1' }));
    await ledger.append(entry({ deployId: 'dep-2', sha: 'c'.repeat(40) }));
    await ledger.append(entry({ app: 'foreman', deployId: 'dep-3' }));

    const reopened = await Ledger.open(fs, PATH);
    expect(reopened.entries('bindery').map((e) => e.deployId)).toEqual(['dep-1', 'dep-2']);
    expect(reopened.entries('foreman').map((e) => e.deployId)).toEqual(['dep-3']);
    expect(reopened.last('bindery')?.deployId).toBe('dep-2');
  });
});

describe('Ledger.open tamper detection', () => {
  async function seeded(): Promise<{ fs: FsPort; files: Map<string, string> }> {
    const mem = memoryFs();
    const ledger = await Ledger.open(mem.fs, PATH);
    await ledger.append(entry({ deployId: 'dep-1' }));
    await ledger.append(entry({ deployId: 'dep-2', sha: 'c'.repeat(40) }));
    await ledger.append(entry({ deployId: 'dep-3', sha: 'd'.repeat(40) }));
    return mem;
  }

  it('fails on an edited digest', async () => {
    const { fs, files } = await seeded();
    const content = files.get(PATH) ?? '';
    const lines = content.split('\n').filter(Boolean);
    const tampered = lines[1]?.replace('b'.repeat(64), 'f'.repeat(64));
    lines[1] = tampered ?? '';
    files.set(PATH, `${lines.join('\n')}\n`);

    await expect(Ledger.open(fs, PATH)).rejects.toThrow(LedgerTamperedError);
    await expect(Ledger.open(fs, PATH)).rejects.toThrow(/line 2/);
  });

  it('fails on an edited at', async () => {
    const { fs, files } = await seeded();
    const content = files.get(PATH) ?? '';
    const lines = content.split('\n').filter(Boolean);
    lines[0] = (lines[0] ?? '').replace('2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.001Z');
    files.set(PATH, `${lines.join('\n')}\n`);

    await expect(Ledger.open(fs, PATH)).rejects.toThrow(LedgerTamperedError);
    await expect(Ledger.open(fs, PATH)).rejects.toThrow(/line 1/);
  });

  it('fails on a deleted middle line', async () => {
    const { fs, files } = await seeded();
    const content = files.get(PATH) ?? '';
    const lines = content.split('\n').filter(Boolean);
    lines.splice(1, 1);
    files.set(PATH, `${lines.join('\n')}\n`);

    await expect(Ledger.open(fs, PATH)).rejects.toThrow(LedgerTamperedError);
  });

  it('fails on reordered lines', async () => {
    const { fs, files } = await seeded();
    const content = files.get(PATH) ?? '';
    const lines = content.split('\n').filter(Boolean);
    const [a, b, c] = lines;
    files.set(PATH, `${[b, a, c].join('\n')}\n`);

    await expect(Ledger.open(fs, PATH)).rejects.toThrow(LedgerTamperedError);
  });

  it('fails on a duplicated line', async () => {
    const { fs, files } = await seeded();
    const content = files.get(PATH) ?? '';
    const lines = content.split('\n').filter(Boolean);
    lines.splice(1, 0, lines[0] ?? '');
    files.set(PATH, `${lines.join('\n')}\n`);

    await expect(Ledger.open(fs, PATH)).rejects.toThrow(LedgerTamperedError);
  });

  it('fails on a recomputed hash without fixing the next line\'s prev', async () => {
    const { fs, files } = await seeded();
    const content = files.get(PATH) ?? '';
    const lines = content.split('\n').filter(Boolean);
    const line1 = JSON.parse(lines[0] ?? '{}') as { seq: number; prev: string; entry: LedgerEntry; hash: string };
    line1.entry.sha = 'e'.repeat(40);
    // Recompute hash consistently for line 1 (simulating an attacker who fixes line 1's own hash)
    // but leaves line 2's `prev` pointing at the *old* hash — the chain should still fail.
    const { createHash } = await import('node:crypto');
    function canon(v: unknown): unknown {
      if (Array.isArray(v)) return v.map(canon);
      if (v !== null && typeof v === 'object') {
        const record = v as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(record).sort()) out[k] = canon(record[k]);
        return out;
      }
      return v;
    }
    line1.hash = createHash('sha256')
      .update(`${line1.prev}\n${JSON.stringify(canon({ seq: line1.seq, entry: line1.entry }))}`)
      .digest('hex');
    lines[0] = JSON.stringify(line1);
    files.set(PATH, `${lines.join('\n')}\n`);

    await expect(Ledger.open(fs, PATH)).rejects.toThrow(LedgerTamperedError);
    await expect(Ledger.open(fs, PATH)).rejects.toThrow(/line 2/);
  });

  it('fails on a torn final line', async () => {
    const { fs, files } = await seeded();
    const content = files.get(PATH) ?? '';
    // Simulate a crash mid-append: no trailing newline on the last line.
    files.set(PATH, content.slice(0, -1));

    await expect(Ledger.open(fs, PATH)).rejects.toThrow(LedgerTamperedError);
    await expect(Ledger.open(fs, PATH)).rejects.toThrow(/torn/);
  });

  it('fails when the final line is unparseable', async () => {
    const { fs, files } = await seeded();
    const content = files.get(PATH) ?? '';
    const lines = content.split('\n').filter(Boolean);
    lines[lines.length - 1] = '{not json';
    files.set(PATH, `${lines.join('\n')}\n`);

    await expect(Ledger.open(fs, PATH)).rejects.toThrow(LedgerTamperedError);
  });
});

describe('Ledger queries', () => {
  it('scopes entries, last, recent (<=5, newest first) per app', async () => {
    const { fs } = memoryFs();
    const ledger = await Ledger.open(fs, PATH);
    for (let i = 1; i <= 7; i++) {
      await ledger.append(entry({ app: 'bindery', deployId: `dep-${i}` }));
    }
    await ledger.append(entry({ app: 'foreman', deployId: 'other-1' }));

    expect(ledger.entries('bindery')).toHaveLength(7);
    expect(ledger.last('bindery')?.deployId).toBe('dep-7');
    expect(ledger.recent('bindery')).toHaveLength(5);
    expect(ledger.recent('bindery').map((e) => e.deployId)).toEqual(['dep-7', 'dep-6', 'dep-5', 'dep-4', 'dep-3']);
    expect(ledger.entries('foreman').map((e) => e.deployId)).toEqual(['other-1']);
  });

  it('isRollbackTarget: within the last 5, excluding the current live (last) entry', async () => {
    const { fs } = memoryFs();
    const ledger = await Ledger.open(fs, PATH);
    for (let i = 1; i <= 6; i++) {
      await ledger.append(entry({ app: 'bindery', deployId: `dep-${i}` }));
    }

    expect(ledger.isRollbackTarget('bindery', 'dep-6')).toBe(false); // current live
    expect(ledger.isRollbackTarget('bindery', 'dep-5')).toBe(true);
    expect(ledger.isRollbackTarget('bindery', 'dep-2')).toBe(true);
    expect(ledger.isRollbackTarget('bindery', 'dep-1')).toBe(false); // outside the last 5
    expect(ledger.isRollbackTarget('bindery', 'unknown')).toBe(false);
  });

  it('laterThan returns entries after the named deploy, oldest first', async () => {
    const { fs } = memoryFs();
    const ledger = await Ledger.open(fs, PATH);
    await ledger.append(entry({ deployId: 'dep-1' }));
    await ledger.append(entry({ deployId: 'dep-2' }));
    await ledger.append(entry({ deployId: 'dep-3' }));

    expect(ledger.laterThan('bindery', 'dep-1').map((e) => e.deployId)).toEqual(['dep-2', 'dep-3']);
    expect(ledger.laterThan('bindery', 'dep-3')).toEqual([]);
    expect(ledger.laterThan('bindery', 'unknown')).toEqual([]);
  });

  it('backupArtifacts returns only entries with a backup, in order', async () => {
    const { fs } = memoryFs();
    const ledger = await Ledger.open(fs, PATH);
    await ledger.append(entry({ deployId: 'dep-1', backupArtifact: '/backups/dep-1.tar' }));
    await ledger.append(entry({ deployId: 'dep-2', backupArtifact: null }));
    await ledger.append(entry({ deployId: 'dep-3', backupArtifact: '/backups/dep-3.tar' }));

    expect(ledger.backupArtifacts('bindery')).toEqual([
      { app: 'bindery', deployId: 'dep-1', backupArtifact: '/backups/dep-1.tar', at: '2026-09-24T00:00:00.000Z' },
      { app: 'bindery', deployId: 'dep-3', backupArtifact: '/backups/dep-3.tar', at: '2026-09-24T00:00:00.000Z' },
    ]);
  });

  it('knownDigests collects every digest recorded for the app', async () => {
    const { fs } = memoryFs();
    const ledger = await Ledger.open(fs, PATH);
    await ledger.append(
      entry({
        deployId: 'dep-1',
        images: [{ service: 'server', repo: 'r', digest: `sha256:${'1'.repeat(64)}`, migration: null }],
      }),
    );
    await ledger.append(
      entry({
        deployId: 'dep-2',
        images: [
          { service: 'server', repo: 'r', digest: `sha256:${'2'.repeat(64)}`, migration: null },
          { service: 'worker', repo: 'r2', digest: `sha256:${'3'.repeat(64)}`, migration: null },
        ],
      }),
    );

    expect(ledger.knownDigests('bindery')).toEqual(new Set([`sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`, `sha256:${'3'.repeat(64)}`]));
  });
});

describe('Ledger.append validation', () => {
  it('rejects a bad digest format', async () => {
    const { fs } = memoryFs();
    const ledger = await Ledger.open(fs, PATH);
    await expect(
      ledger.append(entry({ images: [{ service: 's', repo: 'r', digest: 'notadigest', migration: null }] })),
    ).rejects.toThrow(LedgerEntryInvalidError);
  });

  it('rejects a bad sha', async () => {
    const { fs } = memoryFs();
    const ledger = await Ledger.open(fs, PATH);
    await expect(ledger.append(entry({ sha: 'short' }))).rejects.toThrow(LedgerEntryInvalidError);
  });

  it('rejects empty images', async () => {
    const { fs } = memoryFs();
    const ledger = await Ledger.open(fs, PATH);
    await expect(ledger.append(entry({ images: [] }))).rejects.toThrow(LedgerEntryInvalidError);
  });
});

describe('Ledger concurrent appends', () => {
  it('serializes 10 concurrent appends into one valid chain', async () => {
    const { fs } = memoryFs();
    const ledger = await Ledger.open(fs, PATH);

    await Promise.all(Array.from({ length: 10 }, (_, i) => ledger.append(entry({ deployId: `dep-${i}` }))));

    expect(ledger.entries('bindery')).toHaveLength(10);

    const reopened = await Ledger.open(fs, PATH);
    expect(reopened.entries('bindery')).toHaveLength(10);
    const deployIds = new Set(reopened.entries('bindery').map((e) => e.deployId));
    expect(deployIds.size).toBe(10);
  });
});
