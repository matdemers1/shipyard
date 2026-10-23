// Types only: a runtime import of the schema package would put zod and every schema in the bundle.
import type {
  ActionPage,
  ActionRequest,
  ActionState,
  ActionStatus,
  ActionTarget,
  ContainerTier,
  HostContainer,
  LifecycleVerb,
  LogLine,
  LogsRequest,
  LogsSession,
  Refusal,
} from '@shipyard/schema';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefusalError, request, unreachableRefusal, type Role } from './api';
import { canChangeState } from './auth';
import { formatDuration } from './timeline';
import { ACTION_STATE_WORDS, LIFECYCLE_ACTIVE_WORDS, LIFECYCLE_PAST_WORDS, LIFECYCLE_VERB_WORDS } from './words';

/**
 * Lifecycle actions and container logs from the console (SHP-T-15.7, SHP-ADR-010, SHP-ADR-011).
 *
 * An action names an app or adopted stack, a verb from a fixed enum and, for one container, its
 * compose service — never a command (non-negotiable 1). Which target a container's action names
 * comes from the host snapshot's tier and app, never from anything typed: Deployed → the app,
 * Operated → the stack, Observed → nothing at all (SHP-REQ-185). Stop is console-only: an API token
 * cannot stop (SHP-REQ-188), so the console is the one place it is offered, behind a confirmation.
 *
 * Logs are redacted on the host and never stored (SHP-ADR-011); every view is audited
 * (SHP-REQ-192). A view opens a session, streams it over SSE, and closes it — the stream and the
 * session — when the sheet closes, follow turns off or the page hides, so nothing keeps the agent
 * reading a container nobody is looking at.
 */

// ── The API ──────────────────────────────────────────────────────────────

export const actions = {
  start: (body: ActionRequest): Promise<ActionStatus> => request<ActionStatus>('/api/actions', { method: 'POST', body }),
  get: (id: string, signal?: AbortSignal): Promise<ActionStatus> =>
    request<ActionStatus>(`/api/actions/${encodeURIComponent(id)}`, signal === undefined ? {} : { signal }),
  list: (options: { cursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<ActionPage> => {
    const params = new URLSearchParams();
    if (options.cursor !== undefined) params.set('cursor', options.cursor);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const query = params.toString();
    return request<ActionPage>(`/api/actions${query === '' ? '' : `?${query}`}`, options.signal === undefined ? {} : { signal: options.signal });
  },
};

export const logs = {
  open: (body: LogsRequest): Promise<LogsSession> => request<LogsSession>('/api/logs', { method: 'POST', body }),
  close: (id: string): Promise<unknown> => request<unknown>(`/api/logs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  streamUrl: (id: string): string => `/api/logs/${encodeURIComponent(id)}/stream`,
};

/** How often an action is read while it is not finished (the server's contract: every second). */
export const ACTION_POLL_MS = 1_000;

/** The tail a view opens with. */
export const LOGS_TAIL = 200;

/** Lines kept in memory: the schema's tail maximum (`LOGS_MAX_TAIL`, SHP-REQ-189); older lines drop off the top. */
export const LOGS_LINE_CAP = 2_000;

/** A followed stream ends after this long (`LOGS_MAX_FOLLOW_SECONDS`, SHP-REQ-189). */
export const LOGS_FOLLOW_SECONDS = 300;

// ── Who may do what, to which container ──────────────────────────────────

/** Deployed is an app, Operated a stack, Observed nothing (SHP-ADR-008, SHP-REQ-185). */
const TIER_TARGET: Record<ContainerTier, ActionTarget['kind'] | null> = { shipped: 'app', operated: 'stack', observed: null };

/** What a container's (or its group's) action names; null when no action applies. */
export function targetFor(tier: ContainerTier, app: string | null): ActionTarget | null {
  const kind = TIER_TARGET[tier];
  return kind === null || app === null ? null : { kind, name: app };
}

/** Deployer, operator and admin start, stop, restart and recreate (SHP-REQ-184); a viewer sees no action. */
export function canAct(role: Role | undefined): boolean {
  return canChangeState(role);
}

/** Logs are for admin and operator (SHP-ADR-011). */
export function canReadLogs(role: Role | undefined): boolean {
  return role === 'admin' || role === 'operator';
}

/** The verbs a container offers: Restart, Recreate and Stop while it runs; Start when it does not. */
export function containerVerbs(c: Pick<HostContainer, 'state'>): LifecycleVerb[] {
  return c.state === 'running' ? ['restart', 'recreate', 'stop'] : ['start'];
}

/** The request for one container's service, or null when its tier allows none. */
export function containerRequest(c: Pick<HostContainer, 'tier' | 'app' | 'compose'>, verb: LifecycleVerb): ActionRequest | null {
  const target = targetFor(c.tier, c.app);
  if (target === null || c.compose === null) return null;
  return { target, verb, service: c.compose.service };
}

// ── States and words ─────────────────────────────────────────────────────

const TERMINAL: readonly ActionState[] = ['succeeded', 'failed', 'refused', 'cancelled'];

export function isTerminalAction(state: ActionState): boolean {
  return TERMINAL.includes(state);
}

/** Takes a plain string because a newer server can send a state this console has not met. */
export function actionStateWords(state: string): string {
  return Object.hasOwn(ACTION_STATE_WORDS, state) ? ACTION_STATE_WORDS[state as ActionState] : state.replaceAll('_', ' ');
}

/** How long it took, from when the agent began (or was asked) to when it ended; null under a second. */
export function actionDuration(status: Pick<ActionStatus, 'createdAt' | 'startedAt' | 'endedAt'>): string | null {
  if (status.endedAt === null) return null;
  const ms = Date.parse(status.endedAt) - Date.parse(status.startedAt ?? status.createdAt);
  return Number.isNaN(ms) || ms < 1000 ? null : formatDuration(ms);
}

/** "worker", or "the whole stack" when the action named no service. */
export function actionScope(status: Pick<ActionStatus, 'service'>): string {
  return status.service ?? 'the whole stack';
}

/** The in-progress banner: the state as a headline, and what it is waiting on. */
export function progressWords(status: Pick<ActionStatus, 'verb' | 'state' | 'requesterLabel'>, elapsedSeconds: number): { headline: string; detail: string } {
  const where =
    status.state === 'queued'
      ? 'waiting for the agent to pick it up'
      : status.state === 'dispatched'
        ? 'the agent has it'
        : 'journaled on the host, running';
  const headline = status.state === 'running' ? LIFECYCLE_ACTIVE_WORDS[status.verb] : actionStateWords(status.state);
  return { headline, detail: `Requested by ${status.requesterLabel} · ${where} (${String(Math.max(0, elapsedSeconds))} s)` };
}

/** The result line once it finished: "Restarted worker in 8s", or the failure in words. */
export function resultWords(status: Pick<ActionStatus, 'verb' | 'state' | 'service' | 'createdAt' | 'startedAt' | 'endedAt'>): string {
  const scope = actionScope(status);
  const duration = actionDuration(status);
  switch (status.state) {
    case 'succeeded':
      return `${LIFECYCLE_PAST_WORDS[status.verb]} ${scope}${duration === null ? '' : ` in ${duration}`}`;
    case 'failed':
      return `${LIFECYCLE_VERB_WORDS[status.verb]} of ${scope} failed`;
    case 'refused':
      return `${LIFECYCLE_VERB_WORDS[status.verb]} of ${scope} refused`;
    case 'cancelled':
      return `${LIFECYCLE_VERB_WORDS[status.verb]} of ${scope} cancelled`;
    default:
      return actionStateWords(status.state);
  }
}

/** The Activity badge: the verb's past tense when it worked, else the verb and what became of it. */
export function actionBadgeWords(status: Pick<ActionStatus, 'verb' | 'state'>): string {
  if (status.state === 'succeeded') return LIFECYCLE_PAST_WORDS[status.verb];
  return `${LIFECYCLE_VERB_WORDS[status.verb]} ${actionStateWords(status.state).toLowerCase()}`;
}

export function problemOf(error: unknown): RefusalError {
  return error instanceof RefusalError ? error : unreachableRefusal();
}

// ── Running one action ───────────────────────────────────────────────────

export type ActionPhase =
  | { kind: 'idle' }
  /** The POST is in flight. */
  | { kind: 'starting'; request: ActionRequest; at: number }
  | { kind: 'running'; status: ActionStatus }
  | { kind: 'done'; status: ActionStatus }
  /** The server refused the request itself (locked, forbidden, not adopted, agent too old …). */
  | { kind: 'refused'; request: ActionRequest; error: RefusalError };

export function isBusy(phase: ActionPhase): boolean {
  return phase.kind === 'starting' || phase.kind === 'running';
}

/** Polls that may fail in a row before the action is reported as lost, so one blip does not end it. */
const POLL_FAILURES_ALLOWED = 3;

/**
 * Starts an action and follows it to a terminal state, reading it every second; stops reading when
 * the component goes away. One action at a time: `run` does nothing while one is in flight.
 */
export function useAction(): { phase: ActionPhase; run: (body: ActionRequest) => void; reset: () => void } {
  const [phase, setPhase] = useState<ActionPhase>({ kind: 'idle' });
  const generation = useRef(0);
  const busy = useRef(false);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const run = useCallback((body: ActionRequest) => {
    if (busy.current) return;
    busy.current = true;
    const gen = ++generation.current;
    const live = () => gen === generation.current;
    setPhase({ kind: 'starting', request: body, at: Date.now() });

    const follow = (id: string, failures: number): void => {
      setTimeout(() => {
        if (!live()) return;
        actions
          .get(id)
          .then((status) => {
            if (!live()) return;
            if (isTerminalAction(status.state)) {
              busy.current = false;
              setPhase({ kind: 'done', status });
            } else {
              setPhase({ kind: 'running', status });
              follow(id, 0);
            }
          })
          .catch((error: unknown) => {
            if (!live()) return;
            if (failures + 1 < POLL_FAILURES_ALLOWED) {
              follow(id, failures + 1);
              return;
            }
            busy.current = false;
            setPhase({ kind: 'refused', request: body, error: problemOf(error) });
          });
      }, ACTION_POLL_MS);
    };

    actions
      .start(body)
      .then((status) => {
        if (!live()) return;
        if (isTerminalAction(status.state)) {
          busy.current = false;
          setPhase({ kind: 'done', status });
        } else {
          setPhase({ kind: 'running', status });
          follow(status.id, 0);
        }
      })
      .catch((error: unknown) => {
        if (!live()) return;
        busy.current = false;
        setPhase({ kind: 'refused', request: body, error: problemOf(error) });
      });
  }, []);

  const reset = useCallback(() => {
    generation.current += 1;
    busy.current = false;
    setPhase({ kind: 'idle' });
  }, []);

  return { phase, run, reset };
}

// ── Reading logs ─────────────────────────────────────────────────────────

export interface KeyedLine {
  key: number;
  line: LogLine;
}

export type LogsStatus =
  | { kind: 'loading' }
  | { kind: 'streaming' }
  /** The tail was sent, or the follow window closed. */
  | { kind: 'ended' }
  | { kind: 'error'; error: RefusalError };

/** "Following · 4:12 left": the clock on a followed stream. */
export function followClock(secondsLeft: number): string {
  const s = Math.max(0, Math.ceil(secondsLeft));
  return `${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, '0')}`;
}

/** A line's time as HH:MM:SS in the viewer's own clock; a dash when Docker gave none. */
export function logTime(at: string | null): string {
  if (at === null) return '--:--:--';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Appends, keeping only the newest `LOGS_LINE_CAP`. */
export function capLines(lines: readonly KeyedLine[]): KeyedLine[] {
  return lines.length <= LOGS_LINE_CAP ? [...lines] : lines.slice(lines.length - LOGS_LINE_CAP);
}

function parseData(event: Event): unknown {
  const data = (event as MessageEvent<unknown>).data;
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

function isRefusal(value: unknown): value is Refusal {
  return typeof value === 'object' && value !== null && typeof (value as { message?: unknown }).message === 'string' && typeof (value as { fix?: unknown }).fix === 'string';
}

const STREAM_LOST: Refusal = {
  code: 'invalid_request',
  gate: 'none',
  message: 'The log stream stopped.',
  fix: 'Close the logs and open them again.',
};

export type LogsMode = 'tail' | 'follow' | 'stopped';

export interface Logs {
  lines: KeyedLine[];
  status: LogsStatus;
  mode: LogsMode;
  /** When a followed stream ends, epoch ms; null while not following. */
  followEndsAt: number | null;
  /** Follow on (re-opens with `follow: true`) or off (closes the stream, keeps the lines). */
  setFollow: (on: boolean) => void;
}

/**
 * One container's logs: the last 200 lines, then — while Follow is on — new ones as they come, for
 * at most five minutes. `containerId` null, or `allowed` false, opens nothing.
 */
export function useLogs(containerId: string | null, allowed: boolean): Logs {
  const [mode, setMode] = useState<LogsMode>('tail');
  const [lines, setLines] = useState<KeyedLine[]>([]);
  const [status, setStatus] = useState<LogsStatus>({ kind: 'loading' });
  const [followEndsAt, setFollowEndsAt] = useState<number | null>(null);
  const nextKey = useRef(0);
  const stoppedByHiding = useRef(false);

  // A different container starts over with a fresh tail.
  const [seen, setSeen] = useState(containerId);
  if (seen !== containerId) {
    setSeen(containerId);
    setMode('tail');
    setLines([]);
    setStatus({ kind: 'loading' });
    setFollowEndsAt(null);
  }

  useEffect(() => {
    if (containerId === null || !allowed || mode === 'stopped') return;
    const follow = mode === 'follow';
    let closed = false;
    let source: EventSource | null = null;
    let sessionId: string | null = null;
    // The first batch replaces what is on screen: a re-opened stream sends its tail again.
    let replace = true;
    setStatus({ kind: 'loading' });

    const finish = (next: LogsStatus): void => {
      source?.close();
      source = null;
      if (replace) setLines([]);
      setStatus(next);
      if (follow) {
        setFollowEndsAt(null);
        setMode('stopped');
      }
    };

    logs
      .open({ container: containerId, tail: LOGS_TAIL, follow })
      .then((session) => {
        if (closed) {
          logs.close(session.id).catch(() => undefined);
          return;
        }
        sessionId = session.id;
        if (follow) setFollowEndsAt(Date.now() + LOGS_FOLLOW_SECONDS * 1000);
        const es = new EventSource(logs.streamUrl(session.id));
        source = es;
        setStatus({ kind: 'streaming' });
        es.addEventListener('lines', (event) => {
          const data = parseData(event) as { lines?: LogLine[] } | null;
          const batch = (data?.lines ?? []).map((line) => ({ key: nextKey.current++, line }));
          const fresh = replace;
          replace = false;
          setLines((prev) => capLines(fresh ? batch : [...prev, ...batch]));
        });
        es.addEventListener('end', (event) => {
          const data = parseData(event) as { error?: unknown } | null;
          const error = data?.error;
          finish(isRefusal(error) ? { kind: 'error', error: new RefusalError(error, 409) } : { kind: 'ended' });
        });
        es.onerror = () => {
          // The server ends a stream with `end`; an error before it is a lost connection, and the
          // browser's own reconnect would open a session the server has already let go.
          if (source === null) return;
          finish({ kind: 'error', error: new RefusalError(STREAM_LOST, 0) });
        };
      })
      .catch((error: unknown) => {
        if (closed) return;
        setStatus({ kind: 'error', error: problemOf(error) });
        if (follow) {
          setFollowEndsAt(null);
          setMode('stopped');
        }
      });

    return () => {
      closed = true;
      source?.close();
      source = null;
      // Ends the agent's read too (SHP-ADR-011): nobody is looking.
      if (sessionId !== null) logs.close(sessionId).catch(() => undefined);
    };
  }, [containerId, allowed, mode]);

  // The page hides: stop reading. It shows again: a fresh tail, not a resumed follow.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        setMode((m) => {
          if (m === 'stopped') return m;
          stoppedByHiding.current = true;
          return 'stopped';
        });
        setFollowEndsAt(null);
      } else if (stoppedByHiding.current) {
        stoppedByHiding.current = false;
        setMode('tail');
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const setFollow = useCallback((on: boolean) => {
    setFollowEndsAt(null);
    setMode(on ? 'follow' : 'stopped');
  }, []);

  return { lines, status, mode, followEndsAt, setFollow };
}
