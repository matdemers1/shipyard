import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CompareBody, RunsBody } from '../fake-github/logic.mjs';
import { randomRevision, startHarness, TOY_MANIFEST, type Harness } from '../harness/harness.js';

const SCHEMA = '20260924-0001'; // matches health.expectSchema in toy-app/manifest.yml

describe('e2e harness smoke', () => {
  let h: Harness | undefined;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.stop();
  });

  const harness = (): Harness => {
    if (h === undefined) throw new Error('harness did not start');
    return h;
  };

  it('builds the toy app into the local registry and deploys it from the manifest', async () => {
    const revision = randomRevision();
    const image = await harness().buildToyImage({ mode: 'pass', schema: SCHEMA, revision });
    expect(image.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const d = await harness().deployFromManifest(TOY_MANIFEST, revision);

    expect(d.imageLine).toBe(`registry:5000/toy/app:sha-${revision}@${image.digest}`);
    expect(d.migrate?.stdout).toContain(`migrated to schema ${SCHEMA}`);

    expect(d.health.status).toBe(200);
    expect(d.health.json).toEqual({ status: 'ok', schemaRevision: d.manifest.health.expectSchema });
    expect(d.manifest.health.expectSchema).toBe(SCHEMA);

    expect(d.runningRepoDigests).toContain(`registry:5000/toy/app@${image.digest}`);
    expect(d.revisionLabel).toBe(revision);
    expect(d.labels['dev.d3cloud.shipyard.migration']).toBeUndefined();
  });

  it('serves actions/runs and compare from the state it was given', async () => {
    const [base, head, other] = [randomRevision(), randomRevision(), randomRevision()];
    await harness().setGithubState({
      repos: {
        'example/toy': {
          runs: { [head]: [{ workflow: 'ci.yml', conclusion: 'success', id: 42 }] },
          branches: {
            main: [
              { sha: base, parent: null },
              { sha: head, parent: base },
            ],
            side: [{ sha: other, parent: base }],
          },
        },
      },
    });
    const gh = harness().fakeGithubUrl;

    const runs = await fetch(`${gh}/repos/example/toy/actions/runs?head_sha=${head}`, {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(runs.status).toBe(200);
    const runsBody = (await runs.json()) as RunsBody;
    expect(runsBody.total_count).toBe(1);
    expect(runsBody.workflow_runs[0]).toMatchObject({
      id: 42,
      head_sha: head,
      path: '.github/workflows/ci.yml',
      conclusion: 'success',
      status: 'completed',
      event: 'push',
      head_branch: 'main',
    });

    const ahead = (await (await fetch(`${gh}/repos/example/toy/compare/${base}...${head}`)).json()) as CompareBody;
    expect(ahead).toMatchObject({ status: 'ahead', ahead_by: 1, behind_by: 0, commits: [{ sha: head }] });
    const diverged = (await (await fetch(`${gh}/repos/example/toy/compare/${head}...${other}`)).json()) as CompareBody;
    expect(diverged).toMatchObject({ status: 'diverged', ahead_by: 1, behind_by: 1 });
    expect((await fetch(`${gh}/repos/example/toy/compare/${base}...${'f'.repeat(40)}`)).status).toBe(404);

    const seen = await harness().githubRequests();
    expect(seen[0]).toMatchObject({
      method: 'GET',
      url: `/repos/example/toy/actions/runs?head_sha=${head}`,
      authorization: 'Bearer test-token',
    });
    expect(seen).toHaveLength(4);
  });
});
