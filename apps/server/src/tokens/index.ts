import { Router } from 'express';
import { TokenCreate, refusal, type TokenCreated } from '@shipyard/schema';
import { requireUser } from '../auth/index.js';
import { requireRole, STATE_CHANGING_ROLES } from '../auth/scope.js';
import type { Prisma } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';
import { generateToken } from './tokens.js';

export { generateToken, hashToken, resolveToken, TOKEN_RE, PREFIX_LENGTH, type ResolvedToken } from './tokens.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_SUCH_TOKEN = refusal('not_found', 'No such token.', 'List your tokens and use one of their IDs.');

/** What a token looks like in a list: never the token, never its hash. */
interface TokenSummary {
  id: string;
  userId: string;
  label: string;
  prefix: string;
  apps: string[];
  /** May it read container logs (SHP-ADR-011)? */
  canReadLogs: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
}

const SUMMARY_SELECT = {
  id: true,
  userId: true,
  label: true,
  prefix: true,
  canReadLogs: true,
  createdAt: true,
  lastUsedAt: true,
  lastUsedIp: true,
  revokedAt: true,
  apps: { select: { app: { select: { name: true } } } },
  stacks: { select: { stack: { select: { name: true } } } },
} satisfies Prisma.ApiTokenSelect;

function summarise(row: {
  id: string;
  userId: string;
  label: string;
  prefix: string;
  canReadLogs: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  revokedAt: Date | null;
  apps: { app: { name: string } }[];
  stacks: { stack: { name: string } }[];
}): TokenSummary {
  return {
    id: row.id,
    userId: row.userId,
    label: row.label,
    prefix: row.prefix,
    // A scope names apps and adopted stacks alike (SHP-T-15.4).
    apps: [...row.apps.map((a) => a.app.name), ...row.stacks.map((s) => s.stack.name)].sort(),
    canReadLogs: row.canReadLogs,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: row.lastUsedIp,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/**
 * Mounted at `/api/tokens` (SHP-REQ-046, SHP-D-063). Tokens are managed by signed-in users only:
 * a token can never issue, list or revoke tokens.
 */
export function tokensRouter(deps: ServiceDeps): Router {
  const { db } = deps;
  const router = Router();

  router.use((req, res, next) => {
    if (req.actor?.type === 'token') {
      sendRefusal(
        res,
        refusal('forbidden', 'An API token cannot manage API tokens.', 'Sign in to the console to manage tokens.'),
      );
      return;
    }
    next();
  });
  router.use(requireUser);

  router.get('/', async (req, res) => {
    const userId = req.actor?.id ?? '';
    const rows = await db.apiToken.findMany({
      where: req.role === 'admin' ? {} : { userId },
      select: SUMMARY_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    res.json(rows.map(summarise));
  });

  router.post('/', requireRole(...STATE_CHANGING_ROLES), async (req, res) => {
    const parsed = TokenCreate.safeParse(req.body);
    if (!parsed.success) {
      sendRefusal(
        res,
        refusal(
          'invalid_request',
          'A label and at least one app name are required.',
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        ),
      );
      return;
    }
    const label = parsed.data.label;
    const canReadLogs = parsed.data.canReadLogs === true;
    // A token never reads more than its owner could: only an admin or operator reads logs (SHP-ADR-011).
    if (canReadLogs && req.role !== 'admin' && req.role !== 'operator') {
      sendRefusal(res, refusal('forbidden', 'Only an admin or operator can issue a token that reads container logs.', 'Leave "can read logs" off, or ask an admin.'));
      return;
    }
    const names = [...new Set(parsed.data.apps)].sort();
    // A scope names apps and adopted stacks (SHP-T-15.4). A stack never shares an app's name (the
    // report refuses one that would), so each name is one or the other.
    const apps = await db.app.findMany({ where: { name: { in: names }, retiredAt: null }, select: { id: true, name: true } });
    const appNames = new Set(apps.map((a) => a.name));
    const stacks = await db.stack.findMany({
      where: { name: { in: names.filter((n) => !appNames.has(n)) }, retiredAt: null },
      select: { id: true, name: true },
    });
    const known = new Set([...appNames, ...stacks.map((s) => s.name)]);
    const missing = names.find((n) => !known.has(n));
    if (missing !== undefined) {
      sendRefusal(res, refusal('unknown_app', `No app or adopted stack named ${missing} has been reported by the agent.`));
      return;
    }

    const { token, hash, prefix } = generateToken();
    const row = await db.apiToken.create({
      data: {
        userId: req.actor?.id ?? '',
        label,
        tokenHash: hash,
        prefix,
        canReadLogs,
        apps: { create: apps.map((a) => ({ appId: a.id })) },
        ...(stacks.length === 0 ? {} : { stacks: { create: stacks.map((s) => ({ stackId: s.id })) } }),
      },
      select: { id: true },
    });
    await req.audit({
      action: 'token.created',
      entityType: 'api_token',
      entityId: row.id,
      after: { label, prefix, apps: names, ...(canReadLogs ? { canReadLogs } : {}) },
    });
    const body: TokenCreated = { id: row.id, label, prefix, apps: names, token };
    res.status(201).json(body);
  });

  router.delete('/:id', requireRole(...STATE_CHANGING_ROLES), async (req, res) => {
    const raw: unknown = req.params['id'];
    const id = typeof raw === 'string' ? raw : '';
    if (!UUID_RE.test(id)) {
      sendRefusal(res, NO_SUCH_TOKEN);
      return;
    }
    const existing = await db.apiToken.findUnique({ where: { id }, select: SUMMARY_SELECT });
    // Someone else's token is reported as absent, so its existence is not disclosed.
    if (existing === null || (existing.userId !== req.actor?.id && req.role !== 'admin')) {
      sendRefusal(res, NO_SUCH_TOKEN);
      return;
    }
    const already = existing.revokedAt !== null;
    const row = already
      ? existing
      : await db.apiToken.update({ where: { id }, data: { revokedAt: new Date() }, select: SUMMARY_SELECT });
    const summary = summarise(row);
    await req.audit({
      action: 'token.revoked',
      entityType: 'api_token',
      entityId: id,
      before: { revokedAt: existing.revokedAt?.toISOString() ?? null },
      after: { label: summary.label, prefix: summary.prefix, apps: summary.apps, revokedAt: summary.revokedAt, alreadyRevoked: already },
    });
    res.json(summary);
  });

  return router;
}
