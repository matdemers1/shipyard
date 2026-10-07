import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { RETIRED_ROUTES } from '../src/routes';
import { meReply, mockFetch, type Reply } from './fetch';
import { viewport } from './setup';

/** Three destinations (SHP-REQ-159) and a redirect for every retired route (SHP-REQ-169). */

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(<App />);
}

const SHA = 'a'.repeat(40);

function appRow(name: string, overrides: Record<string, unknown> = {}) {
  return { name, repo: `matdemers1/${name}`, liveSha: SHA, reportedAt: null, drift: null, approvalPolicy: null, active: null, ...overrides };
}

function approvalRow(app: string, deployId: string) {
  return {
    deployId,
    kind: 'deploy',
    app,
    sha: 'b'.repeat(40),
    requester: { label: 'Claude', repo: null, branch: null },
    requestedAt: '2026-10-06T10:00:00.000Z',
    expiresAt: '2026-10-07T10:00:00.000Z',
  };
}

function systemReply(agent: Record<string, unknown> | null): Reply {
  return {
    status: 200,
    body: {
      versions: { server: 'dev', agent: null, compose: null, engineApi: null },
      agent: agent === null ? null : { fingerprint: 'f', lastHeartbeatAt: null, stale: false, patExpiresAt: null, patWarning: 'none', unstartedTargets: 0, ...agent },
      outbox: { unsent: 0, unsentOverHour: 0, oldestUnsentAt: null, lastError: null },
      backups: { lastBackup: null, lastDrill: null },
      buildCache: null,
    },
  };
}

describe('the sidebar', () => {
  it('lists exactly Apps, Activity and Settings, with the current one marked', async () => {
    mockFetch({ 'GET /api/auth/me': meReply('admin') });
    renderAt('/activity');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Apps', 'Activity', 'Settings']);
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/', '/activity', '/settings']);
    expect(within(nav).getByRole('link', { name: 'Activity' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Apps' })).not.toHaveAttribute('aria-current');
  });

  it('keeps Apps current on an app page and Settings current on a section', async () => {
    mockFetch({ 'GET /api/auth/me': meReply('admin') });
    renderAt('/settings/tokens');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
  });

  it('puts the number of Needs-you items on Apps: approvals, drift, and a stale agent', async () => {
    mockFetch({
      'GET /api/auth/me': meReply('admin'),
      'GET /api/apps': { status: 200, body: { apps: [appRow('blog'), appRow('drifter', { drift: { id: 'dr1', detectedAt: '2026-10-06T09:00:00.000Z' } })] } },
      'GET /api/approvals': { status: 200, body: [approvalRow('blog', 'd1'), approvalRow('docs', 'd2')] },
      'GET /api/system': systemReply({ stale: true }),
      'GET /api/apps/blog/commits': { status: 200, body: { live: SHA, head: SHA, commits: [], newestGreen: null, source: 'github' } },
      'GET /api/apps/drifter/commits': { status: 200, body: { live: SHA, head: SHA, commits: [], newestGreen: null, source: 'github' } },
    });
    renderAt('/activity');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    // Two approvals, one drift, one stale agent.
    expect(await within(nav).findByRole('link', { name: 'Apps, 4 need you' })).toBeInTheDocument();
  });

  it('shows no count when nothing needs you, and the host as healthy', async () => {
    mockFetch({
      'GET /api/auth/me': meReply('admin'),
      'GET /api/apps': { status: 200, body: { apps: [] } },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/system': systemReply({}),
    });
    renderAt('/activity');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(await screen.findByRole('link', { name: 'Host healthy' })).toHaveAttribute('href', '/settings/host');
    expect(within(nav).getByRole('link', { name: 'Apps' })).toBeInTheDocument();
  });

  it('shows the first warning in the host footer, linking to the host section', async () => {
    mockFetch({
      'GET /api/auth/me': meReply('admin'),
      'GET /api/apps': { status: 200, body: { apps: [] } },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/system': systemReply({ patWarning: 'expiring' }),
    });
    renderAt('/activity');
    const footer = await screen.findByRole('link', { name: /Host · 1 to look at/ });
    expect(footer).toHaveAttribute('href', '/settings/host');
    expect(footer).toHaveTextContent('The GitHub token expires soon');
  });
});

describe('the phone tab bar', () => {
  it('carries the same three destinations and the Needs-you count, and navigates without a reload', async () => {
    viewport.desktop = false;
    mockFetch({
      'GET /api/auth/me': meReply('viewer'),
      'GET /api/apps': { status: 200, body: { apps: [] } },
      'GET /api/approvals': { status: 200, body: [approvalRow('blog', 'd1')] },
    });
    const user = userEvent.setup();
    renderAt('/settings/tokens');
    const bar = await screen.findByRole('navigation', { name: 'Primary' });
    expect(within(bar).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['/', '/activity', '/settings']);
    expect(await within(bar).findByRole('link', { name: 'Apps, 1 need you' })).toBeInTheDocument();
    expect(within(bar).getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');

    await user.click(within(bar).getByRole('link', { name: 'Activity' }));
    expect(window.location.pathname).toBe('/activity');
    expect(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'Activity' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('retired routes', () => {
  const TARGETS: Record<string, string> = {
    '/timeline': '/activity',
    '/builds': '/activity?kind=build',
    '/schedules': '/activity?kind=schedule',
    '/system': '/settings/host',
    '/agent': '/settings/host',
    '/tokens': '/settings/tokens',
    '/connect': '/settings/tokens',
    '/users': '/settings/people',
    '/account': '/settings/people',
  };

  it('covers every address the old nav had, and nothing else', () => {
    expect(RETIRED_ROUTES.map((r) => `/${r.from}`).sort()).toEqual(Object.keys(TARGETS).sort());
  });

  it.each(Object.entries(TARGETS))('%s lands on %s', async (from, to) => {
    mockFetch({ 'GET /api/auth/me': meReply('admin') });
    renderAt(from);
    await screen.findByRole('navigation', { name: 'Main' });
    const [pathname, search = ''] = to.split('?');
    await waitFor(() => {
      expect(window.location.pathname).toBe(pathname);
    });
    expect(window.location.search).toBe(search === '' ? '' : `?${search}`);
  });

  it('keeps the visitor’s query string and hash through the move', async () => {
    mockFetch({ 'GET /api/auth/me': meReply('admin') });
    renderAt('/timeline?app=blog&outcome=failed#row-3');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/activity');
    });
    expect(window.location.search).toBe('?app=blog&outcome=failed');
    expect(window.location.hash).toBe('#row-3');
  });

  it('merges the target’s own query with the visitor’s', async () => {
    mockFetch({ 'GET /api/auth/me': meReply('admin') });
    renderAt('/builds?app=blog#top');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/activity');
    });
    expect(new URLSearchParams(window.location.search).get('kind')).toBe('build');
    expect(new URLSearchParams(window.location.search).get('app')).toBe('blog');
    expect(window.location.hash).toBe('#top');
  });

  it('sends /settings to its first section', async () => {
    mockFetch({ 'GET /api/auth/me': meReply('admin') });
    renderAt('/settings');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/settings/host');
    });
  });

  it('keeps the routes that did not retire', async () => {
    mockFetch({ 'GET /api/auth/me': meReply('admin') });
    renderAt('/builds/b-1');
    await screen.findByRole('navigation', { name: 'Main' });
    expect(window.location.pathname).toBe('/builds/b-1');
  });

  it('says there is no page at an unknown settings section', async () => {
    mockFetch({ 'GET /api/auth/me': meReply('admin') });
    renderAt('/settings/nope');
    expect(await screen.findByText('There is no page at this address')).toBeInTheDocument();
  });

  it('still refuses a viewer on a section that needs the deployer role', async () => {
    mockFetch({ 'GET /api/auth/me': meReply('viewer') });
    renderAt('/users');
    expect(await screen.findByText('This page needs the deployer role')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/settings/people');
  });

  it('opens Settings on People for a viewer, whose account is there, not on a refusal', async () => {
    mockFetch({ 'GET /api/auth/me': meReply('viewer') });
    renderAt('/settings');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/settings/people');
    });
  });
});
