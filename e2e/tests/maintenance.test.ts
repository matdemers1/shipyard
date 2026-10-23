import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { MaintenanceResult, type MaintenanceJob } from '@shipyard/schema';
import {
  Journal,
  Ledger,
  createDockerAdapter,
  loadManifests,
  loadStacks,
  nodeArchiveFiles,
  nodeFs,
  runMaintenance,
  systemClock,
  type MaintenanceContext,
  type MaintenancePorts,
} from '@shipyard/sequence';

import type { AgentClient } from '../../apps/agent/src/client.js';
import { createMaintenanceRunner, maintenanceResultPath } from '../../apps/agent/src/maintenance.js';
import { memoryLog } from '../harness/engine.js';
import { pipe, run, runRaw } from '../harness/exec.js';
import { startHarness, type Harness } from '../harness/harness.js';

/**
 * SHP-T-17.2 (SHP-ADR-012; SHP-REQ-201, SHP-REQ-202, SHP-REQ-203, SHP-REQ-205), run by the lead:
 * the agent's maintenance runner and engine against the real dind daemon.
 *
 * The archive helper is the agent's runtime base with zstd added, exactly as `apps/agent/Dockerfile`
 * adds it, built on the host and loaded into dind — the agent never pulls a helper. The backup root
 * is under the harness's shared directory, which dind sees at the same path (SHP-D-053), so the
 * helper writes where the agent hashes.
 *
 * 1. A toy stack whose named volume holds `original` is backed up (quiesced), the file is changed,
 *    and a restore from the archive puts `original` back; the stack runs again afterwards.
 * 2. Deleting a volume a stopped container mounts is refused `volume_in_use`; once that container is
 *    gone, the delete succeeds.
 * 3. A prune dry run lists a dangling image, and the real prune from that dry run removes it.
 */

const HELPER_DOCKERFILE = [
  'FROM node:22-trixie-slim',
  'RUN apt-get update && apt-get install -y --no-install-recommends zstd && rm -rf /var/lib/apt/lists/*',
  '',
].join('\n');

function recordingClient(): AgentClient & { posted: { path: string; body: unknown }[] } {
  const posted: { path: string; body: unknown }[] = [];
  return {
    posted,
    request(_method, path, body) {
      posted.push({ path, body });
      return Promise.resolve({ ok: true });
    },
  };
}

describe('volume backup, restore, delete and prune on a real Docker host', () => {
  let h: Harness | undefined;
  let root: string | undefined;
  let hostTag = '';
  let helperTag = '';
  let imageId = '';
  let composePath = '';
  let project = '';
  let volume = '';
  let dataRoot = '';
  let backupRoot = '';
  const logLines: string[] = [];
  const containersMade: string[] = [];
  let runner: ReturnType<typeof createMaintenanceRunner> | undefined;
  /** The compose project the "agent" runs in; the toy stack's own in the self-guard case. */
  let ownProject: string | null = null;
  const client = recordingClient();

  const harness = (): Harness => {
    if (h === undefined) throw new Error('harness did not start');
    return h;
  };
  const compose = (args: string[]) => harness().dind(['compose', '-f', composePath, '-p', project, ...args]);
  const readState = async (): Promise<string> => (await compose(['exec', '-T', 'app', 'cat', '/data/state.txt'])).stdout.trim();
  const writeState = async (text: string): Promise<void> => {
    await compose(['exec', '-T', 'app', 'node', '-e', `require('fs').writeFileSync('/data/state.txt', ${JSON.stringify(text)})`]);
  };
  const runJob = async (job: MaintenanceJob): Promise<MaintenanceResult> => {
    if (runner === undefined) throw new Error('runner did not start');
    const result = await runner.run(job);
    // A failing case says why: the refusal and the agent's own account.
    if (result.state !== 'succeeded') console.error(`${job.kind} ${result.state}: ${JSON.stringify(result.refusal)}\n${result.output ?? ''}`);
    // What the server would have received, and it parses.
    const posted = client.posted.filter((p) => p.path === maintenanceResultPath(job.jobId)).at(-1);
    expect(MaintenanceResult.parse(posted?.body)).toEqual(result);
    return result;
  };

  beforeAll(async () => {
    h = await startHarness();
    const hex = randomBytes(3).toString('hex');

    // The helper: the agent's runtime base plus zstd, built on the host, handed to dind.
    const buildDir = await mkdtemp(join(tmpdir(), 'shp-e2e-helper-'));
    await writeFile(join(buildDir, 'Dockerfile'), HELPER_DOCKERFILE, 'utf8');
    hostTag = `shipyard-e2e/maintenance-helper:${hex}`;
    await run('docker', ['build', '--provenance=false', '--tag', hostTag, buildDir], { timeoutMs: 600_000 });
    await rm(buildDir, { recursive: true, force: true });
    await pipe(['save', hostTag], process.env, ['load', '--quiet'], h.dindEnv());
    helperTag = hostTag;
    imageId = (await h.dind(['image', 'inspect', '--format', '{{.Id}}', helperTag])).stdout.trim();
    expect(imageId).toMatch(/^sha256:[0-9a-f]{64}$/);

    // A data root anywhere; the backup root where dind sees the same path.
    root = await mkdtemp(join(h.sharedDir, 'maint-'));
    dataRoot = join(root, 'data');
    backupRoot = join(root, 'backups');
    // A data root as the agent's host has it: app manifests under apps/ (none here), stacks/.
    await mkdir(join(dataRoot, 'apps'), { recursive: true });
    await mkdir(join(dataRoot, 'stacks'), { recursive: true });
    await mkdir(join(dataRoot, 'agent'), { recursive: true });
    await mkdir(join(root, 'stack'), { recursive: true });
    project = `maint-${hex}`;
    volume = `${project}_data`;
    composePath = join(root, 'stack', 'compose.yml');
    await writeFile(
      composePath,
      ['services:', '  app:', `    image: ${helperTag}`, '    command: ["sleep", "infinity"]', '    volumes: [data:/data]', 'volumes:', '  data: {}', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(dataRoot, 'stacks', 'toy.yml'),
      stringify({ kind: 'stack', name: 'toy', compose: { files: [composePath], project }, volumeBackups: { retain: 3, quiesce: true } }),
      'utf8',
    );
    await compose(['up', '-d', '--wait']);
    await writeState('original');

    // Wired the way apps/agent/src/index.ts wires it, minus the poll loop.
    const fs = nodeFs();
    const clock = systemClock();
    const log = memoryLog(logLines);
    const ports: MaintenancePorts = { docker: createDockerAdapter({ dockerHost: h.dockerHost }), fs, files: nodeArchiveFiles(), clock, log };
    const journal = new Journal(fs, join(dataRoot, 'agent', 'journal.jsonl'), clock, log);
    const ledger = await Ledger.open(fs, join(dataRoot, 'agent', 'ledger.jsonl'));
    runner = createMaintenanceRunner({
      client,
      execute: async (job, onStep): Promise<MaintenanceResult> => {
        const ctx: MaintenanceContext = {
          dataRoot,
          backupRoot,
          apps: await loadManifests(fs, dataRoot),
          stacks: await loadStacks(fs, dataRoot),
          journal,
          ledger,
          helperImage: () => Promise.resolve(imageId),
          ownProject: () => Promise.resolve(ownProject),
          onStep,
        };
        return runMaintenance(ports, ctx, job);
      },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
  });

  afterAll(async () => {
    if (h !== undefined) {
      for (const name of containersMade) await h.dind(['rm', '--force', name]).catch(() => undefined);
      if (composePath !== '') await compose(['down', '--volumes', '--timeout', '2']).catch(() => undefined);
      await h.stop();
    }
    if (hostTag !== '') await runRaw('docker', ['image', 'rm', hostTag]);
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it('backs a volume up, and a restore from that archive puts the original data back (SHP-REQ-201, SHP-REQ-202)', async () => {
    const backup = await runJob({ jobId: randomUUID(), kind: 'volume-backup', volume, owner: { kind: 'stack', name: 'toy' }, quiesce: true });
    expect(backup, logLines.join('\n')).toMatchObject({ state: 'succeeded', archive: { volume, quiesced: true, owner: { kind: 'stack', name: 'toy' } } });
    const archiveId = backup.archive?.archiveId ?? '';

    // The archive is where the agent put it, and hashes to what it reported.
    const ledger = await Ledger.open(nodeFs(), join(dataRoot, 'agent', 'ledger.jsonl'));
    const file = ledger.volumeArchive(archiveId)?.file ?? '';
    expect(file).toMatch(new RegExp(`^${backupRoot}/volumes/${volume}/\\d{8}T\\d{6}Z\\.tar\\.zst$`));
    expect(createHash('sha256').update(await readFile(file)).digest('hex')).toBe(backup.archive?.sha256);
    // The stack was started again after the quiesced backup.
    expect(await readState()).toBe('original');

    await writeState('changed');
    expect(await readState()).toBe('changed');

    const restore = await runJob({ jobId: randomUUID(), kind: 'volume-restore', volume, owner: { kind: 'stack', name: 'toy' }, archiveId });
    expect(restore, logLines.join('\n')).toMatchObject({ state: 'succeeded' });
    expect(await readState()).toBe('original');
    // The safety archive of "changed" is in the ledger and named in the output.
    const after = await Ledger.open(nodeFs(), join(dataRoot, 'agent', 'ledger.jsonl'));
    const safety = after.volumeArchives(volume).at(-1);
    expect(safety?.archiveId).not.toBe(archiveId);
    expect(restore.output).toContain(safety?.archiveId ?? 'missing');
  });

  it("never stops the agent's own stack: a restore or a quiesced backup of it is refused, a plain backup is not", async () => {
    const ledger = await Ledger.open(nodeFs(), join(dataRoot, 'agent', 'ledger.jsonl'));
    const archiveId = ledger.volumeArchives(volume).at(-1)?.archiveId ?? '';
    expect(archiveId).not.toBe('');
    ownProject = project;
    try {
      const restore = await runJob({ jobId: randomUUID(), kind: 'volume-restore', volume, owner: { kind: 'stack', name: 'toy' }, archiveId });
      expect(restore).toMatchObject({ state: 'refused', refusal: { code: 'locked' } });
      const quiesced = await runJob({ jobId: randomUUID(), kind: 'volume-backup', volume, owner: { kind: 'stack', name: 'toy' }, quiesce: true });
      expect(quiesced).toMatchObject({ state: 'refused', refusal: { code: 'locked' } });
      // Nothing was stopped.
      const states = (await compose(['ps', '--all', '--format', '{{.State}}'])).stdout.trim().split('\n');
      expect(states).toEqual(['running']);
      const plain = await runJob({ jobId: randomUUID(), kind: 'volume-backup', volume, owner: { kind: 'stack', name: 'toy' }, quiesce: false });
      expect(plain).toMatchObject({ state: 'succeeded', archive: { quiesced: false } });
    } finally {
      ownProject = null;
    }
  });

  it('refuses to delete a volume a stopped container mounts, and deletes it once nothing does (SHP-REQ-203)', async () => {
    const orphan = `maint-orphan-${randomBytes(3).toString('hex')}`;
    const holder = `maint-holder-${randomBytes(3).toString('hex')}`;
    containersMade.push(holder);
    await harness().dind(['create', '--name', holder, '-v', `${orphan}:/x`, helperTag, 'true']);

    const refused = await runJob({ jobId: randomUUID(), kind: 'volume-delete', volume: orphan });
    expect(refused).toMatchObject({ state: 'refused', refusal: { code: 'volume_in_use' } });
    expect(refused.refusal?.message).toContain(holder);
    await harness().dind(['volume', 'inspect', orphan]);

    await harness().dind(['rm', holder]);
    const deleted = await runJob({ jobId: randomUUID(), kind: 'volume-delete', volume: orphan });
    expect(deleted).toMatchObject({ state: 'succeeded' });
    expect((await runRaw('docker', ['volume', 'inspect', orphan], { env: harness().dindEnv() })).code).not.toBe(0);
  });

  it('a prune dry run lists a dangling image; the real prune from it removes it (SHP-REQ-205)', async () => {
    // Two commits under one tag: the first is left with no tag and no digest — dangling.
    const source = `maint-source-${randomBytes(3).toString('hex')}`;
    containersMade.push(source);
    await harness().dind(['create', '--name', source, helperTag, 'true']);
    const tag = `shipyard-e2e/dangle:${randomBytes(3).toString('hex')}`;
    const first = (await harness().dind(['commit', '--change', 'LABEL n=1', source, tag])).stdout.trim();
    await harness().dind(['commit', '--change', 'LABEL n=2', source, tag]);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);

    const dryRun = await runJob({
      jobId: randomUUID(),
      kind: 'prune',
      dryRun: true,
      images: { dangling: true, unusedOlderThanHours: null },
      buildCache: { olderThanHours: null },
    });
    expect(dryRun.state).toBe('succeeded');
    expect(dryRun.prune?.items).toContainEqual(expect.objectContaining({ kind: 'image', id: first, reason: 'dangling' }));
    expect(dryRun.prune?.reclaimedBytes).toBeNull();
    // The dry run removed nothing; the helper (used by the toy stack) is never listed.
    await harness().dind(['image', 'inspect', first]);
    expect(dryRun.prune?.items.some((i) => i.id === imageId)).toBe(false);

    const pruned = await runJob({
      jobId: randomUUID(),
      kind: 'prune',
      dryRun: false,
      fromDryRunId: dryRun.jobId,
      images: { dangling: true, unusedOlderThanHours: null },
      buildCache: { olderThanHours: null },
    });
    expect(pruned, pruned.output).toMatchObject({ state: 'succeeded' });
    expect(pruned.prune?.items.map((i) => i.id)).toContain(first);
    expect((await runRaw('docker', ['image', 'inspect', first], { env: harness().dindEnv() })).code).not.toBe(0);
    // The tagged image and the toy stack's image are still there.
    await harness().dind(['image', 'inspect', tag]);
    await harness().dind(['image', 'inspect', imageId]);
  });
});
