import type { DeployAccepted, DeployRequest, DeployStatus } from '@shipyard/schema';
import { request, RefusalError } from './api';
import type { SheetAction } from '../components/DryRunSheet';
import { ageFrom, type AgentRow } from './home';

/**
 * The dry-run sheet's data layer (SHP-T-3.3, SHP-REQ-057, SHP-D-068): the request that starts a
 * dry run for a {@link SheetAction}, the request that confirms it for real, and the commits/app
 * lookups the sheet shows alongside the gates.
 */

/** How long the sheet waits on one long poll before it reads again and re-polls. */
export const POLL_WAIT_SECONDS = 10;

/**
 * How long the sheet waits for a dry run to finish before it stops and says why (SHP-DA-014). The
 * agent normally answers within seconds; a stale agent never does, and the sheet must not spin on
 * forever with Confirm disabled and no reason.
 */
export const DRY_RUN_DEADLINE_SECONDS = 90;

/**
 * Why a dry run did not finish in time, as a refusal with a next step. The agent's heartbeat
 * decides which: not taking work at all, or slow this time. Nothing was changed either way — a dry
 * run never touches the host.
 */
export async function dryRunTimeout(now: number = Date.now()): Promise<RefusalError> {
  let agents: AgentRow[] | null;
  try {
    agents = await request<AgentRow[]>('/api/agent');
  } catch {
    agents = null;
  }
  const working = agents?.find((a) => a.confirmed && !a.stale);
  if (agents !== null && working === undefined) {
    const last = agents.find((a) => a.confirmed)?.lastHeartbeatAt ?? null;
    return new RefusalError(
      {
        code: 'agent_offline',
        gate: 'none',
        message: 'The agent is not taking work',
        fix:
          last === null
            ? 'No confirmed agent has checked in, so nothing can run the checks. Nothing was changed. Check the Agent page, then try again.'
            : `It last checked in ${ageFrom(last, now)}. Nothing was changed. Check the agent on the host (the Agent page shows its heartbeat), then try again.`,
      },
      503,
    );
  }
  return new RefusalError(
    {
      code: 'agent_offline',
      gate: 'none',
      message: `The checks did not finish within ${String(DRY_RUN_DEADLINE_SECONDS)}s`,
      fix: 'Nothing was changed. Close this and try again; if it keeps happening, check the Agent page.',
    },
    503,
  );
}

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
