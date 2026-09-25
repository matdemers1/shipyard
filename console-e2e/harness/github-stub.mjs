// Preloaded into the server process (`node --import`): answers the two GitHub REST calls the
// server makes — `compare` and a workflow's runs — from a fixed commit graph, so the console's
// "commits waiting", CI dots and Ship buttons are the same on every run and no request leaves the
// machine. Every other URL goes to the real `fetch`.
//
// The SHAs are `seed.ts`'s `sha(n)`: sha1 of "console-e2e commit <n>". Keep the two in step.
import { createHash } from 'node:crypto';

const sha = (n) => createHash('sha1').update(`console-e2e commit ${String(n)}`).digest('hex');

/** repo → the default branch's commits, oldest first: [n, message, CI conclusion or null (running)]. */
const GRAPH = {
  'matdemers1/bindery': [
    [1, 'Initial import', 'success'],
    [2, 'BND-T-16.1: the private vault', 'success'],
    [3, 'Page-level search inside bundles', 'success'],
    [4, 'BND-T-15.2: gated CI', 'success'],
    [5, 'Fix search ranking', 'failure'],
    [6, 'BND-T-12.1: document titles are editable', 'success'],
    [7, 'Scanner ingest retries', 'success'],
    [8, 'Bump pdf.js', null],
  ],
  'matdemers1/foreman': [
    [20, 'Importer golden fixtures', 'success'],
    [21, 'FRM-T-10.4: cutover', 'success'],
    [22, 'Drift badge on the portfolio', 'success'],
  ],
  'matdemers1/sceptrefall': [
    [31, 'Season two council', 'success'],
    [32, 'Finale epilogue', 'success'],
  ],
  'matdemers1/d3auth': [
    [41, 'AUTH-T-6.2: mail relay', 'success'],
    [42, 'Passkey fix', 'success'],
  ],
  'matdemers1/www': [
    [51, 'Landing copy', 'success'],
    [52, 'Hero copy', 'success'],
    [53, 'Project page for Shipyard', null],
  ],
  'matdemers1/docs': [[61, 'Docs skeleton', 'success']],
  'matdemers1/someday-vault': [
    [70, 'Scaffold', 'success'],
    [71, 'Steward confirmation', 'success'],
  ],
};

const commits = new Map(
  Object.entries(GRAPH).map(([repo, list]) => [repo, list.map(([n, message, conclusion]) => ({ sha: sha(n), message, conclusion }))]),
);

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const notFound = () => json(404, { message: 'Not Found' });

function indexOf(list, ref) {
  if (ref === 'main') return list.length - 1;
  return list.findIndex((c) => c.sha === ref);
}

function answer(url) {
  const compare = /^\/repos\/([^/]+\/[^/]+)\/compare\/([^.]+)\.\.\.(.+)$/.exec(url.pathname);
  if (compare !== null) {
    const list = commits.get(decodeURIComponent(compare[1]));
    if (list === undefined) return notFound();
    const base = indexOf(list, decodeURIComponent(compare[2]));
    const head = indexOf(list, decodeURIComponent(compare[3]));
    if (base === -1 || head === -1) return notFound();
    const ahead = head > base ? list.slice(base + 1, head + 1) : [];
    const behind = base > head ? base - head : 0;
    return json(200, {
      status: ahead.length === 0 && behind === 0 ? 'identical' : behind === 0 ? 'ahead' : 'behind',
      ahead_by: ahead.length,
      behind_by: behind,
      commits: ahead.map((c) => ({ sha: c.sha, commit: { message: c.message } })),
    });
  }
  const runs = /^\/repos\/([^/]+\/[^/]+)\/actions\/workflows\/([^/]+)\/runs$/.exec(url.pathname);
  if (runs !== null) {
    const list = commits.get(decodeURIComponent(runs[1]));
    if (list === undefined) return notFound();
    const headSha = url.searchParams.get('head_sha');
    const found = list.find((c) => c.sha === headSha);
    const workflowRuns =
      found === undefined
        ? []
        : [
            {
              id: 1,
              head_sha: found.sha,
              path: `.github/workflows/${decodeURIComponent(runs[2])}`,
              status: found.conclusion === null ? 'in_progress' : 'completed',
              conclusion: found.conclusion,
              event: 'push',
              head_branch: 'main',
            },
          ];
    return json(200, { total_count: workflowRuns.length, workflow_runs: workflowRuns });
  }
  return notFound();
}

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw);
  if (url.origin === 'https://api.github.com') return Promise.resolve(answer(url));
  return realFetch(input, init);
};
