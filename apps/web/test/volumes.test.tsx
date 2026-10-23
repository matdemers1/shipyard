import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MaintenanceState, MaintenanceStep, type HostContainer, type HostSnapshot, type HostVolume, type MaintenanceStatus, type PruneItem, type VolumeArchive } from '@shipyard/schema';
import { StrictMode } from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { PruneSheet } from '../src/screens/host/PruneSheet';
import type { Role } from '../src/lib/api';
import {
  archiveTime,
  confirmMatches,
  progressHeadline,
  pruneGroups,
  pruneItemName,
  rowActions,
  safetyArchiveLine,
  sortVolumeRows,
  volumeOwners,
  volumeRows,
} from '../src/lib/maintenance';
import { needsYouItems } from '../src/lib/needsyou';
import { MAINTENANCE_STATE_WORDS, MAINTENANCE_STEP_WORDS } from '../src/lib/words';
import { filtersFromParams, maintenanceMatches, sourcesFor } from '../src/screens/activity/model';
import { meReply, mockFetch, type Call, type Reply } from './fetch';

/**
 * SHP-T-17.6 (SHP-ADR-012 and its 2026-10-23 amendment; SHP-REQ-201, SHP-REQ-202, SHP-REQ-203,
 * SHP-REQ-205): Host's volumes list orphans first, then owned, then Observed. Back up is a
 * deployer's on an owned volume; Restore… and Delete… are an admin's — Delete only on an orphan no
 * app or stack claims — and an Observed volume offers nothing. Restore and delete want the volume's
 * name typed exactly and a fresh step-up: a `step_up_required` asks for the code, which is stepped
 * up and the request asked again. Prune runs a dry run on open and prunes from it by its ID. A job
 * is followed every second until it ends, and its result — or the refusal's message and fix,
 * verbatim — shows where it was asked. Needs you lists failed backups and low disk; Activity lists
 * every job under its own chip.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

// ── Fixtures ─────────────────────────────────────────────────────────────

function container(name: string, overrides: Partial<HostContainer>): HostContainer {
  return {
    id: name.padEnd(64, '0').replace(/[^0-9a-f]/g, 'a').slice(0, 64),
    name,
    image: 'postgres:16',
    imageId: `sha256:${'b'.repeat(64)}`,
    digest: null,
    state: 'running',
    health: 'none',
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

function volume(name: string, overrides: Partial<HostVolume> = {}): HostVolume {
  return { name, driver: 'local', sizeBytes: 100 * MB, mountedBy: [], composeProject: null, orphan: false, createdAt: '2026-03-02T14:08:00.000Z', ...overrides };
}

const CONTAINERS: HostContainer[] = [
  container('bindery-postgres-1', { compose: { project: 'bindery', service: 'postgres' }, tier: 'shipped', app: 'bindery' }),
  container('bindery-web-1', { compose: { project: 'bindery', service: 'web' }, tier: 'shipped', app: 'bindery' }),
  container('forgejo', { compose: { project: 'forgejo', service: 'server' }, tier: 'operated', app: 'forgejo' }),
  container('forgejo-db', { compose: { project: 'forgejo', service: 'db' }, tier: 'operated', app: 'forgejo' }),
  container('portainer', {}),
];

const VOLUMES: HostVolume[] = [
  volume('portainer_data', { sizeBytes: 24 * MB, mountedBy: ['portainer'] }),
  volume('bindery_pgdata', { sizeBytes: Math.round(2.3 * GB), mountedBy: ['bindery-postgres-1'], composeProject: 'bindery' }),
  volume('forgejo_data', { sizeBytes: Math.round(1.1 * GB), mountedBy: ['forgejo'], composeProject: 'forgejo' }),
  volume('kardashev_pgdata', { sizeBytes: 412 * MB, orphan: true, composeProject: 'kardashev' }),
  // An orphan whose compose label names a Deployed app's project: never offered Delete.
  volume('bindery_cache', { sizeBytes: 5 * MB, orphan: true, composeProject: 'bindery' }),
];

function snapshot(volumes: HostVolume[] = VOLUMES): HostSnapshot {
  return {
    agent: { id: '7c0f4a0e-3b51-4d8e-9a8e-1f2e3d4c5b6a', fingerprint: 'SHA256:agent' },
    reportedAt: new Date().toISOString(),
    inventory: {
      sampledAt: new Date().toISOString(),
      containers: CONTAINERS,
      volumes,
      images: [],
      networks: [],
      builderCache: { bytes: 4 * GB, reclaimableBytes: GB },
      disk: { dataRoot: { path: '/DATA', freeBytes: 875 * GB, totalBytes: 904 * GB }, dockerRoot: null },
    },
    samples: {},
  };
}

const NEWER = '3f1c1f6e-6a4e-4d43-9a49-8e1f2b3c4d01';
const OLDER = '3f1c1f6e-6a4e-4d43-9a49-8e1f2b3c4d02';
const JOB = '9a1c1f6e-6a4e-4d43-9a49-8e1f2b3c4d10';
const DRY = '9a1c1f6e-6a4e-4d43-9a49-8e1f2b3c4d11';
const REAL = '9a1c1f6e-6a4e-4d43-9a49-8e1f2b3c4d12';

function archive(id: string, createdAt: string, quiesced: boolean, sizeBytes = Math.round(1.1 * GB)): VolumeArchive {
  return { archiveId: id, volume: 'forgejo_data', owner: { kind: 'stack', name: 'forgejo' }, createdAt, sizeBytes, sha256: 'a'.repeat(64), quiesced };
}

const ARCHIVES = [archive(NEWER, new Date(Date.now() - 60 * 60_000).toISOString(), true), archive(OLDER, '2026-10-18T11:12:00.000Z', false, 998 * MB)];

function job(overrides: Partial<MaintenanceStatus> = {}): MaintenanceStatus {
  return {
    id: JOB,
    kind: 'volume-backup',
    state: 'queued',
    step: null,
    volume: 'forgejo_data',
    owner: { kind: 'stack', name: 'forgejo' },
    requester: { kind: 'user', label: 'Matt (console)' },
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    archive: null,
    removedArchives: [],
    prune: null,
    refusal: null,
    output: null,
    ...overrides,
  };
}

function refusal(code: string, message: string, fix: string, status: number): Reply {
  return { status, body: { error: { code, gate: 'none', message, fix } } };
}

const STEP_UP_REQUIRED = refusal('step_up_required', 'Confirm it’s you before restoring or deleting a volume.', 'Enter a code from your authenticator, then retry within ten minutes.', 403);

/** An app row as `GET /api/apps` sends it, with the compose project its manifest names. */
function appRow(name: string, composeProject: string | null = name) {
  return { name, repo: null, defaultBranch: 'main', liveSha: null, reportedAt: null, drift: null, approvalPolicy: 'none', frozen: false, active: null, composeProject };
}

/** An adopted stack as `GET /api/stacks` sends it, adopted for lifecycle only. */
function stackRow(name: string) {
  return { name, composeProject: name, updates: 'none', approval: null, soakSeconds: null, services: [], reportedAt: new Date().toISOString(), activeUpdate: null, lastUpdate: null };
}

/** The unretired app bindery and the adopted stack forgejo: what owns a volume here. */
const OWNERS = volumeOwners([{ name: 'bindery', composeProject: 'bindery' }], [{ name: 'forgejo', composeProject: 'forgejo' }]);

type Route = Reply | Reply[] | ((init: RequestInit | undefined) => Reply);

function hostRoutes(role: Role, extra: Record<string, Route> = {}, volumes: HostVolume[] = VOLUMES): Call[] {
  return mockFetch({
    'GET /api/auth/me': meReply(role),
    'GET /api/apps': { status: 200, body: { apps: [appRow('bindery')] } },
    'GET /api/approvals': { status: 200, body: [] },
    'GET /api/agent': { status: 200, body: [] },
    'GET /api/system': { status: 403, body: { error: { code: 'forbidden', gate: 'none', message: 'no', fix: 'no' } } },
    'GET /api/stack-updates/needs-you': { status: 200, body: { approvals: [], failed: [] } },
    'GET /api/maintenance/needs-you': { status: 200, body: { failedBackups: [], lowDisk: [] } },
    'GET /api/host': { status: 200, body: { hosts: [snapshot(volumes)] } },
    'GET /api/stacks': { status: 200, body: { stacks: [stackRow('forgejo')] } },
    'GET /api/volumes/forgejo_data/archives': { status: 200, body: { archives: ARCHIVES } },
    'GET /api/volumes/bindery_pgdata/archives': { status: 200, body: { archives: [] } },
    'GET /api/volumes/bindery_cache/archives': { status: 200, body: { archives: [] } },
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

async function volumeRow(name: string): Promise<HTMLElement> {
  const list = await screen.findByRole('list', { name: 'Volumes', hidden: true });
  const cell = await within(list).findByText(name, { selector: '.shp-hv__name' });
  const row = cell.closest('li');
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${name}`);
  return row;
}

function buttonsOf(row: HTMLElement): string[] {
  return within(row)
    .queryAllByRole('button', { hidden: true })
    .map((b) => b.getAttribute('aria-label') ?? b.textContent);
}

// ── The model ────────────────────────────────────────────────────────────

describe('whose volume it is (SHP-ADR-012)', () => {
  const rows = volumeRows(snapshot().inventory, OWNERS);
  const kindOf = (name: string) => rows.find((r) => r.volume.name === name)?.kind;

  it('owns a volume a Deployed app or Operated stack mounts, and leaves the rest to their kind', () => {
    expect(kindOf('bindery_pgdata')).toBe('owned');
    expect(rows.find((r) => r.volume.name === 'bindery_pgdata')?.owner).toEqual({ kind: 'app', name: 'bindery', project: 'bindery' });
    expect(kindOf('forgejo_data')).toBe('owned');
    expect(rows.find((r) => r.volume.name === 'forgejo_data')?.ownerContainers).toBe(2);
    expect(kindOf('kardashev_pgdata')).toBe('orphan');
    expect(kindOf('bindery_cache')).toBe('claimed');
    expect(kindOf('portainer_data')).toBe('observed');
  });

  it('counts an orphan labelled with an adopted stack’s project as claimed', () => {
    const adopted = volumeRows({ containers: [], volumes: [volume('immich_old', { orphan: true, composeProject: 'immich' })] }, volumeOwners([], [{ name: 'immich', composeProject: 'immich' }]));
    expect(adopted[0]?.kind).toBe('claimed');
  });

  it('keeps Delete off an app’s volume once its last container is gone (a compose down)', () => {
    // kardashev is an unretired app with no container left on the host: its volume is claimed.
    const owners = volumeOwners([{ name: 'kardashev', composeProject: 'kardashev' }], []);
    const rows = volumeRows({ containers: [], volumes: [volume('kardashev_pgdata', { orphan: true, composeProject: 'kardashev' })] }, owners);
    expect(rows[0]?.kind).toBe('claimed');
    expect(rows[0]?.owner).toEqual({ kind: 'app', name: 'kardashev', project: 'kardashev' });
    expect(rowActions(rows[0] ?? { kind: 'orphan' }, 'admin', null).remove).toBe(false);
  });

  it('owns nothing by a container’s own word: a retired app’s volume is Observed, its orphan deletable', () => {
    // The agent still tiers bindery's container Deployed, but bindery is no longer in GET /api/apps.
    const rows = volumeRows(snapshot().inventory, volumeOwners([], [{ name: 'forgejo', composeProject: 'forgejo' }]));
    expect(rows.find((r) => r.volume.name === 'bindery_pgdata')?.kind).toBe('observed');
    expect(rows.find((r) => r.volume.name === 'bindery_cache')?.kind).toBe('orphan');
  });

  it('sorts orphans first, then owned, then Observed, the largest first in each', () => {
    expect(sortVolumeRows(rows).map((r) => r.volume.name)).toEqual(['kardashev_pgdata', 'bindery_pgdata', 'forgejo_data', 'bindery_cache', 'portainer_data']);
  });

  it.each([
    ['viewer', 'owned', 3, { backUp: false, restore: false, remove: false }],
    ['deployer', 'owned', 3, { backUp: true, restore: false, remove: false }],
    ['operator', 'owned', 3, { backUp: true, restore: false, remove: false }],
    ['admin', 'owned', 3, { backUp: true, restore: true, remove: false }],
    ['admin', 'owned', 0, { backUp: true, restore: false, remove: false }],
    ['deployer', 'orphan', null, { backUp: false, restore: false, remove: false }],
    ['admin', 'orphan', null, { backUp: false, restore: false, remove: true }],
    ['admin', 'claimed', 2, { backUp: false, restore: false, remove: false }],
    ['admin', 'observed', null, { backUp: false, restore: false, remove: false }],
  ] as const)('a %s on an %s volume (%s archives)', (role, kind, count, expected) => {
    expect(rowActions({ kind }, role, count)).toEqual(expected);
  });

  it('takes the typed name exactly: case-sensitive, nothing trimmed', () => {
    expect(confirmMatches('forgejo_data', 'forgejo_data')).toBe(true);
    expect(confirmMatches('Forgejo_data', 'forgejo_data')).toBe(false);
    expect(confirmMatches('forgejo_data ', 'forgejo_data')).toBe(false);
    expect(confirmMatches('', 'forgejo_data')).toBe(false);
  });

  it('has words for every state and step, never "Ship"', () => {
    for (const s of MaintenanceState.options) expect(MAINTENANCE_STATE_WORDS[s], s).toBeTruthy();
    for (const s of MaintenanceStep.options) expect(MAINTENANCE_STEP_WORDS[s], s).toBeTruthy();
    expect(progressHeadline({ state: 'running', step: 'archiving', volume: 'forgejo_data' })).toBe('Archiving · forgejo_data');
    expect(progressHeadline({ state: 'dispatched', step: null, volume: null })).toBe('Sent to the agent');
  });

  it('reads an archive’s time on the 24-hour clock, and the safety archive from a restore’s account', () => {
    const now = new Date(2026, 9, 22, 15, 0);
    expect(archiveTime(new Date(2026, 9, 22, 14, 20).toISOString(), now)).toBe('Today 14:20');
    expect(archiveTime(new Date(2026, 9, 21, 9, 5).toISOString(), now)).toBe('Yesterday 09:05');
    expect(archiveTime(new Date(2026, 9, 18, 11, 12).toISOString(), now)).toBe('Oct 18 11:12');
    expect(safetyArchiveLine(`Stopping forgejo.\nSafety archive of what forgejo_data held before the restore: ${OLDER}.\nStarted.`)).toBe(
      `Safety archive of what forgejo_data held before the restore: ${OLDER}.`,
    );
    expect(safetyArchiveLine(null)).toBeNull();
  });

  it('groups a dry run as dangling, unused and build cache, the largest first', () => {
    const items: PruneItem[] = [
      { kind: 'build-cache', id: 'k3v9x2q81mtd', ref: null, sizeBytes: 310 * MB, createdAt: null, reason: 'old-cache' },
      { kind: 'image', id: `sha256:1c9e4f${'0'.repeat(54)}07ab`, ref: null, sizeBytes: 612 * MB, createdAt: null, reason: 'dangling' },
      { kind: 'image', id: `sha256:${'2'.repeat(64)}`, ref: 'postgres:15', sizeBytes: 268 * MB, createdAt: null, reason: 'unused' },
      { kind: 'image', id: `sha256:7a20bd${'0'.repeat(54)}c311`, ref: null, sizeBytes: 900 * MB, createdAt: null, reason: 'dangling' },
    ];
    const groups = pruneGroups(items);
    expect(groups.map((g) => [g.id, g.items.length, g.bytes])).toEqual([
      ['dangling', 2, 1512 * MB],
      ['unused', 1, 268 * MB],
      ['cache', 1, 310 * MB],
    ]);
    expect(groups[0]?.items.map(pruneItemName)).toEqual(['sha256:7a20bd…c311', 'sha256:1c9e4f…07ab']);
    expect(pruneItemName({ id: `sha256:${'2'.repeat(64)}`, ref: 'postgres:15' })).toBe('postgres:15');
  });
});

// ── The list on Host ─────────────────────────────────────────────────────

describe('the volumes on Host, gated by role and tier (SHP-REQ-201..203)', () => {
  it('shows a viewer every volume and no action, and Observed says so', async () => {
    const calls = hostRoutes('viewer');
    renderAt('/host');
    const list = await screen.findByRole('list', { name: 'Volumes' });
    expect(within(list).getAllByText(/./, { selector: '.shp-hv__name' }).map((n) => n.textContent)).toEqual([
      'kardashev_pgdata',
      'bindery_pgdata',
      'forgejo_data',
      'bindery_cache',
      'portainer_data',
    ]);
    const forgejo = await volumeRow('forgejo_data');
    expect(await within(forgejo).findByRole('button', { name: 'Archives · 2 of forgejo_data' })).toBeInTheDocument();
    expect(buttonsOf(forgejo)).toEqual(['Archives · 2 of forgejo_data']);
    expect(buttonsOf(await volumeRow('kardashev_pgdata'))).toEqual([]);
    expect(within(await volumeRow('portainer_data')).getByText('Observed — no actions')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prune…' })).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('offers a deployer Back up on owned volumes and Prune…, never Restore… or Delete…', async () => {
    hostRoutes('deployer');
    renderAt('/host');
    const forgejo = await volumeRow('forgejo_data');
    await within(forgejo).findByRole('button', { name: 'Archives · 2 of forgejo_data' });
    expect(buttonsOf(forgejo)).toEqual(['Back up forgejo_data', 'Archives · 2 of forgejo_data']);
    expect(buttonsOf(await volumeRow('bindery_pgdata'))).toContain('Back up bindery_pgdata');
    expect(buttonsOf(await volumeRow('kardashev_pgdata'))).toEqual([]);
    expect(screen.getByRole('button', { name: 'Prune…' })).toBeInTheDocument();
  });

  it('offers an admin Restore… where there is an archive and Delete… only on a true orphan', async () => {
    hostRoutes('admin');
    renderAt('/host');
    const forgejo = await volumeRow('forgejo_data');
    expect(await within(forgejo).findByRole('button', { name: 'Restore… forgejo_data' })).toBeInTheDocument();
    expect(buttonsOf(forgejo)).toEqual(['Back up forgejo_data', 'Archives · 2 of forgejo_data', 'Restore… forgejo_data']);
    // No archive yet: no Restore….
    const bindery = await volumeRow('bindery_pgdata');
    await within(bindery).findByRole('button', { name: 'Archives · 0 of bindery_pgdata' });
    expect(buttonsOf(bindery)).toEqual(['Back up bindery_pgdata', 'Archives · 0 of bindery_pgdata']);
    expect(buttonsOf(await volumeRow('kardashev_pgdata'))).toEqual(['Delete… kardashev_pgdata']);
    // Claimed by bindery's compose project: the server would refuse volume_not_owned, so no Delete….
    const claimed = await volumeRow('bindery_cache');
    expect(buttonsOf(claimed)).toEqual([]);
    expect(within(claimed).getByText(/bindery claims it/)).toBeInTheDocument();
    expect(buttonsOf(await volumeRow('portainer_data'))).toEqual([]);
  });

  it('offers no action on any volume while the stack list has never answered', async () => {
    hostRoutes('admin', { 'GET /api/stacks': { status: 500, body: { error: { code: 'internal', gate: 'none', message: 'down', fix: 'retry' } } } });
    renderAt('/host');
    // Without the stacks, an adopted stack's unmounted volume would pass for an orphan.
    expect(buttonsOf(await volumeRow('kardashev_pgdata'))).toEqual([]);
    expect(buttonsOf(await volumeRow('forgejo_data'))).toEqual([]);
  });

  it('opens a volume’s archives newest first, linked by ?volume=', async () => {
    const user = userEvent.setup();
    hostRoutes('admin');
    renderAt('/host');
    const forgejo = await volumeRow('forgejo_data');
    await user.click(await within(forgejo).findByRole('button', { name: 'Archives · 2 of forgejo_data' }));
    expect(new URLSearchParams(window.location.search).get('volume')).toBe('forgejo_data');
    const list = await within(forgejo).findByRole('list', { name: 'Archives · 2 of forgejo_data' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0] as HTMLElement).getByText('Quiesced')).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText('Live copy')).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText('998.0 MB')).toBeInTheDocument();
    // The archive's Restore… opens the sheet on it.
    await user.click(within(items[1] as HTMLElement).getByRole('button', { name: /^Restore… the .* archive of forgejo_data$/ }));
    expect(new URLSearchParams(window.location.search).get('restore')).toBe(OLDER);
    const sheet = await screen.findByRole('dialog', { name: 'Restore forgejo_data' });
    const radios = within(sheet).getAllByRole('radio');
    expect(radios[1]).toBeChecked();
  });

  it('backs up from the row: asks once, then follows the job every second to its result, and stops', async () => {
    const user = userEvent.setup();
    let reads = 0;
    const calls = hostRoutes('deployer', {
      'POST /api/volumes/forgejo_data/backup': { status: 202, body: job() },
      [`GET /api/maintenance/${JOB}`]: () => {
        reads += 1;
        if (reads === 1) return { status: 200, body: job({ state: 'running', step: 'archiving' }) };
        return {
          status: 200,
          body: job({ state: 'succeeded', step: 'retaining', finishedAt: new Date().toISOString(), archive: archive(NEWER, new Date().toISOString(), true), removedArchives: [OLDER] }),
        };
      },
    });
    renderAt('/host');
    const forgejo = await volumeRow('forgejo_data');
    await user.click(await within(forgejo).findByRole('button', { name: 'Back up forgejo_data' }));
    const confirm = await screen.findByRole('dialog', { name: 'Back up forgejo_data?' });
    await user.click(within(confirm).getByRole('button', { name: 'Back up' }));
    expect(await within(forgejo).findByText('Archiving · forgejo_data')).toBeInTheDocument();
    expect(await within(forgejo).findByText('Backed up forgejo_data · 1.1 GB')).toBeInTheDocument();
    expect(within(forgejo).getByText('quiesced · 1 older archive removed')).toBeInTheDocument();
    expect(posts(calls, '/api/volumes/forgejo_data/backup')).toEqual([{ method: 'POST', path: '/api/volumes/forgejo_data/backup', body: {} }]);
    const after = reads;
    await new Promise((r) => setTimeout(r, 1_300));
    expect(reads).toBe(after);
  });

  it('shows a backup refused at once, verbatim', async () => {
    const user = userEvent.setup();
    hostRoutes('deployer', {
      'POST /api/volumes/forgejo_data/backup': refusal('agent_offline', 'The agent that runs this has not polled the server recently.', 'Check the agent is running and can reach the server, then retry.', 409),
    });
    renderAt('/host');
    const forgejo = await volumeRow('forgejo_data');
    await user.click(await within(forgejo).findByRole('button', { name: 'Back up forgejo_data' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Back up forgejo_data?' })).getByRole('button', { name: 'Back up' }));
    expect(await within(forgejo).findByText('The agent that runs this has not polled the server recently.')).toBeInTheDocument();
    expect(within(forgejo).getByText('Check the agent is running and can reach the server, then retry.')).toBeInTheDocument();
  });
});

// ── Restore ──────────────────────────────────────────────────────────────

describe('the restore sheet (SHP-REQ-202)', () => {
  it('says what is replaced and the chain, and enables only on the exact name', async () => {
    const user = userEvent.setup();
    hostRoutes('admin');
    renderAt(`/host?volume=forgejo_data&restore=${NEWER}`);
    const sheet = await screen.findByRole('dialog', { name: 'Restore forgejo_data' });
    expect(within(sheet).getByText('Operated')).toBeInTheDocument();
    expect(within(sheet).getByText(/Shipyard stops forgejo \(2 containers\) for the restore/)).toBeInTheDocument();
    expect(within(sheet).getByText('The volume’s current contents are replaced')).toBeInTheDocument();
    await within(sheet).findAllByRole('radio');
    const chips = [...sheet.querySelectorAll('.shp-stack-chain__chip')].map((c) => c.textContent);
    expect(chips[0]).toBe('Stop forgejo (2 containers)');
    expect(chips[1]).toBe('Empty forgejo_data');
    expect(chips[2]).toMatch(/^Unpack the (Today|Yesterday) \d\d:\d\d archive$/);
    expect(chips.slice(3)).toEqual(['Start forgejo', 'Health']);
    expect(within(sheet).getByText('Admin · console only. Restore is never offered over MCP.')).toBeInTheDocument();

    const go = within(sheet).getByRole('button', { name: 'Restore forgejo_data' });
    expect(go).toBeDisabled();
    const name = within(sheet).getByLabelText('Type forgejo_data to confirm');
    await user.type(name, 'Forgejo_data');
    expect(go).toBeDisabled();
    expect(within(sheet).getByText(/Not a match yet/)).toBeInTheDocument();
    await user.clear(name);
    await user.type(name, 'forgejo_data ');
    expect(go).toBeDisabled();
    await user.type(name, '{Backspace}');
    expect(within(sheet).getByText('Matches the volume name')).toBeInTheDocument();
    // The name alone is not enough: the step-up code comes first (SHP-ADR-012 amendment).
    expect(go).toBeDisabled();
    const code = within(sheet).getByLabelText('Authenticator code');
    await user.type(code, '48291');
    expect(go).toBeDisabled();
    await user.type(code, '3');
    expect(go).toBeEnabled();
  });

  it('steps up before it asks; when the server still wants one, the code field says so and the next code goes first again', async () => {
    const user = userEvent.setup();
    const calls = hostRoutes('admin', {
      'POST /api/volumes/forgejo_data/restore': [
        STEP_UP_REQUIRED,
        { status: 202, body: job({ kind: 'volume-restore', state: 'queued' }) },
      ],
      'POST /api/auth/step-up': { status: 200, body: { ok: true, until: new Date().toISOString() } },
      [`GET /api/maintenance/${JOB}`]: {
        status: 200,
        body: job({ kind: 'volume-restore', state: 'succeeded', step: 'checking', output: `Safety archive of what forgejo_data held before the restore: ${OLDER}.` }),
      },
    });
    renderAt(`/host?volume=forgejo_data&restore=${OLDER}`);
    const sheet = await screen.findByRole('dialog', { name: 'Restore forgejo_data' });
    await within(sheet).findAllByRole('radio');
    await user.type(within(sheet).getByLabelText('Type forgejo_data to confirm'), 'forgejo_data');
    const go = within(sheet).getByRole('button', { name: 'Restore forgejo_data' });
    expect(go).toBeDisabled();
    await user.type(within(sheet).getByLabelText('Authenticator code'), '482 913');
    expect(go).toBeEnabled();
    await user.click(go);

    // The server still wants a fresh step-up: the code field says so, verbatim, and asks for a new code.
    expect(await within(sheet).findByText(/Confirm it’s you before restoring or deleting a volume\./)).toBeInTheDocument();
    expect(within(sheet).getByLabelText('Authenticator code')).toHaveValue('');
    expect(go).toBeDisabled();
    await user.type(within(sheet).getByLabelText('Authenticator code'), '105 228');
    await user.click(go);

    expect(await within(sheet).findByText('Restored forgejo_data')).toBeInTheDocument();
    expect(within(sheet).getByText(`Safety archive of what forgejo_data held before the restore: ${OLDER}.`)).toBeInTheDocument();
    expect(posts(calls, '/api/auth/step-up').map((c) => c.body)).toEqual([{ code: '482913' }, { code: '105228' }]);
    expect(posts(calls, '/api/volumes/forgejo_data/restore').map((c) => c.body)).toEqual([
      { archiveId: OLDER, confirmVolume: 'forgejo_data' },
      { archiveId: OLDER, confirmVolume: 'forgejo_data' },
    ]);
    // Each ask follows its own step-up.
    const order = calls.filter((c) => c.method === 'POST').map((c) => c.path);
    expect(order).toEqual(['/api/auth/step-up', '/api/volumes/forgejo_data/restore', '/api/auth/step-up', '/api/volumes/forgejo_data/restore']);
    expect(within(sheet).getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('says so when a link names an archive that is not in the ledger, and picks nothing', async () => {
    const user = userEvent.setup();
    hostRoutes('admin');
    renderAt('/host?volume=forgejo_data&restore=00000000-0000-4000-8000-000000000000');
    const sheet = await screen.findByRole('dialog', { name: 'Restore forgejo_data' });
    expect(await within(sheet).findByText('That archive is not in the ledger')).toBeInTheDocument();
    const radios = within(sheet).getAllByRole('radio');
    for (const r of radios) expect(r).not.toBeChecked();
    await user.type(within(sheet).getByLabelText('Type forgejo_data to confirm'), 'forgejo_data');
    await user.type(within(sheet).getByLabelText('Authenticator code'), '123456');
    const go = within(sheet).getByRole('button', { name: 'Restore forgejo_data' });
    expect(go).toBeDisabled();
    await user.click(radios[0] as HTMLElement);
    expect(go).toBeEnabled();
    expect(within(sheet).queryByText('That archive is not in the ledger')).not.toBeInTheDocument();
  });

  it.each([
    ['restore', 'portainer_data', 'Restore portainer_data', 'Only Observed containers mount portainer_data. Shipyard shows it and never touches it.'],
    ['restore', 'kardashev_pgdata', 'Restore kardashev_pgdata', 'No app or stack owns kardashev_pgdata, so there is nothing to restore it for. An admin can delete it from its row.'],
    ['delete', 'bindery_pgdata', 'Delete bindery_pgdata', 'bindery_pgdata belongs to bindery. Shipyard deletes only orphans no app or stack claims.'],
    ['delete', 'bindery_cache', 'Delete bindery_cache', 'Nothing mounts bindery_cache, but its compose label names bindery, so Shipyard never deletes it.'],
  ] as const)('a %s link on %s explains itself instead of a dead sheet', async (what, volumeName, title, words) => {
    const calls = hostRoutes('admin');
    renderAt(what === 'restore' ? `/host?volume=${volumeName}&restore=${NEWER}` : `/host?volume=${volumeName}&delete=1`);
    const sheet = await screen.findByRole('dialog', { name: title });
    expect(within(sheet).getByText(words)).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: title })).not.toBeInTheDocument();
    expect(within(sheet).queryByLabelText('Authenticator code')).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('shows a wrong code by its field, and does not sign the person out', async () => {
    const user = userEvent.setup();
    const calls = hostRoutes('admin', {
      'POST /api/auth/step-up': refusal('unauthenticated', 'The authenticator code is wrong or has already been used.', 'Enter the current code from your authenticator app.', 401),
    });
    renderAt(`/host?volume=forgejo_data&restore=${NEWER}`);
    const sheet = await screen.findByRole('dialog', { name: 'Restore forgejo_data' });
    await within(sheet).findAllByRole('radio');
    await user.type(within(sheet).getByLabelText('Type forgejo_data to confirm'), 'forgejo_data');
    await user.type(within(sheet).getByLabelText('Authenticator code'), '000000');
    await user.click(within(sheet).getByRole('button', { name: 'Restore forgejo_data' }));
    expect(await within(sheet).findByText(/The authenticator code is wrong or has already been used\./)).toBeInTheDocument();
    expect(posts(calls, '/api/volumes/forgejo_data/restore')).toHaveLength(0);
    expect(screen.getByRole('dialog', { name: 'Restore forgejo_data' })).toBeInTheDocument();
  });

  it.each([
    ['volume_in_use', 'forgejo has a restart by Matt in progress.', 'Wait for action 1 to finish, then request again.', 409],
    ['archive_not_found', 'Archive x is not a current archive of forgejo_data in the agent’s ledger.', 'Choose one from GET /api/volumes/forgejo_data/archives.', 404],
  ] as const)('shows a %s refusal verbatim', async (code, message, fix, status) => {
    const user = userEvent.setup();
    hostRoutes('admin', {
      'POST /api/auth/step-up': { status: 200, body: { ok: true, until: new Date().toISOString() } },
      'POST /api/volumes/forgejo_data/restore': refusal(code, message, fix, status),
    });
    renderAt(`/host?volume=forgejo_data&restore=${NEWER}`);
    const sheet = await screen.findByRole('dialog', { name: 'Restore forgejo_data' });
    await within(sheet).findAllByRole('radio');
    await user.type(within(sheet).getByLabelText('Type forgejo_data to confirm'), 'forgejo_data');
    await user.type(within(sheet).getByLabelText('Authenticator code'), '123456');
    await user.click(within(sheet).getByRole('button', { name: 'Restore forgejo_data' }));
    expect(await within(sheet).findByText(message)).toBeInTheDocument();
    expect(within(sheet).getByText(fix)).toBeInTheDocument();
  });

  it('offers a deployer no restore button', async () => {
    hostRoutes('deployer');
    renderAt(`/host?volume=forgejo_data&restore=${NEWER}`);
    const sheet = await screen.findByRole('dialog', { name: 'Restore forgejo_data' });
    expect(within(sheet).queryByRole('button', { name: 'Restore forgejo_data' })).not.toBeInTheDocument();
    expect(within(sheet).queryByLabelText('Authenticator code')).not.toBeInTheDocument();
  });

  it('Back closes the sheet and leaves the archives open', async () => {
    const user = userEvent.setup();
    hostRoutes('admin');
    renderAt('/host?volume=forgejo_data');
    const forgejo = await volumeRow('forgejo_data');
    await user.click(await within(forgejo).findByRole('button', { name: 'Restore… forgejo_data' }));
    const sheet = await screen.findByRole('dialog', { name: 'Restore forgejo_data' });
    await user.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Restore forgejo_data' })).not.toBeInTheDocument();
    });
    expect(window.location.search).toBe('?volume=forgejo_data');
  });
});

// ── Delete ───────────────────────────────────────────────────────────────

describe('the delete sheet (SHP-REQ-203)', () => {
  it('says what goes, steps up first when the code is typed, and deletes', async () => {
    const user = userEvent.setup();
    const calls = hostRoutes('admin', {
      'POST /api/auth/step-up': { status: 200, body: { ok: true, until: new Date().toISOString() } },
      'POST /api/volumes/kardashev_pgdata/delete': { status: 202, body: job({ kind: 'volume-delete', volume: 'kardashev_pgdata', owner: null }) },
      [`GET /api/maintenance/${JOB}`]: [
        { status: 200, body: job({ kind: 'volume-delete', volume: 'kardashev_pgdata', owner: null, state: 'running', step: 'deleting' }) },
        { status: 200, body: job({ kind: 'volume-delete', volume: 'kardashev_pgdata', owner: null, state: 'succeeded', finishedAt: new Date().toISOString() }) },
      ],
    });
    renderAt('/host');
    await user.click(await within(await volumeRow('kardashev_pgdata')).findByRole('button', { name: 'Delete… kardashev_pgdata' }));
    expect(new URLSearchParams(window.location.search).get('delete')).toBe('1');
    const sheet = await screen.findByRole('dialog', { name: 'Delete kardashev_pgdata' });
    expect(within(sheet).getByText('Orphaned')).toBeInTheDocument();
    expect(within(sheet).getByText(/Its compose label says it last belonged to kardashev\./)).toBeInTheDocument();
    expect(within(sheet).getByText('This cannot be undone')).toBeInTheDocument();
    expect(within(sheet).getByText('No container, running or stopped')).toBeInTheDocument();
    expect(within(sheet).getByText(/refuses with volume_in_use and deletes nothing/)).toBeInTheDocument();
    const go = within(sheet).getByRole('button', { name: 'Delete kardashev_pgdata' });
    expect(go).toBeDisabled();
    await user.type(within(sheet).getByLabelText('Type kardashev_pgdata to confirm'), 'kardashev_pgdata');
    await user.type(within(sheet).getByLabelText('Authenticator code'), '731058');
    await user.click(go);
    expect(await within(sheet).findByText('Deleting · kardashev_pgdata')).toBeInTheDocument();
    expect(await within(sheet).findByText('Deleted kardashev_pgdata')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST').map((c) => [c.path, c.body])).toEqual([
      ['/api/auth/step-up', { code: '731058' }],
      ['/api/volumes/kardashev_pgdata/delete', { confirmVolume: 'kardashev_pgdata' }],
    ]);
  });

  it('shows the agent’s volume_in_use refusal: what did not happen, why and the fix', async () => {
    const user = userEvent.setup();
    const message = 'A container mounts it now: kardashev-db-1 (stopped).';
    const fix = 'Remove kardashev-db-1 first, then delete again, or keep the volume. Nothing was deleted.';
    hostRoutes('admin', {
      'POST /api/auth/step-up': { status: 200, body: { ok: true, until: new Date().toISOString() } },
      'POST /api/volumes/kardashev_pgdata/delete': {
        status: 202,
        body: job({ kind: 'volume-delete', volume: 'kardashev_pgdata', owner: null, state: 'refused', refusal: { code: 'volume_in_use', gate: 'none', message, fix } }),
      },
    });
    renderAt('/host?volume=kardashev_pgdata&delete=1');
    const sheet = await screen.findByRole('dialog', { name: 'Delete kardashev_pgdata' });
    await user.type(within(sheet).getByLabelText('Type kardashev_pgdata to confirm'), 'kardashev_pgdata');
    await user.type(within(sheet).getByLabelText('Authenticator code'), '731058');
    await user.click(within(sheet).getByRole('button', { name: 'Delete kardashev_pgdata' }));
    expect(await within(sheet).findByText('Didn’t delete kardashev_pgdata · volume_in_use')).toBeInTheDocument();
    expect(within(sheet).getByText(message)).toBeInTheDocument();
    expect(within(sheet).getByText(fix)).toBeInTheDocument();
  });
});

// ── Prune ────────────────────────────────────────────────────────────────

describe('prune from a dry run (SHP-REQ-205)', () => {
  const items: PruneItem[] = [
    { kind: 'image', id: `sha256:1c9e4f${'0'.repeat(54)}07ab`, ref: null, sizeBytes: 612 * MB, createdAt: new Date(Date.now() - 12 * 86_400_000).toISOString(), reason: 'dangling' },
    { kind: 'image', id: `sha256:${'2'.repeat(64)}`, ref: 'postgres:15', sizeBytes: 268 * MB, createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString(), reason: 'unused' },
    { kind: 'build-cache', id: 'k3v9x2q81mtd', ref: null, sizeBytes: 310 * MB, createdAt: new Date(Date.now() - 9 * 86_400_000).toISOString(), reason: 'old-cache' },
  ];
  const total = 612 * MB + 268 * MB + 310 * MB;
  const prune = (id: string, overrides: Partial<MaintenanceStatus>) => job({ id, kind: 'prune', volume: null, owner: null, ...overrides });

  it('lists the dry run on open, prunes these by its ID, and shows what was freed', async () => {
    const user = userEvent.setup();
    let realReads = 0;
    const calls = hostRoutes('deployer', {
      'POST /api/prune': (init) => {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { dryRun: boolean };
        return { status: 202, body: body.dryRun ? prune(DRY, {}) : prune(REAL, {}) };
      },
      [`GET /api/maintenance/${DRY}`]: [
        { status: 200, body: prune(DRY, { state: 'running', step: 'listing' }) },
        { status: 200, body: prune(DRY, { state: 'succeeded', finishedAt: new Date().toISOString(), prune: { items, reclaimableBytes: total, reclaimedBytes: null } }) },
      ],
      [`GET /api/maintenance/${REAL}`]: () => {
        realReads += 1;
        return { status: 200, body: prune(REAL, { state: 'succeeded', finishedAt: new Date().toISOString(), prune: { items, reclaimableBytes: total, reclaimedBytes: total } }) };
      },
    });
    renderAt('/host');
    await user.click(await screen.findByRole('button', { name: 'Prune…' }));
    expect(new URLSearchParams(window.location.search).get('prune')).toBe('1');
    const sheet = await screen.findByRole('dialog', { name: 'Prune images and build cache' });
    expect(within(sheet).getByText('Dry run')).toBeInTheDocument();
    expect(within(sheet).getByText('Volumes are never pruned. Delete orphaned volumes one at a time from their row.')).toBeInTheDocument();
    expect(await within(sheet).findByText('1.2 GB back')).toBeInTheDocument();
    expect(within(sheet).getByText(/^3 items · dry run at \d\d:\d\d$/)).toBeInTheDocument();
    expect(within(sheet).getByRole('heading', { name: 'Dangling images' })).toBeInTheDocument();
    expect(within(sheet).getByRole('heading', { name: 'Unused images, older than 7 days' })).toBeInTheDocument();
    expect(within(sheet).getByRole('heading', { name: 'Build cache, older than 7 days' })).toBeInTheDocument();
    expect(within(sheet).getByText('sha256:1c9e4f…07ab')).toBeInTheDocument();
    expect(within(sheet).getByText('untagged · 12 days')).toBeInTheDocument();
    expect(within(sheet).getByText('postgres:15')).toBeInTheDocument();
    expect(within(sheet).getByText('Deployer, operator or admin. Removes only the 3 items above; recorded in Activity.')).toBeInTheDocument();

    await user.click(within(sheet).getByRole('button', { name: 'Prune these' }));
    expect(await within(sheet).findByText('Freed 1.2 GB')).toBeInTheDocument();
    expect(within(sheet).getByText(/Removed 1 dangling image, 1 unused image and 1 build-cache entry · no volumes touched/)).toBeInTheDocument();
    expect(posts(calls, '/api/prune').map((c) => c.body)).toEqual([{ dryRun: true }, { dryRun: false, fromDryRunId: DRY }]);
    // The real prune ended: no more reads.
    const after = realReads;
    await new Promise((r) => setTimeout(r, 1_300));
    expect(realReads).toBe(after);

    // On the Disk card too, once the sheet is closed.
    await user.click(within(sheet).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Prune images and build cache' })).not.toBeInTheDocument();
    });
    expect(screen.getByText('Freed 1.2 GB')).toBeInTheDocument();
  });

  it('completes the dry run under StrictMode: one request, followed to its list', async () => {
    let reads = 0;
    const calls = mockFetch({
      'POST /api/prune': { status: 202, body: prune(DRY, {}) },
      [`GET /api/maintenance/${DRY}`]: () => {
        reads += 1;
        return reads === 1
          ? { status: 200, body: prune(DRY, { state: 'running', step: 'listing' }) }
          : { status: 200, body: prune(DRY, { state: 'succeeded', finishedAt: new Date().toISOString(), prune: { items, reclaimableBytes: total, reclaimedBytes: null } }) };
      },
    });
    render(
      <StrictMode>
        <PruneSheet role="deployer" onClose={() => undefined} onPruned={() => undefined} />
      </StrictMode>,
    );
    const sheet = await screen.findByRole('dialog', { name: 'Prune images and build cache' });
    expect(await within(sheet).findByText('1.2 GB back')).toBeInTheDocument();
    expect(reads).toBe(2);
    expect(posts(calls, '/api/prune')).toHaveLength(1);
    expect(within(sheet).getByRole('button', { name: 'Prune these' })).toBeEnabled();
  });

  it('shows a refused dry run verbatim and offers nothing to prune', async () => {
    hostRoutes('deployer', {
      'POST /api/prune': refusal('agent_offline', 'The agent that runs this has not polled the server recently.', 'Check the agent is running and can reach the server, then retry.', 409),
    });
    renderAt('/host?prune=1');
    const sheet = await screen.findByRole('dialog', { name: 'Prune images and build cache' });
    expect(await within(sheet).findByText('The agent that runs this has not polled the server recently.')).toBeInTheDocument();
    expect(within(sheet).getByText('Check the agent is running and can reach the server, then retry.')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Prune these' })).toBeDisabled();
  });

  it('runs nothing for a viewer', async () => {
    const calls = hostRoutes('viewer');
    renderAt('/host?prune=1');
    const sheet = await screen.findByRole('dialog', { name: 'Prune images and build cache' });
    expect(within(sheet).queryByRole('button', { name: 'Prune these' })).not.toBeInTheDocument();
    expect(posts(calls, '/api/prune')).toHaveLength(0);
  });
});

// ── Needs you and Activity ───────────────────────────────────────────────

describe('failed backups and low disk in Needs you', () => {
  const failed = job({
    state: 'refused',
    finishedAt: new Date().toISOString(),
    requester: { kind: 'system', label: 'shipyard: nightly backup' },
    refusal: { code: 'agent_offline', gate: 'none', message: 'The agent that runs this has not polled the server recently.', fix: 'Check the agent is running and can reach the server, then retry.' },
  });

  it('lists them after the stack rows, before the host', () => {
    const items = needsYouItems({
      apps: [],
      approvals: [],
      system: null,
      maintenanceNeeds: { failedBackups: [failed], lowDisk: [{ mount: '/DATA', usedPercent: 93.4, freeBytes: 60 * GB }] },
    });
    expect(items).toEqual([
      { kind: 'backup-failed', volume: 'forgejo_data', jobId: JOB },
      { kind: 'low-disk', mount: '/DATA' },
    ]);
  });

  it('shows the refusal verbatim and links to the volume and the Disk card', async () => {
    mockFetch({
      'GET /api/auth/me': meReply('viewer'),
      'GET /api/apps': { status: 200, body: { apps: [] } },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/agent': { status: 200, body: [{ id: 'a1', confirmed: true, lastHeartbeatAt: new Date().toISOString(), stale: false }] },
      'GET /api/groups': { status: 200, body: [] },
      'GET /api/stack-updates/needs-you': { status: 200, body: { approvals: [], failed: [] } },
      'GET /api/maintenance/needs-you': { status: 200, body: { failedBackups: [failed], lowDisk: [{ mount: '/DATA', usedPercent: 93.4, freeBytes: 60 * GB }] } },
    });
    renderAt('/');
    const list = await screen.findByRole('list', { name: 'Needs you' });
    const backup = within(list).getByText('forgejo_data').closest('li') as HTMLElement;
    expect(within(backup).getByText(/backup refused — The agent that runs this has not polled the server recently\./)).toBeInTheDocument();
    expect(within(backup).getByText('Check the agent is running and can reach the server, then retry.')).toBeInTheDocument();
    expect(within(backup).getByRole('link', { name: 'Open forgejo_data on Host' })).toHaveAttribute('href', '/host?volume=forgejo_data');
    const disk = within(list).getByText(/\/DATA is 93\.4% full · 60\.0 GB free/).closest('li') as HTMLElement;
    expect(within(disk).getByRole('link', { name: 'Open /DATA on Host' })).toHaveAttribute('href', '/host#disk');
  });
});

describe('Activity lists maintenance (SHP-ADR-012)', () => {
  const backup = job({ state: 'succeeded', finishedAt: new Date().toISOString(), archive: archive(NEWER, new Date().toISOString(), true), createdAt: new Date(Date.now() - 5 * 60_000).toISOString() });
  const pruned = job({
    id: REAL,
    kind: 'prune',
    volume: null,
    owner: null,
    state: 'succeeded',
    prune: { items: [], reclaimableBytes: 3 * GB, reclaimedBytes: 3 * GB },
    requester: { kind: 'token', label: 'claude: homelab upkeep' },
    createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  });
  const deleteRefused = job({
    id: DRY,
    kind: 'volume-delete',
    volume: 'kardashev_pgdata',
    owner: null,
    state: 'refused',
    refusal: { code: 'volume_in_use', gate: 'none', message: 'A container mounts it now.', fix: 'Remove it first.' },
    createdAt: new Date(Date.now() - 15 * 60_000).toISOString(),
  });

  function activityRoutes(items: MaintenanceStatus[]): Call[] {
    return mockFetch({
      'GET /api/auth/me': meReply('viewer'),
      'GET /api/apps': { status: 200, body: { apps: [] } },
      'GET /api/approvals': { status: 200, body: [] },
      'GET /api/agent': { status: 200, body: [] },
      'GET /api/deploys/timeline': { status: 200, body: { items: [], nextCursor: null } },
      'GET /api/builds': { status: 200, body: { items: [], nextCursor: null } },
      'GET /api/schedules': { status: 200, body: { upcoming: [], past: [] } },
      'GET /api/actions': { status: 200, body: { items: [], nextCursor: null } },
      'GET /api/stack-updates': { status: 200, body: { items: [], nextCursor: null } },
      'GET /api/stack-updates/needs-you': { status: 200, body: { approvals: [], failed: [] } },
      'GET /api/maintenance/needs-you': { status: 200, body: { failedBackups: [], lowDisk: [] } },
      'GET /api/maintenance': { status: 200, body: { items, nextCursor: null } },
    });
  }

  it('has its own source and chip, and matches by owner, requester and outcome', () => {
    expect(sourcesFor(filtersFromParams(new URLSearchParams('kind=maintenance')))).toEqual({
      deploys: false,
      builds: false,
      scheduleRows: false,
      showUpcoming: false,
      actions: false,
      stackUpdates: false,
      maintenance: true,
    });
    expect(sourcesFor(filtersFromParams(new URLSearchParams('kind=refusal'))).maintenance).toBe(true);
    expect(maintenanceMatches(backup, filtersFromParams(new URLSearchParams('app=forgejo')))).toBe(true);
    expect(maintenanceMatches(backup, filtersFromParams(new URLSearchParams('app=bindery')))).toBe(false);
    expect(maintenanceMatches(pruned, filtersFromParams(new URLSearchParams('requester=homelab')))).toBe(true);
    expect(maintenanceMatches(deleteRefused, filtersFromParams(new URLSearchParams('kind=refusal')))).toBe(true);
    expect(maintenanceMatches(backup, filtersFromParams(new URLSearchParams('kind=refusal')))).toBe(false);
  });

  it('shows each job with what it did, who asked, and a link to the volume', async () => {
    const user = userEvent.setup();
    activityRoutes([backup, pruned, deleteRefused]);
    renderAt('/activity');
    const backedUp = (await screen.findByText('Backed up')).closest('li') as HTMLElement;
    expect(within(backedUp).getByText('forgejo_data')).toBeInTheDocument();
    expect(within(backedUp).getByText(/1\.1 GB · quiesced/)).toBeInTheDocument();
    expect(within(backedUp).getAllByText(/console · Matt/).length).toBeGreaterThan(0);
    expect(within(backedUp).getByRole('link')).toHaveAttribute('href', '/host?volume=forgejo_data');
    const prunedRow = screen.getByText('Pruned').closest('li') as HTMLElement;
    expect(within(prunedRow).getByText('Images and build cache')).toBeInTheDocument();
    expect(within(prunedRow).getByText(/Freed 3\.0 GB/)).toBeInTheDocument();
    expect(within(prunedRow).getByRole('link')).toHaveAttribute('href', '/host');
    const refused = screen.getByText('Delete · Refused').closest('li') as HTMLElement;
    expect(within(refused).getByText(/A container mounts it now\. · Remove it first\./)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Maintenance' }));
    expect(new URLSearchParams(window.location.search).get('kind')).toBe('maintenance');
    expect(screen.getByRole('button', { name: 'Maintenance' })).toHaveAttribute('aria-pressed', 'true');
  });
});
