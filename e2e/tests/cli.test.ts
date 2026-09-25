import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ledger, nodeFs } from '@shipyard/sequence';

import { linearMainState, prepareToyDataRoot, type ToyDataRoot } from '../harness/engine.js';
import { MANIFEST_REGISTRY, randomRevision, startHarness, type Harness, type ToyImage } from '../harness/harness.js';
import { run, runRaw, type RawResult } from '../harness/exec.js';

/**
 * SHP-T-1.12's doneWhen: the host CLI drives the same `@shipyard/sequence` engine the agent uses,
 * as a real spawned process, against the real dind/registry/fake-GitHub harness. Nothing here
 * reaches into the engine's internals — only argv, env and stdout/stderr, exactly what a real
 * caller of `shipyard-run` gets.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI_DIST = join(REPO_ROOT, 'apps/cli/dist/index.js');

describe('shipyard-run deploy (spawned process) against the dind harness', () => {
  let h: Harness | undefined;
  let paths: ToyDataRoot | undefined;

  const c1 = randomRevision();
  const c2 = randomRevision();
  const built = new Map<string, ToyImage>();

  beforeAll(async () => {
    // Build the real CLI once; `shipyard-cli`'s own build script builds `@shipyard/sequence` (and
    // that builds `@shipyard/schema`) first, so this is the whole dependency chain.
    await run('pnpm', ['--filter', 'shipyard-cli', 'build'], { cwd: REPO_ROOT, timeoutMs: 180_000 });

    h = await startHarness();
    paths = await prepareToyDataRoot({ soakSeconds: 2 });
    await h.setGithubState(linearMainState([c1, c2]));

    built.set(c1, await h.buildToyImage({ mode: 'pass', schema: 's1', revision: c1 }));
    built.set(c2, await h.buildToyImage({ mode: 'pass', schema: 's2', revision: c2 }));
  }, 300_000);

  afterAll(async () => {
    if (h !== undefined && paths !== undefined) {
      await h.dind(['compose', '-f', paths.composePath, '-p', paths.project, 'down', '--timeout', '2']).catch(() => undefined);
    }
    await paths?.remove();
    await h?.stop();
  });

  const harness = (): Harness => {
    if (h === undefined) throw new Error('harness did not start');
    return h;
  };
  const dataRoot = (): ToyDataRoot => {
    if (paths === undefined) throw new Error('data root not prepared');
    return paths;
  };

  const runCli = async (args: string[]): Promise<RawResult> => {
    const hh = harness();
    return runRaw(process.execPath, [CLI_DIST, ...args], {
      timeoutMs: 120_000,
      env: {
        ...process.env,
        SHIPYARD_DATA_ROOT: dataRoot().dataRoot,
        DOCKER_HOST: hh.dockerHost,
        SHIPYARD_GITHUB_API: hh.fakeGithubUrl,
        SHIPYARD_REGISTRY_ALIAS: `${MANIFEST_REGISTRY}=127.0.0.1:${String(hh.registryHostPort)}`,
      },
    });
  };

  it('deploys a SHA ahead of live: exit 0, prints the digest, and the ledger records it', async () => {
    const first = await runCli(['deploy', 'toy', c1]);
    expect(first.stderr + first.stdout, first.stdout + first.stderr).not.toContain('Error:');
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('state: succeeded');

    const image2 = built.get(c2);
    if (image2 === undefined) throw new Error('c2 was not built');

    const second = await runCli(['deploy', 'toy', c2]);
    expect(second.code, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`).toBe(0);
    expect(second.stdout).toContain('state: succeeded');
    expect(second.stdout).toContain(`app ${MANIFEST_REGISTRY}/toy/app@${image2.digest}`);
    expect(second.stdout).toContain('schema: s2');

    const ledger = await Ledger.open(nodeFs(), dataRoot().ledgerPath);
    const last = ledger.last('toy');
    expect(last?.sha).toBe(c2);
    expect(last?.images[0]?.digest).toBe(image2.digest);
  }, 180_000);

  it('refuses a SHA older than live: exit 2 with not_ahead_of_live', async () => {
    const result = await runCli(['deploy', 'toy', c1]);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('not_ahead_of_live');
    expect(result.stdout).toContain('state: refused');

    // Nothing moved: live is still c2.
    const ledger = await Ledger.open(nodeFs(), dataRoot().ledgerPath);
    expect(ledger.last('toy')?.sha).toBe(c2);
  }, 60_000);
});
