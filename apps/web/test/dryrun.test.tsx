import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DryRunSheet, type SheetAction } from '../src/components/DryRunSheet';
import { AuthProvider } from '../src/lib/auth';
import { meReply, mockFetch } from './fetch';

/**
 * SHP-T-3.3: the dry-run sheet (SHP-REQ-057, SHP-REQ-050, SHP-D-068). A failed gate disables
 * Confirm and shows the fix — the doneWhen — plus an all-pass confirm, the contract warning, a
 * viewer's read-only sheet, an approve action, and a locked refusal at confirm.
 */

const SHA = 'a'.repeat(40);
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
  it('a failed gate disables Confirm and shows its fix', async () => {
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
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    await waitFor(() => {
      expect(confirm).toBeDisabled();
    });
  });

  it('an all-pass dry run enables Confirm; confirming starts the real deploy', async () => {
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

    const confirm = await screen.findByRole('button', { name: 'Confirm' });
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

  it('a viewer sees gates but no Confirm button', async () => {
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

    await screen.findByText('G5');
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
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

    render(<Harness action={{ kind: 'approve', app: 'web', sha: SHA, deployId: 'held-1' }} />);

    const confirm = await screen.findByRole('button', { name: 'Confirm' });
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

    const confirm = await screen.findByRole('button', { name: 'Confirm' });
    await waitFor(() => {
      expect(confirm).toBeEnabled();
    });
    await userEvent.click(confirm);

    expect(await screen.findByText('web is being deployed by someone else.')).toBeInTheDocument();
    expect(await screen.findByText('Wait for it to finish, then request again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });
});
