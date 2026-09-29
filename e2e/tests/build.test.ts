import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BuildProgress, BuildResult, Manifest } from '@shipyard/schema';
import {
  AppLock,
  BUILD_NETWORK_GATEWAY,
  appendBuildRecord,
  createDockerAdapter,
  isAppLockLive,
  latestSucceededBuild,
  loadManifests,
  lockPath,
  runBuildStages,
  runDeploy,
  systemClock,
  withBuildSource,
  type BuildKitPort,
  type BuildStagesResult,
  type SequencePorts,
  type StageProgress,
} from '@shipyard/sequence';

import { buildJournalPath, createBuildWorker } from '../../apps/agent/src/build.js';
import { createAgentClient } from '../../apps/agent/src/client.js';
import { loadOrCreateIdentity } from '../../apps/agent/src/identity.js';
import { buildMainState, pushedImage, registryTags, startBuildKit, toySourceTarball, type DindBuildKit, type SolveCall } from '../harness/build.js';
import { startFakeControlPlane, type FakeControlPlane } from '../harness/control-plane.js';
import { enginePorts, memoryLog, openContext, prepareToyDataRoot, readText, type ToyDataRoot } from '../harness/engine.js';
import { pollUntil, run } from '../harness/exec.js';
import { HARNESS_COMPOSE, MANIFEST_REGISTRY, randomRevision, startHarness, type Harness } from '../harness/harness.js';

/**
 * SHP-T-7.16: the Shipyard build pipeline end to end, in Docker-in-Docker.
 *
 * - **Source** comes from the fake GitHub's tarball endpoint (a gzipped tar of `e2e/toy-app` under
 *   `example-toy-<sha7>/`), through the real GitHub adapter and `withBuildSource`, which also asks
 *   `compare` that the SHA is on `main`.
 * - **Builds** run in a real rootless buildkitd inside dind on the real `shipyard-build` network
 *   (the operator script runs first), through the real BuildKit adapter and `runBuildStages`. The
 *   release is pushed to the harness registry as `registry.shipyard.test/toy/app:sha-<40hex>`.
 * - **Deploys** go through the real state machine; the manifest says `build.source: shipyard`, and
 *   the fake GitHub holds no workflow runs at all, so G5 can only pass on the agent's build record.
 * - **Deploy priority** runs the agent's real build worker (`createBuildWorker`, the real engine
 *   functions, signed reports to the fake control plane), with `deployInFlight` computed as the
 *   agent does it: any live app lock under `<dataRoot>/agent/locks`.
 *
 * Covers SHP-REQ-118 (test before release), SHP-REQ-120 (failed tests push nothing), SHP-REQ-123
 * (a RUN step has no route to another network or the Docker host), SHP-REQ-130 (no new stage while
 * a deploy is in flight) and SHP-REQ-134 (G5 on a Shipyard build whose digests match the registry).
 * SHP-REQ-138 (auto-deploy on a green build) is server-side and covered by the server's integration
 * tests against a real database; this file proves what it consumes — a delivered green result.
 */

const REPO = 'example/toy';
const IMAGE = `${MANIFEST_REGISTRY}/toy/app`;
const REGISTRY_REPOSITORY = 'toy/app';

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`${what} not ready`);
  return v;
}

describe('Shipyard build pipeline in dind (SHP-T-7.16)', () => {
  let h: Harness | undefined;
  let bk: DindBuildKit | undefined;
  let paths: ToyDataRoot | undefined;
  let plane: FakeControlPlane | undefined;
  let ports: SequencePorts;
  const logLines: string[] = [];

  // main: green ← failing ← ciOnly ← held. Each has a tarball; none has a workflow run.
  const green = randomRevision();
  const failing = randomRevision();
  const ciOnly = randomRevision();
  const held = randomRevision();
  let probes: { otherNetwork: string; dockerHost: string } = { otherNetwork: '', dockerHost: '' };

  beforeAll(async () => {
    h = await startHarness();
    bk = await startBuildKit(h);
    paths = await prepareToyDataRoot({ shipyardBuild: true, soakSeconds: 3 });
    ports = enginePorts({ dockerHost: h.dockerHost, fakeGithubUrl: h.fakeGithubUrl, registryHostPort: h.registryHostPort }, memoryLog(logLines));

    // What a RUN step must not reach: a container on the harness network (another network, in
    // private address space — the fake GitHub, which dind itself does reach) and the Docker host.
    const fakeGithubId = (await run('docker', ['compose', '-f', HARNESS_COMPOSE, '-p', h.project, 'ps', '-q', 'fake-github'])).stdout.trim();
    const fakeGithubIp = (await run('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', fakeGithubId])).stdout.trim();
    expect(fakeGithubIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    probes = { otherNetwork: `http://${fakeGithubIp}:8080/_control/requests`, dockerHost: `http://${BUILD_NETWORK_GATEWAY}:2375/_ping` };
    // Control: dind itself reaches it, so a blocked probe from a build step is the firewall.
    await run('docker', ['exec', bk.dindId, 'wget', '-q', '-O', '/dev/null', probes.otherNetwork]);

    const tarballs = {
      [green]: await toySourceTarball(REPO, green, { probes: [probes.otherNetwork, probes.dockerHost] }),
      [failing]: await toySourceTarball(REPO, failing, { failTests: true }),
      [ciOnly]: await toySourceTarball(REPO, ciOnly),
      [held]: await toySourceTarball(REPO, held),
    };
    await h.setGithubState(buildMainState(REPO, [green, failing, ciOnly, held], tarballs));
  });

  afterAll(async () => {
    await plane?.stop();
    if (paths !== undefined) {
      if (h !== undefined) await h.dind(['compose', '-f', paths.composePath, '-p', paths.project, 'down', '--timeout', '2']).catch(() => undefined);
      await paths.remove();
    }
    await bk?.stop();
    await h?.stop();
    if (process.env.SHIPYARD_E2E_VERBOSE === '1') console.log(logLines.join('\n'));
  });

  const manifests = async (): Promise<Map<string, Manifest>> =>
    new Map([...(await loadManifests(ports.fs, need(paths, 'data root').dataRoot))].map(([name, loaded]) => [name, loaded.manifest]));

  /** What the worker does, engine-level: source → stages → build record on success. */
  const build = async (sha: string, buildkit: BuildKitPort): Promise<{ result: BuildStagesResult; progress: StageProgress[] }> => {
    const b = need(bk, 'buildkit');
    const root = need(paths, 'data root');
    const progress: StageProgress[] = [];
    const scratch = join(b.workDir, 'src');
    await mkdir(scratch, { recursive: true });
    const result = await withBuildSource(
      { manifests: await manifests(), app: 'toy', sha, github: ports.github, scratchRoot: scratch, log: memoryLog(logLines) },
      (dir, manifest) =>
        runBuildStages({
          dir,
          manifest,
          sha,
          buildkit,
          secrets: new Map(),
          tmpDir: b.workDir,
          log: memoryLog(logLines),
          onProgress: (p) => {
            progress.push(p);
          },
        }),
    );
    if (result.state === 'succeeded') {
      await appendBuildRecord(ports.fs, root.dataRoot, { buildId: `b-${sha.slice(0, 8)}`, app: 'toy', sha, state: 'succeeded', digests: result.digests, at: new Date().toISOString() });
    }
    return { result, progress };
  };

  let greenLog = '';

  it('a green build: the test target first, then the release pushed as sha-<sha> with its labels, and a build record — then G5 passes on it and the app serves', async () => {
    const b = need(bk, 'buildkit');
    const root = need(paths, 'data root');
    const spied = b.spy();
    const { result, progress } = await build(green, spied.buildkit);
    greenLog = progress.map((p) => p.log ?? '').join('\n');
    expect(result.state, greenLog).toBe('succeeded');

    // SHP-REQ-118: test (no export) strictly before the release push.
    expect(spied.calls.map((c: SolveCall) => [c.target, c.push])).toEqual([
      ['test', null],
      ['release', `${IMAGE}:sha-${green}`],
    ]);
    expect(progress.map((p) => `${p.stage}:${p.state}`)).toEqual([
      'test:running',
      'test:succeeded',
      'integration:skipped',
      'build:running',
      'build:succeeded',
      'push:succeeded',
    ]);
    const testLog = progress.find((p) => p.stage === 'test' && p.state === 'succeeded')?.log ?? '';
    expect(testLog).toMatch(/TOY-TEST start[\s\S]*TOY-TEST pass/);

    // The registry holds exactly what the build reported, labelled with the commit and its source.
    const pushed = await pushedImage(need(h, 'harness').registryHostPort, REGISTRY_REPOSITORY, `sha-${green}`);
    expect(pushed.digest).toBe(result.digests.app);
    expect(pushed.labels['org.opencontainers.image.revision']).toBe(green);
    expect(pushed.labels['org.opencontainers.image.source']).toBe(`https://github.com/${REPO}`);
    const record = await latestSucceededBuild(ports.fs, root.dataRoot, 'toy', green);
    expect(record?.digests).toEqual({ app: pushed.digest });

    // The deploy: G5 reads the build record (the fake GitHub holds no runs, and none is asked for).
    const before = (await need(h, 'harness').githubRequests()).length;
    const ctx = await openContext(ports, root);
    const deployed = await runDeploy(ports, ctx, { deployId: `dep-${green.slice(0, 8)}`, kind: 'deploy', app: 'toy', sha: green, dryRun: false, requesterLabel: 'e2e' });
    expect(deployed.refusal, JSON.stringify(deployed.refusal)).toBeNull();
    expect(deployed.state).toBe('succeeded');
    const g5 = deployed.gates.find((g) => g.gate === 'G5');
    expect(g5?.pass).toBe(true);
    expect(g5?.reason).toContain(`Shipyard built ${green.slice(0, 7)}`);
    const asked = (await need(h, 'harness').githubRequests()).slice(before).map((r) => r.url);
    expect(asked.some((u) => u.includes('/actions/'))).toBe(false);

    const target = { files: [root.composePath], project: root.project };
    const running = (await ports.docker.containers(target, 'app')).filter((c) => c.state === 'running');
    expect(running).toHaveLength(1);
    expect(running[0]?.repoDigests).toContain(`${IMAGE}@${pushed.digest}`);
    expect(running[0]?.labels['org.opencontainers.image.revision']).toBe(green);
    const health = await ports.docker.probeHealth(target, 'app', 3000, '/health', 5_000);
    expect(health.httpStatus).toBe(200);
    expect(await readText(root.composePath)).toContain(`image: ${IMAGE}:sha-${green}@${pushed.digest}`);
  });

  it('a RUN step reaches neither another network nor the Docker host', () => {
    // The green build's test step fetched both (see probes.json); the push to the registry on its
    // public-range address is the control that the network works at all.
    expect(greenLog).toMatch(new RegExp(`TOY-PROBE ${probes.otherNetwork.replaceAll('.', '\\.')} blocked`));
    expect(greenLog).toMatch(new RegExp(`TOY-PROBE ${probes.dockerHost.replaceAll('.', '\\.')} blocked`));
    expect(greenLog).not.toMatch(/TOY-PROBE \S+ reached/);
    // Both listeners are up (dind reaches the fake GitHub; dockerd listens on every address), so
    // a refusal would be a listener missing, not a route; blocked means dropped.
    expect(greenLog).not.toMatch(/TOY-PROBE \S+ blocked ECONNREFUSED/);
  });

  it('failing tests: the build fails at test, nothing is pushed, no record is written — and G5 refuses the SHA', async () => {
    const b = need(bk, 'buildkit');
    const root = need(paths, 'data root');
    const spied = b.spy();
    const { result, progress } = await build(failing, spied.buildkit);
    expect(result).toEqual({ state: 'failed', digests: {}, failedStage: 'test' });
    expect(spied.calls.map((c) => c.target)).toEqual(['test']);
    expect(progress.map((p) => `${p.stage}:${p.state}`)).toEqual(['test:running', 'test:failed']);
    expect(progress.at(-1)?.log).toContain('TOY-TEST fail');

    // SHP-REQ-120: no sha-<failing> tag exists.
    const tags = await registryTags(need(h, 'harness').registryHostPort, REGISTRY_REPOSITORY);
    expect(tags).toContain(`sha-${green}`);
    expect(tags).not.toContain(`sha-${failing}`);
    expect(await latestSucceededBuild(ports.fs, root.dataRoot, 'toy', failing)).toBeNull();

    const ctx = await openContext(ports, root);
    const refused = await runDeploy(ports, ctx, { deployId: `dep-${failing.slice(0, 8)}`, kind: 'deploy', app: 'toy', sha: failing, dryRun: true, requesterLabel: 'e2e' });
    expect(refused.gates.find((g) => g.gate === 'G5')).toMatchObject({ pass: false, refusal: { code: 'build_not_green' } });
  });

  it('an image in the registry is not enough: without a Shipyard build of the SHA, G5 refuses even though G8 finds the digest', async () => {
    const harness = need(h, 'harness');
    const root = need(paths, 'data root');
    // Pushed by hand, the way CI would have — not built by Shipyard.
    const image = await harness.buildToyImage({ mode: 'pass', schema: '0', revision: ciOnly });
    const ctx = await openContext(ports, root);
    const result = await runDeploy(ports, ctx, { deployId: `dep-${ciOnly.slice(0, 8)}`, kind: 'deploy', app: 'toy', sha: ciOnly, dryRun: true, requesterLabel: 'e2e' });
    expect(result.gates.find((g) => g.gate === 'G8')?.pass).toBe(true);
    expect(result.gates.find((g) => g.gate === 'G5')).toMatchObject({ pass: false, refusal: { code: 'build_not_green' } });
    expect(image.digest).toMatch(/^sha256:/);

    // A record whose digest is not what the registry holds is refused too.
    await appendBuildRecord(ports.fs, root.dataRoot, { buildId: 'b-forged', app: 'toy', sha: ciOnly, state: 'succeeded', digests: { app: `sha256:${'0'.repeat(64)}` }, at: new Date().toISOString() });
    const mismatched = await runDeploy(ports, await openContext(ports, root), { deployId: `dep-${ciOnly.slice(0, 8)}-2`, kind: 'deploy', app: 'toy', sha: ciOnly, dryRun: true, requesterLabel: 'e2e' });
    expect(mismatched.gates.find((g) => g.gate === 'G5')).toMatchObject({ pass: false, refusal: { code: 'build_digest_mismatch' } });
  });

  it('deploys first: the agent build worker holds its next stage while an app lock is live, and continues once it is released', async () => {
    const harness = need(h, 'harness');
    const b = need(bk, 'buildkit');
    const root = need(paths, 'data root');
    plane = await startFakeControlPlane();
    const identityDir = await mkdtemp(join(root.root, 'agent-identity-'));
    const client = createAgentClient({ serverUrl: plane.url, identity: await loadOrCreateIdentity(identityDir), timeoutMs: 10_000 });

    // The agent's own test for a deploy in flight (apps/agent/src/index.ts): any live app lock.
    const locksDir = lockPath(root.dataRoot, 'x').slice(0, -'/x.lock'.length);
    const anyLockLive = async (): Promise<boolean> => {
      let files: { path: string }[];
      try {
        files = await ports.fs.list(locksDir);
      } catch {
        return false;
      }
      for (const file of files) {
        const name = file.path.slice(file.path.lastIndexOf('/') + 1);
        if (name.endsWith('.lock') && (await isAppLockLive(root.dataRoot, name.slice(0, -'.lock'.length)))) return true;
      }
      return false;
    };

    // A deploy holds toy's lock, as the machine (or the host CLI) does mid-deploy.
    const lock = await AppLock.acquire(root.dataRoot, 'toy', { pid: process.pid, deployId: 'dep-e2e-holding', requesterLabel: 'e2e', sha: green, step: 'swap', at: new Date().toISOString() });
    if (!(lock instanceof AppLock)) throw new Error(`could not take the lock: ${JSON.stringify(lock)}`);
    let released = false;

    const spied = b.spy();
    const scratch = join(b.workDir, 'worker');
    await mkdir(scratch, { recursive: true });
    const worker = createBuildWorker({
      client,
      manifests,
      github: ports.github,
      buildkit: spied.buildkit,
      docker: createDockerAdapter({ dockerHost: harness.dockerHost }),
      fs: ports.fs,
      dataRoot: root.dataRoot,
      tmpDir: scratch,
      readSecrets: () => Promise.resolve(new Map()),
      deployInFlight: anyLockLive,
      log: memoryLog(logLines),
      clock: systemClock(),
      deployWaitMs: 250,
      // No heartbeat reports mid-test: the progress sequence below is exactly the stages.
      heartbeatMs: 3_600_000,
      backoff: { initialMs: 200, maxMs: 1_000 },
    });
    const journal = async (): Promise<Record<string, string | undefined>[]> => {
      try {
        return (await readText(buildJournalPath(root.dataRoot))).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, string | undefined>);
      } catch {
        return [];
      }
    };

    try {
      expect(worker.offer({ buildId: 'b-e2e-held', app: 'toy', sha: held, requesterLabel: 'e2e' })).toBe(true);
      await pollUntil('the build held for the deploy', async () => (await journal()).some((e) => e.phase === 'held'), { timeoutMs: 120_000 });
      // Held for a while: no solve started, no test stage reported.
      await new Promise((r) => setTimeout(r, 3_000));
      expect(spied.calls).toEqual([]);
      const progressWhileHeld = plane.received.filter((r) => r.path === '/api/agent/build-progress').map((r) => r.body as BuildProgress);
      expect(progressWhileHeld.map((p) => `${p.stage}:${p.state}`)).toEqual(['fetch:running', 'fetch:succeeded']);
      expect(worker.busy()).toBe(true);

      const releasedAt = Date.now();
      await lock.release();
      released = true;
      await worker.idle();

      // The test solve began only after the lock went.
      expect(spied.calls.map((c) => c.target)).toEqual(['test', 'release']);
      expect(spied.calls[0]?.at ?? 0).toBeGreaterThanOrEqual(releasedAt);
      const phases = (await journal()).filter((e) => e.buildId === 'b-e2e-held').map((e) => `${e.stage ?? ''}:${e.phase ?? ''}`);
      expect(phases.indexOf('fetch:held')).toBeGreaterThan(-1);
      expect(phases.indexOf('fetch:held')).toBeLessThan(phases.indexOf('test:start'));

      // The result flows to the (signed) control plane, matching the registry and the build record.
      const results = plane.received.filter((r) => r.path === '/api/agent/build-result').map((r) => r.body as BuildResult);
      expect(results).toHaveLength(1);
      const pushed = await pushedImage(harness.registryHostPort, REGISTRY_REPOSITORY, `sha-${held}`);
      expect(results[0]).toEqual({ buildId: 'b-e2e-held', state: 'succeeded', digests: { app: pushed.digest } });
      expect((await latestSucceededBuild(ports.fs, root.dataRoot, 'toy', held))?.digests).toEqual({ app: pushed.digest });
      expect(plane.keys.size).toBe(1);
      const stages = plane.received
        .filter((r) => r.path === '/api/agent/build-progress')
        .map((r) => r.body as BuildProgress)
        .filter((p) => p.state !== 'running' || p.stage === 'test')
        .map((p) => `${p.stage}:${p.state}`);
      expect(stages).toEqual(['fetch:succeeded', 'test:running', 'test:succeeded', 'integration:skipped', 'build:succeeded', 'push:succeeded']);
    } finally {
      worker.stop();
      if (!released) await lock.release();
      await rm(identityDir, { recursive: true, force: true });
    }
  });
});
