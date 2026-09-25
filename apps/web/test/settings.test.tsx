import { ThemeProvider, TooltipProvider } from '@d3cloud/ui';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { D3AuthSettings } from '@shipyard/schema';
import { App } from '../src/App';
import { AuthProvider } from '../src/lib/auth';
import { Settings } from '../src/screens/Settings';
import { meReply, mockFetch, type Reply } from './fetch';

/** Settings → Sign in with D3 Auth (SHP-T-6.8, SHP-REQ-110). */

function wrap(children: ReactNode) {
  return render(
    <ThemeProvider storageKey="test.theme" defaultPreference="light">
      <TooltipProvider>
        <MemoryRouter initialEntries={['/settings']}>
          <AuthProvider>{children}</AuthProvider>
        </MemoryRouter>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

const REDIRECT = 'http://localhost/api/auth/oidc/callback';

function settings(overrides: Partial<D3AuthSettings> = {}): D3AuthSettings {
  return {
    source: 'none',
    issuer: null,
    clientId: null,
    clientSecretSet: false,
    redirectUri: REDIRECT,
    available: false,
    reachable: null,
    canStoreSecret: true,
    problem: null,
    manifest: { client_id: 'shipyard', redirect_uris: [REDIRECT] },
    updatedAt: null,
    ...overrides,
  };
}

const ON = settings({
  source: 'settings',
  issuer: 'https://auth.example.com',
  clientId: 'shipyard',
  clientSecretSet: true,
  available: true,
  reachable: true,
  updatedAt: '2026-09-25T12:00:00.000Z',
});

function routes(extra: Record<string, Reply | Reply[]> = {}, current: D3AuthSettings = settings()): Record<string, Reply | Reply[]> {
  return {
    'GET /api/auth/me': meReply('admin'),
    'GET /api/settings/d3auth': { status: 200, body: current },
    ...extra,
  };
}

describe('Settings screen', () => {
  it('shows D3 Auth off, the redirect URI to copy and the manifest to download', async () => {
    mockFetch(routes());
    wrap(<Settings />);
    expect(await screen.findByText('Off')).toBeInTheDocument();
    expect(screen.getByText(REDIRECT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy redirect URI' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download app manifest' })).toBeInTheDocument();
    expect(screen.getByText(/Apps → Add an app → upload this file/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn off' })).not.toBeInTheDocument();
  });

  it('saves the issuer, client ID and secret, then shows it on without a restart and forgets the secret', async () => {
    const calls = mockFetch(routes({ 'PUT /api/settings/d3auth': { status: 200, body: ON } }));
    wrap(<Settings />);
    await screen.findByText('Off');
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Issuer' }), 'https://auth.example.com');
    await user.type(screen.getByLabelText(/^Client secret/), 'the-secret');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.getByText(/no restart needed/)).toBeInTheDocument();
    expect(screen.getByText('On')).toBeInTheDocument();
    const saved = calls.find((c) => c.method === 'PUT');
    expect(saved?.body).toEqual({ issuer: 'https://auth.example.com', clientId: 'shipyard', clientSecret: 'the-secret' });
    // The field is empty again: the secret is not kept in the page.
    expect(screen.getByLabelText(/^Client secret/)).toHaveValue('');
    expect(screen.getByText(/A secret is stored/)).toBeInTheDocument();
  });

  it('keeps a stored secret when the field is left blank', async () => {
    const calls = mockFetch(routes({ 'PUT /api/settings/d3auth': { status: 200, body: ON } }, ON));
    wrap(<Settings />);
    expect(await screen.findByRole('textbox', { name: 'Issuer' })).toHaveValue('https://auth.example.com');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved');
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ issuer: 'https://auth.example.com', clientId: 'shipyard' });
  });

  it('says why a saved issuer is not live', async () => {
    mockFetch(routes({}, { ...ON, available: false, reachable: false, problem: 'The issuer did not answer OpenID discovery.' }));
    wrap(<Settings />);
    expect(await screen.findByText('Configured, but the D3 Auth button is off')).toBeInTheDocument();
    expect(screen.getByText('The issuer did not answer OpenID discovery.')).toBeInTheDocument();
  });

  it('tests the issuer and shows what discovery said', async () => {
    const calls = mockFetch(
      routes({
        'POST /api/settings/d3auth/test': {
          status: 200,
          body: {
            ok: false,
            issuer: 'https://auth.example.com',
            discoveredIssuer: 'https://other.example.com',
            issuerMatches: false,
            authorizationEndpoint: null,
            tokenEndpoint: null,
            jwksUri: null,
            error: 'The discovery document names the issuer https://other.example.com; use exactly that.',
          },
        },
      }),
    );
    wrap(<Settings />);
    await screen.findByText('Off');
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Issuer' }), 'https://auth.example.com');
    await user.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('The issuer did not pass')).toBeInTheDocument();
    expect(screen.getByText(/use exactly that/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ issuer: 'https://auth.example.com' });
  });

  it('turns D3 Auth off after a confirmation', async () => {
    const calls = mockFetch(routes({ 'DELETE /api/settings/d3auth': { status: 200, body: settings() } }, ON));
    wrap(<Settings />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Turn off' }));
    const dialog = await screen.findByRole('dialog', { name: 'Turn off Sign in with D3 Auth?' });
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByText('Turned off')).toBeInTheDocument();
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('shows server.env settings read-only, with no way to change them here', async () => {
    mockFetch(routes({}, { ...ON, source: 'env', updatedAt: null }));
    wrap(<Settings />);
    expect(await screen.findByText('Set in server.env')).toBeInTheDocument();
    expect(screen.getByText('https://auth.example.com')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Issuer' })).not.toBeInTheDocument();
  });

  it('shows a refusal from the server', async () => {
    mockFetch(
      routes({
        'PUT /api/settings/d3auth': {
          status: 409,
          body: { error: { code: 'conflict', gate: 'none', message: 'Shipyard cannot store a client secret while SESSION_SECRET is unset.', fix: 'Set SESSION_SECRET.' } },
        },
      }),
    );
    wrap(<Settings />);
    await screen.findByText('Off');
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Issuer' }), 'https://auth.example.com');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/SESSION_SECRET is unset/)).toBeInTheDocument();
  });
});

describe('Settings is admin-only in the console', () => {
  function renderAt(path: string) {
    window.history.replaceState(null, '', path);
    return render(<App />);
  }

  it('offers Settings in the nav to an admin', async () => {
    mockFetch(routes());
    renderAt('/');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });

  it.each(['deployer', 'operator', 'viewer'] as const)('hides Settings from a %s, and refuses the typed address', async (role) => {
    mockFetch({ 'GET /api/auth/me': meReply(role) });
    renderAt('/settings');
    expect(await screen.findByText('This page needs the admin role')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });
});
