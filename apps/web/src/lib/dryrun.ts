import type { DeployAccepted, DeployRequest, DeployStatus } from '@shipyard/schema';
import { request, RefusalError } from './api';
import type { SheetAction } from '../components/DryRunSheet';
import { ageFrom, shortSha, type AgentRow } from './home';
import { approveVerb, ciWords, deployVerb, rollBackVerb, VERBS } from './words';

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
  /** The branch G6 checks against; null when the app has no repository. Absent from an older server. */
  defaultBranch?: string | null;
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

/**
 * The sheet's primary button (SHP-T-13.3): it names the SHA it will act on — "Deploy 2cd9c27" —
 * never "Confirm", so what a tap does is on the button.
 */
export function primaryLabelFor(action: SheetAction): string {
  switch (action.kind) {
    case 'deploy':
      return deployVerb(action.sha);
    case 'rollback':
      return rollBackVerb(action.sha);
    case 'approve':
      return approveVerb(action.sha);
  }
}

/** The sheet's title: the verb, the app and the short SHA it acts on — "Deploy bindery 2cd9c27". */
export function titleFor(action: SheetAction): string {
  const sha = shortSha(action.sha);
  switch (action.kind) {
    case 'deploy':
      return `Deploy ${action.app} ${sha}`;
    case 'rollback':
      return `${VERBS.rollBack} ${action.app} to ${sha}`;
    case 'approve':
      return `Approve deploy of ${action.app} ${sha}`;
  }
}

/**
 * The line under the title: what moves and how much — "f8b48f2 → 2cd9c27 · 3 commits". Until the
 * commits answer (or when they never do) it names only the target, so the sheet never claims a
 * count it does not have.
 */
export function subtitleFor(commits: CommitsResponse | null | 'loading', target: string, shipped: number): string {
  if (commits === null || commits === 'loading') return shortSha(target);
  const route = commits.live === null ? shortSha(target) : `${shortSha(commits.live)} → ${shortSha(target)}`;
  return `${route} · ${String(shipped)} ${shipped === 1 ? 'commit' : 'commits'}`;
}

/** A commit's CI state as the sheet marks it: words from the shared vocabulary and a dot tone. */
export function commitCi(
  ci: string | null,
  source: string,
): { words: string; tone: 'neutral' | 'warning' | 'danger' | 'idle' } {
  const state = ci === 'success' || ci === 'failure' || ci === 'pending' ? ci : 'none';
  const words = ciWords(state, source === 'shipyard' ? 'shipyard' : 'github');
  switch (state) {
    case 'success':
      return { words, tone: 'neutral' };
    case 'failure':
      return { words, tone: 'danger' };
    case 'pending':
      return { words, tone: 'warning' };
    case 'none':
      return { words, tone: 'idle' };
  }
}

/**
 * One warning per commit whose CI failed and that ships along with the target. A deploy ships
 * every commit between live and the target, so a red commit underneath a green one still goes out
 * (SHP-REQ-161). The target itself is left out: its own failure is the dry run's refusal.
 */
export function rideAlongWarnings(shipped: readonly CommitInfo[], target: string): string[] {
  return shipped
    .filter((c) => c.ci === 'failure' && c.sha !== target)
    .map((c) => `${shortSha(c.sha)} failed CI. Its code ships with ${shortSha(target)}.`);
}

/**
 * The app's newest green commit, when a refused dry run failed on CI (gate G5) and there is a
 * different one to deploy instead. Only a plain deploy offers it: an approval is for the held
 * SHA, and a rollback already names the release it returns to.
 */
export function newestGreenInstead(
  commits: CommitsResponse | null | 'loading',
  action: SheetAction,
  status: DeployStatus | null,
): string | null {
  if (action.kind !== 'deploy' || status === null || commits === null || commits === 'loading') return null;
  const ciRefused = status.refusal?.gate === 'G5' || status.gates.some((g) => !g.pass && g.gate === 'G5');
  const green = commits.newestGreen;
  return ciRefused && green !== null && green !== action.sha ? green : null;
}

/** Failed checks first, so the reason a deploy cannot go is the first thing read; order is otherwise kept. */
export function failedFirst<T extends { pass: boolean }>(gates: readonly T[]): T[] {
  return [...gates.filter((g) => !g.pass), ...gates.filter((g) => g.pass)];
}

/** The checks' summary line: "All 6 passed", or "5 of 6 passed". Null when the agent reported none. */
export function checksSummary(gates: readonly { pass: boolean }[]): string | null {
  if (gates.length === 0) return null;
  const passed = gates.filter((g) => g.pass).length;
  return passed === gates.length ? `All ${String(passed)} passed` : `${String(passed)} of ${String(gates.length)} passed`;
}

/** How long ago the agent answered: "3s ago" under a minute, then the console's usual ages. */
export function askedWords(iso: string | null, now: number = Date.now()): string {
  const then = iso === null ? Number.NaN : new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  return seconds < 60 ? `${String(seconds)}s ago` : ageFrom(iso, now);
}
