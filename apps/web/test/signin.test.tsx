import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { NOT_SIGNED_IN, meReply, mockFetch } from './fetch';

/** S1 Sign in (SHP-REQ-001): password → TOTP → session, and D3 Auth only when the server has it. */

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(<App />);
}

async function fillPassword(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Email'), 'matt@example.com');
  await user.type(screen.getByLabelText('Password'), 'hunter2hunter2');
  await user.click(screen.getByRole('button', { name: 'Continue' }));
}

describe('sign-in', () => {
  it('goes password → TOTP → me → home', async () => {
    const calls = mockFetch({
      'GET /api/auth/me': [NOT_SIGNED_IN, meReply('admin')],
      'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: false } },
      'POST /api/auth/login': { status: 200, body: { next: 'totp' } },
      'POST /api/auth/totp': { status: 200, body: { id: 'u1', email: 'matt@example.com', displayName: 'Matt', role: 'admin' } },
    });
    const user = userEvent.setup();
    renderAt('/');

    await fillPassword(user);
    const code = await screen.findByLabelText('Authenticator code');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(code).toHaveAttribute('inputmode', 'numeric');
    await user.type(code, '123456');

    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/auth/login')?.body).toEqual({
      email: 'matt@example.com',
      password: 'hunter2hunter2',
    });
    const totp = calls.filter((c) => c.path === '/api/auth/totp');
    expect(totp).toHaveLength(1);
    expect(totp[0]?.body).toEqual({ code: '123456' });
    expect(screen.getByText('matt@example.com', { selector: '.shp-topline__who' })).toBeInTheDocument();
  });

  it('returns to the page that was asked for', async () => {
    mockFetch({
      'GET /api/auth/me': [NOT_SIGNED_IN, meReply('admin')],
      'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: false } },
      'POST /api/auth/login': { status: 200, body: { next: 'totp' } },
      'POST /api/auth/totp': { status: 200, body: {} },
    });
    const user = userEvent.setup();
    renderAt('/timeline');
    await fillPassword(user);
    await user.type(await screen.findByLabelText('Authenticator code'), '654321');
    expect(await screen.findByRole('heading', { level: 1, name: 'Timeline' })).toBeInTheDocument();
  });

  it('shows the refusal message and its fix for wrong credentials, and stays on sign-in', async () => {
    mockFetch({
      'GET /api/auth/me': NOT_SIGNED_IN,
      'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: false } },
      'POST /api/auth/login': {
        status: 401,
        body: {
          error: {
            code: 'unauthenticated',
            gate: 'none',
            message: 'The email or password is wrong.',
            fix: 'Check both and try again.',
          },
        },
      },
    });
    const user = userEvent.setup();
    renderAt('/');
    await fillPassword(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The email or password is wrong.');
    expect(alert).toHaveTextContent('Check both and try again.');
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('shows the fix when sign-in is throttled (429)', async () => {
    mockFetch({
      'GET /api/auth/me': NOT_SIGNED_IN,
      'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: false } },
      'POST /api/auth/login': {
        status: 429,
        body: {
          error: {
            code: 'too_many_attempts',
            gate: 'none',
            message: 'Too many failed sign-in attempts. Sign-in is paused for a while.',
            fix: 'Wait for the cooling-off period (up to fifteen minutes), then try again.',
          },
        },
      },
    });
    const user = userEvent.setup();
    renderAt('/');
    await fillPassword(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Wait for the cooling-off period (up to fifteen minutes), then try again.',
    );
  });

  it('shows a wrong TOTP code as its refusal and lets the person retry', async () => {
    mockFetch({
      'GET /api/auth/me': NOT_SIGNED_IN,
      'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: false } },
      'POST /api/auth/login': { status: 200, body: { next: 'totp' } },
      'POST /api/auth/totp': {
        status: 401,
        body: {
          error: {
            code: 'unauthenticated',
            gate: 'none',
            message: 'The authenticator code is wrong or has already been used.',
            fix: 'Enter the current code from your authenticator app.',
          },
        },
      },
    });
    const user = userEvent.setup();
    renderAt('/');
    await fillPassword(user);
    await user.type(await screen.findByLabelText('Authenticator code'), '000000');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The authenticator code is wrong or has already been used.');
    expect(alert).toHaveTextContent('Enter the current code from your authenticator app.');
    // Still on the code step, not bounced to the password form by the 401.
    expect(screen.getByLabelText('Authenticator code')).toHaveValue('');
  });

  it('hides Sign in with D3 Auth when the server does not offer it', async () => {
    mockFetch({
      'GET /api/auth/me': NOT_SIGNED_IN,
      'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: false } },
    });
    renderAt('/');
    await screen.findByLabelText('Email');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Sign in with D3 Auth' })).not.toBeInTheDocument();
    });
  });

  it('shows Sign in with D3 Auth when the server offers it', async () => {
    mockFetch({
      'GET /api/auth/me': NOT_SIGNED_IN,
      'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: true } },
    });
    renderAt('/');
    expect(await screen.findByRole('button', { name: 'Sign in with D3 Auth' })).toBeInTheDocument();
  });

  it('keeps the password form working when the methods call fails', async () => {
    mockFetch({
      'GET /api/auth/me': [NOT_SIGNED_IN, meReply('admin')],
      'GET /api/auth/methods': { status: 503 },
      'POST /api/auth/login': { status: 200, body: { next: 'totp' } },
      'POST /api/auth/totp': { status: 200, body: {} },
    });
    const user = userEvent.setup();
    renderAt('/');
    await fillPassword(user);
    await user.type(await screen.findByLabelText('Authenticator code'), '123456');
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in with D3 Auth' })).not.toBeInTheDocument();
  });

  it('labels every sign-in input', async () => {
    mockFetch({
      'GET /api/auth/me': NOT_SIGNED_IN,
      'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: true } },
    });
    const { container } = renderAt('/');
    await screen.findByLabelText('Email');
    for (const input of container.querySelectorAll('input')) {
      if (input.type === 'hidden') continue;
      expect(input.labels?.length ?? 0, `unlabelled input ${input.name}`).toBeGreaterThan(0);
    }
  });
});
