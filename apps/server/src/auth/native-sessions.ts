// Native sessions (SHP-T-10.2, the D3 App contract): D3 Constellation signs in without a browser.
// A native session is an ordinary `session` row — the sessions list shows it, ending it deletes it,
// every route resolves it — marked `native`, named by its device, and reached with a Bearer access
// token instead of the cookie. The access token is the row's `token_hash`: fifteen minutes, never
// slid, replaced on every refresh. Refresh tokens rotate through `native_refresh`, and a replaced
// one presented again is reuse: the session ends.
import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { refusal, type Refusal } from '@shipyard/schema';
import type { Db, Prisma } from '../db.js';
import { hashSessionToken } from './sessions.js';

/** The contract's ceiling for an access token: a phone is lost more often than a desk. */
export const NATIVE_ACCESS_MS = 15 * 60 * 1000;
/** A refresh token's window, renewed by every use (the contract's sliding thirty days). */
export const NATIVE_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
/** Approve, deny and rollback from a native session want proof this recent (SHP-T-10.3). */
export const STEP_UP_MS = 10 * 60 * 1000;

export interface Device {
  name: string;
  platform: string;
}

export interface NativeTokens {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  /** Seconds, as the contract carries it. */
  expiresIn: number;
}

const token = (): string => randomBytes(32).toString('base64url');

type Tx = Prisma.TransactionClient | Db;

export async function issueNativeSession(
  tx: Tx,
  input: { userId: string; method: 'password' | 'oidc'; device: Device | null; ip?: string | undefined; userAgent?: string | undefined; now: Date },
): Promise<NativeTokens> {
  const accessToken = token();
  const refreshToken = token();
  const row = await tx.session.create({
    data: {
      userId: input.userId,
      createdAt: input.now,
      tokenHash: hashSessionToken(accessToken),
      expiresAt: new Date(input.now.getTime() + NATIVE_ACCESS_MS),
      method: input.method,
      native: true,
      deviceName: input.device?.name.slice(0, 120) ?? null,
      devicePlatform: input.device?.platform.slice(0, 40) ?? null,
      ...(input.ip !== undefined ? { ip: input.ip } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent.slice(0, 512) } : {}),
    },
  });
  await tx.nativeRefresh.create({
    data: {
      sessionId: row.id,
      tokenHash: hashSessionToken(refreshToken),
      createdAt: input.now,
      expiresAt: new Date(input.now.getTime() + NATIVE_REFRESH_MS),
    },
  });
  return { sessionId: row.id, accessToken, refreshToken, expiresIn: NATIVE_ACCESS_MS / 1000 };
}

export type Rotation =
  | { kind: 'rotated'; tokens: NativeTokens; userId: string }
  | { kind: 'reused'; sessionId: string; userId: string }
  | { kind: 'ended' };

/**
 * Exchange a refresh token for a new pair. The presented row is claimed with a conditional update,
 * so two refreshes racing with one token cannot both succeed: the loser sees it replaced, which is
 * reuse, and the session ends — exactly what a stolen token racing its owner should cause.
 */
export async function rotateNativeSession(db: Db, refreshToken: string, now: Date): Promise<Rotation> {
  const presented = await db.nativeRefresh.findUnique({
    where: { tokenHash: hashSessionToken(refreshToken) },
    include: { session: { select: { id: true, userId: true, user: { select: { disabledAt: true } } } } },
  });
  if (presented === null || presented.expiresAt.getTime() <= now.getTime() || presented.session.user.disabledAt !== null) {
    return { kind: 'ended' };
  }
  const { id: sessionId, userId } = presented.session;
  if (presented.replacedAt !== null) return { kind: 'reused', sessionId, userId };
  return db.$transaction(async (tx) => {
    const { count } = await tx.nativeRefresh.updateMany({ where: { id: presented.id, replacedAt: null }, data: { replacedAt: now } });
    if (count !== 1) return { kind: 'reused', sessionId, userId } as const;
    const accessToken = token();
    const next = token();
    await tx.session.update({
      where: { id: sessionId },
      data: { tokenHash: hashSessionToken(accessToken), expiresAt: new Date(now.getTime() + NATIVE_ACCESS_MS) },
    });
    await tx.nativeRefresh.create({
      data: { sessionId, tokenHash: hashSessionToken(next), createdAt: now, expiresAt: new Date(now.getTime() + NATIVE_REFRESH_MS) },
    });
    return { kind: 'rotated', userId, tokens: { sessionId, accessToken, refreshToken: next, expiresIn: NATIVE_ACCESS_MS / 1000 } } as const;
  });
}

/**
 * The sessions still signed in at `now`, for the sessions list (SHP-T-10.4). A native row expires
 * with its fifteen-minute access token while the device stays signed in as long as its refresh
 * token is live — so an idle phone stays listed, and so stays revocable. A D3 Auth token's row (native,
 * no refresh) is governed by D3 Auth and never listed here.
 */
export function liveSessionWhere(now: Date): Prisma.SessionWhereInput {
  return {
    OR: [
      { native: false, expiresAt: { gt: now } },
      { native: true, refreshes: { some: { replacedAt: null, expiresAt: { gt: now } } } },
    ],
  };
}

/** The Bearer token in a request, if it carries one. */
export function bearerOf(authorization: string | undefined): string | null {
  const match = /^Bearer (\S+)$/i.exec((authorization ?? '').trim());
  return match?.[1] ?? null;
}

/**
 * Approve, deny and rollback from a native session need a step-up from the last ten minutes
 * (SHP-T-10.3) — a phone left unlocked on a desk must not be enough to ship to production. The
 * console's sessions are unchanged, and an API token never reaches an approval at all.
 */
export function staleStepUp(req: Request, now: number = Date.now()): Refusal | null {
  const session = req.nativeSession;
  if (session === undefined) return null;
  if (session.stepUpAt !== null && now - session.stepUpAt.getTime() <= STEP_UP_MS) return null;
  return refusal('step_up_required', 'Confirm it’s you before approving, denying or rolling back.', 'Enter a code from your authenticator, then retry within ten minutes.');
}
