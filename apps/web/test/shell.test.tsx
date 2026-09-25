import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { App } from '../src/App';
import { request } from '../src/lib/api';
import { AuthProvider, useCan } from '../src/lib/auth';
import { meReply, mockFetch, NOT_SIGNED_IN } from './fetch';
import { viewport } from './setup';

/** The shell: role-aware navigation (SHP-REQ-105), 401 → sign-in, the phone layout. */

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(<App />);
}

const wrapper = ({ children }: { children: ReactNode }) => <AuthProvider>{children}</AuthProvider>;

describe('role-aware navigation', () => {
  it("hides Tokens, Agent and Users from a viewer, and useCan() is false", async () => {
    mockFetch({ 'GET /api/auth/me': meReply('viewer') });
    renderAt('/');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Timeline' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'API tokens' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Agent' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();

    const { result } = renderHook(() => useCan(), { wrapper });
    await waitFor(() => {
      expect(result.current).toBe(false);
    });
  });

  it.each(['deployer', 'operator', 'admin'] as const)('shows Tokens, Agent and Users to %s, and useCan() is true', async (role) => {
    mockFetch({ 'GET /api/auth/me': meReply(role) });
    renderAt('/');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'API tokens' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Agent' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Users' })).toBeInTheDocument();

    const { result } = renderHook(() => useCan(), { wrapper });
    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  it('refuses a viewer who types the tokens address', async () => {
    mockFetch({ 'GET /api/auth/me': meReply('viewer') });
    renderAt('/tokens');
    expect(await screen.findByText('This page needs the deployer role')).toBeInTheDocument();
  });

  it('useCan() is false when nobody is signed in', async () => {
    mockFetch({ 'GET /api/auth/me': NOT_SIGNED_IN });
    const { result } = renderHook(() => useCan(), { wrapper });
    await waitFor(() => {
      expect(result.current).toBe(false);
    });
  });
});

describe('session', () => {
  it('sends a 401 on me to sign-in', async () => {
    mockFetch({
      'GET /api/auth/me': NOT_SIGNED_IN,
      'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: false } },
    });
    renderAt('/timeline');
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in to Shipyard' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/signin');
  });

  it('sends the person to sign-in when a later call finds the session gone', async () => {
    mockFetch({
      'GET /api/auth/me': meReply('admin'),
      'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: false } },
      'GET /api/apps': NOT_SIGNED_IN,
    });
    renderAt('/');
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    await act(async () => {
      await request('/api/apps').catch(() => undefined);
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in to Shipyard' })).toBeInTheDocument();
  });

  it('shows who is signed in and signs out from Account', async () => {
    const calls = mockFetch({
      'GET /api/auth/me': meReply('deployer', { identities: [{ issuer: 'https://auth.d3cloud.io' }] }),
      'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: true } },
      'POST /api/auth/logout': { status: 200, body: { ok: true } },
    });
    const user = userEvent.setup();
    renderAt('/account');
    await screen.findByRole('heading', { level: 1, name: 'Account' });
    expect(screen.getByText('deployer')).toBeInTheDocument();
    expect(screen.getByText('https://auth.d3cloud.io')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in to Shipyard' })).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/auth/logout')).toBe(true);
  });

  it('says the server is not answering, with a fix, when me cannot be reached', async () => {
    mockFetch({ 'GET /api/auth/me': () => { throw new TypeError('Failed to fetch'); } });
    renderAt('/');
    expect(await screen.findByText('Shipyard is not answering.')).toBeInTheDocument();
    expect(screen.getByText('Check that the server is running and reachable, then try again.')).toBeInTheDocument();
  });
});

describe('phone layout', () => {
  it('collapses the nav behind a menu button below lg, and keeps the skip link and theme toggle', async () => {
    viewport.desktop = false;
    mockFetch({ 'GET /api/auth/me': meReply('viewer') });
    const user = userEvent.setup();
    renderAt('/');
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /skip to content/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /switch to (light|dark) theme/i })).toBeInTheDocument();

    const menus = screen.getAllByRole('button', { name: /menu|navigation/i });
    await user.click(menus[0] as HTMLElement);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Timeline' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
  });

  it('toggles the theme on <html>', async () => {
    mockFetch({ 'GET /api/auth/me': meReply('admin') });
    const user = userEvent.setup();
    renderAt('/');
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    const before = document.documentElement.getAttribute('data-theme');
    await user.click(screen.getByRole('button', { name: /switch to (light|dark) theme/i }));
    const after = document.documentElement.getAttribute('data-theme');
    expect(after).not.toBe(before);
    expect(['light', 'dark']).toContain(after);
  });
});
