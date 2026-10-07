import { DeployTargetState as DeployTargetStateSchema } from '@shipyard/schema';
import { describe, expect, it } from 'vitest';
import { appStatus, ciTone, stateTone, type StatusInput, type StatusKind } from '../src/lib/appstatus';
import { buildStateTone } from '../src/lib/builds';
import type { CommitEntry, CommitsInfo } from '../src/lib/home';
import { memberTone } from '../src/lib/rollouts';
import { outcomeTone, type DeployTargetState } from '../src/lib/timeline';

/**
 * SHP-T-13.2: every status maps onto the four tones @d3cloud/ui 1.5's Badge takes, and a state that
 * is running or active is never `neutral`: neutral means quietly fine, and its fill is the card's own
 * raised surface, so an active deploy painted neutral reads as nothing happening.
 */

const LIBRARY_TONES = ['neutral', 'attention', 'warning', 'danger'];

// From the schema's own enum, so a state added there is covered here without anyone remembering to.
const DEPLOY_STATES: readonly DeployTargetState[] = DeployTargetStateSchema.options;
const IN_FLIGHT = DEPLOY_STATES.filter((s) => !['queued', 'succeeded', 'failed', 'rolled_back', 'refused', 'cancelled'].includes(s));
const BUILD_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'refused'] as const;
const CI_STATES: CommitEntry['ci'][] = ['success', 'failure', 'pending', 'none'];

const sha = (c: string): string => c.repeat(40);
const LIVE = sha('0');
const entry = (c: string, ci: CommitEntry['ci']): CommitEntry => ({ sha: sha(c), message: c, ci, taskIds: [] });
function commitsInfo(entries: CommitEntry[], extra: Partial<CommitsInfo> = {}): CommitsInfo {
  let newestGreen: string | null = null;
  for (const e of entries) if (e.ci === 'success') newestGreen = e.sha;
  return { live: LIVE, head: entries.at(-1)?.sha ?? LIVE, commits: entries, newestGreen, source: 'github', ...extra };
}
function input(overrides: Partial<StatusInput> = {}): StatusInput {
  return { repo: 'matdemers1/web', liveSha: LIVE, defaultBranch: 'main', commits: commitsInfo([]), drift: null, active: null, approval: undefined, ...overrides };
}

/** One input per StatusKind, so a kind added later without a case here fails the count below. */
function statusesByKind(): Record<StatusKind, StatusInput> {
  return {
    deploying: input({ active: { holder: 'Ada', state: 'soaking', currentStep: null } }),
    approval: input({ approval: { sha: sha('a'), requester: { label: 'Bo' } } }),
    drift: input({ drift: { reason: 'x' } }),
    frozen: input({ frozen: true }),
    ready: input({ commits: commitsInfo([entry('a', 'success')], { ahead: 1 }) }),
    'ci-running': input({ commits: commitsInfo([entry('a', 'pending')], { ahead: 1 }) }),
    'ci-failed': input({ commits: commitsInfo([entry('a', 'failure')], { ahead: 1 }) }),
    'no-images': input({ commits: commitsInfo([entry('a', 'none')], { ahead: 1 }) }),
    'up-to-date': input(),
    'never-deployed': input({ liveSha: null }),
    'github-unavailable': input({ commits: null }),
    'no-repo': input({ repo: null }),
  };
}

describe('tones (SHP-T-13.2)', () => {
  it('maps every app status onto the four library tones', () => {
    const byKind = statusesByKind();
    const tones: Record<string, string> = {};
    for (const [kind, i] of Object.entries(byKind)) {
      const status = appStatus(i);
      expect(status.kind).toBe(kind);
      expect(LIBRARY_TONES).toContain(status.tone);
      tones[kind] = status.tone;
    }
    expect(tones).toEqual({
      deploying: 'attention',
      approval: 'warning',
      ready: 'attention',
      drift: 'warning',
      'ci-failed': 'danger',
      frozen: 'neutral',
      'github-unavailable': 'warning',
      'ci-running': 'neutral',
      'no-images': 'neutral',
      'never-deployed': 'neutral',
      'no-repo': 'neutral',
      'up-to-date': 'neutral',
    });
  });

  it('keeps every deploy-state helper inside the four tones', () => {
    for (const state of DEPLOY_STATES) {
      expect(LIBRARY_TONES, `stateTone(${state})`).toContain(stateTone(state));
      expect(LIBRARY_TONES, `outcomeTone(${state})`).toContain(outcomeTone(state));
      expect(LIBRARY_TONES, `memberTone(${state})`).toContain(memberTone({ state }));
    }
    expect(LIBRARY_TONES).toContain(stateTone('a_state_a_newer_server_adds'));
  });

  it('keeps build and CI helpers inside the four tones', () => {
    for (const state of BUILD_STATES) expect(LIBRARY_TONES, `buildStateTone(${state})`).toContain(buildStateTone(state));
    for (const ci of CI_STATES) expect(LIBRARY_TONES, `ciTone(${ci})`).toContain(ciTone(ci));
  });

  it('never renders a running or active state as neutral', () => {
    for (const state of IN_FLIGHT) {
      expect(stateTone(state), state).toBe('attention');
      expect(outcomeTone(state), state).toBe('attention');
      expect(memberTone({ state }), state).toBe('attention');
    }
    expect(memberTone({ state: 'queued' })).toBe('attention');
    expect(buildStateTone('running')).toBe('attention');
  });

  it('tones failures danger, cancellations warning and quiet endings neutral, in every helper', () => {
    for (const state of ['failed', 'rolled_back', 'refused'] as const) {
      expect(stateTone(state)).toBe('danger');
      expect(outcomeTone(state)).toBe('danger');
      expect(memberTone({ state })).toBe('danger');
    }
    expect(stateTone('cancelled')).toBe('warning');
    expect(outcomeTone('cancelled')).toBe('warning');
    expect(memberTone({ state: 'cancelled' })).toBe('warning');
    expect(buildStateTone('cancelled')).toBe('warning');
    expect(stateTone('succeeded')).toBe('neutral');
    expect(outcomeTone('succeeded')).toBe('neutral');
    expect(buildStateTone('succeeded')).toBe('neutral');
    expect(buildStateTone('failed')).toBe('danger');
    expect(buildStateTone('refused')).toBe('danger');
    expect(stateTone('awaiting_approval')).toBe('attention');
  });

  it('tones CI: failure danger, success attention, pending and none neutral', () => {
    expect(CI_STATES.map((ci) => ciTone(ci))).toEqual(['attention', 'danger', 'neutral', 'neutral']);
  });
});
