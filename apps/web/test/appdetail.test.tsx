import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { SheetAction } from '../src/components/DryRunSheet';
import type { AppDetail, DriftState } from '../src/lib/appdetail';
import { meReply, mockFetch, type Reply } from './fetch';

/**
 * App detail (SHP-T-3.5): only the server's ledger-eligible rollback targets get a button
 * (SHP-REQ-063); adopt-live cannot be submitted without a reason (SHP-REQ-066); a viewer sees no
 * actions (SHP-REQ-105).
 */

// The sheet is another task's; here it only has to be opened with the right action.
const opened: (SheetAction | null)[] = [];
vi.mock('../src/components/DryRunSheet', () => ({
  DryRunSheet: ({ open, action }: { open: boolean; action: SheetAction | null }) => {
    if (open) opened.push(action);
    return open && action !== null ? <div role="dialog" aria-label={`sheet ${action.kind} ${action.sha}`} /> : null;
  },
}));

const sha = (c: string): string => c.repeat(40);
const digest = (c: string): string => `sha256:${c.repeat(64)}`;

function release(c: string) {
  return {
    deployId: `d-${c}`,
    targetId: `t-${c}`,
    kind: 'deploy',
    sha: sha(c),
    requester: 'matt (console)',
    endedAt: '2026-09-20T00:00:00.000Z',
    images: [{ service: 'web', sha: sha(c), digest: digest(c), migration: null }],
  };
}

function detail(overrides: Partial<AppDetail> = {}): AppDetail {
  return {
    name: 'web',
    repo: 'matdemers1/web',
    defaultBranch: 'main',
    liveSha: sha('9'),
    liveDeployId: 'd-9',
    liveEndedAt: '2026-09-24T00:00:00.000Z',
    schemaRevision: '20260924_init',
    digests: { web: digest('9') },
    running: { web: digest('9') },
    drift: null,
    reportedAt: '2026-09-24T00:00:00.000Z',
    soakSeconds: 30,
    approvalPolicy: 'none',
    canary: false,
    group: null,
    manifest: { name: 'web', services: { web: { image: 'ghcr.io/matdemers1/web' } } },
    active: null,
    rollbackTargets: [release('7'), release('6')],
    needsRestore: [{ ...release('2'), reason: 'Release 3333333 after it carried a contract migration.' }],
    targets: [
      {
        id: 't-9',
        deployId: 'd-9',
        kind: 'rollback',
        sha: sha('9'),
        dryRun: false,
        requester: 'matt (console)',
        state: 'succeeded',
        currentStep: null,
        createdAt: '2026-09-24T00:00:00.000Z',
        startedAt: null,
        endedAt: '2026-09-24T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

const noDrift: DriftState = { open: null, resolved: [] };
const openDrift: DriftState = {
  open: {
    id: 'e1',
    detectedAt: '2026-09-24T01:00:00.000Z',
    services: [{ service: 'web', observed: digest('a'), recorded: digest('9'), differs: true }],
  },
  resolved: [],
};

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(<App />);
}

function routes(role: 'deployer' | 'viewer', body: AppDetail, drift: DriftState, extra: Record<string, Reply> = {}) {
  return mockFetch({
    'GET /api/auth/me': meReply(role),
    'GET /api/apps/web': { status: 200, body },
    'GET /api/apps/web/drift': { status: 200, body: drift },
    ...extra,
  });
}

describe('rollback targets', () => {
  it('renders a rollback button for each server rollback target and none for anything else', async () => {
    routes('deployer', detail(), noDrift);
    const user = userEvent.setup();
    renderAt('/apps/web');
    await screen.findByRole('heading', { level: 1, name: 'web' });

    const buttons = screen.getAllByRole('button', { name: /^Roll back to/ });
    expect(buttons.map((b) => b.textContent)).toEqual(['Roll back to 7777777', 'Roll back to 6666666']);
    // Not the live release, not the one behind a contract migration.
    expect(screen.queryByRole('button', { name: 'Roll back to 9999999' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Roll back to 2222222' })).not.toBeInTheDocument();
    const restore = screen.getByRole('list', { name: 'Releases that need a restore' });
    expect(within(restore).getByText(/contract migration/)).toBeInTheDocument();
    expect(within(restore).queryByRole('button')).not.toBeInTheDocument();

    await user.click(buttons[0] as HTMLElement);
    expect(await screen.findByRole('dialog', { name: `sheet rollback ${sha('7')}` })).toBeInTheDocument();
    expect(opened.at(-1)).toEqual({ kind: 'rollback', app: 'web', sha: sha('7'), toDeployId: 'd-7' });
  });

  it('says there is nothing to roll back to when the server offers no target', async () => {
    routes('deployer', detail({ rollbackTargets: [], needsRestore: [] }), noDrift);
    renderAt('/apps/web');
    expect(await screen.findByText('No release to roll back to')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Roll back to/ })).not.toBeInTheDocument();
  });
});

describe('drift banner', () => {
  it('keeps adopt disabled until a reason is typed, then sends it', async () => {
    const calls = routes('deployer', detail(), openDrift, {
      'POST /api/apps/web/drift/adopt': { status: 201, body: { deployId: 'd-new', sha: sha('0'), digests: { web: digest('a') } } },
    });
    const user = userEvent.setup();
    renderAt('/apps/web');
    expect(await screen.findByText('web is running something other than its recorded release')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: "Adopt what's running" }));
    const submit = await screen.findByRole('button', { name: 'Adopt with this reason' });
    expect(submit).toBeDisabled();
    const reason = screen.getByLabelText(/Reason/);
    await user.type(reason, '   ');
    expect(submit).toBeDisabled();
    await user.type(reason, 'hotfix pulled by hand');
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/apps/web/drift/adopt')).toBe(true);
    });
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ reason: 'hotfix pulled by hand' });
  });

  it('asks before redeploying the recorded release, and shows a refusal with its fix', async () => {
    const calls = routes('deployer', detail(), openDrift, {
      'POST /api/apps/web/drift/redeploy': {
        status: 409,
        body: { error: { code: 'locked', gate: 'G4', message: 'web is being deployed by someone.', fix: 'Wait for it to finish.' } },
      },
    });
    const user = userEvent.setup();
    renderAt('/apps/web');
    await user.click(await screen.findByRole('button', { name: 'Redeploy recorded release' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    const dialog = await screen.findByRole('dialog', { name: "Redeploy web's recorded release" });
    await user.click(within(dialog).getByRole('button', { name: 'Redeploy recorded release' }));
    expect(await within(dialog).findByText('web is being deployed by someone.')).toBeInTheDocument();
    expect(within(dialog).getByText('Wait for it to finish.')).toBeInTheDocument();
  });
});

describe('viewer', () => {
  it('sees the drift, the targets and the manifest, and no actions', async () => {
    routes('viewer', detail(), openDrift);
    renderAt('/apps/web');
    await screen.findByRole('heading', { level: 1, name: 'web' });
    expect(screen.getByText('web is running something other than its recorded release')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "Adopt what's running" })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Redeploy recorded release' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Roll back to/ })).not.toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Rollback targets' })).getByText('7777777')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Manifest' })).toHaveValue(
      JSON.stringify(detail().manifest, null, 2),
    );
  });
});

describe('states', () => {
  it('explains a never-deployed app and offers adopt-live to a deployer', async () => {
    routes('deployer', detail({ liveSha: null, liveDeployId: null, liveEndedAt: null, rollbackTargets: [], needsRestore: [], targets: [] }), noDrift);
    renderAt('/apps/web');
    expect(await screen.findByRole('heading', { name: 'Never deployed through Shipyard' })).toBeInTheDocument();
    expect(screen.getByText(/adopt what is running, with a reason/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Adopt what's running" })).toBeInTheDocument();
  });

  it('shows the refusal and its fix when the app does not exist', async () => {
    mockFetch({
      'GET /api/auth/me': meReply('deployer'),
      'GET /api/apps/nope': {
        status: 404,
        body: { error: { code: 'not_found', gate: 'none', message: 'No app named nope.', fix: 'List the apps and use one of their names.' } },
      },
      'GET /api/apps/nope/drift': { status: 404, body: { error: { code: 'not_found', gate: 'none', message: 'No app named nope.', fix: 'x' } } },
    });
    renderAt('/apps/nope');
    expect(await screen.findByText('No app named nope.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
