import { randomUUID } from 'node:crypto';
import { LOGS_MAX_FOLLOW_SECONDS, refusal, type LogLine, type LogsChunk, type LogsJob, type Refusal } from '@shipyard/schema';
import type { Bus } from '../events.js';

/**
 * Log sessions, in memory only (SHP-ADR-011; SHP-REQ-189, SHP-REQ-191). A session is one viewer's
 * bounded read of one container's logs: opened by `POST /api/logs`, handed to the agent's poll as
 * a `LogsJob`, fed by the agent's `POST /api/agent/logs/:id/chunks`, and relayed to the viewer's
 * SSE stream. A chunk is pushed to the session's listeners — or held until the viewer's stream
 * attaches — and dropped. Nothing here is ever written to PostgreSQL or handed to pino: log lines
 * are the host's data, redacted on the agent, and they leave the server only toward the person who
 * asked for them.
 *
 * Bounded every way: a tail of at most 2000 lines and a follow of at most five minutes (the schema
 * caps both), at most `LOGS_RELAY_CAP_BYTES` relayed per session, `LOGS_MAX_PER_VIEWER` open per
 * user or token and `LOGS_MAX_TOTAL` open at once, and a lifetime after which the session ends
 * whatever the agent is doing. An ended session lingers as a tombstone for `LOGS_TOMBSTONE_MS`, so
 * the agent's next chunk is told to stop and a viewer who attaches late still sees how it ended.
 *
 * One hub per `Bus`, i.e. per server process (and per integration test's app).
 */

export const LOGS_MAX_PER_VIEWER = 3;
export const LOGS_MAX_TOTAL = 20;
/** The most log bytes (as JSON) one session relays before it is ended. */
export const LOGS_RELAY_CAP_BYTES = 2 * 1024 * 1024;
/** A session no poll has taken in this long ends: the agent is not coming. */
export const LOGS_UNCLAIMED_MS = 60_000;
/** Beyond its follow window, how long a session may run before it is ended regardless. */
export const LOGS_GRACE_MS = 60_000;
/** How long an ended session is remembered. */
export const LOGS_TOMBSTONE_MS = 60_000;

export interface LogsViewer {
  type: 'user' | 'token';
  id: string;
}

export type LogsEndReason = 'done' | 'stopped' | 'viewer_left' | 'expired' | 'cap';

export type LogsEvent =
  | { type: 'lines'; seq: number; lines: LogLine[] }
  | { type: 'end'; reason: LogsEndReason; error?: Refusal };

export interface LogsSessionInfo {
  id: string;
  agentId: string;
  container: string;
  containerName: string;
  tail: number;
  follow: boolean;
  followSeconds: number;
  createdAt: Date;
  viewer: LogsViewer;
}

interface Session extends LogsSessionInfo {
  dispatchedAt: number | null;
  nextSeq: number;
  relayedBytes: number;
  /** Events that arrived before any listener attached (bounded by the relay cap). */
  pending: LogsEvent[];
  listeners: Set<(event: LogsEvent) => void>;
  /** True once a listener has attached: its leaving means the viewer left. */
  attached: boolean;
  ended: { reason: LogsEndReason; error?: Refusal } | null;
  endedAt: number | null;
  expiresAt: number;
}

export interface OpenLogsInput {
  agentId: string;
  container: string;
  containerName: string;
  tail: number;
  follow: boolean;
  viewer: LogsViewer;
}

/** `followSeconds` for a job: 0 unless following, and never past the five-minute bound (SHP-REQ-189). */
export function followSecondsFor(follow: boolean, requested: number = LOGS_MAX_FOLLOW_SECONDS): number {
  return follow ? Math.max(0, Math.min(LOGS_MAX_FOLLOW_SECONDS, Math.floor(requested))) : 0;
}

/** The size a batch of lines counts against the relay cap. */
export function linesBytes(lines: readonly LogLine[]): number {
  return Buffer.byteLength(JSON.stringify(lines), 'utf8');
}

export type ChunkAnswer = { continue: boolean } | 'not_yours';

export class LogsHub {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Opens a session for `viewer`, or refuses when the viewer or the server has too many open. */
  open(input: OpenLogsInput): LogsSessionInfo | Refusal {
    this.sweep();
    // A session holds memory while it is live, and after it ends for as long as it still holds
    // lines no viewer has attached for: both count toward the caps.
    const live = [...this.sessions.values()].filter(holdsMemory);
    if (live.length >= LOGS_MAX_TOTAL) {
      return refusal('too_many_attempts', 'Too many log streams are open on this server.', 'Close a log stream, or wait for one to end, then retry.');
    }
    if (live.filter((s) => sameViewer(s.viewer, input.viewer)).length >= LOGS_MAX_PER_VIEWER) {
      return refusal('too_many_attempts', `You already have ${String(LOGS_MAX_PER_VIEWER)} log streams open.`, 'Close one of them, then retry.');
    }
    const at = this.now();
    const followSeconds = followSecondsFor(input.follow);
    const session: Session = {
      id: randomUUID(),
      agentId: input.agentId,
      container: input.container,
      containerName: input.containerName,
      tail: input.tail,
      follow: input.follow,
      followSeconds,
      createdAt: new Date(at),
      viewer: input.viewer,
      dispatchedAt: null,
      nextSeq: 0,
      relayedBytes: 0,
      pending: [],
      listeners: new Set(),
      attached: false,
      ended: null,
      endedAt: null,
      expiresAt: at + LOGS_UNCLAIMED_MS + followSeconds * 1000 + LOGS_GRACE_MS,
    };
    this.sessions.set(session.id, session);
    return info(session);
  }

  /** The session (live or a tombstone), or null. */
  get(id: string): LogsSessionInfo | null {
    this.sweep();
    const s = this.sessions.get(id);
    return s === undefined ? null : info(s);
  }

  /** True while the session has not ended. */
  isLive(id: string): boolean {
    return this.sessions.get(id)?.ended === null;
  }

  /** Whether `viewer` opened session `id`. */
  isViewer(id: string, viewer: LogsViewer): boolean {
    const s = this.sessions.get(id);
    return s !== undefined && sameViewer(s.viewer, viewer);
  }

  /** The oldest live session for `agentId` no poll has taken yet, marked taken, as a job. */
  claim(agentId: string): LogsJob | null {
    this.sweep();
    let oldest: Session | null = null;
    for (const s of this.sessions.values()) {
      if (s.ended !== null || s.dispatchedAt !== null || s.agentId !== agentId) continue;
      if (oldest === null || s.createdAt < oldest.createdAt) oldest = s;
    }
    if (oldest === null) return null;
    oldest.dispatchedAt = this.now();
    return {
      logsId: oldest.id,
      containerId: oldest.container,
      tail: oldest.tail,
      follow: oldest.follow,
      followSeconds: oldest.followSeconds,
    };
  }

  /** Puts a claimed session back, for a poll that went away before it could be answered. */
  release(id: string): void {
    const s = this.sessions.get(id);
    if (s?.ended === null) s.dispatchedAt = null;
  }

  /**
   * Relays one chunk from the agent. `continue: false` once the session has ended (the viewer
   * left, it was stopped, it expired, the relay cap was reached, or this was the last chunk), and
   * for a session the server no longer knows. `not_yours` when it was not dispatched to `agentId`.
   */
  chunk(agentId: string, chunk: LogsChunk): ChunkAnswer {
    this.sweep();
    const s = this.sessions.get(chunk.logsId);
    if (s === undefined) return { continue: false };
    if (s.agentId !== agentId || s.dispatchedAt === null) return 'not_yours';
    if (s.ended !== null) return { continue: false };
    // A retried POST of a chunk already relayed: acknowledged, not relayed twice.
    if (chunk.seq < s.nextSeq) return { continue: true };
    s.nextSeq = chunk.seq + 1;
    if (chunk.lines.length > 0) {
      const bytes = linesBytes(chunk.lines);
      if (s.relayedBytes + bytes > LOGS_RELAY_CAP_BYTES) {
        this.end(s, 'cap', refusal('conflict', 'This log read reached the 2 MB relay limit.', 'Ask for a shorter tail, or follow for less time.'));
        return { continue: false };
      }
      s.relayedBytes += bytes;
      this.emit(s, { type: 'lines', seq: chunk.seq, lines: chunk.lines });
    }
    if (chunk.done) {
      this.end(s, 'done', chunk.error);
      return { continue: false };
    }
    return { continue: true };
  }

  /**
   * Attaches a listener: it first gets every event held so far (and the end, if the session has
   * ended), then each new one. The returned function detaches it; when the last listener detaches
   * from a live session the viewer has left, and the session ends.
   */
  subscribe(id: string, listener: (event: LogsEvent) => void): () => void {
    const s = this.sessions.get(id);
    if (s === undefined) {
      listener({ type: 'end', reason: 'expired' });
      return () => undefined;
    }
    for (const event of s.pending.splice(0)) listener(event);
    if (s.ended !== null) {
      listener({ type: 'end', ...s.ended });
      return () => undefined;
    }
    s.listeners.add(listener);
    s.attached = true;
    return () => {
      s.listeners.delete(listener);
      if (s.listeners.size === 0 && s.ended === null) this.end(s, 'viewer_left');
    };
  }

  /** Ends a session at the viewer's request. False when there is no such live session. */
  stop(id: string): boolean {
    const s = this.sessions.get(id);
    if (s?.ended !== null) return false;
    this.end(s, 'stopped');
    return true;
  }

  /** Ends sessions past their lifetime or never claimed, and forgets old tombstones. */
  sweep(): void {
    const at = this.now();
    for (const s of this.sessions.values()) {
      if (s.ended !== null) {
        if (s.endedAt !== null && at - s.endedAt > LOGS_TOMBSTONE_MS) this.sessions.delete(s.id);
        continue;
      }
      if (s.dispatchedAt === null && at - s.createdAt.getTime() > LOGS_UNCLAIMED_MS) {
        this.end(s, 'expired', refusal('agent_offline', 'The agent did not pick up this log read.', 'Check the agent is running and can reach the server, then retry.'));
      } else if (at > s.expiresAt) {
        this.end(s, 'expired');
      }
    }
  }

  /** How many sessions are held, live or not (tests). */
  get size(): number {
    return this.sessions.size;
  }

  private emit(s: Session, event: LogsEvent): void {
    if (s.listeners.size === 0) {
      // Held only until the viewer's stream attaches; a viewer who has left gets nothing more.
      if (!s.attached) s.pending.push(event);
      return;
    }
    for (const listener of [...s.listeners]) listener(event);
  }

  private end(s: Session, reason: LogsEndReason, error?: Refusal): void {
    if (s.ended !== null) return;
    s.ended = error === undefined ? { reason } : { reason, error };
    s.endedAt = this.now();
    const listeners = [...s.listeners];
    s.listeners.clear();
    if (listeners.length === 0) {
      // Held lines are kept only for a viewer still to attach to a read that finished or ran out;
      // one the viewer stopped has nobody to show them to.
      if (!s.attached && reason !== 'stopped') return;
      // The viewer has gone: nothing is held for nobody.
      s.pending = [];
      return;
    }
    for (const listener of listeners) listener({ type: 'end', ...s.ended });
  }
}

function holdsMemory(s: Session): boolean {
  return s.ended === null || s.pending.length > 0;
}

function sameViewer(a: LogsViewer, b: LogsViewer): boolean {
  return a.type === b.type && a.id === b.id;
}

function info(s: Session): LogsSessionInfo {
  return {
    id: s.id,
    agentId: s.agentId,
    container: s.container,
    containerName: s.containerName,
    tail: s.tail,
    follow: s.follow,
    followSeconds: s.followSeconds,
    createdAt: s.createdAt,
    viewer: s.viewer,
  };
}

const hubs = new WeakMap<Bus, LogsHub>();

/** The process's log hub: one per `Bus`, so each app instance (and each test) has its own. */
export function logsHubFor(bus: Bus): LogsHub {
  let hub = hubs.get(bus);
  if (hub === undefined) {
    hub = new LogsHub();
    hubs.set(bus, hub);
  }
  return hub;
}
