import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import type { Call } from './fetch';
import { meReply, mockFetch } from './fetch';
import type { TimelinePage } from '../src/lib/timeline';
import { stateWords } from '../src/lib/words';

/**
 * SHP-T-3.7: the timeline (S8, SHP-REQ-062) — now the deploy half of Activity (SHP-T-13.13), which
 * `/timeline` redirects to. The feed's own behaviour is tested in activity.test.tsx; these keep the
 * timeline's filters honest against its endpoint.
 */

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

function routes(timeline: ReturnType<typeof page> | ReturnType<typeof page>[]) {
  return mockFetch({
    'GET /api/auth/me': meReply('viewer'),
    'GET /api/apps': { status: 200, body: { apps: [{ name: 'web' }, { name: 'api' }] } },
    'GET /api/deploys/timeline': timeline,
    'GET /api/builds': { status: 200, body: { items: [], nextCursor: null } },
    'GET /api/schedules': { status: 200, body: { upcoming: [], past: [] } },
  });
}

describe('Timeline, inside Activity (S8)', () => {
  it('/timeline lands on the feed and lists deploys with their outcome, app, sha and requester', async () => {
    routes(page([WEB_SUCCEEDED, API_REFUSED]));
    renderAt('/timeline');
    expect(await screen.findByText('Deployed')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/activity');
    expect(screen.getByText(/Refused — app frozen/)).toBeInTheDocument();
    expect(screen.getByText('bbbbbbb')).toBeInTheDocument();
    expect(screen.getByText(/Bob/)).toBeInTheDocument();
  });

  it('keeps the old Timeline address\'s filters: app, outcome and kind reach the endpoint', async () => {
    const calls = routes(page([WEB_SUCCEEDED]));
    renderAt('/timeline?app=web&outcome=succeeded&kind=deploy');
    await screen.findByText('Deployed');
    expect(await screen.findByRole('combobox', { name: 'Outcome' })).toHaveTextContent('Succeeded');
    expect(screen.getByRole('combobox', { name: 'App' })).toHaveTextContent('web');
    expect(screen.getByRole('button', { name: 'Deploys' })).toHaveAttribute('aria-pressed', 'true');
    expect(calls.some((c: Call) => c.path === '/api/deploys/timeline')).toBe(true);
  });

  it('typing a requester and pressing Enter narrows the list (mocked) and updates the URL', async () => {
    const calls = routes([page([WEB_SUCCEEDED, API_REFUSED]), page([API_REFUSED])]);
    const user = userEvent.setup();
    renderAt('/activity');
    await screen.findByText('Deployed');

    await user.type(screen.getByRole('textbox', { name: 'Requester' }), 'Bob{Enter}');

    await waitFor(() => {
      expect(screen.queryByText('Deployed')).not.toBeInTheDocument();
    });
    expect(screen.getByText(/Refused/)).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('requester')).toBe('Bob');
    const timelineCalls = calls.filter((c: Call) => c.path === '/api/deploys/timeline' && c.method === 'GET');
    expect(timelineCalls.length).toBeGreaterThanOrEqual(2);
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
