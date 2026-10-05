import { createHash, randomBytes } from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { LoginRequest, TotpRequest, refusal, type Refusal } from '@shipyard/schema';
import type { Logger } from 'pino';
import { ANONYMOUS_ACTOR, type Actor } from '../audit.js';
import type { Config } from '../config.js';
import { Prisma, type Db } from '../db.js';
import { sendProblem, sendRefusal } from '../errors.js';
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
import type { OidcSource } from './oidc-settings.js';
import { verifyAgainstDummy, verifyPassword } from './passwords.js';
import { SESSION_TTL_MS, createSession, hashSessionToken, resolveSession } from './sessions.js';
import { MfaTickets } from './tickets.js';
import { DEFAULT_ACCOUNT_GLOBAL_LIMITS,
  DEFAULT_ACCOUNT_LIMITS, DEFAULT_IP_LIMITS, Throttle, type ThrottleLimits } from './throttle.js';
import { TotpReplayGuard } from './totp.js';
import { resolveToken } from '../tokens/tokens.js';
import { looksLikeProviderToken, materializeD3AuthSession, verifyD3AuthToken } from './d3auth-bearer.js';
import { STEP_UP_MS, bearerOf, issueNativeSession, liveSessionWhere, rotateNativeSession, type Device, type NativeTokens } from './native-sessions.js';
import { requestDeletion } from '../users/deletion.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** A native app's session (SHP-P-10): its row, and when it last stepped up. */
      nativeSession?: { id: string; stepUpAt: Date | null };
      /** The console's own session row, for the sessions list's "this browser". */
      consoleSessionId?: string;
    }
  }
}

/** This Shipyard's origin: the audience D3 Auth mints its tokens for (SHP-T-10.2). */
export function publicOrigin(config: Config, req: Request): string {
  return new URL(config.PUBLIC_URL ?? `${req.protocol}://${req.get('host') ?? 'localhost'}`).origin;
}

// Helpers other tasks import (SHP-T-0.6 bootstrap-admin, tests).
export { hashPassword, verifyPassword } from './passwords.js';
export { generateTotpSecret, totpCode, totpUri, verifyTotp, TotpReplayGuard } from './totp.js';
export { createSession, hashSessionToken, resolveSession, SESSION_TTL_MS } from './sessions.js';
export { createOidcClient, OidcError, PendingSignIns, type CompletedSignIn, type OidcClient } from './oidc.js';
export { OidcSettings, type OidcSource } from './oidc-settings.js';
export { SESSION_COOKIE, MFA_COOKIE, OIDC_TX_COOKIE } from './cookies.js';
export { Throttle, DEFAULT_ACCOUNT_LIMITS, DEFAULT_IP_LIMITS, type ThrottleLimits } from './throttle.js';
export { assertCanActOn, assertCanChangeState, requireRole, STATE_CHANGING_ROLES, type Role } from './scope.js';

export interface AuthDeps {
  db: Db;
  logger: Logger;
  config: Config;
  /**
   * Sign in with D3 Auth: a fixed client, or a source read per request (the console's Settings swap
   * it without a restart, SHP-REQ-110). Null, or a source yielding null, means password only.
   */
  oidc: OidcClient | OidcSource | null;
  /** Failed-attempt throttling (SHP-REQ-108). Defaults apply when absent; tests pass small limits and a clock. */
  throttle?: {
    account?: ThrottleLimits;
    accountGlobal?: ThrottleLimits;
    ip?: ThrottleLimits;
    now?: () => number;
  };
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
  'Sign in with your password and authenticator code. An admin can configure D3 Auth in Settings.',
);
const NOT_LINKED = refusal(
  'unauthenticated',
  'No Shipyard account is linked to this D3 Auth identity.',
  'Sign in with your password and authenticator code, then use Sign in with D3 Auth to link it. Accounts are never matched by email.',
);
const THROTTLED = refusal(
  'too_many_attempts',
  'Too many failed sign-in attempts. Sign-in is paused for a while.',
  'Wait for the cooling-off period (up to fifteen minutes), then try again.',
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

const BAD_BEARER = refusal(
  'unauthenticated',
  'The API token is malformed, unknown or revoked.',
  'Send `Authorization: Bearer shp_…` with a live token, or issue a new one in the console.',
);

/**
 * Resolves the request's credentials into `req.actor`, before any route runs.
 *
 * An `Authorization` header must be a live API token (SHP-REQ-046): a malformed, unknown or
 * revoked one is refused with 401 at once, never treated as anonymous. Otherwise an absent,
 * unknown, expired or disabled-user session simply leaves `req.actor` unset; `requireUser`
 * refuses later.
 */
export function authenticate(deps: AuthDeps): RequestHandler {
  const oidcSource = oidcSourceOf(deps.oidc);
  return async (req, res, next) => {
    const authorization = req.headers.authorization;
    const bearer = bearerOf(authorization);
    // Not an API token: a native app's session, or a D3 Auth token (SHP-T-10.2). Anything else is
    // refused at once, never treated as anonymous.
    if (bearer !== null && !bearer.startsWith('shp_')) {
      const now = new Date();
      let session = await resolveSession(deps.db, bearer, now, 'bearer');
      if (session === null && looksLikeProviderToken(bearer)) {
        const resource = publicOrigin(deps.config, req);
        const verified = await verifyD3AuthToken(oidcSource.current()?.issuer ?? null, bearer, resource, now);
        if (verified !== null) {
          const made = await materializeD3AuthSession(deps.db, verified, bearer, clientInfo(req), now);
          // The one place an unlinked identity belongs: the link route, which proves the account.
          if (made.kind === 'unlinked' && req.path === '/api/auth/native/link') {
            next();
            return;
          }
          if (made.kind === 'unlinked') {
            sendProblem(res, 401, refusal('unauthenticated', 'This D3 Auth account is not linked to a Shipyard account.', 'Link it once with your Shipyard email, password and authenticator code.'), {
              type: 'https://d3cloud.io/problems/identity_not_linked',
            });
            return;
          }
          if (made.kind === 'session') session = await resolveSession(deps.db, bearer, now, 'bearer');
        }
      }
      if (session === null) {
        sendProblem(res, 401, refusal('unauthenticated', 'This sign-in has ended.', 'Sign in again.'));
        return;
      }
      req.actor = userActor(session.user);
      req.nativeSession = { id: session.sessionId, stepUpAt: session.stepUpAt };
      const user = await deps.db.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
      if (user !== null) req.role = user.role;
      next();
      return;
    }
    if (authorization !== undefined) {
      const match = /^Bearer (\S+)$/i.exec(authorization.trim());
      const resolved = match?.[1] === undefined ? null : await resolveToken(deps.db, match[1], req.ip);
      if (resolved === null) {
        sendRefusal(res, BAD_BEARER);
        return;
      }
      req.actor = { type: 'token', id: resolved.id, label: `token ${resolved.label}` };
      req.role = resolved.role;
      req.tokenApps = resolved.apps;
      next();
      return;
    }

    const token = readCookie(req, SESSION_COOKIE);
    if (token !== undefined && token !== '') {
      const resolved = await resolveSession(deps.db, token);
      if (resolved !== null) {
        req.actor = userActor(resolved.user);
        req.consoleSessionId = resolved.sessionId;
        // The role is read per request, so a demotion takes effect at once (SHP-REQ-065).
        const user = await deps.db.user.findUnique({ where: { id: resolved.user.id }, select: { role: true } });
        if (user !== null) req.role = user.role;
      }
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

/** A fixed client (or none) as a source, so every route reads D3 Auth the same way. */
export function oidcSourceOf(oidc: AuthDeps['oidc']): OidcSource {
  if (oidc === null) return { current: () => null };
  if ('current' in oidc) return oidc;
  return { current: () => oidc };
}

/** Mounted at `/api/auth`. There is no signup route, by design (SHP-REQ-101). */
export function authRouter(deps: AuthDeps): Router {
  const { db, logger, config } = deps;
  const oidcSource = oidcSourceOf(deps.oidc);
  const secret = resolveSessionSecret(config, logger);
  const replay = new TotpReplayGuard();
  const mfaAttempts = new Map<string, { count: number; expiresAt: number }>();
  const tickets = new MfaTickets();
  const clock = deps.throttle?.now;
  const accountThrottle = new Throttle({
    limits: deps.throttle?.account ?? DEFAULT_ACCOUNT_LIMITS,
    ...(clock !== undefined ? { now: clock } : {}),
  });
  const accountGlobalThrottle = new Throttle({
    limits: deps.throttle?.accountGlobal ?? DEFAULT_ACCOUNT_GLOBAL_LIMITS,
    ...(clock !== undefined ? { now: clock } : {}),
  });
  const ipThrottle = new Throttle({
    limits: deps.throttle?.ip ?? DEFAULT_IP_LIMITS,
    ...(clock !== undefined ? { now: clock } : {}),
  });
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

  const accountKey = (email: string): string => email.trim().toLowerCase();
  const emailHashOf = (email: string): string => createHash('sha256').update(accountKey(email)).digest('hex').slice(0, 16);
  const ipKey = (req: Request): string => req.ip ?? 'unknown';

  function recordFailure(req: Request, email: string): void {
    // The tight limit is per account *and* address, so a stranger can only lock themselves out; the
    // loose per-account ceiling still caps guesses spread across many addresses.
    accountThrottle.recordFailure(`${accountKey(email)}|${ipKey(req)}`);
    accountGlobalThrottle.recordFailure(accountKey(email));
    ipThrottle.recordFailure(ipKey(req));
  }

  /**
   * Refuses (and audits) when the source address, or the account when named, is cooling off. The
   * refusal is the same whichever it is and whether the account exists, so it says nothing about
   * which emails are real. The email is logged only as a short hash.
   */
  async function refuseIfThrottled(
    req: Request,
    res: Response,
    step: 'password' | 'totp',
    email: string | undefined,
    entityId?: string,
  ): Promise<boolean> {
    const scope =
      ipThrottle.blockedUntil(ipKey(req)) !== null
        ? 'ip'
        : email !== undefined &&
            (accountThrottle.blockedUntil(`${accountKey(email)}|${ipKey(req)}`) !== null ||
              accountGlobalThrottle.blockedUntil(accountKey(email)) !== null)
          ? 'account'
          : null;
    if (scope === null) return false;
    const emailHash = email === undefined ? undefined : emailHashOf(email);
    logger.warn({ scope, step, ip: req.ip, emailHash }, 'sign-in throttled');
    await fail(req, res, THROTTLED, {
      action: 'auth.login.throttled',
      reason: 'too_many_attempts',
      ...(entityId !== undefined ? { entityId } : {}),
      after: { method: 'password', step, scope, ...(emailHash !== undefined ? { emailHash } : {}) },
    });
    return true;
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
    // Before any password work: a throttled attempt does not get to spend argon2 time.
    if (await refuseIfThrottled(req, res, 'password', email)) return;
    const user = await db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });

    const ok =
      user !== null && user.passwordHash !== null
        ? await verifyPassword(user.passwordHash, password)
        : await verifyAgainstDummy(password);
    if (user === null || !ok) {
      recordFailure(req, email);
      await fail(req, res, BAD_CREDENTIALS, {
        reason: 'bad_credentials',
        ...(user !== null ? { entityId: user.id } : {}),
        // A short hash, never the address: failed-login rows are read by anyone who reads the audit.
        after: { method: 'password', emailHash: emailHashOf(email) },
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

    const issuedAt = Date.now();
    const ticket = { userId: user.id, nonce: randomBytes(16).toString('base64url'), expiresAt: issuedAt + MFA_TTL_MS };
    // Latest ticket wins: any earlier password step for this user can no longer finish.
    tickets.issue(user.id, ticket.nonce, ticket.expiresAt, issuedAt);
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
    if (await refuseIfThrottled(req, res, 'totp', undefined)) return;
    const raw = readCookie(req, MFA_COOKIE);
    const ticket = raw === undefined ? null : verifyMfaTicket(secret, raw, now);
    if (ticket === null) {
      await fail(req, res, NO_MFA_TICKET, { reason: 'no_mfa_ticket', after: { method: 'password' } });
      return;
    }
    const ticketState = tickets.state(ticket, now);
    if (ticketState !== 'live') {
      clearCookie(res, config, MFA_COOKIE, '/api/auth');
      await fail(req, res, NO_MFA_TICKET, {
        reason: ticketState === 'spent' ? 'mfa_ticket_spent' : 'mfa_ticket_superseded',
        entityId: ticket.userId,
        after: { method: 'password' },
      });
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
    if (await refuseIfThrottled(req, res, 'totp', user.email, user.id)) return;
    if (!replay.consume(user.id, user.totpSecret, parsed.data.code, now)) {
      recordFailure(req, user.email);
      await fail(req, res, BAD_TOTP, { reason: 'bad_totp', entityId: user.id, after: { method: 'password' } });
      return;
    }
    // Spend the ticket before any await, so two concurrent requests holding it cannot both finish.
    if (!tickets.consume(ticket, now)) {
      clearCookie(res, config, MFA_COOKIE, '/api/auth');
      await fail(req, res, NO_MFA_TICKET, { reason: 'mfa_ticket_spent', entityId: user.id, after: { method: 'password' } });
      return;
    }

    mfaAttempts.delete(ticket.nonce);
    accountThrottle.reset(`${accountKey(user.email)}|${ipKey(req)}`);
    accountGlobalThrottle.reset(accountKey(user.email));
    clearCookie(res, config, MFA_COOKIE, '/api/auth');
    await startSession(req, res, user, 'password');
    res.json({ id: user.id, email: user.email, displayName: user.displayName, role: user.role });
  });

  // ── Sign-in methods (read-only, for the console's sign-in screen) ────
  // The D3 Auth button is shown only when the OIDC client exists, so a server without it never
  // offers a button that leads to a refusal. The password form is always available.
  router.get('/methods', (_req, res) => {
    res.json({ password: true, d3auth: oidcSource.current() !== null });
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
      // The D3 App contract's names for the same things (SHP-T-10.2), so the console and D3
      // Constellation read one answer.
      accountId: user.id,
      roles: [user.role],
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
    const oidc = oidcSource.current();
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
    const oidc = oidcSource.current();
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

  // ── The D3 App contract: native sessions (SHP-P-10) ──────────────────
  // Every refusal here is problem+json (errors.ts reads the path). The steps and protections are the
  // password sign-in's above — the same throttles, the same TOTP replay guard, the same audit actions
  // — and what differs is the envelope: tokens come back in JSON, never a cookie.
  const nativeChallenges = new Map<string, { userId: string; email: string; device: Device | null; expiresAt: number; attempts: number }>();
  const DeviceShape = z.object({ name: z.string().trim().min(1).max(120), platform: z.string().trim().min(1).max(40) });
  const NativeSignIn = z.union([
    z.object({ email: z.string().min(1).max(320), password: z.string().min(1).max(1024), device: DeviceShape.optional() }),
    z.object({ challenge: z.string().min(1).max(200), totp: z.string().min(1).max(16) }),
  ]);
  const problemOf = (name: string, title: string, status: number, extra: Record<string, unknown> = {}) => (res: Response) => {
    const type = name === 'about:blank' ? name : `https://d3cloud.io/problems/${name}`;
    res.status(status).type('application/problem+json').send(JSON.stringify({ type, title, status, ...extra }));
  };
  const tokensBody = (t: NativeTokens) => ({ accessToken: t.accessToken, refreshToken: t.refreshToken, expiresIn: t.expiresIn, session: { id: t.sessionId } });

  async function nativeFail(req: Request, res: Response, name: 'invalid_credentials' | 'invalid_code', userId: string | undefined, step: string): Promise<void> {
    await req.audit({
      action: 'auth.login.failed',
      entityType: 'user',
      ...(userId !== undefined ? { entityId: userId } : {}),
      after: { reason: name, method: 'password', step, via: 'native' },
      actor: ANONYMOUS_ACTOR,
    });
    problemOf(name, name === 'invalid_credentials' ? 'The email or password is wrong.' : 'That code didn’t work.', 401)(res);
  }

  /** The throttle, answered as the contract's problem with retryAfter in whole seconds. */
  async function nativeThrottled(req: Request, res: Response, email: string | undefined): Promise<boolean> {
    const keys = [ipThrottle.blockedUntil(ipKey(req))];
    if (email !== undefined) {
      keys.push(accountThrottle.blockedUntil(`${accountKey(email)}|${ipKey(req)}`), accountGlobalThrottle.blockedUntil(accountKey(email)));
    }
    const until = Math.max(...keys.map((k) => k ?? 0));
    if (until <= Date.now()) return false;
    const retryAfter = Math.max(1, Math.ceil((until - Date.now()) / 1000));
    await req.audit({ action: 'auth.login.throttled', entityType: 'user', after: { method: 'password', via: 'native' }, actor: ANONYMOUS_ACTOR });
    res.setHeader('Retry-After', String(retryAfter));
    problemOf('throttled', 'Too many attempts', 429, { retryAfter })(res);
    return true;
  }

  router.post('/native/signin', async (req, res) => {
    const parsed = NativeSignIn.safeParse(req.body);
    if (!parsed.success) {
      sendRefusal(res, refusal('invalid_request', 'That request is not a sign-in.'));
      return;
    }
    const body = parsed.data;
    const now = Date.now();
    if ('email' in body) {
      if (await nativeThrottled(req, res, body.email)) return;
      const user = await db.user.findFirst({ where: { email: { equals: body.email, mode: 'insensitive' } } });
      const ok = user !== null && user.passwordHash !== null ? await verifyPassword(user.passwordHash, body.password) : await verifyAgainstDummy(body.password);
      if (user === null || !ok || user.disabledAt !== null) {
        recordFailure(req, body.email);
        await nativeFail(req, res, 'invalid_credentials', user?.id, 'password');
        return;
      }
      if (user.totpSecret === null || user.totpEnabledAt === null) {
        await fail(req, res, TOTP_NOT_ENROLLED, { reason: 'totp_not_enrolled', entityId: user.id, after: { method: 'password', via: 'native' } });
        return;
      }
      const challenge = randomBytes(32).toString('base64url');
      for (const [key, value] of nativeChallenges) if (value.expiresAt <= now) nativeChallenges.delete(key);
      nativeChallenges.set(challenge, { userId: user.id, email: user.email, device: body.device ?? null, expiresAt: now + MFA_TTL_MS, attempts: 0 });
      await req.audit({ action: 'auth.login.password_verified', entityType: 'user', entityId: user.id, after: { next: 'totp', via: 'native' }, actor: userActor(user) });
      res.status(202).json({ next: 'totp', challenge });
      return;
    }

    const pending = nativeChallenges.get(body.challenge);
    if (pending === undefined || pending.expiresAt <= now) {
      nativeChallenges.delete(body.challenge);
      await nativeFail(req, res, 'invalid_code', undefined, 'totp');
      return;
    }
    if (await nativeThrottled(req, res, pending.email)) return;
    // Counted before anything slow, as on the web: the attempt is spent the moment it arrives.
    pending.attempts += 1;
    if (pending.attempts >= MFA_MAX_ATTEMPTS) nativeChallenges.delete(body.challenge);
    const user = await db.user.findUnique({ where: { id: pending.userId } });
    if (user === null || user.disabledAt !== null || user.totpSecret === null) {
      await nativeFail(req, res, 'invalid_code', pending.userId, 'totp');
      return;
    }
    if (!replay.consume(user.id, user.totpSecret, body.totp, now)) {
      recordFailure(req, user.email);
      await nativeFail(req, res, 'invalid_code', user.id, 'totp');
      return;
    }
    nativeChallenges.delete(body.challenge);
    accountThrottle.reset(`${accountKey(user.email)}|${ipKey(req)}`);
    accountGlobalThrottle.reset(accountKey(user.email));
    const tokens = await issueNativeSession(db, { userId: user.id, method: 'password', device: pending.device, ...clientInfo(req), now: new Date(now) });
    await req.audit({
      action: 'auth.login.succeeded',
      entityType: 'session',
      entityId: tokens.sessionId,
      after: { method: 'password', userId: user.id, via: 'native', device: pending.device?.name ?? null },
      actor: userActor(user),
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json(tokensBody(tokens));
  });

  router.post('/native/refresh', async (req, res) => {
    const parsed = z.object({ refreshToken: z.string().min(1).max(200) }).safeParse(req.body);
    if (!parsed.success) {
      sendRefusal(res, refusal('invalid_request', 'That request is not a refresh.'));
      return;
    }
    const rotation = await rotateNativeSession(db, parsed.data.refreshToken, new Date());
    if (rotation.kind === 'ended') {
      problemOf('session_revoked', 'This sign-in has ended', 401)(res);
      return;
    }
    if (rotation.kind === 'reused') {
      // A rotated token came back: it leaked, or a client replayed it. The session ends.
      await db.session.deleteMany({ where: { id: rotation.sessionId } });
      await req.audit({ action: 'auth.native.refresh_reused', entityType: 'session', entityId: rotation.sessionId, after: { ended: true }, actor: { type: 'user', id: rotation.userId, label: 'native session' } });
      problemOf('refresh_reused', 'This sign-in was used twice and has been ended', 401)(res);
      return;
    }
    await req.audit({ action: 'auth.native.refresh', entityType: 'session', entityId: rotation.tokens.sessionId, after: { rotated: true }, actor: { type: 'user', id: rotation.userId, label: 'native session' } });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ accessToken: rotation.tokens.accessToken, refreshToken: rotation.tokens.refreshToken, expiresIn: rotation.tokens.expiresIn });
  });

  router.post('/native/revoke', async (req, res) => {
    const session = req.nativeSession;
    if (session === undefined) {
      problemOf('session_revoked', 'This sign-in has ended', 401)(res);
      return;
    }
    await db.session.deleteMany({ where: { id: session.id } });
    await req.audit({ action: 'auth.logout', entityType: 'session', entityId: session.id, after: { via: 'native' } });
    res.status(204).end();
  });

  /**
   * Link the D3 Auth identity in the Bearer token to a Shipyard account, once (SHP-T-10.2). The
   * account is proven with its own password and code, throttled as a sign-in — a link is a sign-in
   * that leaves a lasting connection behind. Never by email.
   */
  router.post('/native/link', async (req, res) => {
    const parsed = z.object({ email: z.string().min(1).max(320), password: z.string().min(1).max(1024), totp: z.string().min(1).max(16) }).safeParse(req.body);
    if (!parsed.success) {
      sendRefusal(res, refusal('invalid_request', 'That request is not a link.'));
      return;
    }
    const token = bearerOf(req.headers.authorization);
    const verified = token === null ? null : await verifyD3AuthToken(oidcSource.current()?.issuer ?? null, token, publicOrigin(config, req));
    if (verified === null) {
      problemOf('session_revoked', "This D3 Auth sign-in isn't valid here", 401)(res);
      return;
    }
    const { email, password, totp } = parsed.data;
    if (await nativeThrottled(req, res, email)) return;
    const user = await db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    const ok = user !== null && user.passwordHash !== null ? await verifyPassword(user.passwordHash, password) : await verifyAgainstDummy(password);
    if (user === null || !ok || user.disabledAt !== null) {
      recordFailure(req, email);
      await nativeFail(req, res, 'invalid_credentials', user?.id, 'link');
      return;
    }
    if (user.totpSecret === null || !replay.consume(user.id, user.totpSecret, totp, Date.now())) {
      recordFailure(req, email);
      await nativeFail(req, res, 'invalid_code', user.id, 'link');
      return;
    }
    const existing = await db.identity.findUnique({ where: { issuer_subject: { issuer: verified.issuer, subject: verified.subject } } });
    if (existing !== null && existing.userId !== user.id) {
      sendRefusal(res, IDENTITY_TAKEN);
      return;
    }
    if (existing === null) {
      const identity = await db.identity.create({ data: { userId: user.id, issuer: verified.issuer, subject: verified.subject, lastUsedAt: new Date() } });
      await req.audit({ action: 'auth.identity.linked', entityType: 'identity', entityId: identity.id, after: { userId: user.id, issuer: verified.issuer, subject: verified.subject, via: 'native' }, actor: userActor(user) });
    } else {
      await req.audit({ action: 'auth.identity.linked', entityType: 'identity', entityId: existing.id, after: { userId: user.id, already: true, via: 'native' }, actor: userActor(user) });
    }
    accountThrottle.reset(`${accountKey(user.email)}|${ipKey(req)}`);
    res.json({ linked: true, accountId: user.id });
  });

  /**
   * Step-up (SHP-T-10.3): a code from the authenticator, recorded on the session making the request.
   * Approve, deny and rollback from a native session want one from the last ten minutes.
   */
  router.post('/step-up', requireUser, async (req, res) => {
    const parsed = TotpRequest.safeParse(req.body);
    if (!parsed.success) {
      sendRefusal(res, refusal('invalid_request', 'A six-digit code is required.'));
      return;
    }
    const user = await db.user.findUnique({ where: { id: req.actor?.id ?? '' } });
    if (user === null || user.totpSecret === null) {
      sendRefusal(res, TOTP_NOT_ENROLLED);
      return;
    }
    if (await refuseIfThrottled(req, res, 'totp', user.email, user.id)) return;
    if (!replay.consume(user.id, user.totpSecret, parsed.data.code, Date.now())) {
      recordFailure(req, user.email);
      await fail(req, res, BAD_TOTP, { action: 'auth.step_up.failed', reason: 'bad_totp', entityId: user.id });
      return;
    }
    const sessionId = req.nativeSession?.id ?? req.consoleSessionId;
    const now = new Date();
    if (sessionId !== undefined) await db.session.update({ where: { id: sessionId }, data: { stepUpAt: now } });
    await req.audit({ action: 'auth.step_up', entityType: 'session', ...(sessionId !== undefined ? { entityId: sessionId } : {}), after: { native: req.nativeSession !== undefined } });
    res.json({ ok: true, until: new Date(now.getTime() + STEP_UP_MS).toISOString() });
  });

  /**
   * Delete your own account from D3 Constellation (SHP-T-11.3, SHP-ADR-004): the host name typed
   * out and a current code, from a native session or a D3 Auth token — never an API token, which is
   * not a person, and never the console, which has the members screen. Then a grace period.
   */
  router.post('/native/delete-account', async (req, res) => {
    if (req.nativeSession === undefined || req.actor?.type !== 'user' || req.actor.id === undefined) {
      problemOf('session_revoked', 'Sign in again to delete this account.', 401)(res);
      return;
    }
    const parsed = z.object({ confirmation: z.string().max(253), totp: z.string().min(1).max(16) }).safeParse(req.body);
    if (!parsed.success) {
      sendRefusal(res, refusal('invalid_request', 'That request is not a deletion.'));
      return;
    }
    const host = new URL(publicOrigin(deps.config, req)).hostname;
    if (parsed.data.confirmation.trim().toLowerCase() !== host.toLowerCase()) {
      problemOf('about:blank', 'The confirmation doesn’t match.', 422, { detail: `Type ${host} exactly to confirm.` })(res);
      return;
    }
    const user = await db.user.findUnique({ where: { id: req.actor.id } });
    if (user === null || user.disabledAt !== null) {
      problemOf('session_revoked', 'Sign in again to delete this account.', 401)(res);
      return;
    }
    if (await nativeThrottled(req, res, user.email)) return;
    if (user.totpSecret === null || !replay.consume(user.id, user.totpSecret, parsed.data.totp, Date.now())) {
      recordFailure(req, user.email);
      await nativeFail(req, res, 'invalid_code', user.id, 'delete-account');
      return;
    }
    const outcome = await requestDeletion(db, user.id);
    if (outcome.kind === 'last_admin') {
      problemOf('last_owner', 'You’re the last admin.', 409, { detail: 'Make another user an admin first, then delete this account.' })(res);
      return;
    }
    if (outcome.kind === 'gone') {
      problemOf('session_revoked', 'This account is already being deleted.', 401)(res);
      return;
    }
    await req.audit({
      action: 'user.deletion_requested',
      entityType: 'user',
      entityId: user.id,
      after: { deleteAfter: outcome.graceUntil.toISOString(), tokensRevoked: outcome.tokensRevoked, via: 'native' },
      actor: userActor(user),
    });
    res.status(202).json({ graceUntil: outcome.graceUntil.toISOString() });
  });

  // ── Sessions (SHP-T-10.4): your own, the phone among them, each one revocable ──
  router.get('/sessions', requireUser, async (req, res) => {
    const rows = await db.session.findMany({
      where: { userId: req.actor?.id ?? '', ...liveSessionWhere(new Date()) },
      orderBy: { createdAt: 'desc' },
    });
    const current = req.nativeSession?.id ?? req.consoleSessionId;
    res.json(
      rows.map((row) => ({
        id: row.id,
        method: row.method,
        native: row.native,
        deviceName: row.deviceName,
        devicePlatform: row.devicePlatform,
        ip: row.ip,
        userAgent: row.userAgent,
        createdAt: row.createdAt.toISOString(),
        lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
        current: row.id === current,
      })),
    );
  });

  router.post('/sessions/:id/revoke', requireUser, async (req, res) => {
    const id = req.params['id'];
    const row = typeof id === 'string' ? await db.session.findFirst({ where: { id, userId: req.actor?.id ?? '' } }) : null;
    if (row === null) {
      sendRefusal(res, refusal('not_found', 'No such session.', 'List your sessions and use one of their IDs.'));
      return;
    }
    await db.session.delete({ where: { id: row.id } });
    await req.audit({ action: 'auth.session.revoked', entityType: 'session', entityId: row.id, after: { native: row.native, deviceName: row.deviceName } });
    res.json({ ok: true });
  });

  return router;
}
