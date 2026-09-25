import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DryRunSheetProps } from '../src/components/DryRunSheet';
import type { GroupDeploySheetProps } from '../src/components/GroupDeploySheet';
import { App } from '../src/App';
import { meReply, mockFetch } from './fetch';

// Home's job is to open the sheet with the right action; the sheet has its own tests
// (dryrun.test.tsx). A stub that shows the action it was given keeps these tests about Home.
vi.mock('../src/components/DryRunSheet', () => ({
  DryRunSheet: ({ open, action }: DryRunSheetProps) =>
    open && action !== null ? <div role="dialog">{`${action.kind} ${action.app} ${action.sha}`}</div> : null,
}));

// Same idea for the group-deploy sheet: Home's job is to fetch the groups and open it with the
// right one; the sheet's own behaviour is covered by groupdeploysheet.test.tsx.
vi.mock('../src/components/GroupDeploySheet', () => ({
  GroupDeploySheet: ({ open, group }: GroupDeploySheetProps) =>
    open && group !== null ? <div role="dialog">{`deploy group ${group.name}`}</div> : null,
}));

/** S2 Home (SHP-T-3.2): the approvals banner, and one card per app with a live SHA, commits
 * waiting, lock state, last result and a deploy action (SHP-REQ-056, SHP-REQ-059, SHP-D-071). */

const SHA_LIVE = 'a'.repeat(40);
const SHA_MID = 'b'.repeat(40);
const SHA_HEAD = 'c'.repeat(40);

function appRow(name: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name,
    repo: `matdemers1/${name}`,
    liveSha: SHA_LIVE,
    reportedAt: new Date().toISOString(),
    drift: null,
    approvalPolicy: 'required',
    active: null,
    ...overrides,
  };
}

function commitsUnavailable() {
  return { live: SHA_LIVE, head: null, commits: [], newestGreen: null, source: 'unavailable' as const };
}

function commitsUpToDate() {
  return { live: SHA_LIVE, head: SHA_LIVE, commits: [], newestGreen: null, source: 'github' as const };
}

function commitsAheadPending() {
  return {
    live: SHA_LIVE,
    head: SHA_HEAD,
    newestGreen: SHA_MID,
    source: 'github' as const,
    commits: [
      { sha: SHA_MID, message: 'SHP-T-3.2: add commits endpoint', ci: 'success' as const, taskIds: ['SHP-T-3.2'] },
      { sha: SHA_HEAD, message: 'fix typo', ci: 'pending' as const, taskIds: [] },
    ],
  };
}

const AGENT_OK = [{ id: 'a1', confirmed: true, lastHeartbeatAt: new Date().toISOString(), stale: false }];

function baseRoutes() {
  return {
    'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: false } },
    'GET /api/agent': { status: 200, body: AGENT_OK },
    'GET /api/deploys': { status: 200, body: [] },
    'GET /api/groups': { status: 200, body: [] },
  };
}

describe('Home', () => {
  it('renders five cards, one per app', async () => {
    mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps': {
        status: 200,
        body: { apps: ['web', 'api', 'billing', 'worker', 'cron'].map((n) => appRow(n)) },
      },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/apps/web/commits': { status: 200, body: commitsAheadPending() },
      'GET /api/apps/api/commits': { status: 200, body: commitsUpToDate() },
      'GET /api/apps/billing/commits': { status: 200, body: commitsUpToDate() },
      'GET /api/apps/worker/commits': { status: 200, body: commitsUnavailable() },
      'GET /api/apps/cron/commits': { status: 200, body: commitsUpToDate() },
    });
    window.history.replaceState(null, '', '/');
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Home' });

    for (const name of ['web', 'api', 'billing', 'worker', 'cron']) {
      expect(await screen.findByRole('link', { name })).toBeInTheDocument();
    }
  });

  it("an app whose newest green commit is not the head ships that green SHA and opens the sheet with it", async () => {
    mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps': { status: 200, body: { apps: [appRow('web'), appRow('api')] } },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/apps/web/commits': { status: 200, body: commitsAheadPending() },
      'GET /api/apps/api/commits': { status: 200, body: commitsUpToDate() },
    });
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Home' });

    const shipButton = await screen.findByRole('button', { name: `Ship ${SHA_MID.slice(0, 7)}` });
    expect(shipButton).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Ship ${SHA_HEAD.slice(0, 7)}` })).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(shipButton);
    expect(await screen.findByRole('dialog')).toHaveTextContent('deploy web');
  });

  it('an up-to-date app has no ship action', async () => {
    mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps': { status: 200, body: { apps: [appRow('api')] } },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/apps/api/commits': { status: 200, body: commitsUpToDate() },
    });
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    await screen.findByRole('link', { name: 'api' });
    expect(screen.getByRole('button', { name: 'Up to date' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Ship /i })).not.toBeInTheDocument();
  });

  it('shows a group card with its members and canary, and a deployer can open its sheet', async () => {
    mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps': { status: 200, body: { apps: [appRow('web')] } },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/apps/web/commits': { status: 200, body: commitsUpToDate() },
      'GET /api/groups': { status: 200, body: [{ name: 'trio', canary: 'alpha', members: ['alpha', 'bravo', 'charlie'] }] },
    });
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Home' });

    const groupHeading = await screen.findByRole('heading', { name: 'trio' });
    expect(groupHeading).toBeInTheDocument();
    expect(screen.getByText('alpha · canary')).toBeInTheDocument();
    expect(screen.getByText('bravo')).toBeInTheDocument();
    expect(screen.getByText('charlie')).toBeInTheDocument();

    const deployGroup = screen.getByRole('button', { name: 'Deploy group' });
    const user = userEvent.setup();
    await user.click(deployGroup);
    expect(await screen.findByRole('dialog')).toHaveTextContent('deploy group trio');
  });

  it('hides the group deploy action from a viewer', async () => {
    mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('viewer'),
      'GET /api/apps': { status: 200, body: { apps: [] } },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/groups': { status: 200, body: [{ name: 'trio', canary: 'alpha', members: ['alpha', 'bravo', 'charlie'] }] },
    });
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    await screen.findByRole('heading', { name: 'trio' });
    expect(screen.queryByRole('button', { name: 'Deploy group' })).not.toBeInTheDocument();
  });

  it('hides every ship button from a viewer', async () => {
    mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('viewer'),
      'GET /api/apps': { status: 200, body: { apps: [appRow('web'), appRow('api')] } },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/apps/web/commits': { status: 200, body: commitsAheadPending() },
      'GET /api/apps/api/commits': { status: 200, body: commitsUpToDate() },
    });
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    await screen.findByRole('link', { name: 'web' });
    expect(screen.queryByRole('button', { name: /^Ship /i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Up to date' })).not.toBeInTheDocument();
  });

  it('shows an approvals banner with a Review button for one pending approval', async () => {
    mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps': { status: 200, body: { apps: [appRow('billing')] } },
      'GET /api/approvals': {
        status: 200,
        body: [
          {
            deployId: 'd1',
            kind: 'deploy',
            app: 'billing',
            sha: SHA_MID,
            requester: { label: 'user matthew', repo: null, branch: null },
            requestedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
      },
      'GET /api/apps/billing/commits': { status: 200, body: commitsUpToDate() },
    });
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    expect(await screen.findByText('1 deploy waiting on approval')).toBeInTheDocument();
    const review = screen.getByRole('button', { name: 'Review' });

    const user = userEvent.setup();
    await user.click(review);
    expect(await screen.findByRole('dialog')).toHaveTextContent('approve billing');
  });

  it('shows "No agent enrolled yet" with a link to /agent when there is no agent', async () => {
    mockFetch({
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: false } },
      'GET /api/agent': { status: 200, body: [] },
      'GET /api/apps': { status: 200, body: { apps: [] } },
      'GET /api/approvals': { status: 200, body: [] },
    });
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    expect(await screen.findByText('No agent enrolled yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Enrol an agent' })).toHaveAttribute('href', '/agent');
  });

  it('shows "Agent reported no apps" when a confirmed agent has reported nothing', async () => {
    mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps': { status: 200, body: { apps: [] } },
      'GET /api/approvals': { status: 200, body: [] },
    });
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    expect(await screen.findByText('Agent reported no apps')).toBeInTheDocument();
  });

  it('shows a stale-agent banner when the confirmed agent has not heartbeated recently', async () => {
    mockFetch({
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: false } },
      'GET /api/agent': { status: 200, body: [{ id: 'a1', confirmed: true, lastHeartbeatAt: null, stale: true }] },
      'GET /api/apps': { status: 200, body: { apps: [appRow('web')] } },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/apps/web/commits': { status: 200, body: commitsUpToDate() },
      'GET /api/deploys': { status: 200, body: [] },
    });
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    expect(await screen.findByText('No agent has reported recently')).toBeInTheDocument();
  });

  it('shows an error banner when the server cannot be reached', async () => {
    mockFetch({
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: false } },
      'GET /api/agent': () => {
        throw new TypeError('Failed to fetch');
      },
      'GET /api/apps': () => {
        throw new TypeError('Failed to fetch');
      },
      'GET /api/approvals': () => {
        throw new TypeError('Failed to fetch');
      },
    });
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    expect(await screen.findByText('Shipyard is not answering.')).toBeInTheDocument();
  });
});
