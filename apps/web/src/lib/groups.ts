import type { DeployAccepted, GroupSummary } from '@shipyard/schema';
import { request } from './api';
import type { CommitsInfo } from './home';

/**
 * Home's group-deploy sheet (SHP-T-5.11, SHP-REQ-078, SHP-REQ-079): every reported group, the
 * canary's newest green commit as the default target, and the request that starts a group deploy.
 * A group dry run is refused server-side (`createGroupDeploy` in `groups/service.ts`), so this
 * sheet confirms straight from the gates the same dry-run sheet would otherwise show — see
 * `GroupDeploySheet.tsx` for that choice.
 */

/** `GET /api/groups` — every group the agent has reported, filtered to a token's scope already. */
export function fetchGroups(): Promise<GroupSummary[]> {
  return request<GroupSummary[]>('/api/groups');
}

/** The member's commits, for the sheet's default candidate SHA (the newest green). `null` if unavailable. */
export async function fetchMemberCommits(app: string): Promise<CommitsInfo | null> {
  try {
    return await request<CommitsInfo>(`/api/apps/${encodeURIComponent(app)}/commits`);
  } catch {
    return null;
  }
}

/** Starts a real group deploy at `sha` — `POST /api/deploys` with `group` in place of `app`. */
export function startGroupDeploy(group: string, sha: string): Promise<DeployAccepted> {
  return request<DeployAccepted>('/api/deploys', { method: 'POST', body: { kind: 'deploy', group, sha } });
}
