import type { SystemStatus } from '@shipyard/schema';
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { request, RefusalError } from './api';
import { system } from './system';

/**
 * Data for Apps (SHP-T-3.2, SHP-T-13.8, SHP-REQ-056, SHP-REQ-087, SHP-REQ-155): one row per app
 * with its live SHA, the commits waiting on the default branch and their CI state, and what needs
 * a person. Everything here is read-only — the state-changing calls (deploy, approve, deny, adopt)
 * live in `DryRunSheet`, Needs you's deny confirm and the drift buttons.
 */

export type CiState = 'success' | 'failure' | 'pending' | 'none';

/**
 * The push-to-default-branch GitHub Actions run behind a commit's `ci` (SHP-T-13.7, SHP-REQ-167): the
 * pipeline's CI stage links to `url`. `completedAt` is present only once the run has completed.
 */
export interface CommitRun {
  id: number;
  url: string | null;
  startedAt: string | null;
  completedAt?: string | null;
  conclusion: string | null;
}

export interface CommitEntry {
  sha: string;
  message: string;
  ci: CiState;
  taskIds: string[];
  /** For a `build: shipyard` app, the latest Shipyard build of this SHA (SHP-T-3.11). */
  buildId?: string;
  /** The run behind `ci`; null with no such run or for a `build: shipyard` app, absent from a server that predates the field. */
  run?: CommitRun | null;
}

/** `GET /api/apps/:app/commits`. */
export interface CommitsInfo {
  live: string | null;
  head: string | null;
  /** The newest ten commits ahead of live, oldest first. */
  commits: CommitEntry[];
  /** Every commit ahead of live; absent from a server older than SHP-T-3.10. */
  ahead?: number;
  newestGreen: string | null;
  source: 'github' | 'unavailable';
  /** Where the images come from, which decides what `ci` means; absent from older servers. */
  buildSource?: 'github' | 'shipyard';
}

/** `GET /api/apps` — the fields the home cards use. */
export interface AppRow {
  name: string;
  repo: string | null;
  defaultBranch?: string | null;
  liveSha: string | null;
  reportedAt: string | null;
  drift: { id: string; detectedAt: string } | null;
  approvalPolicy: string | null;
  /** A freeze holds now; absent from a server older than SHP-T-12.2. */
  frozen?: boolean;
  active: { targetId: string; deployId: string; state: string; holder: string; currentStep: string | null } | null;
}

/** `GET /api/approvals`. */
export interface PendingApproval {
  deployId: string;
  kind: string;
  app: string;
  sha: string;
  requester: { label: string; repo: string | null; branch: string | null };
  requestedAt: string;
  expiresAt: string;
  /** Set for a scheduled deploy: when it fires once approved (SHP-D-051). */
  fireAt?: string | null;
}

/** `GET /api/agent` — one row per enrolled agent. */
export interface AgentRow {
  id: string;
  confirmed: boolean;
  lastHeartbeatAt: string | null;
  stale: boolean;
}

export interface HomeApp extends AppRow {
  commits: CommitsInfo | null;
  /** This app has a pending approval waiting (SHP-D-071). */
  approvalPending: boolean;
}

export type HomeStatus = 'loading' | 'ready' | 'error';

/**
 * Everything Apps and the shell read, from one set of requests (SHP-T-13.8): the apps with their
 * commits, the approvals, the agents and — for a role that may read it — the host's status. The
 * Apps badge is `needsYouItems` over this same snapshot, so the number in the nav and the rows on
 * the page are counted from one answer and cannot disagree.
 */
export interface AppsSnapshot {
  status: HomeStatus;
  apps: HomeApp[];
  approvals: PendingApproval[];
  /** Null until read, or when `/api/agent` could not be read. */
  agents: AgentRow[] | null;
  /** `GET /api/system`, or null when it was not asked for, could not be read, or the role may not read it. */
  system: SystemStatus | null;
  error: RefusalError | null;
  /** When the last read that succeeded finished, in epoch milliseconds. */
  loadedAt: number | null;
}

export interface AppsStore {
  getSnapshot: () => AppsSnapshot;
  subscribe: (listener: () => void) => () => void;
  /**
   * Keeps the snapshot fresh while the caller is mounted: polls at the shortest pace any watcher
   * asked for and on window focus, and reads `/api/system` while any watcher may read it. Returns
   * the function that stops watching.
   */
  watch: (everyMs: number, readSystem: boolean) => () => void;
  /** Reads everything again now — after a deny, an adopt, a started deploy. */
  refresh: () => void;
}

const INITIAL: AppsSnapshot = {
  status: 'loading',
  apps: [],
  approvals: [],
  agents: null,
  system: null,
  error: null,
  loadedAt: null,
};

async function fetchCommits(app: string): Promise<CommitsInfo | null> {
  try {
    return await request<CommitsInfo>(`/api/apps/${encodeURIComponent(app)}/commits`);
  } catch {
    return null;
  }
}

/**
 * One store per signed-in shell. The shell creates it and provides it, so Apps and the nav badge
 * share one polling loop for `/api/apps`, `/api/approvals` and the per-app commits, instead of each
 * running its own. It is an object rather than module state so that every shell — and every test
 * that renders one — starts empty.
 */
export function createAppsStore(): AppsStore {
  let snapshot = INITIAL;
  const listeners = new Set<() => void>();
  const watches = new Set<{ everyMs: number; readSystem: boolean }>();
  let generation = 0;
  // What the read in flight, and the last one that landed, asked for: a watcher that needs the host
  // status starts a new read when the one it would otherwise share did not ask for it.
  let inFlight: { readSystem: boolean } | null = null;
  let lastReadSystem = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let timerMs = 0;

  const emit = (next: AppsSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const wantsSystem = (): boolean => [...watches].some((w) => w.readSystem);

  async function load(): Promise<void> {
    const gen = ++generation;
    const readSystem = wantsSystem();
    inFlight = { readSystem };
    try {
      const [appRows, approvalRows, agentRows, host] = await Promise.all([
        request<{ apps: AppRow[] }>('/api/apps').then((r) => r.apps),
        request<PendingApproval[]>('/api/approvals'),
        // Only the empty states read the agents; a failed read must not hide the apps.
        request<AgentRow[]>('/api/agent').catch(() => null),
        readSystem ? system.status().catch(() => null) : Promise.resolve(null),
      ]);
      if (gen !== generation) return;

      const pendingByApp = new Set(approvalRows.map((a) => a.app));
      const apps = await Promise.all(
        appRows.map(async (row): Promise<HomeApp> => ({
          ...row,
          commits: await fetchCommits(row.name),
          approvalPending: pendingByApp.has(row.name),
        })),
      );
      if (gen !== generation) return;

      lastReadSystem = readSystem;
      emit({ status: 'ready', apps, approvals: approvalRows, agents: agentRows, system: host, error: null, loadedAt: Date.now() });
    } catch (err) {
      if (gen !== generation) return;
      // The last answer stays, so the badge does not invent or drop a warning on one failed read.
      emit({ ...snapshot, status: 'error', error: err instanceof RefusalError ? err : null });
    } finally {
      if (gen === generation) inFlight = null;
    }
  }

  const onFocus = (): void => {
    void load();
  };

  // One timer at the shortest pace any watcher asked for, and the focus listener while anyone watches.
  function rearm(): void {
    const pace = watches.size === 0 ? 0 : Math.min(...[...watches].map((w) => w.everyMs));
    if (pace === timerMs) return;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    if (timerMs === 0) window.addEventListener('focus', onFocus);
    if (pace === 0) window.removeEventListener('focus', onFocus);
    else timer = setInterval(onFocus, pace);
    timerMs = pace;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    watch: (everyMs, readSystem) => {
      const entry = { everyMs, readSystem };
      watches.add(entry);
      // A watcher shares the read in flight, or a recent enough answer, when it has what it reads;
      // otherwise — Apps opened five minutes after the shell's last read — it reads now.
      const covered =
        inFlight !== null
          ? !readSystem || inFlight.readSystem
          : snapshot.loadedAt !== null && Date.now() - snapshot.loadedAt < everyMs && (!readSystem || lastReadSystem);
      if (!covered) void load();
      rearm();
      return () => {
        watches.delete(entry);
        rearm();
      };
    },
    refresh: () => {
      void load();
    },
  };
}

export const AppsStoreContext = createContext<AppsStore | null>(null);

/**
 * The shell's store, or — for a screen rendered without the shell — one of the screen's own, so
 * nothing ever renders without data.
 */
export function useAppsStore(): AppsStore {
  const shared = useContext(AppsStoreContext);
  const [own] = useState(createAppsStore);
  return shared ?? own;
}

/** Subscribes to the store and keeps it fresh at `everyMs` while mounted. */
export function useAppsSnapshot(store: AppsStore, everyMs: number, readSystem: boolean): AppsSnapshot {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => store.watch(everyMs, readSystem), [store, everyMs, readSystem]);
  return snapshot;
}

/** How often Apps reads while it is open. The shell alone reads every five minutes. */
export const HOME_POLL_MS = 30_000;

export interface HomeData extends AppsSnapshot {
  /** True when no agent has ever enrolled. */
  noAgent: boolean;
  /** An agent is enrolled and confirmed, but has reported no apps. */
  noApps: boolean;
  refresh: () => void;
}

/**
 * Apps' data: the shell's shared snapshot, read every 30 seconds while Apps is open. `readSystem`
 * is false for a viewer, who may not read `/api/system`.
 */
export function useHomeData(readSystem: boolean): HomeData {
  const store = useAppsStore();
  const snapshot = useAppsSnapshot(store, HOME_POLL_MS, readSystem);
  const agents = snapshot.agents;
  const ready = snapshot.status === 'ready' && agents !== null;
  const confirmed = agents?.filter((a) => a.confirmed) ?? [];
  return {
    ...snapshot,
    noAgent: ready && agents.length === 0,
    noApps: ready && confirmed.length > 0 && snapshot.apps.length === 0,
    refresh: store.refresh,
  };
}

// ── Pure helpers (unit-testable without rendering) ─────────────────────────

export function shortSha(sha: string | null): string {
  return sha === null ? '—' : sha.slice(0, 7);
}

/** A human age like "3h ago" from an ISO timestamp, or "—" when there is none. */
export function ageFrom(iso: string | null, now: number = Date.now()): string {
  if (iso === null) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}
