import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import { Ledger, LABEL_MIGRATION, type SequencePorts } from '@shipyard/sequence';

// Imported by path, as the other engine-driven tests do.
import { runDeploy } from '../../packages/sequence/src/machine.js';
import { runRestore } from '../../packages/sequence/src/restore.js';
import type { DeployResult } from '../../packages/sequence/src/types.js';
import { enginePorts, linearMainState, memoryLog, openContext, prepareToyDataRoot, readText, type ToyDataRoot } from '../harness/engine.js';
import { MANIFEST_REGISTRY, randomRevision, startHarness, type Harness, type ToyImage } from '../harness/harness.js';

/**
 * SHP-T-5.6's doneWhen against the real world (dind, registry:2, fake GitHub): a contract-labelled
 * release whose check fails stops `failed` on the new image, keeping the backup it took before its
 * migration; a guided restore of that backup — the agent's side of what the console's confirmed
 * request starts — takes a safety backup, runs the toy's own restore command, puts the earlier
 * release's images back, and passes check and soak. The data on disk is the earlier release's again,
 * and a second restore within 24 hours is refused.
 *
 * The toy stack bind-mounts `/data` and `/backups` under the harness's shared directory, which dind
 * mounts at the same path, so the engine (running here, as the agent would on the host) sees the
 * artifacts the backup step writes.
 */

const REPO = `${MANIFEST_REGISTRY}/toy/app`;

/** The toy stack's compose files: its own, then the data/backups mounts. */
const stackFiles = (root: ToyDataRoot): string[] => [root.composePath, join(dirname(root.composePath), 'data.yml')];

describe('guided restore after a failed contract release, against the dind harness', () => {
  let h: Harness | undefined;
  let paths: ToyDataRoot | undefined;
  let ports: SequencePorts;
  let dataDir = '';
  let backupsDir = '';
  const logLines: string[] = [];

  const [c1, c2] = [randomRevision(), randomRevision()];
  const built = new Map<string, ToyImage>();
  const deployIds = new Map<string, string>();

  beforeAll(async () => {
    h = await startHarness();
    dataDir = join(h.sharedDir, 'data');
    backupsDir = join(h.sharedDir, 'backups');
    for (const dir of [dataDir, backupsDir]) {
      await mkdir(dir, { recursive: true });
      // The toy runs as `node`; the directories are the test's.
      await chmod(dir, 0o777);
    }
    const volumes = ['services:', '  app:', '    volumes:', `      - ${dataDir}:/data`, `      - ${backupsDir}:/backups`, ''].join('\n');
    paths = await prepareToyDataRoot({ soakSeconds: 3, extraComposeFiles: { 'data.yml': volumes } });
    ports = enginePorts({ dockerHost: h.dockerHost, fakeGithubUrl: h.fakeGithubUrl, registryHostPort: h.registryHostPort }, memoryLog(logLines));
    await h.setGithubState(linearMainState([c1, c2]));
    built.set(c1, await h.buildToyImage({ mode: 'pass', schema: 's1', revision: c1 }));
    built.set(c2, await h.buildToyImage({ mode: 'fail-health', schema: 's2', revision: c2, contract: true }));
  });

  afterAll(async () => {
    if (paths !== undefined) {
      if (h !== undefined) {
        await h.dind(['compose', ...stackFiles(paths).flatMap((f) => ['-f', f]), '-p', paths.project, 'down', '--timeout', '2']).catch(() => undefined);
      }
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
  const state = async (): Promise<unknown> => JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8')) as unknown;

  /** Adds the toy's backup and restore steps to the host manifest (after the first deploy, which has nothing running to back up). */
  const enableBackupAndRestore = async (): Promise<void> => {
    const file = join(dataRoot().dataRoot, 'apps', 'toy.yml');
    const manifest = parse(await readFile(file, 'utf8')) as { steps: Record<string, unknown> };
    manifest.steps = {
      ...manifest.steps,
      backup: { service: 'app', argv: ['node', 'backup.mjs'], artifactsDir: backupsDir },
      restore: { service: 'app', argv: ['node', 'restore.mjs', '/backups/{artifact}'] },
    };
    await writeFile(file, stringify(manifest), 'utf8');
  };

  const deploy = async (sha: string): Promise<DeployResult> => {
    const ctx = await openContext(ports, dataRoot());
    const deployId = `dep-${sha.slice(0, 8)}-${Date.now().toString(36)}`;
    deployIds.set(sha, deployId);
    return runDeploy(ports, ctx, { deployId, kind: 'deploy', app: 'toy', sha, dryRun: false, requesterLabel: 'e2e' });
  };
  const restoreBackupOf = async (backupOf: string, dryRun = false): Promise<DeployResult> => {
    const ctx = await openContext(ports, dataRoot());
    return runRestore(ports, ctx, { deployId: `rs-${Date.now().toString(36)}`, app: 'toy', backupOf, requesterLabel: 'matt (console)', dryRun });
  };
  const running = async (): Promise<{ digests: string[]; revision: string | undefined }> => {
    const containers = (await ports.docker.containers({ files: stackFiles(dataRoot()), project: dataRoot().project }, 'app')).filter(
      (c) => c.state === 'running',
    );
    expect(containers).toHaveLength(1);
    return { digests: containers[0]?.repoDigests ?? [], revision: containers[0]?.labels['org.opencontainers.image.revision'] };
  };

  it('c1 deploys and its migration writes schema s1 to the data directory', async () => {
    const first = await deploy(c1);
    expect(first.refusal, JSON.stringify(first.refusal)).toBeNull();
    expect(first.state).toBe('succeeded');
    expect(await state()).toEqual({ schema: 's1' });
  });

  it('c2 (contract) backs up, migrates to s2, fails health and stops failed on the new image, keeping its backup', async () => {
    await enableBackupAndRestore();
    const result = await deploy(c2);
    expect(result.images[0]?.labels[LABEL_MIGRATION]).toBe('contract');
    expect(result.state).toBe('failed');
    expect(result.refusal?.code).toBe('health_failed');
    expect(result.refusal?.fix).toContain('restore the kept backup');
    expect(result.steps.map((s) => s.name)).not.toContain('rollback');
    expect(result.backupArtifact).not.toBeNull();

    expect((await running()).digests).toContain(`${REPO}@${digest(c2)}`);
    expect(await state()).toEqual({ schema: 's2' });
    expect(JSON.parse(await readFile(result.backupArtifact ?? '', 'utf8'))).toEqual({ schema: 's1' });

    // Not a release, but its backup is in the ledger, matched to c1 — the only kind restore may use.
    const ledger = await Ledger.open(ports.fs, dataRoot().ledgerPath);
    expect(ledger.last('toy')?.sha).toBe(c1);
    expect(ledger.backupArtifacts('toy')).toMatchObject([{ deployId: deployIdOf(c2), backupArtifact: result.backupArtifact, release: deployIdOf(c1) }]);
  });

  it('a dry run of the restore reports the backup, the loss window and the release, and changes nothing', async () => {
    const before = await readText(dataRoot().composePath);
    const result = await restoreBackupOf(deployIdOf(c2), true);
    expect(result.refusal, JSON.stringify(result.refusal)).toBeNull();
    expect(result.state).toBe('verifying');
    expect(result.steps[0]?.output).toContain('would be lost');
    expect(result.steps[0]?.output).toContain(c1.slice(0, 7));
    expect(await readText(dataRoot().composePath)).toBe(before);
    expect(await state()).toEqual({ schema: 's2' });
  });

  it('restoring the backup c2 took brings c1 back with its data: succeeded, check and soak passed', async () => {
    const result = await restoreBackupOf(deployIdOf(c2));
    expect(result.refusal, JSON.stringify(result.refusal)).toBeNull();
    expect(result.state).toBe('succeeded');
    expect(result.sha).toBe(c1);
    expect(result.schemaRevision).toBe('s1');
    expect(result.steps.map((s) => s.name)).toEqual(['verify', 'backup', 'restore', 'pull', 'swap', 'check', 'soak']);

    // The data is c1's again, the code is c1's again.
    expect(await state()).toEqual({ schema: 's1' });
    const now = await running();
    expect(now.digests).toContain(`${REPO}@${digest(c1)}`);
    expect(now.revision).toBe(c1);
    expect(await readText(dataRoot().composePath)).toContain(`image: ${REPO}:sha-${c1}@${digest(c1)}`);

    // The safety backup holds the data as it was just before: c2's.
    expect(result.backupArtifact).not.toBeNull();
    expect(JSON.parse(await readFile(result.backupArtifact ?? '', 'utf8'))).toEqual({ schema: 's2' });

    const ledger = await Ledger.open(ports.fs, dataRoot().ledgerPath);
    expect(ledger.restores('toy')).toMatchObject([{ deployId: result.deployId, backupOf: deployIdOf(c2), release: deployIdOf(c1), sha: c1 }]);
  });

  it('a second restore within 24 hours is refused (restore_limited) and nothing moves', async () => {
    const before = await readText(dataRoot().composePath);
    const result = await restoreBackupOf(deployIdOf(c2));
    expect(result.state).toBe('refused');
    expect(result.refusal?.code).toBe('restore_limited');
    expect(await readText(dataRoot().composePath)).toBe(before);
    expect(await state()).toEqual({ schema: 's1' });
  });

  it('a deploy ID with no backup in the ledger is refused (restore_limited)', async () => {
    const result = await restoreBackupOf(deployIdOf(c1));
    expect(result.state).toBe('refused');
    expect(result.refusal?.code).toBe('restore_limited');
  });
});
