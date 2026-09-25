import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ScheduleEntry, ScheduleList } from '@shipyard/schema';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { approvalLabel, fireAtProblem, localToIso, outcomeLabel, shaIsValid } from '../src/lib/schedules';
import { meReply, mockFetch, type Reply } from './fetch';

/**
 * Schedules (S9, SHP-T-5.4): upcoming with the approval each carries; fired-and-refused entries
 * with the reason; "Nothing scheduled" when empty; a deployer schedules, cancels and approves; a
 * viewer only reads.
 */

const SHA = 'a'.repeat(40);

function entry(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return {
    id: 's-1',
    deployId: 'd-1',
    app: 'd3auth',
    sha: SHA,
    fireAt: '2030-01-01T03:00:00.000Z',
    firedAt: null,
    cancelledAt: null,
    status: 'upcoming',
    by: 'matt@example.com',
    requester: { label: 'matt@example.com (scheduled)', repo: null, branch: null },
    approval: { state: 'approved', by: 'matt@example.com', at: '2029-12-31T20:00:00.000Z' },
    state: 'queued',
    refusal: null,
    createdAt: '2029-12-31T20:00:00.000Z',
    ...overrides,
  };
}

const REFUSED = entry({
  id: 's-2',
  deployId: 'd-2',
  app: 'web',
  status: 'fired',
  firedAt: '2029-12-30T03:00:00.000Z',
  state: 'refused',
  approval: { state: 'not_required', by: null, at: null },
  refusal: {
    code: 'not_ahead_of_live',
    gate: 'G7',
    message: 'aaaaaaa is not ahead of live b1c2d3e (behind)',
    fix: 'live is b1c2d3e; request a descendant, or use rollback',
  },
});

const AWAITING = entry({
  id: 's-3',
  deployId: 'd-3',
  by: 'token claude',
  approval: { state: 'awaiting', by: null, at: null },
});

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(<App />);
}

function routes(role: 'deployer' | 'viewer', data: ScheduleList | Reply[], extra: Record<string, Reply> = {}) {
  return mockFetch({
    'GET /api/auth/me': meReply(role),
    'GET /api/schedules': Array.isArray(data) ? data : { status: 200, body: data },
    'GET /api/apps': { status: 200, body: { apps: [{ name: 'd3auth' }, { name: 'web' }] } },
    ...extra,
  });
}

/** A `datetime-local` value `days` from now, in local time. */
function localIn(days: number): string {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

describe('schedule helpers', () => {
  it('accepts only a full SHA, and a fire time in the future within 30 days', () => {
    expect(shaIsValid(SHA)).toBe(true);
    expect(shaIsValid('aaaaaaa')).toBe(false);
    expect(shaIsValid('A'.repeat(40))).toBe(false);
    const now = Date.parse('2030-01-01T00:00:00.000Z');
    expect(fireAtProblem(null, now)).toBe('Pick a date and time.');
    expect(fireAtProblem('2029-12-31T23:59:00.000Z', now)).toBe('Pick a time in the future.');
    expect(fireAtProblem('2030-02-15T00:00:00.000Z', now)).toBe('Pick a time within the next 30 days.');
    expect(fireAtProblem('2030-01-02T00:00:00.000Z', now)).toBeNull();
    expect(localToIso('')).toBeNull();
    expect(localToIso('nonsense')).toBeNull();
  });

  it('says the approval and the outcome in words', () => {
    expect(approvalLabel(entry())).toBe('Approved by matt@example.com');
    expect(approvalLabel(AWAITING)).toBe('Awaiting approval');
    expect(approvalLabel(REFUSED)).toBe('No approval needed');
    expect(approvalLabel(entry({ approval: { state: 'expired', by: null, at: null } }))).toBe('Not approved in time');
    expect(outcomeLabel(REFUSED)).toBe('Fired · refused');
    expect(outcomeLabel(entry({ status: 'cancelled', state: 'cancelled' }))).toBe('Cancelled');
    expect(outcomeLabel(entry({ status: 'fired', state: 'succeeded' }))).toBe('Fired · succeeded');
  });
});

describe('the schedules screen', () => {
  it('lists upcoming with approval captured, and a fired-and-refused schedule with its reason', async () => {
    routes('deployer', { upcoming: [entry(), AWAITING], past: [REFUSED] });
    renderAt('/schedules');

    const upcoming = await screen.findByRole('list', { name: 'Upcoming deploys' }, { timeout: 4000 });
    expect(within(upcoming).getByText('Approved by matt@example.com')).toBeInTheDocument();
    expect(within(upcoming).getByText('Awaiting approval')).toBeInTheDocument();
    const past = screen.getByRole('list', { name: 'Fired and cancelled deploys' });
    expect(within(past).getByText('Fired · refused')).toBeInTheDocument();
    expect(within(past).getByText(/is not ahead of live b1c2d3e/)).toBeInTheDocument();
  });

  it('says "Nothing scheduled" when nothing is', async () => {
    routes('deployer', { upcoming: [], past: [] });
    renderAt('/schedules');
    expect(await screen.findByText('Nothing scheduled', {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it('a viewer reads and cannot schedule, cancel or approve', async () => {
    routes('viewer', { upcoming: [entry(), AWAITING], past: [REFUSED] });
    renderAt('/schedules');
    expect(await screen.findByText('Awaiting approval', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText('Your role can read schedules but not change them.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Schedule a deploy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Cancel / })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Approve / })).not.toBeInTheDocument();
  });

  it('a deployer schedules a deploy: the full SHA and the local time go to the server as ISO, and the list reloads', async () => {
    const created = entry({ id: 's-9', app: 'd3auth' });
    const calls = routes('deployer', [
      { status: 200, body: { upcoming: [], past: [] } },
      { status: 200, body: { upcoming: [created], past: [] } },
    ], { 'POST /api/schedules': { status: 201, body: created } });
    const user = userEvent.setup();
    renderAt('/schedules');

    await user.click(await screen.findByRole('button', { name: 'Schedule a deploy' }, { timeout: 4000 }));
    const dialog = await screen.findByRole('dialog', { name: 'Schedule a deploy' });
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Schedule d3auth' })).toBeInTheDocument();
    });

    // Not the full SHA: refused in the form, nothing sent.
    await user.type(within(dialog).getByLabelText('Commit SHA'), 'aaaaaaa');
    await user.click(within(dialog).getByRole('button', { name: 'Schedule d3auth' }));
    expect(await within(dialog).findByText('Enter the full 40-character commit SHA.')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);

    await user.clear(within(dialog).getByLabelText('Commit SHA'));
    await user.type(within(dialog).getByLabelText('Commit SHA'), SHA);
    const local = localIn(2);
    fireEvent.change(within(dialog).getByLabelText('When'), { target: { value: local } });
    await user.click(within(dialog).getByRole('button', { name: 'Schedule d3auth' }));

    await waitFor(() => {
      expect(calls.find((c) => c.method === 'POST')).toEqual({
        method: 'POST',
        path: '/api/schedules',
        body: { app: 'd3auth', sha: SHA, fireAt: new Date(local).toISOString() },
      });
    });
    expect(await screen.findByText('Approved by matt@example.com')).toBeInTheDocument();
  });

  it('a deployer cancels an upcoming schedule after confirming', async () => {
    const calls = routes(
      'deployer',
      [
        { status: 200, body: { upcoming: [entry()], past: [] } },
        { status: 200, body: { upcoming: [], past: [entry({ status: 'cancelled', state: 'cancelled', cancelledAt: '2029-12-31T21:00:00.000Z' })] } },
      ],
      { 'DELETE /api/schedules/s-1': { status: 200, body: entry({ status: 'cancelled', state: 'cancelled' }) } },
    );
    const user = userEvent.setup();
    renderAt('/schedules');
    await user.click(await screen.findByRole('button', { name: 'Cancel d3auth at aaaaaaa' }, { timeout: 4000 }));
    await user.click(await screen.findByRole('button', { name: 'Cancel deploy' }));
    expect(await screen.findByText('Nothing scheduled')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/schedules/s-1')).toBe(true);
  });

  it("a deployer approves a token's schedule; a refusal shows in the sheet", async () => {
    const calls = routes('deployer', { upcoming: [AWAITING], past: [] }, {
      'POST /api/deploys/d-3/approve': {
        status: 409,
        body: { error: { code: 'conflict', gate: 'none', message: 'This scheduled deploy has already fired or been cancelled.', fix: 'Refresh state and retry.' } },
      },
    });
    const user = userEvent.setup();
    renderAt('/schedules');
    await user.click(await screen.findByRole('button', { name: 'Approve d3auth at aaaaaaa' }, { timeout: 4000 }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByText('This scheduled deploy has already fired or been cancelled.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/deploys/d-3/approve')).toBe(true);
  });
});
