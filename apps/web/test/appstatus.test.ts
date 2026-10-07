import { describe, expect, it } from 'vitest';
import { appStatus, summarizeCommits, type StatusInput } from '../src/lib/appstatus';
import { ciWords } from '../src/lib/words';
import type { CommitEntry, CommitsInfo } from '../src/lib/home';

/** SHP-T-3.10: one status per app, in words, from what the server already answers. */

const sha = (c: string): string => c.repeat(40);
const LIVE = sha('0');

function commit(c: string, ci: CommitEntry['ci']): CommitEntry {
  return { sha: sha(c), message: c, ci, taskIds: [] };
}

function commits(entries: CommitEntry[], extra: Partial<CommitsInfo> = {}): CommitsInfo {
  let newestGreen: string | null = null;
  for (const e of entries) if (e.ci === 'success') newestGreen = e.sha;
  return { live: LIVE, head: entries.at(-1)?.sha ?? LIVE, commits: entries, newestGreen, source: 'github', ...extra };
}

function input(overrides: Partial<StatusInput> = {}): StatusInput {
  return {
    repo: 'matdemers1/web',
    liveSha: LIVE,
    defaultBranch: 'main',
    commits: commits([]),
    drift: null,
    active: null,
    approval: undefined,
    ...overrides,
  };
}

describe('appStatus', () => {
  it('reads frozen over ready, offers no deploy, and still names what would deploy', () => {
    const s = appStatus(input({ frozen: true, commits: commits([commit('a', 'success')], { ahead: 1 }) }));
    expect(s).toMatchObject({ kind: 'frozen', label: 'Frozen', tone: 'neutral', shipSha: null });
    expect(s.detail).toMatch(new RegExp(`^${sha('a').slice(0, 7)} is ready to deploy once it is unfrozen`));
  });

  it('lets a deploy already running read as deploying while frozen', () => {
    const s = appStatus(input({ frozen: true, active: { holder: 'Ada', state: 'soaking', currentStep: 'soak' } }));
    expect(s.kind).toBe('deploying');
  });

  it('is not frozen when the server does not say so', () => {
    expect(appStatus(input({ commits: commits([commit('a', 'success')]) })).kind).toBe('ready');
  });

  it('is up to date with nothing ahead', () => {
    expect(appStatus(input())).toMatchObject({ kind: 'up-to-date', shipSha: null });
  });

  it('explains commits ahead with no image-workflow run instead of offering nothing silently', () => {
    const s = appStatus(input({ commits: commits([commit('a', 'none'), commit('b', 'none')], { ahead: 12 }) }));
    expect(s.kind).toBe('no-images');
    expect(s.headline).toBe('12 commits since live, none with images');
    expect(s.detail).toMatch(/once per push/);
    expect(s.shipSha).toBeNull();
  });

  it('reads the newest push by its newest run: running, then failed', () => {
    expect(appStatus(input({ commits: commits([commit('a', 'none'), commit('b', 'pending'), commit('c', 'none')]) })).kind).toBe(
      'ci-running',
    );
    expect(appStatus(input({ commits: commits([commit('a', 'failure'), commit('b', 'none')]) }))).toMatchObject({
      kind: 'ci-failed',
      tone: 'danger',
      headline: `CI failed on ${sha('a').slice(0, 7)}`,
    });
  });

  it('offers the newest green commit and says what comes after it', () => {
    const s = appStatus(input({ commits: commits([commit('a', 'none'), commit('b', 'success'), commit('c', 'pending')], { ahead: 3 }) }));
    expect(s).toMatchObject({ kind: 'ready', shipSha: sha('b') });
    expect(s.detail).toMatch(/by 2 commits/);
    expect(s.detail).toMatch(/1 newer commit is still being built/);
  });

  it('puts a deploy in progress, an approval and drift ahead of anything to deploy', () => {
    const ready = commits([commit('a', 'success')]);
    expect(appStatus(input({ commits: ready, active: { holder: 'matt', state: 'soaking', currentStep: null } })).kind).toBe('deploying');
    expect(appStatus(input({ commits: ready, approval: { sha: sha('a'), requester: { label: 'claude' } } })).kind).toBe('approval');
    expect(appStatus(input({ commits: ready, drift: { id: 'e1' } })).kind).toBe('drift');
  });

  it('tells no repository, GitHub unreachable and never deployed apart', () => {
    expect(appStatus(input({ repo: null })).kind).toBe('no-repo');
    expect(appStatus(input({ commits: { ...commits([]), source: 'unavailable', head: null } })).kind).toBe('github-unavailable');
    expect(appStatus(input({ commits: null })).kind).toBe('github-unavailable');
    expect(appStatus(input({ liveSha: null })).kind).toBe('never-deployed');
  });
});

describe('appStatus for a build: shipyard app (SHP-T-3.11)', () => {
  const shipyard = (entries: CommitEntry[]) => commits(entries, { buildSource: 'shipyard' });

  it('offers a commit Shipyard built, and says Shipyard built it', () => {
    const s = appStatus(input({ commits: shipyard([commit('a', 'success')]) }));
    expect(s).toMatchObject({ kind: 'ready', shipSha: sha('a') });
    expect(s.detail).toMatch(/^Shipyard built its images\./);
  });

  it("words a running, failed or missing build as Shipyard's, not CI's", () => {
    expect(appStatus(input({ commits: shipyard([commit('a', 'pending')]) })).headline).toBe(`Shipyard is building ${sha('a').slice(0, 7)}`);
    expect(appStatus(input({ commits: shipyard([commit('a', 'failure')]) }))).toMatchObject({
      label: 'Build failed',
      headline: `Shipyard's build of ${sha('a').slice(0, 7)} failed`,
    });
    const none = appStatus(input({ commits: shipyard([commit('a', 'none')]) }));
    expect(none.headline).toBe('1 commit since live, none built');
    expect(none.detail).toMatch(/shipyard_build/);
    expect(none.detail).not.toMatch(/GitHub/);
  });
});

describe('ciWords', () => {
  it('names the builder', () => {
    expect(ciWords('none')).toBe('No images');
    expect(ciWords('none', 'shipyard')).toBe('Not built');
    expect(ciWords('failure', 'shipyard')).toBe('Build failed');
  });
});

describe('summarizeCommits', () => {
  it('counts by CI state and never reports fewer ahead than it listed', () => {
    const s = summarizeCommits(commits([commit('a', 'none'), commit('b', 'success'), commit('c', 'failure')]));
    expect(s).toMatchObject({ ahead: 3, checked: 3, green: 1, failed: 1, noRun: 1, running: 0, afterShip: 1 });
  });
});
