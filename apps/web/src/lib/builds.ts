import type { BuildStage, BuildState, BuildTrigger, Refusal } from '@shipyard/schema';
import { useEffect, useState } from 'react';
import { RefusalError, request } from './api';
import type { StatusTone } from './appstatus';

/**
 * Builds (SHP-T-7.12, SHP-REQ-142, SHP-REQ-143): the shapes `/api/builds` answers with, the calls,
 * and the live stream. A build's progress arrives over Server-Sent Events from
 * `GET /api/builds/:id/events`; when the stream drops, `GET /api/builds/:id` and
 * `/logs?after=<last id>` are polled every three seconds while the stream is retried — the same
 * contract as a deploy's live progress (SHP-D-070).
 */

export type { BuildStage, BuildState, BuildTrigger };

/** The stages in the order the agent runs them. */
export const BUILD_STAGES: readonly BuildStage[] = ['fetch', 'test', 'integration', 'build', 'push'];

export type BuildStageState = 'running' | 'succeeded' | 'failed' | 'skipped';

export interface BuildStageView {
  stage: BuildStage;
  state: BuildStageState;
  startedAt: string;
  endedAt: string | null;
}

/** One row of `GET /api/builds`. */
export interface BuildSummary {
  buildId: string;
  app: string;
  sha: string;
  state: BuildState;
  trigger: BuildTrigger;
  queueSeq: string;
  requesterLabel: string;
  rebuildOfId: string | null;
  failedStage: BuildStage | null;
  cancelRequestedAt: string | null;
  dispatchedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

/** `GET /api/builds/:id` and the stream's `build` event. */
export interface BuildDetail extends BuildSummary {
  digests: Record<string, string>;
  refusal: Refusal | null;
  stages: BuildStageView[];
  /** The deploy this build requested (SHP-REQ-138), when the server reports it. */
  autoDeployId?: string | null;
  /** Why that deploy was refused (SHP-REQ-139), when the server reports it. */
  autoDeployRefusal?: Refusal | null;
}

export interface BuildLogChunk {
  /** A bigint as a string: strictly increasing within a build. */
  id: string;
  stage: BuildStage;
  chunk: string;
  at: string;
}

export interface BuildPage {
  items: BuildSummary[];
  nextCursor: string | null;
}

export interface EnqueuedBuild {
  buildId: string;
  state: BuildState;
  created: boolean;
}

export interface CancelOutcome {
  buildId: string;
  state: BuildState;
  /** True when the build was running: it stops at its next stage boundary. */
  cancelRequested: boolean;
}

export interface ListOptions {
  app?: string;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

const base = (id: string): string => `/api/builds/${encodeURIComponent(id)}`;

export const builds = {
  list: (options: ListOptions = {}): Promise<BuildPage> => {
    const q = new URLSearchParams();
    if (options.app !== undefined && options.app !== '') q.set('app', options.app);
    if (options.limit !== undefined) q.set('limit', String(options.limit));
    if (options.cursor !== undefined) q.set('cursor', options.cursor);
    const qs = q.toString();
    return request<BuildPage>(`/api/builds${qs === '' ? '' : `?${qs}`}`, options.signal !== undefined ? { signal: options.signal } : {});
  },
  get: (id: string, signal?: AbortSignal): Promise<BuildDetail> =>
    request<BuildDetail>(base(id), signal !== undefined ? { signal } : {}),
  logs: async (id: string, after?: string, signal?: AbortSignal): Promise<BuildLogChunk[]> => {
    const path = after !== undefined && after !== '0' ? `${base(id)}/logs?after=${encodeURIComponent(after)}` : `${base(id)}/logs`;
    const res = await request<{ logs: BuildLogChunk[] }>(path, signal !== undefined ? { signal } : {});
    return res.logs;
  },
  rebuild: (id: string): Promise<EnqueuedBuild> => request<EnqueuedBuild>(`${base(id)}/rebuild`, { method: 'POST' }),
  cancel: (id: string): Promise<CancelOutcome> => request<CancelOutcome>(`${base(id)}/cancel`, { method: 'POST' }),
};

// ── Presentation helpers ────────────────────────────────────────────────

export const TERMINAL_BUILD_STATES: readonly BuildState[] = ['succeeded', 'failed', 'cancelled', 'refused'];

export function isTerminalBuild(state: BuildState): boolean {
  return TERMINAL_BUILD_STATES.includes(state);
}

export const BUILD_STATE_LABEL: Record<BuildState, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  refused: 'Refused',
};

/**
 * Tone backs the text, never replaces it (WCAG 1.4.1). One of the library's four tones: a running
 * build is `attention` so its badge is filled in light mode, a cancelled one `warning` (SHP-T-13.2).
 */
export function buildStateTone(state: BuildState): StatusTone {
  if (state === 'failed' || state === 'refused') return 'danger';
  if (state === 'cancelled') return 'warning';
  if (state === 'running') return 'attention';
  return 'neutral';
}

export const TRIGGER_LABEL: Record<BuildTrigger, string> = {
  webhook: 'Push',
  reconcile: 'Reconcile',
  manual: 'Console',
  mcp: 'MCP',
  rebuild: 'Rebuild',
};

export const STAGE_LABEL: Record<BuildStage, string> = {
  fetch: 'Fetch',
  test: 'Test',
  integration: 'Integration',
  build: 'Build',
  push: 'Push',
};

export function sha7(sha: string): string {
  return sha.slice(0, 7);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.max(0, Math.round(ms)))} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${String(s)} s`;
  return `${String(Math.floor(s / 60))} m ${String(s % 60)} s`;
}

/** Merges new chunks into the log in id order, dropping any already held (a resent stream, a poll). */
export function mergeLogs(current: readonly BuildLogChunk[], incoming: readonly BuildLogChunk[]): BuildLogChunk[] {
  if (incoming.length === 0) return current as BuildLogChunk[];
  const last = current[current.length - 1];
  const lastId = last === undefined ? -1n : BigInt(last.id);
  const fresh = incoming.filter((c) => BigInt(c.id) > lastId);
  if (fresh.length === 0) return current as BuildLogChunk[];
  fresh.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  return [...current, ...fresh];
}

// ── The live stream ─────────────────────────────────────────────────────

/** SHP-D-070: the polling fallback's period. */
export const POLL_MS = 3000;
export const FIRST_RETRY_MS = 2000;
export const MAX_RETRY_MS = 30_000;

export function retryDelay(attempt: number): number {
  return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** attempt);
}

/** `connecting` before anything arrived, `live` on the stream, `polling` while it is retried. */
export type Transport = 'connecting' | 'live' | 'polling';

/** The part of `EventSource` the hook uses, so a test can pass a fake. */
export interface BuildEventSource {
  onopen: ((ev: Event) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  /** 0 connecting (the browser is retrying, sending `Last-Event-ID`), 1 open, 2 closed. */
  readonly readyState?: number;
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void;
  close(): void;
}
export type BuildEventSourceFactory = (url: string) => BuildEventSource;

export interface BuildStreamOptions {
  /** Defaults to the browser's `EventSource`; with none, the hook polls from the start. */
  eventSource?: BuildEventSourceFactory | null;
}

export interface BuildStream {
  build: BuildDetail | null;
  logs: BuildLogChunk[];
  transport: Transport;
  /** A refusal that stops progress altogether (no such build, not yours to read). */
  error: RefusalError | null;
  /** The build reached a terminal state; nothing more will change. */
  done: boolean;
}

function defaultFactory(): BuildEventSourceFactory | null {
  if (typeof globalThis.EventSource !== 'function') return null;
  const Impl = globalThis.EventSource;
  return (url) => new Impl(url, { withCredentials: true });
}

const INITIAL: BuildStream = { build: null, logs: [], transport: 'connecting', error: null, done: false };
const CLOSED = 2;

export function useBuildStream(id: string, options: BuildStreamOptions = {}): BuildStream {
  const [state, setState] = useState<BuildStream>(INITIAL);
  const factory = options.eventSource === undefined ? defaultFactory() : options.eventSource;

  useEffect(() => {
    setState(INITIAL);
    if (id === '') return;
    const url = base(id);
    let stopped = false;
    let source: BuildEventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    /** The newest log id held: polling asks only for what came after it. */
    let lastLogId = '0';
    const abort = new AbortController();

    const stopPolling = (): void => {
      if (pollTimer !== null) clearInterval(pollTimer);
      pollTimer = null;
    };
    const closeSource = (): void => {
      if (source !== null) {
        source.onopen = null;
        source.onerror = null;
        source.close();
      }
      source = null;
    };
    const stopAll = (): void => {
      stopped = true;
      closeSource();
      stopPolling();
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
    };

    const applyLogs = (chunks: readonly BuildLogChunk[]): void => {
      if (chunks.length === 0) return;
      setState((s) => {
        const logs = mergeLogs(s.logs, chunks);
        const newest = logs[logs.length - 1];
        if (newest !== undefined) lastLogId = newest.id;
        return logs === s.logs ? s : { ...s, logs };
      });
    };

    /** Reads whatever log is left once, after the build has ended. */
    const finalLogs = (): void => {
      builds
        .logs(id, lastLogId, abort.signal)
        .then(applyLogs)
        .catch(() => undefined);
    };

    const applyBuild = (build: BuildDetail): void => {
      const done = isTerminalBuild(build.state);
      setState((s) => ({ ...s, build, done: s.done || done }));
    };

    const finish = (): void => {
      if (stopped) return;
      stopAll();
      setState((s) => ({ ...s, done: true }));
    };

    const poll = async (): Promise<void> => {
      try {
        const [build, logs] = await Promise.all([builds.get(id, abort.signal), builds.logs(id, lastLogId, abort.signal)]);
        if (stopped) return;
        applyLogs(logs);
        applyBuild(build);
        if (isTerminalBuild(build.state)) {
          finish();
          // A chunk written between the two reads above would otherwise be missed for good.
          finalLogs();
        }
      } catch (error) {
        if (stopped || !(error instanceof RefusalError)) return;
        // Unreachable (status 0) is a blip: keep polling. A real refusal ends it.
        if (error.status === 0) return;
        setState((s) => ({ ...s, error }));
        stopAll();
      }
    };

    const startPolling = (): void => {
      if (stopped || pollTimer !== null) return;
      setState((s) => (s.transport === 'polling' ? s : { ...s, transport: 'polling' }));
      void poll();
      pollTimer = setInterval(() => {
        void poll();
      }, POLL_MS);
    };

    const connect = (): void => {
      if (stopped) return;
      if (factory === null) {
        startPolling();
        return;
      }
      const es = factory(`${url}/events`);
      source = es;
      const goLive = (): void => {
        attempt = 0;
        stopPolling();
        setState((s) => (s.transport === 'live' ? s : { ...s, transport: 'live' }));
      };
      es.onopen = goLive;
      es.addEventListener('build', (ev) => {
        if (stopped || source !== es) return;
        goLive();
        applyBuild(JSON.parse(ev.data) as BuildDetail);
      });
      es.addEventListener('logs', (ev) => {
        if (stopped || source !== es) return;
        applyLogs((JSON.parse(ev.data) as { logs: BuildLogChunk[] }).logs);
      });
      es.addEventListener('end', () => {
        if (stopped || source !== es) return;
        // The server sends the final `build` and every chunk before `end`.
        finish();
      });
      es.onerror = () => {
        if (stopped || source !== es) return;
        // Poll while the stream is down, so progress never stops.
        startPolling();
        if (es.readyState !== CLOSED) {
          // The browser is reconnecting on its own and will send `Last-Event-ID`, so the server
          // resumes the log where it stopped. Leave it to that; `onopen` ends the polling.
          return;
        }
        // Closed for good (an HTTP error, say): a new stream after a backoff. It has no
        // `Last-Event-ID`, so the server resends the log from the start — merged, never doubled.
        closeSource();
        retryTimer = setTimeout(() => {
          retryTimer = null;
          connect();
        }, retryDelay(attempt));
        attempt += 1;
      };
    };

    connect();
    return () => {
      stopAll();
      abort.abort();
    };
    // The factory is resolved once per id; a new function identity each render must not reconnect.
  }, [id]);

  return state;
}
