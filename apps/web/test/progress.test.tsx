import { act, render, screen, within } from '@testing-library/react';
import type { DeployStatus } from '@shipyard/schema';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POLL_MS, retryDelay, type DeployStep, type EventSourceLike } from '../src/lib/progress';
import { DeployProgressView } from '../src/screens/DeployProgress';
import { mockFetch } from './fetch';

/** Live deploy progress (SHP-T-3.4, SHP-REQ-058): dropping the stream keeps progress moving. */

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
      <DeployProgressView id={ID} options={{ eventSource }} />
    </MemoryRouter>,
  );
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function stepNames(): string[] {
  const list = screen.getByRole('list', { name: 'Deploy steps' });
  return within(list)
    .getAllByRole('listitem')
    .map((li) => li.querySelector('strong')?.textContent ?? '');
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
      [`GET /api/deploys/${ID}`]: [
        { status: 200, body: status('pulling', { currentStep: 'pull' }) },
        { status: 200, body: status('swapping', { currentStep: 'swap' }) },
      ],
      [`GET /api/deploys/${ID}/steps`]: [
        { status: 200, body: { steps: [step('verify', 0, true), step('pull', 3, false)] } },
        { status: 200, body: { steps: [step('verify', 0, true), step('pull', 3, true), step('swap', 6, false)] } },
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
    expect(stepNames()).toEqual(['verify']);
    expect(screen.getByText('Verifying')).toBeInTheDocument();
    expect(calls).toHaveLength(0);

    // The stream drops: the hook polls at once and says so.
    act(() => {
      first.drop();
    });
    expect(first.closed).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent('Polling (reconnecting)');
    await advance(0);
    expect(stepNames()).toEqual(['verify', 'pull']);
    expect(screen.getByText('Pulling')).toBeInTheDocument();
    expect(calls.map((c) => c.path)).toEqual([`/api/deploys/${ID}`, `/api/deploys/${ID}/steps`]);

    // It tries the stream again after the first backoff; that attempt has not opened yet...
    await advance(retryDelay(0));
    expect(FakeEventSource.instances).toHaveLength(2);
    // ...so the next poll, three seconds after the first, still moves progress on.
    await advance(POLL_MS - retryDelay(0));
    expect(calls).toHaveLength(4);
    expect(stepNames()).toEqual(['verify', 'pull', 'swap']);
    expect(screen.getByText('Swapping')).toBeInTheDocument();
    const current = screen.getAllByRole('listitem').find((li) => li.getAttribute('aria-current') === 'step');
    expect(current).toHaveTextContent('swap');

    // The reconnect opens: live again, polling stops.
    const second = FakeEventSource.instances[1];
    if (second === undefined) throw new Error('no reconnect');
    act(() => {
      second.open();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Live');
    await advance(POLL_MS * 3);
    expect(calls).toHaveLength(4);

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
    expect(screen.getByText('Deployed')).toBeInTheDocument();
    expect(screen.getByText(DIGEST)).toBeInTheDocument();
    expect(screen.getAllByText(SHA).length).toBeGreaterThan(0);
    expect(screen.getByText('0007_add_invites')).toBeInTheDocument();
    expect(stepNames()).toEqual(['verify', 'pull', 'swap', 'check', 'soak']);
    expect(screen.getByRole('link', { name: 'Deploy record' })).toHaveAttribute('href', `/deploys/${ID}`);

    // Nothing reconnects or polls after the end.
    await advance(60_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(calls).toHaveLength(4);
  });

  it('backs off between failed reconnects while polling every three seconds', async () => {
    const calls = mockFetch({
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
    expect(stepNames()).toEqual(['check']);
    await advance(POLL_MS);
    expect(screen.getAllByText('Rolled back').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('web answered 500 on /health.')).toBeInTheDocument();
    expect(screen.getByText('Fix the release and deploy again.')).toBeInTheDocument();
    expect(screen.getByText('Failed (exit 1)')).toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items[1]).toHaveTextContent('Rollback');
    expect(screen.getByLabelText('Output of check')).toHaveTextContent('HTTP 500');
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
