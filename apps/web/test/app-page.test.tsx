import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { SheetAction } from '../src/components/DryRunSheet';
import type { AppDetail, DriftState, FreezeInfo } from '../src/lib/appdetail';
import type { CommitsInfo } from '../src/lib/home';
import { meReply, mockFetch, type Reply } from './fetch';

/**
 * The app page by job (SHP-T-13.12, SHP-REQ-163, SHP-D-094), against the approved "02 · App"
 * frames: one primary in the header; Freeze one tap beside it, and while frozen Unfreeze in its
 * place with Deploy disabled; the next commit's lane; the waiting commits linked to their CI runs
 * and their commit pages; Deploys with roll back inline; Backups where "More" was; Config holding
 * the manifest's facts and the containers; and a facts rail.
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
const RUN = (id: number) => `https://github.com/matdemers1/bindery/actions/runs/${String(id)}`;

function detail(overrides: Partial<AppDetail> = {}): AppDetail {
  return {
    name: 'bindery',
    repo: 'matdemers1/bindery',
    defaultBranch: 'main',
    liveSha: sha('f'),
    liveDeployId: 'd-f',
    liveEndedAt: '2026-10-05T12:53:00.000Z',
    schemaRevision: '20261001_vault',
    digests: { api: digest('f') },
    running: { api: digest('f'), web: digest('e') },
    drift: null,
    reportedAt: '2026-10-06T00:00:00.000Z',
    soakSeconds: 60,
    approvalPolicy: 'none',
    canary: false,
    group: null,
    manifest: { name: 'bindery', workflow: 'ci.yml', services: { api: { image: 'ghcr.io/matdemers1/bindery-api' } } },
    active: null,
    rollbackTargets: [
      {
        deployId: 'd-7',
        targetId: 't-7',
        kind: 'deploy',
        sha: sha('7'),
        requester: 'Matthew',
        endedAt: '2026-10-01T00:00:00.000Z',
        images: [{ service: 'api', sha: sha('7'), digest: digest('7'), migration: null }],
      },
    ],
    needsRestore: [],
    targets: [
      {
        id: 't-f',
        deployId: 'd-f',
        kind: 'deploy',
        sha: sha('f'),
        dryRun: false,
        requester: 'Matthew',
        state: 'succeeded',
        currentStep: null,
        createdAt: '2026-10-05T12:50:00.000Z',
        startedAt: '2026-10-05T12:50:00.000Z',
        endedAt: '2026-10-05T12:53:05.000Z',
      },
      {
        id: 't-8',
        deployId: 'd-8',
        kind: 'deploy',
        sha: sha('8'),
        dryRun: false,
        requester: 'claude: bindery fix',
        state: 'refused',
        currentStep: null,
        createdAt: '2026-10-03T00:00:00.000Z',
        startedAt: null,
        endedAt: null,
        refusal: { message: 'CI failed on 8888888.' },
      },
      {
        id: 't-7',
        deployId: 'd-7',
        kind: 'deploy',
        sha: sha('7'),
        dryRun: false,
        requester: 'Matthew',
        state: 'succeeded',
        currentStep: null,
        createdAt: '2026-10-01T00:00:00.000Z',
        startedAt: '2026-10-01T00:00:00.000Z',
        endedAt: '2026-10-01T00:01:00.000Z',
      },
    ],
    ...overrides,
  };
}

/** Oldest first, as the server answers: a failed one, the ready one, and a newer one still running. */
const commits: CommitsInfo = {
  live: sha('f'),
  head: sha('c'),
  newestGreen: sha('b'),
  ahead: 3,
  source: 'github',
  buildSource: 'github',
  commits: [
    { sha: sha('a'), message: 'Break the build', ci: 'failure', taskIds: [], run: { id: 409, url: RUN(409), startedAt: null, conclusion: 'failure' } },
    { sha: sha('b'), message: 'Fix the build', ci: 'success', taskIds: ['BND-T-1.1'], run: { id: 412, url: RUN(412), startedAt: null, conclusion: 'success' } },
    { sha: sha('c'), message: 'Newer work', ci: 'pending', taskIds: [], run: { id: 415, url: RUN(415), startedAt: null, conclusion: null } },
  ],
};

const noDrift: DriftState = { open: null, resolved: [] };
const frozen: FreezeInfo = { reason: 'release week', by: 'matt@example.com', from: '2026-10-05T00:00:00.000Z', until: '2026-10-09T00:00:00.000Z' };

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(<App />);
}

function routes(role: 'deployer' | 'viewer', extra: Record<string, Reply> = {}, body: AppDetail = detail()) {
  return mockFetch({
    'GET /api/auth/me': meReply(role),
    'GET /api/apps/bindery': { status: 200, body },
    'GET /api/apps/bindery/drift': { status: 200, body: noDrift },
    'GET /api/apps/bindery/freeze': { status: 200, body: { freeze: null } },
    'GET /api/apps/bindery/commits': { status: 200, body: commits },
    ...extra,
  });
}

/** The header's action group, and the primaries in it. */
async function headerActions(): Promise<{ group: HTMLElement; primaries: HTMLElement[] }> {
  const group = await screen.findByRole('group', { name: 'Actions for bindery' }, { timeout: 4000 });
  return { group, primaries: Array.from(group.querySelectorAll<HTMLElement>('.d3-btn--primary')) };
}

describe('the header (SHP-REQ-163, SHP-D-094)', () => {
  it('has one primary, Deploy the newest ready commit, with Freeze one tap beside it', async () => {
    routes('deployer');
    const user = userEvent.setup();
    renderAt('/apps/bindery');
    await screen.findByText('Ready to deploy bbbbbbb', {}, { timeout: 4000 });
    const { group, primaries } = await headerActions();
    expect(primaries.map((b) => b.textContent)).toEqual(['Deploy bbbbbbb']);
    expect(within(group).getByRole('button', { name: 'Freeze' })).toBeInTheDocument();
    expect(within(group).queryByRole('button', { name: 'Unfreeze' })).not.toBeInTheDocument();
    // The state badge and what is live, with who deployed it and the repository.
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Apps' })).toHaveAttribute('href', '/');
    expect(within(crumbs).getByText('bindery')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText(/· deployed .* by Matthew/)).toBeInTheDocument();

    await user.click(primaries[0] as HTMLElement);
    expect(opened.at(-1)).toEqual({ kind: 'deploy', app: 'bindery', sha: sha('b') });
  });

  it('while frozen offers Unfreeze instead of Freeze, shows Deploy disabled, and says who froze it and why', async () => {
    routes('deployer', { 'GET /api/apps/bindery/freeze': { status: 200, body: { freeze: frozen } } });
    renderAt('/apps/bindery');
    const { group, primaries } = await headerActions();
    await waitFor(() => {
      expect(within(group).getByRole('button', { name: 'Unfreeze' })).toBeInTheDocument();
    });
    expect(within(group).queryByRole('button', { name: 'Freeze' })).not.toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Deploy bbbbbbb' })).toBeDisabled();
    // No enabled Deploy anywhere: a freeze refuses every new deploy.
    expect(primaries.filter((b) => b.textContent.startsWith('Deploy'))).toEqual([]);
    for (const button of screen.getAllByRole('button', { name: /^Deploy / })) expect(button).toBeDisabled();
    expect(screen.getByText(/^Frozen until .* — release week · by matt@example\.com$/)).toBeInTheDocument();
  });

  it('makes Review the primary while a deploy waits on approval', async () => {
    routes('deployer', {
      'GET /api/approvals': {
        status: 200,
        body: [
          {
            deployId: 'd-ap',
            kind: 'deploy',
            app: 'bindery',
            sha: sha('b'),
            requester: { label: 'claude: bindery fix', repo: null, branch: null },
            requestedAt: '2026-10-06T00:00:00.000Z',
            expiresAt: '2026-10-06T01:00:00.000Z',
          },
        ],
      },
    });
    const user = userEvent.setup();
    renderAt('/apps/bindery');
    await screen.findByText('A deploy is waiting on approval', {}, { timeout: 4000 });
    const { primaries } = await headerActions();
    expect(primaries.map((b) => b.textContent)).toEqual(['Review bbbbbbb']);
    await user.click(primaries[0] as HTMLElement);
    expect(opened.at(-1)).toEqual({ kind: 'approve', app: 'bindery', sha: sha('b'), deployId: 'd-ap', requester: 'claude: bindery fix' });
  });

  it('gives a viewer no Freeze and no primary', async () => {
    routes('viewer');
    renderAt('/apps/bindery');
    await screen.findByText('Ready to deploy bbbbbbb', {}, { timeout: 4000 });
    const { group, primaries } = await headerActions();
    expect(primaries).toEqual([]);
    expect(within(group).queryByRole('button', { name: 'Freeze' })).not.toBeInTheDocument();
  });

  it('keeps scheduling and the app’s activity in the overflow menu', async () => {
    routes('deployer');
    const user = userEvent.setup();
    renderAt('/apps/bindery');
    await user.click(await screen.findByRole('button', { name: 'More for bindery' }, { timeout: 4000 }));
    expect(await screen.findByRole('menuitem', { name: 'Schedule a deploy…' })).toHaveAttribute('href', '/activity?kind=schedule');
    expect(screen.getByRole('menuitem', { name: 'All activity for bindery' })).toHaveAttribute('href', '/activity?app=bindery');
  });
});

describe('next up and the waiting commits (SHP-REQ-163, SHP-REQ-167)', () => {
  it("draws the ready commit's lane and links its commit page", async () => {
    routes('deployer');
    renderAt('/apps/bindery');
    const lane = await screen.findByRole('list', { name: 'Pipeline for bbbbbbb' }, { timeout: 4000 });
    expect(within(lane).getByRole('link', { name: 'Open run #412 ↗' })).toHaveAttribute('href', RUN(412));
    expect(screen.getByRole('link', { name: 'Open commit page →' })).toHaveAttribute('href', `/apps/bindery/commits/${sha('b')}`);
  });

  it('links each CI state to its run and each SHA to its commit page, and warns what rides along', async () => {
    routes('deployer');
    renderAt('/apps/bindery');
    const list = await screen.findByRole('list', { name: 'Commits waiting to deploy' }, { timeout: 4000 });
    expect(screen.getByRole('heading', { name: 'Waiting on main (3)' })).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'CI passed · #412 ↗' })).toHaveAttribute('href', RUN(412));
    expect(within(list).getByRole('link', { name: 'CI failed · #409 ↗' })).toHaveAttribute('href', RUN(409));
    expect(within(list).getByRole('link', { name: 'CI running · #415 ↗' })).toHaveAttribute('href', RUN(415));
    for (const c of ['a', 'b', 'c']) {
      expect(within(list).getByRole('link', { name: c.repeat(7) })).toHaveAttribute('href', `/apps/bindery/commits/${sha(c)}`);
    }
    expect(within(list).getByText('Deploying bbbbbbb also deploys aaaaaaa, whose CI failed.')).toBeInTheDocument();
    // A quiet Deploy on the ready row; the header holds the one primary.
    const rowDeploy = within(list).getByRole('button', { name: 'Deploy bbbbbbb' });
    expect(rowDeploy).not.toHaveClass('d3-btn--primary');
  });
});

describe('the tabs', () => {
  it('opens on Deploys: outcomes, a refusal with its reason, roll back inline, and the way to Activity', async () => {
    routes('deployer');
    renderAt('/apps/bindery');
    const list = await screen.findByRole('list', { name: 'Deploys' }, { timeout: 4000 });
    expect(screen.getByRole('tab', { name: 'Deploys' })).toHaveAttribute('aria-selected', 'true');
    const rows = within(list).getAllByRole('listitem');
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: 'Deploy fffffff' })).toHaveAttribute('href', '/deploys/d-f');
    expect(within(rows[0] as HTMLElement).getByText(/Matthew · .* · 3m 05s/)).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Refused')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('CI failed on 8888888.')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByRole('button', { name: 'Roll back to 7777777' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All deploys, rollbacks and refusals in Activity →' })).toHaveAttribute(
      'href',
      '/activity?app=bindery',
    );
  });

  it('puts the backups and the way into restore under Backups', async () => {
    routes('deployer', {
      'GET /api/apps/bindery/restore': {
        status: 200,
        body: {
          app: 'bindery',
          limited: null,
          candidates: [
            {
              backupDeployId: '00000000-0000-4000-8000-000000000001',
              backupDeployKind: 'deploy',
              backupDeploySha: sha('f'),
              path: '/data/backups/bindery-1.sql',
              size: 2048,
              createdAt: '2026-10-05T12:50:00.000Z',
              lossWindowSeconds: 60,
              lossWindow: '1 minute',
              releaseSha: sha('7'),
              available: true,
            },
          ],
        },
      },
    });
    const user = userEvent.setup();
    renderAt('/apps/bindery');
    await user.click(await screen.findByRole('tab', { name: 'Backups' }, { timeout: 4000 }));
    const backups = screen.getByRole('list', { name: 'Recent backups' });
    expect(within(backups).getByText('Before deploy fffffff')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Backups and restore' })).toHaveAttribute('href', '/apps/bindery/restore');
    // The rail says when the last one was taken.
    expect(within(screen.getByRole('complementary', { name: 'About bindery' })).getByText(/^Last .* ago$/)).toBeInTheDocument();
  });

  it('holds the manifest facts and the containers under Config', async () => {
    routes('deployer');
    const user = userEvent.setup();
    renderAt('/apps/bindery');
    await user.click(await screen.findByRole('tab', { name: 'Config' }, { timeout: 4000 }));
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByRole('heading', { name: 'How it deploys' })).toBeInTheDocument();
    expect(within(panel).getByText('No — a deployer can deploy directly')).toBeInTheDocument();
    expect(within(panel).getByRole('heading', { name: 'Running containers' })).toBeInTheDocument();
    expect(within(panel).getByText(`sha256:${'e'.repeat(12)}`)).toBeInTheDocument();
    expect(within(panel).getByRole('textbox', { name: 'Manifest' })).toBeInTheDocument();
  });
});

describe('the facts rail', () => {
  it('names the repository, the workflow that builds the images, and a scheduled deploy', async () => {
    routes('deployer', {
      'GET /api/schedules': {
        status: 200,
        body: {
          upcoming: [
            {
              id: 's1',
              deployId: 'd-s1',
              app: 'bindery',
              sha: sha('b'),
              fireAt: '2026-10-07T09:00:00.000Z',
              firedAt: null,
              cancelledAt: null,
              status: 'upcoming',
              by: 'matt@example.com',
              requester: { label: 'matt (console)', repo: null, branch: null },
              approval: { state: 'not_required', by: null, at: null },
              state: 'queued',
              refusal: null,
              createdAt: '2026-10-06T00:00:00.000Z',
            },
          ],
          past: [],
        },
      },
    });
    renderAt('/apps/bindery');
    const rail = await screen.findByRole('complementary', { name: 'About bindery' }, { timeout: 4000 });
    expect(within(rail).getByRole('link', { name: 'matdemers1/bindery ↗' })).toHaveAttribute('href', 'https://github.com/matdemers1/bindery');
    expect(within(rail).getByRole('link', { name: 'GitHub Actions · ci.yml ↗' })).toHaveAttribute(
      'href',
      'https://github.com/matdemers1/bindery/actions/workflows/ci.yml',
    );
    await waitFor(() => {
      expect(within(rail).getByRole('heading', { name: 'Scheduled' })).toBeInTheDocument();
    });
    expect(within(rail).getByText(/^Deploy/)).toHaveTextContent(/Deploy bbbbbbb at .*, by matt@example\.com/);
  });
});
