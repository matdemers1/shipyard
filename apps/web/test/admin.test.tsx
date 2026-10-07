import { ThemeProvider, TooltipProvider } from '@d3cloud/ui';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { isHeartbeatStale, mcpSnippet, type AgentSummary, type TokenSummary, type UserSummary } from '../src/lib/admin';
import type { Role } from '../src/lib/api';
import { AuthProvider } from '../src/lib/auth';
import { AcceptInvite } from '../src/screens/AcceptInvite';
import { AgentEnrolment } from '../src/screens/settings/AgentEnrolment';
import { ClaudeTokensSection } from '../src/screens/settings/ClaudeTokensSection';
import { HostSection } from '../src/screens/settings/HostSection';
import { useSystemStatus } from '../src/screens/settings/shared';
import { Users } from '../src/screens/Users';
import { meReply, mockFetch, type Reply } from './fetch';

/**
 * The admin parts of Settings (SHP-T-3.8, SHP-T-13.6): agent enrolment on Host, tokens on Claude &
 * tokens, and Users on People. Rendered directly, without the section gate, so "a viewer sees no
 * actions" is a property of the components themselves (SHP-REQ-105).
 */

/** Host as the Settings frame renders it: the frame reads `/api/system` and hands it down. */
function Host() {
  const system = useSystemStatus(true);
  return <HostSection system={system} />;
}

function wrap(children: ReactNode, path = '/') {
  return render(
    <ThemeProvider storageKey="test.theme" defaultPreference="light">
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <AuthProvider>{children}</AuthProvider>
        </MemoryRouter>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function agent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    fingerprint: 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    confirmed: true,
    confirmedAt: minutesAgo(600),
    confirmedBy: { id: 'u1', email: 'matt@example.com', displayName: 'Matt' },
    enrolledAt: minutesAgo(700),
    lastHeartbeatAt: minutesAgo(1),
    agentVersion: '0.3.0',
    composeVersion: '5.0.1',
    engineApiVersion: '1.51',
    stale: false,
    ...overrides,
  };
}

const token: TokenSummary = {
  id: '22222222-2222-4222-8222-222222222222',
  userId: 'u1',
  label: 'matdemers1/bindery',
  prefix: 'shp_abcdefgh',
  apps: ['bindery'],
  createdAt: minutesAgo(60),
  lastUsedAt: minutesAgo(5),
  lastUsedIp: '10.0.0.2',
  revokedAt: null,
};

function user(id: string, role: Role, name: string): UserSummary {
  return {
    id,
    email: `${name.toLowerCase()}@example.com`,
    displayName: name,
    role,
    disabled: false,
    totpEnrolled: true,
    d3authLinked: false,
    createdAt: minutesAgo(1000),
  };
}

const OOB: Reply = {
  status: 200,
  body: { months: [{ month: '2026-08', count: 1 }, { month: '2026-09', count: 3 }] },
};

/** A `GET /api/system` reply naming no PAT warning, for tests that do not care about it. */
const NO_SYSTEM: Reply = {
  status: 200,
  body: {
    versions: { server: 'dev', agent: '0.3.0', compose: '5.0.1', engineApi: '1.51' },
    agent: null,
    outbox: { unsent: 0, unsentOverHour: 0, oldestUnsentAt: null, lastError: null },
    backups: { lastBackup: null, lastDrill: null },
    buildCache: null,
  },
};

function agentRoutes(role: Role, agents: AgentSummary[], system: Reply = NO_SYSTEM) {
  return {
    'GET /api/auth/me': meReply(role),
    'GET /api/agent': { status: 200, body: agents },
    'GET /api/stats/out-of-band': OOB,
    'GET /api/system': system,
    'GET /api/apps': { status: 200, body: { apps: [] } },
  };
}

function tokenRoutes(role: Role) {
  return {
    'GET /api/auth/me': meReply(role),
    'GET /api/tokens': { status: 200, body: [token] },
    'GET /api/apps': { status: 200, body: { apps: [{ name: 'bindery' }, { name: 'foreman' }] } },
  };
}

function userRoutes(role: Role) {
  return {
    'GET /api/auth/me': meReply(role),
    'GET /api/users': {
      status: 200,
      body: [user('u1', role, 'Matt'), user('u2', 'deployer', 'Sam')],
    },
    'GET /api/invites': {
      status: 200,
      body: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          email: 'pending@example.com',
          role: 'viewer',
          invitedBy: 'matt@example.com',
          createdAt: minutesAgo(10),
          expiresAt: minutesAgo(-7 * 24 * 60),
        },
      ],
    },
  };
}

describe('a viewer sees no actions', () => {
  it('Agent enrolment: no confirm or revoke, for confirmed and unconfirmed agents', async () => {
    mockFetch({ 'GET /api/auth/me': meReply('viewer') });
    const noop = () => undefined;
    wrap(
      <>
        <AgentEnrolment agent={agent()} can={false} isAdmin={false} now={Date.now()} onChanged={noop} />
        <AgentEnrolment agent={agent({ id: 'a2', confirmed: false, confirmedAt: null, confirmedBy: null })} can={false} isAdmin={false} now={Date.now()} onChanged={noop} />
      </>,
    );
    expect(await screen.findAllByText('Fingerprint')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /revoke/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/type the fingerprint/i)).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('Claude & tokens: no token form, no token list, and no token read', async () => {
    const calls = mockFetch(tokenRoutes('viewer'));
    wrap(<ClaudeTokensSection />);
    expect(await screen.findByText('A deployer makes the token')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Make the token' })).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'API tokens' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /revoke/i })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/tokens')).toBe(false);
  });

  it('Users: no invite, change-role, disable or revoke', async () => {
    mockFetch(userRoutes('viewer'));
    wrap(<Users />);
    expect(await screen.findByText('Sam')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /invite/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /disable|revoke/i })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('while a deployer does see them, and an admin sees change-role', async () => {
    mockFetch(agentRoutes('admin', [agent(), agent({ id: 'a2', confirmed: false, confirmedAt: null, confirmedBy: null })]));
    const { unmount } = wrap(<Host />);
    // An agent awaiting confirmation opens the enrolment row by itself.
    expect(await screen.findByRole('button', { name: 'Confirm agent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke agent' })).toBeInTheDocument();
    unmount();

    mockFetch(userRoutes('admin'));
    wrap(<Users />);
    expect(await screen.findByText('Sam')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create invite' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Role for Sam' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke invite for pending@example.com' })).toBeInTheDocument();
    // Never on your own row.
    expect(screen.queryByRole('combobox', { name: 'Role for Matt' })).not.toBeInTheDocument();
  });

  it('a deployer (not admin) cannot change roles or revoke the agent', async () => {
    mockFetch(userRoutes('deployer'));
    const { unmount } = wrap(<Users />);
    expect(await screen.findByText('Sam')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create invite' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Role for/ })).not.toBeInTheDocument();
    unmount();

    mockFetch(agentRoutes('deployer', [agent()]));
    wrap(<Host />);
    await userEvent.click(await screen.findByRole('button', { name: 'Show enrolment' }));
    expect(await screen.findByText('Fingerprint')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke agent' })).not.toBeInTheDocument();
  });
});

describe('agent heartbeat', () => {
  it('a heartbeat six minutes old turns the Agent row red, says why, and marks the agent stale', async () => {
    mockFetch(agentRoutes('deployer', [agent({ lastHeartbeatAt: minutesAgo(6) })]));
    wrap(<Host />);
    expect(await screen.findByText(/Not checked in since 6 minutes ago/)).toBeInTheDocument();
    expect(screen.getByText(/Deploys wait until it is back/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show enrolment' }));
    expect(screen.getByText('Stale')).toBeInTheDocument();
  });

  it('a heartbeat one minute old shows none', async () => {
    mockFetch(agentRoutes('deployer', [agent({ lastHeartbeatAt: minutesAgo(1) })]));
    wrap(<Host />);
    expect(await screen.findByText('Checked in 1 minute ago')).toBeInTheDocument();
    expect(screen.queryByText(/Not checked in/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show enrolment' }));
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
  });

  it('shows versions once, the out-of-band count, and the empty state', async () => {
    mockFetch(agentRoutes('deployer', [agent()]));
    const { unmount } = wrap(<Host />);
    await screen.findByText('Checked in 1 minute ago');
    const versions = await screen.findByText(/^Versions:/);
    expect(versions).toHaveTextContent('agent 0.3.0 · compose 5.0.1 · engine API 1.51');
    // Nowhere else on the page: the enrolment row no longer repeats them (SHP-REQ-170).
    await userEvent.click(screen.getByRole('button', { name: 'Show enrolment' }));
    expect(screen.getAllByText(/0\.3\.0/)).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Show months' }));
    expect(screen.getByText('3')).toBeInTheDocument();
    unmount();

    mockFetch(agentRoutes('deployer', []));
    wrap(<Host />);
    await new Promise((r) => setTimeout(r, 500));
    screen.debug(screen.getByRole('list', { name: 'Host health' }), 100000);
    expect(await screen.findByText('No agent enrolled')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Install runbook' })[0]).toHaveAttribute('href', expect.stringMatching(/install\.md$/));
    await userEvent.click(screen.getByRole('button', { name: 'Show enrolment' }));
    expect(screen.getByText('No agent — see the install runbook')).toBeInTheDocument();
  });

  it('warns when the agent\'s PAT expires within 30 days, errors once expired, and offers Renew (SHP-REQ-106)', async () => {
    const soloAgent = agent();
    const expiringSystem: Reply = {
      status: 200,
      body: {
        ...(NO_SYSTEM.body as Record<string, unknown>),
        agent: { fingerprint: soloAgent.fingerprint, lastHeartbeatAt: soloAgent.lastHeartbeatAt, stale: false, patExpiresAt: minutesAgo(-10 * 24 * 60 + 5), patWarning: 'expiring', unstartedTargets: 0 },
      },
    };
    mockFetch(agentRoutes('deployer', [soloAgent], expiringSystem));
    const { unmount } = wrap(<Host />);
    expect(await screen.findByText(/^Expires in 10 days · /)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Renew…' }));
    expect(await screen.findByRole('dialog', { name: "Renew the agent's GitHub token" })).toBeInTheDocument();
    unmount();

    const expiredSystem: Reply = {
      ...expiringSystem,
      body: {
        ...(expiringSystem.body as Record<string, unknown>),
        agent: { ...(expiringSystem.body as { agent: Record<string, unknown> }).agent, patExpiresAt: minutesAgo(60), patWarning: 'expired' },
      },
    };
    mockFetch(agentRoutes('deployer', [soloAgent], expiredSystem));
    wrap(<Host />);
    expect(await screen.findByText(/^Expired · /)).toBeInTheDocument();
    expect(screen.getByText(/cannot read commit history or check runs until it is replaced/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Renew…' })).toBeInTheDocument();
  });

  it('a fingerprint mismatch shows the refusal and its fix', async () => {
    const calls = mockFetch({
      ...agentRoutes('deployer', [agent({ confirmed: false, confirmedAt: null, confirmedBy: null })]),
      'POST /api/agent/11111111-1111-4111-8111-111111111111/confirm': {
        status: 409,
        body: {
          error: {
            code: 'conflict',
            gate: 'none',
            message: 'The fingerprint does not match this agent.',
            fix: 'Compare it character by character.',
          },
        },
      },
    });
    wrap(<Host />);
    expect(await screen.findByText('Waiting for its fingerprint to be confirmed')).toBeInTheDocument();
    const field = await screen.findByLabelText(/type the fingerprint/i);
    await userEvent.type(field, 'SHA256:wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm agent' }));
    expect(await screen.findByText('The fingerprint does not match this agent.')).toBeInTheDocument();
    expect(screen.getByText('Compare it character by character.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ fingerprint: 'SHA256:wrong' });
  });

  it('isHeartbeatStale: none is stale, the boundary is five minutes', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    expect(isHeartbeatStale(null, now)).toBe(true);
    expect(isHeartbeatStale('2026-09-24T11:55:30Z', now)).toBe(false);
    expect(isHeartbeatStale('2026-09-24T11:54:00Z', now)).toBe(true);
  });
});

describe('tokens', () => {
  it('makes a token in the one form, shows it once with its command, and hides it after', async () => {
    const secret = `shp_${'a'.repeat(43)}`;
    const calls = mockFetch({
      ...tokenRoutes('deployer'),
      'POST /api/tokens': {
        status: 201,
        body: { id: 'new', label: 'ci', prefix: secret.slice(0, 12), apps: ['foreman'], token: secret },
      },
    });
    wrap(<ClaudeTokensSection />);
    const name = await screen.findByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'ci');
    await userEvent.click(screen.getByRole('checkbox', { name: 'foreman' }));
    await userEvent.click(screen.getByRole('button', { name: 'Make the token' }));

    expect(await screen.findByText(secret)).toBeInTheDocument();
    const command = screen.getByText(/--header "Authorization: Bearer/, { selector: 'code' });
    expect(command).toHaveTextContent(`Bearer ${secret}`);
    expect(command).toHaveTextContent(/\/mcp --header/);
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ label: 'ci', apps: ['foreman'] });

    await userEvent.click(screen.getByRole('button', { name: 'Make another token' }));
    await waitFor(() => {
      expect(screen.queryByText(secret)).not.toBeInTheDocument();
    });
    expect(screen.queryByText(new RegExp(secret))).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make the token' })).toBeInTheDocument();
  });

  it('revokes only after confirming', async () => {
    const calls = mockFetch({
      ...tokenRoutes('deployer'),
      [`DELETE /api/tokens/${token.id}`]: { status: 200, body: { ...token, revokedAt: new Date().toISOString() } },
    });
    wrap(<ClaudeTokensSection />);
    await userEvent.click(await screen.findByRole('button', { name: `Revoke ${token.label}` }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke token' }));
    expect(await screen.findByText('Revoked')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Tokens (0 active)' })).toBeInTheDocument();
  });

  it('empty state', async () => {
    mockFetch({ ...tokenRoutes('deployer'), 'GET /api/tokens': { status: 200, body: [] } });
    wrap(<ClaudeTokensSection />);
    expect(await screen.findByText('No tokens yet')).toBeInTheDocument();
  });

  it('marks a token nobody has used for thirty days', async () => {
    const stale = { ...token, id: 'old', label: 'old-laptop', createdAt: minutesAgo(90 * 24 * 60), lastUsedAt: minutesAgo(40 * 24 * 60) };
    mockFetch({ ...tokenRoutes('deployer'), 'GET /api/tokens': { status: 200, body: [token, stale] } });
    wrap(<ClaudeTokensSection />);
    expect(await screen.findByText('old-laptop')).toBeInTheDocument();
    expect(screen.getAllByText('Unused for 30 days')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Tokens (2 active)' })).toBeInTheDocument();
  });

  it('mcpSnippet names /mcp and a bearer header', () => {
    const s = JSON.parse(mcpSnippet('https://shipyard.example.test/', 'shp_x')) as {
      mcpServers: { shipyard: { url: string; headers: Record<string, string> } };
    };
    expect(s.mcpServers.shipyard.url).toBe('https://shipyard.example.test/mcp');
    expect(s.mcpServers.shipyard.headers['Authorization']).toBe('Bearer shp_x');
  });
});

describe('users and invites', () => {
  it('shows the invite link once', async () => {
    const link = `https://shipyard.example.test/invite/inv_${'b'.repeat(43)}`;
    const calls = mockFetch({
      ...userRoutes('deployer'),
      'POST /api/invites': {
        status: 201,
        body: {
          id: '44444444-4444-4444-8444-444444444444',
          email: 'new@example.com',
          role: 'deployer',
          invitedBy: 'matt@example.com',
          createdAt: new Date().toISOString(),
          expiresAt: minutesAgo(-7 * 24 * 60),
          token: `inv_${'b'.repeat(43)}`,
          link,
        },
      },
    });
    wrap(<Users />);
    await userEvent.type(await screen.findByLabelText('Email'), 'new@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Create invite' }));
    expect(await screen.findByText(link)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ email: 'new@example.com', role: 'deployer' });
    expect(screen.getByText('new@example.com')).toBeInTheDocument(); // now pending
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByText(link)).not.toBeInTheDocument();
    });
  });

  it('"Just you" when there is only one account', async () => {
    mockFetch({
      ...userRoutes('admin'),
      'GET /api/users': { status: 200, body: [user('u1', 'admin', 'Matt')] },
      'GET /api/invites': { status: 200, body: [] },
    });
    wrap(<Users />);
    expect(await screen.findByText('Just you')).toBeInTheDocument();
  });

  it('an admin changes a role through PATCH', async () => {
    const calls = mockFetch({
      ...userRoutes('admin'),
      'PATCH /api/users/u2': { status: 200, body: { ...user('u2', 'deployer', 'Sam'), disabled: true } },
    });
    wrap(<Users />);
    await userEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    expect(await screen.findByText('Disabled')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ disabled: true });
  });
});

describe('accepting an invite', () => {
  it('email and role → name and password → authenticator → code → account ready', async () => {
    const t = `inv_${'c'.repeat(43)}`;
    const calls = mockFetch({
      [`GET /api/invites/${t}`]: { status: 200, body: { email: 'new@example.com', role: 'viewer', expired: false } },
      [`POST /api/invites/${t}/accept`]: {
        status: 200,
        body: { email: 'new@example.com', role: 'viewer', otpauthUri: 'otpauth://totp/Shipyard:new?secret=ABCDEF', secret: 'ABCDEF' },
      },
      [`POST /api/invites/${t}/confirm-totp`]: { status: 200, body: { ok: true, email: 'new@example.com' } },
    });
    render(
      <ThemeProvider storageKey="test.theme" defaultPreference="light">
        <MemoryRouter initialEntries={[`/invite/${t}`]}>
          <Routes>
            <Route path="/invite/:token" element={<AcceptInvite />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>,
    );
    expect(await screen.findByText('new@example.com')).toBeInTheDocument();
    expect(screen.getByText('viewer')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Display name'), 'New Person');
    await userEvent.type(screen.getByLabelText('Password', { selector: 'input' }), 'a long enough password');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('ABCDEF')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add to authenticator' })).toHaveAttribute(
      'href',
      'otpauth://totp/Shipyard:new?secret=ABCDEF',
    );
    await userEvent.type(screen.getByLabelText('Authenticator code'), '123456');
    expect(await screen.findByText('Account ready, sign in')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/signin');
    expect(calls.find((c) => c.path.endsWith('/accept'))?.body).toEqual({
      displayName: 'New Person',
      password: 'a long enough password',
    });
    expect(calls.find((c) => c.path.endsWith('/confirm-totp'))?.body).toEqual({ code: '123456' });
  });

  it('an unknown or used link says so', async () => {
    mockFetch({
      'GET /api/invites/inv_bad': {
        status: 404,
        body: {
          error: {
            code: 'not_found',
            gate: 'none',
            message: 'This invite link is not valid: it is unknown, revoked or already used.',
            fix: 'Ask whoever invited you for a new invite link.',
          },
        },
      },
    });
    render(
      <ThemeProvider storageKey="test.theme" defaultPreference="light">
        <MemoryRouter initialEntries={['/invite/inv_bad']}>
          <Routes>
            <Route path="/invite/:token" element={<AcceptInvite />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>,
    );
    expect(await screen.findByText(/This invite link is not valid/)).toBeInTheDocument();
  });
});
