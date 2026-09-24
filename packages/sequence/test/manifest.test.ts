import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { loadManifests, ManifestLoadError } from '../src/manifest.js';
import type { FsPort } from '../src/ports.js';

/** Minimal in-memory FsPort fake: just enough of the surface `loadManifests` touches. */
function memoryFs(files: Record<string, string>): FsPort {
  return {
    readFile: (path: string) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return Promise.resolve(content);
    },
    writeFileAtomic: () => Promise.reject(new Error('not implemented')),
    appendLine: () => Promise.reject(new Error('not implemented')),
    exists: (path: string) => Promise.resolve(Object.keys(files).some((p) => p === path || p.startsWith(`${path}/`))),
    mkdirp: () => Promise.resolve(),
    list: (dir: string) => {
      const prefix = `${dir}/`;
      const direct = Object.keys(files).filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
      return Promise.resolve(direct.map((path) => ({ path, size: files[path]?.length ?? 0, mtimeMs: 0 })));
    },
  };
}

const validBindery = `
name: bindery
repo: matdemers1/bindery
workflow: ci.yml
compose:
  files:
    - /DATA/apps/bindery/docker-compose.yml
  project: bindery
services:
  server:
    image: ghcr.io/matdemers1/bindery/server
health:
  service: server
  port: 8000
  path: /health
`;

const validForeman = `
name: foreman
repo: matdemers1/foreman
workflow: ci.yml
compose:
  files:
    - /DATA/apps/foreman/docker-compose.yml
  project: foreman
services:
  server:
    image: ghcr.io/matdemers1/foreman/server
health:
  service: server
  port: 3000
  path: /health
`;

describe('loadManifests', () => {
  it('loads every yaml/yml file directly in <dataRoot>/apps, with hashes, ignoring other files', async () => {
    const fs = memoryFs({
      '/data/apps/bindery.yaml': validBindery,
      '/data/apps/foreman.yml': validForeman,
      '/data/apps/README.md': '# not a manifest',
      '/data/apps/subdir/nested.yaml': validBindery,
    });

    const loaded = await loadManifests(fs, '/data');

    expect([...loaded.keys()].sort()).toEqual(['bindery', 'foreman']);
    expect(loaded.get('bindery')?.file).toBe('/data/apps/bindery.yaml');
    expect(loaded.get('bindery')?.manifest.services.server?.image).toBe('ghcr.io/matdemers1/bindery/server');
    expect(loaded.get('bindery')?.sha256).toBe(createHash('sha256').update(Buffer.from(validBindery, 'utf-8')).digest('hex'));
  });

  it('names the file and field for an invalid field', async () => {
    const bad = validBindery.replace('port: 8000', 'port: "x"');
    const fs = memoryFs({ '/data/apps/bindery.yaml': bad });

    await expect(loadManifests(fs, '/data')).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ManifestLoadError);
      const err = error as ManifestLoadError;
      expect(err.issues).toContainEqual(expect.objectContaining({ file: '/data/apps/bindery.yaml', path: 'health.port' }));
      expect(err.message).toContain('/data/apps/bindery.yaml: health.port:');
      return true;
    });
  });

  it('names steps.migrate.command for an unrecognized key on a step', async () => {
    const bad = `${validBindery}steps:\n  migrate:\n    service: server\n    argv: ["pnpm", "migrate"]\n    command: "rm -rf /"\n`;
    const fs = memoryFs({ '/data/apps/bindery.yaml': bad });

    await expect(loadManifests(fs, '/data')).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ManifestLoadError);
      const err = error as ManifestLoadError;
      expect(err.issues).toContainEqual(expect.objectContaining({ file: '/data/apps/bindery.yaml', path: 'steps.migrate.command' }));
      return true;
    });
  });

  it('reports malformed YAML naming the file', async () => {
    const fs = memoryFs({ '/data/apps/bindery.yaml': 'name: [unterminated' });

    await expect(loadManifests(fs, '/data')).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ManifestLoadError);
      const err = error as ManifestLoadError;
      expect(err.issues[0]?.file).toBe('/data/apps/bindery.yaml');
      expect(err.issues[0]?.message).toMatch(/yaml/i);
      return true;
    });
  });

  it('rejects a manifest whose name does not match its filename', async () => {
    const fs = memoryFs({ '/data/apps/mismatch.yaml': validBindery });

    await expect(loadManifests(fs, '/data')).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ManifestLoadError);
      const err = error as ManifestLoadError;
      expect(err.issues).toContainEqual(expect.objectContaining({ file: '/data/apps/mismatch.yaml', path: 'name' }));
      return true;
    });
  });

  it('rejects two files declaring the same manifest name', async () => {
    // Same stem, both extensions: each file's `name` matches its own filename, so the only
    // problem is the duplicate itself.
    const fs = memoryFs({
      '/data/apps/bindery.yaml': validBindery,
      '/data/apps/bindery.yml': validBindery,
    });

    await expect(loadManifests(fs, '/data')).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ManifestLoadError);
      const err = error as ManifestLoadError;
      expect(err.issues).toContainEqual(expect.objectContaining({ file: '/data/apps/bindery.yml', path: 'name' }));
      return true;
    });
  });

  it('errors naming the directory when <dataRoot>/apps is missing', async () => {
    const fs = memoryFs({});

    await expect(loadManifests(fs, '/data')).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ManifestLoadError);
      const err = error as ManifestLoadError;
      expect(err.issues[0]?.file).toBe('/data/apps');
      return true;
    });
  });
});
