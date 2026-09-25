import type { DeployStatus, DeployTargetState } from '@shipyard/schema';
import { useEffect, useState } from 'react';
import { RefusalError, request } from './api';

/**
 * Live deploy progress (SHP-T-3.4, SHP-REQ-058, SHP-D-070): Server-Sent Events from
 * `GET /api/deploys/:id/events`, and when the stream drops, polling `GET /api/deploys/:id` and
 * `/steps` every three seconds while SSE is retried with backoff. Progress never stops because a
 * proxy or a phone's radio dropped a long-lived connection.
 */

/** One step, as `GET /api/deploys/:id/steps` returns it (the contract the deploy record reads too). */
export interface DeployStep {
  name: string;
  argv: string[];
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  output: string | null;
}

export interface StepsResponse {
  steps: DeployStep[];
}

/** `connecting` before anything arrived, `live` on the stream, `polling` while it is retried. */
export type Transport = 'connecting' | 'live' | 'polling';

export interface DeployProgress {
  status: DeployStatus | null;
  steps: DeployStep[];
  transport: Transport;
  /** A refusal that stops progress altogether (no such deploy, not yours to read). */
  error: RefusalError | null;
  /** The deploy reached a terminal state; nothing more will change. */
  done: boolean;
}

export const TERMINAL_STATES: readonly DeployTargetState[] = ['succeeded', 'failed', 'rolled_back', 'refused', 'cancelled'];

export function isTerminal(state: DeployTargetState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** SHP-D-070: the polling fallback's period. */
export const POLL_MS = 3000;
/** The first SSE retry; each later one doubles, up to {@link MAX_RETRY_MS}. */
export const FIRST_RETRY_MS = 2000;
export const MAX_RETRY_MS = 30_000;

export function retryDelay(attempt: number): number {
  return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** attempt);
}

/** The part of `EventSource` this hook uses, so tests can pass a fake. */
export interface EventSourceLike {
  onopen: ((ev: Event) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void;
  close(): void;
}
export type EventSourceFactory = (url: string) => EventSourceLike;

export interface ProgressOptions {
  /** Defaults to the browser's `EventSource`; with none, the hook polls from the start. */
  eventSource?: EventSourceFactory | null;
}

function defaultFactory(): EventSourceFactory | null {
  if (typeof globalThis.EventSource !== 'function') return null;
  const Impl = globalThis.EventSource;
  return (url) => new Impl(url, { withCredentials: true });
}

const INITIAL: DeployProgress = { status: null, steps: [], transport: 'connecting', error: null, done: false };

export function useDeployProgress(id: string, options: ProgressOptions = {}): DeployProgress {
  const [state, setState] = useState<DeployProgress>(INITIAL);
  const factory = options.eventSource === undefined ? defaultFactory() : options.eventSource;

  useEffect(() => {
    setState(INITIAL);
    if (id === '') return;
    const base = `/api/deploys/${encodeURIComponent(id)}`;
    let stopped = false;
    let source: EventSourceLike | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
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

    const applyStatus = (status: DeployStatus): void => {
      const done = isTerminal(status.state);
      setState((s) => ({ ...s, status, done }));
      if (done && !stopped) {
        stopAll();
        // The stream sends `status` before `steps`, so closing on a terminal status would drop the
        // last steps — every step, for a deploy opened after it finished. Read them once more.
        request<StepsResponse>(`${base}/steps`, { signal: abort.signal })
          .then((res) => {
            applySteps(res.steps);
          })
          .catch(() => undefined);
      }
    };
    const applySteps = (steps: DeployStep[]): void => {
      setState((s) => ({ ...s, steps }));
    };

    const poll = async (): Promise<void> => {
      try {
        const [status, steps] = await Promise.all([
          request<DeployStatus>(base, { signal: abort.signal }),
          request<StepsResponse>(`${base}/steps`, { signal: abort.signal }),
        ]);
        if (stopped) return;
        applySteps(steps.steps);
        applyStatus(status);
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
      setState((s) => ({ ...s, transport: 'polling' }));
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
      const es = factory(`${base}/events`);
      source = es;
      const goLive = (): void => {
        attempt = 0;
        stopPolling();
        setState((s) => (s.transport === 'live' ? s : { ...s, transport: 'live' }));
      };
      es.onopen = goLive;
      es.addEventListener('status', (ev) => {
        if (stopped || source !== es) return;
        goLive();
        applyStatus(JSON.parse(ev.data) as DeployStatus);
      });
      es.addEventListener('steps', (ev) => {
        if (stopped || source !== es) return;
        applySteps((JSON.parse(ev.data) as StepsResponse).steps);
      });
      es.onerror = () => {
        if (stopped || source !== es) return;
        // The stream dropped (or never opened): poll now, and try the stream again later. The
        // browser's own retry is closed off so there is exactly one reconnect schedule.
        closeSource();
        startPolling();
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
