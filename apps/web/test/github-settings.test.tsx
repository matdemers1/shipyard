import { ThemeProvider, TooltipProvider } from '@d3cloud/ui';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { GitHubSettings } from '@shipyard/schema';
import { App } from '../src/App';
import { AuthProvider } from '../src/lib/auth';
import { GitHubSettingsSection } from '../src/screens/GitHubSettings';
import { meReply, mockFetch, type Reply } from './fetch';

/** Settings › Integrations › GitHub (SHP-T-3.13), and Home's banner when GitHub is not answering. */

function wrap() {
  return render(
    <ThemeProvider storageKey="test.theme" defaultPreference="light">
      <TooltipProvider>
        <MemoryRouter initialEntries={['/settings']}>
          <AuthProvider>
            <GitHubSettingsSection />
          </AuthProvider>
        </MemoryRouter>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

const RESET = new Date(Date.now() + 30 * 60_000).toISOString();
const TOKEN = 'github_pat_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function github(overrides: Partial<GitHubSettings> = {}): GitHubSettings {
  return {
    source: 'none',
    tokenSet: false,
    canStoreSecret: true,
    problem: null,
    updatedAt: null,
    rateLimit: { authenticated: false, limit: 60, remaining: 0, resetAt: RESET },
    rateLimitProblem: null,
    ...overrides,
  };
}

const WITH_TOKEN = github({
  source: 'settings',
  tokenSet: true,
  updatedAt: '2026-09-29T12:00:00.000Z',
  rateLimit: { authenticated: true, limit: 5000, remaining: 4990, resetAt: RESET },
});

function routes(current: GitHubSettings, extra: Record<string, Reply | Reply[]> = {}): Record<string, Reply | Reply[]> {
  return {
    'GET /api/auth/me': meReply('admin'),
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
    'GET /api/settings/github': { status: 200, body: current },
    ...extra,
  };
}

const form = () => screen.getByRole('form', { name: 'GitHub access' });

/** The card leads with GitHub's numbers; the token form opens in place. */
async function openForm() {
  const toggle = await screen.findByRole('button', { name: /^(Add a|Edit) GitHub token$/ });
  expect(screen.queryByRole('form', { name: 'GitHub access' })).not.toBeInTheDocument();
  await userEvent.setup().click(toggle);
}

describe('Settings → GitHub', () => {
  it('says the server is out of anonymous requests and what that means', async () => {
    mockFetch(routes(github()));
    wrap();
    expect(await screen.findByText('Out of GitHub requests')).toBeInTheDocument();
    expect(screen.getByText(/0 of 60 requests left this hour/)).toBeInTheDocument();
    expect(screen.getByText(/raises the limit to 5,000 an hour/)).toBeInTheDocument();
    await openForm();
    expect(within(form()).getByRole('button', { name: 'Save GitHub token' })).toBeDisabled();
  });

  it('tests a pasted token, saves it, and never shows it again', async () => {
    const calls = mockFetch(
      routes(github(), {
        'POST /api/settings/github/test': {
          status: 200,
          body: { ok: true, status: 200, rateLimit: { authenticated: true, limit: 5000, remaining: 5000, resetAt: RESET } },
        },
        'PUT /api/settings/github': { status: 200, body: WITH_TOKEN },
      }),
    );
    const user = userEvent.setup();
    wrap();
    await openForm();
    await user.type(await screen.findByLabelText('GitHub token'), TOKEN);
    await user.click(within(form()).getByRole('button', { name: 'Test this GitHub token' }));
    expect(await screen.findByText('GitHub accepted it')).toBeInTheDocument();
    await user.click(within(form()).getByRole('button', { name: 'Save GitHub token' }));
    expect(await screen.findByText('GitHub token saved')).toBeInTheDocument();
    expect(screen.getByText('Token in use')).toBeInTheDocument();
    expect(calls.filter((c) => c.method !== 'GET').map((c) => c.body)).toEqual([{ token: TOKEN }, { token: TOKEN }]);
    expect(screen.getByLabelText('GitHub token')).toHaveValue('');
  });

  it('says so when GitHub rejects a token', async () => {
    mockFetch(
      routes(github(), {
        'POST /api/settings/github/test': {
          status: 200,
          body: { ok: false, status: 401, detail: 'GitHub rejected the token (401): it is mistyped, expired or revoked.' },
        },
      }),
    );
    const user = userEvent.setup();
    wrap();
    await openForm();
    await user.type(await screen.findByLabelText('GitHub token'), TOKEN);
    await user.click(within(form()).getByRole('button', { name: 'Test this GitHub token' }));
    expect(await screen.findByText('GitHub did not accept it')).toBeInTheDocument();
    expect(screen.getByText(/mistyped, expired or revoked/)).toBeInTheDocument();
  });

  it('is read-only when server.env sets the token', async () => {
    mockFetch(routes(github({ source: 'env', tokenSet: true, rateLimit: WITH_TOKEN.rateLimit })));
    wrap();
    expect(await screen.findByText('Set in server.env')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'GitHub access' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /GitHub token$/ })).not.toBeInTheDocument();
  });
});

describe('Home when GitHub is not answering', () => {
  it('tells an admin and links to Settings → GitHub', async () => {
    mockFetch({
      'GET /api/auth/me': meReply('admin'),
      'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: false } },
      'GET /api/agent': { status: 200, body: [{ id: 'a1', confirmed: true, lastHeartbeatAt: new Date().toISOString(), stale: false }] },
      'GET /api/deploys': { status: 200, body: [] },
      'GET /api/groups': { status: 200, body: [] },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/apps': {
        status: 200,
        body: {
          apps: [
            {
              name: 'web',
              repo: 'matdemers1/web',
              liveSha: 'a'.repeat(40),
              reportedAt: null,
              drift: null,
              approvalPolicy: 'none',
              active: null,
            },
          ],
        },
      },
      'GET /api/apps/web/commits': {
        status: 200,
        body: { live: 'a'.repeat(40), head: null, commits: [], ahead: 0, newestGreen: null, source: 'unavailable', buildSource: 'github' },
      },
    });
    window.history.replaceState(null, '', '/');
    render(<App />);
    expect(await screen.findByText("Shipyard can't see new commits on GitHub", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Check GitHub access' })).toHaveAttribute('href', '/settings/integrations#github');
  });
});
