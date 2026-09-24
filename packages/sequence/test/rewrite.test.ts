import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RefusalError } from '../src/ports.js';
import type { RewriteMapping, RewritePlanFile } from '../src/rewrite.js';
import { applyRewrite, planRewrite, restoreFromHistory } from '../src/rewrite.js';
import { describe, expect, it } from 'vitest';

import type { FsPort } from '../src/ports.js';

const GOLDEN_DIR = join(import.meta.dirname, 'golden/rewrite');

interface ExpectedError {
  code: string;
  messageIncludes: string[];
}

function loadCase(caseDir: string) {
  const dir = join(GOLDEN_DIR, caseDir);
  const entries = readdirSync(dir);
  const mappings = JSON.parse(readFileSync(join(dir, 'mappings.json'), 'utf8')) as RewriteMapping[];
  const inputNames = entries.filter((f) => /^input.*\.yml$/.test(f)).sort();
  const files = inputNames.map((name) => ({
    path: name,
    text: readFileSync(join(dir, name), 'utf8'),
  }));
  const errorPath = entries.includes('error.json') ? join(dir, 'error.json') : null;
  const error = errorPath ? (JSON.parse(readFileSync(errorPath, 'utf8')) as ExpectedError) : null;
  const expectedFor = (inputName: string): string | null => {
    const expectedName = inputName.replace(/^input/, 'expected');
    return entries.includes(expectedName) ? readFileSync(join(dir, expectedName), 'utf8') : null;
  };
  return { files, mappings, error, expectedFor };
}

describe('planRewrite golden cases', () => {
  const cases = readdirSync(GOLDEN_DIR).filter((name) => !name.startsWith('.'));

  for (const caseDir of cases) {
    it(caseDir, () => {
      const { files, mappings, error, expectedFor } = loadCase(caseDir);

      if (error) {
        let thrown: RefusalError | undefined;
        try {
          planRewrite(files, mappings);
        } catch (err) {
          thrown = err as RefusalError;
        }
        expect(thrown).toBeDefined();
        if (!thrown) return;
        expect(thrown.refusal.code).toBe(error.code);
        for (const fragment of error.messageIncludes) {
          expect(thrown.refusal.message).toContain(fragment);
        }
        return;
      }

      const plan = planRewrite(files, mappings);
      const afterByPath = new Map(plan.map((p) => [p.path, p.after] as const));

      for (const file of files) {
        const expected = expectedFor(file.path);
        expect(expected).not.toBeNull();
        const after = afterByPath.get(file.path) ?? file.text;
        expect(after).toBe(expected);
      }
    });
  }
});

describe('planRewrite idempotency', () => {
  it('rewriting an already-rewritten line to the same reference yields after === before', () => {
    const { files, mappings } = loadCase('idempotent-already-rewritten');
    const plan = planRewrite(files, mappings);
    // The plan may legitimately omit an unchanged file entirely, or include it with after === before.
    for (const p of plan) {
      expect(p.after).toBe(p.before);
    }
  });
});

// ─── applyRewrite / restoreFromHistory ────────────────────────────────────────

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
      // no-op for the in-memory fake
      return Promise.resolve();
    },
    list(_dir: string) {
      return Promise.resolve([]);
    },
  };
}

describe('applyRewrite', () => {
  it('writes each changed file and keeps the previous content in history', async () => {
    const before = 'services:\n  app:\n    image: repo:old\n';
    const fs = makeMemoryFs({ 'a.yml': before });
    const plan: RewritePlanFile[] = [
      { path: 'a.yml', before, after: 'services:\n  app:\n    image: repo:new\n', changed: ['app'] },
    ];

    const result = await applyRewrite(fs, plan, { dir: '/history', deployId: 'dep-1' });

    expect(fs.files.get('a.yml')).toBe('services:\n  app:\n    image: repo:new\n');
    expect(result.historyFiles).toHaveLength(1);
    const [historyFile] = result.historyFiles;
    expect(historyFile).toBeDefined();
    expect(historyFile?.original).toBe('a.yml');
    expect(fs.files.get(historyFile?.copy ?? '')).toBe('services:\n  app:\n    image: repo:old\n');
    expect(fs.files.has('/history/dep-1/manifest.json')).toBe(true);
  });

  it('restores already-written files and rethrows when a later write fails', async () => {
    const fs = makeMemoryFs({
      'a.yml': 'services:\n  app:\n    image: repo:old\n',
      'b.yml': 'services:\n  worker:\n    image: repo:old\n',
    });
    let calls = 0;
    const originalWrite = fs.writeFileAtomic.bind(fs);
    fs.writeFileAtomic = async (path: string, content: string) => {
      calls++;
      // Succeed for history copies and the first target file, fail on the second target file.
      if (path === 'b.yml') {
        throw new Error('disk full');
      }
      await originalWrite(path, content);
    };

    const plan: RewritePlanFile[] = [
      { path: 'a.yml', before: 'services:\n  app:\n    image: repo:old\n', after: 'services:\n  app:\n    image: repo:new\n', changed: ['app'] },
      { path: 'b.yml', before: 'services:\n  worker:\n    image: repo:old\n', after: 'services:\n  worker:\n    image: repo:new\n', changed: ['worker'] },
    ];

    await expect(applyRewrite(fs, plan, { dir: '/history', deployId: 'dep-2' })).rejects.toThrow('disk full');
    expect(calls).toBeGreaterThan(0);
    // a.yml was written then must have been restored to its previous content.
    expect(fs.files.get('a.yml')).toBe('services:\n  app:\n    image: repo:old\n');
  });
});

describe('restoreFromHistory', () => {
  it('writes saved previous contents back to their original paths', async () => {
    const before = 'services:\n  app:\n    image: repo:old\n';
    const fs = makeMemoryFs({ 'a.yml': before });
    const plan: RewritePlanFile[] = [
      { path: 'a.yml', before, after: 'services:\n  app:\n    image: repo:new\n', changed: ['app'] },
    ];
    await applyRewrite(fs, plan, { dir: '/history', deployId: 'dep-3' });
    expect(fs.files.get('a.yml')).toBe('services:\n  app:\n    image: repo:new\n');

    const restored = await restoreFromHistory(fs, '/history', 'dep-3');

    expect(restored).toEqual(['a.yml']);
    expect(fs.files.get('a.yml')).toBe('services:\n  app:\n    image: repo:old\n');
  });
});
