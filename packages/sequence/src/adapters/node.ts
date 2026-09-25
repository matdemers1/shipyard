import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile as fsReadFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Clock, FsPort } from '../ports.js';

/**
 * The real filesystem and clock adapters (SHP-T-1.11). `writeFileAtomic` is the durability
 * primitive the journal and ledger rely on (SHP-D-020, SHP-D-029): write beside the target, fsync
 * the file, rename over the target, then fsync the directory so the rename itself survives a crash.
 */

export function nodeFs(): FsPort {
  return {
    async readFile(path) {
      return await fsReadFile(path, 'utf-8');
    },

    async writeFileAtomic(path, content) {
      const dir = dirname(path);
      const tmp = `${path}.shipyard-tmp-${randomBytes(8).toString('hex')}`;

      let mode: number | undefined;
      try {
        mode = (await stat(path)).mode;
      } catch {
        mode = undefined;
      }

      const handle = await open(tmp, 'w', mode);
      try {
        await handle.writeFile(content, 'utf-8');
        await handle.sync();
      } finally {
        await handle.close();
      }

      await rename(tmp, path);

      const dirHandle = await open(dir, 'r');
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    },

    async appendLine(path, line) {
      const handle = await open(path, 'a');
      try {
        await handle.writeFile(`${line}\n`, 'utf-8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    },

    async exists(path) {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },

    async mkdirp(path) {
      await mkdir(path, { recursive: true });
    },

    async list(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      const files = entries.filter((entry) => entry.isFile());
      return await Promise.all(
        files.map(async (entry) => {
          const full = join(dir, entry.name);
          const stats = await stat(full);
          return { path: full, size: stats.size, mtimeMs: stats.mtimeMs };
        }),
      );
    },
  };
}

export function systemClock(): Clock {
  return {
    now() {
      return new Date();
    },
    async sleep(ms) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
    },
  };
}
