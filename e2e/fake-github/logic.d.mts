export interface StoredRun {
  id: number;
  /** Workflow file name, e.g. `ci.yml`; reported as `path: .github/workflows/ci.yml`. */
  workflow: string;
  status: string;
  conclusion: string | null;
  event: string;
  head_branch: string;
}

export interface Commit {
  sha: string;
  parent: string | null;
}

export interface RepoState {
  runs: Record<string, StoredRun[]>;
  /** Commits per branch, oldest first; the last one is the tip. */
  branches: Record<string, Commit[]>;
  /** Source archives by SHA, base64 tar.gz; present only when posted. */
  tarballs?: Record<string, string>;
}

export interface State {
  /** Keyed by `owner/repo`. */
  repos: Record<string, RepoState>;
}

/** What may be POSTed to /_control/state; ids, status, conclusion, event and head_branch default. */
export interface StateInput {
  repos: Record<
    string,
    {
      runs?: Record<string, (Partial<StoredRun> & { workflow: string })[]>;
      branches?: Record<string, Commit[]>;
      /** `GET /repos/:o/:r/tarball/:sha` answers 200 with these bytes (base64 tar.gz). */
      tarballs?: Record<string, string>;
    }
  >;
}

export interface WorkflowRun {
  id: number;
  name: string;
  head_sha: string;
  head_branch: string;
  path: string;
  status: string;
  conclusion: string | null;
  event: string;
}

export interface RunsBody {
  total_count: number;
  workflow_runs: WorkflowRun[];
}

export interface CompareBody {
  status: 'ahead' | 'behind' | 'identical' | 'diverged';
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  merge_base_commit: { sha: string };
  commits: { sha: string }[];
}

export interface Reply {
  status: number;
  /** JSON, or raw bytes (a Buffer) sent with `contentType`. */
  body: unknown;
  contentType?: string;
}

export function emptyState(): State;
export function normalizeState(input: unknown): State;
export function listRuns(state: State, fullName: string, query: URLSearchParams): Reply;
export function compare(state: State, fullName: string, baseRef: string, headRef: string): Reply;
export function tarball(state: State, fullName: string, ref: string): Reply;
export function route(state: State, method: string, rawUrl: string): Reply;
