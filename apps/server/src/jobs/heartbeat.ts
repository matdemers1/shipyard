import type { ServiceDeps } from '../deps.js';
import type { Mailer } from '../mail/index.js';

/** How often `startHeartbeat` checks the agent's last heartbeat. */
export const HEARTBEAT_CHECK_INTERVAL_MS = 60_000;

/** Never re-alerts for an episode that already alerted within this window, even across a restart. */
const EPISODE_MEMORY_MS = 60 * 60 * 1000;

const SYSTEM_ACTOR = { actorType: 'system' as const, actorLabel: 'heartbeat' };

function docker(): string {
  return 'docker compose -p shipyard logs agent';
}

/**
 * Checks the confirmed agent's `lastHeartbeatAt` against `HEARTBEAT_STALE_MINUTES` and sends one
 * alert email per stale episode (SHP-T-6.4, SHP-REQ-093).
 *
 * "One episode" is tracked two ways: in memory for this process's lifetime (`state.alerted`), and
 * — so a restart mid-episode does not re-send — by checking for a `system.alert` audit event for
 * this agent within the last hour before sending. A restart more than an hour into an existing
 * episode can still produce one duplicate email; that is accepted, not silently risked (see
 * module doc).
 */
export async function checkHeartbeat(
  deps: ServiceDeps,
  mailer: Mailer,
  state: { alerted: boolean },
  now: Date = new Date(),
): Promise<void> {
  const { db, logger, config } = deps;
  const agent = await db.agent.findFirst({
    where: { confirmedAt: { not: null } },
    orderBy: { enrolledAt: 'asc' },
    select: { id: true, fingerprint: true, lastHeartbeatAt: true },
  });
  if (agent === null) {
    // No confirmed agent: nothing to be stale about.
    return;
  }

  const thresholdMs = config.HEARTBEAT_STALE_MINUTES * 60_000;
  const lastHeartbeatAt = agent.lastHeartbeatAt;
  const staleMs = lastHeartbeatAt === null ? Infinity : now.getTime() - lastHeartbeatAt.getTime();
  const stale = staleMs > thresholdMs;

  if (!stale) {
    if (state.alerted) {
      logger.info({ agentId: agent.id, fingerprint: agent.fingerprint }, 'agent heartbeat recovered');
    }
    state.alerted = false;
    return;
  }

  if (state.alerted) {
    // Already alerted for this episode in this process.
    return;
  }

  const lastSeen = lastHeartbeatAt === null ? 'never' : lastHeartbeatAt.toISOString();

  // Guard against re-alerting for the *same* episode that already alerted within the last hour,
  // in case this process just restarted mid-episode. Identified by `lastHeartbeatAt` not having
  // moved since that alert: a heartbeat that moved forward means the agent recovered and went
  // stale again — a new episode, which does get its own email even inside the hour.
  const recent = await db.auditEvent.findFirst({
    where: {
      action: 'system.alert',
      entityType: 'agent',
      entityId: agent.id,
      at: { gt: new Date(now.getTime() - EPISODE_MEMORY_MS) },
    },
    orderBy: { at: 'desc' },
    select: { after: true },
  });
  const recentLastHeartbeatAt = (recent?.after as { lastHeartbeatAt?: string } | null)?.lastHeartbeatAt;
  if (recent !== null && recentLastHeartbeatAt === lastSeen) {
    state.alerted = true;
    return;
  }

  const minutes = lastHeartbeatAt === null ? null : Math.floor(staleMs / 60_000);
  const subject = `The agent has not been heard from in ${minutes === null ? 'over' : String(minutes)} minutes`;
  const body = [
    `Agent fingerprint: ${agent.fingerprint}`,
    `Last heartbeat: ${lastSeen}`,
    'What this means: deploys will not run until the agent is back — it holds every app lock.',
    `What to do: check the agent container on the host — ${docker()}`,
  ].join('\n');

  // This job already sends once per stale episode; the mailer's hourly suppression must not
  // swallow a second episode that starts within the hour.
  const result = await mailer.send({ kind: 'agent-stale', subject, body }, { repeat: true });
  state.alerted = true;

  await db.auditEvent.create({
    data: {
      ...SYSTEM_ACTOR,
      action: 'system.alert',
      entityType: 'agent',
      entityId: agent.id,
      after: { kind: 'agent-stale', sent: result.sent, reason: result.reason ?? null, lastHeartbeatAt: lastSeen },
    },
  });

  if (result.sent) {
    logger.warn({ agentId: agent.id, fingerprint: agent.fingerprint, lastHeartbeatAt: lastSeen }, 'agent stale: alert email sent');
  } else {
    logger.warn(
      { agentId: agent.id, fingerprint: agent.fingerprint, lastHeartbeatAt: lastSeen, reason: result.reason },
      'agent stale: alert email not sent',
    );
  }
}

/**
 * Starts the periodic stale-agent check (SHP-T-6.4). Checks every minute; exactly one email per
 * stale episode (SHP-REQ-093).
 */
export function startHeartbeat(
  deps: ServiceDeps,
  mailer: Mailer,
  intervalMs = HEARTBEAT_CHECK_INTERVAL_MS,
): { stop: () => Promise<void> } {
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  const state = { alerted: false };

  const tick = (): void => {
    inFlight = checkHeartbeat(deps, mailer, state).catch((err: unknown) => {
      deps.logger.error({ err }, 'heartbeat check failed');
    });
  };

  const timer = setInterval(tick, intervalMs);
  tick();

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
