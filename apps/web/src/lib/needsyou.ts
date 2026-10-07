import type { PatWarning, SystemStatus } from '@shipyard/schema';
import { useCallback, useEffect, useState } from 'react';
import { request } from './api';
import { appStatus } from './appstatus';
import type { AppRow, CommitsInfo, PendingApproval } from './home';
import { system } from './system';

/**
 * Needs you (SHP-ADR-006, SHP-D-089): everything that is waiting on a person, in one list. There
 * is no separate Inbox — Apps shows the list and the nav's Apps badge is its length — so the
 * count and the list are derived from the same function and cannot disagree.
 *
 * Four things from the apps (a deploy waiting for approval, drift, a failed build on the newest
 * push) and two from the host (an agent that has stopped reporting, and a GitHub token that is
 * expiring or expired). A frozen app is held on purpose and is never "ci-failed"; `appStatus` is
 * what decides that, so Home's cards and this list read one rule.
 */

export type NeedsYouKind = 'approval' | 'drift' | 'ci-failed' | 'agent-stale' | 'agent-token';

export type NeedsYouItem =
  | { kind: 'approval'; app: string; deployId: string; sha: string }
  | { kind: 'drift'; app: string; driftId: string }
  | { kind: 'ci-failed'; app: string }
  | { kind: 'agent-stale' }
  | { kind: 'agent-token'; warning: Exclude<PatWarning, 'none'> };

/** An app as this list reads it: the row from `GET /api/apps` and, when known, its commits. */
export type NeedsYouApp = AppRow & { commits?: CommitsInfo | null };

export interface NeedsYouInput {
  apps: readonly NeedsYouApp[];
  approvals: readonly PendingApproval[];
  /** `GET /api/system`, or null when it could not be read (or the role may not read it). */
  system: SystemStatus | null;
}

/** The list, in the order a person should look: approvals, drift, failed builds, then the host. */
export function needsYouItems(input: NeedsYouInput): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];

  for (const approval of input.approvals) {
    items.push({ kind: 'approval', app: approval.app, deployId: approval.deployId, sha: approval.sha });
  }

  for (const app of input.apps) {
    if (app.drift !== null) items.push({ kind: 'drift', app: app.name, driftId: app.drift.id });
  }

  for (const app of input.apps) {
    const approval = input.approvals.find((a) => a.app === app.name);
    const status = appStatus({
      repo: app.repo,
      liveSha: app.liveSha,
      defaultBranch: app.defaultBranch ?? null,
      commits: app.commits ?? null,
      drift: app.drift,
      active: app.active,
      approval: approval === undefined ? undefined : { sha: approval.sha, requester: approval.requester },
      frozen: app.frozen ?? false,
    });
    if (status.kind === 'ci-failed') items.push({ kind: 'ci-failed', app: app.name });
  }

  const agent = input.system?.agent ?? null;
  if (agent?.stale === true) items.push({ kind: 'agent-stale' });
  if (agent !== null && agent.patWarning !== 'none') items.push({ kind: 'agent-token', warning: agent.patWarning });

  return items;
}

/**
 * Everything on the host worth a look, one plain line each, for the sidebar's health footer. A
 * superset of the host items above: it also counts deploys unsent to Foreman for over an hour
 * (SHP-REQ-095) and an agent that heartbeats without taking work, which the System screen shows
 * but which are not a decision for the Apps page.
 */
export function hostWarnings(status: SystemStatus | null): string[] {
  if (status === null) return [];
  const lines: string[] = [];
  const agent = status.agent;
  if (agent?.stale === true) lines.push('The agent has stopped reporting');
  if (agent !== null && agent.patWarning === 'expired') lines.push('The GitHub token has expired');
  if (agent !== null && agent.patWarning === 'expiring') lines.push('The GitHub token expires soon');
  if (agent !== null && agent.unstartedTargets > 0) lines.push('The agent is not starting the work it is given');
  if (status.outbox.unsentOverHour > 0) lines.push('Deploys are waiting to reach Foreman');
  return lines;
}

export interface NeedsYou {
  items: NeedsYouItem[];
  count: number;
  hostWarnings: string[];
}

const NONE: NeedsYou = { items: [], count: 0, hostWarnings: [] };

async function fetchCommits(app: string): Promise<CommitsInfo | null> {
  try {
    return await request<CommitsInfo>(`/api/apps/${encodeURIComponent(app)}/commits`);
  } catch {
    return null;
  }
}

/**
 * What the shell shows: the Apps badge and the host footer. Read once per sign-in, when the tab
 * regains focus, and every five minutes — the same pace the nav's old System badge had. A failed
 * read leaves the last answer rather than inventing a warning. `readSystem` is false for a
 * viewer, who cannot read `/api/system`; the apps' own items still count.
 */
export function useNeedsYou(readSystem: boolean): NeedsYou {
  const [state, setState] = useState<NeedsYou>(NONE);

  const load = useCallback(
    async (isLive: () => boolean) => {
      try {
        const [apps, approvals, status] = await Promise.all([
          request<{ apps: AppRow[] }>('/api/apps').then((r) => r.apps),
          request<PendingApproval[]>('/api/approvals'),
          readSystem ? system.status().catch(() => null) : Promise.resolve(null),
        ]);
        const withCommits = await Promise.all(
          apps.map(async (app): Promise<NeedsYouApp> => ({ ...app, commits: await fetchCommits(app.name) })),
        );
        if (!isLive()) return;
        const items = needsYouItems({ apps: withCommits, approvals, system: status });
        setState({ items, count: items.length, hostWarnings: hostWarnings(status) });
      } catch {
        // Keep what was last known.
      }
    },
    [readSystem],
  );

  useEffect(() => {
    let live = true;
    const isLive = () => live;
    void load(isLive);
    const onFocus = () => {
      void load(isLive);
    };
    const timer = setInterval(onFocus, 5 * 60 * 1000);
    window.addEventListener('focus', onFocus);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  return state;
}
