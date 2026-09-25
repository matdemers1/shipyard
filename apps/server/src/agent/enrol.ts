import type { Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import { EnrolRequest, refusal } from '@shipyard/schema';
import type { Actor } from '../audit.js';
import { requireUser } from '../auth/index.js';
import { requireRole, STATE_CHANGING_ROLES } from '../auth/scope.js';
import { Prisma } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';
import { verifyAgentRequest } from './verify.js';

/**
 * Agent enrolment by fingerprint confirmation (SHP-REQ-035, SHP-REQ-064; SHP-D-064).
 *
 * An agent presents its public key once (`POST /enrol`); the server records it unconfirmed, and
 * every other agent route refuses it with `not_enrolled` until a deployer types the fingerprint
 * they read on the host into the console (`POST /:id/confirm`). An admin can revoke that
 * confirmation, which puts the agent back to `not_enrolled`.
 */

/** Enrol attempts allowed per source IP per window: anyone can mint a key and sign with it. */
export const ENROL_LIMIT = 10;
export const ENROL_WINDOW_MS = 60 * 1000;
/** A heartbeat older than this (or none) marks an agent stale in the console. */
export const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_SUCH_AGENT = refusal('not_found', 'No such agent.', 'List agents and use one of their IDs.');

const ConfirmBody = z.strictObject({ fingerprint: z.string().min(1).max(200) });

export interface EnrolResponse {
  fingerprint: string;
  confirmed: boolean;
}

export interface AgentSummary {
  id: string;
  fingerprint: string;
  confirmed: boolean;
  confirmedAt: string | null;
  confirmedBy: { id: string; email: string; displayName: string } | null;
  enrolledAt: string;
  lastHeartbeatAt: string | null;
  agentVersion: string | null;
  composeVersion: string | null;
  engineApiVersion: string | null;
  stale: boolean;
}

const SUMMARY_SELECT = {
  id: true,
  fingerprint: true,
  enrolledAt: true,
  confirmedAt: true,
  lastHeartbeatAt: true,
  agentVersion: true,
  composeVersion: true,
  engineApiVersion: true,
  confirmedByUser: { select: { id: true, email: true, displayName: true } },
} satisfies Prisma.AgentSelect;

type SummaryRow = Prisma.AgentGetPayload<{ select: typeof SUMMARY_SELECT }>;

function summarise(row: SummaryRow, now: number): AgentSummary {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    confirmed: row.confirmedAt !== null,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    confirmedBy: row.confirmedByUser,
    enrolledAt: row.enrolledAt.toISOString(),
    lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
    agentVersion: row.agentVersion,
    composeVersion: row.composeVersion,
    engineApiVersion: row.engineApiVersion,
    stale: row.lastHeartbeatAt === null || now - row.lastHeartbeatAt.getTime() > HEARTBEAT_STALE_MS,
  };
}

/** Fixed-window counter per source IP, in memory. Checked before any signature work or DB read. */
function enrolRateLimit(): RequestHandler {
  const windows = new Map<string, { start: number; count: number }>();
  return (req, res, next) => {
    const now = Date.now();
    if (windows.size > 10_000) {
      for (const [ip, w] of windows) if (now - w.start >= ENROL_WINDOW_MS) windows.delete(ip);
    }
    const ip = req.ip ?? 'unknown';
    let w = windows.get(ip);
    if (w === undefined || now - w.start >= ENROL_WINDOW_MS) {
      w = { start: now, count: 0 };
      windows.set(ip, w);
    }
    w.count += 1;
    if (w.count > ENROL_LIMIT) {
      res.setHeader('retry-after', String(Math.ceil((w.start + ENROL_WINDOW_MS - now) / 1000)));
      sendRefusal(
        res,
        refusal('too_many_attempts', 'Too many enrolment attempts from this address.', 'Wait a minute, then retry.'),
      );
      return;
    }
    next();
  };
}

/** Agent confirmation and revocation are console actions: an API token is refused outright. */
const consoleOnly: RequestHandler = (req, res, next) => {
  if (req.actor?.type === 'token') {
    sendRefusal(
      res,
      refusal('forbidden', 'An API token cannot confirm or revoke agents.', 'Sign in to the console to do this.'),
    );
    return;
  }
  next();
};

function agentId(req: Request, res: Response): string | null {
  const raw: unknown = req.params['id'];
  const id = typeof raw === 'string' ? raw : '';
  if (!UUID_RE.test(id)) {
    sendRefusal(res, NO_SUCH_AGENT);
    return null;
  }
  return id;
}

export function mountEnrol(router: Router, deps: ServiceDeps): void {
  const { db } = deps;

  // ── The agent's side ──────────────────────────────────────────────────
  router.post(
    '/enrol',
    enrolRateLimit(),
    verifyAgentRequest(deps, { enrolment: true, allowUnconfirmed: true }),
    async (req, res) => {
      const parsed = EnrolRequest.safeParse(req.body);
      const agent = req.agent;
      if (!parsed.success || agent === undefined) {
        sendRefusal(
          res,
          refusal(
            'invalid_request',
            'An enrolment needs the public key and the agent version.',
            parsed.success ? undefined : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          ),
        );
        return;
      }
      const { agentVersion } = parsed.data;
      const label = `agent ${agent.fingerprint.slice(0, 15)}`;

      let existing = agent.id === null ? null : await db.agent.findUnique({ where: { id: agent.id } });
      if (existing === null) {
        try {
          const row = await db.agent.create({
            data: { publicKey: agent.publicKeyB64, fingerprint: agent.fingerprint, agentVersion },
          });
          const actor: Actor = { type: 'agent', id: row.id, label };
          await req.audit({
            action: 'agent.enrol_requested',
            entityType: 'agent',
            entityId: row.id,
            after: { fingerprint: row.fingerprint, agentVersion },
            actor,
          });
          const body: EnrolResponse = { fingerprint: row.fingerprint, confirmed: false };
          res.json(body);
          return;
        } catch (err) {
          // A concurrent enrol of the same key won the insert; fall through to the update.
          if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
          existing = await db.agent.findUnique({ where: { fingerprint: agent.fingerprint } });
          if (existing === null) throw err;
        }
      }

      const row =
        existing.agentVersion === agentVersion
          ? existing
          : await db.agent.update({ where: { id: existing.id }, data: { agentVersion } });
      await req.audit({
        action: 'agent.enrol_repeated',
        entityType: 'agent',
        entityId: row.id,
        before: { agentVersion: existing.agentVersion },
        after: { agentVersion, confirmed: row.confirmedAt !== null },
        actor: { type: 'agent', id: row.id, label },
      });
      const body: EnrolResponse = { fingerprint: row.fingerprint, confirmed: row.confirmedAt !== null };
      res.json(body);
    },
  );

  // ── The console's side ────────────────────────────────────────────────
  router.get('/', requireUser, async (_req, res) => {
    const rows = await db.agent.findMany({ select: SUMMARY_SELECT, orderBy: { enrolledAt: 'asc' } });
    const now = Date.now();
    res.json(rows.map((r) => summarise(r, now)));
  });

  router.post('/:id/confirm', consoleOnly, requireUser, requireRole(...STATE_CHANGING_ROLES), async (req, res) => {
    const id = agentId(req, res);
    if (id === null) return;
    const parsed = ConfirmBody.safeParse(req.body);
    if (!parsed.success) {
      sendRefusal(
        res,
        refusal('invalid_request', 'Type the fingerprint shown on the host.', 'Send { "fingerprint": "SHA256:…" }.'),
      );
      return;
    }
    const existing = await db.agent.findUnique({ where: { id }, select: SUMMARY_SELECT });
    if (existing === null) {
      sendRefusal(res, NO_SUCH_AGENT);
      return;
    }
    if (parsed.data.fingerprint.trim() !== existing.fingerprint) {
      sendRefusal(
        res,
        refusal(
          'conflict',
          'The fingerprint does not match this agent.',
          'Compare it character by character with the fingerprint the agent logs on the host; if they differ, do not confirm it.',
        ),
      );
      return;
    }
    const already = existing.confirmedAt !== null;
    const row = already
      ? existing
      : await db.agent.update({
          where: { id },
          data: { confirmedAt: new Date(), confirmedByUserId: req.actor?.id ?? null },
          select: SUMMARY_SELECT,
        });
    await req.audit({
      action: 'agent.confirmed',
      entityType: 'agent',
      entityId: id,
      before: { confirmedAt: existing.confirmedAt?.toISOString() ?? null },
      after: { fingerprint: row.fingerprint, confirmedAt: row.confirmedAt?.toISOString() ?? null, alreadyConfirmed: already },
    });
    res.json(summarise(row, Date.now()));
  });

  router.post('/:id/revoke', consoleOnly, requireUser, requireRole('admin'), async (req, res) => {
    const id = agentId(req, res);
    if (id === null) return;
    const existing = await db.agent.findUnique({ where: { id }, select: SUMMARY_SELECT });
    if (existing === null) {
      sendRefusal(res, NO_SUCH_AGENT);
      return;
    }
    const row = await db.agent.update({
      where: { id },
      data: { confirmedAt: null, confirmedByUserId: null },
      select: SUMMARY_SELECT,
    });
    await req.audit({
      action: 'agent.revoked',
      entityType: 'agent',
      entityId: id,
      before: {
        confirmedAt: existing.confirmedAt?.toISOString() ?? null,
        confirmedByUserId: existing.confirmedByUser?.id ?? null,
      },
      after: { fingerprint: row.fingerprint, confirmedAt: null },
    });
    res.json(summarise(row, Date.now()));
  });
}
