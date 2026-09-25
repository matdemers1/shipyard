import { ThemeProvider, TooltipProvider } from '@d3cloud/ui';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { D3AuthSettings, MailSettings } from '@shipyard/schema';
import { AuthProvider } from '../src/lib/auth';
import { Settings } from '../src/screens/Settings';
import { meReply, mockFetch, type Reply } from './fetch';

/** Settings → Alert email (SHP-T-6.9, SHP-REQ-093). */

function wrap() {
  return render(
    <ThemeProvider storageKey="test.theme" defaultPreference="light">
      <TooltipProvider>
        <MemoryRouter initialEntries={['/settings']}>
          <AuthProvider>
            <Settings />
          </AuthProvider>
        </MemoryRouter>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

const D3AUTH_OFF: D3AuthSettings = {
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
};

function mail(overrides: Partial<MailSettings> = {}): MailSettings {
  return {
    source: 'none',
    relayUrl: null,
    tokenSet: false,
    alertTo: null,
    active: false,
    canStoreSecret: true,
    problem: null,
    updatedAt: null,
    ...overrides,
  };
}

const ON = mail({
  source: 'settings',
  relayUrl: 'https://relay.example.com/send',
  tokenSet: true,
  alertTo: 'ops@example.com',
  active: true,
  updatedAt: '2026-09-25T12:00:00.000Z',
});

function routes(current: MailSettings, extra: Record<string, Reply | Reply[]> = {}): Record<string, Reply | Reply[]> {
  return {
    'GET /api/auth/me': meReply('admin'),
    'GET /api/settings/d3auth': { status: 200, body: D3AUTH_OFF },
    'GET /api/settings/mail': { status: 200, body: current },
    ...extra,
  };
}

const form = () => screen.getByRole('form', { name: 'Alert email' });

describe('Settings → Alert email', () => {
  it('shows it off, says what triggers alerts and where the relay comes from, and cannot test yet', async () => {
    mockFetch(routes(mail()));
    wrap();
    expect(await screen.findByText('Alerts off')).toBeInTheDocument();
    expect(screen.getByText(/silent for more than five minutes, or a nightly backup or restore drill fails/)).toBeInTheDocument();
    expect(screen.getByText(/relay is D3 Auth's mail-relay Worker: its URL and secret are in that Worker's settings/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send test email' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save alert email' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Turn off alert email' })).not.toBeInTheDocument();
  });

  it('saves the relay, token and recipient, then forgets the token', async () => {
    const calls = mockFetch(routes(mail(), { 'PUT /api/settings/mail': { status: 200, body: ON } }));
    wrap();
    await screen.findByText('Alerts off');
    const user = userEvent.setup();
    await user.type(within(form()).getByRole('textbox', { name: /^Relay URL/ }), 'https://relay.example.com/send');
    await user.type(within(form()).getByLabelText(/^Relay token/), 'the-token');
    await user.type(within(form()).getByRole('textbox', { name: /^Recipient/ }), 'ops@example.com');
    await user.click(screen.getByRole('button', { name: 'Save alert email' }));

    expect(await screen.findByText('Alert email saved')).toBeInTheDocument();
    expect(screen.getByText(/no restart needed/)).toBeInTheDocument();
    expect(screen.getByText('Alerts on')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PUT' && c.path === '/api/settings/mail')?.body).toEqual({
      relayUrl: 'https://relay.example.com/send',
      token: 'the-token',
      alertTo: 'ops@example.com',
    });
    expect(within(form()).getByLabelText(/^Relay token/)).toHaveValue('');
    expect(screen.getByText(/A token is stored/)).toBeInTheDocument();
  });

  it('keeps a stored token when the field is left blank', async () => {
    const calls = mockFetch(routes(ON, { 'PUT /api/settings/mail': { status: 200, body: ON } }));
    wrap();
    expect(await screen.findByRole('textbox', { name: /^Relay URL/ })).toHaveValue('https://relay.example.com/send');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save alert email' }));
    await screen.findByText('Alert email saved');
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ relayUrl: 'https://relay.example.com/send', alertTo: 'ops@example.com' });
  });

  it("sends a test email and shows the relay's answer, sent or refused", async () => {
    const calls = mockFetch(
      routes(ON, {
        'POST /api/settings/mail/test': [
          { status: 200, body: { sent: true, status: 202 } },
          { status: 200, body: { sent: false, status: 401, detail: '{"error":"unauthorized"}' } },
        ],
      }),
    );
    wrap();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Send test email' }));
    expect(await screen.findByText('The relay accepted the test message')).toBeInTheDocument();
    expect(screen.getByText(/HTTP 202 — check ops@example.com/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Send test email' }));
    expect(await screen.findByText('The relay did not send it')).toBeInTheDocument();
    expect(screen.getByText('HTTP 401: {"error":"unauthorized"}')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('turns it off after a confirmation', async () => {
    const calls = mockFetch(routes(ON, { 'DELETE /api/settings/mail': { status: 200, body: mail() } }));
    wrap();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Turn off alert email' }));
    const dialog = await screen.findByRole('dialog', { name: 'Turn off alert email?' });
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByText('Alert email turned off')).toBeInTheDocument();
    expect(screen.getByText('Alerts off')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/settings/mail')).toBe(true);
  });

  it('shows server.env settings read-only, and still offers a test', async () => {
    mockFetch(routes({ ...ON, source: 'env', updatedAt: null }));
    wrap();
    expect(await screen.findByText(/MAIL_RELAY_URL, MAIL_RELAY_TOKEN and ALERT_TO in server.env win/)).toBeInTheDocument();
    expect(screen.getByText('https://relay.example.com/send')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save alert email' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Alert email' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send test email' })).toBeEnabled();
  });

  it('says why a saved relay cannot send', async () => {
    mockFetch(routes({ ...ON, active: false, problem: 'The stored relay token cannot be read: SESSION_SECRET is unset in server.env.' }));
    wrap();
    expect(await screen.findByText('Configured, but alert email cannot send')).toBeInTheDocument();
    expect(screen.getByText(/SESSION_SECRET is unset in server\.env\.$/)).toBeInTheDocument();
  });

  it('shows a refusal from the server', async () => {
    mockFetch(
      routes(ON, {
        'PUT /api/settings/mail': {
          status: 400,
          body: { error: { code: 'invalid_request', gate: 'none', message: 'The relay URL changed, and the stored token was saved for the old one.', fix: 'Paste the token.' } },
        },
      }),
    );
    wrap();
    const user = userEvent.setup();
    const url = await screen.findByRole('textbox', { name: /^Relay URL/ });
    await user.clear(url);
    await user.type(url, 'https://other.example.com/send');
    await user.click(screen.getByRole('button', { name: 'Save alert email' }));
    expect(await screen.findByText(/The relay URL changed/)).toBeInTheDocument();
  });
});
