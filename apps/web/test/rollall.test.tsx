import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { DeployTargetState, RolloutStatus } from '@shipyard/schema';
import { App } from '../src/App';
import type { AppStatus } from '../src/lib/appstatus';
import type { HomeApp } from '../src/lib/home';
import { rolloutCandidates } from '../src/lib/rollouts';
import { RolloutProgressView } from '../src/screens/RolloutProgress';
import { meReply, mockFetch } from './fetch';

/**
 * SHP-T-12.2 (SHP-REQ-154): Roll all on Home. The button appears for a deployer once two or more
 * apps are ready to ship; the sheet shows the order the server plans (Shipyard last) and starts
 * exactly that; the rollout screen follows each app in turn and says where a stopped one stopped.
 */

const SHA_LIVE = 'a'.repeat(40);
const SHA_GREEN = 'b'.repeat(40);

function appRow(name: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name,
    repo: `matdemers1/${name}`,
    liveSha: SHA_LIVE,
    reportedAt: new Date().toISOString(),
    drift: null,
    approvalPolicy: null,
    frozen: false,
    active: null,
    ...overrides,
  };
}

function ready() {
  return {
    status: 200,
    body: {
      live: SHA_LIVE,
      head: SHA_GREEN,
      newestGreen: SHA_GREEN,
      source: 'github' as const,
      commits: [{ sha: SHA_GREEN, message: 'ship it', ci: 'success' as const, taskIds: [] }],
    },
  };
}

function upToDate() {
  return { status: 200, body: { live: SHA_LIVE, head: SHA_LIVE, commits: [], newestGreen: null, source: 'github' as const } };
}

function member(app: string, position: number, state: DeployTargetState, extra: Partial<RolloutStatus['members'][number]> = {}) {
  return {
    deployId: `d-${app}`,
    kind: 'deploy' as const,
    app,
    sha: SHA_GREEN,
    dryRun: false,
    state,
    currentStep: null,
    requester: { label: `Matt (console) · roll all ${String(position + 1)}/3`, repo: null, branch: null },
    images: [],
    schemaRevision: null,
    refusal: null,
    gates: [],
    createdAt: new Date().toISOString(),
    endedAt: null,
    position,
    self: app === 'shipyard',
    ...extra,
  };
}

function homeRoutes(role: 'deployer' | 'viewer' = 'deployer') {
  return {
    'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: false } },
    'GET /api/auth/me': meReply(role),
    'GET /api/agent': { status: 200, body: [{ id: 'a1', confirmed: true, lastHeartbeatAt: new Date().toISOString(), stale: false }] },
    'GET /api/deploys': { status: 200, body: [] },
    'GET /api/groups': { status: 200, body: [] },
    'GET /api/approvals': { status: 200, body: [] },
    'GET /api/apps': {
      status: 200,
      body: { apps: [appRow('shipyard'), appRow('web'), appRow('api'), appRow('billing'), appRow('frozen-app', { frozen: true })] },
    },
    'GET /api/apps/shipyard/commits': ready(),
    'GET /api/apps/web/commits': ready(),
    'GET /api/apps/api/commits': ready(),
    'GET /api/apps/billing/commits': upToDate(),
    'GET /api/apps/frozen-app/commits': ready(),
  };
}

describe('rolloutCandidates', () => {
  const status = (kind: AppStatus['kind'], shipSha: string | null): AppStatus => ({
    kind,
    tone: 'neutral',
    label: '',
    headline: '',
    detail: '',
    shipSha,
  });
  const app = (name: string, frozen = false) => ({ name, frozen }) as HomeApp;

  it('takes only ready, unfrozen apps, at the SHA their card would ship', () => {
    expect(
      rolloutCandidates([
        { app: app('a'), status: status('ready', SHA_GREEN) },
        { app: app('b'), status: status('deploying', SHA_GREEN) },
        { app: app('c'), status: status('up-to-date', null) },
        { app: app('d', true), status: status('ready', SHA_GREEN) },
        { app: app('e'), status: status('approval', SHA_GREEN) },
        { app: app('f'), status: status('ready', SHA_LIVE) },
      ]),
    ).toEqual([
      { app: 'a', sha: SHA_GREEN },
      { app: 'f', sha: SHA_LIVE },
    ]);
  });
});

describe('Roll all on Home', () => {
  it('offers Roll all for the ready apps, shows the server’s order with Shipyard last, starts it and follows it', async () => {
    const calls = mockFetch({
      ...homeRoutes(),
      'POST /api/rollouts/plan': {
        status: 200,
        body: {
          members: [
            { app: 'api', sha: SHA_GREEN, liveSha: SHA_LIVE, self: false },
            { app: 'web', sha: SHA_GREEN, liveSha: SHA_LIVE, self: false },
            { app: 'shipyard', sha: SHA_GREEN, liveSha: SHA_LIVE, self: true },
          ],
        },
      },
      'POST /api/rollouts': { status: 201, body: { rolloutId: 'r1', deployIds: ['d-api', 'd-web', 'd-shipyard'] } },
      'GET /api/rollouts/r1': {
        status: 200,
        body: {
          rolloutId: 'r1',
          requesterLabel: 'Matt (console)',
          createdAt: new Date().toISOString(),
          state: 'soaking',
          members: [
            member('api', 0, 'succeeded'),
            member('web', 1, 'soaking', { currentStep: 'soak' }),
            member('shipyard', 2, 'locked'),
          ],
        },
      },
    });
    window.history.replaceState(null, '', '/');
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Home' });

    // Three ready apps — the frozen one and the up-to-date one are left out.
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Roll all 3' }));

    const plan = await screen.findByRole('list', { name: 'Apps to roll, in order' });
    const rows = within(plan).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('1. api'),
      expect.stringContaining('2. web'),
      expect.stringContaining('3. shipyard'),
    ]);
    expect(rows[2]).toHaveTextContent('Shipyard · last');
    expect(rows[0]).toHaveTextContent(`${SHA_LIVE.slice(0, 7)} → ${SHA_GREEN.slice(0, 7)}`);
    expect(screen.getByText(/Shipyard updates itself last/)).toBeInTheDocument();

    const planned = calls.find((c) => c.method === 'POST' && c.path === '/api/rollouts/plan');
    expect((planned?.body as { items: { app: string }[] }).items.map((i) => i.app).sort()).toEqual(['api', 'shipyard', 'web']);

    await user.click(screen.getByRole('button', { name: 'Roll all' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/rollouts')).toBe(true);
    });
    // It starts exactly what the sheet showed, in that order.
    const started = calls.find((c) => c.method === 'POST' && c.path === '/api/rollouts');
    expect(started?.body).toEqual({
      items: [
        { app: 'api', sha: SHA_GREEN },
        { app: 'web', sha: SHA_GREEN },
        { app: 'shipyard', sha: SHA_GREEN },
      ],
    });

    await screen.findByRole('heading', { level: 1, name: 'Roll all' });
    const progress = await screen.findByRole('list', { name: 'Apps in this rollout, in order' });
    const items = within(progress).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Succeeded');
    expect(items[1]).toHaveTextContent('Soaking');
    expect(items[2]).toHaveTextContent('Waiting its turn');
    expect(screen.getByText(/Shipyard goes last/)).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByRole('link', { name: '2. web' })).toHaveAttribute('href', '/deploys/d-web/live');
    expect(screen.getByText(/1 of 3 done/)).toBeInTheDocument();
  });

  it('shows the plan’s refusal and keeps Roll all disabled', async () => {
    mockFetch({
      ...homeRoutes(),
      'POST /api/rollouts/plan': {
        status: 409,
        body: { error: { code: 'locked', gate: 'G4', message: 'web is being deployed by someone else.', fix: 'Wait for it to finish.' } },
      },
    });
    window.history.replaceState(null, '', '/');
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Roll all 3' }));
    expect(await screen.findByText('web is being deployed by someone else.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Roll all' })).toBeDisabled();
  });

  it('is not offered with fewer than two ready apps', async () => {
    mockFetch({ ...homeRoutes(), 'GET /api/apps/web/commits': upToDate(), 'GET /api/apps/api/commits': upToDate() });
    window.history.replaceState(null, '', '/');
    render(<App />);
    // Only shipyard is ready: the frozen app reads Frozen and offers no Ship (SHP-DA-011).
    expect(await screen.findAllByRole('button', { name: `Ship ${SHA_GREEN.slice(0, 7)}` })).toHaveLength(1);
    expect(screen.getAllByText('Frozen').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^Roll all/ })).not.toBeInTheDocument();
  });

  it('is not offered to a viewer', async () => {
    mockFetch(homeRoutes('viewer'));
    window.history.replaceState(null, '', '/');
    render(<App />);
    await screen.findByRole('link', { name: 'web' });
    expect(screen.queryByRole('button', { name: /^Roll all/ })).not.toBeInTheDocument();
  });
});

describe('Rollout screen', () => {
  it('names the app that stopped the rollout and the apps it left untouched', async () => {
    mockFetch({
      'GET /api/rollouts/r2': {
        status: 200,
        body: {
          rolloutId: 'r2',
          requesterLabel: 'Matt (console)',
          createdAt: new Date().toISOString(),
          state: 'rolled_back',
          members: [
            member('api', 0, 'succeeded'),
            member('web', 1, 'rolled_back', {
              refusal: { code: 'health_failed', gate: 'none', message: 'web failed its health check.', fix: 'Check the logs.' },
            }),
            member('shipyard', 2, 'cancelled', {
              refusal: { code: 'rollout_stopped', gate: 'none', message: 'The rollout stopped at web.', fix: 'Roll again.' },
            }),
          ],
        },
      },
    });
    render(
      <MemoryRouter initialEntries={['/rollouts/r2']}>
        <Routes>
          <Route path="/rollouts/:id" element={<RolloutProgressView id="r2" />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('The rollout stopped at web: rolled back')).toBeInTheDocument();
    expect(screen.getByText(/web failed its health check\./)).toBeInTheDocument();
    expect(screen.getByText(/Not touched: shipyard\./)).toBeInTheDocument();
    const items = within(screen.getByRole('list', { name: 'Apps in this rollout, in order' })).getAllByRole('listitem');
    expect(items[2]).toHaveTextContent('Not started');
    // A finished app links to its record, not its live page.
    expect(within(items[1] as HTMLElement).getByRole('link', { name: '2. web' })).toHaveAttribute('href', '/deploys/d-web');
  });

  it('says so when every app rolled', async () => {
    mockFetch({
      'GET /api/rollouts/r3': {
        status: 200,
        body: {
          rolloutId: 'r3',
          requesterLabel: 'Matt (console)',
          createdAt: new Date().toISOString(),
          state: 'succeeded',
          members: [member('api', 0, 'succeeded'), member('shipyard', 1, 'succeeded')],
        },
      },
    });
    render(
      <MemoryRouter>
        <RolloutProgressView id="r3" />
      </MemoryRouter>,
    );
    expect(await screen.findByText('All 2 apps rolled')).toBeInTheDocument();
  });

  it('the first app waits for the agent, the rest wait their turn', async () => {
    mockFetch({
      'GET /api/rollouts/r4': {
        status: 200,
        body: {
          rolloutId: 'r4',
          requesterLabel: 'Matt (console)',
          createdAt: new Date().toISOString(),
          state: 'locked',
          members: [member('api', 0, 'locked'), member('web', 1, 'locked')],
        },
      },
    });
    render(
      <MemoryRouter>
        <RolloutProgressView id="r4" />
      </MemoryRouter>,
    );
    const list = await screen.findByRole('list', { name: 'Apps in this rollout, in order' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Waiting for the agent');
    expect(items[1]).toHaveTextContent('Waiting its turn');
    // No Shipyard in this rollout, so nothing says it goes last.
    expect(screen.queryByText(/Shipyard goes last/)).not.toBeInTheDocument();
  });
});
