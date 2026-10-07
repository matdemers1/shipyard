import type { SystemStatus } from '@shipyard/schema';
import { describe, expect, it } from 'vitest';
import type { AppRow, CommitsInfo, PendingApproval } from '../src/lib/home';
import { hostWarnings, needsYouItems, type NeedsYouApp } from '../src/lib/needsyou';

/** The one list behind the Apps badge (SHP-ADR-006): its order, and what it leaves out. */

const LIVE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

function app(name: string, overrides: Partial<NeedsYouApp> = {}): NeedsYouApp {
  const row: AppRow = {
    name,
    repo: `matdemers1/${name}`,
    liveSha: LIVE,
    reportedAt: null,
    drift: null,
    approvalPolicy: null,
    active: null,
  };
  return { ...row, commits: null, ...overrides };
}

function failedCommits(): CommitsInfo {
  return {
    live: LIVE,
    head: HEAD,
    newestGreen: null,
    source: 'github',
    commits: [{ sha: HEAD, message: 'break it', ci: 'failure', taskIds: [] }],
  };
}

function approval(appName: string, deployId = 'd1'): PendingApproval {
  return {
    deployId,
    kind: 'deploy',
    app: appName,
    sha: HEAD,
    requester: { label: 'Claude', repo: null, branch: null },
    requestedAt: '2026-10-06T10:00:00.000Z',
    expiresAt: '2026-10-07T10:00:00.000Z',
  };
}

function status(agent: Partial<NonNullable<SystemStatus['agent']>> | null, unsentOverHour = 0): SystemStatus {
  return {
    agent:
      agent === null
        ? null
        : {
            fingerprint: 'f',
            lastHeartbeatAt: null,
            stale: false,
            patExpiresAt: null,
            patWarning: 'none',
            unstartedTargets: 0,
            ...agent,
          },
    outbox: { unsent: unsentOverHour, unsentOverHour, oldestUnsentAt: null, lastError: null },
  } as SystemStatus;
}

describe('needsYouItems', () => {
  it('is empty when nothing waits on anyone', () => {
    expect(needsYouItems({ apps: [app('blog')], approvals: [], system: status({}) })).toEqual([]);
    expect(needsYouItems({ apps: [], approvals: [], system: null })).toEqual([]);
  });

  it('lists approvals, then drift, then failed builds, then the host, in that order', () => {
    const items = needsYouItems({
      apps: [
        app('failing', { commits: failedCommits() }),
        app('drifting', { drift: { id: 'dr1', detectedAt: '2026-10-06T09:00:00.000Z' } }),
      ],
      approvals: [approval('blog')],
      system: status({ stale: true, patWarning: 'expiring' }),
    });
    expect(items.map((i) => i.kind)).toEqual(['approval', 'drift', 'ci-failed', 'agent-stale', 'agent-token']);
    expect(items[0]).toMatchObject({ app: 'blog', deployId: 'd1' });
    expect(items[1]).toMatchObject({ app: 'drifting', driftId: 'dr1' });
    expect(items[2]).toMatchObject({ app: 'failing' });
    expect(items[4]).toMatchObject({ warning: 'expiring' });
  });

  it('counts one item per pending approval', () => {
    const items = needsYouItems({ apps: [], approvals: [approval('blog', 'd1'), approval('blog', 'd2'), approval('docs', 'd3')], system: null });
    expect(items).toHaveLength(3);
  });

  it('does not call a frozen app ci-failed, nor one that is mid-deploy', () => {
    const frozen = app('frozen', { commits: failedCommits(), frozen: true });
    const deploying = app('busy', {
      commits: failedCommits(),
      active: { targetId: 't', deployId: 'd', state: 'swapping', holder: 'Claude', currentStep: null },
    });
    expect(needsYouItems({ apps: [frozen, deploying], approvals: [], system: null })).toEqual([]);
  });

  it('counts a drifting app once, not again as a failed build', () => {
    const both = app('both', { commits: failedCommits(), drift: { id: 'dr', detectedAt: '2026-10-06T09:00:00.000Z' } });
    expect(needsYouItems({ apps: [both], approvals: [], system: null }).map((i) => i.kind)).toEqual(['drift']);
  });

  it('flags an expired token and leaves a healthy or missing agent alone', () => {
    expect(needsYouItems({ apps: [], approvals: [], system: status({ patWarning: 'expired' }) })).toEqual([{ kind: 'agent-token', warning: 'expired' }]);
    expect(needsYouItems({ apps: [], approvals: [], system: status(null) })).toEqual([]);
  });
});

describe('hostWarnings', () => {
  it('says nothing for a healthy host or one that could not be read', () => {
    expect(hostWarnings(status({}))).toEqual([]);
    expect(hostWarnings(null)).toEqual([]);
  });

  it('gives one line per thing wrong, first the agent', () => {
    const lines = hostWarnings(status({ stale: true, patWarning: 'expired', unstartedTargets: 2 }, 3));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('The agent has stopped reporting');
  });
});
