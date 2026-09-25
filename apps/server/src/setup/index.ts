import { createHash, randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { SetupCompleteRequest, SetupStartRequest, refusal, type Refusal, type SetupStarted } from '@shipyard/schema';
import type { Logger } from 'pino';
import { ANONYMOUS_ACTOR, type Actor } from '../audit.js';
import { SESSION_COOKIE, setCookie } from '../auth/cookies.js';
import { hashPassword } from '../auth/passwords.js';
import { SESSION_TTL_MS, createSession } from '../auth/sessions.js';
import { Throttle, type ThrottleLimits } from '../auth/throttle.js';
import { generateTotpSecret, totpUri, verifyTotp } from '../auth/totp.js';
import { BOOTSTRAP_LOCK_KEY } from '../cli/bootstrap-admin.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { sendRefusal } from '../errors.js';

/**
 * First-run setup in the console (SHP-REQ-109, SHP-T-6.7). While no account exists, a visitor may
 * create the first one — an admin with a password and TOTP — in the browser. There is no setup
 * code and no time window, by the owner's choice: whoever reaches a fresh instance first claims it,
 * and the install docs say to claim it right after first start.
 *
 * Two steps, and nothing is written until the second succeeds:
 *
 * - `POST /start` checks there are no users, hashes the password, generates a TOTP secret and
 *   holds both in memory against a random, single-use ticket for ten minutes. The browser gets the
 *   ticket and the authenticator to enrol — never the password hash.
 * - `POST /complete` takes the ticket and a code from the new authenticator, then creates the admin
 *   in one transaction that holds the same advisory lock as `bootstrap-admin` and re-counts users
 *   under it, so two concurrent claims (or a claim racing the CLI) yield exactly one account.
 *
 * Once any user exists, every route here refuses with `conflict` (and GET says `available: false`).
 * Pending claims live in memory: the server is one process, and a restart costs a claimant one
 * restart of the form.
 */

export const SETUP_TICKET_TTL_MS = 10 * 60 * 1000;
/** Wrong codes one ticket may take before it is dropped and the form must start again. */
export const SETUP_MAX_CODE_ATTEMPTS = 5;
/** Pending claims held at once; a flood of starts evicts the oldest rather than growing memory. */
const MAX_PENDING = 100;

/**
 * Per source address: every start (it costs an argon2 hash) and every wrong code counts. Twenty in
 * fifteen minutes pauses the address for fifteen.
 */
export const DEFAULT_SETUP_LIMITS: ThrottleLimits = {
  maxFailures: 20,
  windowMs: 15 * 60 * 1000,
  coolOffMs: 15 * 60 * 1000,
};

export interface SetupDeps {
  db: Db;
  logger: Logger;
  config: Config;
  /** Tests pass small limits and a clock. */
  limits?: ThrottleLimits;
  now?: () => number;
}

const TICKET_RE = /^stp_[A-Za-z0-9_-]{43}$/;

export const ALREADY_SET_UP = refusal(
  'conflict',
  'Shipyard already has an account; sign in.',
  'First-run setup only creates the first account. Sign in, or ask an admin for an invite.',
);
const NO_TICKET = refusal(
  'invalid_request',
  'This setup step has expired or was never started.',
  'Start again: enter your email, display name and password.',
);
const BAD_CODE = refusal(
  'unauthenticated',
  'The authenticator code is wrong.',
  'Enter the current six-digit code from the authenticator you just added.',
);
const THROTTLED = refusal(
  'too_many_attempts',
  'Too many setup attempts from this address.',
  'Wait for the cooling-off period (up to fifteen minutes), then try again.',
);

interface PendingClaim {
  email: string;
  displayName: string;
  passwordHash: string;
  totpSecret: string;
  expiresAt: number;
  attempts: number;
}

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.map(String).join('.') || 'body'}: ${i.message}`).join('; ');
}

/** The ticket is kept by its hash, so a heap dump or a log line of the map never holds a live one. */
function ticketKey(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}

export function setupRouter(deps: SetupDeps): Router {
  const { db, config } = deps;
  const now = deps.now ?? Date.now;
  const throttle = new Throttle({ limits: deps.limits ?? DEFAULT_SETUP_LIMITS, now });
  const pending = new Map<string, PendingClaim>();
  const router = Router();

  const ipKey = (req: Request): string => req.ip ?? 'unknown';

  function sweep(t: number): void {
    for (const [key, claim] of pending) if (claim.expiresAt <= t) pending.delete(key);
    while (pending.size >= MAX_PENDING) {
      const oldest = pending.keys().next();
      if (oldest.done === true) break;
      pending.delete(oldest.value);
    }
  }

  /** Every refusal after the body is read is audited, as sign-in's are. Never the code or password. */
  async function fail(req: Request, res: Response, r: Refusal, reason: string, after: Record<string, unknown> = {}) {
    await req.audit({
      action: 'auth.setup.failed',
      entityType: 'user',
      after: { reason, ...after },
      actor: ANONYMOUS_ACTOR,
    });
    sendRefusal(res, r);
  }

  async function refuseIfThrottled(req: Request, res: Response, step: 'start' | 'complete'): Promise<boolean> {
    if (throttle.blockedUntil(ipKey(req)) === null) return false;
    deps.logger.warn({ ip: req.ip, step }, 'first-run setup throttled');
    await fail(req, res, THROTTLED, 'too_many_attempts', { step });
    return true;
  }

  router.get('/', async (_req, res) => {
    const users = await db.user.count();
    res.setHeader('Cache-Control', 'no-store');
    res.json({ available: users === 0 });
  });

  router.post('/start', async (req, res) => {
    if (await refuseIfThrottled(req, res, 'start')) return;
    if ((await db.user.count()) > 0) {
      await fail(req, res, ALREADY_SET_UP, 'already_set_up', { step: 'start' });
      return;
    }
    const parsed = SetupStartRequest.safeParse(req.body);
    if (!parsed.success) {
      await fail(
        req,
        res,
        refusal(
          'invalid_request',
          'An email, a display name and a password of at least 12 characters are required.',
          issues(parsed.error),
        ),
        'invalid_request',
        { step: 'start' },
      );
      return;
    }
    // Counted before the argon2 work, so the hash cannot be used to burn the host's memory.
    throttle.recordFailure(ipKey(req));

    const email = parsed.data.email.trim().toLowerCase();
    const displayName = parsed.data.displayName;
    const passwordHash = await hashPassword(parsed.data.password);
    const totpSecret = generateTotpSecret();
    const ticket = `stp_${randomBytes(32).toString('base64url')}`;
    const t = now();
    const expiresAt = t + SETUP_TICKET_TTL_MS;
    sweep(t);
    pending.set(ticketKey(ticket), { email, displayName, passwordHash, totpSecret, expiresAt, attempts: 0 });

    await req.audit({
      action: 'auth.setup.started',
      entityType: 'user',
      after: { email, displayName },
      actor: ANONYMOUS_ACTOR,
    });
    const body: SetupStarted = {
      ticket,
      otpauthUri: totpUri(totpSecret, email),
      secret: totpSecret,
      expiresAt: new Date(expiresAt).toISOString(),
    };
    res.setHeader('Cache-Control', 'no-store');
    res.json(body);
  });

  router.post('/complete', async (req, res) => {
    if (await refuseIfThrottled(req, res, 'complete')) return;
    if ((await db.user.count()) > 0) {
      await fail(req, res, ALREADY_SET_UP, 'already_set_up', { step: 'complete' });
      return;
    }
    const parsed = SetupCompleteRequest.safeParse(req.body);
    if (!parsed.success) {
      await fail(
        req,
        res,
        refusal('invalid_request', 'The setup ticket and a six-digit code are required.', issues(parsed.error)),
        'invalid_request',
        { step: 'complete' },
      );
      return;
    }
    const { ticket, code } = parsed.data;
    const t = now();
    sweep(t);
    const key = ticketKey(ticket);
    const claim = TICKET_RE.test(ticket) ? pending.get(key) : undefined;
    if (claim === undefined || claim.expiresAt <= t) {
      pending.delete(key);
      await fail(req, res, NO_TICKET, 'no_setup_ticket', { step: 'complete' });
      return;
    }

    if (!verifyTotp(claim.totpSecret, code, t)) {
      claim.attempts += 1;
      if (claim.attempts >= SETUP_MAX_CODE_ATTEMPTS) pending.delete(key);
      throttle.recordFailure(ipKey(req));
      await fail(req, res, BAD_CODE, 'bad_totp', { step: 'complete', attempts: claim.attempts });
      return;
    }
    // Spent before any await, so two requests holding the same ticket cannot both reach the insert.
    pending.delete(key);

    const at = new Date(t);
    const created = await db.$transaction(async (tx) => {
      // The same lock bootstrap-admin takes: whoever holds it counts users, and only an empty table
      // gets an insert. A second claim blocks here until the first commits, then finds one user.
      await tx.$executeRaw`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`;
      if ((await tx.user.count()) > 0) return null;
      return tx.user.create({
        data: {
          email: claim.email,
          displayName: claim.displayName,
          passwordHash: claim.passwordHash,
          totpSecret: claim.totpSecret,
          totpEnabledAt: at,
          role: 'admin',
        },
      });
    });
    if (created === null) {
      await fail(req, res, ALREADY_SET_UP, 'already_set_up', { step: 'complete', lost: 'race' });
      return;
    }

    const actor: Actor = { type: 'user', id: created.id, label: created.email };
    await req.audit({
      action: 'auth.setup.completed',
      entityType: 'user',
      entityId: created.id,
      after: { email: created.email, displayName: created.displayName, role: created.role, totpEnrolled: true },
      actor,
    });

    // Signed in at once, exactly as the TOTP step of a normal sign-in does it.
    const session = await createSession(db, {
      userId: created.id,
      method: 'password',
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    setCookie(res, config, SESSION_COOKIE, session.token, { maxAgeMs: SESSION_TTL_MS });
    await req.audit({
      action: 'auth.login.succeeded',
      entityType: 'session',
      entityId: session.id,
      after: { method: 'password', userId: created.id, expiresAt: session.expiresAt.toISOString(), via: 'setup' },
      actor,
    });
    res.status(201).json({ id: created.id, email: created.email, displayName: created.displayName, role: created.role });
  });

  return router;
}
