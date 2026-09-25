import type { GitHubPort } from '@shipyard/sequence/github';
import { changelog } from '../changelog.js';

/**
 * The outbox's changelog side (SHP-T-5.9, SHP-REQ-088): "which Foreman tasks did this deploy
 * ship" needs a GitHub call, so it is computed lazily in the drain — never on the deploy path —
 * from the reference recorded at enqueue time.
 */

export interface ChangelogRef {
  repo: string;
  defaultBranch: string;
  /** The live SHA before this deploy (`DeployTarget.liveShaBefore`). Null on a first deploy: no
   * prior release to diff against, so nothing is cited. */
  base: string | null;
  /** The SHA this deploy shipped (the deploy's requested SHA). */
  head: string;
}

/**
 * The task IDs cited by commits between `ref.base` (exclusive) and `ref.head` (inclusive),
 * filtered to `project`'s own prefix — another project's ID is dropped (SHP-REQ-088). Null base
 * means nothing to cite. `cache` is shared across the rows a single drain claims, so two images
 * on the same target (same range) make one GitHub call rather than one per image.
 */
export async function tasksFor(
  github: GitHubPort,
  ref: ChangelogRef,
  project: string,
  cache: Map<string, Promise<string[]>>,
): Promise<string[]> {
  if (ref.base === null) return [];

  const key = `${ref.repo}@${ref.base}..${ref.head}`;
  let pending = cache.get(key);
  if (pending === undefined) {
    pending = changelog(github, ref.repo, ref.base, ref.head).then((result) =>
      result.taskIds.filter((id) => id.split('-')[0] === project),
    );
    cache.set(key, pending);
  }
  return pending;
}
