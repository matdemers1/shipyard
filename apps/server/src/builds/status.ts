import type { BuildResultEvent, BuildStageEndEvent } from './service.js';

/**
 * Pure helpers for the GitHub commit status a build stage or result maps to (SHP-REQ-146). No I/O
 * here — `outbox/builds.ts` enqueues what these compute, and posts it from the drain loop.
 */

export type GitHubStatusState = 'success' | 'failure' | 'error';

export interface GitHubStatusDescriptor {
  context: 'shipyard/test' | 'shipyard/build';
  state: GitHubStatusState;
  description: string;
}

/** GitHub caps a status description at 140 characters. */
const MAX_DESCRIPTION_LENGTH = 140;

export function truncateDescription(text: string): string {
  return text.length > MAX_DESCRIPTION_LENGTH ? text.slice(0, MAX_DESCRIPTION_LENGTH) : text;
}

/**
 * What a stage ending posts, if anything: the `test` stage always reports on
 * `shipyard/test` (skipped reports nothing — there is nothing to say pass/fail about); a `build`
 * or `push` stage failing reports `shipyard/build` failure early, ahead of the build's terminal
 * result (which also reports `shipyard/build` — SHP-T-7.15's brief treats both as distinct posts,
 * harmless since a commit status only ever shows the newest one per context).
 */
export function githubStatusForStageEnd(event: BuildStageEndEvent): GitHubStatusDescriptor | null {
  if (event.stage === 'test') {
    if (event.state === 'skipped') return null;
    return event.state === 'succeeded'
      ? { context: 'shipyard/test', state: 'success', description: 'tests passed' }
      : { context: 'shipyard/test', state: 'failure', description: 'tests failed' };
  }
  if ((event.stage === 'build' || event.stage === 'push') && event.state === 'failed') {
    return { context: 'shipyard/build', state: 'failure', description: truncateDescription(`${event.stage} failed`) };
  }
  return null;
}

/** What a build's terminal result posts on `shipyard/build` (SHP-REQ-146). */
export function githubStatusForResult(event: BuildResultEvent): GitHubStatusDescriptor {
  switch (event.state) {
    case 'succeeded':
      return { context: 'shipyard/build', state: 'success', description: 'build succeeded' };
    case 'failed':
      return {
        context: 'shipyard/build',
        state: 'failure',
        description: truncateDescription(event.failedStage === undefined ? 'build failed' : `${event.failedStage} failed`),
      };
    case 'refused':
      return {
        context: 'shipyard/build',
        state: 'error',
        description: truncateDescription(event.refusal === undefined ? 'build refused' : event.refusal.message),
      };
    case 'cancelled':
      return { context: 'shipyard/build', state: 'error', description: 'build cancelled' };
  }
}

/**
 * `repo`, `base`, `head` and `workflow` are each percent-encoded per path segment in
 * `packages/sequence`'s GitHub adapter; this mirrors just the `owner/name` half of that, since it
 * is the only shape a commit-status POST needs and that package is agent/CLI code the server does
 * not import for writes.
 */
export function encodeRepoPath(repo: string): string {
  const slash = repo.indexOf('/');
  if (slash === -1) return encodeURIComponent(repo);
  return `${encodeURIComponent(repo.slice(0, slash))}/${encodeURIComponent(repo.slice(slash + 1))}`;
}
