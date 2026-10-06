import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import type { Call } from './fetch';
import { meReply, mockFetch } from './fetch';
import type { TimelinePage } from '../src/lib/timeline';
import { stateWords } from '../src/lib/words';

/** SHP-T-3.7: the timeline (S8, SHP-REQ-062). */

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(<App />);
}

function page(items: TimelinePage['items'], nextCursor: string | null = null): { status: number; body: TimelinePage } {
  return { status: 200, body: { items, nextCursor } };
}

const WEB_SUCCEEDED = {
  deployId: 'd-1',
  kind: 'deploy' as const,
  app: 'web',
  sha: 'a'.repeat(40),
  dryRun: false,
  state: 'succeeded' as const,
  requesterLabel: 'Alice',
  createdAt: '2026-01-01T00:05:00.000Z',
  endedAt: '2026-01-01T00:06:00.000Z',
  refusalCode: null,
};

const API_REFUSED = {
  deployId: 'd-2',
  kind: 'deploy' as const,
  app: 'api',
  sha: 'b'.repeat(40),
  dryRun: false,
  state: 'refused' as const,
  requesterLabel: 'Bob',
  createdAt: '2026-01-01T00:04:00.000Z',
  endedAt: '2026-01-01T00:04:00.000Z',
  refusalCode: 'app_frozen',
};

describe('Timeline (S8)', () => {
  it('shows "No deploys yet" when there are none and no filters are set', async () => {
    mockFetch({
      'GET /api/auth/me': meReply('viewer'),
      'GET /api/apps': { status: 200, body: { apps: [{ name: 'web' }, { name: 'api' }] } },
      'GET /api/deploys/timeline': page([]),
    });
    renderAt('/timeline');
    expect(await screen.findByText('No deploys yet')).toBeInTheDocument();
  });

  it('lists deploys newest first, with an outcome badge, app, sha and requester', async () => {
    mockFetch({
      'GET /api/auth/me': meReply('viewer'),
      'GET /api/apps': { status: 200, body: { apps: [{ name: 'web' }, { name: 'api' }] } },
      'GET /api/deploys/timeline': page([WEB_SUCCEEDED, API_REFUSED]),
    });
    renderAt('/timeline');
    const list = await screen.findByRole('list', { name: 'Deploys' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText('Succeeded')).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText(/web/)).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Refused')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText(/app_frozen/)).toBeInTheDocument();
  });

  it('reads app, outcome and kind straight from the URL on load', async () => {
    mockFetch({
      'GET /api/auth/me': meReply('viewer'),
      'GET /api/apps': { status: 200, body: { apps: [{ name: 'web' }, { name: 'api' }] } },
      'GET /api/deploys/timeline': page([WEB_SUCCEEDED]),
    });
    renderAt('/timeline?app=web&outcome=succeeded&kind=deploy');
    await screen.findByText('Succeeded');
    expect(await screen.findByRole('combobox', { name: 'Outcome' })).toHaveTextContent('Succeeded');
    expect(screen.getByRole('combobox', { name: 'Kind' })).toHaveTextContent('Deploy');
  });

  it('the app filter select shows the app chosen in the URL', async () => {
    mockFetch({
      'GET /api/auth/me': meReply('viewer'),
      'GET /api/apps': { status: 200, body: { apps: [{ name: 'web' }, { name: 'api' }] } },
      'GET /api/deploys/timeline': page([WEB_SUCCEEDED]),
    });
    renderAt('/timeline?app=web');
    await screen.findByText('Succeeded');
    expect(await screen.findByRole('combobox', { name: 'App' })).toHaveTextContent('web');
  });

  it('typing a requester and pressing Enter narrows the list (mocked) and updates the URL', async () => {
    const calls = mockFetch({
      'GET /api/auth/me': meReply('viewer'),
      'GET /api/apps': { status: 200, body: { apps: [{ name: 'web' }, { name: 'api' }] } },
      'GET /api/deploys/timeline': [page([WEB_SUCCEEDED, API_REFUSED]), page([API_REFUSED])],
    });
    const user = userEvent.setup();
    renderAt('/timeline');
    await screen.findByText('Succeeded');

    const requester = screen.getByRole('textbox', { name: 'Requester' });
    await user.type(requester, 'Bob{Enter}');

    await waitFor(() => {
      expect(screen.queryByText('Succeeded')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Refused')).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('requester')).toBe('Bob');
    const requesterCalls = calls.filter((c: Call) => c.path === '/api/deploys/timeline' && c.method === 'GET');
    expect(requesterCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('shows "No deploys match" with a clear-filters action for a filtered empty result', async () => {
    mockFetch({
      'GET /api/auth/me': meReply('viewer'),
      'GET /api/apps': { status: 200, body: { apps: [{ name: 'web' }, { name: 'api' }] } },
      'GET /api/deploys/timeline': [page([]), page([WEB_SUCCEEDED, API_REFUSED])],
    });
    const user = userEvent.setup();
    renderAt('/timeline?app=web&outcome=cancelled');
    expect(await screen.findByText('No deploys match')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await screen.findByText('Succeeded');
    expect(window.location.search).toBe('');
  });

  it('shows a Load more control when there is a next page, and appends on click', async () => {
    mockFetch({
      'GET /api/auth/me': meReply('viewer'),
      'GET /api/apps': { status: 200, body: { apps: [{ name: 'web' }] } },
      'GET /api/deploys/timeline': [page([WEB_SUCCEEDED], 'cursor-1'), page([API_REFUSED], null)],
    });
    const user = userEvent.setup();
    renderAt('/timeline');
    await screen.findByText('Succeeded');
    const more = screen.getByRole('button', { name: 'Load more' });
    await user.click(more);
    await screen.findByText('Refused');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});

// The deploy record's tests moved with it to the one deploy page: test/deploy.test.tsx (SHP-T-13.11).

describe('stateWords (SHP-DA-013)', () => {
  it('names each unfinished state instead of one "Active"', () => {
    expect(stateWords('queued')).toBe('Queued');
    expect(stateWords('awaiting_approval')).toBe('Waiting for approval');
    expect(stateWords('soaking')).toBe('Soaking');
    expect(stateWords('rolled_back')).toBe('Rolled back');
  });
});
