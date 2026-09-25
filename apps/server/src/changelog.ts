import type { GitHubPort } from '@shipyard/sequence/github';

/**
 * The changelog between two SHAs on a repo (SHP-T-5.8, SHP-REQ-087): the commits between `base`
 * (exclusive) and `head` (inclusive), each with the Foreman task IDs parsed out of its message,
 * plus the union of every task ID cited. Used both by `GET /api/apps/:app/commits?to=` (the
 * console's "what would ship" list) and by the outbox (SHP-T-5.9), which cites the same IDs back
 * to Foreman as deployed.
 */

const TASK_ID_RE = /\b[A-Z][A-Z0-9]{1,7}-T-\d+(?:\.\d+)?\b/g;

/** Commits beyond this many in one range are still summarised (task IDs, count) but not listed
 * individually — `truncated` says so rather than silently dropping commits with no signal. */
export const MAX_CHANGELOG_COMMITS = 250;

export interface ChangelogCommit {
  sha: string;
  /** The message's first line — a changelog entry, not the full commit body. */
  message: string;
  /** GitHubPort's `compare` does not carry an author; always undefined for now. */
  author?: string;
  taskIds: string[];
}

export interface ChangelogResult {
  commits: ChangelogCommit[];
  /** The union of every commit's task IDs, deduplicated and sorted. */
  taskIds: string[];
  truncated: boolean;
}

export function taskIdsIn(message: string): string[] {
  return [...message.matchAll(TASK_ID_RE)].map((m) => m[0]);
}

function firstLine(message: string): string {
  const idx = message.indexOf('\n');
  return idx === -1 ? message : message.slice(0, idx);
}

/**
 * The changelog for `base..head` on `repo`: `GitHubPort.compare`'s commits (oldest first, per its
 * contract), each with task IDs parsed from its message. Propagates GitHubPort's
 * `RefusalError(github_unreachable)` on failure — callers decide how to surface "unavailable".
 */
export async function changelog(github: GitHubPort, repo: string, base: string, head: string): Promise<ChangelogResult> {
  const comparison = await github.compare(repo, base, head);
  const all = comparison?.commits ?? [];
  const truncated = all.length > MAX_CHANGELOG_COMMITS;
  const commits: ChangelogCommit[] = all.slice(0, MAX_CHANGELOG_COMMITS).map((c) => ({
    sha: c.sha,
    message: firstLine(c.message),
    taskIds: taskIdsIn(c.message),
  }));
  // Every commit in range counts toward the task list, including those past the listing cap.
  const taskIds = [...new Set(all.flatMap((c) => taskIdsIn(c.message)))].sort();
  return { commits, taskIds, truncated };
}
