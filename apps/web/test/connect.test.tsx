import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { claudeAddCommand, DEPLOY_SNIPPET, deploySnippetFor, envLine, mcpJsonWithEnv } from '../src/lib/connect';
import { CONNECT_POLL_MS } from '../src/screens/Connect';
import { meReply, mockFetch } from './fetch';

/**
 * Connect Claude Code (SHP-T-3.12): the exact strings a person copies, a deployer's path from a
 * scoped token to "connected", and a viewer's read-only view.
 */

const TOKEN = 'shp_live_abc123';

describe('connect strings', () => {
  it('adds the server for every repo with the token in a header, at /mcp', () => {
    expect(claudeAddCommand('https://shipyard.example/', TOKEN)).toBe(
      `claude mcp add --transport http --scope user shipyard https://shipyard.example/mcp --header "Authorization: Bearer ${TOKEN}"`,
    );
  });

  it('writes a .mcp.json that reads the token from the environment and never holds it', () => {
    const json = mcpJsonWithEnv('https://shipyard.example');
    expect(JSON.parse(json)).toEqual({
      mcpServers: {
        shipyard: { type: 'http', url: 'https://shipyard.example/mcp', headers: { Authorization: 'Bearer ${SHIPYARD_TOKEN}' } },
      },
    });
    expect(envLine(TOKEN)).toBe(`export SHIPYARD_TOKEN=${TOKEN}`);
  });

  it('serves the CLAUDE.md snippet from docs/claude without its file comment', () => {
    expect(DEPLOY_SNIPPET.startsWith('## Deploying — through Shipyard, never by hand')).toBe(true);
    expect(DEPLOY_SNIPPET).toContain('shipyard_deploy');
  });

  it("names this Shipyard's own origin in the snippet", () => {
    const snippet = deploySnippetFor('https://ship.example.com/');
    expect(snippet).toContain('`https://ship.example.com/mcp`');
    expect(snippet).not.toContain('shipyard.d3cloud.io');
  });
});

function tokenRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 't-new',
    userId: 'u1',
    label: 'Claude Code',
    prefix: 'shp_live_abc',
    apps: ['api', 'web'],
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    lastUsedIp: null,
    revokedAt: null,
    ...overrides,
  };
}

const APPS = { status: 200, body: { apps: [{ name: 'web' }, { name: 'api' }] } };

afterEach(() => {
  vi.useRealTimers();
});

describe('Connect page', () => {
  it('makes a token for all apps, puts it in the command, and turns green on its first call', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const calls = mockFetch({
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: false } },
      'GET /api/apps': APPS,
      // /connect now lands on Settings › Claude & tokens, where the token list reads once on mount
      // before Connect's own reads (SHP-T-13.5's interim section; SHP-T-13.6 replaces it).
      'GET /api/tokens': [
        { status: 200, body: [] },
        { status: 200, body: [] },
        { status: 200, body: [tokenRow()] },
        { status: 200, body: [tokenRow({ lastUsedAt: new Date().toISOString(), lastUsedIp: '10.0.0.9' })] },
      ],
      'POST /api/tokens': {
        status: 201,
        body: { id: 't-new', label: 'Claude Code', prefix: 'shp_live_abc', apps: ['api', 'web'], token: TOKEN },
      },
    });
    window.history.replaceState(null, '', '/connect');
    render(<App />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('checkbox', { name: 'All apps' }, { timeout: 4000 }));
    await user.click(screen.getByRole('button', { name: 'Make the token' }));

    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ label: 'Claude Code', apps: ['web', 'api'] });
    expect(await screen.findByText(/--header "Authorization: Bearer shp_live_abc123"/)).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Waiting for Claude Code’s first call' })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONNECT_POLL_MS * 2);
    });
    const connected = await screen.findByText('Claude Code is connected');
    expect(connected.closest('[role="status"], [role="alert"], div')).toHaveTextContent(/from 10\.0\.0\.9/);
  });

  it('shows a viewer the steps but no way to make a token', async () => {
    mockFetch({
      'GET /api/auth/me': meReply('viewer'),
      'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: false } },
      'GET /api/apps': APPS,
      'GET /api/tokens': { status: 200, body: [] },
    });
    window.history.replaceState(null, '', '/connect');
    render(<App />);
    expect(await screen.findByText('A deployer makes the token', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Make the token' })).not.toBeInTheDocument();
    const tools = screen.getByRole('list', { name: 'MCP tools' });
    expect(within(tools).getByText('shipyard_deploy')).toBeInTheDocument();
    expect(screen.getByText(/<your token>/)).toBeInTheDocument();
  });
});
