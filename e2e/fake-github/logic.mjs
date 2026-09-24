// Pure logic behind the fake GitHub API. No I/O, so it is unit-testable without Docker.
// Types: logic.d.mts.

const SHA = /^[0-9a-f]{40}$/;

/** @returns {import('./logic.d.mts').State} */
export function emptyState() {
  return { repos: {} };
}

function fail(message) {
  throw new Error(`fake-github state: ${message}`);
}

function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate and normalise a state document posted to /_control/state.
 * @param {unknown} input
 * @returns {import('./logic.d.mts').State}
 */
export function normalizeState(input) {
  if (!isObject(input) || !isObject(input.repos)) fail('expected { repos: { "<owner>/<repo>": … } }');
  let nextId = 1000;
  const repos = {};
  for (const [fullName, repo] of Object.entries(input.repos)) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(fullName)) fail(`bad repo name ${JSON.stringify(fullName)}`);
    if (!isObject(repo)) fail(`${fullName}: expected an object`);
    const runs = {};
    const rawRuns = repo.runs ?? {};
    if (!isObject(rawRuns)) fail(`${fullName}.runs: expected { <sha>: [run, …] }`);
    for (const [sha, list] of Object.entries(rawRuns)) {
      if (!SHA.test(sha)) fail(`${fullName}.runs: ${JSON.stringify(sha)} is not a 40-hex sha`);
      if (!Array.isArray(list)) fail(`${fullName}.runs.${sha}: expected an array`);
      runs[sha] = list.map((r) => {
        if (!isObject(r) || typeof r.workflow !== 'string') fail(`${fullName}.runs.${sha}: each run needs a workflow`);
        return {
          id: typeof r.id === 'number' ? r.id : nextId++,
          workflow: r.workflow,
          status: typeof r.status === 'string' ? r.status : 'completed',
          conclusion: r.conclusion === undefined ? 'success' : r.conclusion,
          event: typeof r.event === 'string' ? r.event : 'push',
          head_branch: typeof r.head_branch === 'string' ? r.head_branch : 'main',
        };
      });
    }
    const branches = {};
    const rawBranches = repo.branches ?? {};
    if (!isObject(rawBranches)) fail(`${fullName}.branches: expected { <branch>: [{ sha, parent }, …] }`);
    for (const [branch, commits] of Object.entries(rawBranches)) {
      if (!Array.isArray(commits)) fail(`${fullName}.branches.${branch}: expected an array`);
      branches[branch] = commits.map((c) => {
        if (!isObject(c) || typeof c.sha !== 'string' || !SHA.test(c.sha)) {
          fail(`${fullName}.branches.${branch}: each commit needs a 40-hex sha`);
        }
        const parent = c.parent ?? null;
        if (parent !== null && (typeof parent !== 'string' || !SHA.test(parent))) {
          fail(`${fullName}.branches.${branch}: parent of ${c.sha} must be a 40-hex sha or null`);
        }
        return { sha: c.sha, parent };
      });
    }
    repos[fullName] = { runs, branches };
  }
  return { repos };
}

/** @returns {import('./logic.d.mts').Reply} */
function notFound() {
  return { status: 404, body: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' } };
}

/**
 * GET /repos/:owner/:repo/actions/runs
 * @param {import('./logic.d.mts').State} state
 * @param {string} fullName
 * @param {URLSearchParams} query
 * @returns {import('./logic.d.mts').Reply}
 */
export function listRuns(state, fullName, query) {
  const repo = state.repos[fullName];
  if (!repo) return notFound();
  const headSha = query.get('head_sha');
  const branch = query.get('branch');
  const event = query.get('event');
  const status = query.get('status');
  const runs = [];
  for (const [sha, list] of Object.entries(repo.runs)) {
    if (headSha !== null && sha !== headSha) continue;
    for (const r of list) {
      if (branch !== null && r.head_branch !== branch) continue;
      if (event !== null && r.event !== event) continue;
      if (status !== null && r.status !== status && r.conclusion !== status) continue;
      runs.push({
        id: r.id,
        name: r.workflow.replace(/\.ya?ml$/, ''),
        head_sha: sha,
        head_branch: r.head_branch,
        path: `.github/workflows/${r.workflow}`,
        status: r.status,
        conclusion: r.conclusion,
        event: r.event,
      });
    }
  }
  // GitHub returns newest first.
  runs.sort((a, b) => b.id - a.id);
  return { status: 200, body: { total_count: runs.length, workflow_runs: runs } };
}

function parentMap(repo) {
  const parents = new Map();
  for (const commits of Object.values(repo.branches)) {
    for (const c of commits) parents.set(c.sha, c.parent);
  }
  return parents;
}

function resolveRef(repo, parents, ref) {
  if (parents.has(ref)) return ref;
  const branch = repo.branches[ref];
  if (branch && branch.length > 0) return branch[branch.length - 1].sha;
  return null;
}

/** Ancestry of sha, sha first, oldest last. */
function lineage(parents, sha) {
  const out = [];
  const seen = new Set();
  let cur = sha;
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = parents.get(cur) ?? null;
  }
  return out;
}

/**
 * GET /repos/:owner/:repo/compare/:base...:head
 * @param {import('./logic.d.mts').State} state
 * @param {string} fullName
 * @param {string} baseRef
 * @param {string} headRef
 * @returns {import('./logic.d.mts').Reply}
 */
export function compare(state, fullName, baseRef, headRef) {
  const repo = state.repos[fullName];
  if (!repo) return notFound();
  const parents = parentMap(repo);
  const base = resolveRef(repo, parents, baseRef);
  const head = resolveRef(repo, parents, headRef);
  if (base === null || head === null) return notFound();

  const baseLine = lineage(parents, base);
  const headLine = lineage(parents, head);
  const baseSet = new Set(baseLine);
  const headSet = new Set(headLine);
  const aheadShas = headLine.filter((s) => !baseSet.has(s));
  const behindShas = baseLine.filter((s) => !headSet.has(s));
  const mergeBase = headLine.find((s) => baseSet.has(s)) ?? null;
  if (mergeBase === null) return notFound(); // unrelated histories: GitHub answers 404

  let status;
  if (aheadShas.length === 0 && behindShas.length === 0) status = 'identical';
  else if (behindShas.length === 0) status = 'ahead';
  else if (aheadShas.length === 0) status = 'behind';
  else status = 'diverged';

  return {
    status: 200,
    body: {
      status,
      ahead_by: aheadShas.length,
      behind_by: behindShas.length,
      total_commits: aheadShas.length,
      merge_base_commit: { sha: mergeBase },
      // GitHub lists the head-side commits oldest first.
      commits: aheadShas.reverse().map((sha) => ({ sha })),
    },
  };
}

/**
 * Route a GitHub API request (not /_control) to the logic above.
 * @param {import('./logic.d.mts').State} state
 * @param {string} method
 * @param {string} rawUrl path and query, as received
 * @returns {import('./logic.d.mts').Reply}
 */
export function route(state, method, rawUrl) {
  const url = new URL(rawUrl, 'http://fake-github.invalid');
  if (method !== 'GET') return { status: 405, body: { message: 'Method Not Allowed' } };
  const runs = /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/?$/.exec(url.pathname);
  if (runs) {
    return listRuns(state, `${decodeURIComponent(runs[1])}/${decodeURIComponent(runs[2])}`, url.searchParams);
  }
  const cmp = /^\/repos\/([^/]+)\/([^/]+)\/compare\/(.+)$/.exec(url.pathname);
  if (cmp) {
    const spec = decodeURIComponent(cmp[3]);
    const dots = spec.indexOf('...');
    if (dots <= 0) return notFound();
    return compare(
      state,
      `${decodeURIComponent(cmp[1])}/${decodeURIComponent(cmp[2])}`,
      spec.slice(0, dots),
      spec.slice(dots + 3),
    );
  }
  return notFound();
}
