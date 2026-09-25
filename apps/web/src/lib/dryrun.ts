import type { DeployAccepted, DeployRequest, DeployStatus } from '@shipyard/schema';
import { request, RefusalError } from './api';
import type { SheetAction } from '../components/DryRunSheet';

/**
 * The dry-run sheet's data layer (SHP-T-3.3, SHP-REQ-057, SHP-D-068): the request that starts a
 * dry run for a {@link SheetAction}, the request that confirms it for real, and the commits/app
 * lookups the sheet shows alongside the gates.
 */

/** How long the sheet waits on one long poll before it reads again and re-polls. */
export const POLL_WAIT_SECONDS = 10;

/** The DeployRequest for a dry run of `action` — same kind, app and SHA the real action would use. */
export function dryRunRequestFor(action: SheetAction): DeployRequest {
  switch (action.kind) {
    case 'deploy':
      return { kind: 'deploy', app: action.app, sha: action.sha, dryRun: true };
    case 'rollback':
      return { kind: 'rollback', app: action.app, toDeployId: action.toDeployId, dryRun: true };
    case 'approve':
      // The held deploy's own app and SHA, dry-run again for the approver to see fresh gates.
      return { kind: 'deploy', app: action.app, sha: action.sha, dryRun: true };
  }
}

/** The DeployRequest that actually starts `action` (no `approve` case: that goes through `/approve`). */
export function realRequestFor(action: Exclude<SheetAction, { kind: 'approve' }>): DeployRequest {
  return action.kind === 'deploy'
    ? { kind: 'deploy', app: action.app, sha: action.sha }
    : { kind: 'rollback', app: action.app, toDeployId: action.toDeployId };
}

export function startDryRun(action: SheetAction, signal: AbortSignal): Promise<DeployAccepted> {
  return request<DeployAccepted>('/api/deploys', { method: 'POST', body: dryRunRequestFor(action), signal });
}

export function pollDeployStatus(deployId: string, waitSeconds: number, signal: AbortSignal): Promise<DeployStatus> {
  return request<DeployStatus>(`/api/deploys/${deployId}?wait=${String(waitSeconds)}`, { signal });
}

/** Starts the real deploy or rollback. */
export function startReal(action: Exclude<SheetAction, { kind: 'approve' }>): Promise<DeployAccepted> {
  return request<DeployAccepted>('/api/deploys', { method: 'POST', body: realRequestFor(action) });
}

/** Approves a held deploy — the real action for an `approve` sheet. */
export function approveDeploy(deployId: string): Promise<DeployAccepted> {
  return request<DeployAccepted>(`/api/deploys/${deployId}/approve`, { method: 'POST' });
}

export interface AppSummary {
  soakSeconds: number | null;
}

export function getApp(app: string): Promise<AppSummary> {
  return request<AppSummary>(`/api/apps/${app}`);
}

export interface CommitInfo {
  sha: string;
  message: string;
  ci: string | null;
  taskIds: string[];
}

export interface CommitsResponse {
  live: string | null;
  commits: CommitInfo[];
  newestGreen: string | null;
  source: string;
}

/**
 * Commits between `live` and the target SHA, for the sheet's "what ships" list. `null` when the
 * endpoint is unavailable (e.g. it 404s: it is built by a parallel task) — the sheet shows
 * "commits unavailable" rather than failing.
 */
export async function getCommits(app: string): Promise<CommitsResponse | null> {
  try {
    return await request<CommitsResponse>(`/api/apps/${app}/commits`);
  } catch (error) {
    if (error instanceof RefusalError && (error.status === 404 || error.status === 501)) return null;
    throw error;
  }
}

/** Commits shipped by a deploy to `targetSha`: every commit from `live` down to and including it. */
export function commitsToShip(commits: CommitsResponse, targetSha: string): CommitInfo[] {
  const idx = commits.commits.findIndex((c) => c.sha === targetSha);
  return idx === -1 ? [] : commits.commits.slice(0, idx + 1);
}

/** A dry run's per-image migration labels, `contract` first, for the warning row. */
export function migrationLabels(status: DeployStatus): { service: string; migration: string }[] {
  return status.images
    .filter((i): i is { service: string; migration: string } & typeof i => i.migration !== null && i.migration !== undefined)
    .map((i) => ({ service: i.service, migration: i.migration }))
    .sort((a, b) => (a.migration === 'contract' ? -1 : b.migration === 'contract' ? 1 : 0));
}

export function hasContractMigration(status: DeployStatus): boolean {
  return status.images.some((i) => i.migration === 'contract');
}

/** The label for a sheet's action, e.g. "Deploy web", used as the Modal title. */
export function titleFor(action: SheetAction): string {
  switch (action.kind) {
    case 'deploy':
      return `Deploy ${action.app}`;
    case 'rollback':
      return `Roll back ${action.app}`;
    case 'approve':
      return `Approve deploy of ${action.app}`;
  }
}
