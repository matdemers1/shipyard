import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ScheduleEntry, ScheduleList } from '@shipyard/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { BuildSummary } from '../src/lib/builds';
import type { TimelineItem, TimelinePage } from '../src/lib/timeline';
import {
  dayLabel,
  formatDue,
  formatDuration,
  formatFeedTime,
  type TimelineOutcome,
} from '../src/lib/timeline';
import { buildHeadline, deployHeadline, filtersFromParams, groupRollouts, refusalLine, timelineFilters, type FeedEntry } from '../src/screens/activity/model';
import { meReply, mockFetch, type Call, type Reply } from './fetch';

/**
 * Activity (SHP-T-13.13, SHP-REQ-164): one feed of deploys, rollbacks, refusals, schedules and
 * Shipyard builds, grouped by day, with the filters in the URL, upcoming schedules pinned on top
 * and a rollout's deploys as one expandable row.
 */

// Local noon on a Tuesday, so "Today" and "Yesterday" cannot straddle midnight whatever the zone.
const NOW = new Date(2026, 9, 6, 12, 0, 0);

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

function deploy(overrides: Partial<TimelineItem> = {}): TimelineItem {
  return {
    deployId: 'd-1',
    kind: 'deploy',
    app: 'web',
    sha: 'a'.repeat(40),
    dryRun: false,
    state: 'succeeded',
    requesterLabel: 'Matt (console)',
    createdAt: ago(12 * MIN),
    endedAt: ago(12 * MIN - 45_000),
    refusalCode: null,
    ...overrides,
  };
}

function build(overrides: Partial<BuildSummary> = {}): BuildSummary {
  return {
    buildId: 'b-1',
    app: 'blog',
    sha: 'c'.repeat(40),
    state: 'succeeded',
    trigger: 'webhook',
    queueSeq: '1',
    requesterLabel: 'github',
    rebuildOfId: null,
    failedStage: null,
    cancelRequestedAt: null,
    dispatchedAt: null,
    startedAt: ago(3 * HOUR + 6 * MIN),
    endedAt: ago(3 * HOUR),
    createdAt: ago(3 * HOUR + 6 * MIN),
    ...overrides,
  };
}

function schedule(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return {
    id: 's-1',
    deployId: 'ds-1',
    app: 'api',
    sha: 'e'.repeat(40),
    fireAt: new Date(NOW.getTime() + DAY).toISOString(),
    firedAt: null,
    cancelledAt: null,
    status: 'upcoming',
    by: 'Matt',
    requester: { label: 'Matt (scheduled)', repo: null, branch: null },
    approval: { state: 'approved', by: 'Matt', at: ago(HOUR) },
    state: 'queued',
    refusal: null,
    createdAt: ago(HOUR),
    ...overrides,
  };
}

function page(items: TimelineItem[], nextCursor: string | null = null): Reply {
  return { status: 200, body: { items, nextCursor } satisfies TimelinePage };
}

interface Setup {
  role?: 'viewer' | 'deployer';
  timeline?: Reply | Reply[];
  builds?: BuildSummary[];
  schedules?: ScheduleList;
  extra?: Record<string, Reply>;
}

function setup(s: Setup = {}): Call[] {
  return mockFetch({
    'GET /api/auth/me': meReply(s.role ?? 'viewer'),
    'GET /api/apps': { status: 200, body: { apps: [{ name: 'web' }, { name: 'blog' }, { name: 'api' }] } },
    'GET /api/deploys/timeline': s.timeline ?? page([]),
    'GET /api/builds': { status: 200, body: { items: s.builds ?? [], nextCursor: null } },
    'GET /api/schedules': { status: 200, body: s.schedules ?? { upcoming: [], past: [] } },
    ...s.extra,
  });
}

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(<App />);
}

describe('Activity feed', () => {
  it('groups one feed by day, with deploys, a refusal and a build in time order', async () => {
    setup({
      timeline: page([
        deploy(),
        deploy({
          deployId: 'd-2',
          app: 'api',
          state: 'refused',
          requesterLabel: 'claude: fix login',
          createdAt: ago(2 * HOUR),
          endedAt: ago(2 * HOUR),
          refusalCode: 'app_frozen',
          refusalGate: 'G2',
          refusalMessage: 'api is frozen',
        }),
        deploy({ deployId: 'd-3', app: 'old', createdAt: ago(DAY + HOUR), endedAt: ago(DAY + HOUR - 30_000), requesterLabel: 'Matt (scheduled)' }),
      ]),
      builds: [build()],
    });
    renderAt('/activity');

    const today = await screen.findByRole('list', { name: 'Today' });
    const rows = within(today).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('web');
    expect(rows[0]).toHaveTextContent('aaaaaaa');
    expect(rows[0]).toHaveTextContent('Deployed');
    expect(rows[0]).toHaveTextContent('console · Matt');
    expect(rows[0]).toHaveTextContent('45s');
    expect(rows[0]).toHaveTextContent('12m ago');
    expect(rows[1]).toHaveTextContent('Refused — Not frozen — api is frozen');
    expect(rows[1]).toHaveTextContent('claude: fix login');
    expect(rows[2]).toHaveTextContent('Build passed');
    expect(rows[2]).toHaveTextContent('6m 0s');

    const yesterday = screen.getByRole('list', { name: 'Yesterday' });
    expect(within(yesterday).getByText('old')).toBeInTheDocument();
    expect(within(yesterday).getByText(/schedule · Matt/)).toBeInTheDocument();
    expect(screen.getByText(/Pushes and CI runs are not listed here/)).toBeInTheDocument();
  });

  it('every row links to its deploy, and a build row to its build page', async () => {
    setup({ timeline: page([deploy({ deployId: 'd-9' })]), builds: [build({ buildId: 'b-9', state: 'failed', failedStage: 'test' })] });
    renderAt('/activity');
    const deployLink = await screen.findByRole('link', { name: /web.*Deployed/ });
    expect(deployLink).toHaveAttribute('href', '/deploys/d-9');
    const buildLink = screen.getByRole('link', { name: /blog.*Build failed at test/ });
    expect(buildLink).toHaveAttribute('href', '/builds/b-9');
  });

  it('shows no build rows and no Builds chip when nothing builds with Shipyard', async () => {
    setup({ timeline: page([deploy()]) });
    renderAt('/activity');
    await screen.findByText('Deployed');
    expect(screen.queryByRole('button', { name: 'Builds' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deploys' })).toBeInTheDocument();
  });

  it('folds a rollout into one expandable row that lists its deploys in order', async () => {
    const member = (n: number, app: string, over: Partial<TimelineItem> = {}) =>
      deploy({
        deployId: `r-${String(n)}`,
        app,
        requesterLabel: `Matt (console) · roll all ${String(n)}/3`,
        createdAt: ago(20 * MIN - n * 4 * MIN),
        endedAt: ago(20 * MIN - n * 4 * MIN - 2 * MIN),
        ...over,
      });
    // Newest first, as the timeline answers.
    setup({ timeline: page([member(3, 'shipyard'), member(2, 'blog'), member(1, 'web')]) });
    const user = userEvent.setup();
    renderAt('/activity');

    const toggle = await screen.findByRole('button', { name: /Deploy all ready · 3 apps/ });
    expect(toggle).toHaveTextContent('all deployed');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // One row at the top level: the members are hidden until it opens.
    expect(screen.queryByRole('link', { name: /Deployed/ })).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const members = within(screen.getByRole('list', { name: /Deploy all ready · 3 apps deploys/ })).getAllByRole('listitem');
    expect(members.map((m) => m.textContent)).toEqual([
      expect.stringContaining('web'),
      expect.stringContaining('blog'),
      expect.stringContaining('shipyard'),
    ]);
    expect(members[0]).toHaveTextContent('1 of 3');
  });

  it('says where a rollout stopped', () => {
    const items = [
      deploy({ deployId: 'r-2', app: 'blog', state: 'failed', requesterLabel: 'Matt · roll all 2/3', createdAt: ago(5 * MIN) }),
      deploy({ deployId: 'r-1', app: 'web', requesterLabel: 'Matt · roll all 1/3', createdAt: ago(9 * MIN) }),
    ];
    const grouped = groupRollouts(items.map((item): FeedEntry => ({ type: 'deploy', key: item.deployId, at: item.createdAt, item })));
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ type: 'rollout', total: 3, requester: 'Matt' });
  });

  it('keeps two rollouts by one person apart when a position repeats', () => {
    const mk = (id: string, n: number, hoursAgo: number) =>
      deploy({ deployId: id, requesterLabel: `Matt · roll all ${String(n)}/2`, createdAt: ago(hoursAgo * HOUR) });
    const items = [mk('b2', 2, 1), mk('b1', 1, 1.1), mk('a2', 2, 30), mk('a1', 1, 30.1)];
    const grouped = groupRollouts(items.map((item): FeedEntry => ({ type: 'deploy', key: item.deployId, at: item.createdAt, item })));
    expect(grouped.map((g) => g.type)).toEqual(['rollout', 'rollout']);
  });

  it('pins Upcoming above the feed with its checks-run-again line, and a deployer cancels', async () => {
    const calls = setup({
      role: 'deployer',
      timeline: page([deploy({ deployId: 'ds-1', state: 'queued', requesterLabel: 'Matt (scheduled)', endedAt: null })]),
      schedules: { upcoming: [schedule()], past: [] },
      extra: { 'DELETE /api/schedules/s-1': { status: 200, body: schedule({ status: 'cancelled', state: 'cancelled' }) } },
    });
    const user = userEvent.setup();
    renderAt('/activity');

    const upcoming = await screen.findByRole('list', { name: 'Upcoming deploys' });
    expect(within(upcoming).getByText(/Scheduled Tomorrow .* by Matt · checks run again when it fires/)).toBeInTheDocument();
    // The scheduled deploy's own queued row is the schedule, not a second "Queued" row in the feed.
    expect(screen.queryByText('Queued')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Schedule a deploy' })).toBeInTheDocument();

    await user.click(within(upcoming).getByRole('button', { name: 'Cancel api at eeeeeee' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel deploy' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/schedules/s-1')).toBe(true);
    });
  });

  it('a viewer sees Upcoming but cannot cancel, approve or schedule', async () => {
    setup({ timeline: page([]), schedules: { upcoming: [schedule({ approval: { state: 'awaiting', by: null, at: null } })], past: [] } });
    renderAt('/activity');
    expect(await screen.findByText('Awaiting approval')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Cancel / })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Approve / })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Schedule a deploy' })).not.toBeInTheDocument();
  });

  it('shows a refused schedule as its own row with the check and the reason', async () => {
    setup({
      timeline: page([deploy({ deployId: 'ds-2', app: 'web', state: 'refused', requesterLabel: 'Matt (scheduled)', createdAt: ago(2 * DAY) })]),
      schedules: {
        upcoming: [],
        past: [
          schedule({
            id: 's-2',
            deployId: 'ds-2',
            app: 'web',
            status: 'fired',
            firedAt: ago(HOUR),
            state: 'refused',
            refusal: { code: 'not_ahead_of_live', gate: 'G7', message: 'aaaaaaa is not ahead of live', fix: 'Use rollback.' },
          }),
        ],
      },
    });
    renderAt('/activity');
    expect(await screen.findByText('Refused — Ahead of live — aaaaaaa is not ahead of live')).toBeInTheDocument();
    // Once, not twice: the deploy behind the schedule is folded into it.
    expect(screen.getAllByText(/Refused —/)).toHaveLength(1);
  });
});

describe('Activity filters live in the URL', () => {
  it('?kind=build shows builds only, and asks the timeline for nothing', async () => {
    const calls = setup({ timeline: page([deploy()]), builds: [build()] });
    renderAt('/activity?kind=build');
    expect(await screen.findByText('Build passed')).toBeInTheDocument();
    expect(screen.queryByText('Deployed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Builds' })).toHaveAttribute('aria-pressed', 'true');
    expect(calls.some((c) => c.path === '/api/deploys/timeline')).toBe(false);
  });

  it('?kind=schedule shows Upcoming and past schedules, not deploys or builds', async () => {
    setup({
      timeline: page([deploy()]),
      builds: [build()],
      schedules: {
        upcoming: [schedule()],
        past: [schedule({ id: 's-3', deployId: 'ds-3', status: 'cancelled', state: 'cancelled', cancelledAt: ago(HOUR) })],
      },
    });
    renderAt('/activity?kind=schedule');
    expect(await screen.findByRole('list', { name: 'Upcoming deploys' })).toBeInTheDocument();
    expect(await screen.findByText('Scheduled deploy cancelled')).toBeInTheDocument();
    expect(screen.queryByText('Build passed')).not.toBeInTheDocument();
    expect(screen.queryByText('Deployed')).not.toBeInTheDocument();
  });

  it('reads app, outcome and requester from the address and sends them to the timeline', async () => {
    const calls = setup({ timeline: page([deploy()]) });
    renderAt('/activity?app=web&outcome=succeeded&requester=Matt');
    await screen.findByText('Deployed');
    expect(screen.getByRole('combobox', { name: 'App' })).toHaveTextContent('web');
    expect(screen.getByRole('combobox', { name: 'Outcome' })).toHaveTextContent('Succeeded');
    expect(screen.getByRole('textbox', { name: 'Requester' })).toHaveValue('Matt');
    const asked = calls.find((c) => c.path === '/api/deploys/timeline');
    expect(asked).toBeDefined();
  });

  it('a chip writes ?kind= and pressing it again clears it', async () => {
    setup({ timeline: [page([deploy()]), page([deploy()]), page([deploy()])] });
    const user = userEvent.setup();
    renderAt('/activity');
    await screen.findByText('Deployed');
    await user.click(screen.getByRole('button', { name: 'Refusals' }));
    expect(new URLSearchParams(window.location.search).get('kind')).toBe('refusal');
    expect(screen.getByRole('button', { name: 'Refusals' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Refusals' }));
    expect(window.location.search).toBe('');
  });

  it('typing a requester and pressing Enter writes it to the URL and narrows the feed', async () => {
    setup({ timeline: [page([deploy(), deploy({ deployId: 'd-2', app: 'api', requesterLabel: 'Bob (console)' })]), page([deploy({ deployId: 'd-2', app: 'api', requesterLabel: 'Bob (console)' })])] });
    const user = userEvent.setup();
    renderAt('/activity');
    await screen.findByText(/console · Matt/);
    await user.type(screen.getByRole('textbox', { name: 'Requester' }), 'Bob{Enter}');
    await waitFor(() => {
      expect(screen.queryByText(/console · Matt/)).not.toBeInTheDocument();
    });
    expect(new URLSearchParams(window.location.search).get('requester')).toBe('Bob');
  });

  it('a filtered empty feed offers Clear filters', async () => {
    setup({ timeline: [page([]), page([deploy()])] });
    const user = userEvent.setup();
    renderAt('/activity?app=web&outcome=cancelled');
    expect(await screen.findByText('Nothing matches')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await screen.findByText('Deployed');
    expect(window.location.search).toBe('');
  });

  it('says "No activity yet" when there is nothing and no filter', async () => {
    setup();
    renderAt('/activity');
    expect(await screen.findByText('No activity yet')).toBeInTheDocument();
  });

  it('loads more, appending older rows without reordering the ones already read', async () => {
    setup({ timeline: [page([deploy()], 'cursor-1'), page([deploy({ deployId: 'd-old', app: 'older', createdAt: ago(3 * DAY) })], null)] });
    const user = userEvent.setup();
    renderAt('/activity');
    await screen.findByText('Deployed');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('older')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});

describe('Activity model', () => {
  it('maps the Refusals chip to the refused outcome and the old kinds through', () => {
    expect(timelineFilters(filtersFromParams(new URLSearchParams('kind=refusal')))).toEqual({ outcome: 'refused' });
    expect(timelineFilters(filtersFromParams(new URLSearchParams('kind=rollback&app=web')))).toEqual({ app: 'web', kind: 'rollback' });
    expect(timelineFilters(filtersFromParams(new URLSearchParams('kind=nonsense&outcome=bogus')))).toEqual({});
    const outcome: TimelineOutcome = 'active';
    expect(timelineFilters(filtersFromParams(new URLSearchParams(`outcome=${outcome}`)))).toEqual({ outcome });
  });

  it('words a deploy, a refusal and a build in the console vocabulary', () => {
    expect(deployHeadline({ kind: 'deploy', state: 'succeeded', refusalCode: null })).toBe('Deployed');
    expect(deployHeadline({ kind: 'rollback', state: 'succeeded', refusalCode: null })).toBe('Rolled back');
    expect(deployHeadline({ kind: 'deploy', state: 'soaking', refusalCode: null })).toBe('Soaking');
    expect(deployHeadline({ kind: 'deploy', state: 'awaiting_approval', refusalCode: null })).toBe('Waiting for approval');
    expect(refusalLine('G5', 'CI has not passed', 'ci_not_green')).toBe('Refused — CI passed — CI has not passed');
    expect(refusalLine(null, null, 'app_frozen')).toBe('Refused — app frozen');
    expect(buildHeadline({ state: 'failed', failedStage: 'integration' })).toBe('Build failed at integration');
    expect(buildHeadline({ state: 'succeeded', failedStage: null })).toBe('Build passed');
  });

  it('writes times the way the design says: relative this week, absolute after, no seconds', () => {
    expect(formatFeedTime(ago(12 * MIN), NOW)).toBe('12m ago');
    expect(formatFeedTime(ago(3 * HOUR), NOW)).toBe('3h ago');
    expect(formatFeedTime(new Date(2026, 9, 5, 11, 57).toISOString(), NOW)).toBe('Yesterday 11:57 AM');
    expect(formatFeedTime(new Date(2026, 9, 2, 11, 57).toISOString(), NOW)).toBe('Fri 11:57 AM');
    expect(formatFeedTime(new Date(2026, 8, 20, 11, 57).toISOString(), NOW)).toBe('Sep 20, 11:57 AM');
    expect(formatDue(new Date(2026, 9, 8, 9, 0).toISOString(), NOW)).toBe('Thu 9:00 AM');
    expect(dayLabel(new Date(2026, 9, 6, 1).toISOString(), NOW)).toBe('Today');
    expect(dayLabel(new Date(2026, 9, 5, 23).toISOString(), NOW)).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 9, 4, 9).toISOString(), NOW)).toBe('Oct 4');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(352_000)).toBe('5m 52s');
    expect(formatDuration(3_720_000)).toBe('1h 2m');
  });

  it('groups a rollout by the id and positions the server sends, even without the label suffix', () => {
    const at = (min: number) => new Date(Date.UTC(2026, 9, 6, 12, min)).toISOString();
    const member = (id: string, pos: number, min: number) =>
      ({ type: 'deploy', key: id, at: at(min), item: { deployId: id, kind: 'deploy', app: `app${String(pos)}`, sha: 'a'.repeat(40), dryRun: false, state: 'succeeded', requesterLabel: 'Matt (console)', createdAt: at(min), endedAt: at(min + 1), refusalCode: null, rolloutId: 'r1', rolloutPosition: pos } }) as const;
    const grouped = groupRollouts([member('d2', 1, 10), member('d1', 0, 5)] as never);
    expect(grouped).toHaveLength(1);
    const only = grouped[0] as { type: string; members: { position: number }[]; total: number; rolloutId: string | null };
    expect(only.type).toBe('rollout');
    expect(only.rolloutId).toBe('r1');
    expect(only.members.map((m) => m.position)).toEqual([1, 2]);
    expect(only.total).toBe(2);
  });
});
