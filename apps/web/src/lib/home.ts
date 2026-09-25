import { useCallback, useEffect, useRef, useState } from 'react';
import { request, RefusalError } from './api';

/**
 * Data for the S2 home screen (SHP-T-3.2, SHP-REQ-056, SHP-REQ-059, SHP-REQ-060, SHP-REQ-087):
 * one card per app with its live SHA, commits waiting on the default branch and their CI state,
 * lock state, last result and a deploy action, plus the approvals banner. Everything here is
 * read-only — the state-changing calls (deploy, approve, deny) live in `DryRunSheet` and the
 * banner's own deny confirm.
 */

export type CiState = 'success' | 'failure' | 'pending' | 'none';

export interface CommitEntry {
  sha: string;
  message: string;
  ci: CiState;
  taskIds: string[];
}

/** `GET /api/apps/:app/commits`. */
export interface CommitsInfo {
  live: string | null;
  head: string | null;
  commits: CommitEntry[];
  newestGreen: string | null;
  source: 'github' | 'unavailable';
}

/** `GET /api/apps` — the fields the home cards use. */
export interface AppRow {
  name: string;
  repo: string | null;
  liveSha: string | null;
  reportedAt: string | null;
  drift: { id: string; detectedAt: string } | null;
  approvalPolicy: string | null;
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

/** `GET /api/deploys?app=&limit=1` — just enough for "last result". */
export interface LastDeploy {
  deployId: string;
  state: string;
  endedAt: string | null;
}

export interface HomeApp extends AppRow {
  commits: CommitsInfo | null;
  lastDeploy: LastDeploy | null;
  /** This app has a pending approval waiting (SHP-D-071's card badge). */
  approvalPending: boolean;
}

export type HomeStatus = 'loading' | 'ready' | 'error';

export interface HomeData {
  status: HomeStatus;
  apps: HomeApp[];
  approvals: PendingApproval[];
  /** True when no agent has ever enrolled. */
  noAgent: boolean;
  /** An agent is enrolled and confirmed, but has reported no apps. */
  noApps: boolean;
  /** No confirmed agent has reported within the heartbeat window. */
  agentStale: boolean;
  error: RefusalError | null;
  refresh: () => void;
}

interface RawDeploysResponse {
  deployId: string;
  state: string;
  endedAt: string | null;
}

async function fetchCommits(app: string): Promise<CommitsInfo | null> {
  try {
    return await request<CommitsInfo>(`/api/apps/${encodeURIComponent(app)}/commits`);
  } catch {
    return null;
  }
}

async function fetchLastDeploy(app: string): Promise<LastDeploy | null> {
  try {
    const rows = await request<RawDeploysResponse[]>(`/api/deploys?app=${encodeURIComponent(app)}&limit=1`);
    const row = rows[0];
    return row === undefined ? null : { deployId: row.deployId, state: row.state, endedAt: row.endedAt };
  } catch {
    return null;
  }
}

/** Polls `/api/apps`, `/api/approvals`, `/api/agent`, then per-app commits and last deploy. */
export function useHomeData(): HomeData {
  const [status, setStatus] = useState<HomeStatus>('loading');
  const [apps, setApps] = useState<HomeApp[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [error, setError] = useState<RefusalError | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    try {
      const [appRows, approvalRows, agentRows] = await Promise.all([
        request<{ apps: AppRow[] }>('/api/apps').then((r) => r.apps),
        request<PendingApproval[]>('/api/approvals'),
        request<AgentRow[]>('/api/agent'),
      ]);
      if (gen !== generation.current) return;

      const pendingByApp = new Set(approvalRows.map((a) => a.app));
      const enriched = await Promise.all(
        appRows.map(async (row): Promise<HomeApp> => {
          const [commits, lastDeploy] = await Promise.all([fetchCommits(row.name), fetchLastDeploy(row.name)]);
          return { ...row, commits, lastDeploy, approvalPending: pendingByApp.has(row.name) };
        }),
      );
      if (gen !== generation.current) return;

      setApps(enriched);
      setApprovals(approvalRows);
      setAgents(agentRows);
      setStatus('ready');
      setError(null);
    } catch (err) {
      if (gen !== generation.current) return;
      setError(err instanceof RefusalError ? err : null);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void load();
    const onFocus = () => {
      void load();
    };
    const interval = setInterval(() => {
      void load();
    }, 30_000);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(interval);
    };
  }, [load]);

  const noAgent = status === 'ready' && agents.length === 0;
  const confirmed = agents.filter((a) => a.confirmed);
  const noApps = status === 'ready' && confirmed.length > 0 && apps.length === 0;
  const agentStale = status === 'ready' && confirmed.length > 0 && confirmed.every((a) => a.stale);

  return {
    status,
    apps,
    approvals,
    noAgent,
    noApps,
    agentStale,
    error,
    refresh: () => {
      void load();
    },
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

/** Commits waiting: everything the commits endpoint listed (base..head, oldest first). */
export function waitingCount(commits: CommitsInfo | null): number {
  return commits?.commits.length ?? 0;
}

export type PrimaryAction =
  | { kind: 'ship'; sha: string }
  | { kind: 'up-to-date' }
  | { kind: 'nothing-green'; reason: string };

/**
 * The card's primary action (SHP-REQ-059): ship the newest green commit when it is ahead of live.
 * "Ahead of live" means it appears in the waiting list at all — a live SHA GitHub no longer knows
 * about, or no commits data, never invents a ship target.
 */
export function primaryActionFor(app: HomeApp): PrimaryAction {
  const commits = app.commits;
  if (commits === null || commits.source === 'unavailable') {
    return { kind: 'nothing-green', reason: 'GitHub is unavailable.' };
  }
  if (commits.newestGreen === null) {
    return waitingCount(commits) === 0
      ? { kind: 'up-to-date' }
      : { kind: 'nothing-green', reason: 'No commit ahead of live has passed CI yet.' };
  }
  if (commits.newestGreen === app.liveSha) {
    return { kind: 'up-to-date' };
  }
  const isWaiting = commits.commits.some((c) => c.sha === commits.newestGreen);
  if (!isWaiting) {
    return { kind: 'up-to-date' };
  }
  return { kind: 'ship', sha: commits.newestGreen };
}
