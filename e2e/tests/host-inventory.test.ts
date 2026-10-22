import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AgentReport, HostInventory } from '@shipyard/schema';
import type { SequencePorts } from '@shipyard/sequence';

import { createAgentClient } from '../../apps/agent/src/client.js';
import { loadOrCreateIdentity } from '../../apps/agent/src/identity.js';
import { createInventoryCollector } from '../../apps/agent/src/inventory.js';
import { buildReport, startReporting, type Reporting } from '../../apps/agent/src/report.js';
// `machine.js` is imported by path until the lead exports it from the index.
import { runDeploy } from '../../packages/sequence/src/machine.js';
import { startFakeControlPlane, type FakeControlPlane } from '../harness/control-plane.js';
import { enginePorts, linearMainState, memoryLog, openContext, prepareToyDataRoot, type ToyDataRoot } from '../harness/engine.js';
import { MANIFEST_REGISTRY, randomRevision, startHarness, type Harness, type ToyImage } from '../harness/harness.js';

/**
 * SHP-T-14.4 (SHP-REQ-175, SHP-REQ-176, SHP-REQ-177): the agent reports the host's inventory with
 * its report. Against the real dind daemon, the toy app's containers (deployed from a manifest) are
 * `shipped` with the app set, a container the test starts with no compose labels is `observed`, a
 * stopped one is reported as stopped on the next report, and nothing from a container's
 * environment reaches the control plane.
 */

const REPO = `${MANIFEST_REGISTRY}/toy/app`;

async function waitFor(what: string, cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('host inventory in the agent report', () => {
  let h: Harness | undefined;
  let paths: ToyDataRoot | undefined;
  let plane: FakeControlPlane | undefined;
  let reporting: Reporting | undefined;
  let ports: SequencePorts;
  let image: ToyImage | undefined;
  const sha = randomRevision();
  const unmanaged = `unmanaged-${sha.slice(0, 8)}`;

  beforeAll(async () => {
    h = await startHarness();
    paths = await prepareToyDataRoot({ soakSeconds: 2 });
    ports = enginePorts({ dockerHost: h.dockerHost, fakeGithubUrl: h.fakeGithubUrl, registryHostPort: h.registryHostPort }, memoryLog());
    await h.setGithubState(linearMainState([sha]));
    image = await h.buildToyImage({ mode: 'pass', schema: 's1', revision: sha });
    plane = await startFakeControlPlane();
  });

  afterAll(async () => {
    reporting?.stop();
    await plane?.stop();
    if (h !== undefined) {
      await h.dind(['rm', '--force', unmanaged]).catch(() => undefined);
      if (paths !== undefined) {
        await h.dind(['compose', '-f', paths.composePath, '-p', paths.project, 'down', '--timeout', '2']).catch(() => undefined);
      }
    }
    await paths?.remove();
    await h?.stop();
  });

  it('reports the toy app as shipped, an unmanaged container as observed, and a stopped one as stopped', async () => {
    if (h === undefined || paths === undefined || plane === undefined || image === undefined) throw new Error('harness did not start');
    const fake = plane;
    const toyImage = image;
    const p = paths;

    const deployed = await runDeploy(ports, await openContext(ports, p), {
      deployId: 'dep-inventory',
      kind: 'deploy',
      app: 'toy',
      sha,
      dryRun: false,
      requesterLabel: 'e2e',
    });
    expect(deployed.refusal, JSON.stringify(deployed.refusal)).toBeNull();
    expect(deployed.state).toBe('succeeded');

    // A container compose did not create, from the image the deploy just pulled.
    await h.dind(['run', '-d', '--name', unmanaged, '--entrypoint', 'sleep', `${REPO}@${toyImage.digest}`, '300']);

    const identity = await loadOrCreateIdentity(p.dataRoot);
    const client = createAgentClient({ serverUrl: fake.url, identity, timeoutMs: 30_000 });
    // The way apps/agent/src/index.ts wires it: the inventory collector holds the caches.
    const inventory = createInventoryCollector({ docker: ports.docker, dataRoot: p.dataRoot });
    const build = () =>
      buildReport({ fs: ports.fs, docker: ports.docker, engineApiVersion: () => Promise.resolve('e2e'), inventory }, p.dataRoot, {
        agentVersion: 'e2e',
        patExpiresAt: null,
      });
    reporting = startReporting(client, build, { intervalMs: 3_600_000 });
    const reports = (): AgentReport[] => fake.received.filter((r) => r.path === '/api/agent/report').map((r) => AgentReport.parse(r.body));
    await waitFor('the first report', () => reports().length >= 1, 120_000);

    const first = reports()[0]?.host;
    expect(first, 'the report carries the host inventory').toBeDefined();
    const inv = HostInventory.parse(first);

    const toy = inv.containers.filter((c) => c.compose?.project === p.project);
    expect(toy.length).toBeGreaterThan(0);
    for (const c of toy) {
      expect(c).toMatchObject({ tier: 'shipped', app: 'toy', state: 'running' });
      expect(c.digest).toBe(toyImage.digest);
    }
    const loose = inv.containers.find((c) => c.name === unmanaged);
    expect(loose).toMatchObject({ tier: 'observed', app: null, compose: null, state: 'running' });
    expect(inv.images.some((i) => i.repoDigests.includes(`${REPO}@${toyImage.digest}`) && i.containers >= 2)).toBe(true);
    expect(inv.disk.dataRoot.freeBytes).toBeGreaterThan(0);

    // SHP-REQ-177: the toy compose file gives its container TOY_SECRET; it is nowhere in a report.
    const wire = JSON.stringify(fake.received.filter((r) => r.path === '/api/agent/report').map((r) => r.body));
    expect(wire).not.toContain('TOY_SECRET');
    expect(wire).not.toContain('not-a-real-secret');

    // A stopped container is on the next report, as stopped.
    await h.dind(['stop', '--time', '1', unmanaged]);
    await reporting.sendNow();
    const latest = reports().at(-1)?.host;
    expect(reports().length).toBeGreaterThanOrEqual(2);
    expect(latest?.containers.find((c) => c.name === unmanaged)).toMatchObject({ state: 'exited', tier: 'observed', stats: null });
  });
});
