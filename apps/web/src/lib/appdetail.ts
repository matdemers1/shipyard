import { request } from './api';

/**
 * App detail (S5) and drift resolution: the shapes the server answers with, and the calls.
 * Rollback targets come only from the server, which mirrors the agent's ledger rule (SHP-D-080);
 * the console never works out for itself what may be rolled back to.
 */

export interface ReleaseImage {
  service: string;
  sha: string;
  digest: string;
  migration: string | null;
}

/** A release the agent's ledger would accept as a rollback target. */
export interface Release {
  deployId: string;
  targetId: string;
  kind: string;
  sha: string;
  requester: string;
  endedAt: string | null;
  images: ReleaseImage[];
}

/** A release behind a contract migration: only a restore can go back to it. */
export interface NeedsRestore extends Release {
  reason: string;
}

export interface HistoryTarget {
  id: string;
  deployId: string;
  kind: string;
  sha: string;
  dryRun: boolean;
  requester: string;
  state: string;
  currentStep: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface AppDetail {
  name: string;
  repo: string | null;
  defaultBranch: string | null;
  liveSha: string | null;
  liveDeployId: string | null;
  liveEndedAt: string | null;
  schemaRevision: string | null;
  digests: Record<string, string> | null;
  running: Record<string, string | null> | null;
  drift: { id: string; detectedAt: string } | null;
  reportedAt: string | null;
  soakSeconds: number | null;
  approvalPolicy: string | null;
  canary: boolean;
  group: string | null;
  manifest: unknown;
  active: { deployId: string; state: string; holder: string; currentStep: string | null } | null;
  rollbackTargets: Release[];
  needsRestore: NeedsRestore[];
  targets: HistoryTarget[];
}

export interface DriftService {
  service: string;
  observed: string | null;
  recorded: string | null;
  differs: boolean;
}

export interface DriftState {
  open: { id: string; detectedAt: string; services: DriftService[] } | null;
  resolved: {
    id: string;
    detectedAt: string;
    resolvedAt: string | null;
    resolution: 'adopt_live' | 'redeploy_recorded' | null;
    reason: string | null;
    resolvedBy: string | null;
  }[];
}

export interface Adopted {
  deployId: string;
  sha: string;
  digests: Record<string, string>;
}

export interface DeployAccepted {
  deployId: string;
  state: string;
}

const path = (app: string): string => `/api/apps/${encodeURIComponent(app)}`;

export const appDetail = {
  get: (app: string, signal?: AbortSignal): Promise<AppDetail> =>
    request<AppDetail>(path(app), signal !== undefined ? { signal } : {}),
  drift: (app: string, signal?: AbortSignal): Promise<DriftState> =>
    request<DriftState>(`${path(app)}/drift`, signal !== undefined ? { signal } : {}),
  adopt: (app: string, reason: string): Promise<Adopted> =>
    request<Adopted>(`${path(app)}/drift/adopt`, { method: 'POST', body: { reason } }),
  redeploy: (app: string): Promise<DeployAccepted> =>
    request<DeployAccepted>(`${path(app)}/drift/redeploy`, { method: 'POST', body: {} }),
};

/** The server's limit on an adopt-live reason (SHP-D-085). */
export const REASON_MAX = 200;

/** A reason the server will accept: one line, 1–200 printable characters once trimmed. */
export function reasonIsValid(reason: string): boolean {
  const trimmed = reason.trim();
  return trimmed.length > 0 && trimmed.length <= REASON_MAX && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(trimmed);
}

export function sha7(sha: string | null): string {
  return sha === null ? '—' : sha.slice(0, 7);
}

/** `sha256:abcdef…` shortened to the part a person compares: `sha256:abcdef123456`. */
export function shortDigest(digest: string | null): string {
  if (digest === null) return 'not running';
  const [algo, hex] = digest.split(':');
  return hex === undefined ? digest : `${algo ?? ''}:${hex.slice(0, 12)}`;
}

/** "3 minutes ago", "2 days ago": how old a release is, from `now`. */
export function age(iso: string | null, now: number = Date.now()): string {
  if (iso === null) return 'unknown';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  const units: [number, string][] = [
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, unit] of units) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${String(n)} ${unit}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

export function when(iso: string | null): string {
  return iso === null ? '—' : new Date(iso).toLocaleString();
}
