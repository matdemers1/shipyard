import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db.js';

/** 12 hours, absolute: a session is never extended by use. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** `lastSeenAt` is bookkeeping; bumping it at most once a minute keeps reads from becoming writes. */
export const LAST_SEEN_RESOLUTION_MS = 60 * 1000;

export type SessionMethod = 'password' | 'oidc';

/** Only this hash is stored; the token itself exists in the cookie and nowhere else. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreatedSession {
  id: string;
  token: string;
  expiresAt: Date;
}

export async function createSession(
  db: Db,
  input: { userId: string; method: SessionMethod; ip?: string | undefined; userAgent?: string | undefined },
): Promise<CreatedSession> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const row = await db.session.create({
    data: {
      userId: input.userId,
      tokenHash: hashSessionToken(token),
      expiresAt,
      method: input.method,
      ...(input.ip !== undefined ? { ip: input.ip } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent.slice(0, 512) } : {}),
    },
  });
  return { id: row.id, token, expiresAt };
}

export interface ResolvedSession {
  sessionId: string;
  user: { id: string; email: string };
}

/** The session and its user, when the token is known, unexpired, and the user is not disabled. */
export async function resolveSession(db: Db, token: string, now: Date = new Date()): Promise<ResolvedSession | null> {
  const row = await db.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: { select: { id: true, email: true, disabledAt: true } } },
  });
  if (row === null) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  if (row.user.disabledAt !== null) return null;

  if (row.lastSeenAt === null || now.getTime() - row.lastSeenAt.getTime() >= LAST_SEEN_RESOLUTION_MS) {
    await db.session.update({ where: { id: row.id }, data: { lastSeenAt: now } });
  }
  return { sessionId: row.id, user: { id: row.user.id, email: row.user.email } };
}
