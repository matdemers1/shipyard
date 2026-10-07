import type { SystemStatus } from '@shipyard/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppsStore, type AppRow, type CommitsInfo, type PendingApproval } from '../src/lib/home';
import { hostWarnings, needsYouFrom, needsYouItems, SHELL_POLL_MS, type NeedsYouApp } from '../src/lib/needsyou';
import { mockFetch, type Reply } from './fetch';

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
    backups: { lastBackup: null, lastDrill: null },
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

  it('counts a failed nightly backup or restore drill, but not one that never ran', () => {
    const failed = { at: new Date().toISOString(), ok: false, file: null, error: 'pg_dump exited 1' };
    const base = status({});
    expect(hostWarnings({ ...base, backups: { lastBackup: failed, lastDrill: failed } } as SystemStatus)).toEqual([
      "Shipyard's nightly backup failed",
      'The restore drill failed',
    ]);
    expect(hostWarnings(base)).toEqual([]);
  });
});

describe('needsYouFrom', () => {
  it('counts exactly the items it lists, so the badge and the rows agree', () => {
    const result = needsYouFrom({
      apps: [app('failing', { commits: failedCommits() })],
      approvals: [approval('blog')],
      system: status({ patWarning: 'expired' }, 2),
    });
    expect(result.count).toBe(result.items.length);
    expect(result.items.map((i) => i.kind)).toEqual(['approval', 'ci-failed', 'agent-token']);
    expect(result.hostWarnings).toEqual(['The GitHub token has expired', 'Deploys are waiting to reach Foreman']);
  });
});

describe('the shared apps store (SHP-T-13.8)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const SYSTEM: Reply = { status: 200, body: status({}) };

  function routes() {
    return mockFetch({
      'GET /api/apps': { status: 200, body: { apps: [app('blog')] } },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/agent': { status: 200, body: [] },
      'GET /api/system': SYSTEM,
      'GET /api/apps/blog/commits': { status: 200, body: failedCommits() },
    });
  }

  const reads = (calls: { method: string; path: string }[], path: string) => calls.filter((c) => c.path === path).length;

  it('serves two watchers from one read', async () => {
    const calls = routes();
    const store = createAppsStore();
    const stopHome = store.watch(30_000, true);
    const stopShell = store.watch(SHELL_POLL_MS, true);
    await vi.waitFor(() => {
      expect(store.getSnapshot().status).toBe('ready');
    });
    expect(reads(calls, '/api/apps')).toBe(1);
    expect(reads(calls, '/api/apps/blog/commits')).toBe(1);
    expect(reads(calls, '/api/system')).toBe(1);
    expect(needsYouFrom(store.getSnapshot()).count).toBe(1);
    stopHome();
    stopShell();
  });

  it('reads again for a watcher that needs the host status the last read did not ask for', async () => {
    const calls = routes();
    const store = createAppsStore();
    const stopViewer = store.watch(SHELL_POLL_MS, false);
    await vi.waitFor(() => {
      expect(store.getSnapshot().status).toBe('ready');
    });
    expect(reads(calls, '/api/system')).toBe(0);
    const stopDeployer = store.watch(SHELL_POLL_MS, true);
    await vi.waitFor(() => {
      expect(store.getSnapshot().system).not.toBeNull();
    });
    expect(reads(calls, '/api/apps')).toBe(2);
    stopViewer();
    stopDeployer();
  });

  it('polls at the shortest pace anyone is watching at, and stops when nobody is', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const calls = routes();
    const store = createAppsStore();
    const stopShell = store.watch(SHELL_POLL_MS, false);
    const stopHome = store.watch(30_000, false);
    await vi.waitFor(() => {
      expect(store.getSnapshot().status).toBe('ready');
    });
    expect(reads(calls, '/api/apps')).toBe(1);

    vi.advanceTimersByTime(30_000);
    await vi.waitFor(() => {
      expect(reads(calls, '/api/apps')).toBe(2);
    });

    // Apps closes: the shell alone reads every five minutes, not every thirty seconds.
    stopHome();
    vi.advanceTimersByTime(60_000);
    expect(reads(calls, '/api/apps')).toBe(2);

    stopShell();
    vi.advanceTimersByTime(SHELL_POLL_MS);
    expect(reads(calls, '/api/apps')).toBe(2);
  });

  it('keeps the last answer when a read fails', async () => {
    let fail = false;
    mockFetch({
      'GET /api/apps': () => {
        if (fail) throw new TypeError('Failed to fetch');
        return { status: 200, body: { apps: [app('blog')] } };
      },
      'GET /api/approvals': { status: 200, body: [approval('blog')] },
      'GET /api/agent': { status: 200, body: [] },
      'GET /api/apps/blog/commits': { status: 200, body: failedCommits() },
    });
    const store = createAppsStore();
    const stop = store.watch(SHELL_POLL_MS, false);
    await vi.waitFor(() => {
      expect(store.getSnapshot().status).toBe('ready');
    });
    fail = true;
    store.refresh();
    await vi.waitFor(() => {
      expect(store.getSnapshot().status).toBe('error');
    });
    expect(needsYouFrom(store.getSnapshot()).count).toBe(1);
    stop();
  });
});
