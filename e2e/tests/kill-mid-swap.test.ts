import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Journal, recoverInterrupted, type SequencePorts } from '@shipyard/sequence';

// `machine.js` is not re-exported from the package index until the lead merges SHP-T-1.8.
import { runDeploy } from '../../packages/sequence/src/machine.js';
import type { RunnerConfig } from '../harness/deploy-runner.js';
import { enginePorts, linearMainState, memoryLog, openContext, prepareToyDataRoot, readText, type ToyDataRoot } from '../harness/engine.js';
import { MANIFEST_REGISTRY, randomRevision, startHarness, type Harness, type ToyImage } from '../harness/harness.js';

/**
 * SHP-T-1.9's proof (SHP-REQ-021, SHP-REQ-022): a deploy killed with SIGKILL after it rewrote the
 * compose file and before `up` is found unfinished in the journal on restart, rolled back to the
 * last verified-good compose file, and marked failed + interrupted. Never resumed forward.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../..');
// tsx's loader in this very process (not the `tsx` CLI, which runs the script in a child: a
// SIGKILL would then hit the wrapper and leave the deploy running as an orphan).
const TSX_LOADER = pathToFileURL(resolve(REPO_ROOT, 'apps/server/node_modules/tsx/dist/loader.mjs')).href;
const RUNNER = resolve(REPO_ROOT, 'e2e/harness/deploy-runner.ts');
const RUNNER_TSCONFIG = resolve(REPO_ROOT, 'e2e/harness/runner.tsconfig.json');
const REPO = `${MANIFEST_REGISTRY}/toy/app`;
const PAUSE_MARKER = 'SHIPYARD_TEST_PAUSED swap-rewrite';

/** Resolves once the child prints the pause marker; rejects if it exits or stalls first. */
function waitForPause(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      reject(new Error(`runner did not pause within ${String(timeoutMs)}ms\nstdout: ${out}\nstderr: ${err}`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (out.includes(PAUSE_MARKER)) {
        clearTimeout(timer);
        resolvePromise();
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`runner exited (${String(code)}, ${String(signal)}) before pausing\nstdout: ${out}\nstderr: ${err}`));
    });
  });
}

describe('kill mid-swap', () => {
  let h: Harness | undefined;
  let paths: ToyDataRoot | undefined;
  let ports: SequencePorts;
  let child: ChildProcess | undefined;
  const [c1, c2] = [randomRevision(), randomRevision()];
  const built = new Map<string, ToyImage>();

  beforeAll(async () => {
    h = await startHarness();
    paths = await prepareToyDataRoot({ soakSeconds: 2 });
    ports = enginePorts({ dockerHost: h.dockerHost, fakeGithubUrl: h.fakeGithubUrl, registryHostPort: h.registryHostPort }, memoryLog());
    await h.setGithubState(linearMainState([c1, c2]));
    built.set(c1, await h.buildToyImage({ mode: 'pass', schema: 's1', revision: c1 }));
    built.set(c2, await h.buildToyImage({ mode: 'pass', schema: 's2', revision: c2 }));
  });

  afterAll(async () => {
    child?.kill('SIGKILL');
    if (h !== undefined && paths !== undefined) {
      await h.dind(['compose', '-f', paths.composePath, '-p', paths.project, 'down', '--timeout', '2']).catch(() => undefined);
    }
    await paths?.remove();
    await h?.stop();
  });

  const dataRoot = (): ToyDataRoot => {
    if (paths === undefined) throw new Error('data root not prepared');
    return paths;
  };
  const digest = (sha: string): string => built.get(sha)?.digest ?? '';

  it('recovers a deploy killed after the compose rewrite: previous compose, previous release, interrupted', async () => {
    if (h === undefined) throw new Error('harness did not start');

    // The verified-good release.
    const first = await runDeploy(ports, await openContext(ports, dataRoot()), {
      deployId: 'dep-first',
      kind: 'deploy',
      app: 'toy',
      sha: c1,
      dryRun: false,
      requesterLabel: 'e2e',
    });
    expect(first.refusal, JSON.stringify(first.refusal)).toBeNull();
    expect(first.state).toBe('succeeded');
    const goodCompose = await readText(dataRoot().composePath);
    expect(goodCompose).toContain(`${REPO}:sha-${c1}@${digest(c1)}`);

    // The next deploy, in its own process, paused after the rewrite and before `up`.
    const p = dataRoot();
    const config: RunnerConfig = {
      endpoints: { dockerHost: h.dockerHost, fakeGithubUrl: h.fakeGithubUrl, registryHostPort: h.registryHostPort },
      paths: {
        root: p.root,
        dataRoot: p.dataRoot,
        composePath: p.composePath,
        project: p.project,
        journalPath: p.journalPath,
        ledgerPath: p.ledgerPath,
        workDir: p.workDir,
        historyDir: p.historyDir,
      },
      deployId: 'dep-killed',
      sha: c2,
    };
    child = spawn(process.execPath, ['--import', TSX_LOADER, RUNNER, JSON.stringify(config)], {
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', SHIPYARD_TEST_PAUSE_AFTER: 'swap-rewrite', TSX_TSCONFIG_PATH: RUNNER_TSCONFIG },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForPause(child, 180_000);

    // Killed with the compose file already naming the new release.
    expect(await readText(dataRoot().composePath)).toContain(`${REPO}:sha-${c2}@${digest(c2)}`);
    const exited = new Promise((r) => child?.once('exit', r));
    child.kill('SIGKILL');
    await exited;

    // Restart: the journal shows an unfinished deploy whose last open step is the swap.
    const journal = new Journal(ports.fs, dataRoot().journalPath, ports.clock, ports.log);
    const unfinished = await journal.unfinished();
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0]).toMatchObject({ deployId: 'dep-killed', app: 'toy', lastStep: 'swap' });

    const recovered = await recoverInterrupted(ports, journal, { historyDir: dataRoot().historyDir });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ deployId: 'dep-killed', upExitCode: 0, lastStep: 'swap' });
    expect(recovered[0]?.error).toBeUndefined();

    // The compose file is byte-for-byte the verified-good one, and that release is serving.
    expect(await readText(dataRoot().composePath)).toBe(goodCompose);
    const target = { files: [dataRoot().composePath], project: dataRoot().project };
    const running = (await ports.docker.containers(target, 'app')).filter((c) => c.state === 'running');
    expect(running).toHaveLength(1);
    expect(running[0]?.repoDigests).toContain(`${REPO}@${digest(c1)}`);
    expect(running[0]?.labels['org.opencontainers.image.revision']).toBe(c1);
    let health: Awaited<ReturnType<SequencePorts['docker']['probeHealth']>> | undefined;
    for (let i = 0; i < 20 && health?.httpStatus !== 200; i++) {
      health = await ports.docker.probeHealth(target, 'app', 3000, '/health', 3_000).catch(() => undefined);
    }
    expect(health).toEqual({ httpStatus: 200, body: { status: 'ok', schemaRevision: 's1' } });

    // The journal closes the killed deploy as failed + interrupted, and nothing is left open.
    const entries = await journal.readAll();
    const end = entries.find((e) => e.deployId === 'dep-killed' && e.step === 'deploy' && e.phase === 'end');
    expect(end?.detail).toMatchObject({ state: 'failed', interrupted: true, lastStep: 'swap' });
    expect(await journal.unfinished()).toEqual([]);
    // The killed deploy never reached the ledger.
    const ctx = await openContext(ports, dataRoot());
    expect(ctx.ledger.last('toy')?.sha).toBe(c1);

    // Its stale lock (the killed pid) does not block the next deploy, which now goes through.
    const retry = await runDeploy(ports, ctx, { deployId: 'dep-retry', kind: 'deploy', app: 'toy', sha: c2, dryRun: false, requesterLabel: 'e2e' });
    expect(retry.refusal, JSON.stringify(retry.refusal)).toBeNull();
    expect(retry.state).toBe('succeeded');
  });
});
