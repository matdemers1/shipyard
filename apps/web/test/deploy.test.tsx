import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DeployStatus } from '@shipyard/schema';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { foremanProjectOf, lastLine, liveBefore, soakClock } from '../src/lib/deploy';
import type { DeployStep, EventSourceLike } from '../src/lib/progress';
import { DeployView } from '../src/screens/Deploy';
import { meReply, mockFetch, type Reply } from './fetch';

/**
 * The one deploy page (SHP-T-13.11, SHP-REQ-162, SHP-DA-005): `/deploys/:id` streams while the
 * deploy runs and is its record afterwards — verdict first, every planned step with its timer, the
 * soak counted from the manifest, the refused check and its fix, a held approval's Approve and
 * Deny, and a next action on every state. `/deploys/:id/live` redirects to it.
 */

const ID = '11111111-2222-4333-8444-555555555555';
const SHA = '3b7c9e1' + 'a'.repeat(33);
const BEFORE = 'fd13023' + 'b'.repeat(33);
const DIGEST = `sha256:${'d'.repeat(64)}`;
const T0 = Date.parse('2026-10-03T12:13:00.000Z');

function at(seconds: number): string {
  return new Date(T0 + seconds * 1000).toISOString();
}

function status(state: DeployStatus['state'], extra: Partial<DeployStatus> = {}): DeployStatus {
  return {
    deployId: ID,
    kind: 'deploy',
    app: 'foreman-board',
    sha: SHA,
    dryRun: false,
    state,
    currentStep: null,
    requester: { label: 'Matthew (console)', repo: null, branch: null },
    images: [],
    schemaRevision: null,
    refusal: null,
    gates: [],
    createdAt: at(0),
    endedAt: null,
    ...extra,
  };
}

/** A step that started `start` seconds in and, when `took` is a number, ended that many seconds later. */
function step(name: string, start: number, took: number | null, extra: Partial<DeployStep> = {}): DeployStep {
  return {
    name,
    argv: [name],
    startedAt: at(start),
    endedAt: took === null ? null : at(start + took),
    exitCode: took === null ? null : 0,
    output: took === null ? null : `${name} ok`,
    ...extra,
  };
}

/** The steps of a deploy that has swapped and is soaking, the soak started at 42 s. */
const SOAKING_STEPS = [
  step('verify', 0, 1),
  step('backup', 1, 41, { output: 'pg_dump → 88 MB' }),
  step('migrate', 42, 6),
  step('pull', 48, 2),
  step('swap', 50, 2),
  step('check', 52, 2),
  step('soak', 54, null),
];

function appDetail(app: string, extra: Record<string, unknown> = {}): Reply {
  return {
    status: 200,
    body: {
      soakSeconds: 60,
      defaultBranch: 'main',
      repo: 'matdemers1/foreman',
      liveSha: BEFORE,
      targets: [
        { id: 't0', deployId: 'older', kind: 'deploy', sha: BEFORE, dryRun: false, requester: 'x', state: 'succeeded', currentStep: null, createdAt: at(-3600), startedAt: at(-3600), endedAt: at(-3500) },
      ],
      manifest: { foreman: { project: 'FRM' } },
      ...extra,
      name: app,
    },
  };
}

interface Routes {
  status: DeployStatus | Reply[];
  steps: DeployStep[];
  role?: 'deployer' | 'viewer';
  foreman?: unknown;
  run?: Reply;
  extra?: Record<string, Reply>;
}

function routes({ status: s, steps, role = 'deployer', foreman, run, extra = {} }: Routes) {
  const app = Array.isArray(s) ? 'foreman-board' : s.app;
  return mockFetch({
    'GET /api/auth/me': meReply(role),
    [`GET /api/deploys/${ID}`]: Array.isArray(s) ? s : { status: 200, body: s },
    [`GET /api/deploys/${ID}/steps`]: { status: 200, body: { steps } },
    [`GET /api/deploys/${ID}/foreman`]: { status: 200, body: foreman ?? { posts: [], stuck: false } },
    [`GET /api/apps/${app}`]: appDetail(app),
    [`GET /api/apps/${app}/commits/${SHA}/run`]: run ?? { status: 200, body: { run: null, jobs: [] } },
    ...extra,
  });
}

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(<App />);
}

/** The view on its own, polling (no EventSource), with the clock pinned. */
function renderView(props: Partial<Parameters<typeof DeployView>[0]> = {}) {
  return render(
    <MemoryRouter>
      <DeployView id={ID} options={{ eventSource: null }} {...props} />
    </MemoryRouter>,
  );
}

function rowFor(key: string): HTMLElement {
  const found = screen.getByRole('list', { name: 'Deploy steps' }).querySelector<HTMLElement>(`[data-step="${key}"]`);
  if (found === null) throw new Error(`no row for ${key}`);
  return found;
}

function rowStates(): Record<string, string | null> {
  const list = screen.getByRole('list', { name: 'Deploy steps' });
  const entries = within(list)
    .getAllByRole('listitem')
    .map((li): [string, string | null] => [li.getAttribute('data-step') ?? '', li.getAttribute('data-state')]);
  return Object.fromEntries(entries);
}

const banner = (name: string | RegExp) => screen.findByRole('region', { name });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('one page for a deploy (SHP-T-13.11)', () => {
  it('/deploys/:id/live redirects to /deploys/:id and keeps the id', async () => {
    routes({ status: status('succeeded', { endedAt: at(120) }), steps: [] });
    renderAt(`/deploys/${ID}/live`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Deploy foreman-board 3b7c9e1' })).toBeInTheDocument();
    expect(window.location.pathname).toBe(`/deploys/${ID}`);
  });

  it('soaking: the verdict counts the manifest soak from the soak step, every step is listed, and the running one is marked', async () => {
    routes({ status: status('soaking', { currentStep: 'soak' }), steps: SOAKING_STEPS });
    // Pinned 34 s into the soak: the numbers come from the soak step's start, not a client timer.
    renderView({ now: T0 + (54 + 34) * 1000 });
    const verdict = await banner('Soaking · 34s of 60s');
    expect(verdict).toHaveAttribute('data-tone', 'attention');
    expect(within(verdict).getByText('26s left · live after soak')).toBeInTheDocument();
    expect(within(verdict).getByText(/3b7c9e1 is serving traffic\. Shipyard watches for restarts and \/health for 60s/)).toBeInTheDocument();
    expect(within(verdict).getByRole('progressbar', { name: 'Soak, 34s of 60s' })).toHaveAttribute('value', '34');

    // Breadcrumb back to the app; title names the app and SHA.
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'foreman-board' })).toHaveAttribute('href', '/apps/foreman-board');
    expect(within(crumbs).getByText('Deploy 3b7c9e1')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 1, name: 'Deploy foreman-board 3b7c9e1' })).toBeInTheDocument();

    // Facts: what was live before, the requester and the manifest's soak.
    // The SHA itself is a link, so the chain spans elements: read the Release fact whole.
    expect(screen.getByText('Release').nextElementSibling).toHaveTextContent(/^fd13023 → 3b7c9e1$/);
    expect(screen.getByText('Matthew (console)')).toBeInTheDocument();
    expect(screen.getByText('Soak from manifest').nextElementSibling).toHaveTextContent('60s');

    // Every planned step, with its timer; the soak is the one running.
    expect(rowStates()).toEqual({ backup: 'done', migrate: 'done', pull: 'done', swap: 'done', check: 'done', soak: 'running' });
    expect(rowFor('backup')).toHaveTextContent('41s');
    expect(rowFor('backup')).toHaveTextContent('pg_dump → 88 MB');
    expect(rowFor('soak')).toHaveTextContent('34s of 60s');
    expect(rowFor('soak')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('list', { name: 'Deploy steps' }).querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(screen.getByText(/^5 of 6 done/)).toBeInTheDocument();

    // A next action on every state; no Retry anywhere.
    const next = screen.getByRole('group', { name: 'Next actions' });
    expect(within(next).getByRole('link', { name: 'Back to foreman-board' })).toHaveAttribute('href', '/apps/foreman-board');
    expect(screen.queryByText(/retry/i)).not.toBeInTheDocument();
    // Foreman: mapped, and it posts once the release goes live.
    expect(await screen.findByText('Will post to FRM when it goes live.')).toBeInTheDocument();
  });

  it('lists the steps not reached yet as waiting, the soak with its length', async () => {
    routes({ status: status('pulling', { currentStep: 'pull' }), steps: [step('verify', 0, 1), step('backup', 1, 4), step('pull', 5, null)] });
    renderView({ now: T0 + 9000 });
    await waitFor(() => {
      expect(rowStates()).toEqual({ backup: 'done', migrate: 'skipped', pull: 'running', swap: 'waiting', check: 'waiting', soak: 'waiting' });
    });
    await waitFor(() => {
      expect(rowFor('soak')).toHaveTextContent('60s');
    });
    expect(rowFor('pull')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('heading', { level: 2, name: 'Pulling' })).toBeInTheDocument();
  });

  it('scrolls the running step into view when it is off screen, once per step', async () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scroll });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      // Every step row sits below a 375 × 667 phone's fold.
      const below = this.matches('[data-step]');
      return { top: below ? 2000 : 0, bottom: below ? 2040 : 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
    });
    routes({ status: status('soaking'), steps: SOAKING_STEPS });
    renderView({ now: T0 + 60_000 });
    await waitFor(() => {
      expect(scroll).toHaveBeenCalledTimes(1);
    });
    expect(scroll).toHaveBeenCalledWith({ block: 'center' });
    expect(scroll.mock.contexts[0]).toBe(rowFor('soak'));
    // Later polls of the same step never scroll again: the person may have scrolled away.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3200));
    });
    expect(scroll).toHaveBeenCalledTimes(1);
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }, 10_000);

  it('rolled back: leads with what runs now and the cause; Roll back is a step; Deploy again, never Retry', async () => {
    const onDeployAgain = vi.fn();
    routes({
      status: status('rolled_back', {
        app: 'bindery',
        refusal: {
          code: 'health_failed',
          gate: 'none',
          message: 'Soak failed — worker restarted 3 times in 40s (exit 137 — out of memory).',
          fix: 'Read the worker log; the previous images are running again.',
        },
        endedAt: at(171),
      }),
      steps: [
        step('verify', 0, 1),
        step('backup', 1, 30),
        step('pull', 31, 5),
        step('swap', 36, 4),
        step('check', 40, 3),
        step('soak', 43, 40, { exitCode: 1, output: 'worker restarted\nworker exited 137' }),
        step('rollback', 83, 12, { output: 'Recreated with previous digests' }),
      ],
      run: { status: 200, body: { run: { url: 'https://github.com/o/r/actions/runs/412' }, jobs: [] } },
    });
    renderView({ canAct: true, onDeployAgain });
    const verdict = await banner('Rolled back · bindery is running fd13023 again');
    expect(verdict).toHaveAttribute('data-tone', 'danger');
    expect(within(verdict).getByText('Data unchanged.')).toBeInTheDocument();
    expect(within(verdict).getByText('Soak failed — worker restarted 3 times in 40s (exit 137 — out of memory).')).toBeInTheDocument();
    expect(within(verdict).getByText('Read the worker log; the previous images are running again.')).toBeInTheDocument();
    // The SHA itself is a link, so the chain spans elements: read the Release fact whole.
    expect(screen.getByText('Release').nextElementSibling).toHaveTextContent(/^fd13023 → 3b7c9e1 → fd13023$/);
    expect(screen.getByText('none · database never changed')).toBeInTheDocument();

    expect(rowFor('soak')).toHaveAttribute('data-state', 'failed');
    expect(rowFor('rollback')).toHaveAttribute('data-state', 'done');
    expect(rowFor('rollback')).toHaveTextContent('Roll back');
    expect(rowFor('rollback')).toHaveTextContent('12s');
    expect(screen.getByLabelText('Output of Soak')).toHaveTextContent('worker exited 137');

    const next = screen.getByRole('group', { name: 'Next actions' });
    expect(within(next).getByRole('link', { name: 'Back to bindery' })).toBeInTheDocument();
    expect(await within(next).findByRole('link', { name: 'Open CI run ↗' })).toHaveAttribute('href', 'https://github.com/o/r/actions/runs/412');
    expect(within(next).getByRole('button', { name: 'View container log' })).toBeInTheDocument();
    expect(screen.queryByText(/retry/i)).not.toBeInTheDocument();
    await userEvent.setup().click(within(next).getByRole('button', { name: 'Deploy again' }));
    expect(onDeployAgain).toHaveBeenCalledWith('bindery', SHA);
  });

  it('a viewer gets no Deploy again', async () => {
    routes({ status: status('rolled_back', { endedAt: at(60) }), steps: [step('swap', 0, 2), step('check', 2, 2, { exitCode: 1 }), step('rollback', 4, 2)] });
    renderView({ canAct: false, onDeployAgain: vi.fn() });
    const next = await screen.findByRole('group', { name: 'Next actions' });
    expect(within(next).queryByRole('button', { name: 'Deploy again' })).not.toBeInTheDocument();
    expect(within(next).getByRole('button', { name: 'View container log' })).toBeInTheDocument();
  });

  it('refused: the check by its human name with its code secondary, the fix, and nothing ran', async () => {
    routes({
      status: status('refused', {
        refusal: { code: 'not_on_default_branch', gate: 'G6', message: '3b7c9e1 is not on main.', fix: 'Merge it to main, then deploy the merge commit.' },
        gates: [
          { gate: 'G5', pass: true, reason: 'CI green' },
          { gate: 'G6', pass: false, reason: 'not on main' },
        ],
        endedAt: at(2),
      }),
      steps: [],
    });
    renderView();
    const verdict = await banner('Refused · On main G6');
    expect(within(verdict).getByText('G6')).toBeInTheDocument();
    expect(within(verdict).getByText('3b7c9e1 is not on main.')).toBeInTheDocument();
    expect(within(verdict).getByText('Merge it to main, then deploy the merge commit.')).toBeInTheDocument();
    expect(within(verdict).getByText(/^Nothing ran\./)).toBeInTheDocument();
    expect(Object.values(rowStates()).every((s) => s === 'skipped')).toBe(true);
    // The checks list: human names, codes beside them.
    const checks = screen.getByRole('region', { name: 'Checks' });
    expect(within(checks).getByText('CI passed')).toBeInTheDocument();
    expect(within(checks).getByText('Fail')).toBeInTheDocument();
  });

  it('succeeded: deployed and live, with digests, the CI run and the Foreman post', async () => {
    routes({
      status: status('succeeded', {
        images: [{ service: 'web', sha: SHA, digest: DIGEST, migration: 'expand' }],
        schemaRevision: '0007_add_invites',
        endedAt: at(150),
      }),
      steps: [...SOAKING_STEPS.slice(0, 6), step('soak', 54, 60)],
      foreman: {
        posts: [{ service: 'web', idempotencyKey: 't:web', delivered: true, attempts: 1, lastError: null, nextAt: at(200) }],
        stuck: false,
      },
      run: { status: 200, body: { run: { url: 'https://github.com/o/r/actions/runs/7' }, jobs: [] } },
    });
    renderView();
    const verdict = await banner('Deployed · 3b7c9e1 is live');
    expect(verdict).toHaveAttribute('data-tone', 'neutral');
    // The soak length is the manifest's, read from the app beside the stream.
    expect(await within(verdict).findByText(/The 60s soak passed/)).toBeInTheDocument();
    expect(screen.getByText(DIGEST)).toBeInTheDocument();
    expect(screen.getByText('0007_add_invites')).toBeInTheDocument();
    expect(screen.getByText('expand · migrate step ran')).toBeInTheDocument();
    expect(await screen.findByText(/Posted to FRM/)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Open CI run ↗' })).toHaveAttribute('href', 'https://github.com/o/r/actions/runs/7');
    expect(screen.queryByRole('button', { name: 'Deploy again' })).not.toBeInTheDocument();
  });

  it('a dry run says so: nothing was deployed', async () => {
    routes({ status: status('succeeded', { dryRun: true, endedAt: at(5) }), steps: [] });
    renderView();
    const verdict = await banner('Dry run passed');
    expect(within(verdict).getByText(/nothing was deployed/)).toBeInTheDocument();
    expect(screen.getByText('A dry run is never recorded in Foreman.')).toBeInTheDocument();
  });

  it('a group canary says who deploys these images next', async () => {
    routes({
      status: status('soaking', {
        group: {
          name: 'foreman',
          members: [
            { app: 'foreman-board', state: 'soaking', refusal: null, canary: true, position: 0, targetId: 't1' },
            { app: 'foreman', state: 'queued', refusal: null, canary: false, position: 1, targetId: 't2' },
          ],
        },
      }),
      steps: SOAKING_STEPS,
    });
    renderView({ now: T0 + 60_000 });
    expect(await screen.findByText('Canary of group foreman — foreman deploys these images next')).toBeInTheDocument();
    expect(screen.getByText('Next in group: foreman — Same images, deployed when this soak passes')).toBeInTheDocument();
  });

  it('streams, then becomes the record on the same page', async () => {
    class Source implements EventSourceLike {
      static last: Source | null = null;
      onopen: ((ev: Event) => unknown) | null = null;
      onerror: ((ev: Event) => unknown) | null = null;
      private readonly listeners = new Map<string, (ev: MessageEvent<string>) => void>();
      constructor() {
        Source.last = this;
      }
      addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void {
        this.listeners.set(type, listener);
      }
      close(): void {
        /* nothing to close */
      }
      emit(type: string, data: unknown): void {
        this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }));
      }
    }
    const done = [...SOAKING_STEPS.slice(0, 6), step('soak', 54, 60)];
    routes({ status: status('succeeded', { endedAt: at(120) }), steps: done });
    render(
      <MemoryRouter>
        <DeployView id={ID} options={{ eventSource: () => new Source() }} now={T0 + 70_000} />
      </MemoryRouter>,
    );
    const source = Source.last;
    if (source === null) throw new Error('no stream');
    act(() => {
      source.onopen?.(new Event('open'));
      source.emit('status', status('soaking'));
      source.emit('steps', { steps: SOAKING_STEPS });
    });
    const heading = screen.getByRole('heading', { level: 1, name: 'Deploy foreman-board 3b7c9e1' });
    expect(await banner('Soaking · 16s of 60s')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Live');
    act(() => {
      source.emit('status', status('succeeded', { endedAt: at(120) }));
    });
    expect(await banner('Deployed · 3b7c9e1 is live')).toBeInTheDocument();
    // The same page, not a navigation to another: the heading is the same element.
    expect(screen.getByRole('heading', { level: 1, name: 'Deploy foreman-board 3b7c9e1' })).toBe(heading);
    expect(screen.getByRole('status')).toHaveTextContent('Finished');
    await waitFor(() => {
      expect(rowFor('soak')).toHaveAttribute('data-state', 'done');
    });
    expect(screen.getByRole('list', { name: 'Deploy steps' }).querySelector('[aria-current="step"]')).toBeNull();
  });
});

describe('each kind runs its own steps, and the page says so (SHP-T-13.11 verifier gaps)', () => {
  it('/deploys/:id/live keeps the query and the hash when it redirects', async () => {
    routes({ status: status('succeeded', { endedAt: at(120) }), steps: [] });
    renderAt(`/deploys/${ID}/live?from=home#deploy-step-soak`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Deploy foreman-board 3b7c9e1' })).toBeInTheDocument();
    expect(window.location.pathname).toBe(`/deploys/${ID}`);
    expect(window.location.search).toBe('?from=home');
    expect(window.location.hash).toBe('#deploy-step-soak');
  });

  it("links the deployed SHA to its commit on GitHub when the app's repository is known", async () => {
    routes({ status: status('succeeded', { endedAt: at(120) }), steps: [] });
    renderView();
    expect(await screen.findByRole('link', { name: 'Commit 3b7c9e1 on GitHub' })).toHaveAttribute(
      'href',
      `https://github.com/matdemers1/foreman/commit/${SHA}`,
    );
  });

  it('a running restore: Restore right after Back up, no Migrate, its own verdict, and the data is changing', async () => {
    routes({
      status: status('migrating', { kind: 'restore', currentStep: 'restore' }),
      steps: [step('verify', 0, 1), step('backup', 1, 20, { output: 'safety dump written' }), step('restore', 21, null)],
    });
    renderView({ now: T0 + 30_000 });
    const verdict = await banner('Restoring · putting the data back');
    expect(within(verdict).getByText(/Putting foreman-board's data back from a backup, then running 3b7c9e1/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Migrating|Deployed/ })).not.toBeInTheDocument();
    expect(Object.keys(rowStates())).toEqual(['backup', 'restore', 'pull', 'swap', 'check', 'soak']);
    expect(rowStates()).toMatchObject({ backup: 'done', restore: 'running', pull: 'waiting' });
    expect(rowFor('restore')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('heading', { level: 1, name: 'Restore foreman-board' })).toBeInTheDocument();
    expect(screen.getByText('Data').nextElementSibling).toHaveTextContent('restoring now · the database is changing');
    // A restore is not a commit's road to live: no Push/CI lane.
    expect(screen.queryByRole('list', { name: 'Pipeline' })).not.toBeInTheDocument();
  });

  it('a succeeded restore says the data was restored and the database changed', async () => {
    routes({
      status: status('succeeded', { kind: 'restore', endedAt: at(200) }),
      steps: [
        step('verify', 0, 1),
        step('backup', 1, 20),
        step('restore', 21, 30),
        step('pull', 51, 5),
        step('swap', 56, 4),
        step('check', 60, 3),
        step('soak', 63, 60),
      ],
    });
    renderView();
    const verdict = await banner('Restored · foreman-board is running 3b7c9e1 on the restored data');
    expect(within(verdict).getByText(/writes made after it was taken are gone/)).toBeInTheDocument();
    expect(screen.queryByText(/Deployed/)).not.toBeInTheDocument();
    expect(screen.getByText('Data').nextElementSibling).toHaveTextContent('restored from a backup · the database changed');
    expect(screen.queryByText(/database never changed/)).not.toBeInTheDocument();
    expect(Object.keys(rowStates())).toEqual(['backup', 'restore', 'pull', 'swap', 'check', 'soak']);
  });

  it('a failed restore after the restore command ran says the data may have changed, with no Deploy again', async () => {
    routes({
      status: status('failed', {
        kind: 'restore',
        refusal: { code: 'step_failed', gate: 'none', message: 'compose up exited 1.', fix: 'Read the step output.' },
        endedAt: at(90),
      }),
      steps: [step('backup', 1, 20), step('restore', 21, 30), step('pull', 51, 5), step('swap', 56, 4, { exitCode: 1, output: 'up failed' })],
    });
    renderView({ canAct: true, onDeployAgain: vi.fn() });
    const verdict = await banner('Restore failed at Swap · exit 1');
    expect(within(verdict).getByText(/the data may have changed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deploy again' })).not.toBeInTheDocument();
  });

  it('a rolled-back deploy that migrated never claims Data unchanged', async () => {
    routes({
      status: status('rolled_back', { endedAt: at(90) }),
      steps: [step('backup', 1, 5), step('migrate', 6, 4), step('pull', 10, 2), step('swap', 12, 2), step('check', 14, 2, { exitCode: 1 })],
    });
    renderView();
    const verdict = await banner(/^Rolled back/);
    expect(within(verdict).queryByText('Data unchanged.')).not.toBeInTheDocument();
    expect(within(verdict).getByText(/The migration that ran stays in the database/)).toBeInTheDocument();
    // No journaled rollback step, but the deploy did roll back: the row says so, never Skipped.
    expect(rowFor('rollback')).toHaveAttribute('data-state', 'done');
  });

  it('a rollback runs images only: Pull, Swap, Check, Soak, and says it is live', async () => {
    routes({
      status: status('succeeded', { kind: 'rollback', endedAt: at(100) }),
      steps: [step('verify', 0, 1), step('pull', 1, 5), step('swap', 6, 4), step('check', 10, 3), step('soak', 13, 60)],
    });
    renderView();
    const verdict = await banner('Rolled back to 3b7c9e1 · it is live');
    expect(within(verdict).getByText(/swaps the images only; the data is not touched/)).toBeInTheDocument();
    expect(rowStates()).toEqual({ pull: 'done', swap: 'done', check: 'done', soak: 'done' });
    expect(screen.getByRole('heading', { level: 1, name: 'Roll back foreman-board to 3b7c9e1' })).toBeInTheDocument();
  });

  it("clamps a soak that outlives the manifest's soak, in the banner and the row", async () => {
    routes({ status: status('soaking'), steps: SOAKING_STEPS });
    // The soak step started at 54 s; 100 s later it is still open against a 60 s soak.
    renderView({ now: T0 + (54 + 100) * 1000 });
    expect(await banner('Soaking · 60s of 60s')).toBeInTheDocument();
    expect(rowFor('soak')).toHaveTextContent('60s of 60s');
    expect(rowFor('soak')).not.toHaveTextContent('100s');
  });
});

describe('a held approval (SHP-REQ-105, SHP-D-072)', () => {
  const held = status('awaiting_approval', { requester: { label: 'claude: matdemers1/foreman board', repo: 'matdemers1/foreman', branch: 'main' } });

  it('offers Approve and Deny to a deployer, and approving POSTs /approve', async () => {
    const calls = routes({
      status: held,
      steps: [],
      extra: { [`POST /api/deploys/${ID}/approve`]: { status: 200, body: { deployId: ID, state: 'locked' } } },
    });
    const user = userEvent.setup();
    renderAt(`/deploys/${ID}`);
    const verdict = await banner('Waiting for approval');
    expect(within(verdict).getByText(/claude: matdemers1\/foreman board asked to deploy 3b7c9e1/)).toBeInTheDocument();
    await user.click(within(verdict).getByRole('button', { name: 'Approve and deploy 3b7c9e1' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path === `/api/deploys/${ID}/approve`)).toBe(true);
    });
    expect(await within(verdict).findByText('Approved. It starts when the agent picks it up.')).toBeInTheDocument();
  });

  it('denying asks first, then POSTs /deny', async () => {
    const calls = routes({
      status: held,
      steps: [],
      extra: { [`POST /api/deploys/${ID}/deny`]: { status: 200, body: { deployId: ID, state: 'cancelled' } } },
    });
    const user = userEvent.setup();
    renderAt(`/deploys/${ID}`);
    const verdict = await banner('Waiting for approval');
    await user.click(within(verdict).getByRole('button', { name: 'Deny' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deny foreman-board at 3b7c9e1' });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Deny' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path === `/api/deploys/${ID}/deny`)).toBe(true);
    });
  });

  it('shows a refused approval with its message and fix', async () => {
    routes({
      status: held,
      steps: [],
      extra: {
        [`POST /api/deploys/${ID}/approve`]: {
          status: 409,
          body: { error: { code: 'conflict', gate: 'none', message: 'This deploy is no longer waiting.', fix: 'Reload the page.' } },
        },
      },
    });
    const user = userEvent.setup();
    renderAt(`/deploys/${ID}`);
    const verdict = await banner('Waiting for approval');
    await user.click(within(verdict).getByRole('button', { name: 'Approve and deploy 3b7c9e1' }));
    expect(await screen.findByText('This deploy is no longer waiting.')).toBeInTheDocument();
    expect(screen.getByText('Reload the page.')).toBeInTheDocument();
  });

  it('hides both from a viewer and says who can', async () => {
    routes({ status: held, steps: [], role: 'viewer' });
    renderAt(`/deploys/${ID}`);
    const verdict = await banner('Waiting for approval');
    expect(within(verdict).queryByRole('button')).not.toBeInTheDocument();
    expect(within(verdict).getByText('Only a deployer or an admin can approve or deny it.')).toBeInTheDocument();
  });
});

describe('the record keeps what the old record had (S6)', () => {
  it('renders checks, images and a finished step', async () => {
    routes({
      status: status('failed', {
        images: [{ service: 'web', sha: SHA, digest: 'sha256:deadbeef', migration: null }],
        gates: [
          { gate: 'G5', pass: true, reason: 'CI green' },
          { gate: 'G7', pass: false, reason: 'not ahead of live' },
        ],
        endedAt: at(60),
      }),
      steps: [step('pull', 0, 2, { argv: ['docker', 'pull', 'x'], output: 'ok' })],
      foreman: { posts: [], stuck: false },
    });
    renderAt(`/deploys/${ID}`);
    expect(await screen.findByRole('heading', { level: 1, name: /foreman-board/ })).toBeInTheDocument();
    const checks = screen.getByRole('region', { name: 'Checks' });
    expect(within(checks).getByText('G5')).toBeInTheDocument();
    expect(within(checks).getByText('Pass')).toBeInTheDocument();
    expect(within(checks).getByText('G7')).toBeInTheDocument();
    expect(within(checks).getByText('Fail')).toBeInTheDocument();
    expect(screen.getByText('sha256:deadbeef')).toBeInTheDocument();
    expect(rowFor('pull')).toHaveTextContent('ok');
  });

  it('says when an app has no Foreman mapping', async () => {
    routes({
      status: status('succeeded', { endedAt: at(60) }),
      steps: [],
      extra: { 'GET /api/apps/foreman-board': appDetail('foreman-board', { manifest: {} }) },
    });
    renderAt(`/deploys/${ID}`);
    expect(await screen.findByText('No Foreman mapping')).toBeInTheDocument();
  });

  it('shows the outbox-failing badge when a Foreman post is stuck', async () => {
    routes({
      status: status('succeeded', { endedAt: at(60) }),
      steps: [],
      foreman: {
        posts: [{ service: 'web', idempotencyKey: 'd-1:web', delivered: false, attempts: 3, lastError: 'HTTP 503', nextAt: at(7200) }],
        stuck: true,
      },
    });
    renderAt(`/deploys/${ID}`);
    expect(await screen.findByText('Outbox failing')).toBeInTheDocument();
    expect(screen.getByText('A post has been unsent for over an hour.')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText(/HTTP 503/)).toBeInTheDocument();
  });

  it('shows a loading state while the deploy is read', () => {
    mockFetch({ 'GET /api/auth/me': meReply('viewer') });
    renderView();
    expect(screen.getByRole('status')).toHaveTextContent('Loading this deploy');
  });
});

describe('deploy page helpers', () => {
  it('counts the soak from the soak step and the manifest soak, never past it', () => {
    const steps = [step('soak', 10, null)];
    expect(soakClock(steps, 60, T0 + 44_000)).toEqual({ elapsed: 34, total: 60, left: 26 });
    expect(soakClock(steps, 60, T0 + 500_000)).toEqual({ elapsed: 60, total: 60, left: 0 });
    expect(soakClock(steps, null, T0)).toBeNull();
    expect(soakClock([], 60, T0)).toBeNull();
  });

  it('finds what was live before from the history, not a later or dry-run release', () => {
    const s = status('soaking');
    const t = (sha: string, created: number, extra: Record<string, unknown> = {}) => ({
      id: sha,
      deployId: sha,
      kind: 'deploy',
      sha,
      dryRun: false,
      requester: 'x',
      state: 'succeeded',
      currentStep: null,
      createdAt: at(created),
      startedAt: null,
      endedAt: null,
      ...extra,
    });
    expect(liveBefore(s, [t('later', 10), t('dry', -5, { dryRun: true }), t('prev', -10)], null, true)).toBe('prev');
    expect(liveBefore(s, [], 'live', true)).toBe('live');
    expect(liveBefore(s, [], 'live', false)).toBeNull();
  });

  it('reads the Foreman project from the manifest and the last line of output', () => {
    expect(foremanProjectOf({ foreman: { project: 'BND' } })).toBe('BND');
    expect(foremanProjectOf('{"foreman":{"project":"FRM"}}')).toBe('FRM');
    expect(foremanProjectOf('app: x')).toBeNull();
    expect(foremanProjectOf(null)).toBeNull();
    expect(lastLine('one\ntwo\n\n')).toBe('two');
    expect(lastLine(null)).toBeNull();
  });
});
