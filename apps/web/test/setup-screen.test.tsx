import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { NOT_SIGNED_IN, SETUP_OPEN, meReply, mockFetch } from './fetch';

/** First-run setup (SHP-REQ-109): a server with no account offers setup instead of sign-in. */

const STARTED = {
  status: 200,
  body: {
    ticket: `stp_${'a'.repeat(43)}`,
    otpauthUri: 'otpauth://totp/Shipyard:first%40example.com?issuer=Shipyard&secret=JBSWY3DPEHPK3PXP',
    secret: 'JBSWY3DPEHPK3PXP',
    expiresAt: '2026-09-25T12:10:00.000Z',
  },
};

const CLAIMED = {
  status: 409,
  body: {
    error: {
      code: 'conflict',
      gate: 'none',
      message: 'Shipyard already has an account; sign in.',
      fix: 'First-run setup only creates the first account. Sign in, or ask an admin for an invite.',
    },
  },
};

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(<App />);
}

async function fillDetails(user: ReturnType<typeof userEvent.setup>, confirm = 'correct horse battery') {
  await user.type(await screen.findByLabelText('Email'), 'first@example.com');
  await user.type(screen.getByLabelText('Display name'), 'First Admin');
  await user.type(screen.getByLabelText('Password'), 'correct horse battery');
  await user.type(screen.getByLabelText('Confirm password'), confirm);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
}

describe('first-run setup', () => {
  for (const path of ['/', '/signin']) {
    it(`routes ${path} to setup while no account exists`, async () => {
      mockFetch({ 'GET /api/auth/me': NOT_SIGNED_IN, 'GET /api/setup': SETUP_OPEN });
      renderAt(path);
      expect(await screen.findByRole('heading', { level: 1, name: 'Set up Shipyard' })).toBeInTheDocument();
      expect(window.location.pathname).toBe('/setup');
      expect(screen.getByText(/anyone who can reach this address can create the first account/)).toBeInTheDocument();
      expect(screen.queryByText(/bootstrap-admin/)).not.toBeInTheDocument();
    });
  }

  it('shows sign-in, not setup, once an account exists', async () => {
    mockFetch({
      'GET /api/auth/me': NOT_SIGNED_IN,
      'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: false } },
    });
    renderAt('/setup');
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in to Shipyard' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/signin');
  });

  it('goes details → authenticator → signed in at home', async () => {
    const calls = mockFetch({
      'GET /api/auth/me': [NOT_SIGNED_IN, meReply('admin', { email: 'first@example.com' })],
      'GET /api/setup': SETUP_OPEN,
      'POST /api/setup/start': STARTED,
      'POST /api/setup/complete': {
        status: 201,
        body: { id: 'u1', email: 'first@example.com', displayName: 'First Admin', role: 'admin' },
      },
    });
    const user = userEvent.setup();
    renderAt('/');
    await fillDetails(user);

    expect(await screen.findByRole('heading', { level: 1, name: 'Add your authenticator' })).toBeInTheDocument();
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add to authenticator' })).toHaveAttribute('href', STARTED.body.otpauthUri);
    const code = screen.getByLabelText('Authenticator code');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    await user.type(code, '123456');

    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/setup/start')?.body).toEqual({
      email: 'first@example.com',
      displayName: 'First Admin',
      password: 'correct horse battery',
    });
    expect(calls.find((c) => c.path === '/api/setup/complete')?.body).toEqual({ ticket: STARTED.body.ticket, code: '123456' });
  });

  it('refuses to start with mismatched passwords, without calling the server', async () => {
    const calls = mockFetch({ 'GET /api/auth/me': NOT_SIGNED_IN, 'GET /api/setup': SETUP_OPEN });
    const user = userEvent.setup();
    renderAt('/setup');
    await fillDetails(user, 'something else entirely');
    expect(await screen.findByText('The two passwords differ. Type the same one twice.')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/setup/start')).toBe(false);
  });

  it('shows a wrong code as its refusal and stays on the code step', async () => {
    mockFetch({
      'GET /api/auth/me': NOT_SIGNED_IN,
      'GET /api/setup': SETUP_OPEN,
      'POST /api/setup/start': STARTED,
      'POST /api/setup/complete': {
        status: 401,
        body: {
          error: {
            code: 'unauthenticated',
            gate: 'none',
            message: 'The authenticator code is wrong.',
            fix: 'Enter the current six-digit code from the authenticator you just added.',
          },
        },
      },
    });
    const user = userEvent.setup();
    renderAt('/setup');
    await fillDetails(user);
    await user.type(await screen.findByLabelText('Authenticator code'), '000000');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The authenticator code is wrong.');
    expect(screen.getByLabelText('Authenticator code')).toHaveValue('');
  });

  it('says so when someone else claimed the server first, and leads to sign-in', async () => {
    mockFetch({
      'GET /api/auth/me': NOT_SIGNED_IN,
      'GET /api/setup': [SETUP_OPEN, { status: 200, body: { available: false } }],
      'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: false } },
      'POST /api/setup/start': STARTED,
      'POST /api/setup/complete': CLAIMED,
    });
    const user = userEvent.setup();
    renderAt('/setup');
    await fillDetails(user);
    await user.type(await screen.findByLabelText('Authenticator code'), '123456');
    expect(await screen.findByText('Shipyard already has an account; sign in.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Go to sign-in' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in to Shipyard' })).toBeInTheDocument();
  });

  it('labels every setup input', async () => {
    mockFetch({ 'GET /api/auth/me': NOT_SIGNED_IN, 'GET /api/setup': SETUP_OPEN });
    const { container } = renderAt('/setup');
    await screen.findByLabelText('Email');
    for (const input of container.querySelectorAll('input')) {
      if (input.type === 'hidden') continue;
      expect(input.labels?.length ?? 0, `unlabelled input ${input.name}`).toBeGreaterThan(0);
    }
  });
});
