import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { StackUpdateResult } from '@shipyard/schema';
import {
  Journal,
  Ledger,
  createDockerAdapter,
  createOciRegistry,
  loadStacks,
  nodeFs,
  runStackUpdate,
  systemClock,
  type StackUpdatePorts,
} from '@shipyard/sequence';

import { createAgentClient } from '../../apps/agent/src/client.js';
import { loadOrCreateIdentity } from '../../apps/agent/src/identity.js';
import { runLoop } from '../../apps/agent/src/loop.js';
import { createStackUpdateRunner, stackUpdateProgressPath, stackUpdateResultPath } from '../../apps/agent/src/stack-updates.js';
import { startFakeControlPlane, type FakeControlPlane } from '../harness/control-plane.js';
import { memoryLog, registryFetch } from '../harness/engine.js';
import { INTERNAL_REGISTRY, MANIFEST_REGISTRY, randomRevision, startHarness, type Harness, type ToyImage } from '../harness/harness.js';

/**
 * SHP-T-16.2 (SHP-REQ-194..198), run by the lead: the real agent loop, against the real dind
 * daemon and the harness's registry:2, updates a third-party stack by digest.
 *
 * The "third-party" image is the toy app pushed as `thirdparty/toy` with a moving tag, `stable`,
 * and the stack's compose file gives it a container healthcheck (busybox wget of /health), the way
 * a stack from an app store would. The stack is adopted with `updates: digest` tracking
 * `{ tag: stable }`.
 *
 * 1. `stable` moves from v1 to v2; the control plane hands an update to v2's digest: the agent
 *    re-resolves the tag, pulls by digest, rewrites the image line to `…:stable@sha256:…`,
 *    recreates the service, waits for `healthy`, soaks, and reports `succeeded` — v2 runs.
 * 2. An update naming v2 again after `stable` moved on is refused `digest_not_tracked`.
 * 3. `stable` moves to v3, whose /health answers 503 so its healthcheck goes `unhealthy`: the
 *    update is rolled back image-only — the previous image line comes back and v2 runs again.
 */

const STACK = 'thirdparty';
const REPOSITORY = 'thirdparty/toy';
const IMAGE = `${MANIFEST_REGISTRY}/${REPOSITORY}`;

async function waitFor(what: string, cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('stack updates by digest through the agent loop', () => {
  let h: Harness | undefined;
  let plane: FakeControlPlane | undefined;
  let root: string | undefined;
  let composePath = '';
  let project = '';
  const stop = new AbortController();
  let loop: Promise<void> | undefined;
  const logLines: string[] = [];
  const images: Record<'v1' | 'v2' | 'v3', ToyImage | undefined> = { v1: undefined, v2: undefined, v3: undefined };
  let docker: ReturnType<typeof createDockerAdapter>;

  /** Points `thirdparty/toy:stable` in the registry at `image`. */
  const pointStable = async (image: ToyImage): Promise<void> => {
    if (h === undefined) throw new Error('harness did not start');
    const stable = `${INTERNAL_REGISTRY}/${REPOSITORY}:stable`;
    await h.dind(['pull', image.ref]);
    await h.dind(['tag', image.ref, stable]);
    await h.dind(['push', stable]);
    // Nothing local: an update really pulls by digest.
    await h.dind(['image', 'rm', image.ref, stable]);
  };

  const runningDigest = async (): Promise<string | null> => {
    const [c] = (await docker.containers({ files: [composePath], project }, 'app')).filter((x) => x.state === 'running');
    const ref = c?.repoDigests.find((r) => r.startsWith(`${IMAGE}@`));
    return ref === undefined ? null : ref.slice(IMAGE.length + 1);
  };

  const runUpdate = async (digest: string): Promise<StackUpdateResult> => {
    if (plane === undefined) throw new Error('control plane did not start');
    const fake = plane;
    const updateId = randomUUID();
    fake.enqueueStackUpdate({ updateId, kind: 'update', stack: STACK, digests: { app: digest }, requesterLabel: 'e2e' });
    await waitFor('the stack update result', () => fake.received.some((r) => r.path === stackUpdateResultPath(updateId)), 240_000);
    const body = fake.received.find((r) => r.path === stackUpdateResultPath(updateId))?.body;
    return StackUpdateResult.parse(body);
  };

  beforeAll(async () => {
    h = await startHarness();
    for (const [name, mode, schema] of [
      ['v1', 'pass', 's1'],
      ['v2', 'pass', 's2'],
      ['v3', 'fail-health', 's3'],
    ] as const) {
      images[name] = await h.buildToyImage({ mode, schema, revision: randomRevision(), repository: REPOSITORY });
    }
    const v1 = images.v1;
    if (v1 === undefined) throw new Error('v1 was not built');
    await pointStable(v1);

    root = await mkdtemp(join(tmpdir(), 'shp-e2e-stack-'));
    const dataRoot = join(root, 'data');
    await mkdir(join(dataRoot, 'stacks'), { recursive: true });
    await mkdir(join(dataRoot, 'agent'), { recursive: true });
    composePath = join(root, 'stack', 'compose.yml');
    await mkdir(join(root, 'stack'), { recursive: true });
    project = `thirdparty-${randomBytes(3).toString('hex')}`;
    await writeFile(
      composePath,
      [
        '# A third-party stack, as an app store would write it.',
        'services:',
        '  app:',
        `    image: ${IMAGE}:stable`,
        '    healthcheck:',
        '      test: ["CMD", "wget", "-q", "-O", "-", "http://127.0.0.1:3000/health"]',
        '      interval: 1s',
        '      timeout: 2s',
        '      retries: 3',
        '      start_period: 2s',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(dataRoot, 'stacks', `${STACK}.yml`),
      stringify({
        kind: 'stack',
        name: STACK,
        compose: { files: [composePath], project },
        updates: 'digest',
        services: { app: { image: IMAGE, track: { tag: 'stable' } } },
        soakSeconds: 3,
      }),
      'utf8',
    );
    // Running v1 before Shipyard ever touches it, by the tag.
    await h.dind(['compose', '-f', composePath, '-p', project, 'up', '-d', '--wait']);

    docker = createDockerAdapter({ dockerHost: h.dockerHost });
    const log = memoryLog(logLines);
    const fs = nodeFs();
    const clock = systemClock();
    const ports: StackUpdatePorts = {
      registry: createOciRegistry({ plainHttpHosts: [MANIFEST_REGISTRY], fetch: registryFetch(h.registryHostPort) }),
      docker,
      fs,
      clock,
      log,
    };
    const journal = new Journal(fs, join(dataRoot, 'agent', 'journal.jsonl'), clock, log);
    const ledger = await Ledger.open(fs, join(dataRoot, 'agent', 'ledger.jsonl'));

    // Wired the way apps/agent/src/index.ts wires it.
    plane = await startFakeControlPlane();
    const identity = await loadOrCreateIdentity(dataRoot);
    const client = createAgentClient({ serverUrl: plane.url, identity, timeoutMs: 35_000 });
    const stackUpdates = createStackUpdateRunner({
      client,
      execute: async (job, onStep) =>
        runStackUpdate(
          ports,
          {
            dataRoot,
            stacks: await loadStacks(fs, dataRoot),
            journal,
            ledger,
            historyDir: join(dataRoot, 'agent', 'history'),
            onStep,
            healthTimeoutMs: 60_000,
            checkIntervalMs: 1_000,
            soakIntervalMs: 1_000,
            probeTimeoutMs: 3_000,
          },
          job,
        ),
      log,
      signal: stop.signal,
    });
    loop = runLoop({ client, runTarget: () => Promise.resolve(), stackUpdates, log, signal: stop.signal });
  });

  afterAll(async () => {
    stop.abort();
    await plane?.stop();
    await loop?.catch(() => undefined);
    if (h !== undefined && composePath !== '') {
      await h.dind(['compose', '-f', composePath, '-p', project, 'down', '--timeout', '2']).catch(() => undefined);
    }
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    await h?.stop();
  });

  it("advertises 'stack-updates' and updates v1 → v2 by digest", async () => {
    const fake = plane;
    const v1 = images.v1;
    const v2 = images.v2;
    if (fake === undefined || v1 === undefined || v2 === undefined) throw new Error('harness did not start');
    expect(await runningDigest()).toBe(v1.digest);
    await waitFor('a poll', () => fake.received.some((r) => r.path === '/api/agent/poll'), 30_000);
    expect(fake.received.find((r) => r.path === '/api/agent/poll')?.body).toMatchObject({ capabilities: ['stack-updates'] });

    await pointStable(v2);
    const result = await runUpdate(v2.digest);
    expect(result, logLines.join('\n')).toMatchObject({
      state: 'succeeded',
      images: [{ service: 'app', tag: 'stable', digest: v2.digest }],
      previous: [{ service: 'app', tag: 'stable', digest: v1.digest }],
    });
    expect(await runningDigest()).toBe(v2.digest);
    expect(await readFile(composePath, 'utf8')).toContain(`    image: ${IMAGE}:stable@${v2.digest}\n`);
    const steps = fake.received.filter((r) => r.path === stackUpdateProgressPath(result.updateId)).map((r) => (r.body as { step: string }).step);
    expect(steps).toEqual(['verifying', 'pulling', 'swapping', 'checking', 'soaking']);
  });

  it('refuses a digest the track no longer resolves to', async () => {
    const v2 = images.v2;
    const v3 = images.v3;
    if (v2 === undefined || v3 === undefined) throw new Error('harness did not start');
    await pointStable(v3);
    const result = await runUpdate(v2.digest);
    expect(result).toMatchObject({ state: 'refused', refusal: { code: 'digest_not_tracked' } });
    expect(await runningDigest()).toBe(v2.digest);
  });

  it('rolls a broken tag back to the previous digest, image-only', async () => {
    const v2 = images.v2;
    const v3 = images.v3;
    if (v2 === undefined || v3 === undefined) throw new Error('harness did not start');
    const result = await runUpdate(v3.digest);
    expect(result, logLines.join('\n')).toMatchObject({
      state: 'rolled_back',
      refusal: { code: 'health_failed' },
      images: [{ service: 'app', digest: v2.digest }],
    });
    expect(await runningDigest()).toBe(v2.digest);
    expect(await readFile(composePath, 'utf8')).toContain(`    image: ${IMAGE}:stable@${v2.digest}\n`);
  });
});
