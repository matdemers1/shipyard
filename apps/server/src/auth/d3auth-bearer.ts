// D3 Auth access tokens as Bearer credentials (SHP-T-10.2, the D3 App contract).
//
// D3 Constellation signs a person in to D3 Auth once and asks it for a token whose audience is this
// Shipyard (RFC 8707). That token is checked against the provider's published keys, for the
// configured issuer, for this origin as audience and for time (a minute of leeway, as the contract
// allows) — then mapped to an account by the (iss, sub) identity and nothing else, never by email.
//
// A verified, linked token becomes a session row keyed by its hash and expiring with it, so every
// route, the event streams and step-up treat it as any other native session. Those rows are
// governed by D3 Auth — revoking the device there is what ends them — so the sessions list shows
// only the sessions Shipyard issued itself.
import { ALLOWED_ALGORITHMS } from '@d3cloudio/auth-client';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Db } from '../db.js';
import { hashSessionToken } from './sessions.js';

export const LEEWAY_SECONDS = 60;

export interface VerifiedToken {
  issuer: string;
  subject: string;
  expiresAt: Date;
}

type KeysFor = (issuer: string) => JWTVerifyGetKey;
const resolvers = new Map<string, JWTVerifyGetKey>();
const remoteKeys: KeysFor = (issuer) => {
  const known = resolvers.get(issuer);
  if (known !== undefined) return known;
  // Where D3 Auth publishes its keys; jose caches them and refetches, rate-limited, on a new kid.
  const made = createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, '')}/oidc/jwks`));
  resolvers.set(issuer, made);
  return made;
};
let keysFor: KeysFor = remoteKeys;

/** Tests answer with a local key set; null restores the provider's. */
export function setKeysForTesting(fn: KeysFor | null): void {
  keysFor = fn ?? remoteKeys;
}

/** A JWT with one of the provider's algorithms. Shipyard's own tokens are opaque and never are. */
export function looksLikeProviderToken(token: string): boolean {
  if (token.split('.').length !== 3) return false;
  try {
    return (ALLOWED_ALGORITHMS as readonly string[]).includes(decodeProtectedHeader(token).alg ?? '');
  } catch {
    return false;
  }
}

/** A D3 Auth token for this Shipyard, checked completely; null for anything else. */
export async function verifyD3AuthToken(issuer: string | null, token: string, resource: string, now: Date = new Date()): Promise<VerifiedToken | null> {
  if (issuer === null || !looksLikeProviderToken(token)) return null;
  try {
    const { payload } = await jwtVerify(token, keysFor(issuer), {
      issuer,
      audience: resource,
      algorithms: [...ALLOWED_ALGORITHMS],
      clockTolerance: LEEWAY_SECONDS,
      currentDate: now,
      requiredClaims: ['exp', 'iss', 'aud', 'sub'],
    });
    return { issuer, subject: String(payload.sub), expiresAt: new Date((payload.exp ?? 0) * 1000) };
  } catch {
    return null;
  }
}

export type Materialized = { kind: 'session'; sessionId: string; userId: string } | { kind: 'unlinked' } | { kind: 'invalid' };

/** A verified, linked token becomes a session row once; the same token again finds that row. */
export async function materializeD3AuthSession(
  db: Db,
  verified: VerifiedToken,
  token: string,
  client: { ip?: string | undefined; userAgent?: string | undefined },
  now: Date = new Date(),
): Promise<Materialized> {
  const identity = await db.identity.findUnique({
    where: { issuer_subject: { issuer: verified.issuer, subject: verified.subject } },
    include: { user: { select: { id: true, disabledAt: true } } },
  });
  if (identity === null) return { kind: 'unlinked' };
  if (identity.user.disabledAt !== null) return { kind: 'invalid' };
  const tokenHash = hashSessionToken(token);
  const existing = await db.session.findUnique({ where: { tokenHash }, select: { id: true } });
  if (existing !== null) return { kind: 'session', sessionId: existing.id, userId: identity.userId };
  try {
    const row = await db.$transaction(async (tx) => {
      // The last token's row, long expired: tidied here rather than by a sweeper.
      await tx.session.deleteMany({ where: { userId: identity.userId, native: true, d3authIssuer: { not: null }, expiresAt: { lt: now } } });
      await tx.identity.update({ where: { id: identity.id }, data: { lastUsedAt: now } });
      return tx.session.create({
        data: {
          userId: identity.userId,
          createdAt: now,
          tokenHash,
          expiresAt: verified.expiresAt,
          method: 'oidc',
          native: true,
          d3authIssuer: verified.issuer,
          ...(client.ip !== undefined ? { ip: client.ip } : {}),
          ...(client.userAgent !== undefined ? { userAgent: client.userAgent.slice(0, 512) } : {}),
        },
      });
    });
    return { kind: 'session', sessionId: row.id, userId: identity.userId };
  } catch (error) {
    // Two requests carrying a new token at once: one row wins, and both are served by it.
    if ((error as { code?: string }).code !== 'P2002') throw error;
    const raced = await db.session.findUniqueOrThrow({ where: { tokenHash }, select: { id: true } });
    return { kind: 'session', sessionId: raced.id, userId: identity.userId };
  }
}
