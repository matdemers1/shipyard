import { refusal, type PollRequest, type Refusal } from '@shipyard/schema';
import type { Bus } from '../events.js';

/**
 * What each agent said it can do on its last poll (SHP-ADR-010, SHP-ADR-011). `POST /api/actions`
 * and `POST /api/logs` read this to refuse at once (`agent_too_old`) rather than queue work no poll
 * will ever take: the poll only hands an action or a log read to an agent that advertised it.
 *
 * In memory, per server process — a capability is a live fact about a connected agent, like a
 * heartbeat. After a restart the first poll (at most `waitSeconds`, 25 s, later) records it again;
 * until then a request is refused `agent_offline`, which is true from the server's point of view.
 * Keyed by the process's `Bus`, so each app instance (and each integration test) has its own.
 */

export type Capability = NonNullable<PollRequest['capabilities']>[number];

/** A poll older than this no longer counts as "connected": the agent polls at most 25 s apart. */
export const CAPABILITY_FRESH_MS = 90_000;

interface Seen {
  capabilities: ReadonlySet<Capability>;
  at: number;
}

const trackers = new WeakMap<Bus, Map<string, Seen>>();

function trackerFor(bus: Bus): Map<string, Seen> {
  let tracker = trackers.get(bus);
  if (tracker === undefined) {
    tracker = new Map();
    trackers.set(bus, tracker);
  }
  return tracker;
}

/** Records the capabilities `agentId` sent on the poll it just made. */
export function recordCapabilities(bus: Bus, agentId: string, capabilities: readonly Capability[] | undefined, now: number = Date.now()): void {
  trackerFor(bus).set(agentId, { capabilities: new Set(capabilities ?? []), at: now });
}

/**
 * Null when `agentId` polled recently and advertised `capability`; otherwise the refusal:
 * `agent_offline` when it has not polled within `CAPABILITY_FRESH_MS`, `agent_too_old` when it
 * polls but never said it can do this.
 */
export function capabilityRefusal(bus: Bus, agentId: string, capability: Capability, now: number = Date.now()): Refusal | null {
  const seen = trackerFor(bus).get(agentId);
  if (seen === undefined || now - seen.at > CAPABILITY_FRESH_MS) {
    return refusal('agent_offline', 'The agent that runs this has not polled the server recently.', 'Check the agent is running and can reach the server, then retry.');
  }
  if (!seen.capabilities.has(capability)) {
    const what = capability === 'logs' ? 'read container logs' : capability === 'actions' ? 'run lifecycle actions' : 'run builds';
    return refusal('agent_too_old', `The agent on this host cannot ${what} yet.`);
  }
  return null;
}
