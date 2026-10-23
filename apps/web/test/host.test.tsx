import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HostResponse, type HostContainer, type HostImage, type HostSnapshot, type HostVolume } from '@shipyard/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import {
  HOST_POLL_MS,
  ageWords,
  chipCounts,
  chipFromParams,
  containerStatus,
  defaultOpen,
  groupContainers,
  hostTotals,
  imageSummary,
  isStale,
  matchesChip,
  memoryWords,
  paramsForChip,
  phoneLine,
  repositoryOf,
  restartWords,
  sortVolumes,
  sparkPoints,
} from '../src/lib/host';
import { TIER_WORDS } from '../src/lib/words';
import { meReply, mockFetch, type Call, type Reply } from './fetch';
import { viewport } from './setup';

/**
 * Host (SHP-T-14.7, SHP-REQ-178, SHP-REQ-181): the fourth destination — containers grouped by compose
 * project and tier, volumes, images and disk from the latest snapshot, its age always shown and
 * marked stale after two report intervals, the filter in the address, and nothing that changes
 * anything.
 */

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const MB = 1024 * 1024;
const GB = 1024 * MB;

function hex(seed: string, length = 64): string {
  let out = '';
  for (let i = 0; out.length < length; i += 1) out += ((seed.charCodeAt(i % seed.length) + i) % 16).toString(16);
  return out.slice(0, length);
}

function container(name: string, overrides: Partial<HostContainer> = {}): HostContainer {
  return {
    id: hex(name),
    name,
    image: `ghcr.io/matdemers1/${name}:sha-${'a'.repeat(40)}`,
    imageId: `sha256:${hex(`img-${name}`)}`,
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
    stats: { cpuPercent: 2.4, memoryBytes: 312 * MB, memoryLimitBytes: null },
    ...overrides,
  };
}

function inProject(project: string, service: string, overrides: Partial<HostContainer> = {}): HostContainer {
  return container(`${project}-${service}-1`, { compose: { project, service }, ...overrides });
}

function volume(name: string, overrides: Partial<HostVolume> = {}): HostVolume {
  return { name, driver: 'local', sizeBytes: 100 * MB, mountedBy: [], composeProject: null, orphan: false, createdAt: null, ...overrides };
}

function image(tag: string | null, overrides: Partial<HostImage> = {}): HostImage {
  return {
    id: `sha256:${hex(`image-${tag ?? 'none'}-${String(overrides.sizeBytes ?? 0)}`)}`,
    repoTags: tag === null ? [] : [tag],
    repoDigests: [],
    sizeBytes: 100 * MB,
    createdAt: '2026-10-01T00:00:00.000Z',
    containers: 1,
    dangling: tag === null,
    ...overrides,
  };
}

const CONTAINERS: HostContainer[] = [
  inProject('bindery', 'api', { tier: 'shipped', app: 'bindery', health: 'healthy' }),
  inProject('bindery', 'worker', { tier: 'shipped', app: 'bindery', stats: { cpuPercent: 11.8, memoryBytes: Math.round(1.1 * GB), memoryLimitBytes: 2 * GB } }),
  inProject('forgejo', 'server', { health: 'healthy' }),
  inProject('forgejo', 'dind', { state: 'exited', stats: null, image: 'docker:27-dind' }),
  inProject('immich', 'server', { tier: 'operated', app: 'immich' }),
  container('stray', { restartCount: 2 }),
];

function snapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    agent: { id: '7c0f4a0e-3b51-4d8e-9a8e-1f2e3d4c5b6a', fingerprint: 'SHA256:c0ns0le-agent' },
    reportedAt: new Date(NOW - 40_000).toISOString(),
    inventory: {
      sampledAt: new Date(NOW - 41_000).toISOString(),
      containers: CONTAINERS,
      volumes: [
        volume('bindery_pgdata', { sizeBytes: Math.round(2.3 * GB), mountedBy: ['bindery-postgres-1'], composeProject: 'bindery' }),
        volume('kardashev_pgdata', { sizeBytes: 412 * MB, orphan: true, composeProject: 'kardashev' }),
        volume('crownfall_redis', { sizeBytes: 3 * MB, orphan: true }),
        ...Array.from({ length: 5 }, (_, i) => volume(`extra_${String(i)}`, { sizeBytes: (i + 1) * MB, mountedBy: ['stray'] })),
      ],
      images: [
        image('ghcr.io/matdemers1/bindery/worker:sha-1', { sizeBytes: 2 * GB }),
        image('ghcr.io/matdemers1/bindery/worker:sha-2', { sizeBytes: 2 * GB, containers: 0 }),
        image('postgres:16', { sizeBytes: 432 * MB }),
        image('localhost:5000/tool', { sizeBytes: 10 * MB }),
        image(null, { sizeBytes: 5 * MB, containers: 0 }),
      ],
      networks: [],
      builderCache: { bytes: 4 * GB, reclaimableBytes: GB },
      disk: { dataRoot: { path: '/DATA', freeBytes: 875 * GB, totalBytes: 904 * GB }, dockerRoot: null },
    },
    samples: {
      'bindery-api-1': [
        { at: new Date(NOW - 180_000).toISOString(), cpuPercent: 1, memoryBytes: 300 * MB },
        { at: new Date(NOW - 120_000).toISOString(), cpuPercent: 3, memoryBytes: 310 * MB },
        { at: new Date(NOW - 60_000).toISOString(), cpuPercent: 2, memoryBytes: 312 * MB },
      ],
    },
    ...overrides,
  };
}

// ── The model ────────────────────────────────────────────────────────────

describe('the Host model', () => {
  it('builds a snapshot the schema accepts (the fixtures are real)', () => {
    expect(HostResponse.safeParse({ hosts: [snapshot()] }).error?.issues ?? []).toEqual([]);
  });

  it('says the tier as Deployed, Operated and Observed — never the API value', () => {
    expect(TIER_WORDS).toEqual({ shipped: 'Deployed', operated: 'Operated', observed: 'Observed' });
  });

  it('groups by compose project: Deployed first, then Operated, then Observed, alphabetical; no compose last', () => {
    const groups = groupContainers(CONTAINERS);
    expect(groups.map((g) => [g.project, g.tier])).toEqual([
      ['bindery', 'shipped'],
      ['immich', 'operated'],
      ['forgejo', 'observed'],
      [null, 'observed'],
    ]);
    expect(groups[0]?.app).toBe('bindery');
    expect(groups[0]?.containers.map((c) => c.name)).toEqual(['bindery-api-1', 'bindery-worker-1']);
    expect(groups.map((g) => g.troubled)).toEqual([false, false, true, false]);
  });

  it('opens the troubled groups by default, or only the first when every one is well', () => {
    const groups = groupContainers(CONTAINERS);
    expect([...defaultOpen(groups)]).toEqual(['compose:forgejo']);
    const healthy = groupContainers(CONTAINERS.filter((c) => c.state === 'running'));
    expect([...defaultOpen(healthy)]).toEqual(['compose:bindery']);
    const sick = groupContainers([inProject('web', 'app', { health: 'unhealthy' }), inProject('api', 'app')]);
    expect([...defaultOpen(sick)]).toEqual(['compose:web']);
    expect([...defaultOpen([])]).toEqual([]);
  });

  it('counts and filters by chip, and keeps the chip in the address', () => {
    expect(chipCounts(CONTAINERS)).toEqual({ all: 6, deployed: 2, operated: 1, observed: 3, 'not-running': 1 });
    expect(CONTAINERS.filter((c) => matchesChip(c, 'not-running')).map((c) => c.name)).toEqual(['forgejo-dind-1']);
    expect(chipFromParams(new URLSearchParams('tier=deployed'))).toBe('deployed');
    expect(chipFromParams(new URLSearchParams('state=not-running'))).toBe('not-running');
    expect(chipFromParams(new URLSearchParams('tier=shipped'))).toBe('all');
    expect(paramsForChip('operated', new URLSearchParams('state=not-running&x=1')).toString()).toBe('x=1&tier=operated');
    expect(paramsForChip('not-running', new URLSearchParams('tier=observed')).toString()).toBe('state=not-running');
    expect(paramsForChip('all', new URLSearchParams('tier=observed')).toString()).toBe('');
  });

  it('says a container’s state in words with a tone', () => {
    expect(containerStatus(container('a', { health: 'healthy' }))).toEqual({ words: 'Running · healthy', short: 'Healthy', tone: 'neutral' });
    expect(containerStatus(container('a'))).toEqual({ words: 'Running', short: 'Running', tone: 'neutral' });
    expect(containerStatus(container('a', { health: 'unhealthy' })).tone).toBe('danger');
    expect(containerStatus(container('a', { state: 'restarting' }))).toEqual({ words: 'Restarting', short: 'Restarting', tone: 'warning' });
    expect(containerStatus(container('a', { state: 'exited' }))).toEqual({ words: 'Exited', short: 'Exited', tone: 'idle' });
    expect(containerStatus(container('a', { state: 'paused' })).tone).toBe('idle');
    expect(containerStatus(container('a', { state: 'dead' })).tone).toBe('idle');
  });

  it('says use, restarts and the phone line', () => {
    expect(restartWords(0)).toBe('0 restarts');
    expect(restartWords(1)).toBe('1 restart');
    expect(memoryWords({ cpuPercent: 0, memoryBytes: 312 * MB, memoryLimitBytes: null })).toBe('312.0 MB');
    expect(memoryWords({ cpuPercent: 0, memoryBytes: Math.round(1.1 * GB), memoryLimitBytes: 2 * GB })).toBe('1.1 GB / 2.0 GB');
    expect(memoryWords(null)).toBe('—');
    expect(phoneLine(container('a'))).toBe('2.4% CPU · 312.0 MB · 0 restarts');
    expect(phoneLine(container('a', { state: 'exited', stats: null, image: 'docker:27-dind' }))).toBe('0 restarts · docker:27-dind');
  });

  it('draws a sparkline from two samples or more', () => {
    const at = '2026-10-22T00:00:00.000Z';
    expect(sparkPoints(undefined, 72, 20)).toBeNull();
    expect(sparkPoints([{ at, cpuPercent: 5, memoryBytes: 0 }], 72, 20)).toBeNull();
    expect(
      sparkPoints(
        [
          { at, cpuPercent: 0, memoryBytes: 0 },
          { at, cpuPercent: 10, memoryBytes: 0 },
          { at, cpuPercent: 5, memoryBytes: 0 },
        ],
        72,
        20,
      ),
    ).toBe('0.0,19.0 36.0,1.0 72.0,10.0');
    expect(sparkPoints([{ at, cpuPercent: 0, memoryBytes: 0 }, { at, cpuPercent: 0, memoryBytes: 0 }], 72, 20)).toBe('0.0,19.0 72.0,19.0');
  });

  it('marks a snapshot stale after two report intervals', () => {
    expect(isStale(new Date(NOW - 119_000).toISOString(), NOW)).toBe(false);
    expect(isStale(new Date(NOW - 121_000).toISOString(), NOW)).toBe(true);
    expect(isStale('not a date', NOW)).toBe(true);
    expect(ageWords(new Date(NOW - 40_000).toISOString(), NOW)).toBe('40 s');
    expect(ageWords(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5 min');
    expect(ageWords(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('3 h');
    expect(ageWords(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe('2 d');
  });

  it('sorts volumes orphans first, then by size, an unknown size last', () => {
    const sorted = sortVolumes([volume('a', { sizeBytes: 5 }), volume('b', { sizeBytes: null }), volume('c', { orphan: true, sizeBytes: 1 }), volume('d', { sizeBytes: 9 })]);
    expect(sorted.map((v) => v.name)).toEqual(['c', 'd', 'a', 'b']);
  });

  it('sums images: unused, untagged and the three largest repositories', () => {
    expect(repositoryOf('ghcr.io/x/y:sha-1')).toBe('ghcr.io/x/y');
    expect(repositoryOf('localhost:5000/tool')).toBe('localhost:5000/tool');
    const summary = imageSummary(snapshot().inventory.images);
    expect(summary).toMatchObject({ count: 5, unusedCount: 2, unusedBytes: 2 * GB + 5 * MB, dangling: 1 });
    expect(summary.largest).toEqual([
      { repository: 'ghcr.io/matdemers1/bindery/worker', bytes: 4 * GB, versions: 2 },
      { repository: 'postgres', bytes: 432 * MB, versions: 1 },
      { repository: 'localhost:5000/tool', bytes: 10 * MB, versions: 1 },
    ]);
    const totals = hostTotals(snapshot().inventory);
    expect(totals.containers).toEqual({ total: 6, running: 5, notRunning: 1 });
    expect(totals.volumes.orphaned).toBe(2);
  });
});

// ── The screen ───────────────────────────────────────────────────────────

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(<App />);
}

function hostReply(hosts: HostSnapshot[]): Reply {
  return { status: 200, body: { hosts } };
}

function routes(host: Reply | Reply[]): Record<string, Reply | Reply[]> {
  return {
    'GET /api/auth/me': meReply('viewer'),
    'GET /api/apps': { status: 200, body: { apps: [] } },
    'GET /api/approvals': { status: 200, body: [] },
    'GET /api/agent': { status: 200, body: [] },
    'GET /api/host': host,
  };
}

/** Every request the page made that was not a read. */
function writes(calls: readonly Call[]): Call[] {
  return calls.filter((c) => c.method !== 'GET');
}

describe('the Host destination', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the snapshot: age, tiles, chips, groups, volumes, images and the footnote', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const calls = mockFetch(routes(hostReply([snapshot()])));
    renderAt('/host');
    expect(await screen.findByRole('heading', { level: 1, name: 'Host' })).toBeInTheDocument();
    expect(await screen.findByText('Everything Docker runs on this host, read-only. Reported 40 s ago.')).toBeInTheDocument();
    expect(screen.getByText('Agent reporting')).toBeInTheDocument();
    expect(screen.queryByText(/the agent may be down/)).not.toBeInTheDocument();

    const tiles = screen.getByRole('group', { name: 'Host summary' });
    expect(within(tiles).getByText('5 running · 1 not running')).toBeInTheDocument();
    expect(within(tiles).getAllByText('2 orphaned').length).toBeGreaterThan(0);
    expect(within(tiles).getByText(/of 904\.0 GB on \/DATA/)).toBeInTheDocument();
    expect(within(tiles).getByText(/build cache 4\.0 GB/)).toBeInTheDocument();

    const chips = screen.getByRole('group', { name: 'Filter containers' });
    expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual(['All 6', 'Deployed 2', 'Operated 1', 'Observed 3', 'Not running 1']);
    expect(within(chips).getByRole('button', { name: 'All 6' })).toHaveAttribute('aria-pressed', 'true');

    const projects = screen.getByRole('list', { name: 'Compose projects' });
    const toggles = within(projects).getAllByRole('button');
    expect(toggles.map((b) => b.textContent)).toEqual(['bindery', 'immich', 'forgejo', 'Not in a compose project']);
    // Only the group with a container that is not running is open.
    expect(toggles.map((b) => b.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'true', 'false']);
    const forgejo = screen.getByRole('list', { name: 'forgejo containers' });
    expect(within(forgejo).getByText('forgejo-dind-1')).toBeInTheDocument();
    expect(within(forgejo).getByText('docker:27-dind')).toHaveAttribute('title', 'docker:27-dind');
    expect(within(forgejo).getAllByText('Exited').length).toBeGreaterThan(0);

    // A Deployed group links to its app page; an Observed one does not.
    expect(within(projects).getByRole('link', { name: /Open app bindery/ })).toHaveAttribute('href', '/apps/bindery');
    expect(within(projects).getAllByRole('link')).toHaveLength(1);
    expect(within(projects).getAllByText('Deployed')).toHaveLength(1);
    expect(within(projects).getByText('Operated')).toBeInTheDocument();

    // Volumes: orphans first, six shown, then all.
    const vols = screen.getByRole('list', { name: 'Volumes' });
    const names = within(vols).getAllByRole('listitem').map((li) => li.querySelector('.shp-hv__name')?.textContent);
    expect(names).toEqual(['kardashev_pgdata', 'crownfall_redis', 'bindery_pgdata', 'extra_4', 'extra_3', 'extra_2']);
    expect(within(vols).getAllByText('Orphaned')).toHaveLength(2);
    expect(within(vols).getAllByText('No container mounts it')).toHaveLength(2);

    expect(screen.getByText(/5 images · .* · 2 not used by any container .* · 1 untagged/)).toBeInTheDocument();
    expect(screen.getByText(/Largest: ghcr\.io\/matdemers1\/bindery\/worker \(4\.0 GB × 2 versions\)/)).toBeInTheDocument();
    expect(screen.getByText(/^Read-only\. Deployed is a D3 app Shipyard deploys/)).toBeInTheDocument();

    // SHP-REQ-181: it only reads.
    expect(writes(calls)).toEqual([]);
  });

  it('expands a group to show its rows with state, restarts, use and a sparkline', async () => {
    const user = userEvent.setup();
    mockFetch(routes(hostReply([snapshot()])));
    renderAt('/host');
    await user.click(await screen.findByRole('button', { name: 'bindery' }));
    const rows = screen.getByRole('list', { name: 'bindery containers' });
    const api = within(rows).getAllByRole('listitem')[0] as HTMLElement;
    expect(within(api).getByText('bindery-api-1')).toBeInTheDocument();
    expect(within(api).getByText('api')).toBeInTheDocument();
    expect(within(api).getByText('Running · healthy')).toBeInTheDocument();
    expect(within(api).getByText('0 restarts')).toBeInTheDocument();
    expect(within(api).getByText('2.4%')).toBeInTheDocument();
    expect(within(api).getByText('312.0 MB')).toBeInTheDocument();
    expect(within(api).getByRole('img', { name: 'CPU over the last 3 reports, 1.0% to 3.0%' })).toBeInTheDocument();
    const worker = within(rows).getAllByRole('listitem')[1] as HTMLElement;
    expect(within(worker).getByText('1.1 GB / 2.0 GB')).toBeInTheDocument();
    expect(within(worker).getByText('No CPU history yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'bindery' }));
    expect(screen.queryByRole('list', { name: 'bindery containers' })).not.toBeInTheDocument();
  });

  it('filters by chip through the address, and reads the chip from it', async () => {
    const user = userEvent.setup();
    mockFetch(routes(hostReply([snapshot()])));
    renderAt('/host?tier=deployed');
    const chips = await screen.findByRole('group', { name: 'Filter containers' });
    expect(within(chips).getByRole('button', { name: 'Deployed 2' })).toHaveAttribute('aria-pressed', 'true');
    const projects = screen.getByRole('list', { name: 'Compose projects' });
    expect(within(projects).getAllByRole('button').map((b) => b.textContent)).toEqual(['bindery']);

    await user.click(within(chips).getByRole('button', { name: 'Not running 1' }));
    expect(window.location.search).toBe('?state=not-running');
    expect(within(screen.getByRole('list', { name: 'Compose projects' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['forgejo']);

    await user.click(within(chips).getByRole('button', { name: 'All 6' }));
    expect(window.location.search).toBe('');
  });

  it('shows every volume on request', async () => {
    const user = userEvent.setup();
    mockFetch(routes(hostReply([snapshot()])));
    renderAt('/host');
    const vols = await screen.findByRole('list', { name: 'Volumes' });
    expect(within(vols).getAllByRole('listitem')).toHaveLength(6);
    await user.click(screen.getByRole('button', { name: 'Show all 8' }));
    expect(within(screen.getByRole('list', { name: 'Volumes' })).getAllByRole('listitem')).toHaveLength(8);
    expect(screen.getByText('Showing 8 of 8 · orphans first')).toBeInTheDocument();
  });

  it('marks a snapshot stale after two report intervals', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    mockFetch(routes(hostReply([snapshot({ reportedAt: new Date(NOW - 5 * 60_000).toISOString() })])));
    renderAt('/host');
    expect(await screen.findByText('Last reported 5 min ago — the agent may be down.')).toBeInTheDocument();
    expect(screen.getByText('Agent not reporting')).toBeInTheDocument();
  });

  it('offers no action on a container, volume or image (SHP-REQ-181)', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(routes(hostReply([snapshot()])));
    renderAt('/host');
    await screen.findByRole('list', { name: 'Compose projects' });
    for (const toggle of within(screen.getByRole('list', { name: 'Compose projects' })).getAllByRole('button')) {
      if (toggle.getAttribute('aria-expanded') === 'false') await user.click(toggle);
    }
    const main = document.getElementById('main') ?? document.body;
    const buttons = within(main)
      .getAllByRole('button')
      .map((b) => b.textContent.trim());
    for (const name of buttons) {
      expect(name).not.toMatch(/\b(deploy|restart|stop|start|remove|delete|prune|kill|pause|clean)\b/i);
    }
    expect(writes(calls)).toEqual([]);
  });

  it('says so when no agent has reported an inventory', async () => {
    mockFetch(routes(hostReply([])));
    renderAt('/host');
    expect(await screen.findByRole('heading', { name: 'No host inventory yet' })).toBeInTheDocument();
    expect(screen.getByText('The agent reports everything Docker runs once it is on version f574b79 or later.')).toBeInTheDocument();
  });

  it('shows a refusal with its fix', async () => {
    mockFetch(
      routes({
        status: 500,
        body: { error: { code: 'internal', gate: 'none', message: 'Shipyard could not read the host.', fix: 'Try again in a minute.' } },
      }),
    );
    renderAt('/host');
    expect(await screen.findByRole('heading', { name: 'Shipyard could not read the host.' })).toBeInTheDocument();
    expect(screen.getByText('Try again in a minute.')).toBeInTheDocument();
  });

  it('puts each agent under its own heading when more than one reports', async () => {
    const second = snapshot({ agent: { id: '9d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6', fingerprint: 'SHA256:second-agent' } });
    mockFetch(routes(hostReply([snapshot(), second])));
    renderAt('/host');
    expect(await screen.findByRole('heading', { level: 2, name: 'Agent SHA256:c0ns0le-agent' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Agent SHA256:second-agent' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3, name: 'Containers' })).toHaveLength(2);
  });

  it('reads again every 30 seconds while visible, and stops while hidden', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const calls = mockFetch(routes(hostReply([snapshot()])));
    renderAt('/host');
    await screen.findByRole('list', { name: 'Compose projects' });
    const reads = () => calls.filter((c) => c.path === '/api/host').length;
    expect(reads()).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(HOST_POLL_MS);
      await Promise.resolve();
    });
    expect(reads()).toBe(2);

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(3 * HOST_POLL_MS);
      await Promise.resolve();
    });
    expect(reads()).toBe(2);

    visibility.mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(reads()).toBe(3);
    visibility.mockRestore();
  });

  it('fits a phone: the Host tab is in the tab bar and current', async () => {
    viewport.desktop = false;
    mockFetch(routes(hostReply([snapshot()])));
    renderAt('/host');
    const bar = await screen.findByRole('navigation', { name: 'Primary' });
    expect(within(bar).getByRole('link', { name: 'Host' })).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByRole('list', { name: 'Compose projects' })).toBeInTheDocument();
  });
});
