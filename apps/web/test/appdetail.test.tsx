import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { SheetAction } from '../src/components/DryRunSheet';
import type { AppDetail, DriftState } from '../src/lib/appdetail';
import { meReply, mockFetch, type Reply } from './fetch';

/**
 * App detail (SHP-T-3.5): only the server's ledger-eligible rollback targets get a button
 * (SHP-REQ-063); adopt-live cannot be submitted without a reason and names the drift event it
 * reviewed (SHP-REQ-066); a requested redeploy shows as pending; a viewer sees no actions
 * (SHP-REQ-105). Since SHP-T-13.12 the page is organised by job: the rollback buttons sit inline in
 * the Deploys tab, the releases that need a restore in Backups, the manifest in Config.
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
    retiredAt: null,
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
    pending: null,
  },
  resolved: [],
};

function target(c: string, overrides: Partial<AppDetail['targets'][number]> = {}): AppDetail['targets'][number] {
  return {
    id: `t-${c}`,
    deployId: `d-${c}`,
    kind: 'deploy',
    sha: sha(c),
    dryRun: false,
    requester: 'matt (console)',
    state: 'succeeded',
    currentStep: null,
    createdAt: '2026-09-20T00:00:00.000Z',
    startedAt: '2026-09-20T00:00:00.000Z',
    endedAt: '2026-09-20T00:02:05.000Z',
    ...overrides,
  };
}

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(<App />);
}

function routes(role: 'deployer' | 'viewer', body: AppDetail, drift: DriftState, extra: Record<string, Reply> = {}) {
  return mockFetch({
    'GET /api/auth/me': meReply(role),
    'GET /api/apps/web': { status: 200, body },
    'GET /api/apps/web/drift': { status: 200, body: drift },
    'GET /api/apps/web/freeze': { status: 200, body: { freeze: null } },
    ...extra,
  });
}

describe('rollback targets', () => {
  // The history holds the live release, the two the ledger offers and one that was refused.
  const history = [
    detail().targets[0] as AppDetail['targets'][number],
    target('7'),
    target('6'),
    target('5', { state: 'refused', startedAt: null, endedAt: null }),
  ];

  it('puts Roll back inline on each history row the server offers, and on no other', async () => {
    routes('deployer', detail({ targets: history }), noDrift);
    const user = userEvent.setup();
    renderAt('/apps/web');
    // The skeleton has the same heading; wait for the loaded page's buttons themselves.
    // The first render of the file is the slow one (a cold import under a busy suite).
    const buttons = await screen.findAllByRole('button', { name: /^Roll back to/ }, { timeout: 4000 });
    expect(buttons.map((b) => b.textContent)).toEqual(['Roll back to 7777777', 'Roll back to 6666666']);
    const rows = within(screen.getByRole('list', { name: 'Deploys' })).getAllByRole('listitem');
    expect(within(rows[1] as HTMLElement).getByRole('button', { name: 'Roll back to 7777777' })).toBeInTheDocument();
    // Not the live release, not a refused one, not the one behind a contract migration.
    expect(within(rows[0] as HTMLElement).queryByRole('button')).not.toBeInTheDocument();
    expect(within(rows[3] as HTMLElement).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Roll back to 2222222' })).not.toBeInTheDocument();
    // Every offered target is on a row, so there is no separate list of older ones.
    expect(screen.queryByRole('list', { name: 'Earlier releases to roll back to' })).not.toBeInTheDocument();

    await user.click(buttons[0] as HTMLElement);
    expect(await screen.findByRole('dialog', { name: `sheet rollback ${sha('7')}` })).toBeInTheDocument();
    expect(opened.at(-1)).toEqual({ kind: 'rollback', app: 'web', sha: sha('7'), toDeployId: 'd-7' });
  });

  it('lists an offered target older than the history beneath it, so none is lost', async () => {
    routes('deployer', detail(), noDrift);
    renderAt('/apps/web');
    const older = await screen.findByRole('list', { name: 'Earlier releases to roll back to' }, { timeout: 4000 });
    expect(within(older).getAllByRole('button').map((b) => b.textContent)).toEqual(['Roll back to 7777777', 'Roll back to 6666666']);
  });

  it('keeps the releases that need a restore in Backups, with no button', async () => {
    routes('deployer', detail(), noDrift);
    const user = userEvent.setup();
    renderAt('/apps/web');
    await user.click(await screen.findByRole('tab', { name: 'Backups' }, { timeout: 4000 }));
    const restore = screen.getByRole('list', { name: 'Releases that need a restore' });
    expect(within(restore).getByText(/contract migration/)).toBeInTheDocument();
    expect(within(restore).queryByRole('button')).not.toBeInTheDocument();
  });

  it('says there is nothing to roll back to when the server offers no target', async () => {
    routes('deployer', detail({ rollbackTargets: [], needsRestore: [] }), noDrift);
    renderAt('/apps/web');
    expect(await screen.findByText('No release to roll back to')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Roll back to/ })).not.toBeInTheDocument();
  });
});

describe('status and waiting commits (SHP-T-3.10)', () => {
  const commits = {
    live: sha('9'),
    head: sha('c'),
    newestGreen: sha('b'),
    ahead: 3,
    source: 'github',
    commits: [
      { sha: sha('a'), message: 'SHP-T-1.1: first\n\nbody', ci: 'none', taskIds: ['SHP-T-1.1'] },
      { sha: sha('b'), message: 'second', ci: 'success', taskIds: [] },
      { sha: sha('c'), message: 'third', ci: 'pending', taskIds: [] },
    ],
  };

  it('explains the status, lists the waiting commits newest first, and ships from the list', async () => {
    routes('deployer', detail(), noDrift, { 'GET /api/apps/web/commits': { status: 200, body: commits } });
    const user = userEvent.setup();
    renderAt('/apps/web');
    expect(await screen.findByText('Ready to deploy bbbbbbb', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText(/1 newer commit is still being built/)).toBeInTheDocument();

    const list = screen.getByRole('list', { name: 'Commits waiting to deploy' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => within(r).getByText(/first|second|third/).textContent)).toEqual(['third', 'second', 'SHP-T-1.1: first']);
    expect(within(list).getByText('CI running')).toBeInTheDocument();
    expect(within(list).getByText('No images')).toBeInTheDocument();

    await user.click(within(list).getByRole('button', { name: 'Deploy bbbbbbb' }));
    expect(opened.at(-1)).toEqual({ kind: 'deploy', app: 'web', sha: sha('b') });
  });

  it("links a Shipyard-built app's commits to their builds and words them as Shipyard's", async () => {
    const built = {
      ...commits,
      buildSource: 'shipyard',
      commits: [
        { ...commits.commits[0], ci: 'none' },
        { ...commits.commits[1], ci: 'success', buildId: 'b-2' },
        { ...commits.commits[2], ci: 'pending', buildId: 'b-3' },
      ],
    };
    routes('deployer', detail(), noDrift, { 'GET /api/apps/web/commits': { status: 200, body: built } });
    renderAt('/apps/web');
    expect(await screen.findByText(/^Shipyard built its images\./, {}, { timeout: 4000 })).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Commits waiting to deploy' });
    expect(within(list).getByRole('link', { name: 'second' })).toHaveAttribute('href', '/builds/b-2');
    expect(within(list).getByText('Built')).toBeInTheDocument();
    expect(within(list).getByText('Building')).toBeInTheDocument();
    expect(within(list).getByText('Not built')).toBeInTheDocument();
  });

  it("links each waiting commit's SHA and the ready commit to its page (SHP-T-13.9)", async () => {
    routes('deployer', detail(), noDrift, { 'GET /api/apps/web/commits': { status: 200, body: commits } });
    renderAt('/apps/web');
    expect(await screen.findByText('Ready to deploy bbbbbbb', {}, { timeout: 4000 })).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Commits waiting to deploy' });
    expect(within(list).getByRole('link', { name: 'bbbbbbb' })).toHaveAttribute('href', `/apps/web/commits/${sha('b')}`);
    expect(within(list).getByRole('link', { name: 'ccccccc' })).toHaveAttribute('href', `/apps/web/commits/${sha('c')}`);
    expect(screen.getByRole('link', { name: 'Open commit page →' })).toHaveAttribute('href', `/apps/web/commits/${sha('b')}`);
  });

  it('shows a viewer the status and the commits but no deploy button', async () => {
    routes('viewer', detail(), noDrift, { 'GET /api/apps/web/commits': { status: 200, body: commits } });
    renderAt('/apps/web');
    expect(await screen.findByText('Ready to deploy bbbbbbb', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Commits waiting to deploy' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Deploy / })).not.toBeInTheDocument();
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
    // The event the deployer reviewed travels with the reason: the server adopts its digests.
    expect(post?.body).toEqual({ reason: 'hotfix pulled by hand', driftEventId: 'e1' });
  });

  it('shows a stale-review refusal in the adopt form instead of adopting', async () => {
    routes('deployer', detail(), openDrift, {
      'POST /api/apps/web/drift/adopt': {
        status: 409,
        body: {
          error: {
            code: 'conflict',
            gate: 'none',
            message: 'The drift you reviewed on web is no longer the open one.',
            fix: 'Reload the app, review what is running now, and choose again.',
          },
        },
      },
    });
    const user = userEvent.setup();
    renderAt('/apps/web');
    await user.click(await screen.findByRole('button', { name: "Adopt what's running" }));
    await user.type(screen.getByLabelText(/Reason/), 'hotfix');
    await user.click(screen.getByRole('button', { name: 'Adopt with this reason' }));
    expect(await screen.findByText(/no longer the open one\. Reload the app/)).toBeInTheDocument();
  });

  it('shows a requested redeploy as pending, with its rollback, while the drift stays open', async () => {
    const pending: DriftState = {
      open: { ...(openDrift.open as NonNullable<DriftState['open']>), pending: { deployId: 'd-rb', requestedBy: 'matt@example.com', note: 'x' } },
      resolved: [
        {
          id: 'e0',
          detectedAt: '2026-09-23T01:00:00.000Z',
          resolvedAt: '2026-09-23T02:00:00.000Z',
          resolution: null,
          reason: 'Superseded',
          resolvedBy: null,
        },
      ],
    };
    routes('deployer', detail(), pending);
    renderAt('/apps/web');
    expect(await screen.findByText(/A redeploy of the recorded release was requested by matt@example\.com/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'see the rollback' })).toHaveAttribute('href', '/deploys/d-rb');
    expect(screen.getByText('Superseded by a newer observation')).toBeInTheDocument();
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
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ driftEventId: 'e1' });
  });
});

describe('viewer', () => {
  it('sees the drift, the targets and the manifest, and no actions', async () => {
    routes('viewer', detail(), openDrift);
    const user = userEvent.setup();
    renderAt('/apps/web');
    expect(await screen.findByText('web is running something other than its recorded release')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "Adopt what's running" })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Redeploy recorded release' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Roll back to/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Freeze' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Earlier releases to roll back to' })).getByText('7777777')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Config' }));
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
      'GET /api/apps/nope/freeze': { status: 404, body: { error: { code: 'not_found', gate: 'none', message: 'No app named nope.', fix: 'x' } } },
    });
    renderAt('/apps/nope');
    expect(await screen.findByText('No app named nope.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
