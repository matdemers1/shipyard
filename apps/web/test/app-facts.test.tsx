import { describe, expect, it } from 'vitest';
import {
  failedRidingAlong,
  historyTitle,
  liveRequester,
  nextUpCommit,
  ridingAlongWarning,
  rollbackFor,
  rollbacksOutsideHistory,
  took,
  workflowUrl,
  type Release,
} from '../src/lib/appdetail';
import type { CommitEntry, CommitsInfo } from '../src/lib/home';
import { ciRunText } from '../src/screens/app/Waiting';

/** The app page's derived facts (SHP-T-13.12): each a pure function, pinned here without a render. */

const sha = (c: string): string => c.repeat(40);
const entry = (c: string, ci: CommitEntry['ci']): CommitEntry => ({ sha: sha(c), message: c, ci, taskIds: [] });

function info(entries: CommitEntry[], newestGreen: string | null): CommitsInfo {
  return { live: sha('0'), head: entries.at(-1)?.sha ?? null, commits: entries, newestGreen, source: 'github' };
}

describe('next up', () => {
  it('follows the newest ready commit ahead of live', () => {
    expect(nextUpCommit(info([entry('a', 'none'), entry('b', 'success'), entry('c', 'pending')], sha('b')), sha('0'))?.sha).toBe(sha('b'));
  });

  it('follows the newest waiting commit when none is ready, and nothing when none waits', () => {
    expect(nextUpCommit(info([entry('a', 'none'), entry('c', 'pending')], null), sha('0'))?.sha).toBe(sha('c'));
    expect(nextUpCommit(info([], null), sha('0'))).toBeNull();
    expect(nextUpCommit(null, sha('0'))).toBeNull();
  });
});

describe('what rides along', () => {
  it('names the older commits whose CI failed, in the vocabulary', () => {
    const commits = info([entry('a', 'failure'), entry('d', 'none'), entry('b', 'success'), entry('c', 'failure')], sha('b'));
    const riders = failedRidingAlong(commits, sha('b'));
    expect(riders.map((c) => c.sha)).toEqual([sha('a')]);
    expect(ridingAlongWarning(sha('b'), riders)).toBe('Deploying bbbbbbb also deploys aaaaaaa, whose CI failed.');
    expect(ridingAlongWarning(sha('b'), [])).toBeNull();
  });
});

describe('rollback targets on history rows', () => {
  const offered: Release[] = [
    { deployId: 'd-7', targetId: 't-7', kind: 'deploy', sha: sha('7'), requester: 'm', endedAt: null, images: [] },
    { deployId: 'd-6', targetId: 't-6', kind: 'deploy', sha: sha('6'), requester: 'm', endedAt: null, images: [] },
  ];
  const row = (c: string) => ({
    id: `t-${c}`,
    deployId: `d-${c}`,
    kind: 'deploy',
    sha: sha(c),
    dryRun: false,
    requester: 'm',
    state: 'succeeded',
    currentStep: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
  });

  it('offers only what the server offers, and keeps the rest beneath the history', () => {
    expect(rollbackFor(row('7'), offered)?.sha).toBe(sha('7'));
    expect(rollbackFor(row('9'), offered)).toBeUndefined();
    expect(rollbacksOutsideHistory([row('9'), row('7')], offered).map((r) => r.deployId)).toEqual(['d-6']);
  });

  it('says who deployed the live release and what each row was', () => {
    expect(liveRequester({ liveDeployId: 'd-7', targets: [{ ...row('7'), requester: 'Matthew' }] })).toBe('Matthew');
    expect(liveRequester({ liveDeployId: null, targets: [] })).toBeNull();
    expect(historyTitle({ dryRun: false, kind: 'rollback', sha: sha('7') })).toBe('Rollback 7777777');
    expect(historyTitle({ dryRun: true, kind: 'deploy', sha: sha('7') })).toBe('Dry run 7777777');
  });
});

describe('small words', () => {
  it('times a deploy and links the image workflow', () => {
    expect(took('2026-10-01T00:00:00.000Z', '2026-10-01T00:02:05.000Z')).toBe('2m 05s');
    expect(took(null, '2026-10-01T00:02:05.000Z')).toBeNull();
    expect(workflowUrl('o/r', 'ci.yml')).toBe('https://github.com/o/r/actions/workflows/ci.yml');
    expect(workflowUrl('o/r', 'Images')).toBe('https://github.com/o/r/actions');
    expect(workflowUrl(null, 'ci.yml')).toBeNull();
  });

  it('words a CI state with its run, and a running one with how long it has run', () => {
    const run = { id: 415, url: 'u', startedAt: '2026-10-01T00:00:00.000Z', conclusion: null };
    expect(ciRunText({ ...entry('c', 'pending'), run }, 'github', Date.parse('2026-10-01T00:02:00.000Z'))).toBe('CI running · 2m 00s · #415');
    expect(ciRunText({ ...entry('b', 'success'), run: { ...run, id: 412 } }, 'github')).toBe('CI passed · #412');
    expect(ciRunText(entry('a', 'none'), 'github')).toBe('No images');
    // A Shipyard-built app has no GitHub run to name.
    expect(ciRunText({ ...entry('b', 'success'), run }, 'shipyard')).toBe('Built');
  });
});
