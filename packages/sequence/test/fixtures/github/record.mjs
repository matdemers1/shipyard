#!/usr/bin/env node
// Re-records the real fixtures in this directory against the public repo matdemers1/shipyard,
// unauthenticated. Run with `node test/fixtures/github/record.mjs` from `packages/sequence`.
//
// Each fixture is `{ status, headers, body }`: `headers` keeps only the ones the adapter or the
// tests read (rate limit, token expiry) to keep files small and diffs readable. `body` is the
// exact JSON GitHub returned, or `null` for a fixture with no body to record.
//
// This script makes ~7 unauthenticated requests (60/hour budget) and only touches endpoints that
// need no token. It does NOT re-record the fixtures marked `synthetic: true` in their own file —
// those are hand-edited from a real recording because the real event does not happen on demand:
//   - workflow-runs-failure.json, workflow-runs-in-progress.json: edited copies of
//     workflow-runs-success.json with `status`/`conclusion` changed.
//   - compare-diverged.json: an edited copy of compare-ahead.json with `status` set to
//     `"diverged"` and `behind_by` set to a non-zero number (GitHub only returns `diverged` when
//     both branches have unique commits; there is no cheap real pair of SHAs in this repo that
//     stays diverged, so this is documented as synthetic rather than faked as real).
//   - error-500.json, error-502.json, error-503.json, error-429.json, ratelimited-403.json,
//     malformed-body.json, malformed-shape.json: GitHub does not hand out 5xx/429/malformed
//     bodies on request, so these carry the documented shape of those responses (a JSON
//     `message`, non-JSON text, or valid JSON in an unexpected shape) with `synthetic: true`.
//   - workflow-runs-paginated-page1.json/-page2.json, workflow-runs-cap-page1..5.json: hand-built
//     from the shape of workflow-runs-success.json to exercise `Link: rel="next"` pagination and
//     the 5-page cap — a real SHA with >20 runs on this repo does not exist on demand.
// Everything else here is a live recording, re-run to refresh it.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));

const REPO = 'matdemers1/shipyard';
const SUCCESS_SHA = '30593dd333296f7f9ef5613ea1c211e9f32d310b';
const NO_RUN_SHA = '1111111111111111111111111111111111111a';
const OLDER_SHA = '2890f1155bbfb3d96d3f7d303fd721c210c99911';
const UNKNOWN_SHA = '0000000000000000000000000000000000000000';

const KEEP_HEADERS = [
  'content-type',
  'x-ratelimit-remaining',
  'x-ratelimit-limit',
  'x-ratelimit-reset',
  'github-authentication-token-expiration',
];

async function record(name, url, options = {}) {
  const res = await fetch(url, options);
  const body = await res.text();
  const headers = {};
  for (const key of KEEP_HEADERS) {
    const value = res.headers.get(key);
    if (value !== null) headers[key] = value;
  }
  let parsedBody;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    parsedBody = body;
  }
  const fixture = { status: res.status, headers, body: parsedBody };
  await writeFile(join(dir, `${name}.json`), JSON.stringify(fixture, null, 2) + '\n');
  console.log(name, res.status);
}

async function main() {
  await record(
    'workflow-runs-success',
    `https://api.github.com/repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${SUCCESS_SHA}&per_page=20`,
  );
  await record(
    'workflow-runs-absent',
    `https://api.github.com/repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${NO_RUN_SHA}&per_page=20`,
  );
  await record(
    'workflow-runs-unknown-workflow',
    `https://api.github.com/repos/${REPO}/actions/workflows/does-not-exist.yml/runs?head_sha=${SUCCESS_SHA}&per_page=20`,
  );
  await record(
    'workflow-runs-unauthorized',
    `https://api.github.com/repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${SUCCESS_SHA}&per_page=20`,
    { headers: { Authorization: 'Bearer ghp_invalidtokenxxxxxxxxxxxxxxxxxxxxxx' } },
  );
  // The full workflow *path* form, percent-encoded (`.github%2Fworkflows%2Fci.yml`) — GitHub 200s
  // this too, but the unencoded form 404s. The adapter normalizes to the basename (`ci.yml`)
  // rather than relying on this, so this fixture is evidence the alternative form also works.
  await record(
    'workflow-runs-success-path-form',
    `https://api.github.com/repos/${REPO}/actions/workflows/${encodeURIComponent('.github/workflows/ci.yml')}/runs?head_sha=${SUCCESS_SHA}&per_page=20`,
  );
  await record('compare-ahead', `https://api.github.com/repos/${REPO}/compare/${OLDER_SHA}...${SUCCESS_SHA}`);
  await record('compare-behind', `https://api.github.com/repos/${REPO}/compare/${SUCCESS_SHA}...${OLDER_SHA}`);
  await record('compare-identical', `https://api.github.com/repos/${REPO}/compare/${SUCCESS_SHA}...${SUCCESS_SHA}`);
  await record('compare-404', `https://api.github.com/repos/${REPO}/compare/${UNKNOWN_SHA}...${SUCCESS_SHA}`);

  console.log('\nDone. The synthetic fixtures listed at the top of this file are not touched by this script.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
