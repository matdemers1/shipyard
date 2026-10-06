import { act, render, screen, within } from '@testing-library/react';
import type { DeployStatus } from '@shipyard/schema';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POLL_MS, retryDelay, type DeployStep, type EventSourceLike } from '../src/lib/progress';
import { DeployView } from '../src/screens/Deploy';
import { mockFetch, type Call, type Reply } from './fetch';

/**
 * Live deploy progress (SHP-T-3.4, SHP-REQ-058): dropping the stream keeps progress moving. Since
 * SHP-T-13.11 the stream drives the one deploy page, which reads the app's soak, the Foreman posts
 * and the CI run beside it; the assertions on the stream count only the deploy's own reads.
 */

const ID = '11111111-2222-4333-8444-555555555555';
const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const DIGEST = `sha256:${'d'.repeat(64)}`;

function status(state: DeployStatus['state'], extra: Partial<DeployStatus> = {}): DeployStatus {
  return {
    deployId: ID,
    kind: 'deploy',
    app: 'web',
    sha: SHA,
    dryRun: false,
    state,
    currentStep: null,
    requester: { label: 'matt (console)', repo: null, branch: null },
    images: [],
    schemaRevision: null,
    refusal: null,
    gates: [],
    createdAt: '2026-09-24T10:00:00.000Z',
    endedAt: null,
    ...extra,
  };
}

function step(name: string, second: number, ended: boolean, extra: Partial<DeployStep> = {}): DeployStep {
  const start = `2026-09-24T10:00:${String(second).padStart(2, '0')}.000Z`;
  return {
    name,
    argv: ['docker', 'compose', name],
    startedAt: start,
    endedAt: ended ? `2026-09-24T10:00:${String(second + 2).padStart(2, '0')}.000Z` : null,
    exitCode: ended ? 0 : null,
    output: ended ? `${name} ok` : null,
    ...extra,
  };
}

/** A controllable EventSource: the test opens it, sends events, and drops it. */
class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  closed = false;
  private readonly listeners = new Map<string, ((ev: MessageEvent<string>) => void)[]>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.(new Event('open'));
  }
  emit(type: string, data: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  drop(): void {
    this.onerror?.(new Event('error'));
  }
}

const factory = (url: string): EventSourceLike => new FakeEventSource(url);

function renderScreen(eventSource: typeof factory | null = factory) {
  return render(
    <MemoryRouter>
      <DeployView id={ID} options={{ eventSource }} />
    </MemoryRouter>,
  );
}

/** What the page reads beside the stream: the app (for its soak), the Foreman posts, the CI run. */
function besideTheStream(app = 'web'): Record<string, Reply> {
  return {
    [`GET /api/apps/${app}`]: {
      status: 200,
      body: { soakSeconds: 60, defaultBranch: 'main', liveSha: null, targets: [], manifest: {} },
    },
    [`GET /api/deploys/${ID}/foreman`]: { status: 200, body: { posts: [], stuck: false } },
    [`GET /api/apps/${app}/commits/${SHA}/run`]: { status: 200, body: { run: null, jobs: [] } },
  };
}

/** The stream's own reads: the status and the steps, not what the page reads beside them. */
function streamCalls(calls: Call[]): Call[] {
  return calls.filter((c) => c.path === `/api/deploys/${ID}` || c.path === `/api/deploys/${ID}/steps`);
}

/** A planned step's row, by the agent's name for it. */
function row(key: string): HTMLElement {
  const list = screen.getByRole('list', { name: 'Deploy steps' });
  const found = list.querySelector<HTMLElement>(`[data-step="${key}"]`);
  if (found === null) throw new Error(`no row for ${key}`);
  return found;
}

function verdict(name: string | RegExp): HTMLElement {
  return screen.getByRole('heading', { level: 2, name });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDeployProgress: SSE with a polling fallback', () => {
  it('keeps progress moving when the stream drops, reconnects, and ends on success with digests and schema', async () => {
    const calls = mockFetch({
      ...besideTheStream(),
      [`GET /api/deploys/${ID}`]: [
        { status: 200, body: status('pulling', { currentStep: 'pull' }) },
        { status: 200, body: status('swapping', { currentStep: 'swap' }) },
      ],
      [`GET /api/deploys/${ID}/steps`]: [
        { status: 200, body: { steps: [step('verify', 0, true), step('pull', 3, false)] } },
        { status: 200, body: { steps: [step('verify', 0, true), step('pull', 3, true), step('swap', 6, false)] } },
        // The one read after the terminal status: the stream sends `status` before `steps`.
        {
          status: 200,
          body: { steps: [step('verify', 0, true), step('pull', 3, true), step('swap', 6, true), step('check', 9, true), step('soak', 12, true)] },
        },
      ],
    });
    renderScreen();

    // Live on the stream.
    expect(FakeEventSource.instances).toHaveLength(1);
    const first = FakeEventSource.instances[0];
    if (first === undefined) throw new Error('no EventSource');
    expect(first.url).toBe(`/api/deploys/${ID}/events`);
    act(() => {
      first.open();
      first.emit('status', status('verifying', { currentStep: 'verify' }));
      first.emit('steps', { steps: [step('verify', 0, false)] });
    });
    expect(screen.getByRole('status')).toHaveTextContent('Live');
    expect(verdict('Verifying')).toBeInTheDocument();
    // Every planned step is listed before it runs.
    expect(row('pull')).toHaveAttribute('data-state', 'waiting');
    expect(streamCalls(calls)).toHaveLength(0);

    // The stream drops: the hook polls at once and says so.
    act(() => {
      first.drop();
    });
    expect(first.closed).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent('Polling (reconnecting)');
    await advance(0);
    expect(row('pull')).toHaveAttribute('data-state', 'running');
    expect(verdict('Pulling')).toBeInTheDocument();
    expect(streamCalls(calls).map((c) => c.path)).toEqual([`/api/deploys/${ID}`, `/api/deploys/${ID}/steps`]);

    // It tries the stream again after the first backoff; that attempt has not opened yet...
    await advance(retryDelay(0));
    expect(FakeEventSource.instances).toHaveLength(2);
    // ...so the next poll, three seconds after the first, still moves progress on.
    await advance(POLL_MS - retryDelay(0));
    expect(streamCalls(calls)).toHaveLength(4);
    expect(row('pull')).toHaveAttribute('data-state', 'done');
    expect(row('swap')).toHaveAttribute('data-state', 'running');
    expect(verdict('Swapping')).toBeInTheDocument();
    const current = within(screen.getByRole('list', { name: 'Deploy steps' }))
      .getAllByRole('listitem')
      .filter((li) => li.getAttribute('aria-current') === 'step');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('Swap');

    // The reconnect opens: live again, polling stops.
    const second = FakeEventSource.instances[1];
    if (second === undefined) throw new Error('no reconnect');
    act(() => {
      second.open();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Live');
    await advance(POLL_MS * 3);
    expect(streamCalls(calls)).toHaveLength(4);

    // Success: every image's SHA and digest, and the schema revision.
    act(() => {
      second.emit('steps', {
        steps: [step('verify', 0, true), step('pull', 3, true), step('swap', 6, true), step('check', 9, true), step('soak', 12, true)],
      });
      second.emit(
        'status',
        status('succeeded', {
          images: [{ service: 'web', sha: SHA, digest: DIGEST }],
          schemaRevision: '0007_add_invites',
          endedAt: '2026-09-24T10:01:00.000Z',
        }),
      );
    });
    expect(second.closed).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent('Finished');
    expect(verdict(`Deployed · ${SHA.slice(0, 7)} is live`)).toBeInTheDocument();
    expect(screen.getByText(DIGEST)).toBeInTheDocument();
    expect(screen.getAllByText(SHA).length).toBeGreaterThan(0);
    expect(screen.getByText('0007_add_invites')).toBeInTheDocument();
    expect(row('soak')).toHaveAttribute('data-state', 'done');
    // The record is this page: nothing links away to another view of the same deploy.
    expect(screen.queryByRole('link', { name: 'Deploy record' })).not.toBeInTheDocument();

    // Nothing reconnects or polls after the end: one last read of the steps, then silence.
    await advance(60_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(streamCalls(calls)).toHaveLength(5);
    expect(streamCalls(calls)[4]?.path).toBe(`/api/deploys/${ID}/steps`);
    expect(row('check')).toHaveAttribute('data-state', 'done');
  });

  it('backs off between failed reconnects while polling every three seconds', async () => {
    const calls = mockFetch({
      ...besideTheStream(),
      [`GET /api/deploys/${ID}`]: { status: 200, body: status('soaking') },
      [`GET /api/deploys/${ID}/steps`]: { status: 200, body: { steps: [step('soak', 0, false)] } },
    });
    renderScreen();
    act(() => {
      FakeEventSource.instances[0]?.drop();
    });
    await advance(retryDelay(0));
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => {
      FakeEventSource.instances[1]?.drop();
    });
    await advance(retryDelay(1) - 1);
    expect(FakeEventSource.instances).toHaveLength(2);
    await advance(1);
    expect(FakeEventSource.instances).toHaveLength(3);
    // One immediate poll, then one per three seconds: t = 0, 3000, 6000.
    expect(calls.filter((c) => c.path === `/api/deploys/${ID}`)).toHaveLength(Math.floor((retryDelay(0) + retryDelay(1)) / POLL_MS) + 1);
    expect(screen.getByRole('status')).toHaveTextContent('Polling (reconnecting)');
  });

  it('polls from the start without EventSource, and shows a failure with its message and fix', async () => {
    mockFetch({
      ...besideTheStream(),
      [`GET /api/deploys/${ID}`]: [
        { status: 200, body: status('checking') },
        {
          status: 200,
          body: status('rolled_back', {
            refusal: { code: 'health_failed', gate: 'none', message: 'web answered 500 on /health.', fix: 'Fix the release and deploy again.' },
            endedAt: '2026-09-24T10:01:00.000Z',
          }),
        },
      ],
      [`GET /api/deploys/${ID}/steps`]: [
        { status: 200, body: { steps: [step('check', 0, false)] } },
        {
          status: 200,
          body: {
            steps: [step('check', 0, true, { exitCode: 1, output: 'HTTP 500' }), step('rollback', 3, true)],
          },
        },
      ],
    });
    renderScreen(null);
    await advance(0);
    expect(screen.getByRole('status')).toHaveTextContent('Polling (reconnecting)');
    expect(row('check')).toHaveAttribute('data-state', 'running');
    await advance(POLL_MS);
    // The verdict leads with the outcome, then the refusal's message and fix verbatim.
    const banner = screen.getByRole('region', { name: /^Rolled back/ });
    expect(within(banner).getByText('web answered 500 on /health.')).toBeInTheDocument();
    expect(within(banner).getByText('Fix the release and deploy again.')).toBeInTheDocument();
    expect(row('check')).toHaveAttribute('data-state', 'failed');
    expect(row('check')).toHaveTextContent('exit 1');
    // Roll back is a real step with its own timer, after the one that failed.
    expect(row('rollback')).toHaveTextContent('Roll back');
    expect(row('rollback')).toHaveTextContent('2s');
    expect(screen.getByLabelText('Output of Check')).toHaveTextContent('HTTP 500');
  });

  it("shows a group deploy's members in order, with the stopped member's group_stopped reason (SHP-T-5.11)", async () => {
    mockFetch({
      ...besideTheStream('bravo'),
      [`GET /api/deploys/${ID}`]: {
        status: 200,
        body: status('failed', {
          app: 'bravo',
          refusal: { code: 'health_failed', gate: 'none', message: 'bravo answered 500 on /health.', fix: 'Fix the release and deploy again.' },
          endedAt: '2026-09-24T10:01:00.000Z',
          group: {
            name: 'trio',
            members: [
              { app: 'alpha', state: 'succeeded', refusal: null, canary: true, position: 0, targetId: 't1' },
              {
                app: 'bravo',
                state: 'failed',
                refusal: { code: 'health_failed', gate: 'none', message: 'bravo answered 500 on /health.', fix: 'Fix the release and deploy again.' },
                canary: false,
                position: 1,
                targetId: 't2',
              },
              {
                app: 'charlie',
                state: 'cancelled',
                refusal: {
                  code: 'group_stopped',
                  gate: 'none',
                  message: 'The group deploy stopped at bravo (failed); this member was not touched.',
                  fix: 'x',
                },
                canary: false,
                position: 2,
                targetId: 't3',
              },
            ],
          },
        }),
      },
      [`GET /api/deploys/${ID}/steps`]: { status: 200, body: { steps: [] } },
    });
    renderScreen(null);
    await advance(0);
    expect(screen.getByText('trio — deployed in order, canary first')).toBeInTheDocument();
    expect(screen.getByText('Canary')).toBeInTheDocument();
    expect(screen.getByText(/The group deploy stopped at bravo/)).toBeInTheDocument();
    const group = screen.getByText('alpha').closest('dl');
    expect(group).not.toBeNull();
    if (group === null) throw new Error('no group list');
    const rows = within(group).getAllByRole('term');
    expect(rows.map((r) => r.textContent)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('a refusal ends progress with its message', async () => {
    mockFetch({
      [`GET /api/deploys/${ID}`]: {
        status: 404,
        body: { error: { code: 'not_found', gate: 'none', message: 'No such deploy.', fix: 'List deploys and use one of their IDs.' } },
      },
      [`GET /api/deploys/${ID}/steps`]: { status: 404, body: { error: { code: 'not_found', gate: 'none', message: 'No such deploy.', fix: 'x' } } },
    });
    renderScreen(null);
    await advance(0);
    expect(screen.getByRole('heading', { name: 'No such deploy.' })).toBeInTheDocument();
  });
});
