import { Router } from 'express';
import { refusal, type SystemBackupRun, type SystemStatus } from '@shipyard/schema';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';

/**
 * Mounted at /api/system · the System screen's data (SHP-T-6.5, S15): versions, the agent's
 * heartbeat and PAT expiry, the Foreman outbox backlog, and Shipyard's own backups.
 *
 * Console-only, deployer and above (SHP-REQ-094/095/106): a viewer is refused (this is about what
 * to do next, not what happened), and so is a token — there is no MCP use for it.
 */

const PAT_WARNING_DAYS = 30;
const PAT_WARNING_MS = PAT_WARNING_DAYS * 24 * 60 * 60 * 1000;
const OUTBOX_STALE_MS = 60 * 60 * 1000;

const DEPLOYER_ROLES = new Set(['admin', 'operator', 'deployer']);

const CONSOLE_ONLY = refusal(
  'forbidden',
  'System status is read in the console, not with a token.',
  'Sign in to the console as a deployer to see this.',
);

async function backupRun(deps: ServiceDeps, action: 'system.backup' | 'system.drill'): Promise<SystemBackupRun | null> {
  const row = await deps.db.auditEvent.findFirst({
    where: { action },
    orderBy: { at: 'desc' },
    select: { at: true, after: true },
  });
  if (row === null) return null;
  const after = (row.after ?? {}) as { ok?: boolean; file?: string; bytes?: number; durationMs?: number; error?: string };
  return {
    at: row.at.toISOString(),
    ok: after.ok === true,
    file: after.file ?? null,
    bytes: after.bytes ?? null,
    durationMs: after.durationMs ?? null,
    error: after.error ?? null,
  };
}

export function systemRouter(deps: ServiceDeps): Router {
  const router = Router();
  const { db, config } = deps;

  router.get('/', async (req, res) => {
    const actor = req.actor;
    if (actor === undefined) {
      sendRefusal(res, refusal('unauthenticated', 'You are not signed in.'));
      return;
    }
    if (actor.type !== 'user') {
      sendRefusal(res, CONSOLE_ONLY);
      return;
    }
    if (req.role === undefined || !DEPLOYER_ROLES.has(req.role)) {
      sendRefusal(
        res,
        refusal('forbidden', 'The viewer role cannot see system status.', 'Ask an admin for the deployer role.'),
      );
      return;
    }

    const now = new Date();

    const agentRow = await db.agent.findFirst({
      where: { confirmedAt: { not: null } },
      orderBy: { enrolledAt: 'asc' },
      select: {
        fingerprint: true,
        lastHeartbeatAt: true,
        agentVersion: true,
        composeVersion: true,
        engineApiVersion: true,
        patExpiresAt: true,
      },
    });

    const thresholdMs = config.HEARTBEAT_STALE_MINUTES * 60_000;
    const stale =
      agentRow === null
        ? false
        : agentRow.lastHeartbeatAt === null || now.getTime() - agentRow.lastHeartbeatAt.getTime() > thresholdMs;

    const patWarning: 'none' | 'expiring' | 'expired' =
      agentRow?.patExpiresAt === undefined || agentRow.patExpiresAt === null
        ? 'none'
        : agentRow.patExpiresAt.getTime() <= now.getTime()
          ? 'expired'
          : agentRow.patExpiresAt.getTime() - now.getTime() <= PAT_WARNING_MS
            ? 'expiring'
            : 'none';

    const [unsent, unsentOverHour, oldest, latestErrored] = await Promise.all([
      db.outbox.count({ where: { deliveredAt: null } }),
      db.outbox.count({ where: { deliveredAt: null, createdAt: { lt: new Date(now.getTime() - OUTBOX_STALE_MS) } } }),
      db.outbox.findFirst({ where: { deliveredAt: null }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      db.outbox.findFirst({
        where: { deliveredAt: null, lastError: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { lastError: true },
      }),
    ]);

    const [lastBackup, lastDrill] = await Promise.all([
      backupRun(deps, 'system.backup'),
      backupRun(deps, 'system.drill'),
    ]);

    const status: SystemStatus = {
      versions: {
        server: config.SHIPYARD_VERSION,
        agent: agentRow?.agentVersion ?? null,
        compose: agentRow?.composeVersion ?? null,
        engineApi: agentRow?.engineApiVersion ?? null,
      },
      agent:
        agentRow === null
          ? null
          : {
              fingerprint: agentRow.fingerprint,
              lastHeartbeatAt: agentRow.lastHeartbeatAt?.toISOString() ?? null,
              stale,
              patExpiresAt: agentRow.patExpiresAt?.toISOString() ?? null,
              patWarning,
            },
      outbox: {
        unsent,
        unsentOverHour,
        oldestUnsentAt: oldest?.createdAt.toISOString() ?? null,
        lastError: latestErrored?.lastError ?? null,
      },
      backups: { lastBackup, lastDrill },
    };

    res.json(status);
  });

  return router;
}
