import { createHash, randomBytes } from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { refusal, type Refusal } from '@shipyard/schema';
import { ANONYMOUS_ACTOR, type Actor } from '../audit.js';
import { generateTotpSecret, hashPassword, requireUser, totpUri, verifyTotp } from '../auth/index.js';
import { requireRole, STATE_CHANGING_ROLES, type Role } from '../auth/scope.js';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';

/**
 * Users, invitations and the out-of-band change count (SHP-REQ-046/064/067/068/101; SHP-D-067,
 * SHP-D-085). Mounted at `/api`, so every route here names its own guard: a router-level
 * middleware would run for every other `/api` request too.
 *
 * Nothing creates a user except the bootstrap-admin CLI and the invite accept/confirm pair below
 * (SHP-REQ-101). An invite is consumed only once its new user has confirmed a first TOTP code,
 * because native sign-in requires TOTP; until then the accept step may be restarted.
 */

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 12;
/** Requests per source address per window on the public invite routes. */
export const INVITE_RATE_LIMIT = 30;
export const INVITE_RATE_WINDOW_MS = 15 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVITE_TOKEN_RE = /^inv_[A-Za-z0-9_-]{43}$/;
const ROLES = ['admin', 'operator', 'deployer', 'viewer'] as const;

const InviteCreate = z.strictObject({
  email: z.email().max(254),
  role: z.enum(['deployer', 'viewer']),
});
const UserPatch = z
  .strictObject({ role: z.enum(ROLES).optional(), disabled: z.boolean().optional() })
  .refine((v) => v.role !== undefined || v.disabled !== undefined, 'Send a role, disabled, or both.');
const AcceptBody = z.strictObject({
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
});
const ConfirmTotpBody = z.strictObject({ code: z.string().regex(/^[0-9]{6}$/, 'exactly 6 digits') });

const NO_SUCH_USER = refusal('not_found', 'No such user.', 'List users and use one of their IDs.');
const NO_SUCH_INVITE = refusal('not_found', 'No such pending invite.', 'List pending invites and use one of their IDs.');
const INVITE_INVALID = refusal(
  'not_found',
  'This invite link is not valid: it is unknown, revoked or already used.',
  'Ask whoever invited you for a new invite link.',
);
const INVITE_EXPIRED = refusal(
  'conflict',
  'This invite has expired.',
  'Invites last seven days. Ask whoever invited you for a new one.',
);
const TOKEN_ACTOR = refusal(
  'forbidden',
  'An API token cannot manage users or invites.',
  'Sign in to the console to do this.',
);

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  disabled: boolean;
  totpEnrolled: boolean;
  d3authLinked: boolean;
  createdAt: string;
}

export interface InviteSummary {
  id: string;
  email: string;
  role: Role;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
}

export interface InviteCreated extends InviteSummary {
  /** Shown once: only its sha256 is stored. */
  token: string;
  link: string;
}

export interface OutOfBandMonth {
  /** `YYYY-MM`, UTC. */
  month: string;
  count: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashInviteToken(token: string): string {
  return sha256(token);
}

function bad(res: Response, message: string, issues: z.core.$ZodIssue[]): void {
  sendRefusal(
    res,
    refusal('invalid_request', message, issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')),
  );
}

/** Console-only routes: a bearer token is refused before anything else. */
const consoleOnly: RequestHandler = (req, res, next) => {
  if (req.actor?.type === 'token') {
    sendRefusal(res, TOKEN_ACTOR);
    return;
  }
  next();
};

function rateLimit(limit: number, windowMs: number, now: () => number): RequestHandler {
  const windows = new Map<string, { start: number; count: number }>();
  return (req, res, next) => {
    const t = now();
    if (windows.size > 10_000) {
      for (const [ip, w] of windows) if (t - w.start >= windowMs) windows.delete(ip);
    }
    const ip = req.ip ?? 'unknown';
    let w = windows.get(ip);
    if (w === undefined || t - w.start >= windowMs) {
      w = { start: t, count: 0 };
      windows.set(ip, w);
    }
    w.count += 1;
    if (w.count > limit) {
      res.setHeader('retry-after', String(Math.ceil((w.start + windowMs - t) / 1000)));
      sendRefusal(
        res,
        refusal('too_many_attempts', 'Too many invite attempts from this address.', 'Wait a few minutes, then retry.'),
      );
      return;
    }
    next();
  };
}

function param(req: Request, name: string): string {
  const raw: unknown = req.params[name];
  return typeof raw === 'string' ? raw : '';
}

export interface UsersRouterOptions {
  /** Public invite-route limits and clock; tests pass small ones. */
  inviteRateLimit?: { limit: number; windowMs: number };
  now?: () => number;
}

export function usersRouter(deps: ServiceDeps, options: UsersRouterOptions = {}): Router {
  const { db, config } = deps;
  const now = options.now ?? Date.now;
  const router = Router();
  const limited = rateLimit(
    options.inviteRateLimit?.limit ?? INVITE_RATE_LIMIT,
    options.inviteRateLimit?.windowMs ?? INVITE_RATE_WINDOW_MS,
    now,
  );
  const canManage = [consoleOnly, requireUser, requireRole(...STATE_CHANGING_ROLES)];

  // ── Users ─────────────────────────────────────────────────────────────
  router.get('/users', ...canManage, async (_req, res) => {
    const rows = await db.user.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { identities: true } } },
    });
    const body: UserSummary[] = rows.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      role: u.role,
      disabled: u.disabledAt !== null,
      totpEnrolled: u.totpSecret !== null && u.totpEnabledAt !== null,
      d3authLinked: u._count.identities > 0,
      createdAt: u.createdAt.toISOString(),
    }));
    res.json(body);
  });

  router.patch('/users/:id', consoleOnly, requireUser, requireRole('admin'), async (req, res) => {
    const id = param(req, 'id');
    if (!UUID_RE.test(id)) {
      sendRefusal(res, NO_SUCH_USER);
      return;
    }
    const parsed = UserPatch.safeParse(req.body);
    if (!parsed.success) {
      bad(res, 'Send { "role"?: "admin"|"operator"|"deployer"|"viewer", "disabled"?: boolean }.', parsed.error.issues);
      return;
    }
    const target = await db.user.findUnique({ where: { id } });
    if (target === null) {
      sendRefusal(res, NO_SUCH_USER);
      return;
    }
    const { role, disabled } = parsed.data;
    const losesAdmin =
      target.role === 'admin' &&
      target.disabledAt === null &&
      ((role !== undefined && role !== 'admin') || disabled === true);
    if (losesAdmin) {
      const otherAdmins = await db.user.count({ where: { role: 'admin', disabledAt: null, id: { not: target.id } } });
      if (otherAdmins === 0) {
        sendRefusal(
          res,
          refusal(
            'conflict',
            'This is the last active admin; demoting or disabling it would leave nobody able to manage users.',
            'Make another user an admin first.',
          ),
        );
        return;
      }
    }
    if (target.id === req.actor?.id) {
      sendRefusal(
        res,
        refusal('conflict', 'You cannot change your own role or disable yourself.', 'Ask another admin to do it.'),
      );
      return;
    }

    const disabledAt = disabled === undefined ? target.disabledAt : disabled ? (target.disabledAt ?? new Date()) : null;
    const updated = await db.user.update({
      where: { id },
      data: { ...(role !== undefined ? { role } : {}), disabledAt },
    });
    // A disabled user's sessions end at once; its tokens stop resolving because the owner is disabled.
    if (disabled === true) await db.session.deleteMany({ where: { userId: id } });
    await req.audit({
      action: 'user.updated',
      entityType: 'user',
      entityId: id,
      before: { role: target.role, disabled: target.disabledAt !== null },
      after: { role: updated.role, disabled: updated.disabledAt !== null },
    });
    const identities = await db.identity.count({ where: { userId: id } });
    const body: UserSummary = {
      id: updated.id,
      email: updated.email,
      displayName: updated.displayName,
      role: updated.role,
      disabled: updated.disabledAt !== null,
      totpEnrolled: updated.totpSecret !== null && updated.totpEnabledAt !== null,
      d3authLinked: identities > 0,
      createdAt: updated.createdAt.toISOString(),
    };
    res.json(body);
  });

  // ── Invites (signed in) ───────────────────────────────────────────────
  router.get('/invites', ...canManage, async (_req, res) => {
    const rows = await db.invite.findMany({
      where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date(now()) } },
      include: { invitedBy: { select: { email: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const body: InviteSummary[] = rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      invitedBy: r.invitedBy.email,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
    }));
    res.json(body);
  });

  router.post('/invites', ...canManage, async (req, res) => {
    const parsed = InviteCreate.safeParse(req.body);
    if (!parsed.success) {
      bad(res, 'An email and a role (deployer or viewer) are required.', parsed.error.issues);
      return;
    }
    const email = parsed.data.email.trim().toLowerCase();
    const { role } = parsed.data;
    const existing = await db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (existing !== null && existing.totpEnabledAt !== null) {
      sendRefusal(
        res,
        refusal('conflict', `${email} already has an account.`, 'Change its role on the Users screen instead.'),
      );
      return;
    }
    const inviter = req.actor?.id ?? '';
    const token = `inv_${randomBytes(32).toString('base64url')}`;
    const createdAt = new Date(now());
    const expiresAt = new Date(createdAt.getTime() + INVITE_TTL_MS);

    // The newest invite for an address wins: a lost link is replaced, not left live beside it.
    const superseded = await db.invite.findMany({
      where: { email, acceptedAt: null, revokedAt: null },
      select: { id: true },
    });
    const row = await db.$transaction(async (tx) => {
      if (superseded.length > 0) {
        await tx.invite.updateMany({
          where: { id: { in: superseded.map((s) => s.id) }, acceptedAt: null, revokedAt: null },
          data: { revokedAt: createdAt },
        });
      }
      return tx.invite.create({
        data: { email, role, tokenHash: hashInviteToken(token), invitedById: inviter, expiresAt },
        include: { invitedBy: { select: { email: true } } },
      });
    });
    await req.audit({
      action: 'invite.created',
      entityType: 'invite',
      entityId: row.id,
      after: {
        email,
        role,
        expiresAt: expiresAt.toISOString(),
        ...(superseded.length > 0 ? { superseded: superseded.map((s) => s.id) } : {}),
      },
    });
    const base = (config.PUBLIC_URL ?? `${req.protocol}://${req.get('host') ?? 'localhost'}`).replace(/\/+$/, '');
    const body: InviteCreated = {
      id: row.id,
      email,
      role,
      invitedBy: row.invitedBy.email,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      token,
      link: `${base}/invite/${token}`,
    };
    res.status(201).json(body);
  });

  router.delete('/invites/:id', ...canManage, async (req, res) => {
    const id = param(req, 'id');
    if (!UUID_RE.test(id)) {
      sendRefusal(res, NO_SUCH_INVITE);
      return;
    }
    const existing = await db.invite.findUnique({ where: { id } });
    if (existing === null || existing.acceptedAt !== null) {
      sendRefusal(res, NO_SUCH_INVITE);
      return;
    }
    const already = existing.revokedAt !== null;
    const row = already ? existing : await db.invite.update({ where: { id }, data: { revokedAt: new Date(now()) } });
    await req.audit({
      action: 'invite.revoked',
      entityType: 'invite',
      entityId: id,
      before: { revokedAt: existing.revokedAt?.toISOString() ?? null },
      after: { email: row.email, role: row.role, revokedAt: row.revokedAt?.toISOString() ?? null, alreadyRevoked: already },
    });
    res.json({ id, revokedAt: row.revokedAt?.toISOString() ?? null });
  });

  // ── Invites (public, by token) ────────────────────────────────────────
  type InviteRow = NonNullable<Awaited<ReturnType<typeof db.invite.findUnique>>>;

  /** The invite for the token in the path, or a refusal: unknown, revoked or accepted are all "not valid". */
  async function inviteByToken(req: Request): Promise<{ invite: InviteRow; expired: boolean } | Refusal> {
    const token = param(req, 'token');
    if (!INVITE_TOKEN_RE.test(token)) return INVITE_INVALID;
    const invite = await db.invite.findUnique({ where: { tokenHash: hashInviteToken(token) } });
    if (invite === null || invite.revokedAt !== null || invite.acceptedAt !== null) return INVITE_INVALID;
    return { invite, expired: invite.expiresAt.getTime() <= now() };
  }

  /**
   * The account an earlier, unconfirmed accept created: same email, no TOTP yet, and created after
   * the first invite to that address (so by an invite accept, perhaps of a superseded invite).
   * Anything else with that email is a real account and blocks the invite.
   */
  async function pendingUserFor(invite: InviteRow) {
    const user = await db.user.findFirst({ where: { email: { equals: invite.email, mode: 'insensitive' } } });
    if (user === null) return { user: null, blocked: false } as const;
    const first = await db.invite.findFirst({
      where: { email: invite.email },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    const pending =
      user.totpEnabledAt === null && first !== null && user.createdAt.getTime() >= first.createdAt.getTime();
    return { user, blocked: !pending } as const;
  }

  router.get('/invites/:token', limited, async (req, res) => {
    const found = await inviteByToken(req);
    if (!('invite' in found)) {
      sendRefusal(res, found);
      return;
    }
    res.json({ email: found.invite.email, role: found.invite.role, expired: found.expired });
  });

  router.post('/invites/:token/accept', limited, async (req, res) => {
    const found = await inviteByToken(req);
    if (!('invite' in found)) {
      sendRefusal(res, found);
      return;
    }
    if (found.expired) {
      sendRefusal(res, INVITE_EXPIRED);
      return;
    }
    const parsed = AcceptBody.safeParse(req.body);
    if (!parsed.success) {
      bad(res, `A display name and a password of at least ${MIN_PASSWORD_LENGTH} characters are required.`, parsed.error.issues);
      return;
    }
    const { invite } = found;
    const pending = await pendingUserFor(invite);
    if (pending.blocked) {
      sendRefusal(
        res,
        refusal('conflict', `${invite.email} already has an account.`, 'Sign in with it instead of accepting this invite.'),
      );
      return;
    }
    const passwordHash = await hashPassword(parsed.data.password);
    const totpSecret = generateTotpSecret();
    const data = { displayName: parsed.data.displayName, passwordHash, totpSecret, totpEnabledAt: null, role: invite.role };
    const user =
      pending.user === null
        ? await db.user.create({ data: { email: invite.email, ...data } })
        : await db.user.update({ where: { id: pending.user.id }, data });
    const actor: Actor = { type: 'user', id: user.id, label: user.email };
    await req.audit({
      action: pending.user === null ? 'invite.accepted_pending_totp' : 'invite.accept_restarted',
      entityType: 'invite',
      entityId: invite.id,
      after: { userId: user.id, email: user.email, role: user.role },
      actor,
    });
    res.json({ email: user.email, role: user.role, otpauthUri: totpUri(totpSecret, user.email), secret: totpSecret });
  });

  router.post('/invites/:token/confirm-totp', limited, async (req, res) => {
    const found = await inviteByToken(req);
    if (!('invite' in found)) {
      sendRefusal(res, found);
      return;
    }
    if (found.expired) {
      sendRefusal(res, INVITE_EXPIRED);
      return;
    }
    const parsed = ConfirmTotpBody.safeParse(req.body);
    if (!parsed.success) {
      bad(res, 'A six-digit code is required.', parsed.error.issues);
      return;
    }
    const { invite } = found;
    const pending = await pendingUserFor(invite);
    if (pending.user === null || pending.blocked || pending.user.totpSecret === null) {
      sendRefusal(
        res,
        refusal('conflict', 'This invite has not been accepted yet.', 'Choose a display name and password first.'),
      );
      return;
    }
    const user = pending.user;
    if (!verifyTotp(user.totpSecret ?? '', parsed.data.code, now())) {
      await req.audit({
        action: 'invite.totp_failed',
        entityType: 'invite',
        entityId: invite.id,
        after: { userId: user.id },
        actor: ANONYMOUS_ACTOR,
      });
      sendRefusal(
        res,
        refusal(
          'unauthenticated',
          'The authenticator code is wrong.',
          'Enter the current six-digit code from the authenticator you just added.',
        ),
      );
      return;
    }
    const at = new Date(now());
    // Conditional updates, so two concurrent confirmations cannot both consume the invite.
    const consumed = await db.$transaction(async (tx) => {
      const claimed = await tx.invite.updateMany({
        where: { id: invite.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: at },
      });
      if (claimed.count !== 1) return false;
      await tx.user.update({ where: { id: user.id }, data: { totpEnabledAt: at } });
      return true;
    });
    if (!consumed) {
      sendRefusal(res, INVITE_INVALID);
      return;
    }
    await req.audit({
      action: 'invite.accepted',
      entityType: 'user',
      entityId: user.id,
      after: { inviteId: invite.id, email: user.email, role: user.role, invitedById: invite.invitedById },
      actor: { type: 'user', id: user.id, label: user.email },
    });
    res.json({ ok: true, email: user.email });
  });

  // ── Out-of-band changes (SHP-REQ-068, SHP-D-085) ──────────────────────
  router.get('/stats/out-of-band', requireUser, async (req, res) => {
    const raw = typeof req.query['months'] === 'string' ? Number(req.query['months']) : 6;
    const months = Number.isInteger(raw) && raw >= 1 && raw <= 24 ? raw : 6;
    const today = new Date(now());
    const buckets: OutOfBandMonth[] = [];
    for (let i = months - 1; i >= 0; i -= 1) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
      buckets.push({ month: d.toISOString().slice(0, 7), count: 0 });
    }
    const start = new Date(`${buckets[0]?.month ?? today.toISOString().slice(0, 7)}-01T00:00:00.000Z`);
    const rows = await db.driftEvent.findMany({
      where: { resolution: 'adopt_live', resolvedAt: { gte: start } },
      select: { resolvedAt: true },
    });
    const index = new Map(buckets.map((b) => [b.month, b]));
    for (const r of rows) {
      const bucket = r.resolvedAt === null ? undefined : index.get(r.resolvedAt.toISOString().slice(0, 7));
      if (bucket !== undefined) bucket.count += 1;
    }
    res.json({ months: buckets });
  });

  return router;
}
