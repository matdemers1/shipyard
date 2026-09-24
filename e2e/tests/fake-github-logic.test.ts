import { describe, expect, it } from 'vitest';
import { compare, listRuns, normalizeState, route, type CompareBody, type RunsBody } from '../fake-github/logic.mjs';

const sha = (c: string): string => c.repeat(40);
const A = sha('a');
const B = sha('b');
const C = sha('c');
const D = sha('d');
const E = sha('e');

// main: A <- B <- C ; feature: B <- D <- E
const state = normalizeState({
  repos: {
    'example/toy': {
      runs: {
        [C]: [
          { workflow: 'ci.yml', conclusion: 'success' },
          { workflow: 'lint.yml', conclusion: 'failure' },
        ],
        [B]: [{ workflow: 'ci.yml', status: 'in_progress', conclusion: null }],
      },
      branches: {
        main: [
          { sha: A, parent: null },
          { sha: B, parent: A },
          { sha: C, parent: B },
        ],
        feature: [
          { sha: D, parent: B },
          { sha: E, parent: D },
        ],
      },
    },
  },
});

describe('fake GitHub logic', () => {
  it('lists runs for a head_sha in GitHub shape', () => {
    const reply = listRuns(state, 'example/toy', new URLSearchParams({ head_sha: C }));
    expect(reply.status).toBe(200);
    const body = reply.body as RunsBody;
    expect(body.total_count).toBe(2);
    expect(body.workflow_runs.map((r) => r.path).sort()).toEqual([
      '.github/workflows/ci.yml',
      '.github/workflows/lint.yml',
    ]);
    expect(body.workflow_runs.every((r) => r.head_sha === C && r.event === 'push' && r.head_branch === 'main')).toBe(
      true,
    );
  });

  it('keeps an in-progress run with a null conclusion', () => {
    const body = listRuns(state, 'example/toy', new URLSearchParams({ head_sha: B })).body as RunsBody;
    expect(body.workflow_runs[0]).toMatchObject({ status: 'in_progress', conclusion: null });
  });

  it('answers 404 for an unknown repo', () => {
    expect(listRuns(state, 'example/other', new URLSearchParams()).status).toBe(404);
  });

  it.each([
    [A, C, 'ahead', 2, 0, [B, C]],
    [C, A, 'behind', 0, 2, []],
    [C, C, 'identical', 0, 0, []],
    [C, E, 'diverged', 2, 1, [D, E]],
  ] as const)('compare %s...%s is %s', (base, head, status, ahead, behind, commits) => {
    const reply = compare(state, 'example/toy', base, head);
    expect(reply.status).toBe(200);
    const body = reply.body as CompareBody;
    expect(body).toMatchObject({ status, ahead_by: ahead, behind_by: behind });
    expect(body.commits.map((c) => c.sha)).toEqual(commits);
  });

  it('resolves a branch name to its tip', () => {
    expect((compare(state, 'example/toy', 'main', E).body as CompareBody).status).toBe('diverged');
    expect((compare(state, 'example/toy', B, 'main').body as CompareBody).ahead_by).toBe(1);
  });

  it('answers 404 for an unknown commit', () => {
    expect(compare(state, 'example/toy', A, sha('f')).status).toBe(404);
  });

  it('routes URLs the way the server receives them', () => {
    expect(route(state, 'GET', `/repos/example/toy/actions/runs?head_sha=${C}`).status).toBe(200);
    expect((route(state, 'GET', `/repos/example/toy/compare/${A}...${C}`).body as CompareBody).status).toBe('ahead');
    expect(route(state, 'POST', '/repos/example/toy/actions/runs').status).toBe(405);
    expect(route(state, 'GET', '/nope').status).toBe(404);
  });

  it('rejects a state that is not shaped right', () => {
    expect(() => normalizeState({})).toThrow(/repos/);
    expect(() => normalizeState({ repos: { 'example/toy': { runs: { abc: [] } } } })).toThrow(/40-hex/);
    expect(() =>
      normalizeState({ repos: { 'example/toy': { branches: { main: [{ sha: A, parent: 'x' }] } } } }),
    ).toThrow(/parent/);
  });
});
