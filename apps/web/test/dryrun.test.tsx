import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DryRunSheet, type SheetAction } from '../src/components/DryRunSheet';
import { AuthProvider } from '../src/lib/auth';
import { DRY_RUN_DEADLINE_SECONDS } from '../src/lib/dryrun';
import { meReply, mockFetch, type Reply } from './fetch';

/**
 * SHP-T-3.3: the dry-run sheet (SHP-REQ-057, SHP-REQ-050, SHP-D-068). A failed gate disables
 * the Deploy button and shows the fix — the doneWhen — plus an all-pass confirm, the contract warning, a
 * viewer's read-only sheet, an approve action, and a locked refusal at confirm.
 */

const SHA = 'a'.repeat(40);
// The primary names the SHA it acts on, never "Confirm" (SHP-T-13.3).
const DEPLOY_BUTTON = `Deploy ${SHA.slice(0, 7)}`;
const APPROVE_BUTTON = `Approve and deploy ${SHA.slice(0, 7)}`;
const DEPLOY_ID = 'd1';
const APP_REPLY = { status: 200, body: { soakSeconds: 120 } };
const COMMITS_REPLY = {
  status: 200,
  body: {
    live: 'b'.repeat(40),
    commits: [{ sha: SHA, message: 'ship it', ci: 'success', taskIds: ['SHP-T-9.9'] }],
    newestGreen: SHA,
    source: 'github',
  },
};

function Harness({ action }: { action: SheetAction }) {
  const [open, setOpen] = useState(true);
  const onStarted = vi.fn();
  return (
    <AuthProvider>
      <DryRunSheet open={open} onOpenChange={setOpen} action={action} onStarted={onStarted} />
    </AuthProvider>
  );
}

describe('DryRunSheet', () => {
  it('a failed check disables the Deploy button and shows its fix', async () => {
    mockFetch({
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps/web': APP_REPLY,
      'GET /api/apps/web/commits': COMMITS_REPLY,
      'POST /api/deploys': { status: 201, body: { deployId: DEPLOY_ID, state: 'queued' } },
      [`GET /api/deploys/${DEPLOY_ID}`]: {
        status: 200,
        body: {
          deployId: DEPLOY_ID,
          kind: 'deploy',
          app: 'web',
          sha: SHA,
          dryRun: true,
          state: 'refused',
          currentStep: null,
          requester: { label: 'me', repo: null, branch: null },
          images: [],
          schemaRevision: null,
          refusal: { code: 'ci_not_green', gate: 'G5', message: 'CI is red.', fix: 'Push a green commit to main and retry.' },
          gates: [{ gate: 'G5', pass: false, reason: 'ci.yml is red on main' }],
          createdAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        },
      },
    });

    render(<Harness action={{ kind: 'deploy', app: 'web', sha: SHA }} />);

    expect(await screen.findByText('ci.yml is red on main')).toBeInTheDocument();
    expect(await screen.findByText('Push a green commit to main and retry.')).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: DEPLOY_BUTTON });
    await waitFor(() => {
      expect(confirm).toBeDisabled();
    });
  });

  it('an all-pass dry run enables the Deploy button; deploying starts the real deploy', async () => {
    const calls = mockFetch({
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps/web': APP_REPLY,
      'GET /api/apps/web/commits': COMMITS_REPLY,
      'POST /api/deploys': [
        { status: 201, body: { deployId: DEPLOY_ID, state: 'queued' } },
        { status: 201, body: { deployId: 'd2', state: 'locked' } },
      ],
      [`GET /api/deploys/${DEPLOY_ID}`]: {
        status: 200,
        body: {
          deployId: DEPLOY_ID,
          kind: 'deploy',
          app: 'web',
          sha: SHA,
          dryRun: true,
          state: 'succeeded',
          currentStep: null,
          requester: { label: 'me', repo: null, branch: null },
          images: [{ service: 'web', sha: SHA, digest: `sha256:${'1'.repeat(64)}`, migration: null }],
          schemaRevision: null,
          refusal: null,
          gates: [{ gate: 'G5', pass: true, reason: 'ci.yml succeeded' }],
          createdAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        },
      },
    });

    render(<Harness action={{ kind: 'deploy', app: 'web', sha: SHA }} />);

    const confirm = await screen.findByRole('button', { name: DEPLOY_BUTTON });
    await waitFor(() => {
      expect(confirm).toBeEnabled();
    });

    await userEvent.click(confirm);

    await waitFor(() => {
      expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/deploys')).toHaveLength(2);
    });
    const real = calls.filter((c) => c.method === 'POST' && c.path === '/api/deploys')[1];
    expect(real?.body).toEqual({ kind: 'deploy', app: 'web', sha: SHA });
  });

  it('a contract migration label shows the auto-rollback warning', async () => {
    mockFetch({
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps/web': APP_REPLY,
      'GET /api/apps/web/commits': COMMITS_REPLY,
      'POST /api/deploys': { status: 201, body: { deployId: DEPLOY_ID, state: 'queued' } },
      [`GET /api/deploys/${DEPLOY_ID}`]: {
        status: 200,
        body: {
          deployId: DEPLOY_ID,
          kind: 'deploy',
          app: 'web',
          sha: SHA,
          dryRun: true,
          state: 'succeeded',
          currentStep: null,
          requester: { label: 'me', repo: null, branch: null },
          images: [{ service: 'web', sha: SHA, digest: `sha256:${'1'.repeat(64)}`, migration: 'contract' }],
          schemaRevision: null,
          refusal: null,
          gates: [{ gate: 'G5', pass: true, reason: 'ci.yml succeeded' }],
          createdAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        },
      },
    });

    render(<Harness action={{ kind: 'deploy', app: 'web', sha: SHA }} />);

    expect(await screen.findByText('This release includes a data migration')).toBeInTheDocument();
  });

  it('a viewer sees checks but no Deploy button', async () => {
    mockFetch({
      'GET /api/auth/me': meReply('viewer'),
      'GET /api/apps/web': APP_REPLY,
      'GET /api/apps/web/commits': COMMITS_REPLY,
      'POST /api/deploys': { status: 201, body: { deployId: DEPLOY_ID, state: 'queued' } },
      [`GET /api/deploys/${DEPLOY_ID}`]: {
        status: 200,
        body: {
          deployId: DEPLOY_ID,
          kind: 'deploy',
          app: 'web',
          sha: SHA,
          dryRun: true,
          state: 'succeeded',
          currentStep: null,
          requester: { label: 'me', repo: null, branch: null },
          images: [],
          schemaRevision: null,
          refusal: null,
          gates: [{ gate: 'G5', pass: true, reason: 'ci.yml succeeded' }],
          createdAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        },
      },
    });

    render(<Harness action={{ kind: 'deploy', app: 'web', sha: SHA }} />);

    // The check is named by its human name, with the gate code beside it (SHP-REQ-171).
    // The commit row says "CI passed" too, so look inside the Checks section.
    const checks = await screen.findByRole('region', { name: 'Checks' });
    expect(within(checks).getByText('CI passed')).toBeInTheDocument();
    expect(within(checks).getByText('G5')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: DEPLOY_BUTTON })).not.toBeInTheDocument();
  });

  it('shows every cited Foreman task ID as a chip from the scoped commits response (SHP-REQ-087)', async () => {
    mockFetch({
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps/web': APP_REPLY,
      'GET /api/apps/web/commits': {
        status: 200,
        body: {
          live: 'b'.repeat(40),
          commits: [
            { sha: SHA, message: 'SHP-T-5.8: changelog helper', ci: 'success', taskIds: ['SHP-T-5.8', 'SHP-T-5.9'] },
          ],
          newestGreen: SHA,
          source: 'github',
        },
      },
      'POST /api/deploys': { status: 201, body: { deployId: DEPLOY_ID, state: 'queued' } },
      [`GET /api/deploys/${DEPLOY_ID}`]: {
        status: 200,
        body: {
          deployId: DEPLOY_ID,
          kind: 'deploy',
          app: 'web',
          sha: SHA,
          dryRun: true,
          state: 'succeeded',
          currentStep: null,
          requester: { label: 'me', repo: null, branch: null },
          images: [],
          schemaRevision: null,
          refusal: null,
          gates: [{ gate: 'G5', pass: true, reason: 'ci.yml succeeded' }],
          createdAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        },
      },
    });

    render(<Harness action={{ kind: 'deploy', app: 'web', sha: SHA }} />);

    expect(await screen.findByText('SHP-T-5.8')).toBeInTheDocument();
    expect(await screen.findByText('SHP-T-5.9')).toBeInTheDocument();
  });

  it('an approve action POSTs /api/deploys/:id/approve', async () => {
    const calls = mockFetch({
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps/web': APP_REPLY,
      'GET /api/apps/web/commits': COMMITS_REPLY,
      'POST /api/deploys': { status: 201, body: { deployId: DEPLOY_ID, state: 'queued' } },
      [`GET /api/deploys/${DEPLOY_ID}`]: {
        status: 200,
        body: {
          deployId: DEPLOY_ID,
          kind: 'deploy',
          app: 'web',
          sha: SHA,
          dryRun: true,
          state: 'succeeded',
          currentStep: null,
          requester: { label: 'me', repo: null, branch: null },
          images: [],
          schemaRevision: null,
          refusal: null,
          gates: [{ gate: 'G5', pass: true, reason: 'ci.yml succeeded' }],
          createdAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        },
      },
      [`POST /api/deploys/held-1/approve`]: { status: 200, body: { deployId: 'held-1', state: 'locked' } },
    });

    render(<Harness action={{ kind: 'approve', app: 'web', sha: SHA, deployId: 'held-1', requester: 'claude: matdemers1/web fix' }} />);

    // The person who asked, not the approver looking at the sheet (SHP-DA-012).
    expect(await screen.findByText('claude: matdemers1/web fix')).toBeInTheDocument();
    expect(screen.getByText('Approving as')).toBeInTheDocument();

    const confirm = await screen.findByRole('button', { name: APPROVE_BUTTON });
    await waitFor(() => {
      expect(confirm).toBeEnabled();
    });
    await userEvent.click(confirm);

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/deploys/held-1/approve')).toBe(true);
    });
  });

  it('a locked refusal at confirm time shows its message and fix; the sheet stays open', async () => {
    mockFetch({
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps/web': APP_REPLY,
      'GET /api/apps/web/commits': COMMITS_REPLY,
      'POST /api/deploys': [
        { status: 201, body: { deployId: DEPLOY_ID, state: 'queued' } },
        {
          status: 409,
          body: {
            error: { code: 'locked', gate: 'G4', message: 'web is being deployed by someone else.', fix: 'Wait for it to finish, then request again.' },
          },
        },
      ],
      [`GET /api/deploys/${DEPLOY_ID}`]: {
        status: 200,
        body: {
          deployId: DEPLOY_ID,
          kind: 'deploy',
          app: 'web',
          sha: SHA,
          dryRun: true,
          state: 'succeeded',
          currentStep: null,
          requester: { label: 'me', repo: null, branch: null },
          images: [],
          schemaRevision: null,
          refusal: null,
          gates: [{ gate: 'G5', pass: true, reason: 'ci.yml succeeded' }],
          createdAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        },
      },
    });

    render(<Harness action={{ kind: 'deploy', app: 'web', sha: SHA }} />);

    const confirm = await screen.findByRole('button', { name: DEPLOY_BUTTON });
    await waitFor(() => {
      expect(confirm).toBeEnabled();
    });
    await userEvent.click(confirm);

    expect(await screen.findByText('web is being deployed by someone else.')).toBeInTheDocument();
    expect(await screen.findByText('Wait for it to finish, then request again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: DEPLOY_BUTTON })).toBeInTheDocument();
  });

  describe('the sheet as designed (SHP-REQ-161, SHP-REQ-171)', () => {
    const NEWEST = 'c'.repeat(40);
    const MIDDLE = 'd'.repeat(40);

    function statusBody(sha: string, gates: { gate: string; pass: boolean; reason: string }[], refusal: unknown = null) {
      return {
        deployId: DEPLOY_ID,
        kind: 'deploy',
        app: 'web',
        sha,
        dryRun: true,
        state: refusal === null ? 'succeeded' : 'refused',
        currentStep: null,
        requester: { label: 'me', repo: null, branch: null },
        images: [],
        schemaRevision: null,
        refusal,
        gates,
        createdAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      };
    }

    const GATES = [
      { gate: 'G5', pass: true, reason: 'ci.yml succeeded' },
      { gate: 'disk', pass: true, reason: '12 GB free' },
    ];

    it('warns when a commit whose CI failed ships along, naming it and the target', async () => {
      mockFetch({
        'GET /api/auth/me': meReply('deployer'),
        'GET /api/apps/web': APP_REPLY,
        'GET /api/apps/web/commits': {
          status: 200,
          body: {
            live: 'b'.repeat(40),
            commits: [
              { sha: SHA, message: 'the target', ci: 'success', taskIds: [] },
              { sha: MIDDLE, message: 'broke the build', ci: 'failure', taskIds: [] },
              { sha: NEWEST, message: 'oldest', ci: 'success', taskIds: [] },
            ],
            newestGreen: SHA,
            source: 'github',
          },
        },
        'POST /api/deploys': { status: 201, body: { deployId: DEPLOY_ID, state: 'queued' } },
        [`GET /api/deploys/${DEPLOY_ID}`]: { status: 200, body: statusBody(NEWEST, GATES) },
      });

      render(<Harness action={{ kind: 'deploy', app: 'web', sha: NEWEST }} />);

      expect(await screen.findByText('ddddddd failed CI. Its code deploys with ccccccc.')).toBeInTheDocument();
      expect(screen.getByText('CI failed')).toBeInTheDocument();
      // The subtitle names the route and the count.
      expect(screen.getByText('bbbbbbb → ccccccc · 3 commits')).toBeInTheDocument();
    });

    it('shows checks by human name with the gate code beside it, as one result', async () => {
      mockFetch({
        'GET /api/auth/me': meReply('deployer'),
        'GET /api/apps/web': APP_REPLY,
        'GET /api/apps/web/commits': COMMITS_REPLY,
        'POST /api/deploys': { status: 201, body: { deployId: DEPLOY_ID, state: 'queued' } },
        [`GET /api/deploys/${DEPLOY_ID}`]: { status: 200, body: statusBody(SHA, GATES) },
      });

      render(<Harness action={{ kind: 'deploy', app: 'web', sha: SHA }} />);

      const checks = await screen.findByRole('region', { name: 'Checks' });
      expect(within(checks).getByText('CI passed')).toBeInTheDocument();
      expect(within(checks).getByText('G5')).toBeInTheDocument();
      expect(within(checks).getByText('Disk has space')).toBeInTheDocument();
      expect(within(checks).getByText('disk')).toBeInTheDocument();
      expect(within(checks).getByText(/All 2 passed · Asked the agent · \d+s ago/)).toBeInTheDocument();
    });

    it('puts the failed check first and counts what passed', async () => {
      mockFetch({
        'GET /api/auth/me': meReply('deployer'),
        'GET /api/apps/web': APP_REPLY,
        'GET /api/apps/web/commits': COMMITS_REPLY,
        'POST /api/deploys': { status: 201, body: { deployId: DEPLOY_ID, state: 'queued' } },
        [`GET /api/deploys/${DEPLOY_ID}`]: {
          status: 200,
          body: statusBody(
            SHA,
            [
              { gate: 'G1', pass: true, reason: 'allowed' },
              { gate: 'G4', pass: false, reason: 'locked by someone' },
            ],
            { code: 'locked', gate: 'G4', message: 'web is locked.', fix: 'Wait, then ask again.' },
          ),
        },
      });

      render(<Harness action={{ kind: 'deploy', app: 'web', sha: SHA }} />);

      const checks = await screen.findByRole('region', { name: 'Checks' });
      expect(within(checks).getByText(/1 of 2 passed/)).toBeInTheDocument();
      const rows = within(checks).getAllByRole('listitem');
      expect(within(rows[0] as HTMLElement).getByText('Not locked')).toBeInTheDocument();
      expect(within(rows[1] as HTMLElement).getByText('Allowed')).toBeInTheDocument();
      // A refused dry run does not describe a deploy that will not happen.
      expect(screen.queryByRole('region', { name: 'What happens' })).not.toBeInTheDocument();
    });

    it('names the SHA on the confirm button, in seven characters', async () => {
      mockFetch({
        'GET /api/auth/me': meReply('deployer'),
        'GET /api/apps/web': APP_REPLY,
        'GET /api/apps/web/commits': COMMITS_REPLY,
        'POST /api/deploys': { status: 201, body: { deployId: DEPLOY_ID, state: 'queued' } },
        [`GET /api/deploys/${DEPLOY_ID}`]: { status: 200, body: statusBody(SHA, GATES) },
      });

      render(<Harness action={{ kind: 'deploy', app: 'web', sha: SHA }} />);

      expect(await screen.findByRole('button', { name: 'Deploy aaaaaaa' })).toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: 'Deploy web aaaaaaa' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });

    it('lays out what happens: the steps in order, the soak length and the rollback promise', async () => {
      mockFetch({
        'GET /api/auth/me': meReply('deployer'),
        'GET /api/apps/web': APP_REPLY,
        'GET /api/apps/web/commits': COMMITS_REPLY,
        'POST /api/deploys': { status: 201, body: { deployId: DEPLOY_ID, state: 'queued' } },
        [`GET /api/deploys/${DEPLOY_ID}`]: { status: 200, body: statusBody(SHA, GATES) },
      });

      render(<Harness action={{ kind: 'deploy', app: 'web', sha: SHA }} />);

      const happens = await screen.findByRole('region', { name: 'What happens' });
      await waitFor(() => {
        expect(within(happens).getByText(/Soak 120s/)).toBeInTheDocument();
      });
      const steps = within(happens)
        .getAllByRole('listitem')
        .map((li) => li.textContent.replace('→ ', '').replace(/ 120s$/, ''));
      expect(steps).toEqual(['Back up', 'Migrate', 'Pull', 'Swap', 'Check', 'Soak']);
      expect(within(happens).getByText(/Shipyard rolls the images back\. Data is not restored automatically\./)).toBeInTheDocument();
    });

    it('offers the newest green commit when CI refused, and switching re-runs the dry run for it', async () => {
      const calls = mockFetch({
        'GET /api/auth/me': meReply('deployer'),
        'GET /api/apps/web': APP_REPLY,
        'GET /api/apps/web/commits': {
          status: 200,
          body: {
            live: 'b'.repeat(40),
            commits: [{ sha: SHA, message: 'red one', ci: 'failure', taskIds: [] }],
            newestGreen: NEWEST,
            source: 'github',
          },
        },
        'POST /api/deploys': [
          { status: 201, body: { deployId: DEPLOY_ID, state: 'queued' } },
          { status: 201, body: { deployId: 'd2', state: 'queued' } },
        ],
        [`GET /api/deploys/${DEPLOY_ID}`]: {
          status: 200,
          body: statusBody(
            SHA,
            [{ gate: 'G5', pass: false, reason: 'ci.yml is red on main' }],
            { code: 'ci_not_green', gate: 'G5', message: 'CI is red.', fix: 'Push a green commit to main.' },
          ),
        },
        'GET /api/deploys/d2': { status: 200, body: { ...statusBody(NEWEST, GATES), deployId: 'd2' } },
      });

      render(<Harness action={{ kind: 'deploy', app: 'web', sha: SHA }} />);

      await userEvent.click(await screen.findByRole('button', { name: 'Deploy ccccccc instead' }));

      // The sheet now acts on the green commit, and its dry run was asked for that SHA.
      expect(await screen.findByRole('button', { name: 'Deploy ccccccc' })).toBeEnabled();
      const dryRuns = calls.filter((c) => c.method === 'POST' && c.path === '/api/deploys');
      expect(dryRuns).toHaveLength(2);
      expect(dryRuns[1]?.body).toEqual({ kind: 'deploy', app: 'web', sha: NEWEST, dryRun: true });
      expect(screen.queryByRole('button', { name: /instead/ })).not.toBeInTheDocument();
    });

    it('offers nothing instead when the newest green commit is the one refused', async () => {
      mockFetch({
        'GET /api/auth/me': meReply('deployer'),
        'GET /api/apps/web': APP_REPLY,
        'GET /api/apps/web/commits': {
          status: 200,
          body: {
            live: 'b'.repeat(40),
            commits: [{ sha: SHA, message: 'x', ci: 'failure', taskIds: [] }],
            newestGreen: SHA,
            source: 'github',
          },
        },
        'POST /api/deploys': { status: 201, body: { deployId: DEPLOY_ID, state: 'queued' } },
        [`GET /api/deploys/${DEPLOY_ID}`]: {
          status: 200,
          body: statusBody(
            SHA,
            [{ gate: 'G5', pass: false, reason: 'red' }],
            { code: 'ci_not_green', gate: 'G5', message: 'CI is red.', fix: 'Push a green commit to main.' },
          ),
        },
      });

      render(<Harness action={{ kind: 'deploy', app: 'web', sha: SHA }} />);

      expect(await screen.findByText('Push a green commit to main.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /instead/ })).not.toBeInTheDocument();
    });
  });

  describe('a dry run the agent never finishes (SHP-DA-014)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Answers like the server, except the dry-run request, which never comes back until aborted. */
    function stubHangingDryRun(agents: unknown): void {
      const replies: Record<string, Reply> = {
        'GET /api/auth/me': meReply('deployer'),
        'GET /api/apps/web': APP_REPLY,
        'GET /api/apps/web/commits': COMMITS_REPLY,
        'GET /api/agent': { status: 200, body: agents },
      };
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          const key = `${init?.method ?? 'GET'} ${new URL(url, 'http://localhost').pathname}`;
          if (key === 'POST /api/deploys') {
            return new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('aborted', 'AbortError'));
              });
            });
          }
          const reply = replies[key];
          if (reply === undefined) throw new Error(`unexpected request: ${key}`);
          return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } }));
        }),
      );
    }

    it('stops at the deadline and says the agent is not taking work when it is stale', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      stubHangingDryRun([{ id: 'a1', confirmed: true, stale: true, lastHeartbeatAt: new Date(Date.now() - 20 * 60_000).toISOString() }]);

      render(<Harness action={{ kind: 'deploy', app: 'web', sha: SHA }} />);
      expect(await screen.findByText(/Starting the checks/)).toBeInTheDocument();

      await vi.advanceTimersByTimeAsync(DRY_RUN_DEADLINE_SECONDS * 1000 + 1000);

      expect(await screen.findByText('The agent is not taking work')).toBeInTheDocument();
      expect(screen.getByText(/last checked in 2\dm ago\. Nothing was changed/)).toBeInTheDocument();
      expect(screen.queryByText(/Starting the checks/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: DEPLOY_BUTTON })).toBeDisabled();
    });

    it('says the checks were slow when the agent is checking in', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      stubHangingDryRun([{ id: 'a1', confirmed: true, stale: false, lastHeartbeatAt: new Date().toISOString() }]);

      render(<Harness action={{ kind: 'deploy', app: 'web', sha: SHA }} />);
      await vi.advanceTimersByTimeAsync(DRY_RUN_DEADLINE_SECONDS * 1000 + 1000);

      expect(await screen.findByText(`The checks did not finish within ${String(DRY_RUN_DEADLINE_SECONDS)}s`)).toBeInTheDocument();
    });
  });

  it('a rollback says where it goes back to and lists no commits ahead of live', async () => {
    mockFetch({
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps/web': APP_REPLY,
      'GET /api/apps/web/commits': COMMITS_REPLY,
      'POST /api/deploys': { status: 201, body: { deployId: DEPLOY_ID, state: 'queued' } },
      [`GET /api/deploys/${DEPLOY_ID}`]: {
        status: 200,
        body: {
          deployId: DEPLOY_ID, kind: 'rollback', app: 'web', sha: 'e'.repeat(40), dryRun: true, state: 'succeeded',
          currentStep: null, requester: { label: 'me', repo: null, branch: null }, images: [], schemaRevision: null,
          refusal: null, gates: [{ gate: 'G8', pass: true, reason: 'digests found' }],
          createdAt: new Date().toISOString(), endedAt: new Date().toISOString(),
        },
      },
    });
    render(<Harness action={{ kind: 'rollback', app: 'web', sha: 'e'.repeat(40), toDeployId: 'old-1' }} />);
    expect(await screen.findByText('bbbbbbb → back to eeeeeee')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'What deploys' })).not.toBeInTheDocument();
    expect(screen.queryByText(/commits?$/)).not.toBeInTheDocument();
  });
});
