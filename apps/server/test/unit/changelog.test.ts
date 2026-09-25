import { describe, expect, it } from 'vitest';
import type { GitHubPort } from '@shipyard/sequence/github';
import { changelog, MAX_CHANGELOG_COMMITS, taskIdsIn } from '../../src/changelog.js';

/**
 * `changelog` (SHP-T-5.8, SHP-REQ-087): the range's commits, oldest first per `GitHubPort`'s
 * contract, with each commit's Foreman task IDs parsed out and the union collected.
 */

class FakeGitHub implements GitHubPort {
  compareResult: Awaited<ReturnType<GitHubPort['compare']>> = null;

  compare(_repo: string, _base: string, _head: string): ReturnType<GitHubPort['compare']> {
    return Promise.resolve(this.compareResult);
  }

  workflowRuns(): ReturnType<GitHubPort['workflowRuns']> {
    return Promise.resolve([]);
  }
}

describe('taskIdsIn', () => {
  it('parses every SHP-style task ID out of a message, ignoring the rest', () => {
    expect(taskIdsIn('SHP-T-5.8: what-shipping changelog\n\nAlso touches SHP-T-5.9.')).toEqual(['SHP-T-5.8', 'SHP-T-5.9']);
    expect(taskIdsIn('fix typo (no task id)')).toEqual([]);
  });
});

describe('changelog', () => {
  it('lists commits and their task IDs for a fixture range, and the union across the range', async () => {
    const github = new FakeGitHub();
    github.compareResult = {
      status: 'ahead',
      aheadBy: 3,
      behindBy: 0,
      commits: [
        { sha: 'a'.repeat(40), message: 'SHP-T-5.8: changelog helper\n\nbody text' },
        { sha: 'b'.repeat(40), message: 'fix typo (no task id)' },
        { sha: 'c'.repeat(40), message: 'SHP-T-5.9: mark tasks deployed' },
      ],
    };

    const result = await changelog(github, 'matdemers1/shipyard', 'live-sha', 'candidate-sha');

    expect(result.truncated).toBe(false);
    expect(result.commits).toEqual([
      { sha: 'a'.repeat(40), message: 'SHP-T-5.8: changelog helper', taskIds: ['SHP-T-5.8'] },
      { sha: 'b'.repeat(40), message: 'fix typo (no task id)', taskIds: [] },
      { sha: 'c'.repeat(40), message: 'SHP-T-5.9: mark tasks deployed', taskIds: ['SHP-T-5.9'] },
    ]);
    expect(result.taskIds).toEqual(['SHP-T-5.8', 'SHP-T-5.9']);
  });

  it('drops another project\'s task ID rather than treating it as SHP\'s own — filtering is the caller\'s job', async () => {
    const github = new FakeGitHub();
    github.compareResult = {
      status: 'ahead',
      aheadBy: 1,
      behindBy: 0,
      commits: [{ sha: 'a'.repeat(40), message: 'FRM-T-006: Foreman-side contract' }],
    };

    const result = await changelog(github, 'matdemers1/shipyard', 'live-sha', 'candidate-sha');
    expect(result.taskIds).toEqual(['FRM-T-006']);
  });

  it('returns an empty changelog when the comparison 404s (unknown base SHA)', async () => {
    const github = new FakeGitHub();
    github.compareResult = null;

    const result = await changelog(github, 'matdemers1/shipyard', 'unknown-sha', 'candidate-sha');
    expect(result).toEqual({ commits: [], taskIds: [], truncated: false });
  });

  it('caps the listed commits and says so, without dropping them silently', async () => {
    const github = new FakeGitHub();
    const commits = Array.from({ length: MAX_CHANGELOG_COMMITS + 5 }, (_, i) => ({
      sha: i.toString(16).padStart(40, '0'),
      message: `commit ${String(i)}`,
    }));
    github.compareResult = { status: 'ahead', aheadBy: commits.length, behindBy: 0, commits };

    const result = await changelog(github, 'matdemers1/shipyard', 'live-sha', 'candidate-sha');
    expect(result.truncated).toBe(true);
    expect(result.commits).toHaveLength(MAX_CHANGELOG_COMMITS);
  });

  it('propagates a RefusalError from GitHubPort rather than swallowing it', async () => {
    const { RefusalError } = await import('@shipyard/sequence/github');
    const github = new FakeGitHub();
    github.compare = () => Promise.reject(new RefusalError({ code: 'github_unreachable', gate: 'none', message: 'GitHub is unreachable', fix: 'Retry.' }));

    await expect(changelog(github, 'matdemers1/shipyard', 'live-sha', 'candidate-sha')).rejects.toThrow('GitHub is unreachable');
  });
});
