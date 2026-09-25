import { randomBytes } from 'node:crypto';
import { link, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises';

/**
 * A cross-process exclusive guard file (shared by `AppLock`'s takeover guard and the ledger's
 * append lock, SHP-T-6.11). Created with link(2) from a private temp file, so exactly one process
 * holds it; a guard whose mtime is older than `staleMs` was left by a process that died holding it
 * and is cleared once. A live holder keeps its guard fresh: while held, its mtime is bumped every
 * third of `staleMs`, so however long the protected work takes (a large ledger re-verified under
 * I/O contention), only a holder that has died can ever look stale. Release removes the guard only
 * if it still carries this holder's token, so a holder can never delete someone else's guard.
 */

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** Tries once (plus one retry after clearing a stale guard). Returns the release, or 'busy'. */
export async function tryGuard(guard: string, staleMs: number): Promise<(() => Promise<void>) | 'busy'> {
  const token = randomBytes(12).toString('hex');
  const tmp = `${guard}.${token}.tmp`;
  const content = JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() });
  await writeFile(tmp, content, { flag: 'wx' });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await link(tmp, guard);
        const keepAlive = setInterval(() => {
          const now = new Date();
          void utimes(guard, now, now).catch(() => undefined);
        }, Math.max(250, Math.floor(staleMs / 3)));
        keepAlive.unref();
        return async () => {
          clearInterval(keepAlive);
          // Only our own guard: if it was ever cleared and retaken, the new holder's stays.
          const current = await readFile(guard, 'utf8').catch(() => null);
          if (current === content) await unlink(guard).catch(() => undefined);
        };
      } catch (err) {
        if (errCode(err) !== 'EEXIST') throw err;
        const info = await stat(guard).catch(() => null);
        if (info !== null && Date.now() - info.mtimeMs <= staleMs) return 'busy';
        // Left by a process that died holding it (or just released): clear it and try once more.
        if (info !== null) await unlink(guard).catch(() => undefined);
      }
    }
    return 'busy';
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

export class GuardTimeoutError extends Error {
  constructor(guard: string, waitedMs: number) {
    super(`could not take ${guard} within ${waitedMs} ms: another process holds it`);
    this.name = 'GuardTimeoutError';
  }
}

/**
 * Waits for the guard (short randomised back-off), then returns its release. Throws
 * `GuardTimeoutError` after `timeoutMs`.
 */
export async function acquireGuard(guard: string, options: { staleMs: number; timeoutMs: number }): Promise<() => Promise<void>> {
  const started = Date.now();
  for (;;) {
    const held = await tryGuard(guard, options.staleMs);
    if (held !== 'busy') return held;
    if (Date.now() - started >= options.timeoutMs) throw new GuardTimeoutError(guard, options.timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, 2 + Math.floor(Math.random() * 10)));
  }
}
