import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StackUpdateState, StackUpdateStep, type HostContainer, type HostSnapshot, type StackUpdateStatus } from '@shipyard/schema';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { needsYouItems } from '../src/lib/needsyou';
import {
  candidates,
  canUpdateStacks,
  changeWords,
  checkError,
  progressHeadline,
  requestedChange,
  resultHeadline,
  rollbackNote,
  runningTag,
  shortDigest,
  soakWords,
  stepsDone,
  tagOfImage,
  tracksSentence,
  whatHappens,
  type StackView,
} from '../src/lib/stacks';
import { STACK_UPDATE_STATE_WORDS, STACK_UPDATE_STEP_WORDS, updateAvailableWords, updateToVerb } from '../src/lib/words';
import { sourcesFor, filtersFromParams, stackUpdateMatches } from '../src/screens/activity/model';
import { meReply, mockFetch, type Call, type Reply } from './fetch';

/**
 * SHP-T-16.6 (SHP-ADR-010; SHP-REQ-194, SHP-REQ-199, SHP-REQ-200): an Operated stack updated by
 * digest says on its Host group what the agent found — "Update available · 17.1.1 → 17.1.2", or that
 * a check failed — and offers "Update…" to a deployer and above. The update sheet shows Running vs
 * Update to, the What happens chain from the manifest (with Back up only when there is a backup
 * step) and the image-only rollback note; a request held for approval says so, a running one shows
 * its step and the soak's countdown, a finished one its result, and a refusal its message and fix
 * verbatim. The history lists every update, with Roll back on an earlier success behind a confirm.
 * Needs you approves or denies a held one; Activity lists them under their own chip. A viewer sees
 * none of the state-changing controls.
 */

// ── Fixtures ─────────────────────────────────────────────────────────────

const D1 = `sha256:4c1e${'1'.repeat(56)}a91f`;
const D2 = `sha256:9b07${'2'.repeat(56)}3d22`;
const D0 = `sha256:0d04${'0'.repeat(56)}0004`;

const UPDATE_ID = '6b3c1f6e-6a4e-4d43-9a49-8e1f2b3c4d01';
const PREV_ID = '6b3c1f6e-6a4e-4d43-9a49-8e1f2b3c4d02';
const OLDER_ID = '6b3c1f6e-6a4e-4d43-9a49-8e1f2b3c4d03';
const HELD_ID = '6b3c1f6e-6a4e-4d43-9a49-8e1f2b3c4d04';

function status(overrides: Partial<StackUpdateStatus> = {}): StackUpdateStatus {
  return {
    id: UPDATE_ID,
    stack: 'forgejo',
    kind: 'update',
    state: 'queued',
    step: null,
    digests: { server: D2 },
    images: [],
    previous: [],
    toUpdateId: null,
    requesterLabel: 'Matt (console)',
    approvedBy: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    refusal: null,
    ...overrides,
  };
}

/** Oct 12's update: 17.0.4 → 17.1.1, what runs now. */
const PREVIOUS = status({
  id: PREV_ID,
  state: 'succeeded',
  digests: { server: D1 },
  images: [{ service: 'server', tag: '17.1.1', digest: D1 }],
  previous: [{ service: 'server', tag: '17.0.4', digest: D0 }],
  createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
  endedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
});

/** Sep 30's update: 17.0.3 → 17.0.4, approved by Matt. */
const OLDER = status({
  id: OLDER_ID,
  state: 'succeeded',
  digests: { server: D0 },
  images: [{ service: 'server', tag: '17.0.4', digest: D0 }],
  previous: [{ service: 'server', tag: '17.0.3', digest: `sha256:${'3'.repeat(64)}` }],
  requesterLabel: 'claude: forgejo',
  approvedBy: 'Matt',
  createdAt: new Date(Date.now() - 22 * 86_400_000).toISOString(),
  endedAt: new Date(Date.now() - 22 * 86_400_000).toISOString(),
});

const ROLLED_BACK = status({
  id: UPDATE_ID,
  state: 'rolled_back',
  images: [{ service: 'server', tag: '17.1.1', digest: D1 }],
  previous: [{ service: 'server', tag: '17.1.1', digest: D1 }],
  refusal: { code: 'health_failed', gate: 'none', message: 'Health check: the container reported unhealthy 3 times in 60 s.', fix: "Read the container's logs, then update again or pin 17.1.1." },
  endedAt: new Date().toISOString(),
});

function forgejo(overrides: Partial<StackView> = {}): StackView {
  return {
    name: 'forgejo',
    composeProject: 'forgejo',
    updates: 'digest',
    approval: 'tokens',
    soakSeconds: 120,
    services: [
      {
        service: 'server',
        image: 'codeberg.org/forgejo/forgejo',
        track: { semver: '17.x' },
        running: D1,
        candidate: { tag: '17.1.2', digest: D2 },
        checkedAt: new Date().toISOString(),
        error: null,
      },
    ],
    reportedAt: new Date().toISOString(),
    activeUpdate: null,
    lastUpdate: PREVIOUS,
    backup: { service: 'server', argv: ['forgejo', 'dump', '--file', '/backups/x.zip'] },
    ...overrides,
  };
}

function container(name: string, overrides: Partial<HostContainer>): HostContainer {
  return {
    id: name.padEnd(64, '0').replace(/[^0-9a-f]/g, 'a').slice(0, 64),
    name,
    image: 'postgres:16',
    imageId: `sha256:${'b'.repeat(64)}`,
    digest: null,
    state: 'running',
    health: 'healthy',
    restartCount: 0,
    createdAt: '2026-10-20T00:00:00.000Z',
    startedAt: '2026-10-20T00:00:01.000Z',
    compose: null,
    tier: 'observed',
    app: null,
    ports: [],
    mounts: [],
    stats: { cpuPercent: 1, memoryBytes: 1024, memoryLimitBytes: null },
    ...overrides,
  };
}

const FORGEJO_SERVER = container('forgejo-server', {
  id: 'f'.repeat(64),
  image: 'codeberg.org/forgejo/forgejo:17.1.1',
  compose: { project: 'forgejo', service: 'server' },
  tier: 'operated',
  app: 'forgejo',
});
const FORGEJO_DB = container('forgejo-db', { id: 'e'.repeat(64), compose: { project: 'forgejo', service: 'db' }, tier: 'operated', app: 'forgejo' });
const BINDERY = container('bindery-web-1', { id: 'd'.repeat(64), image: 'ghcr.io/matdemers1/bindery/web:sha-x', compose: { project: 'bindery', service: 'web' }, tier: 'shipped', app: 'bindery' });

function snapshot(): HostSnapshot {
  return {
    agent: { id: '7c0f4a0e-3b51-4d8e-9a8e-1f2e3d4c5b6a', fingerprint: 'SHA256:agent' },
    reportedAt: new Date().toISOString(),
    inventory: {
      sampledAt: new Date().toISOString(),
      containers: [BINDERY, FORGEJO_SERVER, FORGEJO_DB],
      volumes: [],
      images: [],
      networks: [],
      builderCache: { bytes: 0, reclaimableBytes: 0 },
      disk: { dataRoot: { path: '/DATA', freeBytes: 1, totalBytes: 2 }, dockerRoot: null },
    },
    samples: {},
  };
}

type Role = 'admin' | 'operator' | 'deployer' | 'viewer';
type Route = Reply | Reply[] | ((init: RequestInit | undefined) => Reply);

function hostRoutes(role: Role, stack: StackView = forgejo(), extra: Record<string, Route> = {}): Call[] {
  return mockFetch({
    'GET /api/auth/me': meReply(role),
    'GET /api/apps': { status: 200, body: { apps: [] } },
    'GET /api/approvals': { status: 200, body: [] },
    'GET /api/agent': { status: 200, body: [] },
    'GET /api/stack-updates/needs-you': { status: 200, body: { approvals: [], failed: [] } },
    'GET /api/host': { status: 200, body: { hosts: [snapshot()] } },
    'GET /api/stacks': { status: 200, body: { stacks: [stack] } },
    'GET /api/stacks/forgejo/updates': { status: 200, body: { items: [ROLLED_BACK, PREVIOUS, OLDER], nextCursor: null } },
    ...extra,
  });
}

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(<App />);
}

function posts(calls: readonly Call[], path: string): Call[] {
  return calls.filter((c) => c.method === 'POST' && c.path === path);
}

async function forgejoHeader(): Promise<HTMLElement> {
  const groups = await screen.findByRole('list', { name: 'Compose projects' });
  const toggle = await within(groups).findByRole('button', { name: 'forgejo' });
  const head = toggle.closest('.shp-hg__head');
  if (!(head instanceof HTMLElement)) throw new Error('no forgejo group header');
  return head;
}

// ── The model ────────────────────────────────────────────────────────────

describe('the stack update model (SHP-ADR-010)', () => {
  it('has words for every state and step the schema defines, never "Ship"', () => {
    for (const state of StackUpdateState.options) expect(STACK_UPDATE_STATE_WORDS[state], state).toBeTruthy();
    for (const step of StackUpdateStep.options) expect(STACK_UPDATE_STEP_WORDS[step], step).toBeTruthy();
    for (const words of [...Object.values(STACK_UPDATE_STATE_WORDS), ...Object.values(STACK_UPDATE_STEP_WORDS)]) {
      expect(words).not.toMatch(/\bship/i);
    }
    expect(updateToVerb('17.1.2')).toBe('Update to 17.1.2');
    expect(updateAvailableWords('17.1.1', '17.1.2')).toBe('Update available · 17.1.1 → 17.1.2');
  });

  it('shortens a digest to its first and last four, and reads the tag from an image line', () => {
    expect(shortDigest(D1)).toBe('sha256:4c1e…a91f');
    expect(tagOfImage('codeberg.org/forgejo/forgejo:17.1.1')).toBe('17.1.1');
    expect(tagOfImage('registry:5000/x/y')).toBeNull();
    expect(tagOfImage(`postgres:16@${D1}`)).toBe('16');
    expect(tagOfImage(`postgres@${D1}`)).toBeNull();
  });

  it('finds the running tag from the recorded images first, then the container (SHP-REQ-194)', () => {
    const svc = forgejo().services[0];
    if (svc === undefined) throw new Error('no service');
    expect(runningTag(svc, [PREVIOUS], [])).toBe('17.1.1');
    expect(runningTag(svc, [], [FORGEJO_SERVER], 'forgejo')).toBe('17.1.1');
    expect(runningTag(svc, [], [])).toBeNull();
  });

  it('builds the What happens chain from the manifest, with Back up only when there is a backup step', () => {
    const stack = forgejo();
    expect(whatHappens(stack, candidates(stack))).toEqual(['Re-check 17.x', 'Back up (forgejo dump)', 'Pull by digest', 'Swap the image line', 'Health', 'Soak 2 min']);
    expect(whatHappens(forgejo({ backup: null, soakSeconds: 45 }), candidates(stack))).toEqual(['Re-check 17.x', 'Pull by digest', 'Swap the image line', 'Health', 'Soak 45 s']);
    expect(whatHappens({ soakSeconds: 0 }, candidates(stack))).toEqual(['Re-check 17.x', 'Pull by digest', 'Swap the image line', 'Health']);
    expect(soakWords(90)).toBe('Soak 90 s');
  });

  it('says what a track follows, and that rollback is images only', () => {
    expect(tracksSentence({ image: 'codeberg.org/forgejo/forgejo', track: { semver: '17.x' } })).toBe(
      'Tracks codeberg.org/forgejo/forgejo at 17.x — the highest 17.x release the registry has.',
    );
    expect(tracksSentence({ image: 'postgres', track: 'pinned' })).toBe('postgres is pinned; Shipyard never moves it.');
    expect(rollbackNote('17.1.1', true)).toBe(
      'If health or the soak fails, Shipyard puts 17.1.1 back by its digest — images only. Data the new version changed stays changed; the backup taken first is listed under Backups.',
    );
    expect(rollbackNote('17.1.1', false)).toMatch(/stays changed\.$/);
  });

  it('reads the candidates and a failed check from the stack', () => {
    expect(candidates(forgejo())).toHaveLength(1);
    const pinned = forgejo().services.map((s) => ({ ...s, track: 'pinned' as const }));
    expect(candidates(forgejo({ services: pinned }))).toHaveLength(0);
    const failed = forgejo().services.map((s) => ({ ...s, candidate: null, error: 'registry unreachable' }));
    expect(checkError(forgejo({ services: failed }))).toBe('registry unreachable');
    expect(checkError(forgejo())).toBeNull();
  });

  it('words progress, the soak countdown and results', () => {
    expect(progressHeadline({ state: 'running', step: 'soaking' }, { elapsed: 74, of: 120 })).toBe('Soaking · 74 s of 120 s');
    expect(progressHeadline({ state: 'running', step: 'pulling' }, null)).toBe('Pulling by digest');
    expect(progressHeadline({ state: 'queued', step: null }, null)).toBe('Queued');
    expect(progressHeadline({ state: 'awaiting_approval', step: null }, null)).toBe('Waiting for approval');
    expect(stepsDone('soaking', true)).toEqual(['re-checked', 'backed up', 'pulled', 'swapped', 'healthy']);
    expect(stepsDone('pulling', false)).toEqual(['re-checked']);
    expect(resultHeadline(ROLLED_BACK, '17.1.2')).toBe('Update of forgejo to 17.1.2 rolled back — 17.1.1 is running again');
    expect(resultHeadline(status({ state: 'succeeded', images: [{ service: 'server', tag: '17.1.2', digest: D2 }] }), '17.1.2')).toBe('Updated forgejo to 17.1.2');
    expect(changeWords(PREVIOUS)).toBe('17.0.4 → 17.1.1');
    // One that did not stick names what it asked for: by tag when the candidate is known.
    expect(changeWords(ROLLED_BACK, (d) => (d === D2 ? '17.1.2' : null))).toBe('17.1.1 → 17.1.2');
    expect(changeWords(ROLLED_BACK)).toBe('17.1.1 → sha256:9b07…3d22');
    expect(changeWords(status({ state: 'awaiting_approval' }))).toBe('to sha256:9b07…3d22');
    expect(requestedChange(status(), forgejo())).toEqual({ from: '17.1.1', to: '17.1.2' });
  });

  it('lets deployer and above update, roll back and approve; never a viewer', () => {
    expect(canUpdateStacks('admin')).toBe(true);
    expect(canUpdateStacks('operator')).toBe(true);
    expect(canUpdateStacks('deployer')).toBe(true);
    expect(canUpdateStacks('viewer')).toBe(false);
    expect(canUpdateStacks(undefined)).toBe(false);
  });
});

// ── The group header ─────────────────────────────────────────────────────

describe('an Operated stack on Host (SHP-REQ-194)', () => {
  it('shows the candidate on its header, with Update… and History to a deployer', async () => {
    hostRoutes('deployer');
    renderAt('/host');
    const head = await forgejoHeader();
    expect(await within(head).findByText('Update available · 17.1.1 → 17.1.2')).toBeInTheDocument();
    expect(within(head).getByRole('button', { name: 'Update… forgejo' })).toBeInTheDocument();
    expect(within(head).getByRole('link', { name: 'History of forgejo' })).toHaveAttribute('href', '/host?stack=forgejo');
    // The Deployed group has no update controls.
    const bindery = (await screen.findByRole('button', { name: 'bindery' })).closest('.shp-hg__head') as HTMLElement;
    expect(within(bindery).queryByText(/Update available/)).not.toBeInTheDocument();
  });

  it('says when a check failed', async () => {
    const failed = forgejo().services.map((s) => ({ ...s, candidate: null, error: 'registry codeberg.org unreachable' }));
    hostRoutes('deployer', forgejo({ services: failed }));
    renderAt('/host');
    const head = await forgejoHeader();
    expect(await within(head).findByText("Couldn't check for updates: registry codeberg.org unreachable")).toBeInTheDocument();
    expect(within(head).queryByRole('button', { name: /^Update…/ })).not.toBeInTheDocument();
  });

  it('shows a viewer the candidate and the history, and no Update…', async () => {
    hostRoutes('viewer');
    renderAt('/host');
    const head = await forgejoHeader();
    expect(await within(head).findByText('Update available · 17.1.1 → 17.1.2')).toBeInTheDocument();
    expect(within(head).queryByRole('button', { name: /^Update…/ })).not.toBeInTheDocument();
    expect(within(head).getByRole('link', { name: 'History of forgejo' })).toBeInTheDocument();
  });

  it('opens the update sheet from Update… with ?stack=&update=1, and Back closes it', async () => {
    hostRoutes('admin');
    const user = userEvent.setup();
    renderAt('/host');
    const head = await forgejoHeader();
    await user.click(await within(head).findByRole('button', { name: 'Update… forgejo' }));
    expect(await screen.findByRole('dialog', { name: 'Update forgejo' })).toBeInTheDocument();
    const params = new URLSearchParams(window.location.search);
    expect(params.get('stack')).toBe('forgejo');
    expect(params.get('update')).toBe('1');
    window.history.back();
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Update forgejo' })).not.toBeInTheDocument();
    });
  });
});

// ── The update sheet ─────────────────────────────────────────────────────

describe('the update sheet (SHP-REQ-194, SHP-REQ-199)', () => {
  it('shows Running vs Update to, the chain with Back up, the rollback note and Update to <tag>', async () => {
    hostRoutes('deployer');
    renderAt('/host?stack=forgejo&update=1');
    const sheet = await screen.findByRole('dialog', { name: 'Update forgejo' });
    expect(within(sheet).getByText('Tracks codeberg.org/forgejo/forgejo at 17.x — the highest 17.x release the registry has.')).toBeInTheDocument();
    const table = within(sheet).getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Service', 'Running', 'Update to']);
    const row = within(table).getByRole('row', { name: /server/ });
    expect(within(row).getByText('17.1.1')).toBeInTheDocument();
    expect(within(row).getByText('17.1.2')).toBeInTheDocument();
    expect(within(row).getByText('sha256:4c1e…a91f')).toHaveAttribute('title', D1);
    expect(within(row).getByText('sha256:9b07…3d22')).toHaveAttribute('title', D2);
    const chain = within(sheet).getByRole('list');
    expect(within(chain).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Re-check 17.x',
      'Back up (forgejo dump)',
      'Pull by digest',
      'Swap the image line',
      'Health',
      'Soak 2 min',
    ]);
    expect(within(sheet).getByText(/^If health or the soak fails, Shipyard puts 17\.1\.1 back by its digest — images only\./)).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Update to 17.1.2' })).toBeEnabled();
    expect(within(sheet).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('leaves Back up out of the chain when the stack has no backup step', async () => {
    hostRoutes('deployer', forgejo({ backup: null }));
    renderAt('/host?stack=forgejo&update=1');
    const sheet = await screen.findByRole('dialog', { name: 'Update forgejo' });
    expect(within(within(sheet).getByRole('list')).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Re-check 17.x',
      'Pull by digest',
      'Swap the image line',
      'Health',
      'Soak 2 min',
    ]);
    expect(within(sheet).getByText(/stays changed\.$/)).toBeInTheDocument();
  });

  it('offers a viewer the facts and no Update to', async () => {
    hostRoutes('viewer');
    renderAt('/host?stack=forgejo&update=1');
    const sheet = await screen.findByRole('dialog', { name: 'Update forgejo' });
    expect(within(sheet).getByRole('table')).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'Update to 17.1.2' })).not.toBeInTheDocument();
  });

  it('asks with no digests, and says a held request waits for a deployer (SHP-REQ-199)', async () => {
    const calls = hostRoutes('deployer', forgejo({ approval: 'always' }), {
      'POST /api/stacks/forgejo/updates': { status: 202, body: status({ state: 'awaiting_approval' }) },
      [`GET /api/stack-updates/${UPDATE_ID}`]: { status: 200, body: status({ state: 'awaiting_approval' }) },
    });
    const user = userEvent.setup();
    renderAt('/host?stack=forgejo&update=1');
    const sheet = await screen.findByRole('dialog', { name: 'Update forgejo' });
    await user.click(within(sheet).getByRole('button', { name: 'Update to 17.1.2' }));
    expect(await within(sheet).findByText('Waiting for a deployer to approve')).toBeInTheDocument();
    expect(posts(calls, '/api/stacks/forgejo/updates')).toEqual([{ method: 'POST', path: '/api/stacks/forgejo/updates', body: {} }]);
    expect(within(sheet).queryByRole('button', { name: 'Update to 17.1.2' })).not.toBeInTheDocument();
  });

  it('shows the step and the soak countdown while it runs, then the result inline', async () => {
    hostRoutes('deployer', forgejo(), {
      'POST /api/stacks/forgejo/updates': { status: 202, body: status() },
      [`GET /api/stack-updates/${UPDATE_ID}`]: [
        { status: 200, body: status({ state: 'running', step: 'soaking', startedAt: new Date().toISOString() }) },
        { status: 200, body: status({ state: 'running', step: 'soaking', startedAt: new Date().toISOString() }) },
        {
          status: 200,
          body: status({
            state: 'succeeded',
            images: [{ service: 'server', tag: '17.1.2', digest: D2 }],
            previous: [{ service: 'server', tag: '17.1.1', digest: D1 }],
            endedAt: new Date().toISOString(),
          }),
        },
      ],
    });
    const user = userEvent.setup();
    renderAt('/host?stack=forgejo&update=1');
    const sheet = await screen.findByRole('dialog', { name: 'Update forgejo' });
    await user.click(within(sheet).getByRole('button', { name: 'Update to 17.1.2' }));
    expect(await within(sheet).findByText(/^Soaking · \d+ s of 120 s$/, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(within(sheet).getByText(/^Re-checked · backed up · pulled · swapped · healthy/)).toBeInTheDocument();
    expect(await within(sheet).findByText('Updated forgejo to 17.1.2', {}, { timeout: 6000 })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Done' })).toBeInTheDocument();
  }, 15_000);

  it('shows a rolled-back result with the message and fix verbatim', async () => {
    hostRoutes('deployer', forgejo(), {
      'POST /api/stacks/forgejo/updates': { status: 202, body: status() },
      [`GET /api/stack-updates/${UPDATE_ID}`]: { status: 200, body: ROLLED_BACK },
    });
    const user = userEvent.setup();
    renderAt('/host?stack=forgejo&update=1');
    const sheet = await screen.findByRole('dialog', { name: 'Update forgejo' });
    await user.click(within(sheet).getByRole('button', { name: 'Update to 17.1.2' }));
    expect(await within(sheet).findByText('Update of forgejo to 17.1.2 rolled back — 17.1.1 is running again', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(within(sheet).getByText('Health check: the container reported unhealthy 3 times in 60 s.')).toBeInTheDocument();
    expect(within(sheet).getByText("Read the container's logs, then update again or pin 17.1.1.")).toBeInTheDocument();
  });

  it.each([
    ['agent_offline', 'The agent that runs this has not polled the server recently.', 'Check the agent is running and can reach the server, then retry.'],
    ['locked', 'forgejo is being updated by claude: homelab upkeep: soaking.', 'Wait for stack update x to finish, then request again; Shipyard does not queue stack updates.'],
    ['digest_not_tracked', 'server of forgejo is pinned; Shipyard never moves it.', "Change its track in the stack's manifest on the host to update it here."],
  ])('shows a %s refusal verbatim', async (code, message, fix) => {
    hostRoutes('deployer', forgejo(), {
      'POST /api/stacks/forgejo/updates': { status: 409, body: { error: { code, gate: 'none', message, fix } } },
    });
    const user = userEvent.setup();
    renderAt('/host?stack=forgejo&update=1');
    const sheet = await screen.findByRole('dialog', { name: 'Update forgejo' });
    await user.click(within(sheet).getByRole('button', { name: 'Update to 17.1.2' }));
    expect(await within(sheet).findByText(message)).toBeInTheDocument();
    expect(within(sheet).getByText(fix)).toBeInTheDocument();
  });
});

// ── History and rollback ─────────────────────────────────────────────────

describe('the stack history (SHP-REQ-200)', () => {
  it('lists every update newest first, with Roll back only on an earlier success, confirmed', async () => {
    const calls = hostRoutes('deployer', forgejo(), {
      'POST /api/stacks/forgejo/rollback': { status: 202, body: status({ id: HELD_ID, kind: 'rollback', toUpdateId: OLDER_ID }) },
      [`GET /api/stack-updates/${HELD_ID}`]: {
        status: 200,
        body: status({ id: HELD_ID, kind: 'rollback', toUpdateId: OLDER_ID, state: 'succeeded', images: [{ service: 'server', tag: '17.0.4', digest: D0 }], endedAt: new Date().toISOString() }),
      },
    });
    const user = userEvent.setup();
    renderAt('/host?stack=forgejo');
    const sheet = await screen.findByRole('dialog', { name: 'forgejo' });
    const list = await within(sheet).findByRole('list', { name: 'Update history' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText('Rolled back')).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText('17.1.1 → 17.1.2')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('17.0.4 → 17.1.1')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('claude: forgejo (approved by Matt)')).toBeInTheDocument();
    // The newest success is what runs now; the rolled-back one is no target.
    expect(within(rows[0] as HTMLElement).queryByRole('button')).not.toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).queryByRole('button')).not.toBeInTheDocument();
    await user.click(within(rows[2] as HTMLElement).getByRole('button', { name: 'Roll back to 17.0.4' }));

    const confirm = await screen.findByRole('dialog', { name: 'Roll back forgejo to 17.0.4?' });
    expect(posts(calls, '/api/stacks/forgejo/rollback')).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Roll back forgejo to 17.0.4' }));
    await waitFor(() => {
      expect(posts(calls, '/api/stacks/forgejo/rollback')).toEqual([{ method: 'POST', path: '/api/stacks/forgejo/rollback', body: { toUpdateId: OLDER_ID } }]);
    });
    expect(await within(sheet).findByText('Rolled forgejo back to 17.0.4', {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it('sends nothing when the rollback is cancelled', async () => {
    const calls = hostRoutes('deployer');
    const user = userEvent.setup();
    renderAt('/host?stack=forgejo');
    const sheet = await screen.findByRole('dialog', { name: 'forgejo' });
    const list = await within(sheet).findByRole('list', { name: 'Update history' });
    await user.click(within(list).getByRole('button', { name: 'Roll back to 17.0.4' }));
    const confirm = await screen.findByRole('dialog', { name: 'Roll back forgejo to 17.0.4?' });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Roll back forgejo to 17.0.4?' })).not.toBeInTheDocument();
    });
    expect(posts(calls, '/api/stacks/forgejo/rollback')).toHaveLength(0);
  });

  it('shows a viewer the history and no Roll back', async () => {
    hostRoutes('viewer');
    renderAt('/host?stack=forgejo');
    const sheet = await screen.findByRole('dialog', { name: 'forgejo' });
    const list = await within(sheet).findByRole('list', { name: 'Update history' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).queryByRole('button')).not.toBeInTheDocument();
  });

  it('follows an update already under way when the sheet opens', async () => {
    const active = status({ state: 'running', step: 'pulling', requesterLabel: 'claude: homelab upkeep' });
    hostRoutes('deployer', forgejo({ activeUpdate: active }), {
      [`GET /api/stack-updates/${UPDATE_ID}`]: { status: 200, body: active },
    });
    renderAt('/host?stack=forgejo');
    const sheet = await screen.findByRole('dialog', { name: 'forgejo' });
    expect(await within(sheet).findByText('Pulling by digest')).toBeInTheDocument();
    expect(within(sheet).getByText(/requested by claude: homelab upkeep/)).toBeInTheDocument();
  });

  it('says so when the address names a stack nobody adopted', async () => {
    hostRoutes('deployer');
    renderAt('/host?stack=nope');
    expect(await screen.findByRole('dialog', { name: 'Stack not found' })).toBeInTheDocument();
  });
});

// ── Needs you ────────────────────────────────────────────────────────────

const HELD = status({ id: HELD_ID, state: 'awaiting_approval', requesterLabel: 'claude: homelab upkeep', createdAt: new Date(Date.now() - 3 * 60_000).toISOString() });

function appsRoutes(role: Role, extra: Record<string, Route> = {}): Call[] {
  return mockFetch({
    'GET /api/auth/me': meReply(role),
    'GET /api/auth/methods': { status: 200, body: { password: true, d3auth: false } },
    'GET /api/apps': { status: 200, body: { apps: [] } },
    'GET /api/approvals': { status: 200, body: [] },
    'GET /api/agent': { status: 200, body: [{ id: 'a1', confirmed: true, lastHeartbeatAt: new Date().toISOString(), stale: false }] },
    'GET /api/groups': { status: 200, body: [] },
    'GET /api/system': { status: 403, body: { error: { code: 'forbidden', gate: 'none', message: 'no', fix: 'no' } } },
    'GET /api/stacks': { status: 200, body: { stacks: [forgejo()] } },
    ...extra,
  });
}

describe('Needs you lists stack updates (SHP-REQ-199)', () => {
  it('puts a held one first and a rolled-back one after, in the badge count', () => {
    const items = needsYouItems({ apps: [], approvals: [], system: null, stackNeeds: { approvals: [HELD], failed: [ROLLED_BACK] } });
    expect(items).toEqual([
      { kind: 'stack-approval', stack: 'forgejo', updateId: HELD_ID },
      { kind: 'stack-failed', stack: 'forgejo', updateId: UPDATE_ID },
    ]);
  });

  it('approves a held update with Approve and update, and reads the list again', async () => {
    let decided = false;
    const calls = appsRoutes('deployer', {
      'GET /api/stack-updates/needs-you': () => ({ status: 200, body: { approvals: decided ? [] : [HELD], failed: [] } }),
      [`POST /api/stack-updates/${HELD_ID}/approve`]: () => {
        decided = true;
        return { status: 200, body: { ...HELD, state: 'queued', approvedBy: 'Matt' } };
      },
    });
    const user = userEvent.setup();
    renderAt('/');
    const needs = await screen.findByRole('list', { name: 'Needs you' });
    expect(needs).toHaveTextContent('forgejo update 17.1.1 → 17.1.2 · asked by claude: homelab upkeep');
    await user.click(within(needs).getByRole('button', { name: 'Approve and update forgejo' }));
    await waitFor(() => {
      expect(posts(calls, `/api/stack-updates/${HELD_ID}/approve`)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.queryByRole('list', { name: 'Needs you' })).not.toBeInTheDocument();
    });
  });

  it('denies a held update after a confirm', async () => {
    let decided = false;
    const calls = appsRoutes('deployer', {
      'GET /api/stack-updates/needs-you': () => ({ status: 200, body: { approvals: decided ? [] : [HELD], failed: [] } }),
      [`POST /api/stack-updates/${HELD_ID}/deny`]: () => {
        decided = true;
        return { status: 200, body: { ...HELD, state: 'denied' } };
      },
    });
    const user = userEvent.setup();
    renderAt('/');
    const needs = await screen.findByRole('list', { name: 'Needs you' });
    await user.click(within(needs).getByRole('button', { name: 'Deny the forgejo update' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deny the forgejo update' });
    expect(posts(calls, `/api/stack-updates/${HELD_ID}/deny`)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Deny' }));
    await waitFor(() => {
      expect(posts(calls, `/api/stack-updates/${HELD_ID}/deny`)).toHaveLength(1);
    });
  });

  it("shows an approval's refusal verbatim", async () => {
    appsRoutes('deployer', {
      'GET /api/stack-updates/needs-you': { status: 200, body: { approvals: [HELD], failed: [] } },
      [`POST /api/stack-updates/${HELD_ID}/approve`]: {
        status: 409,
        body: { error: { code: 'agent_offline', gate: 'none', message: 'The agent that runs this has not polled the server recently.', fix: 'Check the agent is running and can reach the server, then retry.' } },
      },
    });
    const user = userEvent.setup();
    renderAt('/');
    const needs = await screen.findByRole('list', { name: 'Needs you' });
    await user.click(within(needs).getByRole('button', { name: 'Approve and update forgejo' }));
    expect(await screen.findByText('The agent that runs this has not polled the server recently.')).toBeInTheDocument();
    expect(screen.getByText('Check the agent is running and can reach the server, then retry.')).toBeInTheDocument();
  });

  it('shows a viewer the rows, a rolled-back stack linking to Host, and no Approve or Deny', async () => {
    appsRoutes('viewer', {
      'GET /api/stack-updates/needs-you': { status: 200, body: { approvals: [HELD], failed: [ROLLED_BACK] } },
    });
    renderAt('/');
    const needs = await screen.findByRole('list', { name: 'Needs you' });
    expect(within(needs).getAllByRole('listitem')).toHaveLength(2);
    expect(within(needs).queryByRole('button')).not.toBeInTheDocument();
    expect(needs).toHaveTextContent('forgejo update rolled back — Health check: the container reported unhealthy 3 times in 60 s.');
    expect(within(needs).getByRole('link', { name: 'Open forgejo on Host' })).toHaveAttribute('href', '/host?stack=forgejo');
  });
});

// ── Activity ─────────────────────────────────────────────────────────────

function activityRoutes(items: StackUpdateStatus[]): Call[] {
  return mockFetch({
    'GET /api/auth/me': meReply('viewer'),
    'GET /api/apps': { status: 200, body: { apps: [] } },
    'GET /api/deploys/timeline': { status: 200, body: { items: [], nextCursor: null } },
    'GET /api/builds': { status: 200, body: { items: [], nextCursor: null } },
    'GET /api/schedules': { status: 200, body: { upcoming: [], past: [] } },
    'GET /api/actions': { status: 200, body: { items: [], nextCursor: null } },
    'GET /api/stack-updates': { status: 200, body: { items, nextCursor: null } },
  });
}

describe('Activity lists stack updates (SHP-REQ-200)', () => {
  it('has its own source and chip, and matches by stack, requester and outcome', () => {
    expect(sourcesFor(filtersFromParams(new URLSearchParams('kind=stack-update')))).toEqual({
      deploys: false,
      builds: false,
      scheduleRows: false,
      showUpcoming: false,
      actions: false,
      stackUpdates: true,
    });
    expect(sourcesFor(filtersFromParams(new URLSearchParams(''))).stackUpdates).toBe(true);
    expect(stackUpdateMatches(PREVIOUS, filtersFromParams(new URLSearchParams('app=forgejo')))).toBe(true);
    expect(stackUpdateMatches(PREVIOUS, filtersFromParams(new URLSearchParams('app=immich')))).toBe(false);
    expect(stackUpdateMatches(OLDER, filtersFromParams(new URLSearchParams('requester=matt')))).toBe(true);
    expect(stackUpdateMatches(ROLLED_BACK, filtersFromParams(new URLSearchParams('outcome=rolled_back')))).toBe(true);
    expect(stackUpdateMatches(PREVIOUS, filtersFromParams(new URLSearchParams('kind=refusal')))).toBe(false);
  });

  it('puts a stack update in the feed with its outcome, what moved, who and a link to the stack', async () => {
    activityRoutes([status({ ...PREVIOUS, createdAt: new Date(Date.now() - 5 * 60_000).toISOString() })]);
    renderAt('/activity');
    const badge = await screen.findByText('Succeeded');
    const row = badge.closest('li') as HTMLElement;
    expect(within(row).getByText('forgejo')).toBeInTheDocument();
    expect(within(row).getByText(/^Update 17\.0\.4 → 17\.1\.1/)).toBeInTheDocument();
    expect(within(row).getAllByText(/Matt \(console\)/).length).toBeGreaterThan(0);
    expect(within(row).getByRole('link')).toHaveAttribute('href', '/host?stack=forgejo');
  });

  it('has a Stack updates chip that narrows the feed to them', async () => {
    activityRoutes([status({ ...ROLLED_BACK, createdAt: new Date(Date.now() - 5 * 60_000).toISOString() })]);
    const user = userEvent.setup();
    renderAt('/activity');
    await screen.findByText('Rolled back');
    await user.click(screen.getByRole('button', { name: 'Stack updates' }));
    expect(new URLSearchParams(window.location.search).get('kind')).toBe('stack-update');
    expect(screen.getByRole('button', { name: 'Stack updates' })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByText(/Health check: the container reported unhealthy 3 times in 60 s\./)).toBeInTheDocument();
  });
});
