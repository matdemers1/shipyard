import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DryRunSheetProps } from '../src/components/DryRunSheet';
import type { GroupDeploySheetProps } from '../src/components/GroupDeploySheet';
import { App } from '../src/App';
import { meReply, mockFetch, type Reply } from './fetch';
import { viewport } from './setup';

// Apps' job is to open the sheet with the right action; the sheet has its own tests
// (dryrun.test.tsx). A stub that shows the action it was given keeps these tests about Apps.
vi.mock('../src/components/DryRunSheet', () => ({
  DryRunSheet: ({ open, action }: DryRunSheetProps) =>
    open && action !== null ? <div role="dialog">{`${action.kind} ${action.app} ${action.sha}`}</div> : null,
}));

// Same idea for the group-deploy sheet: Apps' job is to fetch the groups and open it with the
// right one; the sheet's own behaviour is covered by groupdeploysheet.test.tsx.
vi.mock('../src/components/GroupDeploySheet', () => ({
  GroupDeploySheet: ({ open, group }: GroupDeploySheetProps) =>
    open && group !== null ? <div role="dialog">{`deploy group ${group.name}`}</div> : null,
}));

/**
 * Apps (SHP-T-13.8, SHP-REQ-155, SHP-D-089): Needs you first, each with its action inline, then one
 * row per app in alphabetical order with live → target, the lane, one badge and at most one primary
 * action. The nav's Apps badge counts the same rows, from the same requests.
 */

const SHA_LIVE = 'a'.repeat(40);
const SHA_MID = 'b'.repeat(40);
const SHA_HEAD = 'c'.repeat(40);
const short = (sha: string) => sha.slice(0, 7);

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

function commitsFailed() {
  return {
    live: SHA_LIVE,
    head: SHA_HEAD,
    newestGreen: null,
    source: 'github' as const,
    commits: [
      {
        sha: SHA_HEAD,
        message: 'break it',
        ci: 'failure' as const,
        taskIds: [],
        run: { id: 412, url: 'https://github.com/matdemers1/broken/actions/runs/412', startedAt: null, completedAt: null, conclusion: 'failure' },
      },
    ],
  };
}

function approvalRow(app: string, deployId = 'd1') {
  return {
    deployId,
    kind: 'deploy',
    app,
    sha: SHA_MID,
    requester: { label: 'user matthew', repo: null, branch: null },
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function systemReply(agent: Record<string, unknown>): Reply {
  return {
    status: 200,
    body: {
      versions: { server: 'dev', agent: null, compose: null, engineApi: null },
      agent: { fingerprint: 'f', lastHeartbeatAt: null, stale: false, patExpiresAt: null, patWarning: 'none', unstartedTargets: 0, ...agent },
      outbox: { unsent: 0, unsentOverHour: 0, oldestUnsentAt: null, lastError: null },
      backups: { lastBackup: null, lastDrill: null },
      buildCache: null,
    },
  };
}

const AGENT_OK = [{ id: 'a1', confirmed: true, lastHeartbeatAt: new Date().toISOString(), stale: false }];

function baseRoutes() {
  return {
    'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: false } },
    'GET /api/agent': { status: 200, body: AGENT_OK },
    'GET /api/groups': { status: 200, body: [] },
    'GET /api/system': systemReply({}),
  };
}

function allApps() {
  return screen.getByRole('list', { name: 'All apps' });
}

function rowOf(name: string): HTMLElement {
  const link = within(allApps()).getByRole('link', { name });
  const row = link.closest('li');
  if (row === null) throw new Error(`no row for ${name}`);
  return row;
}

async function renderApps() {
  window.history.replaceState(null, '', '/');
  render(<App />);
  await screen.findByRole('heading', { level: 1, name: 'Apps' });
}

describe('Apps: the rows', () => {
  it('lists one row per app in alphabetical order, whatever each one’s state', async () => {
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
    await renderApps();
    await screen.findByRole('list', { name: 'All apps' });
    const names = within(allApps())
      .getAllByRole('listitem')
      .map((li) => li.querySelector('.shp-app-row__name a')?.textContent);
    // The ready app (web) does not jump ahead of the ones that are fine.
    expect(names).toEqual(['api', 'billing', 'cron', 'web', 'worker']);
  });

  it('says how many apps, ready, in flight and needing you in the header', async () => {
    mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps': { status: 200, body: { apps: [appRow('api'), appRow('web')] } },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/apps/web/commits': { status: 200, body: commitsAheadPending() },
      'GET /api/apps/api/commits': { status: 200, body: commitsUpToDate() },
    });
    await renderApps();
    expect(await screen.findByText('2 apps · 1 ready · 0 in flight · 0 need you')).toBeInTheDocument();
    expect(screen.getByText('Nothing needs you. 1 up to date, 1 ready.')).toBeInTheDocument();
  });

  it('offers the newest green commit as the one primary action, with live → target and what waits after it', async () => {
    mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps': { status: 200, body: { apps: [appRow('web'), appRow('api')] } },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/apps/web/commits': { status: 200, body: commitsAheadPending() },
      'GET /api/apps/api/commits': { status: 200, body: commitsUpToDate() },
    });
    await renderApps();
    await screen.findByRole('list', { name: 'All apps' });
    const web = rowOf('web');
    expect(within(web).getByText('Ready')).toBeInTheDocument();
    // "Commit" is for a screen reader; the row shows "aaaaaaa → bbbbbbb".
    expect(web).toHaveTextContent(`${short(SHA_LIVE)} → Commit ${short(SHA_MID)}`);
    expect(web).toHaveTextContent('+1 waiting');
    expect(within(web).getByRole('img', { name: /^Pipeline: Push done, CI done, Images waiting/ })).toBeInTheDocument();
    expect(within(web).getByRole('link', { name: `Commit ${short(SHA_MID)}` })).toHaveAttribute('href', `/apps/web/commits/${SHA_MID}`);
    expect(within(web).getByRole('link', { name: 'web' })).toHaveAttribute('href', '/apps/web');

    const deploy = within(web).getByRole('button', { name: `Deploy ${short(SHA_MID)}` });
    expect(screen.queryByRole('button', { name: `Deploy ${short(SHA_HEAD)}` })).not.toBeInTheDocument();
    await userEvent.setup().click(deploy);
    expect(await screen.findByRole('dialog')).toHaveTextContent(`deploy web ${SHA_MID}`);
  });

  it('gives an up-to-date app no action and a one-line why', async () => {
    mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps': { status: 200, body: { apps: [appRow('api')] } },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/apps/api/commits': { status: 200, body: commitsUpToDate() },
    });
    await renderApps();
    await screen.findByRole('list', { name: 'All apps' });
    const api = rowOf('api');
    expect(within(api).getByText('Up to date')).toBeInTheDocument();
    expect(within(api).getByText('Live is the newest commit')).toBeInTheDocument();
    expect(within(api).queryAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['More for api']);
  });

  it('says why commits ahead with no images have nothing to deploy', async () => {
    mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps': { status: 200, body: { apps: [appRow('web', { defaultBranch: 'main' })] } },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/apps/web/commits': {
        status: 200,
        body: {
          live: SHA_LIVE,
          head: SHA_HEAD,
          newestGreen: null,
          ahead: 14,
          source: 'github',
          commits: [
            { sha: SHA_MID, message: 'docs', ci: 'none', taskIds: [] },
            { sha: SHA_HEAD, message: 'docs again', ci: 'none', taskIds: [] },
          ],
        },
      },
    });
    await renderApps();
    expect(await screen.findByText('14 commits since live, none with images')).toBeInTheDocument();
    expect(within(rowOf('web')).getByText('Waiting')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Deploy [0-9a-f]{7}$/i })).not.toBeInTheDocument();
  });

  it('offers Watch, not Deploy, on an app that is deploying', async () => {
    mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps': {
        status: 200,
        body: {
          apps: [
            appRow('web', { active: { targetId: 't1', deployId: 'dep-1', state: 'soaking', holder: 'Claude', currentStep: 'soak' } }),
          ],
        },
      },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/apps/web/commits': { status: 200, body: commitsAheadPending() },
    });
    await renderApps();
    await screen.findByRole('list', { name: 'All apps' });
    const web = rowOf('web');
    expect(within(web).getByText('Deploying')).toBeInTheDocument();
    expect(within(web).getByText('soak · Claude')).toBeInTheDocument();
    expect(within(web).getByRole('link', { name: 'Watch web' })).toHaveAttribute('href', '/deploys/dep-1');
    expect(within(web).queryByRole('button', { name: /^Deploy / })).not.toBeInTheDocument();
    expect(screen.getByText('1 app · 0 ready · 1 in flight · 0 need you')).toBeInTheDocument();
  });

  it('reads Frozen over Ready and offers nothing to deploy', async () => {
    mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps': { status: 200, body: { apps: [appRow('web', { frozen: true })] } },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/apps/web/commits': { status: 200, body: commitsAheadPending() },
    });
    await renderApps();
    await screen.findByRole('list', { name: 'All apps' });
    const web = rowOf('web');
    expect(within(web).getByText('Frozen')).toBeInTheDocument();
    expect(within(web).getByText('New deploys are refused')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Deploy [0-9a-f]{7}$/ })).not.toBeInTheDocument();
  });

  it('names an app’s groups on its row and keeps the group deploy one tap away', async () => {
    mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps': { status: 200, body: { apps: [appRow('alpha'), appRow('bravo')] } },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/apps/alpha/commits': { status: 200, body: commitsUpToDate() },
      'GET /api/apps/bravo/commits': { status: 200, body: commitsUpToDate() },
      'GET /api/groups': { status: 200, body: [{ name: 'trio', canary: 'alpha', members: ['alpha', 'bravo', 'charlie'] }] },
    });
    await renderApps();
    expect(await screen.findByText('canary · trio group')).toBeInTheDocument();
    expect(within(rowOf('bravo')).getByText('trio group')).toBeInTheDocument();
    const groups = screen.getByRole('list', { name: 'Groups' });
    expect(groups).toHaveTextContent('trio group · alpha (canary), bravo, charlie');

    await userEvent.setup().click(within(groups).getByRole('button', { name: 'Deploy group trio' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('deploy group trio');
  });

  it('hides every deploy, review and group action from a viewer', async () => {
    mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('viewer'),
      'GET /api/apps': { status: 200, body: { apps: [appRow('web'), appRow('api'), appRow('billing')] } },
      'GET /api/approvals': { status: 200, body: [approvalRow('billing')] },
      'GET /api/apps/web/commits': { status: 200, body: commitsAheadPending() },
      'GET /api/apps/api/commits': { status: 200, body: commitsUpToDate() },
      'GET /api/apps/billing/commits': { status: 200, body: commitsUpToDate() },
      'GET /api/groups': { status: 200, body: [{ name: 'trio', canary: 'web', members: ['web', 'api'] }] },
    });
    await renderApps();
    await screen.findByRole('list', { name: 'Groups' });
    expect(screen.queryByRole('button', { name: /^Deploy / })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Review/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Approve and deploy/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument();
    // The approval still shows; a viewer just cannot act on it.
    expect(within(screen.getByRole('list', { name: 'Needs you' })).getByText(/user matthew asked to deploy/)).toBeInTheDocument();
  });

  it('stacks a row on a phone and keeps its one action', async () => {
    viewport.desktop = false;
    mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps': { status: 200, body: { apps: [appRow('web')] } },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/apps/web/commits': { status: 200, body: commitsAheadPending() },
    });
    await renderApps();
    await screen.findByRole('list', { name: 'All apps' });
    expect(within(rowOf('web')).getByRole('button', { name: `Deploy ${short(SHA_MID)}` })).toBeInTheDocument();
  });
});

describe('Apps: Needs you', () => {
  it('lists an approval with Deny and Approve and deploy, and opens the review with the requester', async () => {
    mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps': { status: 200, body: { apps: [appRow('billing')] } },
      'GET /api/approvals': { status: 200, body: [approvalRow('billing')] },
      'GET /api/apps/billing/commits': { status: 200, body: commitsUpToDate() },
    });
    await renderApps();
    expect(await screen.findByRole('heading', { name: 'Needs you (1)' })).toBeInTheDocument();
    const needs = screen.getByRole('list', { name: 'Needs you' });
    expect(needs).toHaveTextContent(`billing user matthew asked to deploy ${short(SHA_MID)}`);
    expect(within(needs).getByRole('button', { name: 'Deny' })).toBeInTheDocument();

    // The row in All apps says the same and offers Review.
    expect(within(rowOf('billing')).getByText('Waiting for approval')).toBeInTheDocument();
    expect(within(rowOf('billing')).getByRole('button', { name: 'Review billing' })).toBeInTheDocument();

    await userEvent.setup().click(within(needs).getByRole('button', { name: `Approve and deploy ${short(SHA_MID)}` }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(`approve billing ${SHA_MID}`);
  });

  it('denies an approval after a confirm and reads the list again', async () => {
    let denied = false;
    const calls = mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps': { status: 200, body: { apps: [appRow('billing')] } },
      'GET /api/approvals': () => ({ status: 200, body: denied ? [] : [approvalRow('billing')] }),
      'GET /api/apps/billing/commits': { status: 200, body: commitsUpToDate() },
      'POST /api/deploys/d1/deny': () => {
        denied = true;
        return { status: 200, body: { deployId: 'd1', state: 'cancelled' } };
      },
    });
    await renderApps();
    const user = userEvent.setup();
    await user.click(await within(await screen.findByRole('list', { name: 'Needs you' })).findByRole('button', { name: 'Deny' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Deny' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/deploys/d1/deny')).toBe(true);
    });
    expect(await screen.findByText('Nothing needs you. 1 up to date, 0 ready.')).toBeInTheDocument();
  });

  it('offers adopt and redeploy inline for drift, and Resolve on the row', async () => {
    mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps': {
        status: 200,
        body: { apps: [appRow('drifter', { drift: { id: 'dr1', detectedAt: new Date(Date.now() - 3_600_000).toISOString() } })] },
      },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/apps/drifter/commits': { status: 200, body: commitsUpToDate() },
    });
    await renderApps();
    const needs = await screen.findByRole('list', { name: 'Needs you' });
    expect(needs).toHaveTextContent('drifter is running something Shipyard did not deploy');
    expect(needs).toHaveTextContent('1h ago');
    expect(within(needs).getByRole('button', { name: "Adopt what's running" })).toBeInTheDocument();
    expect(within(needs).getByRole('button', { name: 'Redeploy live' })).toBeInTheDocument();
    expect(within(rowOf('drifter')).getByRole('link', { name: 'Resolve drifter' })).toHaveAttribute('href', '/apps/drifter');
  });

  it('links a failed CI run from Needs you and from the row', async () => {
    mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps': { status: 200, body: { apps: [appRow('broken')] } },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/apps/broken/commits': { status: 200, body: commitsFailed() },
    });
    await renderApps();
    const needs = await screen.findByRole('list', { name: 'Needs you' });
    expect(needs).toHaveTextContent(`broken CI failed on ${short(SHA_HEAD)}`);
    const url = 'https://github.com/matdemers1/broken/actions/runs/412';
    expect(within(needs).getByRole('link', { name: 'View run for broken' })).toHaveAttribute('href', url);
    expect(within(rowOf('broken')).getByRole('link', { name: 'View run for broken' })).toHaveAttribute('href', url);
    expect(within(rowOf('broken')).getByText('CI failed · run #412')).toBeInTheDocument();
  });

  it('carries host warnings with a way to Settings, and no stale-agent banner', async () => {
    mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('admin'),
      'GET /api/apps': { status: 200, body: { apps: [appRow('web')] } },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/apps/web/commits': { status: 200, body: commitsUpToDate() },
      'GET /api/system': systemReply({ stale: true, patWarning: 'expiring' }),
    });
    await renderApps();
    const needs = await screen.findByRole('list', { name: 'Needs you' });
    expect(within(needs).getByRole('link', { name: 'Open Settings' })).toHaveAttribute('href', '/settings/host');
    expect(within(needs).getByRole('link', { name: 'Renew in Settings' })).toHaveAttribute('href', '/settings/host');
    expect(screen.queryByText('No agent has reported recently')).not.toBeInTheDocument();
  });

  it('puts the same count on the Apps badge as it renders rows, from one read of each endpoint', async () => {
    const calls = mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('admin'),
      'GET /api/apps': {
        status: 200,
        body: {
          apps: [
            appRow('billing'),
            appRow('broken'),
            appRow('drifter', { drift: { id: 'dr1', detectedAt: new Date().toISOString() } }),
            appRow('fine'),
          ],
        },
      },
      'GET /api/approvals': { status: 200, body: [approvalRow('billing', 'd1'), approvalRow('docs', 'd2')] },
      'GET /api/apps/billing/commits': { status: 200, body: commitsUpToDate() },
      'GET /api/apps/broken/commits': { status: 200, body: commitsFailed() },
      'GET /api/apps/drifter/commits': { status: 200, body: commitsUpToDate() },
      'GET /api/apps/fine/commits': { status: 200, body: commitsUpToDate() },
      'GET /api/system': systemReply({ stale: true, patWarning: 'expired' }),
    });
    await renderApps();
    const needs = await screen.findByRole('list', { name: 'Needs you' });
    const rendered = within(needs).getAllByRole('listitem').length;
    // Two approvals, one drift, one failed CI, a stale agent and an expired token.
    expect(rendered).toBe(6);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: `Apps, ${String(rendered)} need you` })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: `Needs you (${String(rendered)})` })).toBeInTheDocument();

    // The shell and Apps share one store: one read of each, not one per surface.
    const count = (path: string) => calls.filter((c) => c.method === 'GET' && c.path === path).length;
    expect(count('/api/apps')).toBe(1);
    expect(count('/api/approvals')).toBe(1);
    expect(count('/api/system')).toBe(1);
    expect(count('/api/apps/broken/commits')).toBe(1);
  });
});

describe('Apps: empty and error states', () => {
  it('shows "No agent enrolled yet" with a link to /agent when there is no agent', async () => {
    mockFetch({
      ...baseRoutes(),
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/agent': { status: 200, body: [] },
      'GET /api/apps': { status: 200, body: { apps: [] } },
      'GET /api/approvals': { status: 200, body: [] },
    });
    await renderApps();
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
    await renderApps();
    expect(await screen.findByText('Agent reported no apps')).toBeInTheDocument();
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
    await renderApps();
    expect(await screen.findByText('Shipyard is not answering.')).toBeInTheDocument();
  });
});
