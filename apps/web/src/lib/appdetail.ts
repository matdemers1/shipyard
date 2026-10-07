import { request } from './api';
import type { CommitEntry, CommitsInfo } from './home';
import { formatSpan } from '../components/pipeline/stages';

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
  /**
   * Why a refused deploy was refused, in one line. Optional because the app response does not carry
   * it yet: the Deploys tab shows it when it arrives, and says to open the deploy until then.
   */
  refusal?: { message: string } | null;
}

/** The app's active freeze (SHP-T-5.1, SHP-REQ-077), or null when it is not frozen. */
export interface FreezeInfo {
  reason: string;
  by: string;
  from: string;
  until: string | null;
}

export interface Freeze extends FreezeInfo {
  id: string;
  app: string;
  clearedAt: string | null;
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
  /** When the agent stopped reporting it (SHP-REQ-174); null while it is reported. */
  retiredAt: string | null;
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

/**
 * A redeploy of the recorded release that a deployer requested: the drift stays open until the
 * agent reports the recorded release running again (SHP-REQ-066).
 */
export interface PendingRedeploy {
  deployId: string | null;
  requestedBy: string | null;
  note: string | null;
}

export interface DriftState {
  open: { id: string; detectedAt: string; services: DriftService[]; pending: PendingRedeploy | null } | null;
  resolved: {
    id: string;
    detectedAt: string;
    resolvedAt: string | null;
    /** Null when a newer observation superseded the event before anyone resolved it. */
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
  /**
   * Adopts what the deployer reviewed: the open drift event's observed digests, named by its id.
   * With no open drift (an app never deployed), what the agent last reported running.
   */
  adopt: (app: string, reason: string, driftEventId?: string): Promise<Adopted> =>
    request<Adopted>(`${path(app)}/drift/adopt`, {
      method: 'POST',
      body: driftEventId !== undefined ? { reason, driftEventId } : { reason },
    }),
  redeploy: (app: string, driftEventId: string): Promise<DeployAccepted> =>
    request<DeployAccepted>(`${path(app)}/drift/redeploy`, { method: 'POST', body: { driftEventId } }),
};

/** Freeze and unfreeze (SHP-T-5.1, SHP-REQ-077, SHP-D-049). */
export const freeze = {
  get: (app: string, signal?: AbortSignal): Promise<{ freeze: FreezeInfo | null }> =>
    request<{ freeze: FreezeInfo | null }>(`${path(app)}/freeze`, signal !== undefined ? { signal } : {}),
  set: (app: string, reason: string, until?: string): Promise<Freeze> =>
    request<Freeze>(`${path(app)}/freeze`, { method: 'POST', body: until !== undefined ? { reason, until } : { reason } }),
  clear: (app: string): Promise<Freeze> => request<Freeze>(`${path(app)}/freeze`, { method: 'DELETE' }),
};

/** The server's limit on a freeze reason (SHP-REQ-077). */
export const FREEZE_REASON_MAX = 500;

/** A freeze reason the server will accept: one line, 1–500 printable characters once trimmed. */
export function freezeReasonIsValid(reason: string): boolean {
  const trimmed = reason.trim();
  return trimmed.length > 0 && trimmed.length <= FREEZE_REASON_MAX && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(trimmed);
}

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

// ── The app page's derived facts (SHP-T-13.12) ──────────────────────────
//
// Pure functions of what the page already fetched, so the page's parts never work a fact out two
// ways and a test can pin each one without rendering.

function manifestObject(manifest: unknown): Record<string, unknown> | null {
  return typeof manifest === 'object' && manifest !== null ? (manifest as Record<string, unknown>) : null;
}

/** Whether the manifest has Shipyard build this app's images (`build.source: shipyard`). */
export function builtByShipyard(manifest: unknown): boolean {
  const build = manifestObject(manifest)?.build;
  return typeof build === 'object' && build !== null && (build as { source?: unknown }).source === 'shipyard';
}

/** The image workflow the manifest names (`workflow: ci.yml`), or null when it names none. */
export function manifestWorkflow(manifest: unknown): string | null {
  const workflow = manifestObject(manifest)?.workflow;
  return typeof workflow === 'string' && workflow !== '' ? workflow : null;
}

/** The repository on GitHub, for a link; null when the app names none. */
export function repoUrl(repo: string | null): string | null {
  return repo === null ? null : `https://github.com/${repo}`;
}

/**
 * The workflow's page on GitHub when the manifest names a workflow file, else the repository's
 * Actions page — a workflow named by its display name has no address of its own.
 */
export function workflowUrl(repo: string | null, workflow: string | null): string | null {
  if (repo === null) return null;
  if (workflow !== null && /\.ya?ml$/.test(workflow)) return `https://github.com/${repo}/actions/workflows/${encodeURIComponent(workflow)}`;
  return `https://github.com/${repo}/actions`;
}

/** Who asked for the release that is live, read from the history; null when it is not in it. */
export function liveRequester(detail: Pick<AppDetail, 'liveDeployId' | 'targets'>): string | null {
  if (detail.liveDeployId === null) return null;
  return detail.targets.find((t) => t.deployId === detail.liveDeployId)?.requester ?? null;
}

/** Waiting commits as the page lists them: newest first, so the top one is the one you would deploy. */
export function newestFirst(commits: CommitsInfo | null): CommitEntry[] {
  return [...(commits?.commits ?? [])].reverse();
}

/**
 * The commit the "Next up" card follows: the newest one with images, when it is ahead of live; or,
 * with none ready, the newest commit waiting, so a running CI shows its lane too. Null with nothing
 * waiting.
 */
export function nextUpCommit(commits: CommitsInfo | null, liveSha: string | null): CommitEntry | null {
  const entries = commits?.commits ?? [];
  const green = commits?.newestGreen ?? null;
  const ready = green !== null && green !== liveSha ? entries.find((c) => c.sha === green) : undefined;
  return ready ?? entries.at(-1) ?? null;
}

/**
 * The commits whose own CI failed that deploying `sha` takes along anyway: everything between live
 * and it rides with it, and a person deploying it should see that before they press the button.
 */
export function failedRidingAlong(commits: CommitsInfo | null, sha: string): CommitEntry[] {
  const entries = commits?.commits ?? [];
  const index = entries.findIndex((c) => c.sha === sha);
  return index <= 0 ? [] : entries.slice(0, index).filter((c) => c.ci === 'failure');
}

/** "Deploying 2cd9c27 also deploys 409abcd, whose CI failed." — the rider warning, in the vocabulary. */
export function ridingAlongWarning(sha: string, riders: readonly CommitEntry[]): string | null {
  if (riders.length === 0) return null;
  const names = riders.map((c) => sha7(c.sha)).join(', ');
  return `Deploying ${sha7(sha)} also deploys ${names}, whose CI failed.`;
}

/**
 * A rollback target on a history row: only the releases the server's ledger mirror offers
 * (SHP-D-080) — a successful deploy in the history that is not in that list gets no button.
 */
export function rollbackFor(target: Pick<HistoryTarget, 'id' | 'deployId'>, offered: readonly Release[]): Release | undefined {
  return offered.find((r) => r.targetId === target.id || r.deployId === target.deployId);
}

/** The offered rollback targets the history's last twenty rows do not show, so none is lost. */
export function rollbacksOutsideHistory(history: readonly HistoryTarget[], offered: readonly Release[]): Release[] {
  return offered.filter((r) => !history.some((t) => t.id === r.targetId || t.deployId === r.deployId));
}

/** "34s", "2m 05s", "1h 02m" between two instants; null while either is missing. */
export function took(startedAt: string | null, endedAt: string | null): string | null {
  if (startedAt === null || endedAt === null) return null;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (Number.isNaN(ms)) return null;
  return formatSpan(ms);
}

/** What a history row is: "Deploy f8b48f2", "Rollback f8b48f2", "Dry run f8b48f2". */
export function historyTitle(t: Pick<HistoryTarget, 'dryRun' | 'kind' | 'sha'>): string {
  const what = t.dryRun ? 'Dry run' : t.kind === 'rollback' ? 'Rollback' : t.kind === 'restore' ? 'Restore' : 'Deploy';
  return `${what} ${sha7(t.sha)}`;
}
