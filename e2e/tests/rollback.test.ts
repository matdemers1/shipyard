import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Ledger, type SequencePorts } from '@shipyard/sequence';

// `machine.js` and `rollback.js` are imported by path until the lead exports them from the index.
import { runDeploy } from '../../packages/sequence/src/machine.js';
import { runRollback } from '../../packages/sequence/src/rollback.js';
import type { DeployResult } from '../../packages/sequence/src/types.js';
import { enginePorts, linearMainState, memoryLog, openContext, prepareToyDataRoot, readText, type ToyDataRoot } from '../harness/engine.js';
import { MANIFEST_REGISTRY, randomRevision, startHarness, type Harness, type ToyImage } from '../harness/harness.js';

/**
 * SHP-T-2.6's doneWhen against the real world (dind, registry:2, fake GitHub): a rollback to a
 * ledger entry succeeds and runs that entry's digest; a deploy ID the ledger does not hold is
 * refused; a rollback across a later contract release is refused, pointing at restore.
 */

const REPO = `${MANIFEST_REGISTRY}/toy/app`;

describe('rollback through the agent ledger against the dind harness', () => {
  let h: Harness | undefined;
  let paths: ToyDataRoot | undefined;
  let ports: SequencePorts;
  const logLines: string[] = [];

  const shas = Array.from({ length: 3 }, () => randomRevision());
  const [c1, c2, c3] = shas as [string, string, string];
  const built = new Map<string, ToyImage>();
  /** sha → the deploy ID that put it live. */
  const deployIds = new Map<string, string>();

  beforeAll(async () => {
    h = await startHarness();
    paths = await prepareToyDataRoot({ soakSeconds: 3 });
    ports = enginePorts({ dockerHost: h.dockerHost, fakeGithubUrl: h.fakeGithubUrl, registryHostPort: h.registryHostPort }, memoryLog(logLines));
    await h.setGithubState(linearMainState(shas));
    built.set(c1, await h.buildToyImage({ mode: 'pass', schema: 's1', revision: c1 }));
    built.set(c2, await h.buildToyImage({ mode: 'pass', schema: 's2', revision: c2 }));
    built.set(c3, await h.buildToyImage({ mode: 'pass', schema: 's3', revision: c3, contract: true }));
  });

  afterAll(async () => {
    if (paths !== undefined) {
      if (h !== undefined) await h.dind(['compose', '-f', paths.composePath, '-p', paths.project, 'down', '--timeout', '2']).catch(() => undefined);
      await paths.remove();
    }
    if (process.env.SHIPYARD_E2E_VERBOSE === '1') console.log(logLines.join('\n'));
    await h?.stop();
  });

  const dataRoot = (): ToyDataRoot => {
    if (paths === undefined) throw new Error('data root not prepared');
    return paths;
  };
  const digest = (sha: string): string => {
    const image = built.get(sha);
    if (image === undefined) throw new Error(`no image for ${sha}`);
    return image.digest;
  };
  const deployIdOf = (sha: string): string => {
    const id = deployIds.get(sha);
    if (id === undefined) throw new Error(`${sha} was never deployed`);
    return id;
  };

  const deploy = async (sha: string): Promise<DeployResult> => {
    const ctx = await openContext(ports, dataRoot());
    const deployId = `dep-${sha.slice(0, 8)}-${Date.now().toString(36)}`;
    const result = await runDeploy(ports, ctx, { deployId, kind: 'deploy', app: 'toy', sha, dryRun: false, requesterLabel: 'e2e' });
    if (result.state === 'succeeded') deployIds.set(sha, deployId);
    return result;
  };
  const rollbackTo = async (toDeployId: string): Promise<DeployResult> => {
    const ctx = await openContext(ports, dataRoot());
    return runRollback(ports, ctx, { deployId: `rb-${Date.now().toString(36)}`, app: 'toy', toDeployId, requesterLabel: 'e2e' });
  };

  const running = async (): Promise<{ digests: string[]; revision: string | undefined }> => {
    const containers = (await ports.docker.containers({ files: [dataRoot().composePath], project: dataRoot().project }, 'app')).filter(
      (c) => c.state === 'running',
    );
    expect(containers).toHaveLength(1);
    return { digests: containers[0]?.repoDigests ?? [], revision: containers[0]?.labels['org.opencontainers.image.revision'] };
  };

  it('deploy c1, deploy c2, roll back to c1 → succeeded, c1 running, the ledger ends in a rollback to c1', async () => {
    const first = await deploy(c1);
    expect(first.refusal, JSON.stringify(first.refusal)).toBeNull();
    expect(first.state).toBe('succeeded');
    const second = await deploy(c2);
    expect(second.refusal, JSON.stringify(second.refusal)).toBeNull();
    expect(second.state).toBe('succeeded');

    const result = await rollbackTo(deployIdOf(c1));
    expect(result.refusal, JSON.stringify(result.refusal)).toBeNull();
    expect(result.state).toBe('succeeded');
    expect(result.schemaRevision).toBe('s1');
    // Image-only: the manifest's migrate step does not run.
    expect(result.steps.map((s) => s.name)).toEqual(['verify', 'pull', 'swap', 'check', 'soak']);
    expect(result.gates.map((g) => g.gate)).toEqual(['disk', 'G8', 'G10']);

    const now = await running();
    expect(now.digests).toContain(`${REPO}@${digest(c1)}`);
    expect(now.revision).toBe(c1);
    expect(await readText(dataRoot().composePath)).toContain(`image: ${REPO}:sha-${c1}@${digest(c1)}`);

    const ledger = await Ledger.open(ports.fs, dataRoot().ledgerPath);
    expect(ledger.last('toy')).toMatchObject({
      deployId: result.deployId,
      kind: 'rollback',
      sha: c1,
      images: [{ service: 'app', repo: REPO, digest: digest(c1) }],
    });
  });

  it('a deploy ID the ledger does not hold is refused (rollback_target_invalid) and nothing moves', async () => {
    const before = await readText(dataRoot().composePath);
    const result = await rollbackTo(`dep-${randomRevision().slice(0, 12)}`);
    expect(result.state).toBe('refused');
    expect(result.refusal?.code).toBe('rollback_target_invalid');
    expect(result.refusal?.message).toContain(deployIdOf(c2));
    expect(await readText(dataRoot().composePath)).toBe(before);
    expect((await running()).digests).toContain(`${REPO}@${digest(c1)}`);
  });

  it('deploy c3 (contract), then roll back to c2 → refused (later_contract_release), pointing at restore', async () => {
    const third = await deploy(c3);
    expect(third.refusal, JSON.stringify(third.refusal)).toBeNull();
    expect(third.state).toBe('succeeded');
    expect(third.images[0]?.migration).toBe('contract');

    const before = await readText(dataRoot().composePath);
    const result = await rollbackTo(deployIdOf(c2));
    expect(result.state).toBe('refused');
    expect(result.refusal?.code).toBe('later_contract_release');
    expect(result.refusal?.fix).toContain('restore');
    expect(await readText(dataRoot().composePath)).toBe(before);

    const now = await running();
    expect(now.digests).toContain(`${REPO}@${digest(c3)}`);
    const ledger = await Ledger.open(ports.fs, dataRoot().ledgerPath);
    expect(ledger.last('toy')).toMatchObject({ kind: 'deploy', sha: c3 });
  });
});
