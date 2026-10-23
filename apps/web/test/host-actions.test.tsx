import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ActionStatus,
  LOGS_MAX_FOLLOW_SECONDS,
  LOGS_MAX_TAIL,
  LifecycleVerb,
  LogsSession,
  type HostContainer,
  type HostSnapshot,
} from '@shipyard/schema';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import {
  LOGS_FOLLOW_SECONDS,
  LOGS_LINE_CAP,
  actionBadgeWords,
  canAct,
  canReadLogs,
  capLines,
  containerRequest,
  containerVerbs,
  followClock,
  logTime,
  progressWords,
  resultWords,
  targetFor,
} from '../src/lib/actions';
import { LIFECYCLE_ACTIVE_WORDS, LIFECYCLE_PAST_WORDS, LIFECYCLE_VERB_WORDS } from '../src/lib/words';
import { LOGS_NOTE } from '../src/screens/host/ContainerSheet';
import { STOP_CONSOLE_ONLY, stopConsequence } from '../src/screens/host/StopConfirm';
import { meReply, mockFetch, type Call, type Reply } from './fetch';

/**
 * SHP-T-15.7 (SHP-REQ-184/185/188/189/192, SHP-ADR-010/011): a Host container row opens a sheet —
 * from the row or from `?container=` — with its logs (tail 200, a follow toggle with the time left,
 * closed and deleted on close, the redaction note, an error state for an agent too old) and the
 * lifecycle actions its tier and the reader's role allow: none for Observed, Stop behind a
 * confirmation, progress and then the result inline. A Deployed or Operated group restarts its whole
 * stack.
 */

// ── Fixtures ─────────────────────────────────────────────────────────────

const MB = 1024 * 1024;

function id64(ch: string): string {
  return ch.repeat(64);
}

function container(name: string, overrides: Partial<HostContainer>): HostContainer {
  return {
    id: id64('0'),
    name,
    image: `ghcr.io/matdemers1/${name}:sha-${'a'.repeat(40)}`,
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
    stats: { cpuPercent: 11.8, memoryBytes: 300 * MB, memoryLimitBytes: null },
    ...overrides,
  };
}

const WORKER = container('bindery-worker-1', { id: id64('1'), compose: { project: 'bindery', service: 'worker' }, tier: 'shipped', app: 'bindery' });
const STOPPED = container('bindery-cron-1', { id: id64('2'), compose: { project: 'bindery', service: 'cron' }, tier: 'shipped', app: 'bindery', state: 'exited', stats: null });
const IMMICH = container('immich-server-1', { id: id64('3'), compose: { project: 'immich', service: 'server' }, tier: 'operated', app: 'immich' });
const FORGEJO = container('forgejo', { id: id64('4'), compose: { project: 'forgejo', service: 'server' } });
const CONTAINERS = [WORKER, STOPPED, IMMICH, FORGEJO];

function snapshot(): HostSnapshot {
  return {
    agent: { id: '7c0f4a0e-3b51-4d8e-9a8e-1f2e3d4c5b6a', fingerprint: 'SHA256:agent' },
    reportedAt: new Date().toISOString(),
    inventory: {
      sampledAt: new Date().toISOString(),
      containers: CONTAINERS,
      volumes: [],
      images: [],
      networks: [],
      builderCache: { bytes: 0, reclaimableBytes: 0 },
      disk: { dataRoot: { path: '/DATA', freeBytes: 1, totalBytes: 2 }, dockerRoot: null },
    },
    samples: {},
  };
}

const ACTION_ID = '0b9c1f6e-6a4e-4d43-9a49-8e1f2b3c4d5e';
const LOGS_ID = '5f0e2c1a-1b2c-4d3e-8f4a-5b6c7d8e9f00';

function status(overrides: Partial<ActionStatus> = {}): ActionStatus {
  return {
    id: ACTION_ID,
    target: { kind: 'app', name: 'bindery' },
    verb: 'restart',
    service: 'worker',
    state: 'queued',
    requesterLabel: 'Matt (console)',
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    refusal: null,
    output: null,
    ...overrides,
  };
}

function session(follow = false): LogsSession {
  return { id: LOGS_ID, container: WORKER.id, containerName: WORKER.name, tail: 200, follow, createdAt: new Date().toISOString() };
}

type Role = 'admin' | 'operator' | 'deployer' | 'viewer';

function routes(role: Role, extra: Record<string, Reply | Reply[] | ((init: RequestInit | undefined) => Reply)> = {}) {
  return mockFetch({
    'GET /api/auth/me': meReply(role),
    'GET /api/apps': { status: 200, body: { apps: [] } },
    'GET /api/approvals': { status: 200, body: [] },
    'GET /api/agent': { status: 200, body: [] },
    'GET /api/host': { status: 200, body: { hosts: [snapshot()] } },
    'POST /api/logs': (init) => ({ status: 201, body: session((JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { follow?: boolean }).follow === true) }),
    [`DELETE /api/logs/${LOGS_ID}`]: { status: 200 },
    ...extra,
  });
}

// ── A stand-in EventSource (jsdom has none) ──────────────────────────────

type Listener = (event: Event) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  onerror: Listener | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    act(() => {
      for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
    });
  }
}

function useFakeEventSource(): typeof FakeEventSource {
  FakeEventSource.instances = [];
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, writable: true, value: FakeEventSource });
  return FakeEventSource;
}

function latestSource(): FakeEventSource {
  const es = FakeEventSource.instances.at(-1);
  if (es === undefined) throw new Error('no EventSource was opened');
  return es;
}

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(<App />);
}

function posts(calls: readonly Call[], path: string): Call[] {
  return calls.filter((c) => c.method === 'POST' && c.path === path);
}

async function openSheet(path = `/host?container=${WORKER.id}`): Promise<HTMLElement> {
  renderAt(path);
  return screen.findByRole('dialog', { name: WORKER.name });
}

// ── The model ────────────────────────────────────────────────────────────

describe('the actions model (SHP-ADR-010)', () => {
  it('names an app for Deployed, a stack for Operated and nothing for Observed (SHP-REQ-185)', () => {
    expect(targetFor(WORKER.tier, WORKER.app)).toEqual({ kind: 'app', name: 'bindery' });
    expect(targetFor(IMMICH.tier, IMMICH.app)).toEqual({ kind: 'stack', name: 'immich' });
    expect(targetFor(FORGEJO.tier, FORGEJO.app)).toBeNull();
    expect(containerRequest(WORKER, 'restart')).toEqual({ target: { kind: 'app', name: 'bindery' }, verb: 'restart', service: 'worker' });
    expect(containerRequest(FORGEJO, 'restart')).toBeNull();
  });

  it('lets deployer and above act, and only admin and operator read logs', () => {
    expect((['admin', 'operator', 'deployer', 'viewer'] as const).map(canAct)).toEqual([true, true, true, false]);
    expect((['admin', 'operator', 'deployer', 'viewer'] as const).map(canReadLogs)).toEqual([true, true, false, false]);
  });

  it('offers Restart, Recreate and Stop while running, and Start when not', () => {
    expect(containerVerbs(WORKER)).toEqual(['restart', 'recreate', 'stop']);
    expect(containerVerbs(STOPPED)).toEqual(['start']);
  });

  it('has words for every verb, never "Ship"', () => {
    for (const verb of LifecycleVerb.options) {
      for (const words of [LIFECYCLE_VERB_WORDS, LIFECYCLE_ACTIVE_WORDS, LIFECYCLE_PAST_WORDS]) {
        expect(words[verb]).toBeTruthy();
        expect(words[verb]).not.toMatch(/ship/i);
      }
    }
    expect(Object.values(LIFECYCLE_PAST_WORDS)).toEqual(['Started', 'Stopped', 'Restarted', 'Recreated']);
  });

  it('words progress and results', () => {
    expect(progressWords(status({ state: 'running' }), 8)).toEqual({ headline: 'Restarting', detail: 'Requested by Matt (console) · journaled on the host, running (8 s)' });
    expect(progressWords(status(), 2).headline).toBe('Queued');
    const done = status({ state: 'succeeded', startedAt: '2026-10-22T12:00:00.000Z', endedAt: '2026-10-22T12:00:08.000Z' });
    expect(resultWords(done)).toBe('Restarted worker in 8s');
    expect(resultWords(status({ state: 'failed', service: null }))).toBe('Restart of the whole stack failed');
    expect(actionBadgeWords(done)).toBe('Restarted');
    expect(actionBadgeWords(status({ state: 'refused' }))).toBe('Restart refused');
  });

  it("keeps the schema's limits: 2000 lines, five minutes of follow (SHP-REQ-189)", () => {
    expect(LOGS_LINE_CAP).toBe(LOGS_MAX_TAIL);
    expect(LOGS_FOLLOW_SECONDS).toBe(LOGS_MAX_FOLLOW_SECONDS);
    const many = Array.from({ length: LOGS_LINE_CAP + 5 }, (_, key) => ({ key, line: { at: null, stream: 'stdout' as const, text: String(key) } }));
    const kept = capLines(many);
    expect(kept).toHaveLength(LOGS_LINE_CAP);
    expect(kept[0]?.key).toBe(5);
    expect(followClock(300)).toBe('5:00');
    expect(followClock(252)).toBe('4:12');
    expect(followClock(-3)).toBe('0:00');
    expect(logTime(null)).toBe('--:--:--');
    expect(logTime(new Date(2026, 9, 22, 7, 5, 9).toISOString())).toBe('07:05:09');
  });

  it('says what a stop does, by target', () => {
    expect(stopConsequence({ kind: 'app', name: 'bindery' }, 'worker')).toBe(
      "worker of bindery stops until it is started again. Shipyard won't start it for you, and the next deploy of bindery will start it.",
    );
    expect(stopConsequence({ kind: 'stack', name: 'immich' }, 'server')).toBe("server of immich stops until it is started again. Shipyard won't start it for you.");
  });
});

// ── The sheet ────────────────────────────────────────────────────────────

describe('the container sheet', () => {
  it('opens from a row, keeps ?container= in the address, and Back closes it', async () => {
    useFakeEventSource();
    routes('admin');
    const user = userEvent.setup();
    renderAt('/host');
    // bindery opens by default: one of its containers is not running.
    await user.click(await screen.findByRole('link', { name: WORKER.name }));
    const sheet = await screen.findByRole('dialog', { name: WORKER.name });
    expect(new URLSearchParams(window.location.search).get('container')).toBe(WORKER.id);
    expect(within(sheet).getByText('Deployed')).toBeInTheDocument();
    expect(within(sheet).getByText('bindery · worker')).toBeInTheDocument();
    expect(within(sheet).getByText(WORKER.image)).toBeInTheDocument();
    expect(within(sheet).getByText(LOGS_NOTE)).toBeInTheDocument();

    act(() => {
      window.history.back();
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: WORKER.name })).not.toBeInTheDocument();
    });
    expect(window.location.search).toBe('');
  });

  it('opens straight from ?container= and closes back to the plain page', async () => {
    useFakeEventSource();
    routes('admin');
    const user = userEvent.setup();
    const sheet = await openSheet();
    const closes = within(sheet).getAllByRole('button', { name: 'Close' });
    await user.click(closes[0] as HTMLElement);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(window.location.search).toBe('');
  });

  it('says so when the address names a container the host does not have', async () => {
    useFakeEventSource();
    routes('admin');
    renderAt(`/host?container=${id64('f')}`);
    expect(await screen.findByRole('dialog', { name: 'Container not found' })).toBeInTheDocument();
  });

  it('shows Restart, Recreate and Stop on a running Deployed container to a deployer, with the image note', async () => {
    useFakeEventSource();
    routes('deployer');
    const sheet = await openSheet();
    const group = within(sheet).getByRole('group', { name: 'Actions' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['Restart', 'Recreate', 'Stop']);
    expect(within(sheet).getByText('Restart and Recreate never change the image.')).toBeInTheDocument();
    // A deployer acts but does not read logs (SHP-ADR-011).
    expect(within(sheet).getByText("Your role can't read logs")).toBeInTheDocument();
  });

  it('offers only Start when the container is not running', async () => {
    useFakeEventSource();
    routes('admin');
    renderAt(`/host?container=${STOPPED.id}`);
    const sheet = await screen.findByRole('dialog', { name: STOPPED.name });
    expect(within(within(sheet).getByRole('group', { name: 'Actions' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['Start']);
  });

  it('offers no action on an Observed container, whoever asks (SHP-REQ-185)', async () => {
    useFakeEventSource();
    routes('admin');
    renderAt(`/host?container=${FORGEJO.id}`);
    const sheet = await screen.findByRole('dialog', { name: FORGEJO.name });
    expect(within(sheet).queryByRole('group', { name: 'Actions' })).not.toBeInTheDocument();
    expect(within(sheet).getByText(/^Observed: Shipyard only watches this container/)).toBeInTheDocument();
    for (const verb of ['Start', 'Stop', 'Restart', 'Recreate']) expect(within(sheet).queryByRole('button', { name: verb })).not.toBeInTheDocument();
  });

  it('offers a viewer no action and no logs', async () => {
    useFakeEventSource();
    const calls = routes('viewer');
    const sheet = await openSheet();
    expect(within(sheet).queryByRole('group', { name: 'Actions' })).not.toBeInTheDocument();
    expect(within(sheet).getByText("Your role can't read logs")).toBeInTheDocument();
    expect(posts(calls, '/api/logs')).toEqual([]);
  });

  it('asks before Stop, says stop is console-only, and sends nothing on Cancel (SHP-REQ-188)', async () => {
    useFakeEventSource();
    const calls = routes('admin', { 'POST /api/actions': { status: 202, body: status({ verb: 'stop' }) }, [`GET /api/actions/${ACTION_ID}`]: { status: 200, body: status({ verb: 'stop' }) } });
    const user = userEvent.setup();
    const sheet = await openSheet();
    await user.click(within(sheet).getByRole('button', { name: 'Stop' }));
    let confirm = await screen.findByRole('dialog', { name: `Stop ${WORKER.name}?` });
    expect(within(confirm).getByText(stopConsequence({ kind: 'app', name: 'bindery' }, 'worker'))).toBeInTheDocument();
    expect(within(confirm).getByText(STOP_CONSOLE_ONLY)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(posts(calls, '/api/actions')).toEqual([]);

    await user.click(within(sheet).getByRole('button', { name: 'Stop' }));
    confirm = await screen.findByRole('dialog', { name: `Stop ${WORKER.name}?` });
    await user.click(within(confirm).getByRole('button', { name: `Stop ${WORKER.name}` }));
    await waitFor(() => {
      expect(posts(calls, '/api/actions').map((c) => c.body)).toEqual([{ target: { kind: 'app', name: 'bindery' }, verb: 'stop', service: 'worker' }]);
    });
  });

  it('shows the action in progress with its state words, disables the buttons, then the result inline', async () => {
    useFakeEventSource();
    const startedAt = new Date().toISOString();
    const calls = routes('admin', {
      'POST /api/actions': { status: 202, body: status() },
      [`GET /api/actions/${ACTION_ID}`]: [
        { status: 200, body: status({ state: 'running', startedAt }) },
        {
          status: 200,
          body: status({ state: 'succeeded', startedAt, endedAt: new Date(Date.parse(startedAt) + 8_000).toISOString(), output: 'Container bindery-worker-1  Restarted' }),
        },
      ],
    });
    const user = userEvent.setup();
    const sheet = await openSheet();
    await user.click(within(sheet).getByRole('button', { name: 'Restart' }));
    expect(posts(calls, '/api/actions').map((c) => c.body)).toEqual([{ target: { kind: 'app', name: 'bindery' }, verb: 'restart', service: 'worker' }]);

    expect(await within(sheet).findByText('Queued')).toBeInTheDocument();
    expect(within(sheet).getByText(/^Requested by Matt \(console\) · waiting for the agent to pick it up/)).toBeInTheDocument();
    for (const b of within(within(sheet).getByRole('group', { name: 'Actions' })).getAllByRole('button')) expect(b).toBeDisabled();

    expect(await within(sheet).findByText('Restarting')).toBeInTheDocument();
    expect(await within(sheet).findByText('Restarted worker in 8s')).toBeInTheDocument();
    expect(within(sheet).getByText('Compose output')).toBeInTheDocument();
    for (const b of within(within(sheet).getByRole('group', { name: 'Actions' })).getAllByRole('button')) expect(b).toBeEnabled();
  });

  it("shows a refusal's message and fix verbatim", async () => {
    useFakeEventSource();
    routes('admin', {
      'POST /api/actions': {
        status: 409,
        body: { error: { code: 'locked', gate: 'G4', message: 'bindery is being deployed by Matt (console).', fix: 'Wait for that deploy to finish, then try again.' } },
      },
    });
    const user = userEvent.setup();
    const sheet = await openSheet();
    await user.click(within(sheet).getByRole('button', { name: 'Recreate' }));
    expect(await within(sheet).findByText('bindery is being deployed by Matt (console).')).toBeInTheDocument();
    expect(within(sheet).getByText('Wait for that deploy to finish, then try again.')).toBeInTheDocument();
  });

  it('shows a refusal the agent sent back on the finished action, verbatim', async () => {
    useFakeEventSource();
    const refusal = { code: 'not_adopted' as const, gate: 'none' as const, message: 'immich is not an adopted stack on this host.', fix: 'Adopt it with a stacks/ manifest (docs/runbooks/adopt-stack.md).' };
    const calls = routes('admin', {
      'POST /api/actions': { status: 202, body: status({ target: { kind: 'stack', name: 'immich' }, service: 'server', state: 'refused', refusal, endedAt: new Date().toISOString() }) },
    });
    const user = userEvent.setup();
    renderAt(`/host?container=${IMMICH.id}`);
    const sheet = await screen.findByRole('dialog', { name: IMMICH.name });
    await user.click(within(sheet).getByRole('button', { name: 'Restart' }));
    expect(posts(calls, '/api/actions').map((c) => c.body)).toEqual([{ target: { kind: 'stack', name: 'immich' }, verb: 'restart', service: 'server' }]);
    expect(await within(sheet).findByText(refusal.message)).toBeInTheDocument();
    expect(within(sheet).getByText(refusal.fix)).toBeInTheDocument();
  });
});

// ── A group's Restart stack ──────────────────────────────────────────────

describe('Restart stack', () => {
  it('restarts a Deployed or Operated project as a whole, with progress; Observed gets none', async () => {
    const calls = routes('deployer', {
      'POST /api/actions': { status: 202, body: status({ service: null }) },
      [`GET /api/actions/${ACTION_ID}`]: { status: 200, body: status({ service: null, state: 'running', startedAt: new Date().toISOString() }) },
    });
    const user = userEvent.setup();
    renderAt('/host');
    const projects = await screen.findByRole('list', { name: 'Compose projects' });
    expect(within(projects).getByRole('button', { name: 'Restart stack bindery' })).toBeInTheDocument();
    expect(within(projects).getByRole('button', { name: 'Restart stack immich' })).toBeInTheDocument();
    expect(within(projects).queryByRole('button', { name: 'Restart stack forgejo' })).not.toBeInTheDocument();

    await user.click(within(projects).getByRole('button', { name: 'Restart stack bindery' }));
    expect(posts(calls, '/api/actions').map((c) => c.body)).toEqual([{ target: { kind: 'app', name: 'bindery' }, verb: 'restart' }]);
    expect(await within(projects).findByText('Queued')).toBeInTheDocument();
    expect(within(projects).getByRole('button', { name: 'Restart stack bindery' })).toBeDisabled();
    expect(await within(projects).findByText('Restarting')).toBeInTheDocument();
  });

  it('is not offered to a viewer', async () => {
    routes('viewer');
    renderAt('/host');
    const projects = await screen.findByRole('list', { name: 'Compose projects' });
    expect(within(projects).queryByRole('button', { name: /^Restart stack/ })).not.toBeInTheDocument();
  });
});

// ── Logs ─────────────────────────────────────────────────────────────────

describe('the logs viewer (SHP-ADR-011)', () => {
  it('asks for the last 200 lines and renders them in order, stderr marked, newest at the bottom', async () => {
    useFakeEventSource();
    const calls = routes('operator');
    const sheet = await openSheet();
    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(1);
    });
    expect(posts(calls, '/api/logs').map((c) => c.body)).toEqual([{ container: WORKER.id, tail: 200, follow: false }]);
    expect(latestSource().url).toBe(`/api/logs/${LOGS_ID}/stream`);
    expect(within(sheet).getByText('last 200 lines')).toBeInTheDocument();

    const at = (s: number) => new Date(2026, 9, 22, 12, 50, s).toISOString();
    latestSource().emit('lines', { seq: 0, lines: [{ at: at(41), stream: 'stdout', text: 'ocr: page 14/38' }, { at: at(47), stream: 'stderr', text: 'WARN low confidence' }] });
    latestSource().emit('lines', { seq: 1, lines: [{ at: at(51), stream: 'stdout', text: 's3: put blob with key [redacted]' }] });
    latestSource().emit('end', {});

    const log = within(sheet).getByRole('log', { name: 'Log lines' });
    const items = within(log).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(['12:50:41ocr: page 14/38', '12:50:47WARN low confidence', '12:50:51s3: put blob with key [redacted]']);
    expect(items[1]).toHaveAttribute('data-stream', 'stderr');
    expect(within(sheet).getByText(LOGS_NOTE)).toBeInTheDocument();
  });

  it('says "No output" when the tail is empty', async () => {
    useFakeEventSource();
    routes('admin');
    const sheet = await openSheet();
    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(1);
    });
    latestSource().emit('end', {});
    expect(await within(sheet).findByText('No output')).toBeInTheDocument();
  });

  it('follows with a five-minute countdown, and turning it off closes the stream and its session', async () => {
    useFakeEventSource();
    const calls = routes('admin');
    const user = userEvent.setup();
    const sheet = await openSheet();
    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(1);
    });
    latestSource().emit('lines', { seq: 0, lines: [{ at: null, stream: 'stdout', text: 'first' }] });
    latestSource().emit('end', {});

    await user.click(within(sheet).getByRole('button', { name: 'Follow' }));
    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(2);
    });
    expect(posts(calls, '/api/logs').map((c) => c.body)).toEqual([
      { container: WORKER.id, tail: 200, follow: false },
      { container: WORKER.id, tail: 200, follow: true },
    ]);
    const toggle = within(sheet).getByRole('button', { name: /^Following · \d:\d\d left$/ });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle.textContent).toMatch(/^Following · (5:00|4:59) left$/);

    // The re-opened stream sends its tail again: it replaces what was there rather than doubling it.
    latestSource().emit('lines', { seq: 0, lines: [{ at: null, stream: 'stdout', text: 'first' }, { at: null, stream: 'stdout', text: 'second' }] });
    expect(within(within(sheet).getByRole('log')).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['--:--:--first', '--:--:--second']);

    const following = latestSource();
    await user.click(toggle);
    expect(following.closed).toBe(true);
    await waitFor(() => {
      expect(calls.filter((c) => c.method === 'DELETE' && c.path === `/api/logs/${LOGS_ID}`).length).toBeGreaterThanOrEqual(2);
    });
    expect(within(sheet).getByRole('button', { name: 'Follow' })).toHaveAttribute('aria-pressed', 'false');
    // The lines stay on screen.
    expect(within(within(sheet).getByRole('log')).getAllByRole('listitem')).toHaveLength(2);
  });

  it('closes the stream and DELETEs the session when the sheet closes', async () => {
    useFakeEventSource();
    const calls = routes('admin');
    const user = userEvent.setup();
    const sheet = await openSheet();
    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(1);
    });
    const es = latestSource();
    await user.click(within(sheet).getAllByRole('button', { name: 'Close' })[0] as HTMLElement);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(es.closed).toBe(true);
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE' && c.path === `/api/logs/${LOGS_ID}`)).toBe(true);
    });
  });

  it('says plainly when the agent is too old to stream logs', async () => {
    useFakeEventSource();
    routes('admin', {
      'POST /api/logs': {
        status: 409,
        body: { error: { code: 'agent_too_old', gate: 'none', message: 'The agent on this host does not stream logs.', fix: 'Upgrade the agent (docs/runbooks/upgrade-agent.md).' } },
      },
    });
    const sheet = await openSheet();
    expect(await within(sheet).findByText("The agent can't stream logs yet")).toBeInTheDocument();
    expect(within(sheet).getByText('The agent on this host does not stream logs.')).toBeInTheDocument();
    expect(within(sheet).getByText('Upgrade the agent (docs/runbooks/upgrade-agent.md).')).toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('shows an error the stream ends with, verbatim', async () => {
    useFakeEventSource();
    routes('admin');
    const sheet = await openSheet();
    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(1);
    });
    latestSource().emit('end', { error: { code: 'invalid_request', gate: 'none', message: 'The container is gone.', fix: 'Reload Host.' } });
    expect(await within(sheet).findByText('The container is gone.')).toBeInTheDocument();
    expect(within(sheet).getByText('Reload Host.')).toBeInTheDocument();
  });
});
