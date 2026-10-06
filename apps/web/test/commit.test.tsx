import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { SheetAction } from '../src/components/DryRunSheet';
import type { AppDetail } from '../src/lib/appdetail';
import { imageVerification, timeline, type RunJob } from '../src/lib/commit';
import { meReply, mockFetch, type Reply } from './fetch';

/**
 * The commit page (SHP-T-13.9, SHP-REQ-156/157/158): the six-stage lane, the run's jobs with a
 * timeline bar, what deploys with the commit, and its images — Expected until a dry run or deploy
 * has verified the digests. A red commit leads with the verdict and offers no Deploy.
 */

// The sheet is another task's; here it only has to be opened with the right action.
const opened: (SheetAction | null)[] = [];
vi.mock('../src/components/DryRunSheet', () => ({
  DryRunSheet: ({ open, action }: { open: boolean; action: SheetAction | null }) => {
    if (open) opened.push(action);
    return open && action !== null ? <div role="dialog" aria-label={`sheet ${action.kind} ${action.sha}`} /> : null;
  },
}));

const sha = (c: string): string => c.repeat(40);
const T0 = Date.parse('2026-10-06T10:00:00.000Z');
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

function detail(overrides: Partial<AppDetail> = {}): AppDetail {
  return {
    name: 'bindery',
    repo: 'matdemers1/bindery',
    defaultBranch: 'main',
    liveSha: sha('f'),
    liveDeployId: 'd-f',
    liveEndedAt: at(-86_400),
    schemaRevision: null,
    digests: { api: `sha256:${'f'.repeat(64)}` },
    running: null,
    drift: null,
    reportedAt: at(-60),
    soakSeconds: 30,
    approvalPolicy: 'none',
    canary: false,
    group: null,
    manifest: {
      name: 'bindery',
      workflow: 'ci.yml',
      services: {
        api: { image: 'ghcr.io/matdemers1/bindery/api' },
        worker: { image: 'ghcr.io/matdemers1/bindery/worker' },
      },
    },
    active: null,
    rollbackTargets: [],
    needsRestore: [],
    targets: [],
    ...overrides,
  };
}

function entry(c: string, message: string, ci: 'success' | 'failure' | 'pending' | 'none', runId?: number) {
  return {
    sha: sha(c),
    message,
    ci,
    taskIds: [],
    run:
      runId === undefined
        ? null
        : { id: runId, url: `https://github.com/matdemers1/bindery/actions/runs/${String(runId)}`, startedAt: at(0), completedAt: ci === 'pending' ? null : at(848), conclusion: ci === 'success' ? 'success' : null },
  };
}

/** Oldest first, as the server sends them: a red rider, a green rider, this commit, a newer one still building. */
function commitsInfo(overrides: Record<string, unknown> = {}) {
  return {
    live: sha('f'),
    head: sha('d'),
    ahead: 4,
    newestGreen: sha('c'),
    source: 'github',
    buildSource: 'github',
    commits: [
      entry('a', 'Rename ingest queue', 'failure', 409),
      entry('b', 'Tidy scanner config', 'success', 410),
      entry('c', 'Scanner ingest retries', 'success', 412),
      entry('d', 'Bump pdf.js', 'pending', 413),
    ],
    ...overrides,
  };
}

function job(id: number, name: string, state: RunJob['state'], from: number | null, to: number | null): RunJob {
  return {
    id,
    name,
    state,
    startedAt: from === null ? null : at(from),
    completedAt: to === null ? null : at(to),
    durationMs: from === null || to === null ? null : (to - from) * 1000,
    url: `https://github.com/matdemers1/bindery/actions/runs/412/job/${String(id)}`,
  };
}

const GREEN_JOBS = {
  run: { id: 412, url: 'https://github.com/matdemers1/bindery/actions/runs/412', status: 'completed', conclusion: 'success', startedAt: at(0), completedAt: at(848) },
  jobs: [job(1, 'lint', 'success', 0, 48), job(2, 'unit', 'success', 5, 128), job(3, 'build', 'success', 130, 700), job(4, 'e2e', 'success', 300, 840)],
};

const RIDER_JOBS = {
  run: { id: 409, url: 'https://github.com/matdemers1/bindery/actions/runs/409', status: 'completed', conclusion: 'failure', startedAt: at(0), completedAt: at(300) },
  jobs: [job(5, 'e2e', 'failure', 10, 290)],
};

const UNREACHABLE: Reply = {
  status: 503,
  body: { error: { code: 'github_unreachable', gate: 'none', message: 'GitHub did not answer.', fix: 'Try again in a minute.' } },
};

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(<App />);
}

function routes(role: 'deployer' | 'viewer', extra: Record<string, Reply | Reply[]> = {}, body: AppDetail = detail(), info: unknown = commitsInfo()) {
  return mockFetch({
    'GET /api/auth/me': meReply(role),
    'GET /api/apps/bindery': { status: 200, body },
    'GET /api/apps/bindery/commits': { status: 200, body: info },
    'GET /api/apps/bindery/freeze': { status: 200, body: { freeze: null } },
    'GET /api/approvals': { status: 200, body: [] },
    [`GET /api/apps/bindery/commits/${sha('c')}/run`]: { status: 200, body: GREEN_JOBS },
    [`GET /api/apps/bindery/commits/${sha('a')}/run`]: { status: 200, body: RIDER_JOBS },
    ...extra,
  });
}

const LANE_TIMEOUT = { timeout: 4000 };

describe('a green commit', () => {
  it('shows the lane, the jobs with durations and bars, the run link, expected images and what deploys with it', async () => {
    routes('deployer');
    renderAt(`/apps/bindery/commits/${sha('c')}`);

    expect(await screen.findByRole('heading', { level: 1, name: 'Scanner ingest retries' }, LANE_TIMEOUT)).toBeInTheDocument();
    // The deploy page's markup, so one rule in one block draws one separator per gap.
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(nav.className).toBe('');
    const crumbList = nav.querySelector('ol.shp-crumbs');
    expect(crumbList).not.toBeNull();
    expect(within(crumbList as HTMLElement).getAllByRole('listitem')).toHaveLength(3);
    expect(nav.querySelectorAll('.shp-crumbs')).toHaveLength(1);
    const crumbs = within(nav);
    expect(crumbs.getByRole('link', { name: 'bindery' })).toHaveAttribute('href', '/apps/bindery');
    expect(crumbs.getByText('ccccccc')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View on GitHub ↗' })).toHaveAttribute('href', `https://github.com/matdemers1/bindery/commit/${sha('c')}`);

    // The six-stage lane.
    const lane = screen.getByRole('list', { name: `Journey of ${'c'.repeat(7)}` });
    expect(within(lane).getAllByRole('listitem').map((li) => li.getAttribute('data-stage'))).toEqual(['push', 'ci', 'images', 'checks', 'deploy', 'live']);
    expect(screen.getByText(/ahead of live/)).toHaveTextContent('Push to live — 3 commits ahead of live');

    // Jobs: name, duration, a bar on the timeline, linked to the job.
    const jobs = await screen.findByRole('list', { name: 'Jobs' });
    const rows = within(jobs).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: 'lint 48s' })).toHaveAttribute('href', 'https://github.com/matdemers1/bindery/actions/runs/412/job/1');
    expect(within(rows[0] as HTMLElement).getByText('48s')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('2m 03s')).toBeInTheDocument();
    const bar = within(rows[2] as HTMLElement).getByRole('img');
    // The bar sits inside the job's link, so it is linked to the job on GitHub.
    expect(bar.closest('a')).toHaveAttribute('href', 'https://github.com/matdemers1/bindery/actions/runs/412/job/3');
    expect(bar).toHaveAccessibleName(/^build: 9m 30s, passed, from 2m 10s into the run$/);
    expect(bar.style.left).not.toBe('');
    expect(screen.getByText('CI · run #412')).toBeInTheDocument();
    expect(screen.getByText(/Passed in 14m 08s · ci\.yml · push to main/)).toBeInTheDocument();
    expect(screen.getByText(/4 jobs/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open run on GitHub ↗' })).toHaveAttribute('href', 'https://github.com/matdemers1/bindery/actions/runs/412');
    expect(screen.getByText(/Shipyard never polls jobs/)).toBeInTheDocument();

    // Images are Expected, not Verified.
    const images = screen.getByRole('list', { name: 'Images' });
    expect(within(images).getByText('ghcr.io/matdemers1/bindery/api:sha-ccccccc')).toBeInTheDocument();
    expect(within(images).getAllByText('Expected · digest not yet verified')).toHaveLength(2);
    expect(screen.getByText(/^Expected — api · worker — Expected from green CI; verified on deploy\./)).toBeInTheDocument();
    expect(screen.queryByText(/^Verified/)).not.toBeInTheDocument();

    // What deploys with it, the red rider flagged, the newer commit not included.
    const riders = await screen.findByRole('list', { name: 'Commits that deploy with this one' });
    const riderRows = within(riders).getAllByRole('listitem');
    expect(riderRows).toHaveLength(2);
    expect(riderRows[0]).toHaveTextContent('Tidy scanner config');
    expect(riderRows[0]).toHaveTextContent('CI passed');
    expect(riderRows[1]).toHaveTextContent('Rename ingest queue');
    expect(riderRows[1]).toHaveTextContent('CI failed · run #409');
    expect(riderRows[1]).toHaveTextContent('Rides along with ccccccc.');
    expect(within(riderRows[1] as HTMLElement).getByRole('link', { name: 'run #409 ↗' })).toHaveAttribute('href', 'https://github.com/matdemers1/bindery/actions/runs/409');
    expect(screen.getByText(/everything between live fffffff and this commit deploys together/)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Not included' })).toHaveTextContent('Not included: ddddddd “Bump pdf.js” — newer, CI running');
  });

  it('offers Deploy to a deployer only for the newest green commit, and opens the sheet with it', async () => {
    routes('deployer');
    const user = userEvent.setup();
    renderAt(`/apps/bindery/commits/${sha('c')}`);
    await user.click(await screen.findByRole('button', { name: 'Deploy ccccccc' }, LANE_TIMEOUT));
    expect(opened.at(-1)).toEqual({ kind: 'deploy', app: 'bindery', sha: sha('c') });
  });

  it('shows a viewer no Deploy, and a green commit that is not the newest green none either', async () => {
    routes('viewer');
    renderAt(`/apps/bindery/commits/${sha('c')}`);
    await screen.findByRole('heading', { level: 1, name: 'Scanner ingest retries' }, LANE_TIMEOUT);
    expect(screen.queryByRole('button', { name: /^Deploy / })).not.toBeInTheDocument();

    routes('deployer', { [`GET /api/apps/bindery/commits/${sha('b')}/run`]: { status: 200, body: { run: null, jobs: [] } } });
    renderAt(`/apps/bindery/commits/${sha('b')}`);
    await screen.findByRole('heading', { level: 1, name: 'Tidy scanner config' }, LANE_TIMEOUT);
    expect(screen.queryByRole('button', { name: /^Deploy / })).not.toBeInTheDocument();
  });
});

describe('images (SHP-REQ-158)', () => {
  it('reads Verified, with the digest, once a deploy of this commit recorded them', async () => {
    const verified = detail({
      targets: [
        {
          id: 't1',
          deployId: 'd1',
          kind: 'deploy',
          sha: sha('c'),
          dryRun: true,
          requester: 'matt',
          state: 'succeeded',
          currentStep: null,
          createdAt: at(10),
          startedAt: at(10),
          endedAt: at(60),
        },
      ],
      rollbackTargets: [
        {
          deployId: 'd1',
          targetId: 't1',
          kind: 'deploy',
          sha: sha('c'),
          requester: 'matt',
          endedAt: at(60),
          images: [{ service: 'api', sha: sha('c'), digest: `sha256:${'c'.repeat(64)}`, migration: null }],
        },
      ],
    });
    routes('deployer', {}, verified);
    renderAt(`/apps/bindery/commits/${sha('c')}`);
    await screen.findByRole('heading', { level: 1, name: 'Scanner ingest retries' }, LANE_TIMEOUT);
    expect(screen.getByText(/^Verified — api · worker — Verified by a dry run\./)).toBeInTheDocument();
    const images = screen.getByRole('list', { name: 'Images' });
    expect(within(images).getAllByText(/^Verified/)).toHaveLength(2);
    expect(within(images).getByText(/sha256:cccccccccccc/)).toBeInTheDocument();
    expect(screen.queryByText('Expected · digest not yet verified')).not.toBeInTheDocument();
  });

  it('says when a dry run verified the images if it kept no digest to show', async () => {
    const dryRunOnly = detail({
      targets: [
        {
          id: 't1',
          deployId: 'd1',
          kind: 'deploy',
          sha: sha('c'),
          dryRun: true,
          requester: 'matt',
          state: 'succeeded',
          currentStep: null,
          createdAt: at(10),
          startedAt: at(10),
          endedAt: at(60),
        },
      ],
    });
    routes('deployer', {}, dryRunOnly);
    renderAt(`/apps/bindery/commits/${sha('c')}`);
    await screen.findByRole('heading', { level: 1, name: 'Scanner ingest retries' }, LANE_TIMEOUT);
    const images = screen.getByRole('list', { name: 'Images' });
    expect(within(images).getAllByText(/^Verified on dry run /)).toHaveLength(2);
    expect(within(images).queryByText(/sha256:/)).not.toBeInTheDocument();
  });

  it('decides verification from the live release, a dry run, or a deploy past its verify step', () => {
    const target = (state: string, dryRun: boolean) => ({
      id: 't',
      deployId: 'd',
      kind: 'deploy',
      sha: sha('c'),
      dryRun,
      requester: 'm',
      state,
      currentStep: null,
      createdAt: at(0),
      startedAt: null,
      endedAt: null,
    });
    expect(imageVerification(detail(), sha('c')).verified).toBe(false);
    expect(imageVerification(detail({ targets: [target('refused', true)] }), sha('c')).verified).toBe(false);
    expect(imageVerification(detail({ targets: [target('verifying', false)] }), sha('c')).verified).toBe(false);
    expect(imageVerification(detail({ targets: [target('succeeded', true)] }), sha('c')).verified).toBe(true);
    expect(imageVerification(detail({ targets: [target('soaking', false)] }), sha('c')).verified).toBe(true);
    expect(imageVerification(detail(), sha('f')).verified).toBe(true);
  });
});

describe('a failed run', () => {
  const red = commitsInfo({
    newestGreen: null,
    ahead: 1,
    commits: [entry('e', 'Break the unit suite', 'failure', 233)],
  });
  const failedRun = {
    run: { id: 233, url: 'https://github.com/matdemers1/bindery/actions/runs/233', status: 'completed', conclusion: 'failure', startedAt: at(0), completedAt: at(250) },
    jobs: [
      job(11, 'lint', 'success', 0, 40),
      { ...job(12, 'unit', 'failure', 5, 195), url: 'https://github.com/matdemers1/bindery/actions/runs/233/job/12' },
      { ...job(13, 'e2e', 'skipped', null, null), url: null },
    ],
  };

  it('leads with the verdict, names the failing job and links out, and offers no Deploy', async () => {
    routes('deployer', { [`GET /api/apps/bindery/commits/${sha('e')}/run`]: { status: 200, body: failedRun } }, detail(), red);
    renderAt(`/apps/bindery/commits/${sha('e')}`);

    expect(await screen.findByText('CI failed at unit — there is nothing to deploy from this commit', {}, LANE_TIMEOUT)).toBeInTheDocument();
    expect(screen.getByText(/Live fffffff is unaffected\. Push a fix to main and Shipyard will pick it up\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Deploy / })).not.toBeInTheDocument();

    expect(screen.getByText('Failed at unit · 3m 10s')).toBeInTheDocument();
    const fullLog = screen.getByRole('link', { name: 'Full log on GitHub ↗' });
    expect(fullLog).toHaveAttribute('href', 'https://github.com/matdemers1/bindery/actions/runs/233/job/12');
    expect(screen.getAllByRole('link', { name: 'Open run #233 ↗' }).length).toBeGreaterThan(0);

    const jobs = screen.getByRole('list', { name: 'Jobs' });
    const rows = within(jobs).getAllByRole('listitem');
    expect(rows[1]).toHaveTextContent('Failed');
    expect(rows[2]).toHaveTextContent('Skipped — unit failed');
    expect(within(rows[2] as HTMLElement).queryByRole('img')).not.toBeInTheDocument();

    // The lane says what will not happen, and the images were never built.
    const lane = screen.getByRole('list', { name: `Journey of ${'e'.repeat(7)}` });
    expect(lane).toHaveTextContent('Not built');
    expect(lane).toHaveTextContent('Blocked by CI');
    expect(screen.getByText(/^Not built — Nothing was pushed to GHCR\./)).toBeInTheDocument();
    expect(screen.queryByText(/Deploys with it/)).not.toBeInTheDocument();
  });

  it('makes exactly one run call however many red commits ride along', async () => {
    const many = commitsInfo({
      ahead: 10,
      newestGreen: sha('c'),
      commits: [
        ...['1', '2', '3', '4', '5', '6', '7', '8'].map((c) => entry(c, `Red ${c}`, 'failure', 300 + Number(c))),
        entry('c', 'Scanner ingest retries', 'success', 412),
      ],
    });
    const calls = routes('deployer', {}, detail(), many);
    renderAt(`/apps/bindery/commits/${sha('c')}`);
    const riders = await screen.findByRole('list', { name: 'Commits that deploy with this one' }, LANE_TIMEOUT);
    expect(within(riders).getAllByText('Rides along with ccccccc.', { exact: false })).toHaveLength(8);
    expect(await screen.findByRole('list', { name: 'Jobs' })).toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith('/run'))).toHaveLength(1);
  });
});

describe('when GitHub cannot be reached for the run', () => {
  it('shows the refusal and its fix, keeps the lane and the commits that deploy with it, and retries', async () => {
    const calls = routes('deployer', { [`GET /api/apps/bindery/commits/${sha('c')}/run`]: [UNREACHABLE, { status: 200, body: GREEN_JOBS }] });
    const user = userEvent.setup();
    renderAt(`/apps/bindery/commits/${sha('c')}`);
    expect(await screen.findByText('GitHub did not answer.', {}, LANE_TIMEOUT)).toBeInTheDocument();
    expect(screen.getByText(/Try again in a minute\./)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: `Journey of ${'c'.repeat(7)}` })).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Commits that deploy with this one' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Jobs' })).toBeInTheDocument();
    expect(calls.filter((c) => c.path === `/api/apps/bindery/commits/${sha('c')}/run`)).toHaveLength(2);
  });
});

describe('a build: shipyard app', () => {
  it('makes no GitHub jobs call and points at the Shipyard build', async () => {
    const built = commitsInfo({
      buildSource: 'shipyard',
      commits: [{ sha: sha('c'), message: 'Scanner ingest retries', ci: 'success', taskIds: [], buildId: 'b-9', run: null }],
      ahead: 1,
    });
    const calls = routes('deployer', {}, detail(), built);
    renderAt(`/apps/bindery/commits/${sha('c')}`);
    await screen.findByRole('heading', { level: 1, name: 'Scanner ingest retries' }, LANE_TIMEOUT);
    expect(screen.getByRole('link', { name: 'Open the build' })).toHaveAttribute('href', '/builds/b-9');
    expect(screen.getByText(/there are no GitHub Actions jobs to list/)).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/run'))).toBe(false);
  });
});

describe('other commits', () => {
  it('explains that an unknown commit is not waiting and links back to the app, without asking GitHub', async () => {
    const calls = routes('deployer');
    renderAt(`/apps/bindery/commits/${sha('9')}`);
    expect(await screen.findByText('This commit is not waiting', {}, LANE_TIMEOUT)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to bindery' })).toHaveAttribute('href', '/apps/bindery');
    expect(calls.some((c) => c.path.endsWith('/run'))).toBe(false);
  });

  it('does not call the server for something that is not a full SHA', async () => {
    const calls = routes('deployer');
    renderAt('/apps/bindery/commits/not-a-sha');
    expect(await screen.findByText('This commit is not waiting', {}, LANE_TIMEOUT)).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith('/api/apps/bindery'))).toBe(false);
  });

  it('opens the live commit as done end to end, without asking GitHub for its run', async () => {
    const calls = routes('deployer');
    renderAt(`/apps/bindery/commits/${sha('f')}`);
    // The skeleton has the same heading; the run section only exists once the page has loaded.
    expect(await screen.findByText(/This commit is live, so Shipyard does not ask GitHub for its run/, {}, LANE_TIMEOUT)).toBeInTheDocument();
    expect(screen.getAllByText('Live').length).toBeGreaterThan(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Commit fffffff' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: `Journey of ${'f'.repeat(7)}` })).toHaveTextContent('fffffff is live');
    expect(screen.queryByRole('button', { name: /^Deploy / })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/run'))).toBe(false);
  });

  it('makes no run call when the commits could not be read', async () => {
    const calls = routes('deployer', {}, detail(), commitsInfo({ source: 'unavailable', commits: [] }));
    renderAt(`/apps/bindery/commits/${sha('c')}`);
    expect(await screen.findByText("Shipyard could not read this app's commits", {}, LANE_TIMEOUT)).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/run'))).toBe(false);

    routes('deployer', { 'GET /api/apps/bindery/commits': { status: 500, body: { error: { code: 'internal', gate: 'none', message: 'x', fix: 'y' } } } });
    renderAt(`/apps/bindery/commits/${sha('f')}`);
    expect(await screen.findAllByText("Shipyard could not read this app's commits", {}, LANE_TIMEOUT)).not.toHaveLength(0);
  });
});

describe('the timeline', () => {
  it('positions each bar by its start and end relative to the run, and ticks the axis', () => {
    const run = { id: 1, url: null, status: 'completed', conclusion: 'success', startedAt: at(0), completedAt: at(600) };
    const t = timeline(run, [job(1, 'a', 'success', 0, 60), job(2, 'b', 'success', 300, 600), job(3, 'c', 'queued', null, null)]);
    expect(t?.totalMs).toBe(600_000);
    expect(t?.bars.get(1)).toEqual({ left: 0, width: 10 });
    expect(t?.bars.get(2)).toEqual({ left: 50, width: 50 });
    expect(t?.bars.has(3)).toBe(false);
    expect(t?.ticks.map((x) => x.label)).toEqual(['0', '5m', '10m'].slice(0, t?.ticks.length));
    expect(t?.ticks[0]?.label).toBe('0');
  });
});
