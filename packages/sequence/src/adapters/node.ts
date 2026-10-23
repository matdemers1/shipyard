import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readdir, readFile as fsReadFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { acquireGuard } from '../guard.js';
import type { ArchiveFilesPort, Clock, FsPort } from '../ports.js';

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

    /** A `<path>.lock` guard (see `guard.ts`); stale after 30 s, and a wait longer than 60 s throws. */
    async lock(path) {
      return await acquireGuard(`${path}.lock`, { staleMs: 30_000, timeoutMs: 60_000 });
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

    async list(dir, options) {
      const entries = await readdir(dir, { withFileTypes: true, recursive: options?.recursive === true });
      const files = entries.filter((entry) => entry.isFile());
      return await Promise.all(
        files.map(async (entry) => {
          const full = join(entry.parentPath, entry.name);
          const stats = await stat(full);
          return { path: full, size: stats.size, mtimeMs: stats.mtimeMs };
        }),
      );
    },
  };
}

function errCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
}

/**
 * Volume archives on the real filesystem (SHP-REQ-201, SHP-T-17.2): directories 0700, files 0600,
 * a commit that fsyncs the file, renames it and fsyncs the directory, and a streamed SHA-256.
 */
export function nodeArchiveFiles(): ArchiveFilesPort {
  return {
    async ensureDir(dir) {
      // `mkdir -p` returns the first directory it made: that one and each below it down to `dir`
      // are ours, and set 0700 whatever the umask. One that existed (the backup root) is left alone.
      const first = await mkdir(dir, { recursive: true, mode: 0o700 });
      if (first === undefined) return;
      for (let d = dir; d.length >= first.length; d = dirname(d)) {
        await chmod(d, 0o700);
        if (d === first || d === dirname(d)) break;
      }
    },

    async createEmpty(path) {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
    },

    async commit(tmp, final) {
      const handle = await open(tmp, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, final);
      const dirHandle = await open(dirname(final), 'r');
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    },

    async digest(path) {
      try {
        const info = await stat(path);
        if (!info.isFile()) return null;
      } catch (err) {
        if (errCode(err) === 'ENOENT') return null;
        throw err;
      }
      const hash = createHash('sha256');
      let read = 0;
      for await (const chunk of createReadStream(path)) {
        const buf = chunk as Buffer;
        hash.update(buf);
        read += buf.length;
      }
      // The size is what was hashed, so the two always describe the same bytes.
      return { sha256: hash.digest('hex'), sizeBytes: read };
    },

    async remove(path) {
      try {
        await unlink(path);
      } catch (err) {
        if (errCode(err) !== 'ENOENT') throw err;
      }
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
