import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SystemStatus } from '@shipyard/schema';
import { App } from '../src/App';
import type { Role } from '../src/lib/api';
import { sectionsFor } from '../src/screens/SettingsSection';
import { meReply, mockFetch, type Reply } from './fetch';
import { viewport } from './setup';

/**
 * Settings as one destination (SHP-T-13.6, SHP-REQ-160, SHP-REQ-170, SHP-ADR-006): a sub-nav of
 * Host, Claude & tokens, People, Integrations and Builds; each section behind the gate its old
 * screens had, per role; Host leading with its health checklist; one token form and one token list;
 * Builds collapsed when no app builds with Shipyard; and no setting in two sections.
 */

const SHA = 'a'.repeat(40);

function system(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    versions: { server: 'sha-abc123', agent: '0.9.2', compose: '5.0.1', engineApi: '1.51' },
    agent: {
      fingerprint: 'SHA256:abc',
      lastHeartbeatAt: new Date().toISOString(),
      stale: false,
      patExpiresAt: new Date(Date.now() + 9 * 86_400_000).toISOString(),
      patWarning: 'expiring',
      unstartedTargets: 0,
    },
    outbox: { unsent: 0, unsentOverHour: 0, oldestUnsentAt: null, lastError: null },
    backups: { lastBackup: null, lastDrill: null },
    buildCache: null,
    ...overrides,
  };
}

/** Everything any section (and the shell around it) reads, for one role. */
function routes(role: Role, opts: { buildSource?: 'github' | 'shipyard'; system?: SystemStatus } = {}): Record<string, Reply | Reply[]> {
  const app = (name: string) => ({ name, repo: `matdemers1/${name}`, liveSha: SHA, reportedAt: null, drift: null, approvalPolicy: null, active: null });
  const manifest = (source: 'github' | 'shipyard') => ({ status: 200, body: { ...app('web'), manifest: { build: { source } } } });
  return {
    'GET /api/auth/me': meReply(role),
    'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: false } },
    'GET /api/auth/sessions': { status: 200, body: [] },
    'GET /api/apps': { status: 200, body: { apps: [app('web'), app('api')] } },
    'GET /api/apps/web': manifest(opts.buildSource ?? 'github'),
    'GET /api/apps/api': manifest('github'),
    'GET /api/apps/web/commits': { status: 200, body: { live: SHA, head: SHA, commits: [], ahead: 0, newestGreen: null, source: 'github', buildSource: 'github' } },
    'GET /api/apps/api/commits': { status: 200, body: { live: SHA, head: SHA, commits: [], ahead: 0, newestGreen: null, source: 'github', buildSource: 'github' } },
    'GET /api/approvals': { status: 200, body: [] },
    'GET /api/system': { status: 200, body: opts.system ?? system() },
    'GET /api/agent': {
      status: 200,
      body: [
        {
          id: 'a1',
          fingerprint: 'SHA256:abc',
          confirmed: true,
          confirmedAt: null,
          confirmedBy: null,
          enrolledAt: '2026-09-20T00:00:00.000Z',
          lastHeartbeatAt: new Date().toISOString(),
          agentVersion: '0.9.2',
          composeVersion: '5.0.1',
          engineApiVersion: '1.51',
          stale: false,
        },
      ],
    },
    'GET /api/stats/out-of-band': { status: 200, body: { months: [] } },
    'GET /api/tokens': { status: 200, body: [] },
    'GET /api/users': { status: 200, body: [{ id: 'u1', email: 'matt@example.com', displayName: 'Matt', role, disabled: false, totpEnrolled: true, d3authLinked: false, createdAt: '2026-09-01T00:00:00.000Z' }] },
    'GET /api/invites': { status: 200, body: [] },
    'GET /api/settings/d3auth': {
      status: 200,
      body: {
        source: 'none',
        issuer: null,
        clientId: null,
        clientSecretSet: false,
        redirectUri: 'http://localhost/api/auth/oidc/callback',
        available: false,
        reachable: null,
        canStoreSecret: true,
        problem: null,
        manifest: { client_id: 'shipyard' },
        updatedAt: null,
      },
    },
    'GET /api/settings/mail': {
      status: 200,
      body: { source: 'none', relayUrl: null, tokenSet: false, alertTo: null, active: false, canStoreSecret: true, problem: null, updatedAt: null },
    },
    'GET /api/settings/github': {
      status: 200,
      body: { source: 'none', tokenSet: false, canStoreSecret: true, problem: null, updatedAt: null, rateLimit: null, rateLimitProblem: 'GitHub could not be reached.' },
    },
    'GET /api/settings/builds': { status: 200, body: { cpus: 2, memoryMb: 4096, cacheCapGb: 20 } },
  };
}

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(<App />);
}

const h1 = (name: string) => screen.findByRole('heading', { level: 1, name }, { timeout: 4000 });
const subNav = () => screen.findByRole('navigation', { name: 'Settings' }, { timeout: 4000 });

const ROLES = ['viewer', 'deployer', 'operator', 'admin'] as const;

/** What each role may open — the gates the old screens had (SHP-ADR-006). */
const EXPECTED: Record<(typeof ROLES)[number], string[]> = {
  viewer: ['Claude & tokens', 'People'],
  deployer: ['Host', 'Claude & tokens', 'People'],
  operator: ['Host', 'Claude & tokens', 'People'],
  admin: ['Host', 'Claude & tokens', 'People', 'Integrations', 'Builds'],
};

describe('the sub-nav lists only what the role may open', () => {
  it.each(ROLES)('%s', async (role) => {
    mockFetch(routes(role));
    renderAt('/settings/people');
    const nav = await subNav();
    const labels = within(nav)
      .getAllByRole('link')
      .map((link) => link.querySelector('.shp-settings__label')?.textContent);
    expect(labels).toEqual(EXPECTED[role]);
    expect(sectionsFor(role)).toHaveLength(EXPECTED[role].length);
    expect(within(nav).getByRole('link', { name: /^People/ })).toHaveAttribute('aria-current', 'page');
  });

  it('groups the sections as Daily, Connect, Access and Advanced', async () => {
    mockFetch(routes('admin'));
    renderAt('/settings/people');
    const nav = await subNav();
    expect(within(nav).getAllByRole('group').map((g) => g.getAttribute('aria-labelledby')?.replace('shp-settings-group-', ''))).toEqual([
      'Daily',
      'Connect',
      'Access',
      'Advanced',
    ]);
  });
});

describe('each section keeps its gate, per role', () => {
  const SECTIONS: { path: string; title: string; gate: 'none' | 'state' | 'admin' }[] = [
    { path: 'host', title: 'Host', gate: 'state' },
    { path: 'tokens', title: 'Claude & tokens', gate: 'none' },
    { path: 'people', title: 'People', gate: 'none' },
    { path: 'integrations', title: 'Integrations', gate: 'admin' },
    { path: 'builds', title: 'Builds', gate: 'admin' },
  ];
  const cases = SECTIONS.flatMap((s) => ROLES.map((role) => ({ ...s, role })));

  it.each(cases)('$path as $role', async ({ path, title, gate, role }) => {
    mockFetch(routes(role));
    renderAt(`/settings/${path}`);
    const allowed = gate === 'none' || (gate === 'state' && role !== 'viewer') || (gate === 'admin' && role === 'admin');
    if (allowed) {
      expect(await h1(title)).toBeInTheDocument();
    } else {
      expect(
        await screen.findByText(gate === 'admin' ? 'This page needs the admin role' : 'This page needs the deployer role', {}, { timeout: 4000 }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('heading', { level: 1, name: title })).not.toBeInTheDocument();
    }
  });

  it('Claude & tokens shows the token list to a deployer and not to a viewer', async () => {
    mockFetch(routes('deployer'));
    const { unmount } = renderAt('/settings/tokens');
    expect(await screen.findByRole('heading', { name: 'Tokens (0 active)' }, { timeout: 4000 })).toBeInTheDocument();
    unmount();

    const calls = mockFetch(routes('viewer'));
    renderAt('/settings/tokens');
    expect(await screen.findByText('A deployer makes the token', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^Tokens/ })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/tokens')).toBe(false);
  });

  it('People shows a viewer their own account and not the users list', async () => {
    const calls = mockFetch(routes('viewer'));
    renderAt('/settings/people');
    expect(await h1('People')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Users' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/users')).toBe(false);
  });

  it('People shows a deployer the users and invites, then their own account', async () => {
    mockFetch(routes('deployer'));
    renderAt('/settings/people');
    expect(await screen.findByRole('heading', { name: 'Users' }, { timeout: 4000 })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Create invite' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your account' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
  });
});

describe('Host leads with the health checklist', () => {
  it('shows Health first, its seven rows in order, and the token warning with Renew…', async () => {
    mockFetch(routes('deployer'));
    renderAt('/settings/host');
    await h1('Host');
    const headings = (await screen.findAllByRole('heading', { level: 2 })).map((h) => h.textContent);
    expect(headings.slice(0, 2)).toEqual(['Health', 'Rarely needed']);
    const list = await screen.findByRole('list', { name: 'Host health' });
    await waitFor(() => {
      expect(within(list).getAllByRole('listitem')).toHaveLength(7);
    });
    expect(within(list).getAllByRole('listitem').map((li) => li.querySelector('.d3-sdot')?.textContent)).toEqual([
      'Agent',
      "Agent's GitHub token",
      'Foreman outbox',
      'Nightly backup of Shipyard',
      'Restore drill',
      'Disk',
      'Drift',
    ]);
    expect(within(list).getByText(/^Expires in 9 days · /)).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Renew…' })).toBeInTheDocument();
  });

  it('puts a warning dot on Host in the sub-nav when the host has something to look at', async () => {
    mockFetch(routes('admin'));
    renderAt('/settings/people');
    const nav = await subNav();
    await waitFor(() => {
      expect(within(nav).getByRole('link', { name: /^Host, needs a look/ })).toBeInTheDocument();
    });
  });

  it('puts no dot there when the host is fine', async () => {
    const agent = system().agent;
    if (agent === null) throw new Error('the default status has an agent');
    mockFetch(routes('admin', { system: system({ agent: { ...agent, patWarning: 'none', patExpiresAt: null } }) }));
    renderAt('/settings/people');
    const nav = await subNav();
    await screen.findByRole('heading', { name: 'Your account' });
    expect(within(nav).getByRole('link', { name: 'Host' })).toBeInTheDocument();
  });
});

describe('Claude & tokens: one create form, one list', () => {
  it('puts Connect a Claude session first and has exactly one token form', async () => {
    const token = {
      id: 't1',
      userId: 'u1',
      label: 'matdemers1/bindery',
      prefix: 'shp_abcdefgh',
      apps: ['web'],
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      lastUsedIp: null,
      revokedAt: null,
    };
    mockFetch({ ...routes('admin'), 'GET /api/tokens': { status: 200, body: [token] } });
    renderAt('/settings/tokens');
    await h1('Claude & tokens');
    await screen.findByRole('button', { name: 'Make the token' }, { timeout: 4000 });
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Connect a Claude session', 'Tokens (1 active)']);
    expect(screen.getAllByRole('form')).toHaveLength(1);
    expect(screen.getAllByRole('list', { name: 'API tokens' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Create token' })).not.toBeInTheDocument();
  });
});

describe('Builds', () => {
  it('collapses, says why and is marked Unused when no app builds with Shipyard', async () => {
    mockFetch(routes('admin'));
    renderAt('/settings/builds');
    await h1('Builds');
    expect(await screen.findByText('No app uses Shipyard builds — all 2 build on GitHub Actions.')).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'CPUs' })).not.toBeInTheDocument();
    const nav = await subNav();
    expect(within(nav).getByRole('link', { name: /^Builds/ })).toHaveTextContent('Unused');

    const edit = screen.getByRole('button', { name: 'Edit limits' });
    expect(edit).toHaveAttribute('aria-expanded', 'false');
    await userEvent.setup().click(edit);
    expect(screen.getByRole('spinbutton', { name: 'CPUs' })).toHaveValue(2);
  });

  it('opens the limits at once when an app builds with Shipyard', async () => {
    mockFetch(routes('admin', { buildSource: 'shipyard' }));
    renderAt('/settings/builds');
    expect(await screen.findByRole('spinbutton', { name: 'CPUs' }, { timeout: 4000 })).toHaveValue(2);
    expect(screen.queryByRole('button', { name: 'Edit limits' })).not.toBeInTheDocument();
    const nav = await subNav();
    expect(within(nav).getByRole('link', { name: /^Builds/ })).not.toHaveTextContent('Unused');
  });
});

describe('no setting appears in two sections (SHP-REQ-170)', () => {
  it('Integrations has Sign-in, GitHub and alert email as cards, and only points at Builds', async () => {
    mockFetch(routes('admin'));
    renderAt('/settings/integrations');
    await h1('Integrations');
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Sign in with D3 Auth',
      'GitHub',
      'Alert email',
      'Builds',
    ]);
    expect(await screen.findByText('No app uses Shipyard builds — all 2 build on GitHub Actions.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Builds' })).toHaveAttribute('href', '/settings/builds');
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
  });

  it("the agent's token expiry and the versions are on Host alone", async () => {
    for (const path of ['tokens', 'people', 'integrations', 'builds']) {
      mockFetch(routes('admin'));
      const { unmount } = renderAt(`/settings/${path}`);
      await screen.findByRole('heading', { level: 1 }, { timeout: 4000 });
      expect(screen.queryByText(/Expires in \d+ days/)).not.toBeInTheDocument();
      expect(screen.queryByText(/sha-abc123/)).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe('on a phone', () => {
  it('keeps the sub-nav above the section, with every allowed section listed', async () => {
    viewport.desktop = false;
    mockFetch(routes('deployer'));
    renderAt('/settings/tokens');
    const nav = await subNav();
    expect(within(nav).getAllByRole('link')).toHaveLength(3);
    const heading = await h1('Claude & tokens');
    // The sub-nav comes first in the document, so it sits above the section on a narrow screen.
    expect(nav.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
