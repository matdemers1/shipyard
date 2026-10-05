import { createHash, randomBytes } from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { refusal, type Refusal } from '@shipyard/schema';
import { ANONYMOUS_ACTOR, type Actor } from '../audit.js';
import { generateTotpSecret, hashPassword, requireUser, totpUri, verifyTotp } from '../auth/index.js';
import { issueNativeSession, type Device } from '../auth/native-sessions.js';
import { requireRole, STATE_CHANGING_ROLES, type Role } from '../auth/scope.js';
import { Prisma } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';

/**
 * Users, invitations and the out-of-band change count (SHP-REQ-046/064/067/068/101; SHP-D-067,
 * SHP-D-085). Mounted at `/api`, so every route here names its own guard: a router-level
 * middleware would run for every other `/api` request too.
 *
 * Nothing creates a user except the bootstrap-admin CLI, first-run setup while no account exists
 * (src/setup, SHP-REQ-109) and the invite accept/confirm pair below (SHP-REQ-101). An invite is consumed only once its new user has confirmed a first TOTP code,
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
      // A purged account (SHP-T-11.3) is only a name for the audit trail now, not a user.
      where: { deletedAt: null },
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
    if (target === null || target.deletedAt !== null) {
      sendRefusal(res, NO_SUCH_USER);
      return;
    }
    const { role, disabled } = parsed.data;
    const actorId = req.actor?.id;

    // Locks every active admin row before deciding whether this demotion/disable would leave
    // none, so two admins demoting each other at the same moment serialize instead of racing:
    // the second transaction re-reads the row it locked only after the first has committed, by
    // which point the other admin's row may no longer match the lock predicate at all.
    type PatchResult =
      | { kind: 'gone' }
      | { kind: 'lastAdmin' }
      | { kind: 'self' }
      | { kind: 'ok'; before: { role: Role; disabledAt: Date | null }; updated: Awaited<ReturnType<typeof db.user.update>> };
    const result: PatchResult = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "user" WHERE role = 'admin' AND disabled_at IS NULL FOR UPDATE`;
      const locked = await tx.user.findUnique({ where: { id } });
      if (locked === null) return { kind: 'gone' };
      const losesAdmin =
        locked.role === 'admin' &&
        locked.disabledAt === null &&
        ((role !== undefined && role !== 'admin') || disabled === true);
      if (losesAdmin) {
        const otherAdmins = await tx.user.count({ where: { role: 'admin', disabledAt: null, id: { not: locked.id } } });
        if (otherAdmins === 0) return { kind: 'lastAdmin' };
      }
      if (locked.id === actorId) return { kind: 'self' };
      const disabledAt = disabled === undefined ? locked.disabledAt : disabled ? (locked.disabledAt ?? new Date()) : null;
      const updated = await tx.user.update({
        where: { id },
        // Re-enabling cancels a deletion the person asked for (SHP-ADR-004): the grace period's point.
        data: { ...(role !== undefined ? { role } : {}), disabledAt, ...(disabledAt === null ? { deleteAfter: null } : {}) },
      });
      // A disabled user's sessions end at once; its tokens stop resolving because the owner is disabled.
      if (disabled === true) await tx.session.deleteMany({ where: { userId: id } });
      return { kind: 'ok', before: { role: locked.role, disabledAt: locked.disabledAt }, updated };
    });
    if (result.kind === 'gone') {
      sendRefusal(res, NO_SUCH_USER);
      return;
    }
    if (result.kind === 'lastAdmin') {
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
    if (result.kind === 'self') {
      sendRefusal(
        res,
        refusal('conflict', 'You cannot change your own role or disable yourself.', 'Ask another admin to do it.'),
      );
      return;
    }
    const { updated } = result;
    await req.audit({
      action: 'user.updated',
      entityType: 'user',
      entityId: id,
      before: { role: result.before.role, disabled: result.before.disabledAt !== null },
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
    // `existing` here is never a confirmed account (that was refused above), so it can only be a
    // pending user an earlier accept created. It never had a working login — deleting it means
    // this invite's own accept is the only thing that can create the user confirm-totp will later
    // apply this invite's role to, instead of confirm-totp binding to it by email alone and
    // inheriting a role or TOTP secret from a superseded invite (SHP-REQ-067).
    const pendingToClear = existing?.id;
    const { row, clearedPending } = await db.$transaction(async (tx) => {
      if (superseded.length > 0) {
        await tx.invite.updateMany({
          where: { id: { in: superseded.map((s) => s.id) }, acceptedAt: null, revokedAt: null },
          data: { revokedAt: createdAt },
        });
      }
      let cleared = false;
      if (pendingToClear !== undefined) {
        await tx.user.delete({ where: { id: pendingToClear } });
        cleared = true;
      }
      const created = await tx.invite.create({
        data: { email, role, tokenHash: hashInviteToken(token), invitedById: inviter, expiresAt },
        include: { invitedBy: { select: { email: true } } },
      });
      return { row: created, clearedPending: cleared };
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
        ...(clearedPending ? { clearedPendingUser: pendingToClear } : {}),
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
   * The account an earlier, unconfirmed accept of *this* invite created (accept may restart any
   * number of times against a still-live invite). Creating any new invite for an address deletes
   * a leftover pending user for it (see POST /invites), so a pending user found by email here can
   * only be one this exact invite's own accept produced — never a stale one from an invite that
   * has since been revoked or superseded. Anything with that email whose TOTP is already enabled
   * is a real account and blocks the invite.
   */
  async function pendingUserFor(invite: InviteRow) {
    const user = await db.user.findFirst({ where: { email: { equals: invite.email, mode: 'insensitive' } } });
    if (user === null) return { user: null, blocked: false } as const;
    return { user, blocked: user.totpEnabledAt !== null } as const;
  }

  /**
   * The accept step's account write, shared by the console and the app (SHP-T-11.2): a pending
   * account with a fresh, unconfirmed authenticator. `racing` when a concurrent first accept won.
   */
  async function writePendingAccount(
    invite: InviteRow,
    existing: Awaited<ReturnType<typeof pendingUserFor>>['user'],
    displayName: string,
    password: string,
  ): Promise<{ user: NonNullable<typeof existing>; totpSecret: string } | 'racing'> {
    const passwordHash = await hashPassword(password);
    const totpSecret = generateTotpSecret();
    const data = { displayName, passwordHash, totpSecret, totpEnabledAt: null, role: invite.role };
    if (existing !== null) return { user: await db.user.update({ where: { id: existing.id }, data }), totpSecret };
    try {
      return { user: await db.user.create({ data: { email: invite.email, ...data } }), totpSecret };
    } catch (e) {
      // Two concurrent first-accepts of the same invite: exactly one wins the unique email.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return 'racing';
      throw e;
    }
  }

  /** Spends the invite on the account whose first code just proved its authenticator. */
  async function consumeInvite(invite: InviteRow, userId: string, at: Date): Promise<boolean> {
    // Conditional updates, so two concurrent confirmations cannot both consume the invite.
    return db.$transaction(async (tx) => {
      const claimed = await tx.invite.updateMany({
        where: { id: invite.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: at },
      });
      if (claimed.count !== 1) return false;
      // The invite this confirm actually consumes decides the role, even if it was restarted
      // or the account row predates a role change on the invite itself.
      await tx.user.update({ where: { id: userId }, data: { totpEnabledAt: at, role: invite.role } });
      return true;
    });
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
    const written = await writePendingAccount(invite, pending.user, parsed.data.displayName, parsed.data.password);
    if (written === 'racing') {
      sendRefusal(
        res,
        refusal(
          'conflict',
          'This invite is already being accepted by another request.',
          'Wait a moment and check whether it went through, or reload the invite link.',
        ),
      );
      return;
    }
    const { user, totpSecret } = written;
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
    const consumed = await consumeInvite(invite, user.id, new Date(now()));
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

  // ── Accepting an invite from D3 Constellation (SHP-T-11.2) ─────────────
  // The account, then its authenticator, then a native session: the console's own accept and
  // confirm, in the contract's shape, with the token in the body. The invite is spent only by the
  // second step, as on the web, so a person who abandons the app halfway can start again.
  const NativeInvite = z.union([
    z.object({
      token: z.string().min(1).max(200),
      displayName: z.string().trim().min(1).max(100),
      password: z.string().min(1).max(1024),
      device: z.object({ name: z.string().trim().min(1).max(120), platform: z.string().trim().min(1).max(40) }).optional(),
    }),
    z.object({ challenge: z.string().min(1).max(200), enrolTotp: z.string().min(1).max(16) }),
  ]);
  const enrolments = new Map<string, { userId: string; inviteId: string; device: Device | null; expiresAt: number }>();
  const ENROL_TTL_MS = 15 * 60 * 1000;
  const problem = (res: Response, status: number, name: string, title: string, extra: Record<string, unknown> = {}): void => {
    res.status(status).type('application/problem+json').send(JSON.stringify({ type: `https://d3cloud.io/problems/${name}`, title, status, ...extra }));
  };
  const inviteInvalid = (res: Response): void => {
    problem(res, 410, 'invite_invalid', 'This invite can’t be used.', { detail: 'It has been used, revoked or has expired. Ask whoever invited you for a new one.' });
  };

  router.post('/auth/native/invite', limited, async (req, res) => {
    const parsed = NativeInvite.safeParse(req.body);
    if (!parsed.success) {
      sendRefusal(res, refusal('invalid_request', 'That request is not an invitation.'));
      return;
    }
    const body = parsed.data;
    const at = now();
    for (const [key, value] of enrolments) if (value.expiresAt <= at) enrolments.delete(key);

    if ('token' in body) {
      const invite = INVITE_TOKEN_RE.test(body.token) ? await db.invite.findUnique({ where: { tokenHash: hashInviteToken(body.token) } }) : null;
      // Unknown, revoked, used and expired are one answer: telling them apart says which guess was real.
      if (invite === null || invite.revokedAt !== null || invite.acceptedAt !== null || invite.expiresAt.getTime() <= at) {
        inviteInvalid(res);
        return;
      }
      if (body.password.length < MIN_PASSWORD_LENGTH) {
        problem(res, 422, 'weak_password', 'Choose a longer password.', { detail: `Use at least ${String(MIN_PASSWORD_LENGTH)} characters.` });
        return;
      }
      const pending = await pendingUserFor(invite);
      // A real account already holds the address: still "this invite can't be used", never a hint.
      if (pending.blocked) {
        inviteInvalid(res);
        return;
      }
      const written = await writePendingAccount(invite, pending.user, body.displayName, body.password);
      if (written === 'racing') {
        inviteInvalid(res);
        return;
      }
      const { user, totpSecret } = written;
      await req.audit({
        action: pending.user === null ? 'invite.accepted_pending_totp' : 'invite.accept_restarted',
        entityType: 'invite',
        entityId: invite.id,
        after: { userId: user.id, email: user.email, role: user.role, via: 'native' },
        actor: { type: 'user', id: user.id, label: user.email },
      });
      const challenge = randomBytes(32).toString('base64url');
      enrolments.set(challenge, { userId: user.id, inviteId: invite.id, device: body.device ?? null, expiresAt: at + ENROL_TTL_MS });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ challenge, enrolment: { secret: totpSecret, otpauthUri: totpUri(totpSecret, user.email), digits: 6, period: 30 } });
      return;
    }

    const pending = enrolments.get(body.challenge);
    if (pending === undefined) {
      problem(res, 401, 'invalid_code', 'This setup has expired.', { detail: 'Open the invite link again to start over.' });
      return;
    }
    const [invite, user] = await Promise.all([
      db.invite.findUnique({ where: { id: pending.inviteId } }),
      db.user.findUnique({ where: { id: pending.userId } }),
    ]);
    if (invite === null || invite.revokedAt !== null || invite.acceptedAt !== null || invite.expiresAt.getTime() <= at || user === null || user.totpSecret === null) {
      enrolments.delete(body.challenge);
      inviteInvalid(res);
      return;
    }
    // A wrong code leaves the challenge valid until it expires; the route's rate limit bounds guessing.
    if (!verifyTotp(user.totpSecret, body.enrolTotp, at)) {
      await req.audit({ action: 'invite.totp_failed', entityType: 'invite', entityId: invite.id, after: { userId: user.id, via: 'native' }, actor: ANONYMOUS_ACTOR });
      problem(res, 401, 'invalid_code', 'That code didn’t work.', { detail: 'Enter the current six-digit code from the authenticator you just added.' });
      return;
    }
    if (!(await consumeInvite(invite, user.id, new Date(at)))) {
      enrolments.delete(body.challenge);
      inviteInvalid(res);
      return;
    }
    enrolments.delete(body.challenge);
    await req.audit({
      action: 'invite.accepted',
      entityType: 'user',
      entityId: user.id,
      after: { inviteId: invite.id, email: user.email, role: invite.role, invitedById: invite.invitedById, via: 'native' },
      actor: { type: 'user', id: user.id, label: user.email },
    });
    const tokens = await issueNativeSession(db, { userId: user.id, method: 'password', device: pending.device, ip: req.ip, userAgent: req.get('user-agent'), now: new Date(at) });
    await req.audit({
      action: 'auth.login.succeeded',
      entityType: 'session',
      entityId: tokens.sessionId,
      after: { method: 'password', userId: user.id, via: 'native', device: pending.device?.name ?? null },
      actor: { type: 'user', id: user.id, label: user.email },
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresIn: tokens.expiresIn, session: { id: tokens.sessionId } });
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
