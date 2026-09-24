import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createGitHubAdapter, parseTokenExpiry } from '../src/adapters/github.js';
import { RefusalError } from '../src/ports.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/github');

interface Fixture {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  synthetic?: boolean;
}

function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8')) as Fixture;
}

function responseFromFixture(fixture: Fixture): Response {
  const bodyText = typeof fixture.body === 'string' ? fixture.body : JSON.stringify(fixture.body);
  return new Response(bodyText, { status: fixture.status, headers: fixture.headers });
}

/** A `fetch` stub that returns the named fixture on every call (or a queue of fixtures in order). */
function fetchFor(...names: string[]): typeof fetch {
  const queue = [...names];
  const last = names[names.length - 1] ?? '';
  return vi.fn(() => {
    const name = queue.shift() ?? last;
    return Promise.resolve(responseFromFixture(loadFixture(name)));
  });
}

const REPO = 'matdemers1/shipyard';
const SUCCESS_SHA = '30593dd333296f7f9ef5613ea1c211e9f32d310b';
const NO_RUN_SHA = '1111111111111111111111111111111111111a';
const OLDER_SHA = '2890f1155bbfb3d96d3f7d303fd721c210c99911';
const UNKNOWN_SHA = '0000000000000000000000000000000000000000';

async function expectRefusal(promise: Promise<unknown>): Promise<RefusalError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(RefusalError);
    return err as RefusalError;
  }
  throw new Error('expected a RefusalError but the promise resolved');
}

describe('workflowRuns', () => {
  it('maps a successful run (recorded fixture)', async () => {
    const adapter = createGitHubAdapter({ fetch: fetchFor('workflow-runs-success') });
    const runs = await adapter.workflowRuns(REPO, 'ci.yml', SUCCESS_SHA);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      headSha: SUCCESS_SHA,
      path: '.github/workflows/ci.yml',
      status: 'completed',
      conclusion: 'success',
      event: 'push',
    });
  });

  it('maps a failed run (synthetic fixture)', async () => {
    const adapter = createGitHubAdapter({ fetch: fetchFor('workflow-runs-failure') });
    const runs = await adapter.workflowRuns(REPO, 'ci.yml', SUCCESS_SHA);
    expect(runs[0]?.conclusion).toBe('failure');
  });

  it('maps an in-progress run with a null conclusion (synthetic fixture)', async () => {
    const adapter = createGitHubAdapter({ fetch: fetchFor('workflow-runs-in-progress') });
    const runs = await adapter.workflowRuns(REPO, 'ci.yml', SUCCESS_SHA);
    expect(runs[0]?.status).toBe('in_progress');
    expect(runs[0]?.conclusion).toBeNull();
  });

  it('returns an empty array when there is no run for the SHA (recorded fixture)', async () => {
    const adapter = createGitHubAdapter({ fetch: fetchFor('workflow-runs-absent') });
    const runs = await adapter.workflowRuns(REPO, 'ci.yml', NO_RUN_SHA);
    expect(runs).toEqual([]);
  });

  it('returns an empty array when the workflow file is unknown (404, recorded fixture)', async () => {
    const adapter = createGitHubAdapter({ fetch: fetchFor('workflow-runs-unknown-workflow') });
    const runs = await adapter.workflowRuns(REPO, 'does-not-exist.yml', SUCCESS_SHA);
    expect(runs).toEqual([]);
  });

  it('refuses naming GitHub on a bad token (401, recorded fixture)', async () => {
    const adapter = createGitHubAdapter({ token: 'bad', fetch: fetchFor('workflow-runs-unauthorized') });
    const err = await expectRefusal(adapter.workflowRuns(REPO, 'ci.yml', SUCCESS_SHA));
    expect(err.refusal.code).toBe('github_unreachable');
    expect(err.refusal.gate).toBe('none');
    expect(err.refusal.message).toContain('GitHub');
    expect(err.refusal.fix.toLowerCase()).toContain('token');
  });

  it('the path form (`.github/workflows/ci.yml`) resolves to the same request as the bare form (SHP-REQ-008)', async () => {
    const bareFetch = fetchFor('workflow-runs-success');
    const bareAdapter = createGitHubAdapter({ fetch: bareFetch });
    await bareAdapter.workflowRuns(REPO, 'ci.yml', SUCCESS_SHA);
    const bareUrl = (bareFetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;

    const pathFetch = fetchFor('workflow-runs-success-path-form');
    const pathAdapter = createGitHubAdapter({ fetch: pathFetch });
    const runs = await pathAdapter.workflowRuns(REPO, '.github/workflows/ci.yml', SUCCESS_SHA);
    const pathUrl = (pathFetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;

    // The raw (unencoded) path form 404s on GitHub's real API; the adapter must never send it.
    expect(pathUrl).not.toContain('.github/workflows/ci.yml');
    expect(pathUrl).toBe(bareUrl);
    expect(pathUrl).toContain('/actions/workflows/ci.yml/runs');

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ headSha: SUCCESS_SHA, conclusion: 'success' });
  });

  it('percent-encodes the repo owner and name in the request URL', async () => {
    const fetchStub = fetchFor('workflow-runs-absent');
    const adapter = createGitHubAdapter({ fetch: fetchStub });
    await adapter.workflowRuns('weird/repo name', 'ci.yml', NO_RUN_SHA);
    const url = (fetchStub as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).toContain('/repos/weird/repo%20name/');
  });

  it('follows Link: rel="next" and finds a success run on page 2 (synthetic fixtures)', async () => {
    const fetchStub = fetchFor('workflow-runs-paginated-page1', 'workflow-runs-paginated-page2');
    const adapter = createGitHubAdapter({ fetch: fetchStub });
    const runs = await adapter.workflowRuns(REPO, 'ci.yml', SUCCESS_SHA);
    expect((fetchStub as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(runs.some((r) => r.conclusion === 'success')).toBe(true);
  });

  it('refuses a pagination link to another origin rather than sending the token there', async () => {
    const page1 = new Response(JSON.stringify({ total_count: 40, workflow_runs: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json', link: '<https://evil.example.com/steal?page=2>; rel="next"' },
    });
    const fetchStub = vi.fn(() => Promise.resolve(page1));
    const adapter = createGitHubAdapter({ fetch: fetchStub as unknown as typeof fetch, token: 'pat-secret' });
    await expect(adapter.workflowRuns(REPO, 'ci.yml', SUCCESS_SHA)).rejects.toMatchObject({
      refusal: { code: 'github_unreachable' },
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('caps pagination at 5 pages and never fetches a 6th (synthetic fixtures)', async () => {
    const fetchStub = fetchFor(
      'workflow-runs-cap-page1',
      'workflow-runs-cap-page2',
      'workflow-runs-cap-page3',
      'workflow-runs-cap-page4',
      'workflow-runs-cap-page5',
    );
    const adapter = createGitHubAdapter({ fetch: fetchStub });
    const runs = await adapter.workflowRuns(REPO, 'ci.yml', SUCCESS_SHA);
    expect((fetchStub as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(5);
    expect(runs).toHaveLength(5);
    expect(runs.some((r) => r.conclusion === 'success')).toBe(false);
  });
});

describe('compare', () => {
  it('reports ahead (recorded fixture)', async () => {
    const adapter = createGitHubAdapter({ fetch: fetchFor('compare-ahead') });
    const cmp = await adapter.compare(REPO, OLDER_SHA, SUCCESS_SHA);
    expect(cmp).toMatchObject({ status: 'ahead', aheadBy: 2, behindBy: 0 });
    expect(cmp?.commits.length).toBeGreaterThan(0);
  });

  it('reports behind (recorded fixture)', async () => {
    const adapter = createGitHubAdapter({ fetch: fetchFor('compare-behind') });
    const cmp = await adapter.compare(REPO, SUCCESS_SHA, OLDER_SHA);
    expect(cmp).toMatchObject({ status: 'behind', aheadBy: 0, behindBy: 2 });
  });

  it('reports identical (recorded fixture)', async () => {
    const adapter = createGitHubAdapter({ fetch: fetchFor('compare-identical') });
    const cmp = await adapter.compare(REPO, SUCCESS_SHA, SUCCESS_SHA);
    expect(cmp).toMatchObject({ status: 'identical', aheadBy: 0, behindBy: 0 });
  });

  it('reports diverged (synthetic fixture, edited from a real ahead comparison)', async () => {
    const adapter = createGitHubAdapter({ fetch: fetchFor('compare-diverged') });
    const cmp = await adapter.compare(REPO, OLDER_SHA, SUCCESS_SHA);
    expect(cmp?.status).toBe('diverged');
  });

  it('returns null for an unknown SHA (404, recorded fixture)', async () => {
    const adapter = createGitHubAdapter({ fetch: fetchFor('compare-404') });
    const cmp = await adapter.compare(REPO, UNKNOWN_SHA, SUCCESS_SHA);
    expect(cmp).toBeNull();
  });
});

describe('unavailability (SHP-REQ-029): every path refuses naming GitHub with gate "none"', () => {
  const cases: { name: string; fixture: string }[] = [
    { name: '500', fixture: 'error-500' },
    { name: '502', fixture: 'error-502' },
    { name: '503', fixture: 'error-503' },
    { name: '429', fixture: 'error-429' },
    { name: 'rate-limited 403', fixture: 'ratelimited-403' },
    { name: 'malformed body (not JSON)', fixture: 'malformed-body' },
    { name: 'malformed body (unexpected shape)', fixture: 'malformed-shape' },
  ];

  for (const { name, fixture } of cases) {
    it(`workflowRuns refuses on ${name}`, async () => {
      const adapter = createGitHubAdapter({ fetch: fetchFor(fixture, fixture) });
      const err = await expectRefusal(adapter.workflowRuns(REPO, 'ci.yml', SUCCESS_SHA));
      expect(err.refusal.code).toBe('github_unreachable');
      expect(err.refusal.gate).toBe('none');
      expect(err.refusal.message).toContain('GitHub');
    });

    it(`compare refuses on ${name}`, async () => {
      const adapter = createGitHubAdapter({ fetch: fetchFor(fixture, fixture) });
      const err = await expectRefusal(adapter.compare(REPO, OLDER_SHA, SUCCESS_SHA));
      expect(err.refusal.code).toBe('github_unreachable');
      expect(err.refusal.gate).toBe('none');
      expect(err.refusal.message).toContain('GitHub');
    });
  }

  it('refuses naming GitHub on a network error, after one silent retry (no more)', async () => {
    let calls = 0;
    const fetchStub = vi.fn(() => {
      calls++;
      return Promise.reject(new Error('getaddrinfo ENOTFOUND api.github.com'));
    });
    const adapter = createGitHubAdapter({ fetch: fetchStub });
    const err = await expectRefusal(adapter.workflowRuns(REPO, 'ci.yml', SUCCESS_SHA));
    expect(err.refusal.code).toBe('github_unreachable');
    expect(err.refusal.message).toContain('GitHub');
    expect(calls).toBe(2); // one attempt, one retry, never more
  });

  it('succeeds after exactly one retry when the first attempt is a network error', async () => {
    let calls = 0;
    const fetchStub = vi.fn(() => {
      calls++;
      if (calls === 1) return Promise.reject(new Error('ECONNRESET'));
      return Promise.resolve(responseFromFixture(loadFixture('workflow-runs-success')));
    });
    const adapter = createGitHubAdapter({ fetch: fetchStub });
    const runs = await adapter.workflowRuns(REPO, 'ci.yml', SUCCESS_SHA);
    expect(runs).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('refuses naming GitHub on a timeout (AbortSignal)', async () => {
    const fetchStub = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const adapter = createGitHubAdapter({ fetch: fetchStub, timeoutMs: 5 });
    const err = await expectRefusal(adapter.workflowRuns(REPO, 'ci.yml', SUCCESS_SHA));
    expect(err.refusal.code).toBe('github_unreachable');
    expect(err.refusal.message.toLowerCase()).toContain('timed out');
    expect(err.refusal.message).toContain('GitHub');
  });
});

describe('parseTokenExpiry / tokenExpiresAt (SHP-REQ-094)', () => {
  it('is null before any response carries the header', () => {
    const adapter = createGitHubAdapter({ fetch: fetchFor('workflow-runs-success') });
    expect(adapter.tokenExpiresAt()).toBeNull();
  });

  it('parses the github-authentication-token-expiration header directly', () => {
    const headers = new Headers({ 'github-authentication-token-expiration': '2026-10-01 00:00:00 UTC' });
    const expiry = parseTokenExpiry(headers);
    expect(expiry).toBeInstanceOf(Date);
    expect(expiry?.getUTCFullYear()).toBe(2026);
  });

  it('is null when the header is absent', () => {
    expect(parseTokenExpiry(new Headers())).toBeNull();
  });

  it('exposes the last seen expiry via tokenExpiresAt() after a real request', async () => {
    const fetchStub = vi.fn(() => {
      // Fixture has no expiry header; add one via a fresh Response.
      const fixture = loadFixture('workflow-runs-success');
      return Promise.resolve(
        new Response(JSON.stringify(fixture.body), {
          status: fixture.status,
          headers: { ...fixture.headers, 'github-authentication-token-expiration': '2026-12-25 00:00:00 UTC' },
        }),
      );
    });
    const adapter = createGitHubAdapter({ token: 'x', fetch: fetchStub });
    await adapter.workflowRuns(REPO, 'ci.yml', SUCCESS_SHA);
    const expiry = adapter.tokenExpiresAt();
    expect(expiry).toBeInstanceOf(Date);
    expect(expiry?.getUTCMonth()).toBe(11);
  });
});
