import { randomBytes } from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { LoginRequest, TotpRequest, refusal, type Refusal } from '@shipyard/schema';
import type { Logger } from 'pino';
import { ANONYMOUS_ACTOR, type Actor } from '../audit.js';
import type { Config } from '../config.js';
import { Prisma, type Db } from '../db.js';
import { sendRefusal } from '../errors.js';
import {
  MFA_COOKIE,
  OIDC_TX_COOKIE,
  SESSION_COOKIE,
  clearCookie,
  readCookie,
  resolveSessionSecret,
  setCookie,
  signMfaTicket,
  verifyMfaTicket,
} from './cookies.js';
import { OIDC_TX_TTL_MS, OidcError, type OidcClient } from './oidc.js';
import { verifyAgainstDummy, verifyPassword } from './passwords.js';
import { SESSION_TTL_MS, createSession, hashSessionToken, resolveSession } from './sessions.js';
import { TotpReplayGuard } from './totp.js';

// Helpers other tasks import (SHP-T-0.6 bootstrap-admin, tests).
export { hashPassword, verifyPassword } from './passwords.js';
export { generateTotpSecret, totpCode, totpUri, verifyTotp, TotpReplayGuard } from './totp.js';
export { createSession, hashSessionToken, resolveSession, SESSION_TTL_MS } from './sessions.js';
export { createOidcClient, OidcError, PendingSignIns, type CompletedSignIn, type OidcClient } from './oidc.js';
export { SESSION_COOKIE, MFA_COOKIE, OIDC_TX_COOKIE } from './cookies.js';

export interface AuthDeps {
  db: Db;
  logger: Logger;
  config: Config;
  /** Sign in with D3 Auth, or null when it is unconfigured or discovery failed at boot. */
  oidc: OidcClient | null;
}

/** The password step is good for five minutes, and for this many TOTP guesses. */
const MFA_TTL_MS = 5 * 60 * 1000;
const MFA_MAX_ATTEMPTS = 5;
const OIDC_COOKIE_PATH = '/api/auth/oidc';

const BAD_CREDENTIALS = refusal(
  'unauthenticated',
  'The email or password is wrong.',
  'Check both and try again.',
);
const BAD_TOTP = refusal(
  'unauthenticated',
  'The authenticator code is wrong or has already been used.',
  'Enter the current code from your authenticator app.',
);
const NO_MFA_TICKET = refusal(
  'unauthenticated',
  'There is no password step in progress for this browser, or it has expired.',
  'Sign in with your email and password first, then enter the code within five minutes.',
);
const DISABLED = refusal('unauthenticated', 'This account is disabled.', 'Ask an admin to re-enable it.');
const TOTP_NOT_ENROLLED = refusal(
  'unauthenticated',
  'This account has no authenticator enrolled, and password sign-in requires one.',
  'An operator must run the bootstrap-admin CLI on the server to enrol TOTP for this account.',
);
const OIDC_UNAVAILABLE = refusal(
  'invalid_request',
  'Sign in with D3 Auth is not available on this server.',
  'Sign in with your password and authenticator code, or set D3AUTH_ISSUER, D3AUTH_CLIENT_ID and PUBLIC_URL and restart.',
);
const NOT_LINKED = refusal(
  'unauthenticated',
  'No Shipyard account is linked to this D3 Auth identity.',
  'Sign in with your password and authenticator code, then use Sign in with D3 Auth to link it. Accounts are never matched by email.',
);
const IDENTITY_TAKEN = refusal(
  'conflict',
  'This D3 Auth identity is already linked to a different Shipyard account.',
  'Sign in as that account, or unlink the identity there first.',
);

function userActor(user: { id: string; email: string }): Actor {
  return { type: 'user', id: user.id, label: user.email };
}

function clientInfo(req: Request): { ip: string | undefined; userAgent: string | undefined } {
  return { ip: req.ip, userAgent: req.get('user-agent') };
}

/**
 * Resolves the session cookie into `req.actor`, before any route runs. An absent, unknown,
 * expired or disabled-user session simply leaves `req.actor` unset; `requireUser` refuses later.
 */
export function authenticate(deps: AuthDeps): RequestHandler {
  return async (req, _res, next) => {
    // Seam for API tokens (a later phase): an `Authorization: Bearer` header resolves here into
    // `req.actor = { type: 'token', ... }`. Until then it is ignored and only the cookie counts.
    const token = readCookie(req, SESSION_COOKIE);
    if (token !== undefined && token !== '') {
      const resolved = await resolveSession(deps.db, token);
      if (resolved !== null) req.actor = userActor(resolved.user);
    }
    next();
  };
}

/** 401 `unauthenticated` unless a signed-in user made the request. */
export const requireUser: RequestHandler = (req, res, next) => {
  if (req.actor?.type !== 'user' || req.actor.id === undefined) {
    sendRefusal(res, refusal('unauthenticated', 'You are not signed in.'));
    return;
  }
  next();
};

/** Mounted at `/api/auth`. There is no signup route, by design (SHP-REQ-101). */
export function authRouter(deps: AuthDeps): Router {
  const { db, logger, config, oidc } = deps;
  const secret = resolveSessionSecret(config, logger);
  const replay = new TotpReplayGuard();
  const mfaAttempts = new Map<string, { count: number; expiresAt: number }>();
  const router = Router();

  async function fail(
    req: Request,
    res: Response,
    r: Refusal,
    detail: { action?: string; reason: string; entityId?: string; after?: Record<string, unknown> },
  ): Promise<void> {
    await req.audit({
      action: detail.action ?? 'auth.login.failed',
      entityType: 'user',
      ...(detail.entityId !== undefined ? { entityId: detail.entityId } : {}),
      after: { reason: detail.reason, ...detail.after },
      actor: ANONYMOUS_ACTOR,
    });
    sendRefusal(res, r);
  }

  async function startSession(
    req: Request,
    res: Response,
    user: { id: string; email: string },
    method: 'password' | 'oidc',
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const session = await createSession(db, { userId: user.id, method, ...clientInfo(req) });
    setCookie(res, config, SESSION_COOKIE, session.token, { maxAgeMs: SESSION_TTL_MS });
    await req.audit({
      action: 'auth.login.succeeded',
      entityType: 'session',
      entityId: session.id,
      after: { method, userId: user.id, expiresAt: session.expiresAt.toISOString(), ...extra },
      actor: userActor(user),
    });
  }

  function sweepAttempts(now: number): void {
    for (const [key, value] of mfaAttempts) if (value.expiresAt <= now) mfaAttempts.delete(key);
  }

  // ── Password, step 1 ────────────────────────────────────────────────
  router.post('/login', async (req, res) => {
    const parsed = LoginRequest.safeParse(req.body);
    if (!parsed.success) {
      await fail(req, res, refusal('invalid_request', 'An email and a password are required.'), {
        reason: 'invalid_request',
      });
      return;
    }
    const { email, password } = parsed.data;
    const user = await db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });

    const ok =
      user !== null && user.passwordHash !== null
        ? await verifyPassword(user.passwordHash, password)
        : await verifyAgainstDummy(password);
    if (user === null || !ok) {
      await fail(req, res, BAD_CREDENTIALS, {
        reason: 'bad_credentials',
        ...(user !== null ? { entityId: user.id } : {}),
        after: { method: 'password', email },
      });
      return;
    }
    if (user.disabledAt !== null) {
      await fail(req, res, DISABLED, { reason: 'disabled', entityId: user.id, after: { method: 'password' } });
      return;
    }
    if (user.totpSecret === null || user.totpEnabledAt === null) {
      await fail(req, res, TOTP_NOT_ENROLLED, {
        reason: 'totp_not_enrolled',
        entityId: user.id,
        after: { method: 'password' },
      });
      return;
    }

    const ticket = { userId: user.id, nonce: randomBytes(16).toString('base64url'), expiresAt: Date.now() + MFA_TTL_MS };
    setCookie(res, config, MFA_COOKIE, signMfaTicket(secret, ticket), { maxAgeMs: MFA_TTL_MS, path: '/api/auth' });
    await req.audit({
      action: 'auth.login.password_verified',
      entityType: 'user',
      entityId: user.id,
      after: { next: 'totp' },
      actor: userActor(user),
    });
    res.json({ next: 'totp' });
  });

  // ── Password, step 2: TOTP ──────────────────────────────────────────
  router.post('/totp', async (req, res) => {
    const now = Date.now();
    const raw = readCookie(req, MFA_COOKIE);
    const ticket = raw === undefined ? null : verifyMfaTicket(secret, raw, now);
    if (ticket === null) {
      await fail(req, res, NO_MFA_TICKET, { reason: 'no_mfa_ticket', after: { method: 'password' } });
      return;
    }

    sweepAttempts(now);
    const attempts = mfaAttempts.get(ticket.nonce) ?? { count: 0, expiresAt: ticket.expiresAt };
    attempts.count += 1;
    mfaAttempts.set(ticket.nonce, attempts);
    if (attempts.count > MFA_MAX_ATTEMPTS) {
      clearCookie(res, config, MFA_COOKIE, '/api/auth');
      await fail(req, res, NO_MFA_TICKET, { reason: 'too_many_totp_attempts', entityId: ticket.userId });
      return;
    }

    const parsed = TotpRequest.safeParse(req.body);
    if (!parsed.success) {
      await fail(req, res, refusal('invalid_request', 'A six-digit code is required.'), {
        reason: 'invalid_request',
        entityId: ticket.userId,
      });
      return;
    }

    const user = await db.user.findUnique({ where: { id: ticket.userId } });
    if (user === null || user.disabledAt !== null) {
      await fail(req, res, DISABLED, { reason: 'disabled', entityId: ticket.userId, after: { method: 'password' } });
      return;
    }
    if (user.totpSecret === null || user.totpEnabledAt === null) {
      await fail(req, res, TOTP_NOT_ENROLLED, { reason: 'totp_not_enrolled', entityId: user.id });
      return;
    }
    if (!replay.consume(user.id, user.totpSecret, parsed.data.code, now)) {
      await fail(req, res, BAD_TOTP, { reason: 'bad_totp', entityId: user.id, after: { method: 'password' } });
      return;
    }

    mfaAttempts.delete(ticket.nonce);
    clearCookie(res, config, MFA_COOKIE, '/api/auth');
    await startSession(req, res, user, 'password');
    res.json({ id: user.id, email: user.email, displayName: user.displayName, role: user.role });
  });

  // ── Session ─────────────────────────────────────────────────────────
  router.get('/me', requireUser, async (req, res) => {
    const user = await db.user.findUnique({
      where: { id: req.actor?.id ?? '' },
      include: { identities: { select: { issuer: true }, orderBy: { createdAt: 'asc' } } },
    });
    if (user === null) {
      sendRefusal(res, refusal('unauthenticated', 'You are not signed in.'));
      return;
    }
    res.json({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      identities: user.identities.map((i) => ({ issuer: i.issuer })),
    });
  });

  router.post('/logout', requireUser, async (req, res) => {
    const token = readCookie(req, SESSION_COOKIE) ?? '';
    const session = await db.session.findUnique({ where: { tokenHash: hashSessionToken(token) } });
    if (session !== null) await db.session.delete({ where: { id: session.id } });
    clearCookie(res, config, SESSION_COOKIE);
    await req.audit({
      action: 'auth.logout',
      entityType: 'session',
      ...(session !== null ? { entityId: session.id } : {}),
    });
    res.json({ ok: true });
  });

  // ── Sign in with D3 Auth ────────────────────────────────────────────
  router.get('/oidc/start', async (req, res) => {
    if (oidc === null) {
      sendRefusal(res, OIDC_UNAVAILABLE);
      return;
    }
    // A browser that is already signed in is linking this identity to its account.
    const linkToUserId = req.actor?.type === 'user' ? req.actor.id : undefined;
    let started;
    try {
      started = await oidc.beginSignIn(linkToUserId);
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'OIDC sign-in could not start');
      sendRefusal(res, OIDC_UNAVAILABLE);
      return;
    }
    setCookie(res, config, OIDC_TX_COOKIE, started.tx, { maxAgeMs: OIDC_TX_TTL_MS, path: OIDC_COOKIE_PATH });
    res.redirect(302, started.url);
  });

  router.get('/oidc/callback', async (req, res) => {
    if (oidc === null) {
      sendRefusal(res, OIDC_UNAVAILABLE);
      return;
    }
    const tx = readCookie(req, OIDC_TX_COOKIE);
    clearCookie(res, config, OIDC_TX_COOKIE, OIDC_COOKIE_PATH);
    const state = typeof req.query['state'] === 'string' ? req.query['state'] : undefined;
    if (tx === undefined || state === undefined) {
      await fail(req, res, refusal('invalid_request', 'No D3 Auth sign-in is in progress for this browser.', 'Start again from the sign-in page.'), {
        reason: 'oidc_no_transaction',
        after: { method: 'oidc' },
      });
      return;
    }

    const base = config.PUBLIC_URL ?? `${req.protocol}://${req.get('host') ?? 'localhost'}`;
    let result;
    try {
      result = await oidc.completeSignIn(new URL(req.originalUrl, base), tx, state);
    } catch (error) {
      if (!(error instanceof OidcError)) throw error;
      await fail(req, res, refusal('unauthenticated', `D3 Auth sign-in failed: ${error.message}`, 'Start again from the sign-in page.'), {
        reason: 'oidc_failed',
        after: { method: 'oidc' },
      });
      return;
    }

    const { iss, sub, linkToUserId } = result;
    const who = { method: 'oidc', issuer: iss, subject: sub };

    // A link must finish in the same signed-in session that started it.
    if (linkToUserId !== undefined && req.actor?.id !== linkToUserId) {
      await fail(req, res, refusal('unauthenticated', 'The session that started this link has ended.', 'Sign in again, then link D3 Auth.'), {
        action: 'auth.identity.link_failed',
        reason: 'link_session_ended',
        entityId: linkToUserId,
        after: who,
      });
      return;
    }

    // Identity is (iss, sub) and nothing else. The email claim is never consulted for matching.
    const existing = await db.identity.findUnique({
      where: { issuer_subject: { issuer: iss, subject: sub } },
      include: { user: true },
    });

    if (existing !== null) {
      if (linkToUserId !== undefined && existing.userId !== linkToUserId) {
        await fail(req, res, IDENTITY_TAKEN, {
          action: 'auth.identity.link_failed',
          reason: 'identity_linked_elsewhere',
          entityId: linkToUserId,
          after: who,
        });
        return;
      }
      if (existing.user.disabledAt !== null) {
        await fail(req, res, DISABLED, { reason: 'disabled', entityId: existing.userId, after: who });
        return;
      }
      await db.identity.update({ where: { id: existing.id }, data: { lastUsedAt: new Date() } });
      // Linking an identity that is already this user's is a no-op; the session stays as it is.
      if (linkToUserId === undefined) await startSession(req, res, existing.user, 'oidc', { issuer: iss });
      res.redirect(302, '/');
      return;
    }

    if (linkToUserId === undefined) {
      // Not linked, and not a link: refuse. No account is ever created or matched here (SHP-REQ-101).
      await fail(req, res, NOT_LINKED, { reason: 'identity_not_linked', after: who });
      return;
    }

    let identity;
    try {
      identity = await db.identity.create({
        data: {
          userId: linkToUserId,
          issuer: iss,
          subject: sub,
          lastUsedAt: new Date(),
          ...(result.email !== undefined ? { emailAtLink: result.email } : {}),
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        await fail(req, res, IDENTITY_TAKEN, {
          action: 'auth.identity.link_failed',
          reason: 'identity_linked_elsewhere',
          entityId: linkToUserId,
          after: who,
        });
        return;
      }
      throw error;
    }
    await req.audit({
      action: 'auth.identity.linked',
      entityType: 'identity',
      entityId: identity.id,
      after: { userId: linkToUserId, issuer: iss, subject: sub, emailAtLink: identity.emailAtLink },
    });
    res.redirect(302, '/');
  });

  return router;
}
