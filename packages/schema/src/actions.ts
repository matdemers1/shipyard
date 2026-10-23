import { z } from 'zod';

import { AppName } from './primitives.js';
import { Refusal } from './errors.js';

/**
 * Lifecycle actions and container logs (SHP-ADR-010, SHP-ADR-011): the REST bodies the console
 * sends, the jobs the server hands the agent on its long-poll, and what the agent sends back.
 *
 * What reaches the host is a name the host's own manifests define, a verb from a fixed enum, a
 * compose service name and, for logs, a container ID — never a command (non-negotiable 1). The
 * agent re-checks every one of them against its manifests and the Engine before it acts.
 */

export const LifecycleVerb = z
  .enum(['start', 'stop', 'restart', 'recreate'])
  .meta({ id: 'LifecycleVerb', description: 'A compose lifecycle verb; recreate never changes an image' });
export type LifecycleVerb = z.infer<typeof LifecycleVerb>;

/** A Deployed app (an `apps/` manifest) or an Operated stack (a `stacks/` manifest), by name. */
export const ActionTarget = z
  .strictObject({
    kind: z.enum(['app', 'stack']),
    name: AppName,
  })
  .meta({ id: 'ActionTarget', description: 'The app or adopted stack an action applies to' });
export type ActionTarget = z.infer<typeof ActionTarget>;

/** A compose service name as compose accepts it; checked against the project on the host as well. */
export const ServiceName = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/, 'a compose service name: letters, digits, _ . -, at most 63')
  .meta({ id: 'ServiceName', description: 'A compose service name' });

/** A Docker container ID, full length. */
export const ContainerId = z
  .string()
  .regex(/^[0-9a-f]{64}$/, '64 lowercase hex characters')
  .meta({ id: 'ContainerId', description: 'A full Docker container ID' });

export const ActionState = z
  .enum(['queued', 'dispatched', 'running', 'succeeded', 'failed', 'refused', 'cancelled'])
  .meta({ id: 'ActionState', description: 'Where a lifecycle action is' });
export type ActionState = z.infer<typeof ActionState>;

export const ActionStatus = z
  .strictObject({
    id: z.uuid(),
    target: ActionTarget,
    verb: LifecycleVerb,
    service: ServiceName.nullable(),
    state: ActionState,
    requesterLabel: z.string(),
    createdAt: z.iso.datetime({ offset: true }),
    startedAt: z.iso.datetime({ offset: true }).nullable(),
    endedAt: z.iso.datetime({ offset: true }).nullable(),
    refusal: Refusal.nullable(),
    /** Compose's own output, redacted on the agent and capped. */
    output: z.string().max(16384).nullable(),
  })
  .meta({ id: 'ActionStatus', description: 'A lifecycle action and its outcome' });
export type ActionStatus = z.infer<typeof ActionStatus>;

export const ActionPage = z
  .strictObject({
    items: z.array(ActionStatus),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: 'ActionPage', description: 'Lifecycle actions, newest first' });
export type ActionPage = z.infer<typeof ActionPage>;

/** Handed to an agent that advertises the `actions` capability. */
export const ActionJob = z
  .strictObject({
    actionId: z.uuid(),
    target: ActionTarget,
    verb: LifecycleVerb,
    service: ServiceName.optional(),
    requesterLabel: z.string().max(200).optional(),
  })
  .meta({ id: 'ActionJob', description: 'A lifecycle action for the agent to run' });
export type ActionJob = z.infer<typeof ActionJob>;

/** The agent has started the action (journaled, then running). */
export const ActionProgress = z
  .strictObject({
    actionId: z.uuid(),
    state: z.literal('running'),
  })
  .meta({ id: 'ActionProgress', description: 'A lifecycle action started on the host' });
export type ActionProgress = z.infer<typeof ActionProgress>;

export const ActionResult = z
  .strictObject({
    actionId: z.uuid(),
    state: z.enum(['succeeded', 'failed', 'refused']),
    refusal: Refusal.optional(),
    output: z.string().max(16384).optional(),
  })
  .meta({ id: 'ActionResult', description: 'The terminal result of a lifecycle action' });
export type ActionResult = z.infer<typeof ActionResult>;

/** At most this many lines of tail per request (SHP-REQ-189). */
export const LOGS_MAX_TAIL = 2000;
/** A followed log stream ends after this long (SHP-REQ-189). */
export const LOGS_MAX_FOLLOW_SECONDS = 300;

/** `POST /api/logs`. */
export const LogsRequest = z
  .strictObject({
    container: ContainerId,
    tail: z.int().min(1).max(LOGS_MAX_TAIL).default(200),
    follow: z.boolean().default(false),
  })
  .meta({ id: 'LogsRequest', description: "Read a container's recent logs, optionally following them" });
export type LogsRequest = z.infer<typeof LogsRequest>;

export const LogsSession = z
  .strictObject({
    id: z.uuid(),
    container: ContainerId,
    containerName: z.string().min(1).max(255),
    tail: z.int(),
    follow: z.boolean(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: 'LogsSession', description: 'A log stream opened for one viewer; its lines are never stored' });
export type LogsSession = z.infer<typeof LogsSession>;

/** Handed to an agent that advertises the `logs` capability. */
export const LogsJob = z
  .strictObject({
    logsId: z.uuid(),
    containerId: ContainerId,
    tail: z.int().min(1).max(LOGS_MAX_TAIL),
    since: z.iso.datetime({ offset: true }).optional(),
    follow: z.boolean(),
    /** 0 when not following. */
    followSeconds: z.int().min(0).max(LOGS_MAX_FOLLOW_SECONDS),
  })
  .meta({ id: 'LogsJob', description: 'A bounded log read for the agent to stream back' });
export type LogsJob = z.infer<typeof LogsJob>;

export const LogLine = z
  .strictObject({
    /** Docker's timestamp for the line; null when it carried none. */
    at: z.iso.datetime({ offset: true }).nullable(),
    stream: z.enum(['stdout', 'stderr']),
    /** Already redacted on the agent (SHP-REQ-190). */
    text: z.string().max(16384),
  })
  .meta({ id: 'LogLine', description: 'One redacted log line' });
export type LogLine = z.infer<typeof LogLine>;

/** The agent posts these in order; the server relays them and keeps nothing (SHP-REQ-191). */
export const LogsChunk = z
  .strictObject({
    logsId: z.uuid(),
    seq: z.int().min(0),
    lines: z.array(LogLine).max(1000),
    /** The last chunk: the tail is sent, the follow window ended, or the agent stopped. */
    done: z.boolean(),
    error: Refusal.optional(),
  })
  .meta({ id: 'LogsChunk', description: 'An ordered batch of redacted log lines from the agent' });
export type LogsChunk = z.infer<typeof LogsChunk>;

/** The server's answer to a chunk: `continue: false` when the viewer has gone, so the agent stops. */
export const LogsChunkAck = z
  .strictObject({ continue: z.boolean() })
  .meta({ id: 'LogsChunkAck', description: 'Whether the agent should keep streaming' });
export type LogsChunkAck = z.infer<typeof LogsChunkAck>;
