import { render, screen, within } from '@testing-library/react';
import type { DeployStatus } from '@shipyard/schema';
import { describe, expect, it } from 'vitest';
import {
  PipeLane,
  PipeMini,
  PipeNode,
  StepList,
  commitStages,
  deployStages,
  deploySteps,
  stagesSummary,
  type CommitStagesInput,
  type Stage,
  type StageState,
} from '../src/components/pipeline';
import type { CommitEntry, CommitRun } from '../src/lib/home';
import type { DeployStep } from '../src/lib/progress';

/** SHP-T-13.7: one stage model, drawn three ways (SHP-REQ-156, SHP-REQ-158, SHP-REQ-167). */

const SHA = 'f8b48f2'.padEnd(40, '0');
const LIVE = '1a2b3c4'.padEnd(40, '0');
const NOW = Date.parse('2026-10-06T12:00:00.000Z');
const RUN_URL = 'https://github.com/matdemers1/web/actions/runs/412';

function run(extra: Partial<CommitRun> = {}): CommitRun {
  return {
    id: 412,
    url: RUN_URL,
    startedAt: '2026-10-06T11:45:52.000Z',
    completedAt: '2026-10-06T12:00:00.000Z',
    conclusion: 'success',
    ...extra,
  };
}

function commit(ci: CommitEntry['ci'], runValue: CommitRun | null = run()): CommitEntry {
  return { sha: SHA, message: 'fix it', ci, taskIds: [], run: runValue };
}

function lane(over: Partial<CommitStagesInput> & Pick<CommitStagesInput, 'commit'>): Stage[] {
  return commitStages({ liveSha: LIVE, buildSource: 'github', now: NOW, branch: 'main', ...over });
}

function byKey(stages: Stage[]): Record<Stage['key'], Stage> {
  return Object.fromEntries(stages.map((s) => [s.key, s])) as Record<Stage['key'], Stage>;
}

describe('PipeNode: every state, in text as well as colour', () => {
  const states: [StageState, string][] = [
    ['done', 'Done'],
    ['running', 'Running'],
    ['waiting', 'Waiting'],
    ['failed', 'Failed'],
    ['held', 'Blocked'],
    ['skipped', 'Skipped'],
  ];

  it.each(states)('%s names itself %s and its icon is decoration', (state, word) => {
    const { container } = render(<PipeNode state={state} />);
    expect(screen.getByTitle(word)).toHaveAttribute('data-state', state);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it.each(states)('%s reads in a lane as "<stage>, <state>" with the value beside it', (state, word) => {
    const stages: Stage[] = [{ key: 'images', label: 'Images', state, detail: `value for ${state}` }];
    render(<PipeLane stages={stages} />);
    const item = screen.getByRole('listitem');
    expect(item).toHaveAttribute('data-state', state);
    expect(item).toHaveTextContent(`Images, ${word.toLowerCase()}`);
    expect(within(item).getByText(`value for ${state}`)).toBeInTheDocument();
  });
});

describe('commitStages', () => {
  it('lists the six stages in order', () => {
    expect(lane({ commit: commit('success') }).map((s) => s.label)).toEqual(['Push', 'CI', 'Images', 'Checks', 'Deploy', 'Live']);
  });

  it('green CI: CI done with a link to the run, and Images only Expected (SHP-REQ-158, SHP-REQ-167)', () => {
    const s = byKey(lane({ commit: commit('success'), pushedAt: '2026-10-06T11:00:00.000Z', author: 'matdemers1' }));
    expect(s.push).toMatchObject({ state: 'done', detail: '1h ago · main', note: 'by matdemers1' });
    expect(s.ci).toMatchObject({ state: 'done', detail: '#412 · 14m 08s', href: RUN_URL, linkLabel: 'Open run #412' });
    expect(s.images).toMatchObject({ state: 'waiting', detail: 'Expected', note: 'Expected from green CI; verified on deploy' });
    expect(s.checks).toMatchObject({ state: 'waiting', detail: 'Run when you deploy' });
    expect(s.deploy).toMatchObject({ state: 'waiting', detail: 'Not started' });
    expect(s.deploy.note).toContain('Back up → Migrate → Pull → Swap → Check → Soak');
    expect(s.live).toMatchObject({ state: 'waiting', detail: '1a2b3c4 is live' });
    expect(JSON.stringify(s.images)).not.toMatch(/built/i);
  });

  it('verified digests: Images reads Verified', () => {
    const s = byKey(lane({ commit: commit('success'), verifiedDigests: true }));
    expect(s.images).toMatchObject({ state: 'done', detail: 'Verified', note: 'Digests verified' });
  });

  it('CI pending: CI running with its timer and run, everything after it waiting', () => {
    const s = byKey(lane({ commit: commit('pending', run({ completedAt: null, conclusion: null, startedAt: '2026-10-06T11:58:00.000Z' })) }));
    expect(s.ci).toMatchObject({ state: 'running', detail: 'CI running · 2m 00s · #412', href: RUN_URL });
    for (const key of ['images', 'checks', 'deploy', 'live'] as const) expect(s[key].state).toBe('waiting');
  });

  it('CI failure: Images skipped as Not built, Checks and Deploy held, and nothing downstream Waiting', () => {
    const s = byKey(lane({ commit: commit('failure', run({ conclusion: 'failure' })), failedJob: 'unit' }));
    expect(s.ci).toMatchObject({ state: 'failed', detail: 'Failed at unit', note: 'unit · run #412 · 14m 08s', href: RUN_URL });
    expect(s.images).toMatchObject({ state: 'skipped', detail: 'Not built', note: 'Nothing was pushed to GHCR' });
    expect(s.checks).toMatchObject({ state: 'held', detail: 'Blocked by CI', note: 'Would refuse: CI passed (G5)' });
    expect(s.deploy).toMatchObject({ state: 'held', detail: 'Blocked' });
    expect(s.live.state).toBe('held');
    expect(lane({ commit: commit('failure') }).map((x) => x.state)).not.toContain('waiting');
  });

  it('failed CI without a known job still says Failed', () => {
    expect(byKey(lane({ commit: commit('failure') })).ci.detail).toBe('Failed');
  });

  it('a build: shipyard app has a CI stage with no GitHub link, even if a run slipped through', () => {
    const s = byKey(lane({ commit: commit('success', run()), buildSource: 'shipyard' }));
    expect(s.ci).toMatchObject({ state: 'done', detail: 'Shipyard build passed' });
    expect(s.ci.href).toBeUndefined();
    expect(s.images).toMatchObject({ detail: 'Expected', note: 'Expected from the Shipyard build; verified on deploy' });
  });

  it('a github app with no run: CI waiting, no link', () => {
    const s = byKey(lane({ commit: commit('none', null) }));
    expect(s.ci).toMatchObject({ state: 'waiting', detail: 'No run yet' });
    expect(s.ci.href).toBeUndefined();
  });

  it('a run with no URL links nowhere', () => {
    expect(byKey(lane({ commit: commit('success', run({ url: null })) })).ci.href).toBeUndefined();
  });

  it('an older server with no run field still gives a lane', () => {
    const c: CommitEntry = { sha: SHA, message: 'm', ci: 'success', taskIds: [] };
    const s = byKey(lane({ commit: c }));
    expect(s.ci).toMatchObject({ state: 'done', detail: 'Passed' });
    expect(s.push.detail).toBe('main');
  });

  it('the live commit is done end to end', () => {
    const s = lane({ commit: commit('success'), liveSha: SHA });
    expect(s.map((x) => x.state)).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
    expect(s[5]?.detail).toBe('f8b48f2 is live');
  });

  it('a deploy soaking: checks and images done, Deploy running with the soak timer, Live waiting', () => {
    const s = byKey(
      lane({ commit: commit('success'), deploy: { state: 'soaking', startedAt: '2026-10-06T11:59:26.000Z', soakSeconds: 60 } }),
    );
    expect(s.images).toMatchObject({ state: 'done', detail: 'Verified' });
    expect(s.checks.state).toBe('done');
    expect(s.deploy).toMatchObject({ state: 'running', detail: 'Soaking 34s', note: 'Soak is 60s' });
    expect(s.live).toMatchObject({ state: 'waiting', detail: '1a2b3c4 is live' });
  });

  it('a refused deploy fails Checks and holds Deploy and Live', () => {
    const s = byKey(lane({ commit: commit('success'), deploy: { state: 'refused', reason: 'Frozen until Friday' } }));
    expect(s.checks).toMatchObject({ state: 'failed', detail: 'Refused', note: 'Frozen until Friday' });
    expect(s.deploy.state).toBe('held');
    expect(s.live.state).toBe('held');
    expect(s.images.detail).toBe('Expected');
  });

  it('a rolled-back deploy shows Deploy failed and Live held', () => {
    const s = byKey(lane({ commit: commit('success'), deploy: { state: 'rolled_back' } }));
    expect(s.deploy).toMatchObject({ state: 'failed', detail: 'Rolled back' });
    expect(s.live.state).toBe('held');
  });

  it('a succeeded deploy of this commit is live', () => {
    const s = byKey(lane({ commit: commit('success'), deploy: { state: 'succeeded' } }));
    expect(s.deploy.state).toBe('done');
    expect(s.live).toMatchObject({ state: 'done', detail: 'f8b48f2 is live' });
  });

  it('awaiting approval keeps Deploy waiting and says why at Checks', () => {
    const s = byKey(lane({ commit: commit('success'), deploy: { state: 'awaiting_approval' } }));
    expect(s.checks).toMatchObject({ state: 'waiting', detail: 'Waiting for approval' });
    expect(s.deploy.state).toBe('waiting');
  });
});

describe('PipeMini', () => {
  it('names all six stages and their states in one accessible name', () => {
    const stages = lane({ commit: commit('pending', run({ completedAt: null })) });
    render(<PipeMini stages={stages} />);
    expect(screen.getByRole('img', { name: 'Pipeline: Push done, CI running, Images waiting, Checks waiting, Deploy waiting, Live waiting' })).toBeInTheDocument();
    expect(stagesSummary(stages)).toMatch(/^Pipeline: Push done, CI running/);
  });

  it('shows six nodes, each in its state', () => {
    const { container } = render(<PipeMini stages={lane({ commit: commit('failure') })} />);
    const nodes = [...container.querySelectorAll('.shp-pipe-node')].map((n) => n.getAttribute('data-state'));
    expect(nodes).toEqual(['done', 'failed', 'skipped', 'held', 'held', 'held']);
  });
});

describe('PipeLane', () => {
  it('links CI to the run in a new tab, with an arrow', () => {
    render(<PipeLane stages={lane({ commit: commit('success') })} />);
    const link = screen.getByRole('link', { name: /Open run #412/ });
    expect(link).toHaveAttribute('href', RUN_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    expect(link).toHaveTextContent('Open run #412 ↗');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('draws Images as Expected until verified, then Verified', () => {
    const { rerender } = render(<PipeLane stages={lane({ commit: commit('success') })} />);
    const images = (): HTMLElement => screen.getAllByRole('listitem')[2] as HTMLElement;
    expect(images()).toHaveTextContent('Expected');
    expect(images()).toHaveTextContent('Expected from green CI; verified on deploy');
    rerender(<PipeLane stages={lane({ commit: commit('success'), verifiedDigests: true })} />);
    expect(images()).toHaveTextContent('Verified');
  });

  it('shows no link for a shipyard-built app', () => {
    render(<PipeLane stages={lane({ commit: commit('success', null), buildSource: 'shipyard' })} />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});

// ── The deploy page ─────────────────────────────────────────────────────

const ID = '11111111-2222-4333-8444-555555555555';

function status(state: DeployStatus['state'], extra: Partial<DeployStatus> = {}): DeployStatus {
  return {
    deployId: ID,
    kind: 'deploy',
    app: 'web',
    sha: SHA,
    dryRun: false,
    state,
    currentStep: null,
    requester: { label: 'matt (console)', repo: null, branch: 'main' },
    images: [],
    schemaRevision: null,
    refusal: null,
    gates: [],
    createdAt: '2026-10-06T11:58:00.000Z',
    endedAt: null,
    ...extra,
  };
}

function step(name: string, start: string, end: string | null, exitCode: number | null = end === null ? null : 0): DeployStep {
  return { name, argv: [], startedAt: `2026-10-06T${start}.000Z`, endedAt: end === null ? null : `2026-10-06T${end}.000Z`, exitCode, output: null };
}

const DIGEST = `sha256:${'d'.repeat(64)}`;

describe('deployStages', () => {
  it('a soaking deploy: verified images, passed checks, Deploy running its soak, Live waiting', () => {
    const steps = [step('pull', '11:58:10', '11:58:30'), step('swap', '11:58:30', '11:58:40'), step('check', '11:58:40', '11:59:00'), step('soak', '11:59:26', null)];
    const s = byKey(
      deployStages(
        status('soaking', {
          images: [{ service: 'web', sha: SHA, digest: DIGEST }],
          gates: [
            { gate: 'G5', pass: true, reason: 'CI passed' },
            { gate: 'G8', pass: true, reason: 'digests found' },
          ],
        }),
        steps,
        { now: NOW, soakSeconds: 60 },
      ),
    );
    expect(s.push).toMatchObject({ state: 'done', detail: 'f8b48f2 · main', note: 'requested by matt (console)' });
    expect(s.ci).toMatchObject({ state: 'done', note: 'CI passed' });
    expect(s.images).toMatchObject({ state: 'done', detail: 'Verified', note: '1 image, digests verified' });
    expect(s.checks).toMatchObject({ state: 'done', detail: '2 passed' });
    expect(s.deploy).toMatchObject({ state: 'running', detail: 'Soaking 34s' });
    expect(s.live.state).toBe('waiting');
  });

  it('a refusal at G5 fails CI, skips Images and holds the rest', () => {
    const s = byKey(
      deployStages(
        status('refused', { refusal: { code: 'build_not_green', gate: 'G5', message: 'CI is red', fix: 'Fix CI' } }),
        [],
        { now: NOW },
      ),
    );
    expect(s.ci).toMatchObject({ state: 'failed', note: 'CI is red' });
    expect(s.images.state).toBe('skipped');
    expect(s.checks).toMatchObject({ state: 'held', detail: 'Blocked by CI' });
    expect(s.deploy.state).toBe('held');
    expect(s.live.state).toBe('held');
  });

  it('a failed gate fails Checks and holds Deploy', () => {
    const s = byKey(deployStages(status('refused', { gates: [{ gate: 'G2', pass: false, reason: 'frozen' }] }), [], { now: NOW }));
    expect(s.checks).toMatchObject({ state: 'failed', detail: 'G2 failed', note: 'frozen' });
    expect(s.deploy.state).toBe('held');
  });

  it('a rolled-back deploy fails Deploy and holds Live', () => {
    const s = byKey(deployStages(status('rolled_back'), [], { now: NOW }));
    expect(s.deploy).toMatchObject({ state: 'failed', detail: 'Rolled back' });
    expect(s.live.state).toBe('held');
  });

  it('a dry run skips Deploy and Live: nothing was deployed', () => {
    const s = byKey(deployStages(status('succeeded', { dryRun: true, images: [{ service: 'web', sha: SHA, digest: DIGEST }] }), [], { now: NOW }));
    expect(s.images.state).toBe('done');
    expect(s.deploy).toMatchObject({ state: 'skipped', detail: 'Dry run' });
    expect(s.live.state).toBe('skipped');
  });
});

describe('deploySteps and StepList', () => {
  const soaking = [
    step('backup', '11:58:00', '11:58:12'),
    step('migrate', '11:58:12', '11:58:20'),
    step('pull', '11:58:20', '11:58:40'),
    step('swap', '11:58:40', '11:58:50'),
    step('check', '11:58:50', '11:59:10'),
    step('soak', '11:59:26', null),
  ];

  it('a soaking deploy has earlier steps done and Soak running with its timer', () => {
    render(<StepList steps={soaking} state="soaking" soakSeconds={60} now={NOW} />);
    const row = (name: string): HTMLElement => screen.getByText(name).closest('li') as HTMLElement;
    expect(row('Back up')).toHaveAttribute('data-state', 'done');
    expect(row('Back up')).toHaveTextContent('Back up Done 12s');
    expect(row('Pull')).toHaveTextContent('Pull Done 20s');
    expect(row('Soak')).toHaveAttribute('data-state', 'running');
    expect(row('Soak')).toHaveTextContent('Soak Running 34s of 60s');
    expect(screen.queryByText('Roll back')).toBeNull();
  });

  it('steps not started yet are listed up front as waiting', () => {
    render(<StepList steps={[step('backup', '11:58:00', null)]} state="backing_up" soakSeconds={60} now={NOW} />);
    const items = within(screen.getByRole('list', { name: 'Deploy steps' })).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-state'))).toEqual(['running', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting']);
    expect(items[0]).toHaveTextContent('Back up Running 2m 00s');
    expect(items[5]).toHaveTextContent('Soak Waiting 60s');
  });

  it('a rolled-back deploy shows the failed step and Roll back done', () => {
    const steps = [
      step('backup', '11:58:00', '11:58:10'),
      step('pull', '11:58:10', '11:58:30'),
      step('swap', '11:58:30', '11:58:40'),
      step('check', '11:58:40', '11:58:50', 1),
      step('rollback', '11:58:50', '11:59:05'),
    ];
    const rows = deploySteps(steps, 'rolled_back', { now: NOW });
    const state = (key: string): string | undefined => rows.find((r) => r.key === key)?.state;
    expect(state('check')).toBe('failed');
    expect(rows.find((r) => r.key === 'check')?.detail).toBe('exit 1 · 10s');
    expect(state('rollback')).toBe('done');
    expect(state('soak')).toBe('skipped');
    // This app has no migrations: a planned step a later one passed is skipped, not waiting.
    expect(state('migrate')).toBe('skipped');
    render(<StepList steps={steps} state="rolled_back" now={NOW} />);
    expect(screen.getByText('Roll back').closest('li')).toHaveTextContent('Roll back Done 15s');
    expect(screen.getByText('Check').closest('li')).toHaveTextContent('Check Failed exit 1 · 10s');
  });

  it('a refused deploy ran nothing: every step skipped, never waiting', () => {
    expect(deploySteps([], 'refused').map((r) => r.state)).toEqual(Array<string>(6).fill('skipped'));
  });

  it('leaves the verify step to the Checks stage and lists an unknown step by name', () => {
    const rows = deploySteps([step('verify', '11:58:00', '11:58:02'), step('recover', '11:58:02', '11:58:05')], 'succeeded');
    expect(rows.map((r) => r.key)).toEqual(['backup', 'migrate', 'pull', 'swap', 'check', 'soak', 'recover']);
    expect(rows.at(-1)).toMatchObject({ label: 'Recover', state: 'done' });
  });
});
