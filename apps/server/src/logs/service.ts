import { LogsRequest, refusal, type LogLine, type LogsSession, type Refusal } from '@shipyard/schema';
import { capabilityRefusal } from '../agent/capabilities.js';
import type { ServiceDeps } from '../deps.js';
import type { DeployCaller } from '../deploys/service.js';
import { snapshotContainers } from '../host/index.js';
import { logsHubFor, type LogsEvent, type LogsSessionInfo, type LogsViewer } from './hub.js';

/**
 * Opening a log session (SHP-ADR-011; SHP-REQ-189, SHP-REQ-191, SHP-REQ-192): who may, which
 * container, and the audit row that every view leaves — viewer, container and window, never a
 * line of content.
 *
 * Who: an admin or operator signed in; or an API token created with `can_read_logs` whose owner is
 * still an admin or operator — a token never reads more than the person behind it could.
 */

/** Roles that may read container logs in the console. */
export const LOG_READER_ROLES = ['admin', 'operator'] as const;

/** The longest `readLogsTail` waits for the agent to send the tail. */
export const MAX_TAIL_WAIT_MS = 60_000;

function isReaderRole(role: string | undefined): boolean {
  return role !== undefined && (LOG_READER_ROLES as readonly string[]).includes(role);
}

/** The viewer a caller is, or the refusal when it may not read logs at all. */
export async function logsViewerOf(deps: ServiceDeps, caller: Pick<DeployCaller, 'actor' | 'role'>): Promise<LogsViewer | Refusal> {
  const actor = caller.actor;
  if (actor === undefined) return refusal('unauthenticated', 'You are not signed in.');
  if ((actor.type !== 'user' && actor.type !== 'token') || actor.id === undefined) {
    return refusal('forbidden', `A ${actor.type} actor cannot read container logs.`);
  }
  if (actor.type === 'token') {
    const token = await deps.db.apiToken.findUnique({ where: { id: actor.id }, select: { canReadLogs: true } });
    if (token?.canReadLogs !== true) {
      return refusal('forbidden', 'This token may not read container logs.', 'Issue a token with "can read logs" from an admin or operator account.');
    }
    if (!isReaderRole(caller.role)) {
      return refusal('forbidden', "This token's owner may no longer read container logs.", 'Ask an admin for the operator role, or use another token.');
    }
    return { type: 'token', id: actor.id };
  }
  if (!isReaderRole(caller.role)) {
    return refusal('forbidden', 'Reading container logs needs the admin or operator role.', 'Ask an admin for the operator role.');
  }
  return { type: 'user', id: actor.id };
}

export function toLogsSession(s: LogsSessionInfo): LogsSession {
  return {
    id: s.id,
    container: s.container,
    containerName: s.containerName,
    tail: s.tail,
    follow: s.follow,
    createdAt: s.createdAt.toISOString(),
  };
}

/**
 * Opens a session for `input` (already a parsed `LogsRequest`), audits it as `logs.view`, and wakes
 * the agent's poll; or returns the refusal.
 */
export async function openLogs(deps: ServiceDeps, caller: DeployCaller, input: LogsRequest): Promise<LogsSessionInfo | Refusal> {
  const viewer = await logsViewerOf(deps, caller);
  if ('code' in viewer) return viewer;

  const found = (await snapshotContainers(deps.db)).find((c) => c.container.id === input.container);
  if (found === undefined) {
    return refusal('unknown_container', 'The agent does not report a container with that ID.');
  }
  const cannot = capabilityRefusal(deps.bus, found.agentId, 'logs');
  if (cannot !== null) return cannot;

  const session = logsHubFor(deps.bus).open({
    agentId: found.agentId,
    container: input.container,
    containerName: found.container.name,
    tail: input.tail,
    follow: input.follow,
    viewer,
  });
  if ('code' in session) return session;

  // SHP-REQ-192: who looked at which container, over what window. Never a line of what they saw.
  await caller.audit({
    action: 'logs.view',
    entityType: 'container',
    entityId: input.container,
    after: {
      logsId: session.id,
      viewer: caller.actor?.label ?? null,
      container: input.container,
      containerName: found.container.name,
      app: found.container.app,
      tier: found.container.tier,
      tail: input.tail,
      follow: input.follow,
      window: { tail: input.tail, followSeconds: session.followSeconds },
    },
  });
  deps.logger.info({ logsId: session.id, tail: input.tail, follow: input.follow }, 'log session opened');
  deps.bus.publish('work');
  return session;
}

export interface TailInput {
  containerId: string;
  tail?: number;
}

/**
 * Reads a container's recent lines without following (`shipyard_logs`, SHP-T-15.5): opens a
 * session, collects its chunks until the agent sends the last one or `timeoutMs` passes, then closes
 * it. The lines are returned to the caller and kept nowhere. A refusal when the caller may not
 * read logs, the container is unknown, the agent cannot, or the agent sent nothing in time.
 */
export async function readLogsTail(deps: ServiceDeps, caller: DeployCaller, input: TailInput, timeoutMs: number): Promise<LogLine[] | Refusal> {
  const parsed = LogsRequest.safeParse({ container: input.containerId, ...(input.tail === undefined ? {} : { tail: input.tail }), follow: false });
  if (!parsed.success) {
    return refusal('invalid_request', 'The logs request failed validation.', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const session = await openLogs(deps, caller, parsed.data);
  if ('code' in session) return session;

  const hub = logsHubFor(deps.bus);
  const lines: LogLine[] = [];
  // Written by the listener; an object so the reads below are not narrowed away.
  const heardFrom: { agent: boolean; ending: Refusal | undefined } = { agent: false, ending: undefined };
  let unsubscribe: () => void = () => undefined;
  const ended = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, Math.max(0, Math.min(MAX_TAIL_WAIT_MS, timeoutMs)));
    unsubscribe = hub.subscribe(session.id, (event: LogsEvent) => {
      if (event.type === 'lines') {
        heardFrom.agent = true;
        lines.push(...event.lines);
        return;
      }
      heardFrom.agent = heardFrom.agent || event.reason === 'done';
      heardFrom.ending = event.error;
      clearTimeout(timer);
      resolve(true);
    });
  });
  unsubscribe();
  hub.stop(session.id);
  if (heardFrom.ending !== undefined && lines.length === 0) return heardFrom.ending;
  if (!ended && !heardFrom.agent) {
    return refusal('agent_offline', 'The agent did not send the logs in time.', 'Check the agent is running and can reach the server, then retry.');
  }
  return lines;
}
