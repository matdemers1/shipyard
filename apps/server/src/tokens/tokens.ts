import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db.js';

/** Every API token starts with this, so a leaked one is recognisable (and greppable) as Shipyard's. */
export const TOKEN_PREFIX = 'shp_';
/** `shp_` plus 32 random bytes in base64url (43 characters, no padding). */
export const TOKEN_RE = /^shp_[A-Za-z0-9_-]{43}$/;
/** How much of a token is kept and shown in lists: `shp_` and eight random characters. */
export const PREFIX_LENGTH = 12;
/** `lastUsedAt` is bookkeeping; bumping it at most once a minute keeps reads from becoming writes. */
export const LAST_USED_RESOLUTION_MS = 60 * 1000;

export type Role = 'admin' | 'operator' | 'deployer' | 'viewer';

/** A fresh token. The caller shows `token` once and stores only `hash` and `prefix` (SHP-REQ-046). */
export function generateToken(): { token: string; hash: string; prefix: string } {
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token), prefix: token.slice(0, PREFIX_LENGTH) };
}

/** sha256 hex. The only form of a token the database ever holds. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface ResolvedToken {
  id: string;
  label: string;
  userId: string;
  role: Role;
  apps: Set<string>;
}

/**
 * The token and its scope when it is known, unrevoked, and its owner is not disabled; otherwise
 * null. Looked up by hash through the unique index; the plaintext never reaches the database.
 */
export async function resolveToken(
  db: Db,
  token: string,
  ip: string | undefined,
  now: Date = new Date(),
): Promise<ResolvedToken | null> {
  if (!TOKEN_RE.test(token)) return null;
  const row = await db.apiToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      user: { select: { role: true, disabledAt: true } },
      apps: { include: { app: { select: { name: true } } } },
    },
  });
  if (row === null || row.revokedAt !== null || row.user.disabledAt !== null) return null;

  if (row.lastUsedAt === null || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS) {
    await db.apiToken.update({
      where: { id: row.id },
      data: { lastUsedAt: now, lastUsedIp: ip ?? null },
    });
  }
  return {
    id: row.id,
    label: row.label,
    userId: row.userId,
    role: row.user.role,
    apps: new Set(row.apps.map((a) => a.app.name)),
  };
}
