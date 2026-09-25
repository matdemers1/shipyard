import { randomBytes } from 'node:crypto';
import { link, stat, unlink, writeFile } from 'node:fs/promises';

/**
 * A cross-process exclusive guard file (shared by `AppLock`'s takeover guard and the ledger's
 * append lock, SHP-T-6.11). Created with link(2) from a private temp file, so exactly one process
 * holds it; a guard whose mtime is older than `staleMs` was left by a process that died holding it
 * and is cleared once. A guard is only ever held for milliseconds (a read and a rename, or a read
 * and an append), so a stale one is a crash, never a slow holder.
 */

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** Tries once (plus one retry after clearing a stale guard). Returns the release, or 'busy'. */
export async function tryGuard(guard: string, staleMs: number): Promise<(() => Promise<void>) | 'busy'> {
  const tmp = `${guard}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await link(tmp, guard);
        return async () => {
          await unlink(guard).catch(() => undefined);
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
