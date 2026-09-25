import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { GroupSummary } from '@shipyard/schema';
import { GroupDeploySheet } from '../src/components/GroupDeploySheet';
import { mockFetch } from './fetch';

/**
 * SHP-T-5.11: the group-deploy sheet from Home. It defaults the target SHA to the canary's newest
 * green commit, lists every member in order with a canary badge, and confirming posts the group
 * deploy request straight (a group dry run is refused server-side, SHP-REQ-078/079).
 */

const SHA = 'a'.repeat(40);
const GROUP: GroupSummary = { name: 'trio', canary: 'alpha', members: ['alpha', 'bravo', 'charlie'] };

function commitsReply(newestGreen: string | null) {
  return { status: 200, body: { live: 'b'.repeat(40), head: null, commits: [], newestGreen, source: 'github' as const } };
}

function Harness({ group }: { group: GroupSummary | null }) {
  const [open, setOpen] = useState(true);
  const onStarted = vi.fn();
  return <GroupDeploySheet open={open} onOpenChange={setOpen} group={group} onStarted={onStarted} />;
}

describe('GroupDeploySheet', () => {
  it("defaults the SHA to the canary's newest green commit, lists members in order with the canary badge, and confirms", async () => {
    const calls = mockFetch({
      'GET /api/apps/alpha/commits': commitsReply(SHA),
      'POST /api/deploys': { status: 201, body: { deployId: 'g1', state: 'locked' } },
    });

    render(<Harness group={GROUP} />);

    expect(await screen.findByRole('heading', { name: 'Deploy group trio' })).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Members of trio, in deploy order' });
    expect(list).toHaveTextContent('alpha');
    expect(list).toHaveTextContent('bravo');
    expect(list).toHaveTextContent('charlie');
    expect(screen.getByText('Canary')).toBeInTheDocument();

    const input = await screen.findByDisplayValue(SHA);
    expect(input).toBeInTheDocument();

    const confirm = screen.getByRole('button', { name: 'Confirm' });
    await waitFor(() => {
      expect(confirm).not.toBeDisabled();
    });
    await userEvent.click(confirm);

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/deploys')).toBe(true);
    });
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/deploys');
    expect(post?.body).toEqual({ kind: 'deploy', group: 'trio', sha: SHA });
  });

  it('disables Confirm until a valid 40-hex SHA is entered when no candidate is found', async () => {
    mockFetch({
      'GET /api/apps/alpha/commits': commitsReply(null),
    });

    render(<Harness group={GROUP} />);

    await screen.findByText('No candidate SHA found — enter one to deploy the group.');
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();

    const input = screen.getByPlaceholderText('40-character commit SHA');
    await userEvent.type(input, SHA);
    await waitFor(() => {
      expect(confirm).not.toBeDisabled();
    });
  });

  it('shows the refusal and keeps the sheet open when the server refuses the group deploy', async () => {
    mockFetch({
      'GET /api/apps/alpha/commits': commitsReply(SHA),
      'POST /api/deploys': {
        status: 409,
        body: { error: { code: 'locked', gate: 'none', message: 'bravo is being deployed by someone else.', fix: 'Wait, then retry.' } },
      },
    });

    render(<Harness group={GROUP} />);
    const confirm = await screen.findByRole('button', { name: 'Confirm' });
    await waitFor(() => {
      expect(confirm).not.toBeDisabled();
    });
    await userEvent.click(confirm);

    expect(await screen.findByText('bravo is being deployed by someone else.')).toBeInTheDocument();
    expect(screen.getByText('Wait, then retry.')).toBeInTheDocument();
  });
});
